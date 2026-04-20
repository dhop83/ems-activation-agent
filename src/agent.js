const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'dale1383@gmail.com';

const EMS_BASE_URL = process.env.SENTINEL_EMS_URL;
const EMS_USER = process.env.SENTINEL_EMS_USERNAME || 'admin';
const EMS_PASS = process.env.SENTINEL_EMS_PASSWORD;

// ─── EMS direct API calls (no MCP needed) ─────────────────────────────────────

function emsAuth() {
  return 'Basic ' + Buffer.from(`${EMS_USER}:${EMS_PASS}`).toString('base64');
}

async function emsGet(path) {
  try {
    const res = await fetch(`${EMS_BASE_URL}/ems/api/v5${path}`, {
      headers: { Authorization: emsAuth(), Accept: 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getActivationDetails(entitlementUid, activationUid) {
  return emsGet(`/entitlements/${entitlementUid}/activations/${activationUid}`);
}

async function getEntitlementDetails(entitlementUid) {
  return emsGet(`/entitlements/${entitlementUid}?embed=productKeys,customer`);
}

async function getActivationHistory(entitlementUid) {
  return emsGet(`/entitlements/${entitlementUid}/activations`);
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 }
  };

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.replace(/```json|```/g, '').trim();
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(subject, body) {
  console.log('[email] Sending alert...');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'EMS Agent <onboarding@resend.dev>',
      to: ALERT_EMAIL,
      subject,
      text: body
    })
  });

  const data = await response.json();
  console.log('[email] Resend response:', JSON.stringify(data));

  if (data.error) throw new Error(`Resend error: ${JSON.stringify(data.error)}`);
  console.log(`[email] Sent — ID: ${data.id}`);
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export async function runAgent(webhookPayload) {
  console.log('[agent] Starting investigation...');

  // ── Step 1: Parse webhook for key identifiers ──────────────────────────────
  let currentState = {};
  try {
    currentState = JSON.parse(webhookPayload.currentState || '{}');
  } catch { /* continue with raw payload */ }

  const activationUid = webhookPayload.entityId;
  const entitlementUid = currentState?.activation?.entitlement?.id;
  const currentActivationState = currentState?.activation?.state;
  const activityName = webhookPayload.activityName;

  console.log(`[agent] Activation: ${activationUid}`);
  console.log(`[agent] Entitlement: ${entitlementUid}`);
  console.log(`[agent] State: ${currentActivationState}`);
  console.log(`[agent] Activity: ${activityName}`);

  // ── Step 2: Gather context from EMS ───────────────────────────────────────
  console.log('[agent] Gathering EMS context...');

  const [activationData, entitlementData, activationHistory] = await Promise.all([
    activationUid && entitlementUid ? getActivationDetails(entitlementUid, activationUid) : null,
    entitlementUid ? getEntitlementDetails(entitlementUid) : null,
    entitlementUid ? getActivationHistory(entitlementUid) : null
  ]);

  const allActivations = activationHistory?.activations?.activation || [];
  const failedActivations = allActivations.filter(a =>
    ['REVOKED', 'REVOKE_CONFIRMED', 'REVOKE_CONFIRMATION_PENDING', 'FAILED', 'ERROR'].includes(a.state)
  );
  const activeActivations = allActivations.filter(a => a.state === 'ACTIVATED');

  console.log(`[agent] Total activations: ${allActivations.length}, Failed: ${failedActivations.length}, Active: ${activeActivations.length}`);

  // ── Step 3: Ask Gemini to reason over ALL gathered context ─────────────────
  const investigationPrompt = `You are an EMS Activation Monitoring Agent. Analyse the following data and determine:
1. Is this a genuine failure that warrants an alert?
2. What is the severity (LOW / MEDIUM / HIGH / CRITICAL)?
3. What is the likely cause?
4. What action should be taken?

WEBHOOK EVENT:
- Activity: ${activityName}
- Activation UID: ${activationUid}
- Current State: ${currentActivationState}
- Entitlement UID: ${entitlementUid}

ENTITLEMENT CONTEXT:
${entitlementData ? JSON.stringify(entitlementData, null, 2) : 'Could not retrieve entitlement data'}

ACTIVATION DETAILS:
${activationData ? JSON.stringify(activationData, null, 2) : 'Could not retrieve activation details'}

ACTIVATION HISTORY ON THIS ENTITLEMENT:
- Total activations: ${allActivations.length}
- Currently active: ${activeActivations.length}
- Previously failed/revoked: ${failedActivations.length}
- Recent failed UIDs: ${failedActivations.slice(0, 3).map(a => a.id).join(', ') || 'none'}

Respond ONLY with valid JSON, no markdown:
{
  "should_alert": true or false,
  "severity": "LOW | MEDIUM | HIGH | CRITICAL",
  "is_failure": true or false,
  "product_name": "product name or unknown",
  "customer_name": "customer name or unknown",
  "entitlement_id": "eid or unknown",
  "failure_reason": "concise description",
  "pattern_detected": "one-off | repeated | first-failure",
  "remaining_active": ${activeActivations.length},
  "recommended_action": "what should be done",
  "summary": "2-3 sentence plain English summary for ops team"
}`;

  console.log('[agent] Asking Gemini to reason over context...');
  let analysis;
  try {
    const raw = await callGemini(investigationPrompt);
    console.log('[agent] Gemini analysis:', raw);
    analysis = JSON.parse(raw);
  } catch (err) {
    console.error('[agent] Gemini analysis failed:', err.message);
    // Fall back to basic alert
    analysis = {
      should_alert: true,
      severity: 'MEDIUM',
      is_failure: true,
      product_name: 'unknown',
      customer_name: 'unknown',
      entitlement_id: entitlementUid || 'unknown',
      failure_reason: currentActivationState || 'Unknown failure state',
      pattern_detected: 'unknown',
      remaining_active: activeActivations.length,
      recommended_action: 'Investigate manually',
      summary: `Activation ${activationUid} entered state ${currentActivationState}.`
    };
  }

  // ── Step 4: Send alert only if agent decides it warrants one ───────────────
  if (!analysis.should_alert) {
    console.log('[agent] No alert needed — agent determined this is not actionable');
    return;
  }

  console.log(`[agent] Alert warranted — Severity: ${analysis.severity}`);

  const subject = `[${analysis.severity}] EMS Activation Alert — ${analysis.product_name} — ${analysis.customer_name}`;

  const emailBody = `EMS ACTIVATION ALERT
====================
Severity         : ${analysis.severity}
Product          : ${analysis.product_name}
Customer         : ${analysis.customer_name}
Entitlement ID   : ${analysis.entitlement_id}
Activation UID   : ${activationUid}
State            : ${currentActivationState}
Activity         : ${activityName}
Pattern          : ${analysis.pattern_detected}
Remaining Active : ${analysis.remaining_active}

AGENT ASSESSMENT
----------------
${analysis.summary}

Failure Reason   : ${analysis.failure_reason}
Recommended Action: ${analysis.recommended_action}

ACTIVATION HISTORY
------------------
Total activations on this entitlement : ${allActivations.length}
Currently active                       : ${activeActivations.length}
Previously failed/revoked              : ${failedActivations.length}

EMS LINKS
---------
Entitlement : ${EMS_BASE_URL}/admin/entitlements/${entitlementUid}
Activation  : ${activationUid}
Timestamp   : ${webhookPayload.opDatetime}
`;

  await sendEmail(subject, emailBody);
  console.log('[agent] Investigation complete — alert sent');
}

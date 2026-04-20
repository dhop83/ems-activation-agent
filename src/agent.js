const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = 'dale1383@gmail.com';

const SYSTEM_PROMPT = `You are an EMS Activation Monitoring Agent.

You will receive a webhook payload from Sentinel EMS. Your job is to determine if it represents a failed activation.

Failure states to detect: FAILED, ERROR, REJECTED, EXPIRED, REVOKED, REVOKE_CONFIRMED, REVOKE_CONFIRMATION_PENDING — or any non-ACTIVE/non-PENDING state on an activation event.

Respond ONLY with a valid JSON object — no markdown, no explanation, nothing else:

{
  "is_failure": true or false,
  "entitlement_uid": "uid or unknown",
  "activation_uid": "uid or unknown",
  "failure_reason": "description of the failure or null",
  "timestamp": "ISO timestamp from payload or now",
  "summary": "One sentence plain English summary of what happened"
}`;

async function callGemini(payload) {
  const body = {
    contents: [
      {
        parts: [
          { text: SYSTEM_PROMPT },
          { text: `Webhook payload:\n${JSON.stringify(payload, null, 2)}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048
    }
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
  console.log('[gemini] Raw response:', text);

  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function sendEmail(result, rawPayload) {
  console.log('[email] Preparing to send via Resend...');
  console.log('[email] RESEND_API_KEY present:', !!RESEND_API_KEY);
  console.log('[email] Sending to:', ALERT_EMAIL);

  const emailBody = {
    from: 'EMS Agent <onboarding@resend.dev>',
    to: ALERT_EMAIL,
    subject: `EMS Activation Failure Alert — Entitlement ${result.entitlement_uid}`,
    text: `EMS ACTIVATION FAILURE DETECTED
================================

Entitlement UID : ${result.entitlement_uid}
Activation UID  : ${result.activation_uid}
Failure Reason  : ${result.failure_reason}
Timestamp       : ${result.timestamp}
Summary         : ${result.summary}

--- Raw Payload ---
${JSON.stringify(rawPayload, null, 2)}`
  };

  console.log('[email] Calling Resend API...');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailBody)
  });

  console.log('[email] Resend HTTP status:', response.status);

  const data = await response.json();
  console.log('[email] Resend response:', JSON.stringify(data));

  if (data.error) {
    throw new Error(`Resend error: ${JSON.stringify(data.error)}`);
  }

  console.log(`[email] Alert sent successfully — ID: ${data.id}`);
}

export async function runAgent(webhookPayload) {
  console.log('[agent] Evaluating payload with Gemini...');

  try {
    const result = await callGemini(webhookPayload);
    console.log('[agent] Decision:', result);

    if (result.is_failure) {
      console.log('[agent] Failure detected — sending email alert');
      try {
        await sendEmail(result, webhookPayload);
      } catch (emailErr) {
        console.error('[email] Send failed:', emailErr.message);
        console.error('[email] Stack:', emailErr.stack);
      }
    } else {
      console.log('[agent] No action required');
    }
  } catch (agentErr) {
    console.error('[agent] Error:', agentErr.message);
    console.error('[agent] Stack:', agentErr.stack);
  }
}

import nodemailer from 'nodemailer';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const ALERT_EMAIL = 'dale.hopkinson@thalesgroup.com';

const SYSTEM_PROMPT = `You are an EMS Activation Monitoring Agent.

You will receive a webhook payload from Sentinel EMS. Your job is to determine if it represents a failed activation.

Failure states to detect: FAILED, ERROR, REJECTED, EXPIRED, REVOKED — or any non-ACTIVE/non-PENDING state on an activation event.

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
      maxOutputTokens: 512
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

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function sendEmail(result, rawPayload) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const subject = `EMS Activation Failure Alert — Entitlement ${result.entitlement_uid}`;

  const body = `
EMS ACTIVATION FAILURE DETECTED
================================

Entitlement UID : ${result.entitlement_uid}
Activation UID  : ${result.activation_uid}
Failure Reason  : ${result.failure_reason}
Timestamp       : ${result.timestamp}
Summary         : ${result.summary}

--- Raw Payload ---
${JSON.stringify(rawPayload, null, 2)}
  `.trim();

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: ALERT_EMAIL,
    subject,
    text: body
  });

  console.log(`[email] Alert sent to ${ALERT_EMAIL}`);
}

export async function runAgent(webhookPayload) {
  console.log('[agent] Evaluating payload with Gemini...');

  const result = await callGemini(webhookPayload);
  console.log('[agent] Decision:', result);

  if (result.is_failure) {
    console.log('[agent] Failure detected — sending email alert');
    await sendEmail(result, webhookPayload);
  } else {
    console.log('[agent] No failure — no action required');
  }
}

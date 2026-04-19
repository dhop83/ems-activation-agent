# EMS Activation Agent (Gemini)

Autonomous agent. Receives Sentinel EMS webhook events, uses Gemini to detect activation failures, emails dale.hopkinson@thalesgroup.com.

## Stack
- **Runtime**: Node.js on Railway
- **AI**: Google Gemini 1.5 Flash (free tier)
- **Email**: Nodemailer via SMTP
- **Trigger**: Sentinel EMS webhook

## Architecture

```
EMS Activation Event
    ↓
EMS Webhook → POST /webhook/ems (Railway)
    ↓
Express receives + acknowledges (200)
    ↓
Gemini evaluates payload — failure?
    ↓
Yes → Nodemailer → Email alert
No  → Exit cleanly
```

## Deploy

### Step 1 — Get a free Gemini API key
Go to aistudio.google.com → Get API Key → Create API key

### Step 2 — Push to GitHub
```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/dhop83/ems-activation-agent.git
git push -u origin main
```

### Step 3 — Deploy on Railway
New Project → Deploy from GitHub → select repo

### Step 4 — Set environment variables in Railway
```
GEMINI_API_KEY=your_key
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.gmail@gmail.com
SMTP_PASS=your_gmail_app_password
```

### Step 5 — Generate Railway domain
Settings → Domains → Generate Domain
Your endpoint: https://your-app.railway.app/webhook/ems

### Step 6 — Register webhook in EMS via Claude
Come back to Claude with the Railway URL and run ems_create_webhook

## Gmail App Password Setup
1. Enable 2FA on Google account
2. Go to myaccount.google.com/apppasswords
3. Generate password for "Mail"
4. Use as SMTP_PASS

## Email Alert Format
**Subject:** EMS Activation Failure Alert — Entitlement [uid]
**Body:** Entitlement UID, Activation UID, Failure reason, Timestamp, Summary, Raw payload

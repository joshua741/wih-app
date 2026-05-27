# WIH App — Setup Guide

## What This Is
Webber Investment Homes autonomous wholesale operation. AI agent "Vince" handles all top-of-funnel SMS conversations across three pipelines. Joshua and Angel only touch deals when it's time to close.

## Prerequisites
- Railway account (railway.app)
- Twilio account with 2 purchased phone numbers
- Anthropic API key
- GitHub repo (push this folder to one)

---

## Step 1 — Get Your Credentials

### Twilio
1. Go to console.twilio.com
2. Copy **Account SID** and **Auth Token**
3. Buy 2 phone numbers:
   - One for **Agent Outreach** (AI texting RE agents)
   - One for **Seller Inbound** (AI texting motivated sellers)

### Anthropic
1. Go to console.anthropic.com
2. Create an API key

---

## Step 2 — Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Railway auto-detects the `railway.toml` and builds

### Add PostgreSQL
In Railway dashboard: **New** → **Database** → **PostgreSQL**
Railway automatically sets `DATABASE_URL` in your environment.

### Set Environment Variables
In Railway dashboard → your service → **Variables**, add:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_OUTREACH_NUMBER=+1xxxxxxxxxx     ← Agent Outreach number
TWILIO_SELLER_NUMBER=+1xxxxxxxxxx       ← Seller Inbound number
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
JOSH_PHONE=+18067818495
ANGEL_PHONE=+18063170334
NODE_ENV=production
```

Railway sets `PORT` and `DATABASE_URL` automatically — do not add those.

---

## Step 3 — Run Database Migration

In Railway dashboard → your service → **Shell**:
```bash
npm run migrate
```

This creates all tables and seeds the pipeline stages.

---

## Step 4 — Configure Twilio Webhooks

In Twilio console, for each phone number:

**Agent Outreach number:**
- Messaging → Webhook: `https://your-app.railway.app/webhooks/sms/inbound` (POST)
- Status Callback: `https://your-app.railway.app/webhooks/sms/status` (POST)
- Voice → Webhook: `https://your-app.railway.app/webhooks/voice/inbound` (POST)
- Status Callback: `https://your-app.railway.app/webhooks/voice/status` (POST)

**Seller Inbound number:** Same URLs above.

---

## Step 5 — End-to-End Test

### Test 1: Health Check
```
GET https://your-app.railway.app/health
```
Expected: `{"status":"ok","ts":"..."}`

### Test 2: Simulated Inbound SMS
Send yourself a text from a non-DNC number to either Twilio number. Within ~10 seconds Vince should reply.

### Test 3: Dashboard
Open `https://your-app.railway.app` in a browser. You should see the Kanban board with the contact that just texted.

### Test 4: Click-to-Call
From the dashboard, open the lead panel and click **Call with Angel**. Angel's phone (806-317-0334) should ring first, then bridge to the lead when answered.

---

## Pipeline Reference

| Pipeline | AI Number | Handles |
|---|---|---|
| Agent Outreach | TWILIO_OUTREACH_NUMBER | RE agents with off-market deals |
| Seller Inbound | TWILIO_SELLER_NUMBER | Motivated sellers (ISP-to-Lead) |
| Active Deals | N/A | Deals under contract → disposition |

## Deal Routing
- **Cash deal** (asking ≤ MAO = ARV×70% - repairs - $10k) → Angel (806-317-0334)
- **Creative deal** (near-retail, low equity, <5% mortgage, free-and-clear) → Josh (806-781-8495)
- **Dead deal** (numbers don't work) → politely passed, stage set to dead

## DNC
Any STOP/UNSUBSCRIBE/REMOVE ME → one final reply → never contacted again.

## Human Takeover Triggers
Vince flags for human when: frustrated language, asks for real person, deal >$500K, legal mention, 10+ messages no progress.
- Cash leads → Angel notified via SMS
- Creative leads → Josh notified via SMS

---

## Local Development

```bash
# Copy env file
cp .env.example .env
# Fill in your real credentials

# Install deps
npm install
cd client && npm install && cd ..

# Run DB migration (needs DATABASE_URL)
npm run migrate

# Start backend
npm run dev

# In another terminal, start frontend
cd client && npm run dev
```

Frontend dev server runs at `http://localhost:5173` and proxies API calls to `localhost:3001`.

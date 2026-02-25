# MediBook — Deployment Guide

## Recommended Stack (cheapest to start)

| Service | What for | Cost |
|---------|----------|------|
| [Railway](https://railway.app) | Backend + PostgreSQL | ~$5–20/mo |
| [Vercel](https://vercel.com) | Frontend static files | Free |
| [Supabase](https://supabase.com) | PostgreSQL (alternative) | Free tier |

---

## 1. Deploy the Backend (Railway)

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select the `medibook` repo
4. Set **Root Directory** to `backend`
5. Ensure Railway is using `backend/nixpacks.toml` (this avoids workspace autodetect bugs)
6. Railway should run:
   - Build: `npm run build`
   - Start: `npm start`
7. Add a **PostgreSQL** plugin in Railway → copy the `DATABASE_URL`
8. Add all environment variables from `.env.example` in Railway's Variables tab
9. Deploy → copy the generated URL (e.g. `https://medibook-backend.up.railway.app`)

---

## 2. Deploy the Frontend (Vercel)

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Set **Root Directory** to `frontend`
3. **Framework**: Other (static)
4. Leave **Output Directory** empty (or use `.`)
5. Deploy → your frontend is live at `https://medibook.vercel.app`

---

## 3. Configure Twilio Webhooks

1. Go to [console.twilio.com](https://console.twilio.com)
2. Buy a phone number (or use an existing one)
3. Set the webhook URL on your number:
   - **Voice webhook**: `https://your-backend.railway.app/voice/inbound`
   - **Method**: POST
4. For each clinic, assign a Twilio number and store it against the tenant record

---

## 4. Configure Stripe Webhooks

1. Go to [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://your-backend.railway.app/billing/webhooks`
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
4. Copy the **Signing Secret** → set as `STRIPE_WEBHOOK_SECRET` in your env

---

## 5. Create Stripe Products

1. Go to Stripe Dashboard → Products → Add Product
2. Create three products:
   - **MediBook Starter** — £49/month recurring → copy Price ID → `STRIPE_PRICE_STARTER`
   - **MediBook Pro** — £129/month recurring → copy Price ID → `STRIPE_PRICE_PRO`
   - **MediBook Enterprise** — custom → copy Price ID → `STRIPE_PRICE_ENTERPRISE`
3. Add the Price IDs to your environment variables

---

## 6. Run Database Migrations

After deploying, run migrations against your production database:

```bash
# From your local machine, with DATABASE_URL pointing to production
cd backend
DATABASE_URL="postgresql://..." npx prisma migrate deploy
npx prisma generate
```

Or via Railway's shell:
```bash
npx prisma migrate deploy
```

---

## 7. Environment Variables Checklist

Before going live, verify every variable is set:

```
✓ PORT
✓ NODE_ENV=production
✓ PUBLIC_URL                  ← your backend URL
✓ FRONTEND_URL                ← your frontend URL
✓ DATABASE_URL
✓ JWT_SECRET                  ← generate: openssl rand -base64 32
✓ OPENAI_API_KEY
✓ OPENAI_MODEL=gpt-4o
✓ ELEVENLABS_API_KEY
✓ ELEVENLABS_MODEL=eleven_turbo_v2
✓ DEEPGRAM_API_KEY
✓ DEEPGRAM_MODEL=nova-2-medical
✓ TWILIO_ACCOUNT_SID
✓ TWILIO_AUTH_TOKEN
✓ TWILIO_PHONE_NUMBER
✓ STRIPE_SECRET_KEY           ← use sk_live_... in production
✓ STRIPE_PUBLISHABLE_KEY      ← use pk_live_... in production
✓ STRIPE_WEBHOOK_SECRET
✓ STRIPE_PRICE_STARTER
✓ STRIPE_PRICE_PRO
✓ STRIPE_PRICE_ENTERPRISE
✓ RESEND_API_KEY
✓ EMAIL_FROM
✓ EMAIL_REPLY_TO
```

---

## 8. Domain Setup (optional but recommended)

**Backend API**: Point `api.yourdomain.com` → Railway app
**Frontend app**: Point `app.yourdomain.com` → Vercel deployment
**Admin panel**: Point `admin.yourdomain.com` → Vercel (`/admin` path)
**Clinic subdomains**: `*.yourdomain.com` → Vercel with wildcard routing

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/yourusername/medibook.git
cd medibook/backend

# 2. Install
npm install

# 3. Environment
cp ../.env.example .env
# fill in .env values

# 4. Database
npx prisma migrate dev --name init
npx prisma generate

# 5. Run backend
npm run dev
# → http://localhost:3001

# 6. Run frontend (separate terminal)
cd ../frontend
npx serve pages
# → http://localhost:3000

# 7. Expose backend for Twilio (use ngrok or cloudflared)
ngrok http 3001
# Copy the https URL → set as PUBLIC_URL in .env
# Update Twilio webhook to: https://xxxx.ngrok.io/voice/inbound

# 8. Listen for Stripe webhooks locally
stripe listen --forward-to localhost:3001/billing/webhooks
# Copy whsec_... → set as STRIPE_WEBHOOK_SECRET in .env
```

---

## Costs at Scale

At 100 clinics on Pro (£129/mo = £12,900 MRR):

| Service | Usage | Monthly Cost |
|---------|-------|-------------|
| GPT-4o | ~50k calls × £0.03 | ~£1,500 |
| ElevenLabs | ~50k synths | ~£800 |
| Deepgram | ~50k transcripts | ~£200 |
| Twilio | ~50k calls + SMS | ~£400 |
| Railway | Backend + DB | ~£50 |
| Vercel | Frontend | Free |
| **Total infra** | | **~£2,950** |
| **Gross margin** | | **~77%** |

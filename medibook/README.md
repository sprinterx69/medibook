# MediBook 🏥

> AI-powered clinic management SaaS — bookings, voice agent, billing, multi-tenancy.

A full-stack SaaS platform for aesthetics and wellness clinics. Each clinic gets their own AI voice receptionist that answers calls 24/7, books appointments, handles cancellations, and answers FAQs — all configured from a self-serve dashboard.

---

## What's Built

| Module | Description |
|--------|-------------|
| **Landing Page** | Marketing page with pricing, features, CTA |
| **Onboarding** | 5-step wizard: clinic setup → services → team → plan → payment |
| **Clinic Dashboard** | Calendar, clients, payments, staff management |
| **AI Voice Agent** | Full Twilio + Deepgram + GPT-4o + ElevenLabs pipeline |
| **Agent Settings** | Per-clinic voice, greeting, FAQs, booking rules configuration |
| **Super Admin Panel** | Operator control: all clinics, revenue, AI performance, API key management |
| **Billing** | Stripe subscriptions, trials, webhooks, plan enforcement |

---

## Tech Stack

**Backend**
- [Fastify](https://fastify.dev/) — HTTP + WebSocket server
- [Prisma](https://prisma.io/) — ORM + PostgreSQL
- [OpenAI GPT-4o](https://platform.openai.com/) — AI reasoning & tool calls
- [Deepgram](https://deepgram.com/) — Real-time speech-to-text (`nova-2-medical`)
- [ElevenLabs](https://elevenlabs.io/) — Text-to-speech (`eleven_turbo_v2`)
- [Twilio](https://twilio.com/) — Phone calls, media streaming, SMS
- [Stripe](https://stripe.com/) — Subscriptions, billing, webhooks

**Frontend**
- Vanilla HTML/CSS/JS — zero framework dependencies, fully self-contained pages
- Served as static files (any CDN, Nginx, or Vercel)

**Database**
- PostgreSQL with multi-tenant row-level isolation via `tenantId` on every table

---

## Project Structure

```
medibook/
├── backend/
│   ├── prisma/
│   │   └── schema.prisma          # Full DB schema — all models
│   └── src/
│       ├── server.js              # Fastify entry point, route registration
│       ├── handlers/
│       │   ├── inbound-call.js    # Twilio webhook — answers incoming calls
│       │   └── media-stream.js    # WebSocket — real-time audio pipeline
│       ├── services/
│       │   ├── llm.js             # GPT-4o — system prompt builder + tool calls
│       │   ├── deepgram.js        # STT — WebSocket transcription
│       │   ├── tts.js             # ElevenLabs — audio synthesis + streaming
│       │   ├── booking.js         # Appointment creation / cancellation / reschedule
│       │   ├── calendar.js        # Availability checking
│       │   ├── billing.js         # Stripe — checkout, portal, plan management
│       │   ├── session-store.js   # In-memory call session state
│       │   └── tenant-and-utils.js # Tenant resolution, phone number lookup
│       ├── routes/
│       │   └── billing-routes.js  # Stripe webhook + checkout endpoints
│       └── middleware/
│           └── feature-gates.js   # Plan-based feature enforcement
├── frontend/
│   └── pages/
│       ├── landing.html           # Public marketing page
│       ├── onboarding.html        # New clinic signup wizard
│       ├── dashboard.html         # Main clinic dashboard
│       ├── agent-settings.html    # AI voice agent configuration
│       ├── preview.html           # Full platform preview (all views)
│       └── admin/
│           └── index.html         # Super admin operator panel
├── docs/
│   ├── ARCHITECTURE.md            # System design & data flow
│   ├── API.md                     # Backend API reference
│   └── DEPLOYMENT.md              # Production deployment guide
├── .github/
│   └── workflows/
│       └── deploy.yml             # GitHub Actions CI/CD
├── .env.example                   # All required environment variables
├── .gitignore
└── package.json                   # Root monorepo config
```

---

## Quick Start

### Prerequisites
- Node.js ≥ 18
- PostgreSQL database
- Accounts: OpenAI, ElevenLabs, Deepgram, Twilio, Stripe

### 1. Clone & install

```bash
git clone https://github.com/yourusername/medibook.git
cd medibook
cd backend && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env (see Environment Variables section below)
```

### 3. Set up the database

```bash
cd backend
npx prisma migrate dev --name init
npx prisma generate
```

### 4. Run the backend

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3001`.

### 5. Serve the frontend

The frontend is plain HTML — serve the `frontend/pages/` directory with any static server:

```bash
# Quick local preview
npx serve frontend/pages

# Or open individual files directly in your browser
open frontend/pages/landing.html
```

---

## Environment Variables

All variables are documented in `.env.example`. Key ones:

| Variable | Where to get it |
|----------|----------------|
| `DATABASE_URL` | Your PostgreSQL connection string |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ELEVENLABS_API_KEY` | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) |
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com) |
| `TWILIO_ACCOUNT_SID` | [console.twilio.com](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | [console.twilio.com](https://console.twilio.com) |
| `STRIPE_SECRET_KEY` | [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → your endpoint |

---

## How the AI Voice Agent Works

```
Caller phones clinic number (Twilio)
        │
        ▼
POST /voice/inbound (inbound-call.js)
  → Looks up clinic by phone number (tenantId)
  → Loads clinic config (greeting, services, FAQs, rules)
  → Returns TwiML to connect WebSocket media stream
        │
        ▼
WebSocket /voice/stream (media-stream.js)
  → Receives μ-law audio chunks from Twilio
  → Pipes audio to Deepgram WebSocket (STT)
        │
        ▼
Deepgram transcript event
  → Appends transcript to session message history
  → Sends messages to GPT-4o with clinic system prompt
        │
        ▼
GPT-4o response (llm.js)
  → May call tools: check_availability, book_appointment,
    cancel_appointment, reschedule_appointment, get_clinic_info
  → Tools execute against Prisma/DB filtered by tenantId
  → Final text response returned
        │
        ▼
ElevenLabs TTS (tts.js)
  → Streams audio chunks back through Twilio WebSocket
  → Caller hears the response in < 2 seconds end-to-end
```

---

## Multi-Tenancy

Every database table has a `tenantId` column. Every query filters by it:

```js
// Every data access is automatically scoped to one clinic
const appointments = await prisma.appointment.findMany({
  where: { tenantId: req.tenant.id, startsAt: { gte: today } }
});
```

Phone numbers → tenant resolution:
```js
const tenant = await getTenantByPhoneNumber(twilioTo);
// Loads that clinic's full config: greeting, services, FAQs, voice, rules
```

---

## Stripe Billing Plans

| Plan | Price | Features |
|------|-------|----------|
| **Starter** | £49/mo | Booking dashboard, up to 2 staff, 1 location, no AI voice |
| **Pro** | £129/mo | Everything + AI voice agent, unlimited staff, 3 locations |
| **Enterprise** | Custom | White-label, custom voice, HIPAA BAA, dedicated support |

Webhooks handled: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.deleted`

---

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for full production setup including:
- Railway / Render / Fly.io backend deployment
- Vercel / Netlify / Cloudflare Pages for frontend
- PostgreSQL on Supabase or Railway
- Twilio webhook configuration
- Stripe webhook registration
- Environment variable checklist

---

## License

MIT — use freely, build on top, don't hold us liable.

# MediBook — Architecture

## System Overview

MediBook is a multi-tenant SaaS platform. One codebase, one server, one AI model — serving every clinic with full data isolation via `tenantId`.

## Data Flow — Inbound Call

```
┌─────────────────────────────────────────────────────────┐
│                    CALLER'S PHONE                        │
└──────────────────────┬──────────────────────────────────┘
                       │ dials clinic number
                       ▼
┌─────────────────────────────────────────────────────────┐
│                      TWILIO                              │
│  Receives call → POST /voice/inbound                    │
│  Opens WebSocket media stream to our server             │
└──────────┬───────────────────────────────┬──────────────┘
           │ TwiML                         │ Audio (μ-law)
           ▼                               ▼
┌──────────────────┐            ┌──────────────────────────┐
│  inbound-call.js │            │     media-stream.js       │
│  • Resolve tenant│            │  • Buffer audio chunks    │
│    by phone no.  │            │  • Pipe to Deepgram WS    │
│  • Load config   │            │  • Handle transcripts     │
│  • Return TwiML  │            │  • Call GPT-4o            │
└──────────────────┘            │  • Stream TTS back        │
                                └──────────┬───────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                       │
                    ▼                      ▼                       ▼
          ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐
          │   Deepgram STT  │   │   GPT-4o (llm.js)│   │ ElevenLabs TTS  │
          │  nova-2-medical │   │  • System prompt  │   │ eleven_turbo_v2 │
          │  ~200ms latency │   │  • Tool calls     │   │  ~310ms first   │
          └─────────────────┘   │  • Intent detect  │   │  audio chunk    │
                                └────────┬─────────┘   └──────────────────┘
                                         │
                              ┌──────────┴──────────┐
                              │    Tool Calls        │
                              │  check_availability  │
                              │  book_appointment    │
                              │  cancel_appointment  │
                              │  reschedule          │
                              │  get_clinic_info     │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │     PostgreSQL        │
                              │  (via Prisma ORM)     │
                              │  All queries filter   │
                              │  by tenantId          │
                              └──────────────────────┘
```

## Multi-Tenancy Model

```
Tenant (Clinic)
├── tenantId: uuid (primary isolation key)
├── slug: "lumiere-aesthetics" → lumiere.medibook.io
├── plan: STARTER | PRO | ENTERPRISE
├── settings: JSON {
│     greeting, afterHoursGreeting, agentName,
│     voiceId, faqs[], services[], rules{},
│     businessHours{}, personality, language
│   }
└── phoneNumbers: String[] → used for inbound call routing

Every table: Appointment, Client, Staff, Service, CallLog
has tenantId and every query WHERE tenantId = req.tenant.id
```

## System Prompt Architecture

Each call builds a custom system prompt from the tenant's DB record:

```
IDENTITY
  You are {agentName}, receptionist for {clinicName}
  Address: {address}
  Voice: {voiceName}
  Tone: {personality}

BUSINESS HOURS
  Monday–Friday: 9am–7pm
  Saturday: 10am–4pm
  ...

SERVICES (from DB, filtered by tenant)
  • Hydrafacial — 60 min — £180
  • Botox — 30 min — £280
  ...

RULES
  • Min booking advance: 4 hours
  • Require deposit for injectables
  • Offer consultation to first-time callers
  ...

KNOWLEDGE BASE (FAQs from DB)
  Q: Do you offer parking?
  A: Yes, NCP on Wimpole Street...
  ...

TOOLS AVAILABLE
  check_availability, book_appointment, cancel_appointment,
  reschedule_appointment, get_clinic_info

NEVER DO
  • Never mention competitors
  • Never promise specific results
```

Same GPT-4o model. Different prompt = different agent persona per clinic.

## Latency Budget (End-to-End)

```
Caller speaks → silence detected (Deepgram endpointing): ~300ms
Deepgram transcript arrives:                              ~200ms
GPT-4o response (no tool call):                          ~800ms
GPT-4o response (with tool call):                       ~1,400ms
ElevenLabs first audio chunk:                            ~310ms
Twilio audio playback starts:                             ~50ms
─────────────────────────────────────────────────────────────────
Total (no tool call):                                    ~1,660ms
Total (with tool call):                                  ~2,260ms
```

## Database Schema Summary

```
Tenant          — one per clinic, holds all config
├── Location    — physical locations (multi-site support)
├── Staff       — team members + availability
├── Service     — treatments with price/duration
├── Client      — patient records
├── Appointment — bookings (linked to client, staff, service)
├── Payment     — deposit + full payments via Stripe
├── Subscription — Stripe subscription record
└── CallLog     — full transcript + metadata per AI call
```

## Billing Flow

```
Clinic signs up
  → Stripe Checkout Session created
  → Clinic redirected to Stripe hosted page
  → Payment captured
  → Stripe sends webhook: checkout.session.completed
  → Our server: creates/updates Subscription record
  → Tenant.plan updated to PRO or ENTERPRISE
  → Feature gates unlocked

Monthly renewal:
  → invoice.payment_succeeded → update currentPeriodEnd
  → invoice.payment_failed   → status = PAST_DUE, agent paused

Cancellation:
  → customer.subscription.deleted → status = CANCELLED
  → Tenant.plan → STARTER
  → Feature gates re-applied
```

# MediBook — API Reference

Base URL: `https://api.yourdomain.com`

All authenticated routes require `Authorization: Bearer <jwt_token>` header.

---

## Voice Agent (Twilio Webhooks)

### POST /voice/inbound
Twilio calls this when a call arrives. Returns TwiML to start media stream.

**No auth required** — Twilio signature validation applied.

**Body** (form-encoded, from Twilio):
```
To: +441234567890
From: +447700900123
CallSid: CA...
```

**Response**: TwiML XML

---

### WebSocket /voice/stream
Twilio connects here for real-time audio streaming.

**Protocol**: WebSocket  
**Messages**: Twilio Media Stream JSON frames (start, media, stop)

---

## Billing

### POST /billing/checkout
Create a Stripe Checkout session for plan upgrade.

**Auth**: Required

**Body**:
```json
{
  "plan": "PRO",
  "successUrl": "https://app.yourdomain.com/dashboard?upgraded=true",
  "cancelUrl": "https://app.yourdomain.com/billing"
}
```

**Response**:
```json
{
  "url": "https://checkout.stripe.com/..."
}
```

---

### POST /billing/portal
Get Stripe Customer Portal URL for self-serve billing management.

**Auth**: Required

**Response**:
```json
{
  "url": "https://billing.stripe.com/..."
}
```

---

### POST /billing/webhooks
Stripe sends events here. Handles:
- `checkout.session.completed` → activate subscription
- `invoice.payment_succeeded` → renew subscription
- `invoice.payment_failed` → mark past_due
- `customer.subscription.deleted` → downgrade to STARTER

**No auth** — Stripe signature validation applied.

---

## Appointments

### GET /appointments
Get appointments for the authenticated clinic.

**Auth**: Required  
**Query params**: `from`, `to` (ISO date strings), `staffId`, `status`

**Response**:
```json
[
  {
    "id": "uuid",
    "startsAt": "2026-02-21T10:00:00Z",
    "endsAt": "2026-02-21T11:00:00Z",
    "status": "CONFIRMED",
    "client": { "id": "...", "fullName": "Sophie Laurent" },
    "staff": { "id": "...", "name": "Dr. Chen" },
    "service": { "id": "...", "name": "Hydrafacial", "durationMins": 60 }
  }
]
```

---

### POST /appointments
Create a new appointment.

**Auth**: Required

**Body**:
```json
{
  "clientId": "uuid",
  "staffId": "uuid",
  "serviceId": "uuid",
  "startsAt": "2026-02-21T10:00:00Z",
  "source": "dashboard"
}
```

---

### PATCH /appointments/:id
Update appointment status or time.

**Auth**: Required

**Body**:
```json
{
  "status": "CANCELLED",
  "cancellationReason": "Client request"
}
```

---

## Clients

### GET /clients
List all clients for the clinic.

**Auth**: Required  
**Query**: `search`, `limit`, `offset`

---

### POST /clients
Create a new client.

**Auth**: Required

**Body**:
```json
{
  "fullName": "Sophie Laurent",
  "email": "sophie@example.com",
  "phone": "+447700900123"
}
```

---

## Tenant / Settings

### GET /settings/agent
Get current AI agent configuration.

**Auth**: Required

**Response**: Full agent settings JSON (greeting, FAQs, services, rules, voice, hours)

---

### PUT /settings/agent
Save AI agent configuration. Rebuilds system prompt immediately.

**Auth**: Required

**Body**: Full agent settings object (same shape as GET response)

---

## Admin (Super Admin only)

All `/admin/*` routes require `role: SUPER_ADMIN` in JWT.

### GET /admin/clinics
List all tenants with stats.

### GET /admin/clinics/:id
Get detailed clinic info.

### POST /admin/clinics/:id/impersonate
Generate a short-lived JWT scoped to that clinic for support access.

### GET /admin/revenue
MRR, ARR, plan breakdown, recent transactions.

### GET /admin/ai-stats
Aggregated voice agent performance across all clinics.

### PUT /admin/integrations/:service
Update API key or config for a platform integration (OpenAI, ElevenLabs, etc.)

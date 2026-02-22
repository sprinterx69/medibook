// ─────────────────────────────────────────────────────────────────────────────
// handlers/inbound-call.js
//
// Called by Twilio when a call arrives at the clinic's phone number.
// Looks up tenant from the called number, then returns TwiML that:
//   1. Plays a brief greeting while the stream connects
//   2. Opens a Media Stream WebSocket to our server
// ─────────────────────────────────────────────────────────────────────────────

import { getTenantByPhoneNumber } from '../services/tenant.js';
import { createCallSession } from '../services/session-store.js';

/**
 * Generates TwiML to connect Twilio to our Media Stream WebSocket.
 * The <Stream> element tells Twilio to send bidirectional audio to our WS URL.
 */
function buildTwiML(wsUrl, callSid, tenantId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="tenantId" value="${tenantId}" />
    </Stream>
  </Connect>
</Response>`;
}

export async function inboundCallHandler(request, reply) {
  const {
    CallSid,
    From,          // caller's phone number
    To,            // clinic's phone number (used to identify tenant)
    CallStatus,
  } = request.body;

  request.log.info({ CallSid, From, To, CallStatus }, 'Inbound call received');

  try {
    // ── 1. Identify tenant from the called number ─────────────────────────
    const tenant = await getTenantByPhoneNumber(To);
    if (!tenant) {
      request.log.warn({ To }, 'No tenant found for phone number');
      // Fall back to a generic rejection message
      return reply
        .header('Content-Type', 'text/xml')
        .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, this number is not configured. Please try again later.</Say>
  <Hangup/>
</Response>`);
    }

    // ── 2. Create a call session (in-memory store for conversation state) ──
    await createCallSession({
      callSid: CallSid,
      callerPhone: From,
      tenantId: tenant.id,
      tenantName: tenant.name,
      startedAt: new Date(),
    });

    request.log.info(
      { callSid: CallSid, tenant: tenant.name },
      'Call session created'
    );

    // ── 3. Build WebSocket URL for Twilio Media Streams ───────────────────
    const wsUrl = `${process.env.PUBLIC_URL.replace('https', 'wss')}/voice/stream`;

    // ── 4. Return TwiML ───────────────────────────────────────────────────
    return reply
      .header('Content-Type', 'text/xml')
      .send(buildTwiML(wsUrl, CallSid, tenant.id));

  } catch (err) {
    request.log.error({ err, CallSid }, 'Error handling inbound call');
    return reply
      .header('Content-Type', 'text/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, we're having technical difficulties. Please call back shortly.</Say>
  <Hangup/>
</Response>`);
  }
}

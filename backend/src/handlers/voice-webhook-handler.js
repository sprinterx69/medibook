// ─────────────────────────────────────────────────────────────────────────────
// handlers/voice-webhook-handler.js
//
// POST /api/voice-webhook
//
// Twilio calls this endpoint when a call arrives at a clinic number that was
// purchased through the Settings "Buy Number" flow.
//
// Flow:
//   1. Read req.body.To  — the number Twilio dialled (the clinic's number)
//   2. Look up which clinic owns that number via tenant settings
//   3. Return valid TwiML
//
// Future upgrade: replace the <Say>/<Hangup> stub with a <Connect><Stream>
// pointing at the existing /voice/stream WebSocket to enable the full AI agent.
// See the placeholder comment below.
// ─────────────────────────────────────────────────────────────────────────────

import { getTenantByPhoneNumber } from '../services/tenant-and-utils.js';

export async function voiceWebhookHandler(request, reply) {
  const { To, From, CallSid } = request.body ?? {};

  request.log.info({ To, From, CallSid }, 'voice-webhook: inbound call received');

  // ── 1. Identify clinic from the called number ──────────────────────────────
  let tenant;
  try {
    tenant = await getTenantByPhoneNumber(To);
  } catch (err) {
    request.log.error({ err, To }, 'voice-webhook: tenant lookup error');
  }

  if (!tenant) {
    request.log.warn({ To }, 'voice-webhook: no clinic found for number');
    return reply
      .header('Content-Type', 'text/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, this number is not currently configured. Please try again later.</Say>
  <Hangup/>
</Response>`);
  }

  request.log.info({ CallSid, tenantId: tenant.id, clinic: tenant.name }, 'voice-webhook: clinic identified');

  // ── 2. Placeholder — future AI call handling ───────────────────────────────
  //
  // To upgrade this to the full AI voice agent, replace the TwiML below with:
  //
  //   const wsUrl = `${process.env.PUBLIC_URL.replace('https', 'wss')}/voice/stream`;
  //   return reply.header('Content-Type', 'text/xml').send(`
  //     <?xml version="1.0" encoding="UTF-8"?>
  //     <Response>
  //       <Connect>
  //         <Stream url="${wsUrl}">
  //           <Parameter name="callSid"  value="${CallSid}" />
  //           <Parameter name="tenantId" value="${tenant.id}" />
  //         </Stream>
  //       </Connect>
  //     </Response>`);
  //
  // That connects Twilio Media Streams to the existing Deepgram/GPT-4o/ElevenLabs
  // pipeline already running at /voice/stream — no other changes required.
  // ──────────────────────────────────────────────────────────────────────────

  return reply
    .header('Content-Type', 'text/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for calling ${escapeXml(tenant.name)}. Please hold while we connect you.</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`);
}

/** Escapes characters that are invalid inside TwiML XML text nodes. */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

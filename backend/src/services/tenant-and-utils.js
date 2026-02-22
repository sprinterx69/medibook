// ─────────────────────────────────────────────────────────────────────────────
// services/tenant.js  —  Tenant lookup and context builder
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * Finds a tenant by the phone number they have registered.
 * Twilio sends the "To" number which we match to a tenant's config.
 */
export async function getTenantByPhoneNumber(phoneNumber) {
  return prisma.tenant.findFirst({
    where: { settings: { path: ['voiceAgentPhone'], equals: phoneNumber } },
    select: { id: true, name: true, slug: true },
  });
}

/**
 * Loads full tenant context for the system prompt:
 * business name, services, hours, FAQs, location.
 */
export async function getTenantContext(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      services: {
        where: { isActive: true },
        select: { name: true, durationMins: true, priceCents: true },
        orderBy: { name: 'asc' },
      },
    },
  });

  if (!tenant) return null;

  const settings = tenant.settings ?? {};
  const va = settings.voiceAgent ?? {};

  // Format business hours to readable string
  const hoursStr = va.businessHours
    ? Object.entries(va.businessHours)
        .filter(([, h]) => h.open)
        .map(([day, h]) => `${day.charAt(0).toUpperCase() + day.slice(1)} ${h.from}–${h.to}`)
        .join(', ')
    : settings.businessHours ?? 'Monday to Saturday, 9am to 7pm';

  return {
    id: tenant.id,
    name: tenant.name,
    services: tenant.services,
    hours: hoursStr,
    location: settings.address ?? 'Central London',
    phone: settings.publicPhone ?? null,
    faqs: va.faqs ?? settings.voiceAgentFAQs ?? [],
    // Full voice agent config — used by llm.js buildSystemPrompt
    voiceAgent: {
      agentName:        va.agentName        ?? 'Aria',
      voiceId:          va.voiceId          ?? '21m00Tcm4TlvDq8ikWAM',
      greeting:         va.greeting         ?? null,
      afterHoursMessage:va.afterHoursMessage ?? null,
      transferMessage:  va.transferMessage  ?? null,
      clinicContext:    va.clinicContext    ?? '',
      neverSay:         va.neverSay         ?? [],
      faqs:             va.faqs             ?? [],
      enabledServiceIds:va.enabledServiceIds ?? [],
      bookingRules:     va.bookingRules     ?? {},
      isActive:         va.isActive         ?? true,
    },
  };
}

/**
 * Returns FAQ/info for the get_clinic_info tool.
 */
export async function getClinicInfo({ tenantId, topic }) {
  const ctx = await getTenantContext(tenantId);
  if (!ctx) return { error: 'Clinic information not available.' };

  switch (topic) {
    case 'services': {
      const list = ctx.services
        .map(s => `${s.name} (${s.durationMins} mins, £${(s.priceCents / 100).toFixed(0)})`)
        .join('; ');
      return { services: list };
    }
    case 'pricing': {
      const list = ctx.services
        .map(s => `${s.name}: £${(s.priceCents / 100).toFixed(0)}`)
        .join('; ');
      return { pricing: list };
    }
    case 'hours': return { hours: ctx.hours };
    case 'location': return { location: ctx.location };
    case 'faqs': return { faqs: ctx.faqs };
    case 'all': return { ...ctx };
    default: return { info: 'Topic not recognised.' };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// services/transcript.js  —  Save call transcripts to the database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves a call transcript after the call ends.
 * Creates a CallLog record with:
 *   - Full conversation history
 *   - Duration
 *   - Bookings made count
 *   - Caller phone
 */
export async function saveCallTranscript({
  callSid, tenantId, callerPhone, history, durationMs, bookingsMade,
}) {
  try {
    await prisma.callLog.create({
      data: {
        tenantId,
        callSid,
        callerPhone,
        durationMs,
        bookingsMade,
        transcript: history.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        endedAt: new Date(),
      },
    });
  } catch (err) {
    console.error('saveCallTranscript error:', err.message);
    // Non-fatal — don't crash if transcript save fails
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// handlers/status-callback.js  —  Twilio call lifecycle events
// ─────────────────────────────────────────────────────────────────────────────

export async function statusCallbackHandler(request, reply) {
  const { CallSid, CallStatus, CallDuration } = request.body;

  request.log.info({ CallSid, CallStatus, CallDuration }, 'Twilio status callback');

  // Update call log with final status if the call has ended
  if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    try {
      await prisma.callLog.updateMany({
        where: { callSid: CallSid },
        data: { twilioStatus: CallStatus, durationMs: parseInt(CallDuration ?? 0) * 1000 },
      });
    } catch {}
  }

  return reply.code(204).send();
}

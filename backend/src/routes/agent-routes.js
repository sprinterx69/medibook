// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';
// routes/agent-routes.js
//
// REST API for AI voice agent settings.
// Settings are stored in tenant.settings.voiceAgent (JSON column).
//
// GET  /api/tenants/:tenantId/agent-settings  — load current config
// PUT  /api/tenants/:tenantId/agent-settings  — save config
// GET  /api/tenants/:tenantId/agent-prompt    — preview generated system prompt
// ─────────────────────────────────────────────────────────────────────────────




const DEFAULT_BUSINESS_HOURS = {
  monday:    { open: true,  from: '09:00', to: '19:00' },
  tuesday:   { open: true,  from: '09:00', to: '19:00' },
  wednesday: { open: true,  from: '09:00', to: '19:00' },
  thursday:  { open: true,  from: '09:00', to: '19:00' },
  friday:    { open: true,  from: '09:00', to: '19:00' },
  saturday:  { open: true,  from: '10:00', to: '16:00' },
  sunday:    { open: false, from: '10:00', to: '14:00' },
};

const DEFAULT_BOOKING_RULES = {
  minNoticeHours: 2,
  maxFutureDays: 60,
  slotIntervalMins: 15,
  bufferMins: 10,
  newClientPolicy: 'book_directly', // 'book_directly' | 'require_consultation'
  requireDeposit: false,
  depositPercent: 25,
  allowRescheduling: true,
  allowCancellation: true,
  cancellationNoticeHours: 24,
};

/** Format business hours to readable string (used in system prompt) */
function formatHoursForPrompt(hours) {
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return days
    .map((d, i) => {
      const h = hours[d];
      if (!h || !h.open) return `${dayNames[i]}: Closed`;
      return `${dayNames[i]}: ${h.from}–${h.to}`;
    })
    .join(', ');
}

/** Build the system prompt from stored voice agent settings */
function buildPromptFromSettings(tenant, voiceAgent, services) {
  const name = tenant.name;
  const agentName = voiceAgent.agentName || 'Aria';
  const hours = formatHoursForPrompt(voiceAgent.businessHours || DEFAULT_BUSINESS_HOURS);
  const location = tenant.settings?.address || 'Central London';
  const greeting = voiceAgent.greeting || `Hello! Thank you for calling ${name}.`;
  const clinicContext = voiceAgent.clinicContext || '';
  const neverSay = voiceAgent.neverSay || [];
  const rules = voiceAgent.bookingRules || DEFAULT_BOOKING_RULES;

  // Build services list (only enabled ones if configured)
  const enabledIds = voiceAgent.enabledServiceIds || [];
  const availableServices = enabledIds.length > 0
    ? services.filter(s => enabledIds.includes(s.id))
    : services;
  const servicesList = availableServices
    .map(s => `${s.name} (${s.durationMins} mins, £${(s.priceCents / 100).toFixed(0)})`)
    .join('; ') || 'General appointments';

  // Build FAQ section
  const faqLines = (voiceAgent.faqs || [])
    .map(f => `Q: ${f.question}\nA: ${f.answer}`)
    .join('\n\n');

  // Build never-say section
  const neverSayLine = neverSay.length > 0
    ? `\nNEVER use these words/phrases: ${neverSay.join(', ')}`
    : '';

  return `You are ${agentName}, a friendly and professional AI receptionist for ${name}.

OPENING GREETING: When you answer the call, greet the caller with exactly this phrase:
"${greeting}"

YOUR ROLE:
- Help callers book, reschedule, or cancel appointments
- Answer questions about services, pricing, opening hours, and clinic info
- Keep responses concise — this is a phone call. Max 2–3 sentences per turn.
- Speak naturally, like a warm receptionist — no bullet points or lists.

CLINIC INFO:
- Name: ${name}
- Location: ${location}
- Opening Hours: ${hours}
- Services Available: ${servicesList}
${clinicContext ? `\nADDITIONAL CONTEXT:\n${clinicContext}` : ''}

BOOKING RULES:
- Minimum notice required: ${rules.minNoticeHours} hours
- Can book up to: ${rules.maxFutureDays} days in advance
- New clients: ${rules.newClientPolicy === 'require_consultation' ? 'Require a free consultation before booking treatments' : 'Can book directly without prior consultation'}
- Deposits: ${rules.requireDeposit ? `Required (${rules.depositPercent}% of treatment cost)` : 'Not required — full payment on the day'}
- Rescheduling: ${rules.allowRescheduling ? 'Allowed with ' + rules.cancellationNoticeHours + 'h notice' : 'Not allowed by phone — direct to reception'}
- Cancellation: ${rules.allowCancellation ? 'Allowed with ' + rules.cancellationNoticeHours + 'h notice' : 'Direct caller to reception'}

RULES YOU MUST FOLLOW:
1. ALWAYS confirm the caller's full name before creating any booking.
2. ALWAYS call check_availability before booking — never invent or guess time slots.
3. ALWAYS read back booking details (service, date, time, practitioner) and ask for confirmation before completing the booking.
4. If the caller asks to speak to a human, say "Of course, let me transfer you now" and end with [TRANSFER].
5. If you don't know something, say "Let me check that for you" and use a tool.
6. For clinical or medical advice, always refer to a practitioner: "I'd recommend speaking with one of our practitioners for that."
7. Never discuss competitor clinics.${neverSayLine}
${faqLines ? `\nFREQUENTLY ASKED QUESTIONS:\n${faqLines}` : ''}

CURRENT DATE & TIME: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;
}

export default async function agentRoutes(fastify) {
  // ── GET agent settings ────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/agent-settings', async (request, reply) => {
    const { tenantId } = request.params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        services: {
          where: { isActive: true },
          select: { id: true, name: true, durationMins: true, priceCents: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const settings = tenant.settings ?? {};
    const va = settings.voiceAgent ?? {};

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      // Identity
      agentName: va.agentName ?? 'Aria',
      voiceId: va.voiceId ?? '21m00Tcm4TlvDq8ikWAM',
      voicePersonality: va.voicePersonality ?? 65,
      isActive: va.isActive ?? true,
      // Greeting
      greeting: va.greeting ?? `Hello! Thank you for calling ${tenant.name}. How can I help you today?`,
      afterHoursMessage: va.afterHoursMessage ?? `Thank you for calling ${tenant.name}. We're currently closed. Our opening hours are Monday to Saturday, 9am to 7pm. Please call back during business hours or leave a voicemail.`,
      transferMessage: va.transferMessage ?? 'Of course, let me connect you with a member of our team. Please hold for just a moment.',
      businessHours: va.businessHours ?? DEFAULT_BUSINESS_HOURS,
      // Services
      enabledServiceIds: va.enabledServiceIds ?? [],
      // Knowledge base
      faqs: va.faqs ?? [],
      neverSay: va.neverSay ?? [],
      clinicContext: va.clinicContext ?? '',
      // Booking rules
      bookingRules: va.bookingRules ?? DEFAULT_BOOKING_RULES,
      // Available services (from DB)
      services: tenant.services,
    };
  });

  // ── PUT agent settings ────────────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/agent-settings', async (request, reply) => {
    const { tenantId } = request.params;
    const body = request.body;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const currentSettings = tenant.settings ?? {};
    const updatedSettings = {
      ...currentSettings,
      voiceAgent: {
        agentName: body.agentName,
        voiceId: body.voiceId,
        voicePersonality: body.voicePersonality,
        isActive: body.isActive,
        greeting: body.greeting,
        afterHoursMessage: body.afterHoursMessage,
        transferMessage: body.transferMessage,
        businessHours: body.businessHours,
        enabledServiceIds: body.enabledServiceIds,
        faqs: body.faqs,
        neverSay: body.neverSay,
        clinicContext: body.clinicContext,
        bookingRules: body.bookingRules,
        updatedAt: new Date().toISOString(),
      },
    };

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: updatedSettings },
    });

    return { success: true, message: 'Agent settings saved successfully.' };
  });

  // ── GET preview of generated system prompt ────────────────────────────────
  fastify.get('/api/tenants/:tenantId/agent-prompt', async (request, reply) => {
    const { tenantId } = request.params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        services: {
          where: { isActive: true },
          select: { id: true, name: true, durationMins: true, priceCents: true },
        },
      },
    });

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const va = (tenant.settings ?? {}).voiceAgent ?? {};
    const prompt = buildPromptFromSettings(tenant, va, tenant.services);

    return { prompt, charCount: prompt.length, tokenEstimate: Math.ceil(prompt.length / 4) };
  });

  // ── PATCH toggle agent active state ──────────────────────────────────────
  fastify.patch('/api/tenants/:tenantId/agent-settings/toggle', async (request, reply) => {
    const { tenantId } = request.params;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const settings = tenant.settings ?? {};
    const va = settings.voiceAgent ?? {};
    const newActive = !va.isActive;

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { ...settings, voiceAgent: { ...va, isActive: newActive } },
      },
    });

    return { isActive: newActive };
  });
}

// Export the prompt builder so llm.js can use the same logic
export { buildPromptFromSettings };

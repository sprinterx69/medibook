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
function buildPromptFromSettings(tenant, voiceAgent, services, staffList = []) {
  const name         = tenant.name;
  const agentName    = voiceAgent.agentName    || 'Aria';
  const hours        = formatHoursForPrompt(voiceAgent.businessHours || DEFAULT_BUSINESS_HOURS);
  const location     = tenant.settings?.address || '';
  const parking      = tenant.settings?.parking  || '';
  const clinicPhone  = tenant.settings?.phone    || '';
  const greeting     = voiceAgent.greeting     || `Hello! Thank you for calling ${name}.`;
  const clinicContext = voiceAgent.clinicContext || '';
  const neverSay     = voiceAgent.neverSay     || [];
  const rules        = voiceAgent.bookingRules || DEFAULT_BOOKING_RULES;
  const transferNumber = voiceAgent.transferNumber || '';

  // Build services list (only enabled ones if configured)
  const enabledIds = voiceAgent.enabledServiceIds || [];
  const availableServices = enabledIds.length > 0
    ? services.filter(s => enabledIds.includes(s.id))
    : services;
  const servicesList = availableServices
    .map(s => `- ${s.name}: ${s.durationMins} mins, £${(s.priceCents / 100).toFixed(0)}`)
    .join('\n') || '- General appointments';

  // Build staff section
  const staffSection = staffList.length > 0
    ? `\nTEAM MEMBERS:\n${staffList.map(s => `- ${s.name}${s.title ? ` (${s.title})` : ''}`).join('\n')}`
    : '';

  // Build FAQ section
  const faqLines = (voiceAgent.faqs || [])
    .map(f => `Q: ${f.question}\nA: ${f.answer}`)
    .join('\n\n');

  // Build never-say section
  const neverSayLine = neverSay.length > 0
    ? `\n- NEVER use these words or phrases: ${neverSay.join(', ')}`
    : '';

  const depositText = rules.requireDeposit
    ? `A deposit of ${rules.depositPercent ?? 25}% is required at booking.`
    : 'No deposit required — full payment on the day.';

  return `You are ${agentName}, the warm and professional AI receptionist for ${name}.

SPEAKING STYLE — THIS IS CRITICAL:
- You are calm, patient, and genuinely helpful. Never rush the caller.
- Speak naturally and conversationally — as a friendly human receptionist would.
- Keep every response SHORT: 1–3 sentences maximum. This is a phone call, not a chat.
- Never read bullet points or lists aloud. Weave information naturally into sentences.
- Use natural spoken phrases: "Of course", "Absolutely", "Let me just check that for you…"
- If a caller is confused or repeating themselves, stay patient and gently guide them.
- Always wait for the caller to finish before responding.
- If you mishear or are unsure, politely ask: "I'm sorry, could you say that again?"

OPENING GREETING — say this EXACTLY when you answer:
"${greeting}"

YOUR JOB:
- Book, reschedule, and cancel appointments.
- Answer questions about services, prices, opening hours, parking, and the clinic.
- Transfer callers to a human receptionist when they ask.

CLINIC DETAILS:
- Clinic name: ${name}${location ? `\n- Address: ${location}` : ''}${clinicPhone ? `\n- Phone: ${clinicPhone}` : ''}${parking ? `\n- Parking: ${parking}` : ''}
- Opening hours: ${hours}

SERVICES AVAILABLE:
${servicesList}
${staffSection}

BOOKING POLICY:
- Minimum booking notice: ${rules.minNoticeHours} hour${rules.minNoticeHours !== 1 ? 's' : ''} ahead
- Furthest ahead you can book: ${rules.maxFutureDays} days
- New clients: ${rules.newClientPolicy === 'require_consultation' ? 'must book a free consultation before treatments' : 'can book any service directly'}
- Deposits: ${depositText}
- Rescheduling: ${rules.allowRescheduling ? `allowed with ${rules.cancellationNoticeHours}h notice` : 'not available by phone — direct to reception'}
- Cancellation: ${rules.allowCancellation ? `allowed with ${rules.cancellationNoticeHours}h notice` : 'not available by phone — direct to reception'}
${clinicContext ? `\nABOUT THE CLINIC:\n${clinicContext}` : ''}

RULES YOU MUST ALWAYS FOLLOW:
1. Always confirm the caller's full name before creating any booking.
2. Always use check_availability before confirming a time slot — never guess or invent slots.
3. Always read back the full booking details (service, date, time, practitioner) and ask the caller to confirm before finalising.
4. If the caller asks for a human or to be transferred: say "${voiceAgent.transferMessage || 'Of course, let me connect you now.'}" then end with [TRANSFER]${transferNumber ? ` to ${transferNumber}` : ''}.
5. For medical or clinical questions: "I'd recommend speaking with one of our practitioners for that."
6. Never discuss competitor clinics or make negative comparisons.
7. If you don't know something: say "Let me check that for you" and use a tool.${neverSayLine}
${faqLines ? `\nFREQUENTLY ASKED QUESTIONS:\n${faqLines}` : ''}

TODAY'S DATE & TIME: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;
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
      transferNumber: va.transferNumber ?? '',
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
        transferNumber: body.transferNumber,
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
        staff: {
          where: { isActive: true },
          select: { id: true, name: true, title: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!tenant) {
      return reply.status(404).send({ error: 'Tenant not found' });
    }

    const va = (tenant.settings ?? {}).voiceAgent ?? {};

    // Prefer the AI-generated prompt (created during onboarding). Fall back to
    // the dynamically-built prompt for tenants that haven't onboarded yet.
    const prompt = va.systemPrompt || buildPromptFromSettings(tenant, va, tenant.services, tenant.staff);
    const isAiGenerated = !!va.systemPrompt;

    return {
      prompt,
      isAiGenerated,
      generatedAt:   va.systemPromptGeneratedAt ?? null,
      charCount:     prompt.length,
      tokenEstimate: Math.ceil(prompt.length / 4),
    };
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

  // ── GET /api/tenants/:tenantId/me ─────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/me', async (request, reply) => {
    const { tenantId } = request.params;
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const user = await prisma.user.findFirst({
      where: { tenantId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!user) return reply.code(404).send({ error: 'Not found' });
    return user;
  });
}

// Export the prompt builder so llm.js can use the same logic
export { buildPromptFromSettings };

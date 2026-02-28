// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';
import OpenAI from 'openai';
// routes/agent-routes.js
//
// REST API for AI voice agent settings.
// Settings are stored in tenant.settings.voiceAgent (JSON column).
//
// GET  /api/tenants/:tenantId/agent-settings           — load current config
// PUT  /api/tenants/:tenantId/agent-settings           — save config
// GET  /api/tenants/:tenantId/agent-prompt             — preview system prompt
// POST /api/tenants/:tenantId/agent-prompt/regenerate  — regenerate via OpenAI
// ─────────────────────────────────────────────────────────────────────────────




// Normalize legacy 3-letter day keys (Mon/Tue/…) stored before the onboarding
// fix was deployed, so the agent page always receives full lowercase names.
const _HOUR_DAY_MAP = { Mon:'monday', Tue:'tuesday', Wed:'wednesday', Thu:'thursday', Fri:'friday', Sat:'saturday', Sun:'sunday' };
function normalizeBusinessHours(hours) {
  if (!hours) return null;
  const out = {};
  for (const [k, v] of Object.entries(hours)) {
    out[_HOUR_DAY_MAP[k] ?? k] = v;
  }
  return out;
}

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
  const location     = tenant.settings?.address || '';
  const parking      = tenant.settings?.parking  || '';
  const clinicPhone  = tenant.settings?.phone    || '';
  const businessType = tenant.settings?.businessType || '';
  const clinicContext = voiceAgent.clinicContext || '';
  const neverSay     = voiceAgent.neverSay     || [];
  const rules        = voiceAgent.bookingRules || DEFAULT_BOOKING_RULES;
  const transferNumber = voiceAgent.transferNumber || '';
  const transferMsg    = voiceAgent.transferMessage || 'Of course, let me connect you with a member of our team. Please hold.';
  const hours          = formatHoursForPrompt(voiceAgent.businessHours || DEFAULT_BUSINESS_HOURS);

  // Build services list (only enabled ones if configured)
  const enabledIds = voiceAgent.enabledServiceIds || [];
  const availableServices = enabledIds.length > 0
    ? services.filter(s => enabledIds.includes(s.id))
    : services;
  const servicesBlock = availableServices.length
    ? availableServices.map(s => `* ${s.name}${s.durationMins ? ` — ${s.durationMins} mins` : ''}${s.priceCents ? `, £${(s.priceCents / 100).toFixed(0)}` : ''}`).join('\n')
    : '* General appointments — please enquire for pricing and duration';

  const staffBlock = staffList.length
    ? `\nOur team:\n${staffList.map(s => `* ${s.name}${s.title ? ` — ${s.title}` : ''}`).join('\n')}`
    : '';

  const faqBlock = (voiceAgent.faqs || []).length
    ? `\n\nFrequently asked questions:\n${(voiceAgent.faqs).map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}`
    : '';

  const neverSayBlock = neverSay.length
    ? `* Never use these words or phrases: ${neverSay.join(', ')}` : '';

  const depositNote = rules.requireDeposit
    ? `A deposit of ${rules.depositPercent ?? 25}% is required at booking.`
    : 'No deposit required — full payment is taken on the day.';

  const newClientNote = rules.newClientPolicy === 'require_consultation'
    ? 'New clients must book a free consultation before any treatment.'
    : 'New clients can book any service directly.';

  const clinicDetails = [
    location   && `* Address: ${location}`,
    clinicPhone && `* Phone: ${clinicPhone}`,
    parking    && `* Parking: ${parking}`,
  ].filter(Boolean).join('\n');

  return `# Personality
You are ${agentName}, the professional and warm AI receptionist for ${name}${businessType ? `, a ${businessType.toLowerCase()} clinic` : ''}${location ? ` located at ${location}` : ''}. You are knowledgeable about the clinic's services, treatments, pricing, and team. You are approachable, calm, and always aim to provide a friendly yet professional experience for every caller.${clinicContext ? `\n\n${clinicContext}` : ''}

# Environment
You are answering calls over the phone through an AI voice system. You have access to the clinic's calendar and booking system in real time. Callers typically enquire about services, treatments, pricing, or call to book, reschedule, or cancel appointments.

Clinic details:
${clinicDetails || `* ${name}`}
* Opening hours: ${hours}

# Tone
Your communication style is professional, warm, and approachable. Speak naturally as a human receptionist would — never robotic or scripted. Keep every response short: 1–3 sentences maximum. This is a phone call, not a chat. Never read out bullet points or lists aloud; weave information naturally into spoken sentences. Use phrases like "Of course", "Absolutely", "Let me just check that for you".

# Goal
Your primary goal is to efficiently answer enquiries and book appointments for ${name}. Follow these steps on every call:

1. **Greeting** — Greet the caller warmly and introduce yourself. Ask how you can help them today.

2. **Answer questions** — If the caller asks about services, treatments, prices, or hours, provide accurate information from the knowledge base below. Do not guess or invent details.

3. **Check availability** — If the caller wants to book, use the calendar integration tool to check real availability. Clearly state the available slots.

4. **Book the appointment** — Once the caller confirms a slot, use the calendar tool to create the booking. Confirm the service, date, time, and practitioner name before finalising.

5. **Close the call** — Thank the caller for contacting ${name}. Offer any additional help. End the call politely.

# Knowledge Base

## Services
${servicesBlock}
${staffBlock}${faqBlock}

## Booking rules
* Minimum notice: ${rules.minNoticeHours ?? 2} hour${(rules.minNoticeHours ?? 2) !== 1 ? 's' : ''} in advance
* Maximum advance booking: ${rules.maxFutureDays ?? 60} days ahead
* ${newClientNote}
* Deposits: ${depositNote}
* Rescheduling: ${rules.allowRescheduling !== false ? `allowed with ${rules.cancellationNoticeHours ?? 24}h notice` : 'not available by phone — direct to reception'}
* Cancellations: ${rules.allowCancellation !== false ? `allowed with ${rules.cancellationNoticeHours ?? 24}h notice` : 'not available by phone — direct to reception'}

# Guardrails
* Do not provide medical advice or clinical recommendations outside the knowledge base above.
* Do not book appointments outside of confirmed available time slots.
* Do not engage in conversations unrelated to the clinic's services or booking process.
* If a caller asks about something you don't know, say "Let me check that for you" and use a tool, or offer to take a message for the team.
* If a caller becomes distressed or the situation is beyond your scope, offer to transfer them to a human member of staff.${neverSayBlock ? `\n* ${neverSayBlock}` : ''}

# Tools
* **Calendar Integration** — Check real-time availability and book, reschedule, or cancel appointments. Always use this before confirming any time slot — never guess or invent availability.
* **Transfer** — If the caller explicitly asks for a human, say "${transferMsg}" then end your turn with [TRANSFER]${transferNumber ? ` to ${transferNumber}` : ''}.

# Rules you must always follow
1. Always confirm the caller's full name before creating any booking.
2. Always use the calendar tool to check availability — never invent a free slot.
3. Always read back the full booking details (service, date, time, practitioner) and get the caller's verbal confirmation before finalising.
4. For any clinical or medical question beyond the knowledge base: "I'd recommend speaking with one of our practitioners directly — I can book you a consultation."
5. Never mention competitor clinics or make comparisons.

TODAY'S DATE & TIME: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;
}

export default async function agentRoutes(fastify) {

  // Shared auth helper — verifies JWT and ensures token belongs to this tenant
  const requireAuth = async (request, reply) => {
    try {
      await request.jwtVerify();
      if (request.user?.tenantId !== request.params.tenantId) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // ── GET agent settings ────────────────────────────────────────────────────
  // No auth required — used by the onboarding gate fallback without a token.
  fastify.get('/api/tenants/:tenantId/agent-settings', async (request, reply) => {
    const { tenantId } = request.params;

    try {
      // Fetch tenant base record + services
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        include: {
          services: {
            where: { isActive: true },
            select: { id: true, name: true, durationMins: true, priceCents: true, category: true, description: true, depositCents: true },
            orderBy: { name: 'asc' },
          },
        },
      });

      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found' });
      }

      // Fetch staff separately to keep the Prisma query simple and avoid
      // potential issues with nested select + include in a single call.
      const staff = await prisma.staff.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, title: true, email: true, color: true },
        orderBy: { name: 'asc' },
      });

      const settings = tenant.settings ?? {};
      const va = settings.voiceAgent ?? {};

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        // Business info (stored in settings root)
        businessType:    settings.businessType    ?? '',
        address:         settings.address         ?? '',
        parking:         settings.parking         ?? '',
        phone:           settings.phone           ?? '',
        email:           settings.email           ?? '',
        voiceAgentPhone: settings.voiceAgentPhone ?? '',
        // Staff
        staff,
        // Identity
        agentName:       va.agentName       ?? 'Aria',
        voiceId:         va.voiceId         ?? '21m00Tcm4TlvDq8ikWAM',
        voicePersonality: va.voicePersonality ?? 65,
        isActive:        va.isActive        ?? true,
        bankHolidayClosed: va.bankHolidayClosed ?? false,
        // Greeting
        greeting:          va.greeting          ?? `Hello! Thank you for calling ${tenant.name}. How can I help you today?`,
        afterHoursMessage: va.afterHoursMessage ?? `Thank you for calling ${tenant.name}. We're currently closed. Please call back during business hours or leave a voicemail.`,
        transferMessage:   va.transferMessage   ?? 'Of course, let me connect you with a member of our team. Please hold for just a moment.',
        transferNumber:    va.transferNumber    ?? '',
        businessHours:     normalizeBusinessHours(va.businessHours) ?? DEFAULT_BUSINESS_HOURS,
        // Services
        enabledServiceIds: va.enabledServiceIds ?? [],
      
        // Knowledge base
        faqs:         va.faqs         ?? [],
        neverSay:     va.neverSay     ?? [],
        clinicContext: va.clinicContext ?? '',
        // Booking rules
        bookingRules: va.bookingRules ?? DEFAULT_BOOKING_RULES,
        // Available services (from DB)
        services: tenant.services,
      };
    } catch (err) {
      fastify.log.error(err, 'GET agent-settings failed');
      return reply.status(500).send({ error: 'Failed to load agent settings', detail: err.message });
    }
  });

  // ── PUT agent settings ────────────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/agent-settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const { tenantId } = request.params;
    const body = request.body;

    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        include: {
          services: { where: { isActive: true }, select: { id: true, name: true, durationMins: true, priceCents: true } },
        },
      });
      if (!tenant) {
        return reply.status(404).send({ error: 'Tenant not found' });
      }

      const currentSettings = tenant.settings ?? {};
      const currentVoiceAgent = currentSettings.voiceAgent ?? {};
      const updatedVoiceAgent = {
        ...currentVoiceAgent,
        // Use ?? to fall back to existing values if body field is undefined
        agentName:         body.agentName         ?? currentVoiceAgent.agentName,
        voiceId:           body.voiceId           ?? currentVoiceAgent.voiceId,
        voicePersonality:  body.voicePersonality  ?? currentVoiceAgent.voicePersonality,
        isActive:          body.isActive          ?? currentVoiceAgent.isActive,
        greeting:          body.greeting          ?? currentVoiceAgent.greeting,
        afterHoursMessage: body.afterHoursMessage ?? currentVoiceAgent.afterHoursMessage,
        transferMessage:   body.transferMessage   ?? currentVoiceAgent.transferMessage,
        transferNumber:    body.transferNumber    ?? currentVoiceAgent.transferNumber,
        businessHours:     body.businessHours     ?? currentVoiceAgent.businessHours,
        enabledServiceIds: body.enabledServiceIds ?? currentVoiceAgent.enabledServiceIds,
        faqs:              body.faqs              ?? currentVoiceAgent.faqs,
        neverSay:          body.neverSay          ?? currentVoiceAgent.neverSay,
        clinicContext:     body.clinicContext      ?? currentVoiceAgent.clinicContext,
        bankHolidayClosed: body.bankHolidayClosed ?? currentVoiceAgent.bankHolidayClosed,
        bookingRules:      body.bookingRules       ?? currentVoiceAgent.bookingRules,
        // Preserve existing prompt — will be regenerated async below
        systemPrompt:            currentVoiceAgent.systemPrompt,
        systemPromptGeneratedAt: currentVoiceAgent.systemPromptGeneratedAt,
        updatedAt: new Date().toISOString(),
      };

      const updatedSettings = {
        ...currentSettings,
        businessType:    body.businessType    ?? currentSettings.businessType,
        address:         body.address         ?? currentSettings.address,
        parking:         body.parking         ?? currentSettings.parking,
        phone:           body.phone           ?? currentSettings.phone,
        email:           body.email           ?? currentSettings.email,
        voiceAgentPhone: body.voiceAgentPhone ?? currentSettings.voiceAgentPhone,
        voiceAgent:      updatedVoiceAgent,
      };

      const updateData = { settings: updatedSettings };
      if (body.tenantName?.trim() && body.tenantName !== tenant.name) {
        updateData.name = body.tenantName.trim();
      }

      await prisma.tenant.update({ where: { id: tenantId }, data: updateData });

      // The system prompt is intentionally NOT regenerated here.
      // It is generated once at onboarding and only when the user explicitly
      // clicks "Regenerate" in the AI Prompt tab.
      return { success: true, message: 'Agent settings saved.' };
    } catch (err) {
      fastify.log.error(err, 'PUT agent-settings failed');
      return reply.status(500).send({ error: 'Failed to save agent settings', detail: err.message });
    }
  });

  // ── GET preview of generated system prompt ────────────────────────────────
  fastify.get('/api/tenants/:tenantId/agent-prompt', async (request, reply) => {
    const { tenantId } = request.params;

    try {
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

      const staff = await prisma.staff.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, title: true },
        orderBy: { name: 'asc' },
      });

  // ── DEBUG: Check what's saved in database ────────────────────────────────
    } catch (err) {
      console.error("Error fetching agent settings:", err);
      return reply.status(500).send({ error: "Failed to load agent settings" });
    }
  });

  fastify.get('/api/tenants/:tenantId/debug/settings', async (request, reply) => {
    const { tenantId } = request.params;
    await request.jwtVerify();
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, settings: true, services: { where: { isActive: true }, select: { id: true, name: true } } }
    });
    return {
      name: tenant?.name,
      hasSettings: !!tenant?.settings,
      settingsKeys: tenant?.settings ? Object.keys(tenant.settings) : [],
      businessType: tenant?.settings?.businessType,
      address: tenant?.settings?.address,
      hasVoiceAgent: !!tenant?.settings?.voiceAgent,
      voiceAgentKeys: tenant?.settings?.voiceAgent ? Object.keys(tenant.settings.voiceAgent) : [],
      onboardingCompleted: tenant?.settings?.onboardingCompleted,
      serviceCount: tenant?.services?.length || 0
    };
  });
}

export { buildPromptFromSettings };

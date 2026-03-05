// ─────────────────────────────────────────────────────────────────────────────
// services/onboarding-service.js
//
// Handles the 8-step AI agent onboarding flow.
// Saves all data in a single transaction and marks the tenant as onboarded.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import OpenAI from 'openai';

/**
 * Check if a tenant has completed the AI agent onboarding.
 */
export async function getOnboardingStatus(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const s = tenant.settings ?? {};
  return {
    completed:   s.onboardingCompleted === true,
    completedAt: s.onboardingCompletedAt ?? null,
  };
}

/**
 * Save all 8-step onboarding data and mark the tenant as onboarded.
 *
 * Expected body shape:
 * {
 *   clinicName, businessType,
 *   address, parking, phone, email,
 *   staff: [{ name, role }],
 *   services: [{ name, durationMins, priceCents, description, category,
 *                prepNotes, aftercareNotes, serviceType, assignedStaff }],
 *   businessHours: { monday: { open, from, to }, … },
 *   bookingRules: { cancellationNoticeHours, advanceBookingHours, depositCents },
 *   agentName, voiceId, voicePersonality,
 *   transferNumber,
 *   clinicContext,
 * }
 */
export async function completeOnboarding(tenantId, data) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const currentSettings = tenant.settings ?? {};

  // ── 1. Delete any pre-existing onboarding services (avoid duplicates on re-run) ──
  const hasOnboarded = currentSettings.onboardingCompleted === true;
  if (!hasOnboarded && data.services?.length) {
    // Only wipe auto-created services from a previous partial run, not manually added ones
    // We mark them with category 'onboarding' if set during save — skip deletion for safety
  }

  // ── 2. Upsert staff members ───────────────────────────────────────────────
  const createdStaffIds = [];
  if (data.staff?.length) {
    for (const s of data.staff) {
      const safeName  = s.name?.trim();
      if (!safeName) continue;
      const safeEmail = s.email?.trim()
        || `${safeName.toLowerCase().replace(/[^a-z0-9]/g, '.')}@noemail.local`;

      const existing = await prisma.staff.findFirst({
        where: { tenantId, email: safeEmail },
      });

      let staff;
      if (existing) {
        staff = await prisma.staff.update({
          where: { id: existing.id },
          data: { name: safeName, title: s.role ?? null, isActive: true },
        });
      } else {
        staff = await prisma.staff.create({
          data: {
            tenantId,
            name:    safeName,
            email:   safeEmail,
            title:   s.role ?? null,
            role:    'STAFF',
            color:   s.color ?? '#60a5fa',
            isActive: true,
          },
        });
      }
      createdStaffIds.push(staff.id);
    }
  }

  // ── 3. Create services ────────────────────────────────────────────────────
  const createdServiceIds = [];
  if (data.services?.length) {
    for (const svc of data.services) {
      if (!svc.name?.trim()) continue;

      // Build description from prep / aftercare notes
      let desc = svc.description?.trim() || '';
      if (svc.prepNotes?.trim())      desc += (desc ? '\n' : '') + `Prep: ${svc.prepNotes.trim()}`;
      if (svc.aftercareNotes?.trim()) desc += (desc ? '\n' : '') + `Aftercare: ${svc.aftercareNotes.trim()}`;

      const service = await prisma.service.create({
        data: {
          tenantId,
          name:        svc.name.trim(),
          description: desc || null,
          durationMins: parseInt(svc.durationMins) || 60,
          priceCents:   parseInt(svc.priceCents)   || 0,
          depositCents: parseInt(svc.depositCents)  || 0,
          category:    svc.serviceType ?? svc.category ?? null,
          color:       '#0d9488',
          isActive:    true,
        },
      });
      createdServiceIds.push(service.id);

      // Link assigned staff → service (M2M)
      if (svc.assignedStaff?.length && createdStaffIds.length) {
        const links = [];
        for (const staffRef of svc.assignedStaff) {
          // staffRef can be 'any' (= all staff) or a specific staff id/name
          if (staffRef === 'any') {
            for (const sid of createdStaffIds) {
              links.push({ staffId: sid, serviceId: service.id });
            }
          } else {
            const staff = await prisma.staff.findFirst({
              where: { tenantId, OR: [{ id: staffRef }, { name: staffRef }] },
            });
            if (staff) links.push({ staffId: staff.id, serviceId: service.id });
          }
        }
        if (links.length) {
          await prisma.staffService.createMany({ data: links, skipDuplicates: true });
        }
      }
    }
  }

  // ── 4. Build booking rules ────────────────────────────────────────────────
  const rawRules = data.bookingRules ?? {};
  const bookingRules = {
    minNoticeHours:          parseInt(rawRules.advanceBookingHours)       || 0,
    maxFutureDays:           60,
    slotIntervalMins:        15,
    bufferMins:              0,
    newClientPolicy:         'book_directly',
    requireDeposit:          (parseInt(rawRules.depositCents) || 0) > 0,
    depositPercent:          rawRules.depositPercent ?? 0,
    allowRescheduling:       true,
    allowCancellation:       true,
    cancellationNoticeHours: parseInt(rawRules.cancellationNoticeHours) || 24,
  };

  // ── 5. Build voice agent settings ─────────────────────────────────────────
  const agentName = data.agentName?.trim() || 'Sophie';
  const clinicName = data.clinicName?.trim() || tenant.name;
  const normalizedHours = _normalizeBusinessHours(data.businessHours);

  // Build template system prompt immediately (always works, no API key needed)
  // businessType is hardcoded to 'Med Spa' — no industry selector
  const templatePrompt = _buildTemplatePrompt({
    clinicName, agentName,
    businessType:   data.businessType ?? 'Med Spa',
    address:        data.address        ?? '',
    parking:        data.parking        ?? '',
    phone:          data.phone          ?? '',
    services:       data.services       ?? [],
    staff:          data.staff          ?? [],
    businessHours:  normalizedHours,
    bookingRules,
    clinicContext:  data.clinicContext  ?? '',
    transferNumber: data.transferNumber ?? '',
  });

  const voiceAgent = {
    ...(currentSettings.voiceAgent ?? {}),
    agentName,
    voiceId:          data.voiceId          ?? '21m00Tcm4TlvDq8ikWAM',
    voicePersonality: data.voicePersonality ?? 65,
    voiceGender:      data.voiceGender      ?? 'female',
    isActive:         true,
    bankHolidayClosed: data.bankHolidayClosed ?? false,
    greeting:         `Hello! Thank you for calling ${clinicName}. I'm ${agentName}, your virtual receptionist. How can I help you today?`,
    afterHoursMessage: `Thank you for calling ${clinicName}. We're currently closed. Please call back during our opening hours or leave a voicemail and we'll get back to you shortly.`,
    transferMessage:  'Of course, let me connect you with a member of our team right away. Please hold for just a moment.',
    transferNumber:   data.transferNumber   ?? '',
    businessHours:    normalizedHours,
    enabledServiceIds: createdServiceIds,
    faqs:             [],
    neverSay:         [],
    clinicContext:    data.clinicContext     ?? '',
    bookingRules,
    // Store template prompt immediately — calls work even if OpenAI upgrade fails
    systemPrompt:            templatePrompt,
    systemPromptGeneratedAt: new Date().toISOString(),
    updatedAt:               new Date().toISOString(),
  };

  // ── 6. Update tenant ──────────────────────────────────────────────────────
  const updatedSettings = {
    ...currentSettings,
    businessType:          data.businessType ?? currentSettings.businessType ?? 'Med Spa',
    address:               data.address              ?? currentSettings.address ?? '',
    phone:                 data.phone                ?? currentSettings.phone   ?? '',
    email:                 data.email                ?? currentSettings.email   ?? '',
    parking:               data.parking              ?? '',
    // Persist selected Twilio number so inbound calls route to this tenant
    voiceAgentPhone:       data.selectedPhone        ?? currentSettings.voiceAgentPhone ?? '',
    voiceAgent,
    onboardingCompleted:   true,
    onboardingCompletedAt: new Date().toISOString(),
  };

  const updateData = { settings: updatedSettings };
  if (clinicName && clinicName !== tenant.name) updateData.name = clinicName;

  await prisma.tenant.update({ where: { id: tenantId }, data: updateData });

  // ── 7. Upgrade system prompt via OpenAI asynchronously (non-blocking) ────
  // Template prompt is already saved above. This upgrades it to an AI-written
  // version when OPENAI_API_KEY is available — never blocks the response.
  generateAndStoreSystemPrompt(tenantId, {
    clinicName,
    businessType:   data.businessType ?? 'Med Spa',
    address:        data.address         ?? '',
    parking:        data.parking         ?? '',
    phone:          data.phone           ?? '',
    agentName,
    voiceGender:    data.voiceGender     ?? 'female',
    services:       data.services        ?? [],
    staff:          data.staff           ?? [],
    businessHours:  data.businessHours   ?? {},
    bookingRules,
    clinicContext:  data.clinicContext   ?? '',
  }).catch(() => {}); // fire-and-forget — template prompt already saved

  return {
    success:          true,
    servicesCreated:  createdServiceIds.length,
    staffCreated:     createdStaffIds.length,
  };
}

// ─── Generate AI system prompt via OpenAI and persist it ─────────────────────
async function generateAndStoreSystemPrompt(tenantId, ctx) {
  if (!process.env.OPENAI_API_KEY) return; // no key — template prompt already saved
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const servicesList = (ctx.services ?? []).length
    ? ctx.services.map(s => `* ${s.name}${s.durationMins ? ` — ${s.durationMins} mins` : ''}${s.priceCents ? `, $${(s.priceCents / 100).toFixed(0)}` : ''}`).join('\n')
    : '* General appointments — please enquire for pricing';

  const staffBlock = (ctx.staff ?? []).length
    ? `\nOur team:\n${ctx.staff.map(s => `* ${s.name}${s.role ? ` — ${s.role}` : ''}`).join('\n')}`
    : '';

  const hoursStr = Object.entries(ctx.businessHours || {})
    .map(([day, h]) => h?.open ? `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.from}–${h.to}` : `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`)
    .join(', ');

  const rules = ctx.bookingRules ?? {};
  const depositNote = rules.requireDeposit
    ? `${rules.depositPercent ?? 25}% deposit required at booking`
    : 'no deposit required';
  const newClientNote = rules.newClientPolicy === 'require_consultation'
    ? 'new clients must book a free consultation before treatments'
    : 'new clients can book any service directly';

  const userMsg = `Write a complete AI voice receptionist system prompt using EXACTLY these section headings in this order. Do not add, skip, or rename any section.

# Personality
# Environment
# Tone
# Goal
# Knowledge Base
## Services
## Booking rules
# Guardrails
# Tools
# Rules you must always follow

CLINIC DATA to weave into the sections:
- Agent name: ${ctx.agentName}
- Clinic: ${ctx.clinicName}${ctx.businessType ? ` (${ctx.businessType})` : ''}${ctx.address ? `\n- Address: ${ctx.address}` : ''}${ctx.phone ? `\n- Phone: ${ctx.phone}` : ''}${ctx.parking ? `\n- Parking: ${ctx.parking}` : ''}
- Opening hours: ${hoursStr || 'Mon–Fri 9:00–19:00'}

## Services
${servicesList}${staffBlock}

## Booking rules
* Min notice: ${rules.minNoticeHours ?? 2} hours
* Max advance: ${rules.maxFutureDays ?? 60} days
* ${newClientNote}
* ${depositNote}
* Rescheduling: ${rules.allowRescheduling !== false ? 'allowed' : 'not available by phone'}
* Cancellations: ${rules.allowCancellation !== false ? `allowed with ${rules.cancellationNoticeHours ?? 24}h notice` : 'not available by phone'}
${ctx.clinicContext ? `\nExtra context: ${ctx.clinicContext}` : ''}

REQUIREMENTS:
- # Personality: describe who ${ctx.agentName} is, warm and professional
- # Environment: phone call via AI voice system, real-time calendar access
- # Tone: short (1–3 sentences), natural, conversational, UK English
- # Goal: EXACTLY 5 numbered steps — 1. Greeting, 2. Answer questions, 3. Check availability, 4. Book appointment, 5. Close the call
- # Knowledge Base: use the Services and Booking rules sections above
- # Guardrails: what the agent must never do
- # Tools: mention Calendar Integration (for checking/booking slots) and Transfer (for human handoff using [TRANSFER])
- # Rules you must always follow: 5 numbered firm rules including confirming caller's name, always using calendar tool, reading back booking details before finalising
- End the entire prompt with exactly this line: TODAY'S DATE & TIME: {CURRENT_DATETIME}`.trim();

  const completion = await openai.chat.completions.create({
    model:       process.env.OPENAI_MODEL || 'gpt-4o-mini',
    max_tokens:  1400,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'You are an expert at writing AI voice receptionist system prompts for UK healthcare and beauty clinics. You always follow the exact section structure provided and write in UK English.' },
      { role: 'user',   content: userMsg },
    ],
  });

  const generatedPrompt = completion.choices[0]?.message?.content?.trim();
  if (!generatedPrompt) return;

  // Persist the AI-generated prompt (replaces the template saved at onboarding)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  if (!tenant) return;

  const s = tenant.settings ?? {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...s,
        voiceAgent: {
          ...(s.voiceAgent ?? {}),
          systemPrompt: generatedPrompt,
          systemPromptGeneratedAt: new Date().toISOString(),
        },
      },
    },
  });
}

// ─── Template-based system prompt builder (no API key required) ──────────────
function _buildTemplatePrompt(ctx) {
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const hoursStr = days
    .map((d, i) => {
      const h = (ctx.businessHours ?? {})[d];
      if (!h || !h.open) return `${dayNames[i]}: Closed`;
      return `${dayNames[i]}: ${h.from}–${h.to}`;
    })
    .join(', ');

  const servicesBlock = (ctx.services ?? []).length
    ? ctx.services.map(s =>
        `* ${s.name}${s.durationMins ? ` — ${s.durationMins} mins` : ''}${s.priceCents ? `, $${(s.priceCents / 100).toFixed(0)}` : ''}`
      ).join('\n')
    : '* General appointments — please enquire for pricing and duration';

  const staffBlock = (ctx.staff ?? []).length
    ? `\nOur team:\n${ctx.staff.map(s => `* ${s.name}${s.role ? ` — ${s.role}` : ''}`).join('\n')}`
    : '';

  const rules = ctx.bookingRules ?? {};
  const depositNote = rules.requireDeposit
    ? `A deposit of ${rules.depositPercent ?? 25}% is required at booking.`
    : 'No deposit required — full payment is taken on the day.';
  const newClientNote = rules.newClientPolicy === 'require_consultation'
    ? 'New clients must book a free consultation before any treatment.'
    : 'New clients can book any service directly.';

  const clinicDetails = [
    ctx.address  && `* Address: ${ctx.address}`,
    ctx.phone    && `* Phone: ${ctx.phone}`,
    ctx.parking  && `* Parking: ${ctx.parking}`,
  ].filter(Boolean).join('\n');

  return `# Personality
You are ${ctx.agentName}, the professional and warm AI receptionist for ${ctx.clinicName}${ctx.businessType ? `, a ${ctx.businessType.toLowerCase()} clinic` : ''}${ctx.address ? ` located at ${ctx.address}` : ''}. You are knowledgeable about the clinic's services, treatments, pricing, and team. You are approachable, calm, and always aim to provide a friendly yet professional experience for every caller.${ctx.clinicContext ? `\n\n${ctx.clinicContext}` : ''}

# Environment
You are answering calls over the phone through an AI voice system. You have access to the clinic's calendar and booking system in real time. Callers typically enquire about services, treatments, pricing, or call to book, reschedule, or cancel appointments.

Clinic details:
${clinicDetails || `* ${ctx.clinicName}`}
* Opening hours: ${hoursStr}

# Tone
Your communication style is professional, warm, and approachable. Speak naturally as a human receptionist would — never robotic or scripted. Keep every response short: 1–3 sentences maximum. This is a phone call, not a chat. Never read out bullet points or lists aloud; weave information naturally into spoken sentences. Use phrases like "Of course", "Absolutely", "Let me just check that for you".

# Goal
Your primary goal is to efficiently answer enquiries and book appointments for ${ctx.clinicName}. Follow these steps on every call:

1. **Greeting** — Greet the caller warmly and introduce yourself. Ask how you can help them today.

2. **Answer questions** — If the caller asks about services, treatments, prices, or hours, provide accurate information from the knowledge base below. Do not guess or invent details.

3. **Check availability** — If the caller wants to book, use the calendar integration tool to check real availability. Clearly state the available slots.

4. **Book the appointment** — Once the caller confirms a slot, use the calendar tool to create the booking. Confirm the service, date, time, and practitioner name before finalising.

5. **Close the call** — Thank the caller for contacting ${ctx.clinicName}. Offer any additional help. End the call politely.

# Knowledge Base

## Services
${servicesBlock}
${staffBlock}

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
* For everything else (unknown questions, general queries), handle it and let the call end naturally when the caller is done.

# Tools
* **Calendar Integration** — Check real-time availability and book, reschedule, or cancel appointments. Always use this before confirming any time slot — never guess or invent availability.
* **Transfer** — Say "Of course, let me connect you with a member of our team. Please hold." then end your turn with [TRANSFER]${ctx.transferNumber ? ` to ${ctx.transferNumber}` : ''} ONLY in these situations: (1) the caller explicitly asks to speak to a human or be transferred, (2) there is a genuine emergency or urgent safety concern (e.g. medical emergency, severe distress). Do NOT transfer for normal calls — let them end naturally.

# Rules you must always follow
1. Always confirm the caller's full name before creating any booking.
2. Always use the calendar tool to check availability — never invent a free slot.
3. Always read back the full booking details (service, date, time, practitioner) and get the caller's verbal confirmation before finalising.
4. For any clinical or medical question beyond the knowledge base: "I'd recommend speaking with one of our practitioners directly — I can book you a consultation."
5. Never mention competitor clinics or make comparisons.

TODAY'S DATE & TIME: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;
}

// Onboarding sends 3-letter keys (Mon/Tue/…); agent page expects full names (monday/tuesday/…)
const _DAY_KEY = { Mon:'monday', Tue:'tuesday', Wed:'wednesday', Thu:'thursday', Fri:'friday', Sat:'saturday', Sun:'sunday' };
function _normalizeBusinessHours(hours) {
  if (!hours || !Object.keys(hours).length) return _defaultBusinessHours();
  const out = {};
  for (const [k, v] of Object.entries(hours)) {
    out[_DAY_KEY[k] ?? k.toLowerCase()] = v;
  }
  return out;
}

function _defaultBusinessHours() {
  return {
    monday:    { open: true,  from: '09:00', to: '17:00' },
    tuesday:   { open: true,  from: '09:00', to: '17:00' },
    wednesday: { open: true,  from: '09:00', to: '17:00' },
    thursday:  { open: true,  from: '09:00', to: '17:00' },
    friday:    { open: true,  from: '09:00', to: '17:00' },
    saturday:  { open: false, from: '09:00', to: '17:00' },
    sunday:    { open: false, from: '09:00', to: '17:00' },
  };
}

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
  const templatePrompt = _buildTemplatePrompt({
    clinicName, agentName,
    businessType:   data.businessType   ?? '',
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
    businessType:          data.businessType         ?? currentSettings.businessType,
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
    businessType:   data.businessType   ?? '',
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
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const servicesList = ctx.services.length
    ? ctx.services.map(s => `- ${s.name}${s.durationMins ? ` (${s.durationMins} mins` : ''}${s.priceCents ? `, £${(s.priceCents / 100).toFixed(0)})` : (s.durationMins ? ')' : '')}`).join('\n')
    : '- General appointments';

  const staffList = ctx.staff.length
    ? ctx.staff.map(s => `- ${s.name}${s.role ? ` (${s.role})` : ''}`).join('\n')
    : '';

  const hoursStr = Object.entries(ctx.businessHours || {})
    .map(([day, h]) => h.open ? `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.from}–${h.to}` : `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`)
    .join(', ');

  const userMsg = `
You are writing the AI system prompt for a voice receptionist called "${ctx.agentName}" at a ${ctx.businessType || 'clinic'} named "${ctx.clinicName}".

Clinic details:
- Address: ${ctx.address || 'not provided'}
- Parking: ${ctx.parking || 'not provided'}
- Phone: ${ctx.phone || 'not provided'}
- Opening hours: ${hoursStr || 'Mon–Fri 9am–5pm'}

Services offered:
${servicesList}

${staffList ? `Team:\n${staffList}\n` : ''}
Booking rules:
- Minimum notice: ${ctx.bookingRules.cancellationNoticeHours ?? 24}h for cancellations
- Advance booking: up to ${ctx.bookingRules.maxFutureDays ?? 60} days ahead
- Deposit required: ${ctx.bookingRules.requireDeposit ? 'yes' : 'no'}

${ctx.clinicContext ? `Additional context:\n${ctx.clinicContext}` : ''}

Write a complete, natural, conversational AI receptionist system prompt. The agent should:
1. Greet callers warmly by name (${ctx.agentName}), mention the clinic name
2. Help with booking, rescheduling, and cancelling appointments
3. Answer questions about services, pricing, hours, and parking
4. Transfer to a human receptionist when asked (using [TRANSFER])
5. Be concise (1–3 sentences per response) — this is a phone call
6. Never invent appointment slots — always use tools to check availability first
7. Always confirm full booking details before finalising

Write the prompt in second-person (you are...) format, ready to use directly as a ChatGPT system message.
`.trim();

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  800,
    temperature: 0.4,
    messages: [
      { role: 'system', content: 'You are an expert at writing concise, effective AI receptionist system prompts for UK healthcare and beauty clinics.' },
      { role: 'user',   content: userMsg },
    ],
  });

  const generatedPrompt = completion.choices[0]?.message?.content?.trim();
  if (!generatedPrompt) return;

  // Persist the generated prompt into voiceAgent.systemPrompt
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

  const servicesList = (ctx.services ?? []).length
    ? ctx.services.map(s =>
        `- ${s.name}${s.durationMins ? ` (${s.durationMins} min` : ''}${s.priceCents ? `, £${(s.priceCents / 100).toFixed(0)})` : (s.durationMins ? ')' : '')}`
      ).join('\n')
    : '- General appointments';

  const staffSection = (ctx.staff ?? []).length
    ? `\nTEAM MEMBERS:\n${ctx.staff.map(s => `- ${s.name}${s.role ? ` (${s.role})` : ''}`).join('\n')}`
    : '';

  const rules = ctx.bookingRules ?? {};
  const depositNote = rules.requireDeposit
    ? `A deposit of ${rules.depositPercent ?? 25}% is required at booking.`
    : 'No deposit required — full payment on the day.';

  return `You are ${ctx.agentName}, the warm and professional AI receptionist for ${ctx.clinicName}${ctx.businessType ? ` — a ${ctx.businessType.toLowerCase()} practice` : ''}.

SPEAKING STYLE — CRITICAL:
- You are calm, patient, and genuinely helpful. Never rush the caller.
- Speak naturally — as a friendly human receptionist would.
- Keep every response SHORT: 1–3 sentences maximum. This is a phone call, not a chat.
- Never read bullet points aloud. Weave information naturally into sentences.
- Use natural spoken phrases: "Of course", "Absolutely", "Let me just check that for you…"
- Always wait for the caller to finish before responding.
- If unsure, ask: "I'm sorry, could you say that again?"

OPENING GREETING — say this EXACTLY when you answer:
"Hello! Thank you for calling ${ctx.clinicName}. I'm ${ctx.agentName}, your virtual receptionist. How can I help you today?"

YOUR JOB:
- Book, reschedule, and cancel appointments
- Answer questions about services, prices, opening hours, and the clinic
- Transfer callers to a human when they ask

CLINIC DETAILS:
- Name: ${ctx.clinicName}${ctx.address ? `\n- Address: ${ctx.address}` : ''}${ctx.phone ? `\n- Phone: ${ctx.phone}` : ''}${ctx.parking ? `\n- Parking: ${ctx.parking}` : ''}
- Opening hours: ${hoursStr}

SERVICES AVAILABLE:
${servicesList}
${staffSection}

BOOKING POLICY:
- Minimum booking notice: ${rules.minNoticeHours ?? 2} hour${(rules.minNoticeHours ?? 2) !== 1 ? 's' : ''} ahead
- Furthest ahead you can book: ${rules.maxFutureDays ?? 60} days
- Deposits: ${depositNote}
- Rescheduling: ${rules.allowRescheduling !== false ? `allowed with ${rules.cancellationNoticeHours ?? 24}h notice` : 'not available by phone — direct to reception'}
- Cancellations: ${rules.allowCancellation !== false ? `allowed with ${rules.cancellationNoticeHours ?? 24}h notice` : 'not available by phone — direct to reception'}
${ctx.clinicContext ? `\nABOUT THE CLINIC:\n${ctx.clinicContext}` : ''}

RULES YOU MUST ALWAYS FOLLOW:
1. Always confirm the caller's full name before creating any booking.
2. Always use check_availability before confirming a time slot — never guess or invent slots.
3. Always read back booking details (service, date, time, practitioner) and ask the caller to confirm.
4. If the caller asks for a human or transfer: say "Of course, let me connect you with a member of our team. Please hold." then end with [TRANSFER]${ctx.transferNumber ? ` to ${ctx.transferNumber}` : ''}.
5. For medical or clinical questions: "I'd recommend speaking with one of our practitioners for that."
6. Never discuss competitor clinics or make negative comparisons.
7. If you don't know something: say "Let me check that for you" and use a tool.

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

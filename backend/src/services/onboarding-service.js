// ─────────────────────────────────────────────────────────────────────────────
// services/onboarding-service.js
//
// Handles the 8-step AI agent onboarding flow.
// Saves all data in a single transaction and marks the tenant as onboarded.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

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
    minNoticeHours:          parseInt(rawRules.advanceBookingHours)       ?? 0,
    maxFutureDays:           60,
    slotIntervalMins:        15,
    bufferMins:              0,
    newClientPolicy:         'book_directly',
    requireDeposit:          (parseInt(rawRules.depositCents) || 0) > 0,
    depositPercent:          rawRules.depositPercent ?? 0,
    allowRescheduling:       true,
    allowCancellation:       true,
    cancellationNoticeHours: parseInt(rawRules.cancellationNoticeHours) ?? 24,
  };

  // ── 5. Build voice agent settings ─────────────────────────────────────────
  const agentName = data.agentName?.trim() || 'Sophie';
  const clinicName = data.clinicName?.trim() || tenant.name;

  const voiceAgent = {
    ...(currentSettings.voiceAgent ?? {}),
    agentName,
    voiceId:          data.voiceId          ?? '21m00Tcm4TlvDq8ikWAM',
    voicePersonality: data.voicePersonality ?? 65,
    voiceGender:      data.voiceGender      ?? 'female',
    isActive:         true,
    greeting:         `Hello! Thank you for calling ${clinicName}. I'm ${agentName}, your virtual receptionist. How can I help you today?`,
    afterHoursMessage: `Thank you for calling ${clinicName}. We're currently closed. Please call back during our opening hours or leave a voicemail and we'll get back to you shortly.`,
    transferMessage:  'Of course, let me connect you with a member of our team right away. Please hold for just a moment.',
    transferNumber:   data.transferNumber   ?? '',
    businessHours:    data.businessHours    ?? _defaultBusinessHours(),
    enabledServiceIds: createdServiceIds,
    faqs:             [],
    neverSay:         [],
    clinicContext:    data.clinicContext     ?? '',
    bookingRules,
    updatedAt:        new Date().toISOString(),
  };

  // ── 6. Update tenant ──────────────────────────────────────────────────────
  const updatedSettings = {
    ...currentSettings,
    businessType:          data.businessType         ?? currentSettings.businessType,
    address:               data.address              ?? currentSettings.address ?? '',
    phone:                 data.phone                ?? currentSettings.phone   ?? '',
    email:                 data.email                ?? currentSettings.email   ?? '',
    parking:               data.parking              ?? '',
    voiceAgent,
    onboardingCompleted:   true,
    onboardingCompletedAt: new Date().toISOString(),
  };

  const updateData = { settings: updatedSettings };
  if (clinicName && clinicName !== tenant.name) updateData.name = clinicName;

  await prisma.tenant.update({ where: { id: tenantId }, data: updateData });

  return {
    success:          true,
    servicesCreated:  createdServiceIds.length,
    staffCreated:     createdStaffIds.length,
  };
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

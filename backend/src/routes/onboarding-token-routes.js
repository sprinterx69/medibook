// ─────────────────────────────────────────────────────────────────────────────
// routes/onboarding-token-routes.js
//
// Token-gated onboarding API for the 6-step Med Spa setup wizard.
//
//   GET  /api/onboarding/:token          — validate token, return progress
//   POST /api/onboarding/:token/step     — auto-save step data
//   POST /api/onboarding/:token/submit   — finalise onboarding
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

export default async function onboardingTokenRoutes(fastify) {

  // ── Shared token validation helper ───────────────────────────────────────
  async function resolveToken(token, reply) {
    const record = await prisma.onboardingToken.findUnique({
      where: { token },
      include: { tenant: { select: { id: true, name: true, settings: true, clinicStatus: true } } },
    });

    if (!record) {
      reply.code(404).send({ error: 'Invalid onboarding link.' });
      return null;
    }
    if (record.usedAt) {
      reply.code(409).send({ error: 'This onboarding link has already been used.', redirect: '/app/dashboard.html' });
      return null;
    }
    if (new Date() > record.expiresAt) {
      reply.code(410).send({ error: 'This onboarding link has expired. Please log in to get a new one.', redirect: '/pages/login.html' });
      return null;
    }
    return record;
  }

  // ── GET /api/onboarding/:token ────────────────────────────────────────────
  fastify.get('/api/onboarding/:token', async (request, reply) => {
    const record = await resolveToken(request.params.token, reply);
    if (!record) return;

    const progress = record.tenant.settings?.onboardingProgress ?? {};
    return {
      tenantId:   record.tenant.id,
      tenantName: record.tenant.name,
      expiresAt:  record.expiresAt,
      progress,
    };
  });

  // ── POST /api/onboarding/:token/step ─────────────────────────────────────
  // Auto-saves step data to tenant.settings.onboardingProgress
  fastify.post('/api/onboarding/:token/step', async (request, reply) => {
    const record = await resolveToken(request.params.token, reply);
    if (!record) return;

    const { step, data } = request.body ?? {};
    if (!step || !data) {
      return reply.code(400).send({ error: 'step and data are required' });
    }

    const current = record.tenant.settings ?? {};
    const progress = current.onboardingProgress ?? {};
    progress[`step_${step}`] = data;

    await prisma.tenant.update({
      where: { id: record.tenantId },
      data:  { settings: { ...current, onboardingProgress: progress } },
    });

    return { saved: true, step };
  });

  // ── POST /api/onboarding/:token/submit ────────────────────────────────────
  // Finalises onboarding: creates services, consultation rule, brand voice, blackout dates.
  fastify.post('/api/onboarding/:token/submit', async (request, reply) => {
    const record = await resolveToken(request.params.token, reply);
    if (!record) return;

    const body = request.body ?? {};
    const { clinicInfo, services, consultationRules, callHandling, brandVoice, operatingHours } = body;

    await prisma.$transaction(async (tx) => {
      const tenantId = record.tenantId;

      // Step 1: Update clinic info on tenant settings
      const currentSettings = record.tenant.settings ?? {};
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          name: clinicInfo?.name || record.tenant.name,
          clinicStatus: 'onboarding_submitted',
          settings: {
            ...currentSettings,
            phone:    clinicInfo?.phone,
            timezone: clinicInfo?.timezone || 'America/New_York',
            address:  clinicInfo?.address,
            website:  clinicInfo?.website,
            instagram: clinicInfo?.instagram,
            callHandling: callHandling ?? {},
            onboardingProgress: null, // clear progress once submitted
          },
        },
      });

      // Step 2: Upsert services
      if (Array.isArray(services)) {
        for (const svc of services) {
          if (!svc.name) continue;
          await tx.service.upsert({
            where: { id: svc.id || 'new-' + Math.random() },
            create: {
              tenantId,
              name: svc.name,
              durationMins: svc.durationMins || 60,
              priceCents: Math.round((svc.price || 0) * 100),
              consultationRequired: svc.consultationRequired || false,
              category: 'Med Spa',
            },
            update: {
              name: svc.name,
              durationMins: svc.durationMins || 60,
              priceCents: Math.round((svc.price || 0) * 100),
              consultationRequired: svc.consultationRequired || false,
            },
          }).catch(() => {
            // New service (id not found) — create instead
            return tx.service.create({
              data: {
                tenantId,
                name: svc.name,
                durationMins: svc.durationMins || 60,
                priceCents: Math.round((svc.price || 0) * 100),
                consultationRequired: svc.consultationRequired || false,
                category: 'Med Spa',
              },
            });
          });
        }
      }

      // Step 3: Upsert consultation rules
      if (consultationRules) {
        await tx.consultationRule.upsert({
          where:  { tenantId },
          create: { tenantId, ...consultationRules },
          update: consultationRules,
        });
      }

      // Step 4: Upsert brand voice
      if (brandVoice) {
        await tx.brandVoice.upsert({
          where:  { tenantId },
          create: { tenantId, ...brandVoice },
          update: brandVoice,
        });
      }

      // Step 5: Blackout dates
      if (Array.isArray(operatingHours?.blackoutDates)) {
        for (const d of operatingHours.blackoutDates) {
          const date = new Date(d.date);
          if (isNaN(date.getTime())) continue;
          await tx.blackoutDate.upsert({
            where:  { tenantId_date: { tenantId, date } },
            create: { tenantId, date, label: d.label },
            update: { label: d.label },
          });
        }
      }

      // Mark token used
      await tx.onboardingToken.update({
        where: { id: record.id },
        data:  { usedAt: new Date() },
      });
    });

    return { success: true, message: 'Setup complete! Your clinic is being configured.', redirect: '/app/dashboard.html' };
  });
}

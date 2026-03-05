// ─────────────────────────────────────────────────────────────────────────────
// routes/admin-routes.js
//
// Platform admin API — all routes require SUPERADMIN platformRole.
//
//   GET  /api/admin/overview
//   GET  /api/admin/clinics
//   GET  /api/admin/clinics/:tenantId/status
//   PUT  /api/admin/clinics/:tenantId/status
//   GET  /api/admin/clinics/:tenantId/ai-config
//   PUT  /api/admin/clinics/:tenantId/ai-config
//   GET  /api/admin/clinics/:tenantId/booking-engine
//   PUT  /api/admin/clinics/:tenantId/booking-engine
//   GET  /api/admin/clinics/:tenantId/transcripts
//   GET  /api/admin/clinics/:tenantId/booking-logs
//   GET  /api/admin/billing/:tenantId
//   POST /api/admin/clinics/initiate
//   POST /api/admin/clinics/:tenantId/resend-onboarding
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import { requirePlatformAdmin } from '../middleware/role-guards.js';
import { createAdminCheckoutSession } from '../services/billing.js';
import { sendOnboardingEmail } from '../services/email.js';
import crypto from 'crypto';

export default async function adminRoutes(fastify) {

  // All admin routes require JWT + SUPERADMIN role
  async function guard(request, reply) {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
    return requirePlatformAdmin(request, reply);
  }

  // ── GET /api/admin/overview ───────────────────────────────────────────────
  fastify.get('/api/admin/overview', { preHandler: [guard] }, async () => {
    const [tenants, callsToday, bookingsToday] = await Promise.all([
      prisma.tenant.findMany({
        select: { id: true, clinicStatus: true, isActive: true, plan: true, subscriptions: { select: { status: true } } },
      }),
      prisma.callLog.count({
        where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      prisma.appointment.count({
        where: {
          source: 'VOICE',
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    const statusCounts = tenants.reduce((acc, t) => {
      acc[t.clinicStatus] = (acc[t.clinicStatus] || 0) + 1;
      return acc;
    }, {});

    // Rough MRR: count active/trialing subscriptions
    const planMrr = { STARTER: 29900 };
    const mrr = tenants.reduce((sum, t) => {
      const hasPaid = t.subscriptions.some(s => ['ACTIVE', 'TRIALING'].includes(s.status));
      return sum + (hasPaid ? (planMrr[t.plan] ?? 0) : 0);
    }, 0);

    return {
      mrr,
      totalClinics:   tenants.length,
      liveClinics:    tenants.filter(t => t.clinicStatus === 'live').length,
      callsToday,
      bookingsToday,
      statusCounts,
    };
  });

  // ── GET /api/admin/clinics ────────────────────────────────────────────────
  fastify.get('/api/admin/clinics', { preHandler: [guard] }, async (request) => {
    const { status } = request.query;
    const where = status ? { clinicStatus: status } : {};
    const clinics = await prisma.tenant.findMany({
      where,
      select: {
        id: true, name: true, slug: true, plan: true, clinicStatus: true,
        isActive: true, createdAt: true,
        users: { where: { role: 'OWNER' }, select: { email: true, fullName: true }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { clinics };
  });

  // ── GET/PUT /api/admin/clinics/:tenantId/status ───────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/status', { preHandler: [guard] }, async (request) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.params.tenantId },
      select: { id: true, name: true, clinicStatus: true, isActive: true },
    });
    if (!tenant) return { error: 'Tenant not found' };
    return tenant;
  });

  fastify.put('/api/admin/clinics/:tenantId/status', { preHandler: [guard] }, async (request, reply) => {
    const { clinicStatus, isActive } = request.body ?? {};
    const VALID_STATUSES = ['pending_payment', 'onboarding_required', 'onboarding_submitted', 'setup_in_progress', 'testing', 'live', 'paused'];
    if (clinicStatus && !VALID_STATUSES.includes(clinicStatus)) {
      return reply.code(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const data = {};
    if (clinicStatus) data.clinicStatus = clinicStatus;
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    const tenant = await prisma.tenant.update({ where: { id: request.params.tenantId }, data });
    return { success: true, clinicStatus: tenant.clinicStatus, isActive: tenant.isActive };
  });

  // ── GET/PUT /api/admin/clinics/:tenantId/ai-config ────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/ai-config', { preHandler: [guard] }, async (request) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.params.tenantId },
      select: { settings: true },
    });
    return { aiConfig: (tenant?.settings)?.aiConfig ?? {} };
  });

  fastify.put('/api/admin/clinics/:tenantId/ai-config', { preHandler: [guard] }, async (request) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: request.params.tenantId }, select: { settings: true } });
    const current = tenant?.settings ?? {};
    await prisma.tenant.update({
      where: { id: request.params.tenantId },
      data:  { settings: { ...current, aiConfig: request.body } },
    });
    return { success: true };
  });

  // ── GET/PUT /api/admin/clinics/:tenantId/booking-engine ───────────────────
  fastify.get('/api/admin/clinics/:tenantId/booking-engine', { preHandler: [guard] }, async (request) => {
    const [rule, brandVoice] = await Promise.all([
      prisma.consultationRule.findUnique({ where: { tenantId: request.params.tenantId } }),
      prisma.brandVoice.findUnique({ where: { tenantId: request.params.tenantId } }),
    ]);
    return { consultationRule: rule, brandVoice };
  });

  fastify.put('/api/admin/clinics/:tenantId/booking-engine', { preHandler: [guard] }, async (request) => {
    const { consultationRule, brandVoice } = request.body ?? {};
    const tenantId = request.params.tenantId;
    if (consultationRule) {
      await prisma.consultationRule.upsert({
        where:  { tenantId },
        create: { tenantId, ...consultationRule },
        update: consultationRule,
      });
    }
    if (brandVoice) {
      await prisma.brandVoice.upsert({
        where:  { tenantId },
        create: { tenantId, ...brandVoice },
        update: brandVoice,
      });
    }
    return { success: true };
  });

  // ── GET /api/admin/clinics/:tenantId/transcripts ──────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/transcripts', { preHandler: [guard] }, async (request) => {
    const logs = await prisma.callLog.findMany({
      where: { tenantId: request.params.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, callSid: true, callerPhone: true, durationMs: true, bookingsMade: true, twilioStatus: true, createdAt: true, transcript: true },
    });
    return { logs };
  });

  // ── GET /api/admin/clinics/:tenantId/booking-logs ─────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/booking-logs', { preHandler: [guard] }, async (request) => {
    const logs = await prisma.bookingEngineLog.findMany({
      where: { tenantId: request.params.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { logs };
  });

  // ── GET /api/admin/billing/:tenantId ─────────────────────────────────────
  fastify.get('/api/admin/billing/:tenantId', { preHandler: [guard] }, async (request) => {
    const [tenant, subscriptions] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: request.params.tenantId },
        select: { stripeCustomerId: true, stripeSubscriptionId: true, plan: true, clinicStatus: true },
      }),
      prisma.subscription.findMany({ where: { tenantId: request.params.tenantId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { tenant, subscriptions };
  });

  // ── POST /api/admin/clinics/initiate ──────────────────────────────────────
  // Starts the Stripe-first clinic creation flow.
  fastify.post('/api/admin/clinics/initiate', { preHandler: [guard] }, async (request, reply) => {
    const { planKey, businessName, email, fullName } = request.body ?? {};
    if (!planKey || !businessName || !email) {
      return reply.code(400).send({ error: 'planKey, businessName, and email are required' });
    }

    try {
      const result = await createAdminCheckoutSession({
        planKey, businessName, email, fullName: fullName || businessName,
        successUrl: `${process.env.PUBLIC_URL}/pages/payment-success.html`,
        cancelUrl:  `${process.env.PUBLIC_URL}/pages/login.html`,
      });
      return { checkoutUrl: result.url, sessionId: result.sessionId };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /api/admin/clinics/:tenantId/resend-onboarding ───────────────────
  // Regenerates the onboarding token and resends the email.
  fastify.post('/api/admin/clinics/:tenantId/resend-onboarding', { preHandler: [guard] }, async (request, reply) => {
    const { tenantId } = request.params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, users: { where: { role: 'OWNER' }, select: { email: true, fullName: true }, take: 1 } },
    });
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const owner = tenant.users[0];
    if (!owner) return reply.code(404).send({ error: 'No owner user found' });

    const newToken = crypto.randomBytes(32).toString('hex');
    await prisma.onboardingToken.upsert({
      where:  { tenantId },
      create: { tenantId, token: newToken, expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000) },
      update: { token: newToken, expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), usedAt: null },
    });

    const onboardingUrl = `${process.env.PUBLIC_URL}/app/onboarding.html?token=${newToken}`;
    try {
      await sendOnboardingEmail({ to: owner.email, fullName: owner.fullName, tenantName: tenant.name, onboardingUrl });
    } catch (emailErr) {
      console.error('[Admin] Failed to send onboarding email:', emailErr.message);
    }

    return { success: true, onboardingUrl };
  });
}

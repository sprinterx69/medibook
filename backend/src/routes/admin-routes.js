// ─────────────────────────────────────────────────────────────────────────────
// routes/admin-routes.js
//
// All routes require platformRole = SUPERADMIN (enforced server-side).
//
// GET  /api/admin/overview                           — Platform stats (MRR, clinics, calls, bookings)
// GET  /api/admin/clinics                            — List all tenants with status
// GET  /api/admin/clinics/:tenantId                  — Full clinic detail
// PUT  /api/admin/clinics/:tenantId/status           — Update clinicStatus
// GET  /api/admin/clinics/:tenantId/ai-config        — Get AI/agent config
// PUT  /api/admin/clinics/:tenantId/ai-config        — Update AI/agent config
// GET  /api/admin/clinics/:tenantId/booking-engine   — Get consultation rules
// PUT  /api/admin/clinics/:tenantId/booking-engine   — Update consultation rules
// GET  /api/admin/clinics/:tenantId/transcripts      — Call transcripts
// GET  /api/admin/clinics/:tenantId/booking-logs     — Booking validation logs
// GET  /api/admin/billing/:tenantId                  — Stripe subscription + invoice data
// POST /api/admin/clinics/initiate                   — Start Stripe-first clinic creation
// POST /api/admin/clinics/:tenantId/resend-onboarding — Regenerate onboarding token
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import { requirePlatformAdmin } from '../middleware/role-guards.js';
import { createAdminCheckoutSession, getSubscriptionStatus, listInvoices } from '../services/billing.js';
import crypto from 'crypto';

const VALID_CLINIC_STATUSES = [
  'pending_payment', 'onboarding_required', 'onboarding_submitted',
  'setup_in_progress', 'testing', 'live', 'paused',
];

export default async function adminRoutes(fastify) {

  // All admin routes require authentication + SUPERADMIN role
  const adminGuard = [
    async (req, reply) => {
      try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
    },
    requirePlatformAdmin,
  ];

  // ── GET /api/admin/overview ───────────────────────────────────────────────
  fastify.get('/api/admin/overview', { preHandler: adminGuard }, async (request, reply) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [
      totalClinics,
      liveClinics,
      callsToday,
      aiBookingsToday,
      subscriptions,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { clinicStatus: 'live' } }),
      prisma.callLog.count({ where: { createdAt: { gte: today, lte: todayEnd } } }),
      prisma.appointment.count({
        where: { createdAt: { gte: today, lte: todayEnd }, source: { in: ['VOICE', 'voice_agent', 'ai'] } },
      }),
      prisma.subscription.findMany({
        where:   { status: { in: ['ACTIVE', 'TRIALING'] } },
        include: { tenant: { select: { plan: true } } },
      }),
    ]);

    // Approximate MRR from active subscriptions (uses plan amounts from PLANS config)
    const PLAN_AMOUNTS = { STARTER: 4900, PRO: 12900, ENTERPRISE: 0 };
    const mrrCents = subscriptions.reduce((sum, sub) => {
      return sum + (PLAN_AMOUNTS[sub.tenant?.plan] ?? 0);
    }, 0);

    // Count by status
    const statusCounts = await prisma.tenant.groupBy({
      by:      ['clinicStatus'],
      _count:  { _all: true },
    });

    return {
      totalClinics,
      liveClinics,
      callsToday,
      aiBookingsToday,
      mrr:          { cents: mrrCents, formatted: `$${(mrrCents / 100).toFixed(0)}` },
      statusCounts: statusCounts.reduce((acc, row) => {
        acc[row.clinicStatus] = row._count._all;
        return acc;
      }, {}),
    };
  });

  // ── GET /api/admin/clinics ────────────────────────────────────────────────
  fastify.get('/api/admin/clinics', { preHandler: adminGuard }, async (request, reply) => {
    const clinics = await prisma.tenant.findMany({
      select: {
        id:                   true,
        name:                 true,
        slug:                 true,
        plan:                 true,
        clinicStatus:         true,
        stripeCustomerId:     true,
        stripeSubscriptionId: true,
        isActive:             true,
        createdAt:            true,
        users: {
          where:  { role: 'OWNER' },
          select: { email: true, fullName: true },
          take:   1,
        },
        subscriptions: {
          where:   { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
          orderBy: { createdAt: 'desc' },
          take:    1,
          select:  { status: true, currentPeriodEnd: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { clinics };
  });

  // ── GET /api/admin/clinics/:tenantId ──────────────────────────────────────
  fastify.get('/api/admin/clinics/:tenantId', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    const tenant = await prisma.tenant.findUnique({
      where:   { id: tenantId },
      include: {
        users:           { select: { id: true, email: true, fullName: true, role: true, platformRole: true, createdAt: true } },
        subscriptions:   { orderBy: { createdAt: 'desc' }, take: 1 },
        consultationRule: true,
        brandVoice:      true,
        onboardingToken: { select: { expiresAt: true, usedAt: true, createdAt: true } },
        _count:          { select: { appointments: true, clients: true, callLogs: true } },
      },
    });

    if (!tenant) return reply.code(404).send({ error: 'Clinic not found' });
    return tenant;
  });

  // ── PUT /api/admin/clinics/:tenantId/status ───────────────────────────────
  fastify.put('/api/admin/clinics/:tenantId/status', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId }     = request.params;
    const { clinicStatus } = request.body ?? {};

    if (!VALID_CLINIC_STATUSES.includes(clinicStatus)) {
      return reply.code(400).send({ error: `Invalid status. Must be one of: ${VALID_CLINIC_STATUSES.join(', ')}` });
    }

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data:  {
        clinicStatus,
        isActive: clinicStatus === 'live' || clinicStatus === 'testing',
      },
      select: { id: true, name: true, clinicStatus: true, isActive: true },
    });

    await prisma.activityLog.create({
      data: {
        tenantId,
        type:        'clinic_status_changed',
        description: `Clinic status changed to <strong>${clinicStatus}</strong> by admin.`,
        icon:        '🔧',
        bgColor:     '#3b82f6',
      },
    });

    return updated;
  });

  // ── GET /api/admin/clinics/:tenantId/ai-config ────────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/ai-config', { preHandler: adminGuard }, async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where:  { id: request.params.tenantId },
      select: { id: true, name: true, settings: true, brandVoice: true },
    });
    if (!tenant) return reply.code(404).send({ error: 'Clinic not found' });

    return {
      tenantId:    tenant.id,
      tenantName:  tenant.name,
      aiConfig:    tenant.settings?.aiConfig ?? {},
      callHandling: tenant.settings?.callHandling ?? {},
      brandVoice:  tenant.brandVoice ?? null,
    };
  });

  // ── PUT /api/admin/clinics/:tenantId/ai-config ────────────────────────────
  fastify.put('/api/admin/clinics/:tenantId/ai-config', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    const { aiConfig, callHandling } = request.body ?? {};

    const tenant = await prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) return reply.code(404).send({ error: 'Clinic not found' });

    await prisma.tenant.update({
      where: { id: tenantId },
      data:  {
        settings: {
          ...(tenant.settings ?? {}),
          ...(aiConfig      ? { aiConfig }      : {}),
          ...(callHandling  ? { callHandling }  : {}),
        },
      },
    });

    return { success: true };
  });

  // ── GET /api/admin/clinics/:tenantId/booking-engine ───────────────────────
  fastify.get('/api/admin/clinics/:tenantId/booking-engine', { preHandler: adminGuard }, async (request, reply) => {
    const rule = await prisma.consultationRule.findUnique({
      where: { tenantId: request.params.tenantId },
    });
    return rule ?? { tenantId: request.params.tenantId, configured: false };
  });

  // ── PUT /api/admin/clinics/:tenantId/booking-engine ───────────────────────
  fastify.put('/api/admin/clinics/:tenantId/booking-engine', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    const { durationMins, availableDays, timeBlocks, bufferMins, maxPerDay } = request.body ?? {};

    const data = {};
    if (durationMins  != null) data.durationMins  = parseInt(durationMins,  10);
    if (availableDays != null) data.availableDays = availableDays;
    if (timeBlocks    != null) data.timeBlocks    = timeBlocks;
    if (bufferMins    != null) data.bufferMins    = parseInt(bufferMins,    10);
    if (maxPerDay     != null) data.maxPerDay     = parseInt(maxPerDay,     10);

    const rule = await prisma.consultationRule.upsert({
      where:  { tenantId },
      create: { tenantId, durationMins: 30, availableDays: [1,2,3,4,5], timeBlocks: [{ start:'09:00',end:'17:00' }], bufferMins: 15, maxPerDay: 10, ...data },
      update: data,
    });

    return rule;
  });

  // ── GET /api/admin/clinics/:tenantId/transcripts ──────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/transcripts', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    const limit        = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset       = parseInt(request.query.offset ?? '0', 10);

    const [calls, total] = await Promise.all([
      prisma.callLog.findMany({
        where:   { tenantId },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
        select:  {
          id: true, callSid: true, callerPhone: true,
          durationMs: true, bookingsMade: true, twilioStatus: true,
          transcript: true, createdAt: true,
        },
      }),
      prisma.callLog.count({ where: { tenantId } }),
    ]);

    return { calls, total, limit, offset };
  });

  // ── GET /api/admin/clinics/:tenantId/booking-logs ─────────────────────────
  fastify.get('/api/admin/clinics/:tenantId/booking-logs', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    const limit        = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset       = parseInt(request.query.offset ?? '0', 10);

    const [logs, total] = await Promise.all([
      prisma.bookingEngineLog.findMany({
        where:   { tenantId },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.bookingEngineLog.count({ where: { tenantId } }),
    ]);

    return { logs, total, limit, offset };
  });

  // ── GET /api/admin/billing/:tenantId ──────────────────────────────────────
  fastify.get('/api/admin/billing/:tenantId', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;
    try {
      const [status, invoices] = await Promise.all([
        getSubscriptionStatus(tenantId),
        listInvoices(tenantId, 12),
      ]);
      return { subscription: status, ...invoices };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /api/admin/clinics/initiate ──────────────────────────────────────
  // Admin initiates Stripe-first checkout for a new clinic
  fastify.post('/api/admin/clinics/initiate', { preHandler: adminGuard }, async (request, reply) => {
    const { businessName, ownerEmail, ownerFullName, planKey, setupFeeIncluded } = request.body ?? {};

    const missing = ['businessName', 'ownerEmail', 'ownerFullName', 'planKey'].filter(k => !request.body?.[k]);
    if (missing.length) {
      return reply.code(400).send({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    try {
      const appUrl = process.env.APP_URL || 'https://app.callora.me';
      const result = await createAdminCheckoutSession({
        businessName,
        ownerEmail,
        ownerFullName,
        planKey:          planKey.toLowerCase(),
        setupFeeIncluded: Boolean(setupFeeIncluded),
        successUrl:       `${appUrl}/pages/admin/index.html?payment=success`,
        cancelUrl:        `${appUrl}/pages/admin/index.html?payment=cancelled`,
      });

      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /api/admin/clinics/:tenantId/resend-onboarding ───────────────────
  // Regenerate onboarding token and optionally resend email
  fastify.post('/api/admin/clinics/:tenantId/resend-onboarding', { preHandler: adminGuard }, async (request, reply) => {
    const { tenantId } = request.params;

    const tenant = await prisma.tenant.findUnique({
      where:  { id: tenantId },
      select: { id: true, name: true, clinicStatus: true, users: { where: { role: 'OWNER' }, select: { email: true, fullName: true }, take: 1 } },
    });

    if (!tenant) return reply.code(404).send({ error: 'Clinic not found' });

    // Generate new token (invalidates old one via upsert)
    const newToken = crypto.randomBytes(32).toString('hex');
    const tokenRecord = await prisma.onboardingToken.upsert({
      where:  { tenantId },
      create: {
        tenantId,
        token:     newToken,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      },
      update: {
        token:     newToken,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        usedAt:    null,
      },
    });

    // Optionally reset clinicStatus to onboarding_required if it was submitted
    if (tenant.clinicStatus !== 'live' && tenant.clinicStatus !== 'testing') {
      await prisma.tenant.update({
        where: { id: tenantId },
        data:  { clinicStatus: 'onboarding_required' },
      });
    }

    const appUrl = process.env.APP_URL || 'https://app.callora.me';
    const onboardingUrl = `${appUrl}/app/onboarding.html?token=${tokenRecord.token}`;

    // Send email if owner exists
    const owner = tenant.users?.[0];
    if (owner) {
      try {
        const { sendOnboardingEmail } = await import('../services/email.js');
        await sendOnboardingEmail({
          to:           owner.email,
          fullName:     owner.fullName,
          tenantName:   tenant.name,
          onboardingUrl,
        });
      } catch (err) {
        console.error('[admin] Onboarding email failed (non-fatal):', err.message);
      }
    }

    return {
      success:        true,
      onboardingUrl,
      token:          tokenRecord.token,
      expiresAt:      tokenRecord.expiresAt,
    };
  });
}

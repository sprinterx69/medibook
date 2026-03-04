// ─────────────────────────────────────────────────────────────────────────────
// middleware/role-guards.js
//
// Server-side role enforcement preHandlers.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

/**
 * Requires the authenticated user to have platformRole = SUPERADMIN.
 * Must be used AFTER request.jwtVerify().
 */
export async function requirePlatformAdmin(request, reply) {
  const role = request.user?.platformRole;
  if (role !== 'SUPERADMIN') {
    return reply.code(403).send({ error: 'FORBIDDEN', message: 'Admin access required.' });
  }
}

/**
 * Requires the clinic to have completed onboarding and not be paused.
 * Reads clinicStatus from DB (not JWT, which may be stale).
 */
export async function requireOnboardingComplete(request, reply) {
  const tenantId = request.user?.tenantId;
  if (!tenantId) return reply.code(401).send({ error: 'Unauthorized' });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { clinicStatus: true },
  });

  if (!tenant) return reply.code(401).send({ error: 'Tenant not found' });

  if (tenant.clinicStatus === 'paused') {
    return reply.code(403).send({
      error: 'ACCOUNT_PAUSED',
      message: 'Your account is paused. Please update your payment method.',
      redirect: '/pages/billing-issue.html',
    });
  }

  if (tenant.clinicStatus === 'onboarding_required') {
    const token = await prisma.onboardingToken.findFirst({
      where: { tenantId, usedAt: null, expiresAt: { gt: new Date() } },
      select: { token: true },
    });
    const redirect = token
      ? `/app/onboarding.html?token=${token.token}`
      : '/pages/login.html';
    return reply.code(403).send({
      error: 'ONBOARDING_REQUIRED',
      message: 'Please complete your clinic setup.',
      redirect,
    });
  }
}

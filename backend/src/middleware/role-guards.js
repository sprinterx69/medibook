// ─────────────────────────────────────────────────────────────────────────────
// middleware/role-guards.js
//
// Server-side role enforcement for the Callora Med Spa SaaS platform.
//
// Roles:
//   platformRole = "SUPERADMIN"  — Platform operators (Callora team). Full access.
//   platformRole = "CLINIC"      — Clinic owners/staff. Restricted access.
//
// Usage as Fastify preHandler:
//   fastify.get('/admin/overview', { preHandler: [fastify.authenticate, requirePlatformAdmin] }, handler)
//   fastify.get('/bookings',       { preHandler: [fastify.authenticate, requireOnboardingComplete] }, handler)
//
// All guards assume fastify.authenticate has already run (i.e., request.user is set).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

// ─── requirePlatformAdmin ─────────────────────────────────────────────────────
// Blocks anyone who is not a SUPERADMIN.
// Returns 403 Forbidden for CLINIC users and unauthenticated requests.
// Old JWTs without platformRole field are treated as CLINIC (never granted admin).
export async function requirePlatformAdmin(request, reply) {
  const role = request.user?.platformRole;
  if (role !== 'SUPERADMIN') {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'Admin access required.',
    });
  }
}

// ─── requireClinicAccess ──────────────────────────────────────────────────────
// Blocks SUPERADMIN users from accessing clinic-scoped routes with the wrong tenantId.
// Ensures a CLINIC user can only access their own tenant's data.
export async function requireClinicAccess(request, reply) {
  const { platformRole, tenantId } = request.user ?? {};

  // SUPERADMIN can access any clinic — they pass through
  if (platformRole === 'SUPERADMIN') return;

  // CLINIC user must match the route's :tenantId param (if present)
  const routeTenantId = request.params?.tenantId;
  if (routeTenantId && routeTenantId !== tenantId) {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'You do not have access to this clinic.',
    });
  }
}

// ─── requireOnboardingComplete ────────────────────────────────────────────────
// Blocks clinic users from accessing dashboard routes until onboarding is complete.
// SUPERADMIN bypasses this check entirely.
//
// If clinicStatus is onboarding_required:
//   - Looks for a valid OnboardingToken
//   - Returns { redirect: '/app/onboarding.html?token=...' }
//   - Does NOT block the request with a 403 — lets frontend handle the redirect
//
// If clinicStatus is onboarding_submitted or setup_in_progress:
//   - Returns 403 with message "Clinic setup is in progress."
//
// If clinicStatus is paused:
//   - Returns 403 with message "Account paused."
export async function requireOnboardingComplete(request, reply) {
  const { platformRole, tenantId } = request.user ?? {};

  // SUPERADMIN bypasses clinic status checks
  if (platformRole === 'SUPERADMIN') return;

  // Fetch current clinicStatus from DB (JWT may be stale)
  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: { clinicStatus: true },
  });

  const status = tenant?.clinicStatus ?? 'live';

  if (status === 'live' || status === 'testing') return; // Allow through

  if (status === 'onboarding_required') {
    // Find a valid onboarding token
    const tokenRecord = await prisma.onboardingToken.findFirst({
      where: {
        tenantId,
        usedAt:    null,
        expiresAt: { gt: new Date() },
      },
      select: { token: true },
    });

    return reply.code(403).send({
      error:    'ONBOARDING_REQUIRED',
      message:  'Please complete your clinic onboarding before accessing the dashboard.',
      redirect: tokenRecord
        ? `/app/onboarding.html?token=${tokenRecord.token}`
        : '/app/onboarding.html?expired=1',
    });
  }

  if (status === 'onboarding_submitted' || status === 'setup_in_progress') {
    return reply.code(403).send({
      error:    'SETUP_IN_PROGRESS',
      message:  'Your clinic is being set up. You will be notified when access is ready.',
      redirect: '/app/dashboard.html?status=pending_setup',
    });
  }

  if (status === 'paused') {
    return reply.code(403).send({
      error:    'ACCOUNT_PAUSED',
      message:  'Your account has been paused. Please contact support or update your billing.',
      redirect: '/app/dashboard.html?status=paused',
    });
  }

  // pending_payment — should not normally log in, but just in case
  return reply.code(403).send({
    error:   'PAYMENT_REQUIRED',
    message: 'Payment is required to access this account.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';
// stripe/feature-gates.js
//
// Middleware and helpers to enforce subscription plan limits.
// Used throughout the API to block access to paid features.
//
// Usage in route handlers:
//   await requirePlan(tenantId, 'pro');            // Must be on Pro+
//   await requireFeature(tenantId, 'voiceAgent');  // Must have feature enabled
//   const within = await checkLimit(tenantId, 'staff', currentCount);
// ─────────────────────────────────────────────────────────────────────────────


import { PLANS } from './billing.js';



const PLAN_HIERARCHY = { STARTER: 0 };

// ─── Get tenant's current plan ────────────────────────────────────────────────
async function getTenantPlan(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  });
  return tenant?.plan ?? 'STARTER';
}

// ─── Require minimum plan level ───────────────────────────────────────────────
export async function requirePlan(tenantId, minimumPlan) {
  const currentPlan = await getTenantPlan(tenantId);
  const currentLevel = PLAN_HIERARCHY[currentPlan] ?? 0;
  const requiredLevel = PLAN_HIERARCHY[minimumPlan.toUpperCase()] ?? 0;

  if (currentLevel < requiredLevel) {
    throw createUpgradeError(minimumPlan, currentPlan);
  }
}

// ─── Require specific feature ─────────────────────────────────────────────────
// Features currently gated behind Pro:
//   integrations — connect external management systems / third-party APIs
export async function requireFeature(tenantId, feature) {
  const currentPlan = await getTenantPlan(tenantId);
  const planKey = currentPlan.toLowerCase();
  const features = PLANS[planKey]?.features ?? {};

  if (!features[feature]) {
    throw createUpgradeError('pro', currentPlan, feature);
  }
}

// ─── Check usage limit ────────────────────────────────────────────────────────
// Returns { allowed: boolean, current: number, limit: number, plan: string }
export async function checkLimit(tenantId, resource) {
  const currentPlan = await getTenantPlan(tenantId);
  const planKey = currentPlan.toLowerCase();
  const features = PLANS[planKey]?.features ?? {};

  const LIMITS = {
    staff:     { featureKey: 'maxStaff',      countFn: () => prisma.staff.count({ where: { tenantId, isActive: true } }) },
    locations: { featureKey: 'maxLocations',  countFn: () => prisma.location.count({ where: { tenantId, isActive: true } }) },
    // phoneNumbers limit enforced inside settings-service.js via PHONE_LIMITS
  };

  const config = LIMITS[resource];
  if (!config) return { allowed: true, current: 0, limit: -1, plan: planKey };

  const limit = features[config.featureKey] ?? 1;
  if (limit === -1) return { allowed: true, current: 0, limit: -1, plan: planKey }; // Unlimited

  const current = await config.countFn();
  return {
    allowed: current < limit,
    current,
    limit,
    plan: planKey,
    upgradeRequired: current >= limit,
  };
}

// ─── Fastify preHandler middleware ────────────────────────────────────────────
// Apply to individual routes that need feature gating.
//
// Usage:
//   fastify.post('/staff', {
//     preHandler: [planGate('pro'), featureGate('voiceAgent'), limitGate('staff')],
//   }, handler);

export function planGate(minimumPlan) {
  return async (request, reply) => {
    try {
      await requirePlan(request.user.tenantId, minimumPlan);
    } catch (err) {
      return reply.code(402).send(err.body);
    }
  };
}

export function featureGate(feature) {
  return async (request, reply) => {
    try {
      await requireFeature(request.user.tenantId, feature);
    } catch (err) {
      return reply.code(402).send(err.body);
    }
  };
}

export function limitGate(resource) {
  return async (request, reply) => {
    const result = await checkLimit(request.user.tenantId, resource);
    if (!result.allowed) {
      return reply.code(402).send({
        error: 'LIMIT_EXCEEDED',
        message: `You've reached your ${resource} limit (${result.limit}) on the ${result.plan} plan.`,
        upgrade: { resource, current: result.current, limit: result.limit },
        upgradeUrl: `${process.env.PUBLIC_URL}/settings/billing`,
      });
    }
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function createUpgradeError(requiredPlan, currentPlan, feature) {
  const err = new Error(`This feature requires the ${requiredPlan} plan.`);
  err.body = {
    error: 'UPGRADE_REQUIRED',
    message: `This feature requires the ${requiredPlan} plan. You're currently on ${currentPlan}.`,
    currentPlan,
    requiredPlan: requiredPlan.toUpperCase(),
    feature: feature ?? null,
    upgradeUrl: `${process.env.PUBLIC_URL}/settings/billing`,
  };
  return err;
}

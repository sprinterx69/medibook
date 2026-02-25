// ─────────────────────────────────────────────────────────────────────────────
// services/settings-service.js
// Business logic for clinic settings and notification preferences.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const DEFAULT_NOTIFICATIONS = {
  emailBookingConfirmations: true,
  smsReminders: true,
  notifyOwnerOnAiBooking: true,
  dailySummaryEmail: false,
  paymentFailureAlerts: true,
};

/**
 * Get clinic information from tenant settings.
 */
export async function getClinicSettings(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, plan: true, settings: true, createdAt: true },
  });
  if (!tenant) return null;

  const s = tenant.settings ?? {};
  return {
    id:           tenant.id,
    name:         tenant.name,
    slug:         tenant.slug,
    plan:         tenant.plan,
    businessType: s.businessType ?? 'Medical Aesthetics',
    phone:        s.phone ?? '',
    email:        s.email ?? '',
    website:      s.website ?? '',
    address:      s.address ?? '',
    city:         s.city ?? '',
    postcode:     s.postcode ?? '',
    timezone:     s.timezone ?? 'Europe/London',
    currency:     s.currency ?? 'GBP',
    brandColor:   s.brandColor ?? '#0d9488',
    logoUrl:      s.logoUrl ?? '',
    createdAt:    tenant.createdAt,
    notifications: s.notifications ?? DEFAULT_NOTIFICATIONS,
  };
}

/**
 * Update clinic information.
 */
export async function updateClinicSettings(tenantId, updates) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');

  const current = tenant.settings ?? {};
  const allowed = [
    'businessType','phone','email','website','address','city','postcode',
    'timezone','currency','brandColor','logoUrl',
  ];
  const patch = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) patch[key] = updates[key];
  }

  // Update tenant name separately if provided
  const data = { settings: { ...current, ...patch } };
  if (updates.name) data.name = updates.name;

  await prisma.tenant.update({ where: { id: tenantId }, data });
  return { success: true };
}

/**
 * Update notification preferences only.
 */
export async function updateNotificationSettings(tenantId, notifications) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');

  const current = tenant.settings ?? {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { settings: { ...current, notifications: { ...DEFAULT_NOTIFICATIONS, ...notifications } } },
  });
  return { success: true };
}

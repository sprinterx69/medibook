// ─────────────────────────────────────────────────────────────────────────────
// services/settings-service.js
// Business logic for clinic settings and notification preferences.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import twilio from 'twilio';

// ─── Twilio client (lazy, so env vars are guaranteed loaded) ──────────────────
let _twilio;
function getTwilio() {
  if (!_twilio) {
    _twilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _twilio;
}

// Starter includes 1 number; Pro includes 3; Enterprise unlimited
const PHONE_LIMITS = { STARTER: 1, PRO: 3, ENTERPRISE: -1 };

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

/**
 * Auto-searches for and purchases an available local phone number for the clinic.
 *
 * - Enforces plan limits (one number on Starter, three on Pro, unlimited on Enterprise).
 * - Prevents buying a second number if one already exists.
 * - Sets voiceUrl to /api/voice-webhook on the purchased Twilio number.
 * - Persists the number + SID into tenant.settings.voiceAgentPhone/voiceAgentPhoneSid.
 *
 * @param {string} tenantId  - Authenticated clinic ID from JWT
 * @param {string} [country] - ISO country code, defaults to 'GB'
 * @returns {{ success: true, phoneNumber: string }}
 */
export async function buyClinicNumber(tenantId, country = 'GB') {
  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: { plan: true, settings: true },
  });
  if (!tenant) {
    throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  }

  const settings = tenant.settings ?? {};
  const limit    = PHONE_LIMITS[tenant.plan] ?? 0;

  // ── Plan check ─────────────────────────────────────────────────────────────
  if (limit === 0) {
    throw Object.assign(
      new Error('You have reached your phone number limit. Upgrade to Pro for additional numbers.'),
      { statusCode: 402, code: 'PLAN_UPGRADE_REQUIRED', requiredPlan: 'PRO' },
    );
  }

  // ── Duplicate guard ────────────────────────────────────────────────────────
  if (settings.voiceAgentPhone) {
    throw Object.assign(
      new Error(`This clinic already has a phone number (${settings.voiceAgentPhone}). Release it before buying a new one.`),
      { statusCode: 409, code: 'NUMBER_ALREADY_EXISTS' },
    );
  }

  // ── Search Twilio inventory ────────────────────────────────────────────────
  let available;
  try {
    available = await getTwilio()
      .availablePhoneNumbers(country)
      .local
      .list({ voiceEnabled: true, limit: 1 });
  } catch (err) {
    throw Object.assign(
      new Error(`Twilio number search failed: ${err.message}`),
      { statusCode: 502 },
    );
  }

  if (!available.length) {
    throw Object.assign(
      new Error(`No available local numbers found in ${country}. Try a different country code.`),
      { statusCode: 404 },
    );
  }

  const chosenNumber   = available[0].phoneNumber;
  const voiceWebhook   = `${process.env.PUBLIC_URL}/voice/inbound`;

  // ── Purchase via Twilio ────────────────────────────────────────────────────
  let purchased;
  try {
    purchased = await getTwilio().incomingPhoneNumbers.create({
      phoneNumber:          chosenNumber,
      voiceUrl:             voiceWebhook,
      voiceMethod:          'POST',
      statusCallback:       `${process.env.PUBLIC_URL}/voice/status`,
      statusCallbackMethod: 'POST',
    });
  } catch (err) {
    throw Object.assign(
      new Error(`Twilio purchase failed: ${err.message}`),
      { statusCode: 502 },
    );
  }

  // ── Persist into tenant settings (existing JSON column) ───────────────────
  //
  // Equivalent raw SQL if needed:
  //   UPDATE tenants
  //   SET    settings = settings
  //                  || jsonb_build_object(
  //                       'voiceAgentPhone',    $1,
  //                       'voiceAgentPhoneSid', $2
  //                     )
  //   WHERE  id = $3;
  //
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...settings,
        voiceAgentPhone:    purchased.phoneNumber,
        voiceAgentPhoneSid: purchased.sid,
      },
    },
  });

  return { success: true, phoneNumber: purchased.phoneNumber };
}

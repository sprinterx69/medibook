// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '../config/prisma.js';
// services/phone-numbers.js
//
// Twilio phone number provisioning for MediBook tenants.
// Handles searching available numbers, purchasing, and plan enforcement.
//
// Numbers are stored in tenant.settings.voiceAgentPhone (string) so the
// existing call-routing logic in tenant-and-utils.js requires no changes.
//
// Plan limits:
//   STARTER    → 0 numbers (voice agent feature not included)
//   PRO        → 1 number
//   ENTERPRISE → unlimited (-1)
// ─────────────────────────────────────────────────────────────────────────────


import twilio from 'twilio';


const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const PHONE_LIMITS = { STARTER: 0, PRO: 1, ENTERPRISE: -1 };

export const SUPPORTED_COUNTRIES = [
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'US', name: 'United States',  flag: '🇺🇸' },
  { code: 'CA', name: 'Canada',         flag: '🇨🇦' },
  { code: 'AU', name: 'Australia',      flag: '🇦🇺' },
];

// ─── List tenant's assigned numbers ───────────────────────────────────────────
export async function getTenantNumbers(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const settings = tenant.settings ?? {};
  const phone    = settings.voiceAgentPhone ?? null;
  const limit    = PHONE_LIMITS[tenant.plan] ?? 0;

  return {
    numbers: phone ? [{ phoneNumber: phone, sid: settings.voiceAgentPhoneSid ?? null, isActive: true }] : [],
    plan:    tenant.plan,
    limit,                                    // -1 = unlimited
    canAdd:  limit === -1 || (!phone && limit > 0),
    countries: SUPPORTED_COUNTRIES,
  };
}

// ─── Search Twilio inventory for available numbers ─────────────────────────────
export async function searchAvailableNumbers(country = 'GB', areaCode = null) {
  const params = { voiceEnabled: true, limit: 8 };
  if (areaCode) params.areaCode = areaCode;

  try {
    const results = await twilioClient
      .availablePhoneNumbers(country)
      .local
      .list(params);

    return results.map(n => ({
      phoneNumber:  n.phoneNumber,
      friendlyName: n.friendlyName,
      locality:     n.locality     ?? '',
      region:       n.region       ?? '',
      country,
      capabilities: { voice: n.capabilities.voice, sms: n.capabilities.SMS },
    }));
  } catch (err) {
    throw Object.assign(new Error(`Twilio search failed: ${err.message}`), { statusCode: 502 });
  }
}

// ─── Purchase a phone number via Twilio and assign it to the tenant ────────────
export async function purchaseNumber(tenantId, phoneNumber) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const limit    = PHONE_LIMITS[tenant.plan] ?? 0;
  const settings = tenant.settings ?? {};

  // Enforce plan — STARTER has no voice agent
  if (limit === 0) {
    throw Object.assign(
      new Error('Your Starter plan does not include phone numbers. Upgrade to Pro to enable the AI voice agent.'),
      { statusCode: 402, code: 'PLAN_UPGRADE_REQUIRED', requiredPlan: 'PRO' }
    );
  }

  // Enforce per-plan number cap (PRO = 1)
  if (limit !== -1 && settings.voiceAgentPhone) {
    throw Object.assign(
      new Error('Phone number limit reached for your plan (1 number on Pro). Release your current number first, or upgrade to Enterprise for unlimited numbers.'),
      { statusCode: 402, code: 'LIMIT_EXCEEDED', limit }
    );
  }

  // Buy from Twilio and configure webhooks
  let purchased;
  try {
    purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl:              `${process.env.PUBLIC_URL}/voice/inbound`,
      voiceMethod:           'POST',
      statusCallback:        `${process.env.PUBLIC_URL}/voice/status`,
      statusCallbackMethod:  'POST',
    });
  } catch (err) {
    throw Object.assign(new Error(`Twilio purchase failed: ${err.message}`), { statusCode: 502 });
  }

  // Persist to tenant settings
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

  return { phoneNumber: purchased.phoneNumber, sid: purchased.sid, isActive: true };
}

// ─── Release a number from Twilio and remove from tenant settings ──────────────
export async function releaseNumber(tenantId, phoneNumber) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const settings = tenant.settings ?? {};
  if (settings.voiceAgentPhone !== phoneNumber) {
    throw Object.assign(new Error('Phone number not found on this account'), { statusCode: 404 });
  }

  // Remove from Twilio (best-effort — may already be released)
  if (settings.voiceAgentPhoneSid) {
    try {
      await twilioClient.incomingPhoneNumbers(settings.voiceAgentPhoneSid).remove();
    } catch (err) {
      console.error('Twilio release warning:', err.message);
    }
  }

  // Remove from tenant settings
  const { voiceAgentPhone, voiceAgentPhoneSid, ...rest } = settings;
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: rest } });

  return { released: true, phoneNumber };
}

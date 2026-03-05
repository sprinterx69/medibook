// ─────────────────────────────────────────────────────────────────────────────
// services/phone-numbers.js
//
// Twilio phone number provisioning for MediBook tenants.
// Handles searching available numbers, purchasing, and plan enforcement.
//
// Numbers are stored in tenant.settings.voiceAgentPhone (string) so the
// existing call-routing logic in tenant-and-utils.js requires no changes.
//
// Plan limits:
//   STARTER    → 1 number
//   PRO        → 1 number
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';
import twilio from 'twilio';

// Lazy-load Twilio client to ensure env vars are loaded
let twilioClient;
export function getTwilio() {
  if (!twilioClient) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

const PHONE_LIMITS = { STARTER: 1, PRO: 1 };

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
    const results = await getTwilio()
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

  const settings = tenant.settings ?? {};

  // Allow PRO/ENTERPRISE tenants to buy numbers (supports free trials & pre-Stripe setups)
  // Only block if explicitly STARTER plan
  const limit = PHONE_LIMITS[tenant.plan] ?? 0;

  // Plan check bypassed - all plans can buy numbers

  // Enforce per-plan number cap (PRO = 1)
  if (limit !== -1 && settings.voiceAgentPhone) {
    throw Object.assign(
      new Error('Phone number limit reached for your plan (1 number on Pro). Release your current number first, or upgrade to Enterprise for unlimited numbers.'),
      { statusCode: 402, code: 'LIMIT_EXCEEDED', limit }
    );
  }

  // Buy from Twilio and configure webhooks
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) {
    throw Object.assign(
      new Error('PUBLIC_URL environment variable is not set — cannot configure Twilio webhooks'),
      { statusCode: 500 }
    );
  }

  let purchased;
  try {
    purchased = await getTwilio().incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl:              `${publicUrl}/voice/inbound`,
      voiceMethod:           'POST',
      statusCallback:        `${publicUrl}/voice/status`,
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

// ─── Update webhook URLs for an existing number ───────────────────────────────
// Call this if PUBLIC_URL changed after the number was purchased, or if the
// webhook was misconfigured. Idempotent — safe to call multiple times.
export async function updateWebhook(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const settings = tenant.settings ?? {};
  const sid = settings.voiceAgentPhoneSid;
  if (!sid) {
    throw Object.assign(
      new Error('No phone number SID found — purchase a number first'),
      { statusCode: 400 }
    );
  }

  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) {
    throw Object.assign(
      new Error('PUBLIC_URL environment variable is not set on the server'),
      { statusCode: 500 }
    );
  }

  try {
    await getTwilio().incomingPhoneNumbers(sid).update({
      voiceUrl:             `${publicUrl}/voice/inbound`,
      voiceMethod:          'POST',
      statusCallback:       `${publicUrl}/voice/status`,
      statusCallbackMethod: 'POST',
    });
  } catch (err) {
    throw Object.assign(new Error(`Twilio webhook update failed: ${err.message}`), { statusCode: 502 });
  }

  return { updated: true, voiceUrl: `${publicUrl}/voice/inbound`, sid };
}


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
      await getTwilio().incomingPhoneNumbers(settings.voiceAgentPhoneSid).remove();
    } catch (err) {
      console.error('Twilio release warning:', err.message);
    }
  }

  // Remove from tenant settings
  const { voiceAgentPhone, voiceAgentPhoneSid, ...rest } = settings;
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: rest } });

  return { released: true, phoneNumber };
}

// ─── Diagnose phone number configuration ──────────────────────────────────────
// Returns what's in the DB, what Twilio has configured, and what PUBLIC_URL is.
export async function diagnoseTenantPhone(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });

  const settings = tenant.settings ?? {};
  const phone = settings.voiceAgentPhone ?? null;
  const sid   = settings.voiceAgentPhoneSid ?? null;

  const result = {
    db: { voiceAgentPhone: phone, voiceAgentPhoneSid: sid },
    server: { PUBLIC_URL: process.env.PUBLIC_URL ?? null },
    twilio: null,
  };

  if (sid) {
    try {
      const num = await getTwilio().incomingPhoneNumbers(sid).fetch();
      result.twilio = {
        phoneNumber:  num.phoneNumber,
        voiceUrl:     num.voiceUrl,
        voiceMethod:  num.voiceMethod,
        sid:          num.sid,
        accountSid:   num.accountSid,
      };
    } catch (err) {
      result.twilio = { error: err.message };
    }
  }

  return result;
}

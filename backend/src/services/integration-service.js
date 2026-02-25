// ─────────────────────────────────────────────────────────────────────────────
// services/integration-service.js
// Business logic for third-party integrations.
// Stores OAuth tokens in tenant.settings.integrations JSON column.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../config/prisma.js';

// Base integration catalogue — status comes from env vars and stored tokens
const INTEGRATIONS_CATALOGUE = [
  {
    key:    'twilio',
    name:   'Twilio',
    desc:   'Phone numbers & AI call routing',
    icon:   '📞',
    envKey: 'TWILIO_ACCOUNT_SID',
    docsUrl: 'https://twilio.com',
  },
  {
    key:    'openai',
    name:   'OpenAI (GPT-4o)',
    desc:   'AI receptionist intelligence',
    icon:   '🤖',
    envKey: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com',
  },
  {
    key:    'elevenlabs',
    name:   'ElevenLabs',
    desc:   'Natural text-to-speech voices',
    icon:   '🎙️',
    envKey: 'ELEVENLABS_API_KEY',
    docsUrl: 'https://elevenlabs.io',
  },
  {
    key:    'deepgram',
    name:   'Deepgram',
    desc:   'Real-time speech recognition',
    icon:   '👂',
    envKey: 'DEEPGRAM_API_KEY',
    docsUrl: 'https://deepgram.com',
  },
  {
    key:    'stripe',
    name:   'Stripe',
    desc:   'Subscription billing & payments',
    icon:   '💳',
    envKey: 'STRIPE_SECRET_KEY',
    docsUrl: 'https://stripe.com',
  },
  {
    key:    'resend',
    name:   'Resend',
    desc:   'Transactional email delivery',
    icon:   '✉️',
    envKey: 'RESEND_API_KEY',
    docsUrl: 'https://resend.com',
  },
  {
    key:    'google_calendar',
    name:   'Google Calendar',
    desc:   'Sync appointments to Google Calendar',
    icon:   '📅',
    envKey: null,           // OAuth — stored in tenant settings
    oauthEnabled: true,
    docsUrl: 'https://calendar.google.com',
  },
];

/**
 * List all integrations with their current connection status.
 */
export async function listIntegrations(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const storedTokens = (tenant?.settings ?? {}).integrations ?? {};

  return INTEGRATIONS_CATALOGUE.map(integration => {
    let connected = false;
    let connectedAt = null;

    if (integration.envKey) {
      // Connected if corresponding env var is set
      connected = Boolean(process.env[integration.envKey]);
    } else if (integration.oauthEnabled) {
      // Connected if we have stored OAuth tokens
      const stored = storedTokens[integration.key];
      connected = Boolean(stored?.accessToken);
      connectedAt = stored?.connectedAt ?? null;
    }

    return {
      key:          integration.key,
      name:         integration.name,
      desc:         integration.desc,
      icon:         integration.icon,
      connected,
      connectedAt,
      oauthEnabled: integration.oauthEnabled ?? false,
      docsUrl:      integration.docsUrl,
    };
  });
}

/**
 * Build the Google Calendar OAuth authorization URL.
 * Requires GOOGLE_CLIENT_ID env var.
 */
export function getGoogleCalendarAuthUrl(tenantId) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/api/tenants/${tenantId}/integrations/google-calendar/callback`;

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is not set');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/calendar',
    access_type:   'offline',
    prompt:        'consent',
    state:         tenantId,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange auth code for tokens and store them.
 */
export async function handleGoogleCalendarCallback(tenantId, code) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${process.env.PUBLIC_URL}/api/tenants/${tenantId}/integrations/google-calendar/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    throw new Error('Failed to exchange Google auth code');
  }
  const tokens = await tokenRes.json();

  // Store tokens in tenant settings
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const current = tenant.settings ?? {};
  const integrations = current.integrations ?? {};

  await prisma.tenant.update({
    where: { id: tenantId },
    data:  {
      settings: {
        ...current,
        integrations: {
          ...integrations,
          google_calendar: {
            accessToken:  tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt:    new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
            connectedAt:  new Date().toISOString(),
          },
        },
      },
    },
  });

  return { success: true };
}

/**
 * Disconnect an OAuth integration by removing stored tokens.
 */
export async function disconnectIntegration(tenantId, integrationKey) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error('Tenant not found');

  const current = tenant.settings ?? {};
  const integrations = { ...(current.integrations ?? {}) };
  delete integrations[integrationKey];

  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { settings: { ...current, integrations } },
  });

  return { success: true };
}

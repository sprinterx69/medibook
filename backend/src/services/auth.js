// ─────────────────────────────────────────────────────────────────────────────
// services/auth.js
//
// Authentication and tenant-creation logic.
//
// Registration flow:
//   1. startRegistration   — validates, hashes pw, creates PendingRegistration,
//                            sends 6-digit verification email
import { prisma } from '../config/prisma.js';
//   2. verifyEmailAndActivate — verifies code, creates Tenant + User + Staff
//                            in a transaction, returns JWT payload + Stripe URL
//
// Auth flow:
//   loginUser              — validates credentials, returns JWT payload
//   getMe                  — returns user + tenant info by userId
//   resendVerificationCode — generates fresh code and re-sends email
//
// Password hashing uses Node's built-in crypto.scrypt (no bcrypt dep needed).
// ─────────────────────────────────────────────────────────────────────────────


import crypto from 'crypto';
import { promisify } from 'util';
import { sendVerificationEmail, sendWelcomeEmail } from './email.js';
import { createCheckoutSession } from './billing.js';


const scryptAsync = promisify(crypto.scrypt);

// ─── Password helpers ──────────────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf  = await scryptAsync(password, salt, 64);
  return `${salt}:${buf.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const buf = await scryptAsync(password, salt, 64);
  return crypto.timingSafeEqual(buf, Buffer.from(hash, 'hex'));
}

// ─── Slug generation ───────────────────────────────────────────────────────────

async function generateSlug(businessName) {
  const base = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'clinic';

  let slug = base;
  let n = 2;
  while (true) {
    const [existing, pending] = await Promise.all([
      prisma.tenant.findUnique({ where: { slug } }),
      prisma.pendingRegistration.findFirst({ where: { slug } }),
    ]);
    if (!existing && !pending) break;
    slug = `${base}-${n++}`;
  }
  return slug;
}

// ─── Start registration ────────────────────────────────────────────────────────
// Creates a PendingRegistration and sends a verification email.
export async function startRegistration({ planKey, businessName, fullName, email, username, phone, password }) {
  const VALID_PLANS = ['starter', 'pro', 'enterprise'];
  if (!VALID_PLANS.includes(planKey)) {
    throw Object.assign(new Error('Invalid plan selected.'), { statusCode: 400 });
  }

  const normEmail    = email.toLowerCase().trim();
  const normUsername = username.toLowerCase().trim();

  // Username must be alphanumeric + dashes only
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(normUsername)) {
    throw Object.assign(
      new Error('Username must be 3-63 characters, start with a letter or number, and contain only letters, numbers and hyphens.'),
      { statusCode: 400 }
    );
  }

  // Check uniqueness against real users and pending registrations
  const [existingUser, existingPending] = await Promise.all([
    prisma.user.findFirst({
      where: { OR: [{ email: normEmail }, { username: normUsername }] },
      select: { email: true, username: true },
    }),
    prisma.pendingRegistration.findFirst({
      where: { OR: [{ username: normUsername }] },
      select: { email: true, username: true },
    }),
  ]);

  // Email conflict (allow re-registration with same email — they might be resending)
  if (existingUser?.email === normEmail) {
    throw Object.assign(new Error('An account with this email already exists. Try logging in.'), { statusCode: 409, code: 'EMAIL_EXISTS' });
  }
  // Username conflict
  const takenUsername = existingUser?.username === normUsername || existingPending?.username === normUsername;
  if (takenUsername) {
    throw Object.assign(new Error('This username is taken. Please choose another.'), { statusCode: 409, code: 'USERNAME_TAKEN' });
  }

  const [passwordHash, slug] = await Promise.all([
    hashPassword(password),
    generateSlug(businessName),
  ]);

  const verifyCode = String(Math.floor(100000 + Math.random() * 900000));

  // Upsert PendingRegistration — allows retry with same email
  const reg = await prisma.pendingRegistration.upsert({
    where:  { email: normEmail },
    create: {
      planKey, businessName: businessName.trim(), slug,
      fullName: fullName.trim(), email: normEmail,
      username: normUsername, phone: phone?.trim() || null,
      passwordHash, verifyCode,
      verifyExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    update: {
      planKey, businessName: businessName.trim(), slug,
      fullName: fullName.trim(), username: normUsername,
      phone: phone?.trim() || null, passwordHash, verifyCode,
      verifyExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  // Send email (best-effort — don't fail account creation if email fails)
  try {
    await sendVerificationEmail({ to: normEmail, fullName: fullName.trim(), code: verifyCode });
  } catch (err) {
    console.error('[auth] Verification email failed:', err.message);
  }

  return { registrationId: reg.id, email: normEmail };
}

// ─── Verify email and activate account ────────────────────────────────────────
// On success: creates Tenant + User + Staff, returns JWT payload + Stripe checkout URL.
export async function verifyEmailAndActivate({ email, code, frontendUrl }) {
  const normEmail = email.toLowerCase().trim();

  const reg = await prisma.pendingRegistration.findUnique({ where: { email: normEmail } });
  if (!reg) {
    throw Object.assign(new Error('Registration not found. Please start the signup process again.'), { statusCode: 404 });
  }
  if (reg.verifyCode !== String(code).trim()) {
    throw Object.assign(new Error('Incorrect code. Please check your email and try again.'), { statusCode: 400 });
  }
  if (new Date() > reg.verifyExpiry) {
    throw Object.assign(new Error('This code has expired. Please request a new one.'), { statusCode: 410 });
  }

  // Create Tenant + User + Staff in a single transaction
  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug: reg.slug,
        name: reg.businessName,
        plan: reg.planKey?.toUpperCase() ?? 'STARTER', // Use selected plan (Stripe webhook will update if needed)
        settings: {
          timezone:   'Europe/London',
          currency:   'gbp',
          brandColor: '#c9903a',
        },
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId:       tenant.id,
        email:          reg.email,
        username:       reg.username,
        passwordHash:   reg.passwordHash,
        fullName:       reg.fullName,
        phone:          reg.phone,
        role:           'OWNER',
        emailVerifiedAt: new Date(),
      },
    });

    // Create a Staff record for the owner so they appear in scheduling
    await tx.staff.create({
      data: {
        tenantId: tenant.id,
        email:    reg.email,
        name:     reg.fullName,
        role:     'OWNER',
      },
    });

    // Clean up pending registration
    await tx.pendingRegistration.delete({ where: { id: reg.id } });

    return { tenant, user };
  });

  // Create Stripe Checkout (30-day trial). Enterprise gets a manual quote instead.
  let checkoutUrl = null;
  if (reg.planKey !== 'enterprise') {
    try {
      const successUrl = `${frontendUrl}/pages/onboarding.html?success=1`;
      const cancelUrl  = `${frontendUrl}/pages/onboarding.html`;
      const checkout   = await createCheckoutSession({ tenantId: tenant.id, planKey: reg.planKey, successUrl, cancelUrl });
      checkoutUrl = checkout.url;
    } catch (err) {
      console.error('[auth] Stripe checkout failed:', err.message);
      // Don't fail account creation if Stripe is down
    }
  }

  // Send welcome email (async, don't await)
  sendWelcomeEmail({
    to:           user.email,
    fullName:     user.fullName,
    tenantName:   tenant.name,
    dashboardUrl: `${frontendUrl}/app/dashboard.html`,
  }).catch(err => console.error('[auth] Welcome email failed:', err.message));

  return {
    userId:      user.id,
    tenantId:    tenant.id,
    email:       user.email,
    fullName:    user.fullName,
    tenantName:  tenant.name,
    planKey:     reg.planKey,
    checkoutUrl,
    isEnterprise: reg.planKey === 'enterprise',
  };
}

// ─── Login ─────────────────────────────────────────────────────────────────────
export async function loginUser({ email, password }) {
  const normEmail = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where:  { email: normEmail },
    select: {
      id: true, tenantId: true, email: true, username: true,
      fullName: true, role: true, platformRole: true, passwordHash: true, emailVerifiedAt: true,
      tenant: {
        select: { name: true, plan: true, isActive: true, clinicStatus: true },
      },
    },
  });

  if (!user) {
    // Same error for wrong email or wrong password to prevent enumeration
    throw Object.assign(new Error('Incorrect email or password.'), { statusCode: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error('Incorrect email or password.'), { statusCode: 401 });
  }

  if (!user.emailVerifiedAt) {
    throw Object.assign(
      new Error('Please verify your email address before logging in.'),
      { statusCode: 403, code: 'EMAIL_NOT_VERIFIED' }
    );
  }

  if (!user.tenant.isActive) {
    throw Object.assign(
      new Error('This account has been suspended. Please contact support.'),
      { statusCode: 403 }
    );
  }

  const clinicStatus    = user.tenant.clinicStatus ?? 'live';
  const platformRole    = user.platformRole ?? 'CLINIC';

  // ── Determine redirect based on clinicStatus ────────────────────────────────
  // SUPERADMIN is never redirected by clinic status
  let redirect = null;

  if (platformRole !== 'SUPERADMIN') {
    if (clinicStatus === 'onboarding_required') {
      // Auto-regenerate token if expired or missing — user must never be blocked
      let tokenRecord = await prisma.onboardingToken.findFirst({
        where: {
          tenantId:  user.tenantId,
          usedAt:    null,
          expiresAt: { gt: new Date() },
        },
        select: { token: true },
      });

      if (!tokenRecord) {
        const newToken = crypto.randomBytes(32).toString('hex');
        tokenRecord = await prisma.onboardingToken.upsert({
          where:  { tenantId: user.tenantId },
          create: {
            tenantId:  user.tenantId,
            token:     newToken,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          },
          update: {
            token:     newToken,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            usedAt:    null,
          },
        });
      }

      redirect = `/app/onboarding.html?token=${tokenRecord.token}`;

    } else if (clinicStatus === 'onboarding_submitted' || clinicStatus === 'setup_in_progress') {
      redirect = '/app/dashboard.html?status=pending_setup';

    } else if (clinicStatus === 'paused') {
      redirect = '/app/dashboard.html?status=paused';
    }
    // 'live' and 'testing' → no redirect
  }

  return {
    userId:       user.id,
    tenantId:     user.tenantId,
    email:        user.email,
    username:     user.username,
    fullName:     user.fullName,
    role:         user.role,
    platformRole,
    clinicStatus,
    tenantName:   user.tenant.name,
    plan:         user.tenant.plan,
    ...(redirect ? { redirect } : {}),
  };
}

// ─── Get current user ──────────────────────────────────────────────────────────
export async function getMe(userId) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: {
      id: true, tenantId: true, email: true, username: true,
      fullName: true, role: true, phone: true, createdAt: true,
      tenant: { select: { id: true, name: true, slug: true, plan: true, isActive: true, settings: true } },
    },
  });
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  return user;
}

// ─── Resend verification code ──────────────────────────────────────────────────
export async function resendVerificationCode(email) {
  const normEmail = email.toLowerCase().trim();
  const reg = await prisma.pendingRegistration.findUnique({ where: { email: normEmail } });
  if (!reg) {
    throw Object.assign(new Error('No pending registration found for this email.'), { statusCode: 404 });
  }

  const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.pendingRegistration.update({
    where: { email: normEmail },
    data:  { verifyCode, verifyExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });

  await sendVerificationEmail({ to: normEmail, fullName: reg.fullName, code: verifyCode });
  return { message: 'Verification code resent.' };
}
// Deployed at Thu Feb 26 10:29:04 UTC 2026

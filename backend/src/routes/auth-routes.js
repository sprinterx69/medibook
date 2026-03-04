// ─────────────────────────────────────────────────────────────────────────────
// routes/auth-routes.js
//
// POST /auth/register       — Start signup (creates PendingRegistration, sends code)
// POST /auth/verify-email   — Verify 6-digit code → creates tenant+user → JWT + Stripe URL
// POST /auth/resend-code    — Resend verification email
// POST /auth/login          — Login → JWT
// GET  /auth/me             — Current user (requires Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

import {
  startRegistration,
  verifyEmailAndActivate,
  loginUser,
  getMe,
  resendVerificationCode,
} from '../services/auth.js';

export default async function authRoutes(fastify) {

  // ── POST /auth/register ────────────────────────────────────────────────────
  fastify.post('/auth/register', async (request, reply) => {
    const body = request.body ?? {};
    const { planKey, businessName, fullName, email, username, phone, password } = body;

    const missing = ['planKey', 'businessName', 'fullName', 'email', 'username', 'password']
      .filter(k => !body[k]);
    if (missing.length) {
      return reply.status(400).send({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters.' });
    }

    try {
      const result = await startRegistration({ planKey, businessName, fullName, email, username, phone, password });
      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message, code: err.code ?? null });
    }
  });

  // ── POST /auth/verify-email ────────────────────────────────────────────────
  fastify.post('/auth/verify-email', async (request, reply) => {
    const { email, code } = request.body ?? {};
    if (!email || !code) {
      return reply.status(400).send({ error: 'email and code are required' });
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const result = await verifyEmailAndActivate({ email, code: String(code), frontendUrl });

      // Issue a 7-day JWT containing the essentials
      const token = fastify.jwt.sign(
        { userId: result.userId, tenantId: result.tenantId, email: result.email, role: 'OWNER' },
        { expiresIn: '7d' }
      );

      return reply.status(201).send({ ...result, token });
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message, code: err.code ?? null });
    }
  });

  // ── POST /auth/resend-code ─────────────────────────────────────────────────
  fastify.post('/auth/resend-code', async (request, reply) => {
    const { email } = request.body ?? {};
    if (!email) return reply.status(400).send({ error: 'email is required' });

    try {
      return await resendVerificationCode(email);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  // ── POST /auth/login ───────────────────────────────────────────────────────
  fastify.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }

    try {
      const user  = await loginUser({ email, password });
      const token = fastify.jwt.sign(
        {
          userId:       user.userId,
          tenantId:     user.tenantId,
          email:        user.email,
          role:         user.role,
          platformRole: user.platformRole,
          clinicStatus: user.clinicStatus,
        },
        { expiresIn: '7d' }
      );
      return { ...user, token };
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message, code: err.code ?? null });
    }
  });

  // ── GET /auth/me  (protected) ──────────────────────────────────────────────
  fastify.get('/auth/me', { preHandler: [fastify.authenticate] }, async (request) => {
    return getMe(request.user.userId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MediBook AI Voice Agent — Server Entry Point
// Stack: Fastify + Twilio Media Streams + Deepgram STT + GPT-4o + ElevenLabs
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import formbodyPlugin from '@fastify/formbody';
import corsPlugin from '@fastify/cors';

import { inboundCallHandler } from './handlers/inbound-call.js';
import { mediaStreamHandler } from './handlers/media-stream.js';
import { statusCallbackHandler } from './handlers/status-callback.js';
import jwtPlugin from '@fastify/jwt';
import agentRoutes from './routes/agent-routes.js';
import phoneRoutes from './routes/phone-routes.js';
import authRoutes from './routes/auth-routes.js';
import { billingRoutes } from './routes/billing-routes.js';
import appointmentRoutes from './routes/appointment-routes.js';
import staffRoutes from './routes/staff-routes.js';
import activityRoutes from './routes/activity-routes.js';
import calendarRoutes from './routes/calendar-routes.js';
import clientRoutes from './routes/client-routes.js';
import paymentRoutes from './routes/payment-routes.js';
import settingsRoutes from './routes/settings-routes.js';
import servicesRoutes from './routes/services-routes.js';
import integrationRoutes from './routes/integration-routes.js';
import teamRoutes from './routes/team-routes.js';

const server = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────
await server.register(websocketPlugin);
await server.register(formbodyPlugin);

// CORS — allow requests from the frontend (app.medibook.io or localhost during dev)
await server.register(corsPlugin, {
  origin: process.env.FRONTEND_URL
    ? [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000']
    : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
});

// ─── JWT ───────────────────────────────────────────────────────────────────────
await server.register(jwtPlugin, {
  secret: process.env.JWT_SECRET || 'medibook-dev-secret-change-in-production',
});

// Reusable auth preHandler — call fastify.authenticate on protected routes
server.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ─── API Content-Type ─────────────────────────────────────────────────────────
// Parse JSON bodies for API routes
server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, JSON.parse(body)); } catch (err) { done(err); }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
await server.register(authRoutes);
await server.register(agentRoutes);
await server.register(phoneRoutes);
await server.register(billingRoutes, { prefix: '/billing' });
await server.register(appointmentRoutes);
await server.register(staffRoutes);
await server.register(activityRoutes);
await server.register(calendarRoutes);
await server.register(clientRoutes);
await server.register(paymentRoutes);
await server.register(settingsRoutes);
await server.register(servicesRoutes);
await server.register(integrationRoutes);
await server.register(teamRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────
server.get('/health', async () => ({
  status: 'ok',
  service: 'medibook-voice-agent',
  timestamp: new Date().toISOString(),
}));

// ─── Twilio Webhook Routes ────────────────────────────────────────────────────

/**
 * POST /voice/inbound
 * Twilio calls this when a call arrives at the clinic's phone number.
 * Returns TwiML that connects the call to our Media Stream WebSocket.
 */
server.post('/voice/inbound', inboundCallHandler);

/**
 * POST /voice/status
 * Twilio calls this with call lifecycle events (ringing, answered, completed).
 */
server.post('/voice/status', statusCallbackHandler);

// ─── WebSocket Route ──────────────────────────────────────────────────────────

/**
 * GET /voice/stream
 * Twilio Media Streams sends real-time audio here as μ-law 8kHz PCM over WS.
 * We pipe audio → Deepgram STT → GPT-4o → ElevenLabs TTS → back to Twilio.
 */
server.get('/voice/stream', { websocket: true }, mediaStreamHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
  await server.listen({ port: PORT, host: HOST });
  server.log.info(`🎙️  MediBook Voice Agent listening on ${HOST}:${PORT}`);
  server.log.info(`📞  Twilio webhook: ${process.env.PUBLIC_URL}/voice/inbound`);
  server.log.info(`🔌  Media Stream:   ${process.env.PUBLIC_URL?.replace('https', 'wss')}/voice/stream`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

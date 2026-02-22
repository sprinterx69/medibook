// ─────────────────────────────────────────────────────────────────────────────
// MediBook AI Voice Agent — Server Entry Point
// Stack: Fastify + Twilio Media Streams + Deepgram STT + GPT-4o + ElevenLabs
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import formbodyPlugin from '@fastify/formbody';

import { inboundCallHandler } from './handlers/inbound-call.js';
import { mediaStreamHandler } from './handlers/media-stream.js';
import { statusCallbackHandler } from './handlers/status-callback.js';

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

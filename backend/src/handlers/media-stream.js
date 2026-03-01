// ─────────────────────────────────────────────────────────────────────────────
// handlers/media-stream.js
//
// THE CORE OF THE VOICE AGENT
//
// This WebSocket handler receives real-time audio from Twilio Media Streams,
// pipes it through the AI pipeline, and streams synthesized speech back.
//
// Audio pipeline:
//   Twilio (μ-law 8kHz) → Deepgram WS (STT) → GPT-4o (LLM) → ElevenLabs (TTS)
//   → Twilio (base64 μ-law 8kHz back via WS)
//
// Message types from Twilio:
//   connected  — WS opened, contains stream metadata
//   start      — call stream started, contains callSid + customParameters
//   media      — audio chunk (base64 encoded μ-law PCM)
//   stop       — call ended
//   mark       — playback position marker (used for interruption detection)
// ─────────────────────────────────────────────────────────────────────────────

import { getCallSession, updateCallSession, deleteCallSession } from '../services/session-store.js';
import { createDeepgramConnection } from '../services/deepgram.js';
import { runLLMTurn } from '../services/llm.js';
import { synthesizeSpeech, streamAudioToTwilio } from '../services/tts.js';
import { getTenantContext } from '../services/tenant-and-utils.js';
import { saveCallTranscript } from '../services/transcript.js';

export async function mediaStreamHandler(connection, request) {
  const log = request.log;
  log.info('Media stream WebSocket opened');

  // State for this call
  let callSid = null;
  let tenantId = null;
  let session = null;
  let deepgramWs = null;
  let isSpeaking = false;        // Is the agent currently speaking?
  let isProcessing = false;      // Is the LLM currently processing a turn?
  let interimTranscript = '';    // Accumulated partial transcript
  let finalTranscript = '';      // Final transcript for current utterance
  let silenceTimer = null;       // Timer to detect end of user speech
  let streamSid = null;          // Twilio stream SID (needed to send audio back)

  const SILENCE_TIMEOUT_MS = 800; // Wait 800ms of silence before processing

  // ─── Handle messages from Twilio ──────────────────────────────────────────
  connection.socket.on('message', async (rawMessage) => {
    let msg;
    try {
      msg = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    switch (msg.event) {

      // ── connected: WebSocket is open ──────────────────────────────────────
      case 'connected':
        log.info({ protocol: msg.protocol }, 'Twilio stream connected');
        break;

      // ── start: Call stream beginning, contains our custom parameters ───────
      case 'start': {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        // Retrieve custom parameters we passed in TwiML <Parameter> tags
        const params = msg.start.customParameters ?? {};
        tenantId = params.tenantId;

        log.info({ callSid, tenantId, streamSid }, 'Stream started');

        // Load the call session created by inbound-call handler
        session = await getCallSession(callSid);
        if (!session) {
          log.warn({ callSid }, 'No session found for call');
          connection.socket.close();
          return;
        }

        // Load tenant context (business name, services, hours, etc.)
        const tenantCtx = await getTenantContext(tenantId);
        session.tenantContext = tenantCtx;
        session.conversationHistory = [];

        // Open Deepgram WebSocket for real-time STT
        deepgramWs = createDeepgramConnection({
          onTranscript: handleTranscript,
          onError: (err) => log.error({ err }, 'Deepgram error'),
        });

        // Give a warm greeting after a brief pause
        setTimeout(() => greetCaller(session, connection, streamSid, log), 600);
        break;
      }

      // ── media: Audio chunk from caller ────────────────────────────────────
      case 'media': {
        if (!deepgramWs || isSpeaking) return; // Don't process audio while agent is speaking

        // Twilio sends base64 encoded μ-law 8kHz audio
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');

        // Forward raw audio to Deepgram
        if (deepgramWs.readyState === 1 /* OPEN */) {
          deepgramWs.send(audioBuffer);
        }
        break;
      }

      // ── mark: Playback marker (we use this to detect when agent finishes speaking)
      case 'mark': {
        if (msg.mark.name === 'agent-done-speaking') {
          isSpeaking = false;
          log.debug('Agent finished speaking, listening again');
        }
        break;
      }

      // ── stop: Call ended ───────────────────────────────────────────────────
      case 'stop': {
        log.info({ callSid }, 'Stream stopped — call ended');
        await handleCallEnd(session, log);
        if (deepgramWs) deepgramWs.close();
        break;
      }
    }
  });

  connection.socket.on('close', async () => {
    log.info({ callSid }, 'WebSocket closed');
    if (deepgramWs) deepgramWs.close();
    if (session) await handleCallEnd(session, log);
  });

  connection.socket.on('error', (err) => {
    log.error({ err }, 'WebSocket error');
  });

  // ─── Handle transcripts from Deepgram ────────────────────────────────────
  async function handleTranscript({ text, isFinal, confidence }) {
    if (!text || isProcessing) return;

    if (!isFinal) {
      // Partial transcript — update display and reset silence timer
      interimTranscript = text;
      resetSilenceTimer();
      return;
    }

    // Final transcript chunk received
    finalTranscript += (finalTranscript ? ' ' : '') + text;
    interimTranscript = '';
    log.debug({ text, confidence }, 'Final transcript chunk');

    // Reset the silence timer — when it fires, we process the full utterance
    resetSilenceTimer();
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      const utterance = (finalTranscript + ' ' + interimTranscript).trim();
      finalTranscript = '';
      interimTranscript = '';

      if (!utterance || utterance.length < 2) return;

      log.info({ utterance }, 'Processing user utterance');
      await processUserTurn(utterance);
    }, SILENCE_TIMEOUT_MS);
  }

  // ─── Core turn processing: utterance → LLM → TTS → Twilio ────────────────
  async function processUserTurn(userText) {
    if (isProcessing) return;
    isProcessing = true;
    isSpeaking = true;

    try {
      // Add to conversation history
      session.conversationHistory.push({ role: 'user', content: userText });

      // Run LLM turn — may include tool calls (check_availability, book_appointment, etc.)
      const { responseText, toolResults, updatedHistory } = await runLLMTurn({
        session,
        userText,
        log,
      });

      session.conversationHistory = updatedHistory;

      // Log tool usage
      if (toolResults.length > 0) {
        log.info({ tools: toolResults.map(t => t.name) }, 'Tools called in this turn');
        session.toolCallsThisTurn = toolResults;
      }

      if (!responseText) {
        isSpeaking = false;
        isProcessing = false;
        return;
      }

      log.info({ responseText: responseText.slice(0, 80) + '...' }, 'Agent response');

      // Synthesize speech with ElevenLabs — use the clinic's chosen voice
      const clinicVoiceId = session.tenantContext?.voiceAgent?.voiceId;
      const audioChunks = await synthesizeSpeech(responseText, clinicVoiceId);

      // Stream audio back to Twilio
      await streamAudioToTwilio({
        socket: connection.socket,
        streamSid,
        audioChunks,
        markName: 'agent-done-speaking',
      });

    } catch (err) {
      log.error({ err }, 'Error processing user turn');
      isSpeaking = false;
    } finally {
      isProcessing = false;
    }
  }

  // ─── Initial greeting ─────────────────────────────────────────────────────
  async function greetCaller(sess, conn, sid, logger) {
    const businessName = sess.tenantContext?.name ?? 'the clinic';
    const va = sess.tenantContext?.voiceAgent ?? {};
    // Use the clinic-specific greeting saved during onboarding/agent settings,
    // falling back to a generic greeting if none is configured yet.
    const greeting = va.greeting?.trim()
      || `Hello, thank you for calling ${businessName}. I'm ${va.agentName || 'your virtual assistant'}. How can I help you today?`;

    logger.info({ businessName }, 'Sending greeting');

    sess.conversationHistory.push({ role: 'assistant', content: greeting });
    isSpeaking = true;

    const clinicVoiceId = va.voiceId;
    const audioChunks = await synthesizeSpeech(greeting, clinicVoiceId);
    await streamAudioToTwilio({
      socket: conn.socket,
      streamSid: sid,
      audioChunks,
      markName: 'agent-done-speaking',
    });
  }

  // ─── Handle call end ──────────────────────────────────────────────────────
  async function handleCallEnd(sess, logger) {
    if (!sess || sess.ended) return;
    sess.ended = true;

    logger.info({ callSid: sess.callSid }, 'Saving call transcript and deleting session');

    // Save transcript to DB
    await saveCallTranscript({
      callSid: sess.callSid,
      tenantId: sess.tenantId,
      callerPhone: sess.callerPhone,
      history: sess.conversationHistory,
      durationMs: Date.now() - sess.startedAt.getTime(),
      bookingsMade: (sess.toolCallsThisTurn ?? [])
        .filter(t => t.name === 'book_appointment').length,
    });

    await deleteCallSession(sess.callSid);
  }
}

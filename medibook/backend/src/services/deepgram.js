// ─────────────────────────────────────────────────────────────────────────────
// services/deepgram.js
//
// Opens a WebSocket connection to Deepgram's real-time transcription API.
// Configured for:
//   - μ-law 8kHz encoding (Twilio's format)
//   - Streaming interim + final results
//   - Medical vocabulary model for accuracy with treatment names
//   - Endpointing (voice activity detection) to detect utterance boundaries
// ─────────────────────────────────────────────────────────────────────────────

import { WebSocket } from 'ws';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * Deepgram streaming STT query parameters.
 * These are appended to the WebSocket URL.
 */
const DG_PARAMS = new URLSearchParams({
  model: 'nova-2-medical',    // Medical vocabulary model — handles treatment names well
  language: 'en-GB',
  encoding: 'mulaw',          // Twilio sends μ-law encoded audio
  sample_rate: '8000',        // Twilio Media Streams: 8kHz
  channels: '1',
  punctuate: 'true',          // Add punctuation to transcripts
  interim_results: 'true',    // Stream partial results as user speaks
  smart_format: 'true',       // Format numbers, dates, etc.
  utterance_end_ms: '1200',   // Emit UtteranceEnd after 1.2s of silence
  vad_events: 'true',         // Voice activity detection events
  endpointing: '300',         // Detect end of speech after 300ms silence
}).toString();

/**
 * Creates and manages a Deepgram WebSocket connection.
 *
 * @param {Object} options
 * @param {Function} options.onTranscript   - Called with { text, isFinal, confidence }
 * @param {Function} options.onError        - Called with Error
 * @returns {WebSocket} The Deepgram WebSocket instance
 */
export function createDeepgramConnection({ onTranscript, onError }) {
  const ws = new WebSocket(`${DEEPGRAM_WS_URL}?${DG_PARAMS}`, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  ws.on('open', () => {
    // Send a KeepAlive every 5s to prevent timeout during pauses
    ws._keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 5000);
  });

  ws.on('message', (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    // ── Handle transcript results ──────────────────────────────────────────
    if (data.type === 'Results') {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      const text = alt.transcript.trim();
      if (!text) return;

      onTranscript({
        text,
        isFinal: data.is_final === true,
        confidence: alt.confidence ?? 0,
        words: alt.words ?? [],
      });
    }

    // ── Handle utterance end (user finished speaking) ──────────────────────
    if (data.type === 'UtteranceEnd') {
      // Signal that the user has stopped speaking — triggers processing
      onTranscript({ text: '', isFinal: true, confidence: 0, utteranceEnd: true });
    }
  });

  ws.on('error', (err) => {
    onError(err);
  });

  ws.on('close', () => {
    if (ws._keepAliveInterval) clearInterval(ws._keepAliveInterval);
  });

  return ws;
}

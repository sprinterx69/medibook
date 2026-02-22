// ─────────────────────────────────────────────────────────────────────────────
// services/tts.js
//
// Text-to-Speech via ElevenLabs streaming API.
// ElevenLabs returns PCM audio (24kHz by default), which we must convert
// to μ-law 8kHz before sending back to Twilio via the Media Stream WebSocket.
//
// Audio format conversion:
//   ElevenLabs → PCM 24kHz linear16 → μ-law 8kHz (downsample + encode)
//
// We stream chunks back to Twilio as they arrive so speech starts ASAP,
// without waiting for the full synthesis to complete (low latency).
// ─────────────────────────────────────────────────────────────────────────────

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Encodes a 16-bit PCM sample to 8-bit μ-law.
 * μ-law is a companding algorithm that Twilio uses for telephone audio.
 */
function linearToUlaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;

  let s = sample;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (s >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xff;
}

/**
 * Converts a PCM buffer (16-bit LE, inputSampleRate) to μ-law 8kHz.
 * Simple linear interpolation downsampling.
 */
function pcm16ToUlaw8k(pcmBuffer, inputSampleRate = 24000) {
  const outputSampleRate = 8000;
  const ratio = inputSampleRate / outputSampleRate;
  const inputSamples = pcmBuffer.length / 2; // 16-bit = 2 bytes per sample
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples);

  for (let i = 0; i < outputSamples; i++) {
    const srcIdx = Math.floor(i * ratio) * 2;
    if (srcIdx + 1 >= pcmBuffer.length) break;
    // Read 16-bit LE sample
    const sample = pcmBuffer.readInt16LE(srcIdx);
    output[i] = linearToUlaw(sample);
  }

  return output;
}

/**
 * Synthesizes speech via ElevenLabs streaming API.
 * Returns an array of μ-law 8kHz audio buffers, ready for Twilio.
 *
 * @param {string} text - The text to synthesize
 * @returns {Promise<Buffer[]>} Array of audio chunks
 */
export async function synthesizeSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';

  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',   // Lowest latency model
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
        output_format: 'pcm_24000',    // Raw PCM at 24kHz for easy conversion
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${err}`);
  }

  // Collect streamed PCM chunks
  const pcmChunks = [];
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) pcmChunks.push(Buffer.from(value));
  }

  // Convert all PCM to μ-law 8kHz
  return pcmChunks.map(chunk => pcm16ToUlaw8k(chunk, 24000));
}

/**
 * Streams μ-law audio chunks back to Twilio over the Media Stream WebSocket.
 *
 * Twilio expects:
 *   { event: 'media', streamSid, media: { payload: <base64 mulaw> } }
 *
 * After all audio, we send a 'mark' event so we know when Twilio finishes
 * playing the audio (used to resume listening).
 *
 * @param {Object} options
 * @param {WebSocket} options.socket     - The Twilio Media Stream WebSocket
 * @param {string}    options.streamSid  - Twilio stream SID
 * @param {Buffer[]}  options.audioChunks - μ-law 8kHz audio chunks
 * @param {string}    options.markName   - Name for the completion mark event
 */
export async function streamAudioToTwilio({ socket, streamSid, audioChunks, markName }) {
  if (!audioChunks.length || socket.readyState !== 1 /* OPEN */) return;

  // Send each audio chunk as a Twilio media event
  for (const chunk of audioChunks) {
    if (socket.readyState !== 1) break;

    socket.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: {
        payload: chunk.toString('base64'),
      },
    }));
  }

  // Send mark event — Twilio echoes this back when the audio finishes playing
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: markName },
    }));
  }
}

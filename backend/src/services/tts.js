import { execSync } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export async function synthesizeSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
  
  const response = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2' }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${err}`);
  }

  const mp3Buffer = Buffer.from(await response.arrayBuffer());
  
  // Convert MP3 to μ-law using FFmpeg
  const tmpMp3 = join(tmpdir(), `tts-${Date.now()}.mp3`);
  const tmpUl = join(tmpdir(), `tts-${Date.now()}.ul`);
  
  writeFileSync(tmpMp3, mp3Buffer);
  
  try {
    execSync(`${ffmpeg} -i ${tmpMp3} -ar 8000 -ac 1 -f mulaw ${tmpUl} -y`);
    const ulawBuffer = readFileSync(tmpUl);
    
    // Split into chunks
    const chunkSize = 1024;
    const chunks = [];
    for (let i = 0; i < ulawBuffer.length; i += chunkSize) {
      chunks.push(ulawBuffer.slice(i, i + chunkSize));
    }
    
    return chunks;
  } finally {
    try { unlinkSync(tmpMp3); } catch {}
    try { unlinkSync(tmpUl); } catch {}
  }
}

export async function streamAudioToTwilio({ socket, streamSid, audioChunks, markName }) {
  if (!audioChunks.length || socket.readyState !== 1 /* OPEN */) return;
  
  for (const chunk of audioChunks) {
    if (socket.readyState !== 1) break;
    socket.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: chunk.toString('base64') },
    }));
  }
  
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: markName },
    }));
  }
}

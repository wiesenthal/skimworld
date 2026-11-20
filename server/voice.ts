// Villager voices: text-to-speech through Vercel AI Gateway (the Quest browser has no
// speechSynthesis). Auth is the project's Vercel OIDC token, so no extra API key.
//
// Only lines the server itself produced are voiced: /api/npc/chat signs each reply, and
// /api/npc/voice checks that signature, so the endpoint can't be used as a free public TTS.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getVercelOidcToken } from '@vercel/oidc';
import { memory, save } from './memory.js';

const MODEL = process.env.SKIM_TTS_MODEL ?? 'openai/tts-1';
const DAILY_LINES = Number(process.env.SKIM_DAILY_TTS ?? 400);
const MAX_CHARS = 600;
const STT_MODEL = process.env.SKIM_STT_MODEL ?? 'openai/whisper-1';
const DAILY_HEARD = Number(process.env.SKIM_DAILY_STT ?? 600);
export const MAX_AUDIO_BYTES = 1_500_000; // ~1.5 MB: minutes of opus, far more than one spoken line

/** One distinct OpenAI voice per villager (tts-1 voices), plus their speaking rate. */
const VOICES: Record<string, string> = {
  tomas: 'onyx', // 68, gravelly old champion
  mari: 'coral',
  pip: 'shimmer', // the kid
  felix: 'echo',
  june: 'nova',
  ren: 'sage',
  kip: 'ash',
  nalu: 'alloy',
  ama: 'sage',
  sora: 'fable',
  hollis: 'onyx',
  vex: 'shimmer',
  bao: 'ash',
  odette: 'coral',
};
export const voiceOf = (npcId: string) => VOICES[npcId] ?? 'alloy';

const key = createHash('sha256')
  .update('skimworld-voice:' + (process.env.ANTHROPIC_API_KEY ?? process.env.SKIM_ADMIN_TOKEN ?? 'dev'))
  .digest();

export function signLine(npcId: string, text: string): string {
  return createHmac('sha256', key).update(npcId + '\n' + text).digest('hex').slice(0, 32);
}

export function verifyLine(npcId: string, text: string, sig: string): boolean {
  const want = Buffer.from(signLine(npcId, text));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Voice is available when we can authenticate to the gateway. */
export function voiceEnabled(): boolean {
  return Boolean(process.env.VERCEL || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

function underBudget(kind: 'lines' | 'heard'): boolean {
  const mem = memory();
  const day = new Date().toISOString().slice(0, 10);
  if (mem.voice?.day !== day) mem.voice = { day, lines: 0, heard: 0 };
  const used = mem.voice[kind] ?? 0;
  if (used >= (kind === 'lines' ? DAILY_LINES : DAILY_HEARD)) return false;
  mem.voice[kind] = used + 1;
  save();
  return true;
}

async function gatewayToken(req: IncomingMessage): Promise<string> {
  const header = req.headers['x-vercel-oidc-token'];
  if (typeof header === 'string' && header) return header;
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return getVercelOidcToken();
}

export type VoiceResult = { ok: true; mp3: Buffer } | { ok: false; status: number; error: string };

export async function speakLine(req: IncomingMessage, npcId: string, text: string, rate = 1): Promise<VoiceResult> {
  if (!voiceEnabled()) return { ok: false, status: 503, error: 'voice off' };
  if (!text || text.length > MAX_CHARS) return { ok: false, status: 400, error: 'bad text' };
  if (!underBudget('lines')) return { ok: false, status: 429, error: 'daily voice budget used' };
  const res = await fetch('https://ai-gateway.vercel.sh/v4/ai/speech-model', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await gatewayToken(req)}`,
      'ai-gateway-protocol-version': '0.0.1',
      'ai-speech-model-specification-version': '4',
      'ai-model-id': MODEL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, voice: voiceOf(npcId), outputFormat: 'mp3', speed: Math.min(1.25, Math.max(0.8, rate)) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.warn('[voice] gateway', res.status, detail);
    return { ok: false, status: 502, error: `gateway ${res.status}` };
  }
  const out = (await res.json()) as { audio?: string };
  if (!out.audio) return { ok: false, status: 502, error: 'no audio' };
  return { ok: true, mp3: Buffer.from(out.audio, 'base64') };
}

/** What the player said: speech-to-text for freeform talking (the Quest browser has no SpeechRecognition). */
export async function hearLine(req: IncomingMessage, audio: Buffer, mediaType: string): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  if (!voiceEnabled()) return { ok: false, status: 503, error: 'voice off' };
  if (audio.length < 1000 || audio.length > MAX_AUDIO_BYTES) return { ok: false, status: 400, error: 'bad audio' };
  if (!/^audio\/[a-z0-9.+-]+$/i.test(mediaType)) return { ok: false, status: 400, error: 'bad media type' };
  if (!underBudget('heard')) return { ok: false, status: 429, error: 'daily listening budget used' };
  const res = await fetch('https://ai-gateway.vercel.sh/v4/ai/transcription-model', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await gatewayToken(req)}`,
      'ai-gateway-protocol-version': '0.0.1',
      'ai-transcription-model-specification-version': '4',
      'ai-model-id': STT_MODEL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ audio: audio.toString('base64'), mediaType }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.warn('[hear] gateway', res.status, (await res.text()).slice(0, 300));
    return { ok: false, status: 502, error: `gateway ${res.status}` };
  }
  const out = (await res.json()) as { text?: string };
  return { ok: true, text: String(out.text ?? '').trim().slice(0, 500) };
}

// The villager API, shared by the local dev server (server/index.ts) and the Vercel function (api/index.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PERSONAS, persona } from '../shared/npcs.js';
import { advanceLives, aiStatus, chat, type ChatContext } from './brain.js';
import { flushMemory, loadMemory, memory, resetMemory } from './memory.js';
import { hearLine, MAX_AUDIO_BYTES, signLine, speakLine, verifyLine, voiceEnabled } from './voice.js';

export function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

let inflight = 0;

/** Handles /api/* routes. Returns false when the path isn't an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith('/api/')) return false;
  // Headset diagnostics: the client reports VR entry results here so they show up in the
  // server log (Vercel logs), since there's no console on the Quest. No memory load needed.
  if (url.pathname === '/api/client-log' && req.method === 'POST') {
    const b = await body<{ event?: string; detail?: string }>(req).catch(() => ({}) as { event?: string; detail?: string });
    console.warn('[client]', String(b.event ?? '').slice(0, 40), String(b.detail ?? '').slice(0, 400), '|', String(req.headers['user-agent'] ?? '').slice(0, 200));
    json(res, 200, { ok: true });
    return true;
  }
  await loadMemory();
  try {
    await route(url, req, res);
  } finally {
    await flushMemory();
  }
  return true;
}

async function route(url: URL, req: IncomingMessage, res: ServerResponse) {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, ...aiStatus(), voice: voiceEnabled(), clock: memory().lastTick });

    if (url.pathname === '/api/npc/chat' && req.method === 'POST') {
      const b = await body<{ npcId: string; message: string; context: ChatContext }>(req);
      if (!PERSONAS.some((p) => p.id === b.npcId)) return json(res, 404, { error: 'unknown villager' });
      if (inflight > 6) return json(res, 429, { error: 'busy' });
      inflight++;
      try {
        const out = await chat(b.npcId, String(b.message ?? ''), b.context ?? { hour: 12, day: 1 });
        // Signed so the voice route only ever speaks lines this server wrote.
        return json(res, 200, { ...out, voiceSig: signLine(b.npcId, out.reply) });
      } finally {
        inflight--;
      }
    }

    if (url.pathname === '/api/npc/voice' && req.method === 'POST') {
      const b = await body<{ npcId: string; text: string; sig: string }>(req);
      const text = String(b.text ?? '');
      if (!PERSONAS.some((p) => p.id === b.npcId) || !verifyLine(b.npcId, text, String(b.sig ?? ''))) return json(res, 403, { error: 'unsigned line' });
      const out = await speakLine(req, b.npcId, text, persona(b.npcId).voice.rate);
      if (!out.ok) return json(res, out.status, { error: out.error });
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'content-length': String(out.mp3.length) });
      res.end(out.mp3);
      return;
    }

    // Freeform talk: the player's recorded line in, its text out. The client then sends that to /api/npc/chat.
    if (url.pathname === '/api/npc/hear' && req.method === 'POST') {
      const audio = await rawBody(req, MAX_AUDIO_BYTES).catch(() => null);
      if (!audio) return json(res, 413, { error: 'too long' });
      const type = String(req.headers['content-type'] ?? 'audio/webm').split(';')[0].trim();
      const out = await hearLine(req, audio, type);
      if (!out.ok) return json(res, out.status, { error: out.error });
      return json(res, 200, { text: out.text });
    }

    if (url.pathname === '/api/world/tick' && req.method === 'POST') {
      const b = await body<{ day: number; hour: number }>(req);
      const out = await advanceLives(Number(b.day) || 1, Number(b.hour) || 0);
      return json(res, 200, out);
    }

    if (url.pathname === '/api/world/news') {
      const life = memory().life.slice(-60).map((e) => ({ ...e, name: persona(e.npcId).name, region: persona(e.npcId).home }));
      return json(res, 200, { events: life });
    }

    if (url.pathname === '/api/world/reset' && req.method === 'POST') {
      // Hosted: only with the admin token, so visitors can't wipe the world.
      if (process.env.VERCEL && (!process.env.SKIM_ADMIN_TOKEN || req.headers['x-skim-admin'] !== process.env.SKIM_ADMIN_TOKEN))
        return json(res, 403, { error: 'forbidden' });
      resetMemory();
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
}

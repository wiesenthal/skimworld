// Client for the NPC server (proxied at /api by Vite in dev).

export interface ChatReply {
  reply: string;
  mood: string;
  suggestions: string[];
  ai: boolean;
  voiceSig?: string; // lets /api/npc/voice speak this exact reply
}

export interface ChatContext {
  hour: number;
  day: number;
  playerName?: string;
  playerRegion?: string;
  feats?: string[];
  gear?: string[];
}

export interface LifeEvent {
  npcId: string;
  name: string;
  region: string;
  day: number;
  hour: number;
  text: string;
}

async function post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  async health(): Promise<{ ok: boolean; ai: boolean; voice?: boolean; model: string; clock?: { day: number; hour: number } | null } | null> {
    try {
      const r = await fetch('/api/health');
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  chat(npcId: string, message: string, context: ChatContext) {
    return post<ChatReply>('/api/npc/chat', { npcId, message, context });
  },
  /** The villager's line as speech (mp3), or null if voice is unavailable. */
  async voice(npcId: string, text: string, sig: string): Promise<ArrayBuffer | null> {
    try {
      const r = await fetch('/api/npc/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ npcId, text, sig }) });
      return r.ok ? await r.arrayBuffer() : null;
    } catch {
      return null;
    }
  },
  /** Speech-to-text for freeform talk: what the player said, or throws with the server's reason. */
  async hear(audio: Blob): Promise<string> {
    const r = await fetch('/api/npc/hear', { method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio, signal: AbortSignal.timeout(30000) });
    const out = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!r.ok) throw new Error(out.error ?? String(r.status));
    return out.text ?? '';
  },
  tick(day: number, hour: number) {
    return post<{ ran: boolean; events: number }>('/api/world/tick', { day, hour }, 120000);
  },
  async news(): Promise<LifeEvent[]> {
    try {
      const r = await fetch('/api/world/news');
      if (!r.ok) return [];
      return ((await r.json()) as { events: LifeEvent[] }).events;
    } catch {
      return [];
    }
  },
};

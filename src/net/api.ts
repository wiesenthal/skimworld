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

// The owner's access key unlocks live villager minds and voice. Open the game once as
// https://skimworld.vercel.app/#key=<SKIM_ACCESS_KEY>; it's kept in this browser and the
// link's #key is removed from the address bar. Without it the game runs with scripted villagers.
const KEY_STORE = 'skimworld-key';
function accessKey(): string {
  const m = location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (m) {
    const k = decodeURIComponent(m[1]);
    try {
      localStorage.setItem(KEY_STORE, k);
    } catch {
      /* storage blocked: the key still works for this page load */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return k;
  }
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}
const KEY = accessKey();
const auth = (h: Record<string, string> = {}): Record<string, string> => (KEY ? { ...h, 'x-skim-key': KEY } : h);

/** False when the server said this browser has no valid key (scripted villagers, no server voice or hearing). */
let unlocked = true;
export const isUnlocked = () => unlocked;

async function post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: 'POST', headers: auth({ 'content-type': 'application/json' }), body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  async health(): Promise<{ ok: boolean; ai: boolean; locked?: boolean; voice?: boolean; model: string; clock?: { day: number; hour: number } | null } | null> {
    try {
      const r = await fetch('/api/health', { headers: auth() });
      if (!r.ok) return null;
      const h = await r.json();
      unlocked = !h.locked;
      return h;
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
      const r = await fetch('/api/npc/voice', { method: 'POST', headers: auth({ 'content-type': 'application/json' }), body: JSON.stringify({ npcId, text, sig }) });
      return r.ok ? await r.arrayBuffer() : null;
    } catch {
      return null;
    }
  },
  /** Speech-to-text for freeform talk: what the player said, or throws with the server's reason. */
  async hear(audio: Blob): Promise<string> {
    const r = await fetch('/api/npc/hear', { method: 'POST', headers: auth({ 'content-type': audio.type || 'audio/webm' }), body: audio, signal: AbortSignal.timeout(30000) });
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

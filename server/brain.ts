// Villager minds, powered by Claude.
//  - chat(): one villager answers you in character, aware of the time, what
//    they are doing, what has happened in their life, gossip from friends, and
//    everything they remember about you.
//  - advanceLives(): every few in-game hours, the whole village moves forward —
//    each villager gets a new concrete life event that continues their arcs.
// With no credentials it falls back to scripted lines so the world still works.

import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activityAt, PERSONAS, persona, type Persona } from '../shared/npcs.js';
import { BUILDINGS } from '../shared/villages.js';
import { REGIONS } from '../shared/world.js';
import { addLife, flushMemory, gossipFor, lifeFor, memory, npcMemory, save } from './memory.js';

export const MODEL = process.env.NPC_MODEL ?? 'claude-opus-5-5';
const LIFE_MODEL = process.env.LIFE_MODEL ?? MODEL;

let client: Anthropic | null = null;
let offlineReason = '';
const hasCreds =
  !!process.env.ANTHROPIC_API_KEY ||
  !!process.env.ANTHROPIC_AUTH_TOKEN ||
  !!process.env.ANTHROPIC_PROFILE ||
  existsSync(join(homedir(), '.config', 'anthropic'));
if (process.env.SKIM_OFFLINE || !hasCreds) offlineReason = 'no Anthropic credentials (set ANTHROPIC_API_KEY or run `ant auth login`)';
else {
  try {
    client = new Anthropic();
  } catch (e) {
    offlineReason = (e as Error).message;
  }
}

// Spend guards for a public deployment: a daily cap on Claude calls (then villagers fall back
// to scripted lines until midnight UTC) and a real-time floor between life ticks.
const DAILY_CALLS = Number(process.env.SKIM_DAILY_CALLS ?? 400);
const TICK_MIN_MS = Number(process.env.SKIM_TICK_MINUTES ?? 10) * 60_000;

function underBudget(): boolean {
  const mem = memory();
  const day = new Date().toISOString().slice(0, 10);
  if (mem.usage?.day !== day) mem.usage = { day, calls: 0 };
  if (mem.usage.calls >= DAILY_CALLS) return false;
  mem.usage.calls++;
  save();
  return true;
}

export function aiStatus() {
  return { ai: !!client, model: MODEL, reason: client ? undefined : offlineReason };
}

const WORLD_BIBLE = `You are voicing a villager in SKIMWORLD, a world where everything — every plain, beach and mesa — is covered by a thin film of water, a few centimetres deep, over firm sand. Nobody walks far: people travel by skimboarding. You run, throw your board ahead onto the film, hop onto it as it slides, and plane across the shimmering water. Skill matters: timing the drop, pumping over the rollers (crouch over crests, extend down the backsides), carving without catching a rail, popping ollies off kickers and wave lips.

Places:
- Tidewell: a turquoise lagoon village of bamboo-and-thatch houses on stilts, with a pump-track ring of rollers around it. The Stilt Cup café sits on tall stilts in the middle of the lagoon.
- Saltglass Flats: a dead-flat salt pan where the film is a perfect mirror and the wind always blows hard from the east. White pavilions on steel stilts, wind turbines that power all five villages, June's Sail Loft (where riders get sails).
- Brinehook: surf shacks on driftwood stilts where the film meets real rolling waves. Bonfires at night.
- Highfall Mesa: a 38-metre mesa ringed by waterfalls, with long flowing chutes you can ride down and thermals you can glide on. Lacquered pagoda houses, Hollis's Mist Tea House, Sora's Wing Loft (where riders get glide wings). The Mist Lift carries people up.
- Glowmarsh: dusky neon shallows that never quite see day; the water glows where boards cut it. The Lumen Club, Bao's Trading Post.
- Skimboats — giant skimboards with decks, cabins and sails — run trade loops: Bao's The Long Glide (Tidewell–Glowmarsh–Saltglass) and Captain Odette's Wavecutter (Tidewell–Brinehook–Highfall). Riders hop aboard and "boat drop" off the side for huge speed.
- In a few days is the Skim Regatta: races, a wave heat, a design prize, a glide class, and a big party at the Lumen Club.

The person talking to you is a newcomer who just arrived and is learning to ride. They are wearing a VR headset in our world, but to you they are simply a visitor — never mention VR, games, AI, or being a character.

How to talk:
- Stay completely in character: your own voice, opinions, worries and wants. You have a whole life; let it leak in naturally.
- Spoken dialogue only: 1-3 short sentences (under 55 words), no stage directions, no emoji, no lists.
- React to what the visitor says and does (their riding is visible to you). Ask them things back sometimes. Remember them across conversations.
- You may share gossip, give riding tips that fit your expertise, mention where to find things, or invite them to things in your schedule.
- Keep secrets secret unless trust is genuinely high and it fits the moment.
- Offer three short things the visitor might say next ("suggestions"): natural, varied, first-person, under 10 words each.`;

function personaBlock(p: Persona): string {
  const rel = Object.entries(p.relationships)
    .map(([id, d]) => `- ${persona(id).name}: ${d}`)
    .join('\n');
  const sched = p.schedule.map((a) => `- from ${a.h}:00 ${a.note}`).join('\n');
  return `YOU ARE ${p.name}, ${p.age}, ${p.role}. Home: ${REGIONS.find((r) => r.id === p.home)!.name}.
Personality: ${p.personality}
Backstory: ${p.backstory}
Goals: ${p.goals}
Secret (guard it): ${p.secret}
How you speak: ${p.speech}
People in your life:
${rel}
Your usual day:
${sched}`;
}

export interface ChatContext {
  hour: number;
  day: number;
  playerName?: string;
  playerRegion?: string;
  feats?: string[]; // what the visitor just did ("landed a 360", "wiped out")
  gear?: string[];
}

export interface ChatReply {
  reply: string;
  mood: string;
  suggestions: string[];
  ai: boolean;
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What you say out loud, in character.' },
    mood: { type: 'string', enum: ['happy', 'warm', 'curious', 'playful', 'wistful', 'worried', 'annoyed', 'tired', 'excited'] },
    suggestions: { type: 'array', items: { type: 'string' }, description: 'Exactly three things the visitor might say next.' },
    remember: { type: 'string', description: 'A new fact worth remembering about the visitor, or empty string.' },
    relationship_delta: { type: 'integer', description: '-2..2: how this exchange changed how you feel about them.' },
  },
  required: ['reply', 'mood', 'suggestions', 'remember', 'relationship_delta'],
  additionalProperties: false,
} as const;

function fmtHour(h: number) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh}:${mm.toString().padStart(2, '0')}`;
}

function situation(p: Persona, ctx: ChatContext): string {
  const m = npcMemory(p.id);
  const act = activityAt(p, ctx.hour);
  const where = 'at' in act ? BUILDINGS.find((b) => b.id === act.at)?.name ?? act.at : act.act === 'captain' ? 'at the helm of your skimboat' : 'out riding';
  const life = lifeFor(p.id, 6).map((e) => `- day ${e.day} ${fmtHour(e.hour)}: ${e.text}`);
  const gossip = gossipFor(p.id, 5).map((e) => `- ${persona(e.npcId).name}: ${e.text}`);
  const facts = m.facts.length ? m.facts.map((f) => `- ${f}`).join('\n') : '- nothing yet; you have not met them before';
  return `RIGHT NOW: day ${ctx.day}, ${fmtHour(ctx.hour)}. You are ${act.note} (${where}).
What is going on in your life: ${m.currentLife}
Recent events in your life:
${life.join('\n') || '- (a normal week so far)'}
Gossip you have heard:
${gossip.join('\n') || '- nothing new'}
About the visitor${ctx.playerName ? ` (${ctx.playerName})` : ''}:
${facts}
How you feel about them: ${m.relationship} on a -10..10 scale (${m.relationship > 4 ? 'you trust and like them' : m.relationship < -2 ? 'you are wary of them' : 'still making up your mind'}).
What you've seen them do just now: ${ctx.feats?.length ? ctx.feats.join('; ') : 'nothing notable'}.
Their gear: ${ctx.gear?.length ? ctx.gear.join(', ') : 'just a skimboard'}.`;
}

export async function chat(npcId: string, message: string, ctx: ChatContext, allowAI = true): Promise<ChatReply> {
  const p = persona(npcId);
  const m = npcMemory(npcId);
  const opening = message.trim() === '';
  const said = opening ? '(The visitor skims up and stops beside you. Greet them.)' : message.slice(0, 400);

  // Locked visitors get scripted lines that aren't saved, so strangers can't write into the
  // shared memory that the owner's Claude-driven chats read.
  if (!allowAI) return offlineReply(p, said, opening, false);
  if (!client || !underBudget()) return offlineReply(p, said, opening);

  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of m.history.slice(-14)) {
    const last = history[history.length - 1];
    if (last && last.role === t.role) last.content = `${last.content as string}\n${t.text}`;
    else history.push({ role: t.role, content: t.text });
  }
  if (history.length && history[0].role !== 'user') history.shift();
  const lastRole = history[history.length - 1]?.role;
  if (lastRole === 'user') history.push({ role: 'assistant', content: '…' });
  history.push({ role: 'user', content: said });

  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: REPLY_SCHEMA } },
      system: [
        { type: 'text', text: `${WORLD_BIBLE}\n\n${personaBlock(p)}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: situation(p, ctx) },
      ],
      messages: history,
    });
    if (res.stop_reason === 'refusal') return offlineReply(p, said, opening);
    const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '';
    const out = JSON.parse(text) as { reply: string; mood: string; suggestions: string[]; remember: string; relationship_delta: number };
    m.history.push({ role: 'user', text: said, ts: Date.now() }, { role: 'assistant', text: out.reply, ts: Date.now() });
    if (m.history.length > 40) m.history.splice(0, m.history.length - 40);
    if (out.remember?.trim()) {
      m.facts.push(out.remember.trim());
      if (m.facts.length > 20) m.facts.shift();
    }
    m.relationship = Math.max(-10, Math.min(10, m.relationship + Math.max(-2, Math.min(2, out.relationship_delta | 0))));
    m.lastSeen = Date.now();
    save();
    return { reply: out.reply, mood: out.mood, suggestions: (out.suggestions ?? []).slice(0, 3), ai: true };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      client = null;
      offlineReason = 'authentication failed';
    }
    console.error('[npc chat]', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    return offlineReply(p, said, opening);
  }
}

// ---------------------------------------------------------------------------

const LIFE_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          npcId: { type: 'string', enum: PERSONAS.map((p) => p.id) },
          text: { type: 'string', description: 'One or two vivid, concrete sentences in past tense, third person.' },
          involves: { type: 'array', items: { type: 'string', enum: PERSONAS.map((p) => p.id) } },
          currentLife: { type: 'string', description: "This villager's updated situation in <= 2 sentences." },
        },
        required: ['npcId', 'text', 'involves', 'currentLife'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
} as const;

let ticking = false;

export async function advanceLives(day: number, hour: number): Promise<{ ran: boolean; events: number }> {
  const mem = memory();
  const now = day * 24 + hour;
  const last = mem.lastTick ? mem.lastTick.day * 24 + mem.lastTick.hour : -Infinity;
  if (ticking || now - last < 6) return { ran: false, events: 0 };
  // Real-time floor so many visitors (or reloads) can't each trigger a paid tick.
  if (client && mem.lastTickAt && Date.now() - mem.lastTickAt < TICK_MIN_MS) return { ran: false, events: 0 };
  ticking = true;
  try {
    const span = Math.min(24, now - last === Infinity ? 6 : now - last);
    mem.lastTick = { day, hour };
    mem.lastTickAt = Date.now();
    save();
    await flushMemory(); // claim this tick before the slow call so other instances skip it
    if (!client || !underBudget()) {
      const n = offlineLife(day, hour);
      save();
      return { ran: true, events: n };
    }
    const roster = PERSONAS.map(
      (p) => `## ${p.id} — ${p.name}, ${p.role}\nNow: ${npcMemory(p.id).currentLife}\nGoals: ${p.goals}\nSecret: ${p.secret}\nPeople: ${Object.entries(p.relationships).map(([k, v]) => `${k}: ${v}`).join(' | ')}`,
    ).join('\n\n');
    const recent = mem.life.slice(-24).map((e) => `- day ${e.day} ${fmtHour(e.hour)} ${e.npcId}: ${e.text}`).join('\n');
    const visitor = PERSONAS.map((p) => ({ id: p.id, f: npcMemory(p.id).facts.slice(-3), r: npcMemory(p.id).relationship }))
      .filter((x) => x.f.length)
      .map((x) => `- ${x.id} knows: ${x.f.join('; ')} (feels ${x.r})`)
      .join('\n');
    const res = await client.beta.messages.create({
      model: LIFE_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: LIFE_SCHEMA } },
      system: `You are the quiet narrator of SKIMWORLD, a world covered in a thin film of water where people travel by skimboard, live in stilt villages, and are days away from the Skim Regatta. You advance villagers' lives like a good ensemble novel: small, specific, human moments; arcs that move slowly but really move (romances, rivalries, injuries, money troubles, secrets brushing the surface); villagers crossing paths across villages via skimboats. Keep continuity with the recent log. Never resolve every arc at once. Occasionally a villager notices or talks about the newcomer, if they have met.`,
      messages: [
        {
          role: 'user',
          content: `It is now day ${day}, ${fmtHour(hour)}. About ${span} hours have passed since the last update.

VILLAGERS
${roster}

RECENT LOG
${recent || '(nothing yet — this is the first update)'}

THE NEWCOMER
${visitor || '(nobody has met them yet)'}

Write exactly one new event for each villager (${PERSONAS.length} total) covering these ${span} hours, and their updated situation.`,
        },
      ],
    });
    if (res.stop_reason === 'refusal') {
      offlineLife(day, hour);
      return { ran: true, events: 0 };
    }
    const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '{"events":[]}';
    const out = JSON.parse(text) as { events: Array<{ npcId: string; text: string; involves: string[]; currentLife: string }> };
    for (const e of out.events) {
      if (!PERSONAS.some((p) => p.id === e.npcId)) continue;
      addLife({ npcId: e.npcId, day, hour, text: e.text, involves: e.involves.filter((i) => i !== e.npcId) });
      if (e.currentLife) npcMemory(e.npcId).currentLife = e.currentLife;
    }
    save();
    return { ran: true, events: out.events.length };
  } catch (e) {
    console.error('[life tick]', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    offlineLife(day, hour);
    return { ran: true, events: 0 };
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Scripted fallbacks

const OFFLINE_SUGGESTIONS = [
  ["What's new with you?", 'Any riding tips?', 'Tell me about this place.'],
  ['Who should I meet here?', "What's the Regatta?", 'See you around!'],
  ['How did you learn to ride?', 'Where can I get a sail?', 'What do you do all day?'],
];

function offlineReply(p: Persona, said: string, opening: boolean, remember = true): ChatReply {
  const m = npcMemory(p.id);
  const lower = said.toLowerCase();
  let reply: string;
  if (opening) reply = m.history.length ? `You again! ${p.greeting.split('.')[0]}.` : p.greeting;
  else if (/tip|how do|teach|drop|pump/.test(lower))
    reply = 'Run hard, throw the board just ahead, and hop before you reach it — land on it while it slides. Crouch over crests, stand up into the dips.';
  else if (/sail|wind/.test(lower)) reply = "June's Sail Loft out on Saltglass. Wind never stops there.";
  else if (/wing|glide|fly/.test(lower)) reply = "Sora makes wings up on Highfall. Take the Mist Lift, then ride the thermals down.";
  else if (/regatta/.test(lower)) reply = 'The Skim Regatta! Races, a wave heat, a design prize — and a party at the Lumen Club after.';
  else if (/new|life|up to|doing/.test(lower)) reply = m.currentLife;
  else reply = [p.currentLife, p.goals, p.backstory.split('.')[0] + '.'][m.history.length % 3];
  if (remember) {
    m.history.push({ role: 'user', text: said, ts: Date.now() }, { role: 'assistant', text: reply, ts: Date.now() });
    save();
  }
  return { reply, mood: 'warm', suggestions: OFFLINE_SUGGESTIONS[m.history.length % 3], ai: false };
}

/** Familiar first name ("Ama", "Odette", "Vex") rather than "Dr." or "Captain". */
function shortName(id: string) {
  return id[0].toUpperCase() + id.slice(1);
}

function offlineLife(day: number, hour: number): number {
  let n = 0;
  for (const p of PERSONAS) {
    const act = activityAt(p, hour);
    addLife({ npcId: p.id, day, hour, text: `${shortName(p.id)} — ${act.note}.`, involves: [] });
    n++;
  }
  return n;
}

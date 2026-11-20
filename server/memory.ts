// Durable villager memory: what each villager remembers about you, how they
// feel about you, and the running log of everything happening in their lives.

//
// Locally it lives in server/data/memory.json. On Vercel (a Blob store is connected, so
// BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN is set) it lives in a private blob: each request
// loads it fresh with loadMemory() and writes it back with flushMemory().

import { get, put } from '@vercel/blob';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from '../shared/npcs.js';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.SKIM_MEMORY_FILE ?? join(here, 'data', 'memory.json');
const BLOB_PATH = 'skimworld/memory.json';
export const USE_BLOB = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface NpcMemory {
  currentLife: string;
  facts: string[]; // about the player
  relationship: number; // -10..10
  history: Turn[];
  lastSeen: number;
}

export interface LifeEvent {
  npcId: string;
  day: number;
  hour: number;
  text: string;
  involves: string[];
  ts: number;
}

export interface WorldMemory {
  npcs: Record<string, NpcMemory>;
  life: LifeEvent[];
  lastTick: { day: number; hour: number } | null;
  /** Real time (ms) the last live life tick started; gates ticks across serverless instances. */
  lastTickAt?: number;
  /** Claude calls today (UTC), for the daily spend cap. */
  usage?: { day: string; calls: number };
  voice?: { day: string; lines: number; heard?: number }; // daily counts of voiced villager lines (TTS) and transcribed player lines (STT): spend guards
}

function fresh(): WorldMemory {
  const npcs: Record<string, NpcMemory> = {};
  for (const p of PERSONAS) npcs[p.id] = { currentLife: p.currentLife, facts: [], relationship: 0, history: [], lastSeen: 0 };
  return { npcs, life: [], lastTick: null };
}

function merge(loaded: WorldMemory): WorldMemory {
  return { ...fresh(), ...loaded, npcs: { ...fresh().npcs, ...loaded.npcs } };
}

let mem: WorldMemory = fresh();
let dirty = false;
if (!USE_BLOB) {
  try {
    mem = merge(JSON.parse(readFileSync(FILE, 'utf8')) as WorldMemory);
  } catch {
    /* first run */
  }
}

/** Serverless: pull the latest shared memory before handling a request. No-op locally. */
export async function loadMemory() {
  if (!USE_BLOB) return;
  const r = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (r?.statusCode === 200) mem = merge(JSON.parse(await new Response(r.stream).text()) as WorldMemory);
  dirty = false;
}

/** Serverless: write memory back if this request changed it. No-op locally (save() debounces to disk). */
export async function flushMemory() {
  if (!USE_BLOB || !dirty) return;
  dirty = false;
  await put(BLOB_PATH, JSON.stringify(mem), {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

let timer: NodeJS.Timeout | null = null;
export function save() {
  dirty = true;
  if (USE_BLOB || timer) return;
  timer = setTimeout(() => {
    timer = null;
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(mem, null, 1));
  }, 500);
}

export function memory(): WorldMemory {
  return mem;
}

export function npcMemory(id: string): NpcMemory {
  return mem.npcs[id];
}

export function addLife(e: Omit<LifeEvent, 'ts'>) {
  mem.life.push({ ...e, ts: Date.now() });
  if (mem.life.length > 300) mem.life.splice(0, mem.life.length - 300);
  save();
}

export function lifeFor(id: string, n = 6): LifeEvent[] {
  return mem.life.filter((e) => e.npcId === id || e.involves.includes(id)).slice(-n);
}

export function gossipFor(id: string, n = 5): LifeEvent[] {
  const p = PERSONAS.find((x) => x.id === id)!;
  const friends = new Set(Object.keys(p.relationships));
  return mem.life.filter((e) => e.npcId !== id && (friends.has(e.npcId) || e.involves.some((i) => friends.has(i)))).slice(-n);
}

export function resetMemory() {
  // Keep a backup: a reset can't be undone otherwise.
  if (!USE_BLOB) {
    try {
      writeFileSync(FILE.replace(/\.json$/, `.backup-${Date.now()}.json`), JSON.stringify(mem, null, 1));
    } catch {
      /* nothing to back up */
    }
  }
  mem = fresh();
  save();
}

// Skimworld's ground truth: terrain, the everywhere-film of water, waves, wind,
// thermals and flowing chutes. Pure functions of (x, z, t) so physics, NPCs and
// meshing all agree. The wave function is mirrored in GLSL (src/render/ground.ts)
// — keep them in sync (tests/world.test.ts checks the JS side).

import { fbm, lerp, noise2, smoothstep } from './noise.js';

export const FILM = 0.035; // metres of water over sand, everywhere
export const SEA_LEVEL = 0; // global water table: anything lower fills to here
export const GRAVITY = 9.81;

export type RegionId = 'tidewell' | 'saltglass' | 'brinehook' | 'highfall' | 'glowmarsh';

export interface RegionDef {
  id: RegionId;
  name: string;
  x: number;
  z: number;
  radius: number;
  tagline: string;
}

export const REGIONS: RegionDef[] = [
  { id: 'tidewell', name: 'Tidewell', x: 0, z: 0, radius: 230, tagline: 'Lagoon village on bamboo stilts' },
  { id: 'saltglass', name: 'Saltglass Flats', x: 950, z: -150, radius: 420, tagline: 'Mirror flats — wind country' },
  { id: 'brinehook', name: 'Brinehook', x: -250, z: 860, radius: 300, tagline: 'Surf shacks on the wave coast' },
  { id: 'highfall', name: 'Highfall Mesa', x: -900, z: -550, radius: 300, tagline: 'Waterfalls, updrafts and wings' },
  { id: 'glowmarsh', name: 'Glowmarsh', x: 700, z: 780, radius: 320, tagline: 'Neon shallows that never quite see day' },
];

export const SPAWN = { x: 18, z: 128, heading: Math.PI }; // facing the lagoon

export function regionById(id: RegionId): RegionDef {
  return REGIONS.find((r) => r.id === id)!;
}

/** Soft membership weights (0..1) of each region at a point. */
export function regionWeights(x: number, z: number): Record<RegionId, number> {
  const out = {} as Record<RegionId, number>;
  for (const r of REGIONS) {
    const d = Math.hypot(x - r.x, z - r.z);
    out[r.id] = smoothstep(r.radius * 1.5, r.radius * 0.7, d);
  }
  return out;
}

export function nearestRegion(x: number, z: number): RegionDef {
  let best = REGIONS[0];
  let bd = Infinity;
  for (const r of REGIONS) {
    const d = Math.hypot(x - r.x, z - r.z) / r.radius;
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Terrain features

export interface Kicker {
  x: number;
  z: number;
  dir: number; // travel direction (radians, forward = (sin, cos))
  len: number;
  height: number;
  width: number;
}

export const KICKERS: Kicker[] = [
  { x: 60, z: 150, dir: 0, len: 9, height: 1.4, width: 4 },
  { x: -150, z: 40, dir: -Math.PI / 2, len: 8, height: 1.2, width: 4 },
  { x: 150, z: -90, dir: 2.2, len: 10, height: 1.8, width: 4.5 },
  { x: 0, z: -175, dir: Math.PI, len: 14, height: 2.6, width: 6 },
  { x: 820, z: -40, dir: Math.PI / 2, len: 12, height: 2.2, width: 5 },
  { x: 1060, z: -260, dir: -Math.PI / 2, len: 12, height: 2.0, width: 5 },
  { x: -170, z: 760, dir: 0, len: 9, height: 1.5, width: 4 },
  { x: 620, z: 680, dir: 0.8, len: 10, height: 1.6, width: 4 },
];

function kicker(x: number, z: number, k: Kicker): number {
  const dx = x - k.x;
  const dz = z - k.z;
  const fx = Math.sin(k.dir);
  const fz = Math.cos(k.dir);
  const u = dx * fx + dz * fz;
  if (u < 0 || u > k.len + 2.5) return 0;
  const v = Math.abs(dx * fz - dz * fx);
  if (v > k.width) return 0;
  const lateral = smoothstep(k.width, k.width * 0.6, v);
  const rise = u <= k.len ? Math.pow(u / k.len, 1.6) : 1 - (u - k.len) / 2.5;
  return k.height * rise * lateral;
}

export const MESA = { x: -900, z: -550, r: 190, h: 38 };
export const CHUTE_ANGLES = [0.55, 2.7, -2.0];

export interface MesaInfo {
  d: number;
  ang: number;
  chute: number;
  rEdge: number;
  width: number;
}

export function mesaInfo(x: number, z: number): MesaInfo {
  const dx = x - MESA.x;
  const dz = z - MESA.z;
  const d = Math.hypot(dx, dz);
  const ang = Math.atan2(dz, dx);
  let chute = 0;
  for (const a of CHUTE_ANGLES) chute = Math.max(chute, smoothstep(0.965, 0.995, Math.cos(ang - a)));
  const rEdge = MESA.r + (noise2(Math.cos(ang) * 2.2 + 5, Math.sin(ang) * 2.2 + 5) - 0.5) * 40;
  const width = lerp(9, 200, chute);
  return { d, ang, chute, rEdge, width };
}

function mesa(x: number, z: number): number {
  const dx = x - MESA.x;
  const dz = z - MESA.z;
  if (dx * dx + dz * dz > (MESA.r + 300) ** 2) return 0;
  const m = mesaInfo(x, z);
  let h = MESA.h * smoothstep(m.rEdge + m.width, m.rEdge, m.d);
  h += smoothstep(m.rEdge, m.rEdge - 30, m.d) * (noise2(x * 0.03, z * 0.03) - 0.5) * 1.5;
  const base = m.rEdge + m.width;
  const moat = smoothstep(base, base + 8, m.d) * smoothstep(base + 45, base + 25, m.d) * (1 - m.chute);
  h -= moat * 2.2;
  return h;
}

/** Sand height (without water). */
export function terrainHeight(x: number, z: number): number {
  let h = 0.55 + (fbm(x * 0.0035 + 3.1, z * 0.0035 - 7.3, 4) - 0.5) * 3.4;
  h += (noise2(x * 0.045, z * 0.045) - 0.5) * 0.25;

  // Tidewell: flattened shelf around a deep lagoon, ringed by pump rollers.
  const dT = Math.hypot(x, z);
  if (dT < 520) {
    h = lerp(h, 0.25, smoothstep(210, 120, dT));
    h -= 1.0 * smoothstep(82, 45, dT);
    const roll = smoothstep(220, 260, dT) * smoothstep(480, 430, dT);
    h += roll * (1.1 + 0.9 * Math.sin(dT / 6.5));
  }

  for (const k of KICKERS) {
    if (Math.abs(x - k.x) < k.len + 8 && Math.abs(z - k.z) < k.len + 8) h += kicker(x, z, k);
  }

  // Saltglass: dead-flat salt pan -> perfect mirror.
  const dS = Math.hypot(x - 950, z + 150);
  if (dS < 440) h = lerp(h, 0.12, smoothstep(440, 320, dS));

  // Glowmarsh: islands and meandering channels.
  const dG = Math.hypot(x - 700, z - 780);
  if (dG < 340) {
    const gm = smoothstep(340, 240, dG);
    const n = noise2(x * 0.011 + 40, z * 0.011 - 12);
    const channel = smoothstep(0.07, 0, Math.abs(n - 0.5));
    h = lerp(h, 0.2 - channel * 1.15 + (noise2(x * 0.05, z * 0.05) - 0.5) * 0.4, gm);
  }

  // Brinehook beach shelves gently into the sea.
  const seaX = 1 - smoothstep(380, 650, Math.abs(x + 250));
  if (z > 700) {
    h = lerp(h, 0.45, smoothstep(700, 800, z) * seaX);
    h = lerp(h, -2.6, smoothstep(930, 1080, z) * seaX);
  }

  h += mesa(x, z);
  return h;
}

// ---------------------------------------------------------------------------
// Water

export const WAVE = { length: 42, speed: 6.2 };

export function seaMask(x: number, z: number): number {
  return smoothstep(860, 960, z) * (1 - smoothstep(380, 650, Math.abs(x + 250)));
}

/** Sea surface elevation above SEA_LEVEL (0 outside the sea). Mirrored in GLSL. */
export function waveHeight(x: number, z: number, t: number): number {
  const m = seaMask(x, z);
  if (m <= 0) return 0;
  const phase = (2 * Math.PI * (z + WAVE.speed * t)) / WAVE.length + 0.25 * Math.sin(x * 0.013);
  const s = 0.5 + 0.5 * Math.sin(phase);
  const crest = s * s * s * s;
  const amp = (0.5 + 1.2 * smoothstep(1250, 1030, z)) * smoothstep(900, 980, z);
  return m * amp * (crest * 2.2 - 0.35);
}

export interface Surface {
  y: number; // where a board rides
  ground: number; // sand height
  depth: number; // water depth over sand
}

export function surfaceAt(x: number, z: number, t: number, out?: Surface): Surface {
  const g = terrainHeight(x, z);
  const water = Math.max(g + FILM, SEA_LEVEL + waveHeight(x, z, t));
  const s = out ?? { y: 0, ground: 0, depth: 0 };
  s.y = water;
  s.ground = g;
  s.depth = water - g;
  return s;
}

export function surfaceY(x: number, z: number, t: number): number {
  return Math.max(terrainHeight(x, z) + FILM, SEA_LEVEL + waveHeight(x, z, t));
}

/** Gradient of the riding surface (dy/dx, dy/dz). */
export function surfaceGrad(x: number, z: number, t: number, out = { x: 0, z: 0 }) {
  const e = 0.35;
  out.x = (surfaceY(x + e, z, t) - surfaceY(x - e, z, t)) / (2 * e);
  out.z = (surfaceY(x, z + e, t) - surfaceY(x, z - e, t)) / (2 * e);
  return out;
}

// ---------------------------------------------------------------------------
// Air

export const SALTGLASS_WIND_DIR = (() => {
  const x = -0.97;
  const z = 0.24;
  const l = Math.hypot(x, z);
  return { x: x / l, z: z / l };
})();

export function windAt(x: number, z: number, t: number, out = { x: 0, z: 0 }) {
  const bx = -0.6 * 2.5;
  const bz = 0.8 * 2.5;
  const dS = Math.hypot(x - 950, z + 150);
  const m = smoothstep(500, 330, dS);
  const gust = 1 + 0.22 * Math.sin(t * 0.6 + x * 0.008) + 0.1 * Math.sin(t * 1.7 + z * 0.02);
  const sx = SALTGLASS_WIND_DIR.x * 14 * gust;
  const sz = SALTGLASS_WIND_DIR.z * 14 * gust;
  out.x = lerp(bx, sx, m);
  out.z = lerp(bz, sz, m);
  return out;
}

export const THERMALS: Array<{ x: number; z: number; r: number; lift: number }> = [
  { x: -640, z: -390, r: 30, lift: 8 },
  { x: -520, z: -300, r: 28, lift: 7 },
  { x: -380, z: -200, r: 30, lift: 7 },
  { x: -760, z: -290, r: 26, lift: 8 },
  { x: -1060, z: -330, r: 28, lift: 7 },
  { x: -700, z: -720, r: 28, lift: 7.5 },
  { x: -250, z: -110, r: 32, lift: 6.5 },
];

export function thermalAt(x: number, z: number): number {
  let lift = 0;
  for (const th of THERMALS) {
    const dx = x - th.x;
    const dz = z - th.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 9 * th.r * th.r) lift += th.lift * Math.exp(-d2 / (2 * th.r * th.r));
  }
  return lift;
}

/** Push from water running down the mesa chutes (m/s^2). */
export function flowAt(x: number, z: number, out = { x: 0, z: 0 }) {
  out.x = 0;
  out.z = 0;
  const dx = x - MESA.x;
  const dz = z - MESA.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > (MESA.r + 260) ** 2 || d2 < (MESA.r - 40) ** 2) return out;
  const m = mesaInfo(x, z);
  if (m.chute <= 0) return out;
  const along = smoothstep(m.rEdge - 4, m.rEdge + 6, m.d) * smoothstep(m.rEdge + m.width + 10, m.rEdge + m.width - 20, m.d);
  const k = 1.6 * m.chute * along;
  out.x = (dx / m.d) * k;
  out.z = (dz / m.d) * k;
  return out;
}

/** The Mist Lift: a waterwheel elevator from the plain up onto Highfall Mesa. */
export const LIFT = {
  base: { x: -879, z: -245 },
  top: { x: -888, z: -392 },
  radius: 5,
};

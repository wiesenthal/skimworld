// Village layouts: every building stands on stilts above the film.
// Shared so NPC schedules (client) and NPC prompts (server) name the same places.

import { surfaceY, terrainHeight, type RegionId } from './world.js';

export type BuildingRole = 'home' | 'shop' | 'cafe' | 'workshop' | 'tower' | 'dock' | 'club' | 'clinic' | 'shrine' | 'hut';

export interface Building {
  id: string;
  name: string;
  region: RegionId;
  role: BuildingRole;
  x: number;
  z: number;
  rot: number;
  w: number;
  d: number;
  stilt: number; // deck height above the water
  floors: number;
}

const b = (
  id: string,
  name: string,
  region: RegionId,
  role: BuildingRole,
  x: number,
  z: number,
  opts: Partial<Pick<Building, 'rot' | 'w' | 'd' | 'stilt' | 'floors'>> = {},
): Building => ({
  id,
  name,
  region,
  role,
  x,
  z,
  rot: opts.rot ?? Math.atan2(-x, -z),
  w: opts.w ?? 8,
  d: opts.d ?? 7,
  stilt: opts.stilt ?? 3,
  floors: opts.floors ?? 1,
});

export const BUILDINGS: Building[] = [
  // Tidewell — tropical lagoon, bamboo + thatch
  b('tidewell.cafe', 'The Stilt Cup (café)', 'tidewell', 'cafe', 0, 0, { w: 11, d: 11, stilt: 3.6, rot: 0.3 }),
  b('tidewell.boards', 'Driftline Boards (board shaping shed)', 'tidewell', 'workshop', 66, 32, { w: 10, d: 8 }),
  b('tidewell.okafor', 'Okafor house', 'tidewell', 'home', 72, -28),
  b('tidewell.tomas', "Tomas's house", 'tidewell', 'home', -58, 54),
  b('tidewell.felix', "Felix's house", 'tidewell', 'home', -74, -18),
  b('tidewell.tower', 'Lagoon lookout tower', 'tidewell', 'tower', -22, -90, { w: 5, d: 5, stilt: 9, floors: 1 }),
  b('tidewell.dock', 'Tidewell skimboat dock', 'tidewell', 'dock', 4, 122, { w: 14, d: 6, stilt: 1.2, rot: 0 }),
  b('tidewell.hut1', 'Guest hut', 'tidewell', 'hut', 34, -74),
  b('tidewell.hut2', 'Net-mender hut', 'tidewell', 'hut', -44, -64),
  b('tidewell.hut3', 'Shell hut', 'tidewell', 'hut', 42, 80),
  b('tidewell.hut4', 'Rope hut', 'tidewell', 'hut', -88, 22),

  // Saltglass — white pavilions on steel stilts over the mirror
  b('saltglass.loft', "June's Sail Loft", 'saltglass', 'shop', 930, -118, { w: 12, d: 9, stilt: 4, floors: 2, rot: 1.3 }),
  b('saltglass.june', "June's flat", 'saltglass', 'home', 905, -160, { rot: 1.3 }),
  b('saltglass.ren', "Ren's cabin", 'saltglass', 'home', 1010, -110, { rot: 1.3 }),
  b('saltglass.mills', 'Turbine yard control hut', 'saltglass', 'workshop', 1020, -205, { w: 7, d: 6, stilt: 5, rot: 1.3 }),
  b('saltglass.station', 'Weather station', 'saltglass', 'tower', 970, -60, { w: 5, d: 5, stilt: 10, rot: 1.3 }),
  b('saltglass.dock', 'Saltglass skimboat dock', 'saltglass', 'dock', 862, -40, { w: 14, d: 6, stilt: 1.2, rot: 1.57 }),
  b('saltglass.p1', 'Salt-cutter pavilion', 'saltglass', 'hut', 960, -230, { rot: 1.3 }),
  b('saltglass.p2', 'Glass pavilion', 'saltglass', 'hut', 880, -220, { rot: 1.3 }),

  // Brinehook — driftwood surf shacks on the beach
  b('brinehook.shack', "Kip's Surf Shack", 'brinehook', 'shop', -232, 884, { w: 10, d: 8, stilt: 2.6, rot: Math.PI }),
  b('brinehook.kip', "Kip's place", 'brinehook', 'home', -290, 860, { rot: Math.PI }),
  b('brinehook.tower', 'Lifeguard tower', 'brinehook', 'tower', -150, 912, { w: 4, d: 4, stilt: 6, rot: Math.PI }),
  b('brinehook.nalu', "Nalu's bunk", 'brinehook', 'home', -110, 860, { rot: Math.PI }),
  b('brinehook.clinic', "Ama's Clinic", 'brinehook', 'clinic', -340, 846, { w: 9, d: 8, rot: Math.PI }),
  b('brinehook.dock', 'Brinehook skimboat dock', 'brinehook', 'dock', -360, 770, { w: 14, d: 6, stilt: 1.2, rot: 0.6 }),
  b('brinehook.s1', 'Board rack shed', 'brinehook', 'hut', -190, 850, { rot: Math.PI }),
  b('brinehook.s2', 'Fish smokehouse', 'brinehook', 'hut', -400, 880, { rot: Math.PI }),

  // Highfall — lacquered pagodas on the mesa
  b('highfall.tea', "Hollis's Mist Tea House", 'highfall', 'cafe', -880, -520, { w: 11, d: 9, stilt: 2.5, floors: 2 }),
  b('highfall.wings', "Sora's Wing Loft", 'highfall', 'shop', -940, -585, { w: 10, d: 9, stilt: 3, floors: 2 }),
  b('highfall.sora', "Sora's house", 'highfall', 'home', -980, -510),
  b('highfall.hollis', "Hollis's house", 'highfall', 'home', -850, -600),
  b('highfall.launch', 'Glide launch shrine', 'highfall', 'shrine', -770, -470, { w: 6, d: 6, stilt: 2, rot: -2.1 }),
  b('highfall.h1', 'Mist-keeper hut', 'highfall', 'hut', -1000, -620),

  // Glowmarsh — neon-trimmed shells over dark channels
  b('glowmarsh.club', 'Lumen Club', 'glowmarsh', 'club', 700, 780, { w: 14, d: 12, stilt: 3.5, floors: 2 }),
  b('glowmarsh.vex', "Vex's loft", 'glowmarsh', 'home', 748, 820),
  b('glowmarsh.market', "Bao's Trading Post", 'glowmarsh', 'shop', 652, 742, { w: 10, d: 8 }),
  b('glowmarsh.bao', "Bao's houseboat-on-stilts", 'glowmarsh', 'home', 610, 790),
  b('glowmarsh.dock', 'Glowmarsh skimboat dock', 'glowmarsh', 'dock', 640, 655, { w: 14, d: 6, stilt: 1.2, rot: 0.4 }),
  b('glowmarsh.m1', 'Mushroom hut', 'glowmarsh', 'hut', 760, 730),
  b('glowmarsh.m2', 'Lantern hut', 'glowmarsh', 'hut', 690, 860),
];

export const BOARDWALKS: Array<[string, string]> = [
  ['tidewell.cafe', 'tidewell.boards'],
  ['tidewell.cafe', 'tidewell.tomas'],
  ['tidewell.cafe', 'tidewell.felix'],
  ['tidewell.boards', 'tidewell.okafor'],
  ['saltglass.loft', 'saltglass.june'],
  ['saltglass.loft', 'saltglass.station'],
  ['brinehook.shack', 'brinehook.kip'],
  ['brinehook.kip', 'brinehook.clinic'],
  ['highfall.tea', 'highfall.wings'],
  ['highfall.tea', 'highfall.hollis'],
  ['glowmarsh.club', 'glowmarsh.vex'],
  ['glowmarsh.club', 'glowmarsh.market'],
  ['glowmarsh.market', 'glowmarsh.bao'],
];

export function building(id: string): Building {
  const found = BUILDINGS.find((x) => x.id === id);
  if (!found) throw new Error(`Unknown building ${id}`);
  return found;
}

/** Ground-level spot just in front of a building's ladder. */
export function doorstep(bd: Building): { x: number; z: number } {
  const fx = Math.sin(bd.rot);
  const fz = Math.cos(bd.rot);
  const off = bd.d / 2 + 2.2;
  return { x: bd.x + fx * off, z: bd.z + fz * off };
}

// ------------------------------------------------------------------ decks & ladders
// Mirrors buildBuilding() in src/render/villages.ts: deck = (w + 1.6) x (d + 1.6) at
// surfaceY + stilt, ladder centred at local (w/2 - 0.4, d/2 + 1.0), just outside the front edge.

/** World height of a building's deck. */
export function deckY(bd: Building): number {
  return surfaceY(bd.x, bd.z, 0) + bd.stilt;
}

const toWorld = (bd: Building, lx: number, lz: number) => {
  const c = Math.cos(bd.rot);
  const s = Math.sin(bd.rot);
  return { x: bd.x + lx * c + lz * s, z: bd.z - lx * s + lz * c };
};

export interface Ladder {
  id: string; // building id
  /** Where you stand to climb: in front of the rungs, on the ground side. */
  x: number;
  z: number;
  /** Outward normal (away from the deck). Climbers face -n. */
  nx: number;
  nz: number;
  /** The rails themselves, for "is my hand on the ladder". */
  railX: number;
  railZ: number;
  bottomY: number;
  topY: number;
  /** Step-off point on the deck at the top. */
  topX: number;
  topZ: number;
}

export const LADDERS: Ladder[] = BUILDINGS.map((bd) => {
  const lx = bd.w / 2 - 0.4;
  const rail = toWorld(bd, lx, bd.d / 2 + 1.0);
  const stand = toWorld(bd, lx, bd.d / 2 + 1.45);
  const top = toWorld(bd, lx, bd.d / 2 + 0.2);
  return {
    id: bd.id,
    x: stand.x,
    z: stand.z,
    nx: Math.sin(bd.rot),
    nz: Math.cos(bd.rot),
    railX: rail.x,
    railZ: rail.z,
    bottomY: Math.max(terrainHeight(stand.x, stand.z), surfaceY(stand.x, stand.z, 0)),
    topY: deckY(bd),
    topX: top.x,
    topZ: top.z,
  };
});

/** The building deck under (x, z), if any. */
export function deckAt(x: number, z: number): { bd: Building; y: number } | null {
  for (const bd of BUILDINGS) {
    const dx = x - bd.x;
    const dz = z - bd.z;
    if (dx * dx + dz * dz > (bd.w + bd.d + 4) ** 2) continue;
    const c = Math.cos(bd.rot);
    const s = Math.sin(bd.rot);
    const lx = c * dx - s * dz;
    const lz = s * dx + c * dz;
    if (Math.abs(lx) <= (bd.w + 1.6) / 2 && Math.abs(lz) <= (bd.d + 1.6) / 2) return { bd, y: deckY(bd) };
  }
  return null;
}

/** Pickups that unlock gear. */
export const GEAR_SPOTS = {
  sail: { x: 918, z: -96, building: 'saltglass.loft' },
  wing: { x: -925, z: -560, building: 'highfall.wings' },
};

// Ladder climbing onto the stilt-house decks. Pure logic (no three.js) so it can be tested.
//
// Start: walk into a ladder from below, or walk off the deck's ladder edge from above.
// In VR you can also just grab it: squeeze grip with a hand on the rails.
// While climbing: stick / W-S moves you along it, and in VR pulling a gripped hand down
// lifts you by the same amount (hand-over-hand). Jump lets go.
import { LADDERS, type Ladder } from '../../shared/villages';

export const CLIMB_SPEED = 1.8; // m/s with the stick held fully
export const RUNG = 0.4; // matches the rung spacing drawn in render/villages.ts
const REACH = 1.0; // how close you must be to the ladder's foot / top to start
const INTO = 0.6; // m/s of walking toward the ladder that counts as "walking into it"

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ClimbState {
  ladder: Ladder;
  y: number;
  /** +1 started from the bottom, -1 from the deck: desktop "forward" keeps going that way. */
  dir: 1 | -1;
  rung: number;
}

/** A hand counts as on the ladder when it's at the rails, between the foot and just above the deck. */
export function handOnRails(h: Vec3, L: Ladder): boolean {
  return Math.hypot(h.x - L.railX, h.z - L.railZ) < 0.55 && h.y > L.bottomY - 0.2 && h.y < L.topY + 1.2;
}

/**
 * The ladder to start climbing, if any.
 * @param onDeckId building id of the deck you're standing on (null if none)
 * @param grabbing world positions of hands that are squeezing grip (VR)
 */
export function ladderToClimb(p: Vec3, vx: number, vz: number, onDeckId: string | null, grabbing: Vec3[] = []): { ladder: Ladder; dir: 1 | -1 } | null {
  for (const L of LADDERS) {
    if ((p.x - L.x) ** 2 + (p.z - L.z) ** 2 > 36) continue;
    if (onDeckId === L.id) {
      if (Math.hypot(p.x - L.topX, p.z - L.topZ) > REACH) continue;
      const outward = vx * L.nx + vz * L.nz;
      if (outward > INTO || grabbing.some((h) => handOnRails(h, L))) return { ladder: L, dir: -1 };
    } else if (p.y < L.topY - 0.8) {
      if (Math.hypot(p.x - L.x, p.z - L.z) > REACH) continue;
      const toward = -(vx * L.nx + vz * L.nz);
      if (toward > INTO || grabbing.some((h) => handOnRails(h, L))) return { ladder: L, dir: 1 };
    }
  }
  return null;
}

export function startClimb(ladder: Ladder, dir: 1 | -1): ClimbState {
  const y = dir > 0 ? ladder.bottomY + 0.1 : ladder.topY - 0.1;
  return { ladder, y, dir, rung: rungOf(ladder, y) };
}

const rungOf = (L: Ladder, y: number) => Math.floor((y - L.bottomY) / RUNG);

/**
 * Advance a climb. `up` is -1..1 (stick), `pull` is metres to rise this frame (VR hand-over-hand).
 * Returns where you ended up and whether you passed a rung (for a haptic tick).
 */
export function stepClimb(st: ClimbState, dt: number, up: number, pull: number): { at: 'ladder' | 'top' | 'bottom'; rung: boolean } {
  const L = st.ladder;
  st.y += up * CLIMB_SPEED * dt + Math.max(-0.3, Math.min(0.3, pull));
  if (st.y >= L.topY) {
    st.y = L.topY;
    return { at: 'top', rung: true };
  }
  if (st.y <= L.bottomY) {
    st.y = L.bottomY;
    return { at: 'bottom', rung: true };
  }
  const r = rungOf(L, st.y);
  const passed = r !== st.rung;
  st.rung = r;
  return { at: 'ladder', rung: passed };
}

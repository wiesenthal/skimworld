// Skimboard physics. Renderer-agnostic, used by the player AND every NPC.
//
// The loop that makes skimming feel like skimming:
//   run  ->  throw the board ahead  ->  hop so you land on it as it slides
//   (land clean = PERFECT DROP, a burst of speed)  ->  plane on the film
//   ->  pump the rollers (crouch on the up-slope, extend on the down-slope)
//   ->  carve (lean; too hard and the rail skids, spraying and scrubbing speed)
//   ->  pop off kickers / wave lips, spin, absorb the landing (STOMP)
//   ->  hop OFF the board (drop while riding), KICK it forward mid-air (drop again,
//       late in the hop) and land back on it: another drop boost. Chained, that
//       builds scary speed (it tapers, never caps). No kick = sloppy, slower.
//   ->  or hop first and toss the board down under you mid-air
// Flow builds as you chain clean moves and makes the board run freer.

import { clamp, lerp, wrapAngle } from '../../shared/noise';
import { flowAt, GRAVITY as G, surfaceAt, surfaceGrad, surfaceY, thermalAt, windAt } from '../../shared/world';

export type Mode = 'foot' | 'board' | 'air' | 'wipeout';

export interface SkimInput {
  moveX: number; // strafe (-1 left .. 1 right), on foot
  moveY: number; // forward (-1..1), on foot
  viewYaw: number; // locomotion reference yaw (forward = (sin, cos))
  run: number; // 0..1 sprint effort (arm swing in VR)
  lean: number; // -1..1, +1 = carve right
  crouch: number; // 0..1
  jump: boolean; // edge
  drop: boolean; // edge: throw board (also mid-hop) / hop off or kick out / pick up
  spin: number; // -1..1 in the air
  sail: boolean; // edge: deploy / stow sail
  sailTrim: number | null; // sail normal angle relative to heading; null = auto
  sailTrimOffset: number; // radians added to auto trim
  wing: boolean; // held: deploy glide wing while airborne
  pitch: number; // -1..1 glide pitch (+ nose up)
}

export const emptyInput = (): SkimInput => ({
  moveX: 0,
  moveY: 0,
  viewYaw: 0,
  run: 0,
  lean: 0,
  crouch: 0,
  jump: false,
  drop: false,
  spin: 0,
  sail: false,
  sailTrim: null,
  sailTrimOffset: 0,
  wing: false,
  pitch: 0,
});

export type SkimEventType =
  | 'throw'
  | 'perfect-drop'
  | 'good-drop'
  | 'sloppy-drop'
  | 'pump'
  | 'mispump'
  | 'ollie'
  | 'launch'
  | 'land'
  | 'stomp'
  | 'trick'
  | 'switch'
  | 'wipeout'
  | 'bog'
  | 'pickup'
  | 'splash'
  | 'step'
  | 'glide'
  | 'aboard'
  | 'sail';

export interface SkimEvent {
  type: SkimEventType;
  text?: string;
  value: number;
  x: number;
  z: number;
}

export interface Platform {
  id: string;
  y: number; // deck height
  vx: number;
  vz: number;
  yawRate: number;
  cx: number;
  cz: number;
  /** false for fixed decks (stilt houses): riding under one must not "hop aboard" it like a boat. */
  boardable?: boolean;
}

export type PlatformQuery = (x: number, z: number) => Platform | null;

export interface ThrownBoard {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  moving: boolean;
  /** Left under you by a hop-off and not kicked yet: landing on it is sloppy. */
  loose: boolean;
  /** Kicked ahead of you: your boost is based on your own speed, not the kick's. */
  kicked: boolean;
}

const CROUCH_DEPTH = 0.45; // metres of leg travel between standing and full crouch
export const KICK_OUT_BELOW = 5; // m/s: slower than this, drop while riding grabs the board; faster, you hop off it
const MISS_TUMBLE = 11;
/** m/s a kick sends the loose board ahead of you. Kick in the last ~0.15 s of the hop, or it's gone. */
export const KICK = 6; // m/s: missing the board and landing on your feet faster than this wipes you out

/** How much of a drop's speed bonus you keep at a given speed (1 at running pace, ~1/3 at 40 m/s). */
export const dropTaper = (sp: number) => 1 / (1 + (sp / 28) ** 2);

export class Skimmer {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  mode: Mode = 'foot';
  riding = false; // true while the board is under your feet (board or air)
  hasBoard = true; // carrying it
  board: ThrownBoard = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, moving: false, loose: false, kicked: false };

  crouch = 0;
  extend = 0; // m/s leg extension rate (+ standing up)
  charge = 0;
  flow = 0;
  time = 0;
  airTime = 0;
  spinAccum = 0;
  boardYaw = 0; // board spin relative to body while airborne
  skid = 0;
  carve = 0; // signed turn rate (rad/s) while riding, + = right
  depth = 0;
  slopeAlong = 0;
  pumpA = 0;

  hasSail = false;
  hasWing = false;
  sailOut = false;
  sailAngle = 0; // world angle of the sail normal
  sailEff = 0;
  gliding = false;

  platform: Platform | null = null;
  events: SkimEvent[] = [];

  private lastJump = -10;
  private lastPump = -10;
  private pumpGood = 0;
  private pumpBad = 0;
  private stepTimer = 0;
  private wipeTimer = 0;
  private bogged = false;
  private airPeakFall = 0;
  private grad = { x: 0, z: 0 };
  private tmp = { x: 0, z: 0 };
  private surf = { y: 0, ground: 0, depth: 0 };

  constructor(public skill = 1) {}

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  place(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.y = surfaceY(x, z, this.time);
    this.vx = this.vy = this.vz = 0;
    this.heading = heading;
    this.mode = 'foot';
    this.riding = false;
    this.hasBoard = true;
    this.board.active = false;
    this.gliding = false;
    this.platform = null;
  }

  private emit(type: SkimEventType, value = 1, text?: string) {
    this.events.push({ type, value, text, x: this.x, z: this.z });
  }

  update(dt: number, input: SkimInput, platformAt?: PlatformQuery) {
    dt = Math.min(dt, 0.05);
    // Crouch velocity drives pumping; charge lets you crouch, then pop.
    const raw = (-(input.crouch - this.crouch) / Math.max(dt, 1e-3)) * CROUCH_DEPTH;
    this.extend = lerp(this.extend, raw, 1 - Math.exp(-dt * 18));
    this.crouch = input.crouch;
    this.charge = Math.max(this.crouch, this.charge - dt * 1.4);

    if (input.sail && this.hasSail && this.mode !== 'wipeout') {
      this.sailOut = !this.sailOut;
      this.emit('sail', this.sailOut ? 1 : 0, this.sailOut ? 'Sail up' : 'Sail stowed');
    }

    const steps = Math.max(1, Math.ceil(dt / 0.0125));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const edge = i === 0;
      const inp = edge ? input : { ...input, jump: false, drop: false };
      this.time += h;
      switch (this.mode) {
        case 'foot':
          this.stepFoot(h, inp, platformAt);
          break;
        case 'board':
          this.stepBoard(h, inp, platformAt);
          break;
        case 'air':
          this.stepAir(h, inp, platformAt);
          break;
        case 'wipeout':
          this.stepWipeout(h);
          break;
      }
      this.stepThrownBoard(h, platformAt);
    }
    this.flow = clamp(this.flow - dt * (this.speed > 7 ? 0.012 : 0.04), 0, 1);
    if (this.y < -40) this.place(this.x, this.z, this.heading);
  }

  // ---------------------------------------------------------------- on foot
  private stepFoot(h: number, inp: SkimInput, platformAt?: PlatformQuery) {
    const s = surfaceAt(this.x, this.z, this.time, this.surf);
    this.depth = s.depth;
    const plat = platformAt?.(this.x, this.z) ?? null;
    this.platform = plat && Math.abs(this.y - plat.y) < 0.7 ? plat : null;
    const cvx = this.platform ? this.platform.vx : 0;
    const cvz = this.platform ? this.platform.vz : 0;

    const fx = Math.sin(inp.viewYaw);
    const fz = Math.cos(inp.viewYaw);
    const rx = -Math.cos(inp.viewYaw);
    const rz = Math.sin(inp.viewYaw);
    let dx = fx * inp.moveY + rx * inp.moveX;
    let dz = fz * inp.moveY + rz * inp.moveX;
    const mag = Math.min(1, Math.hypot(inp.moveX, inp.moveY));
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const wading = !this.platform && s.depth > 0.4;
    const maxSpeed = wading ? 2.2 : lerp(3.4, 8.2, clamp(inp.run, 0, 1));
    const tx = dx * maxSpeed * mag;
    const tz = dz * maxSpeed * mag;

    let rvx = this.vx - cvx;
    let rvz = this.vz - cvz;
    const ax = tx - rvx;
    const az = tz - rvz;
    const al = Math.hypot(ax, az);
    const accel = (mag > 0.05 ? 9 : 12) * h;
    if (al > accel) {
      rvx += (ax / al) * accel;
      rvz += (az / al) * accel;
    } else {
      rvx = tx;
      rvz = tz;
    }
    if (!this.platform) {
      surfaceGrad(this.x, this.z, this.time, this.grad);
      rvx -= this.grad.x * G * 0.25 * h;
      rvz -= this.grad.z * G * 0.25 * h;
    }
    this.vx = rvx + cvx;
    this.vz = rvz + cvz;
    const relSpeed = Math.hypot(rvx, rvz);
    if (relSpeed > 0.6) {
      const target = Math.atan2(rvx, rvz);
      this.heading += wrapAngle(target - this.heading) * Math.min(1, h * 10);
    }

    if (this.platform) {
      // ride the deck around its turning centre
      const yaw = this.platform.yawRate * h;
      const ox = this.x - this.platform.cx;
      const oz = this.z - this.platform.cz;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      this.x = this.platform.cx + ox * c + oz * sn;
      this.z = this.platform.cz - ox * sn + oz * c;
      this.heading += yaw;
    }
    this.x += this.vx * h;
    this.z += this.vz * h;

    const plat2 = platformAt?.(this.x, this.z) ?? null;
    const ground = plat2 && Math.abs(this.y - plat2.y) < 0.7 ? plat2.y : surfaceY(this.x, this.z, this.time);
    if (ground < this.y - 0.5) {
      this.mode = 'air';
      this.riding = false;
      this.vy = 0;
      this.airTime = 0;
    } else {
      this.y = ground;
      this.vy = 0;
    }

    this.stepTimer -= h * relSpeed;
    if (relSpeed > 1 && this.stepTimer <= 0) {
      this.stepTimer = 1.05;
      this.emit('step', relSpeed / 8);
    }

    if (inp.jump) {
      this.vy = 2.6;
      this.mode = 'air';
      this.riding = false;
      this.airTime = 0;
      this.lastJump = this.time;
    }

    if (inp.drop) {
      if (this.hasBoard) this.throwBoard(relSpeed);
      else if (this.board.active && this.distToBoard() < 2.6) this.pickUp();
    }

    const b = this.board;
    if (b.active && this.mode === 'foot') {
      const d = this.distToBoard();
      if (!b.moving && d < 1.0) this.pickUp();
      else if (b.moving && d < 0.75 && Math.abs(this.y - b.y) < 0.6) this.mountBoard('sloppy');
    }
  }

  private distToBoard() {
    return Math.hypot(this.x - this.board.x, this.z - this.board.z);
  }

  private throwBoard(relSpeed: number) {
    const b = this.board;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    this.hasBoard = false;
    if (relSpeed < 1.2 && !this.platform) {
      // standing start: drop it at your feet and step on
      b.active = true;
      b.x = this.x;
      b.z = this.z;
      b.y = this.y;
      b.vx = this.vx;
      b.vz = this.vz;
      b.vy = 0;
      b.heading = this.heading;
      b.moving = true;
      b.loose = false;
      b.kicked = false;
      this.mountBoard('sloppy', true);
      return;
    }
    // The board leaves your hands a touch slower than you run: you close the
    // gap, and the skill is hopping early enough to land on it mid-slide.
    const cvx = this.platform ? this.platform.vx : 0;
    const cvz = this.platform ? this.platform.vz : 0;
    b.active = true;
    b.moving = true;
    b.loose = false;
    b.kicked = false;
    b.x = this.x + fx * 1.2;
    b.z = this.z + fz * 1.2;
    b.y = this.y + 0.25;
    b.vx = cvx + (this.vx - cvx) * 0.92;
    b.vz = cvz + (this.vz - cvz) * 0.92;
    b.vy = this.platform ? 1.2 : 0;
    b.heading = this.heading;
    this.emit('throw', relSpeed);
  }

  /** Jump off a fast board and leave it sliding loose under you: kick it forward, then land on it. */
  private hopOff(sp: number) {
    const b = this.board;
    b.active = true;
    b.moving = true;
    b.loose = true;
    b.kicked = false;
    b.x = this.x;
    b.z = this.z;
    b.y = this.y;
    b.vx = this.vx;
    b.vz = this.vz;
    b.vy = 0;
    b.heading = this.heading;
    this.hasBoard = false;
    this.sailOut = false;
    this.vy = Math.max(this.vy, 0) + 2.6 + 0.8 * this.charge;
    this.mode = 'air';
    this.riding = false;
    this.airTime = 0;
    this.lastJump = this.time;
    this.emit('throw', sp, 'Kick it forward!');
  }

  /** Mid-hop with the board in hand: slam it down under you, matching your speed. */
  private tossUnder() {
    const b = this.board;
    const hs = this.speed;
    const ux = hs > 0.3 ? this.vx / hs : Math.sin(this.heading);
    const uz = hs > 0.3 ? this.vz / hs : Math.cos(this.heading);
    b.active = true;
    b.moving = true;
    b.loose = false;
    b.kicked = false;
    b.x = this.x + ux * 0.25;
    b.z = this.z + uz * 0.25;
    b.y = this.y - 0.3;
    b.vx = this.vx;
    b.vz = this.vz;
    b.vy = Math.min(this.vy, 0) - 4;
    b.heading = hs > 0.3 ? Math.atan2(ux, uz) : this.heading;
    this.hasBoard = false;
    this.emit('throw', hs, 'Tossed it under you');
  }

  /** Mid hop-off: kick the loose board out ahead of you. Too early and it's gone before you land. */
  private kickForward() {
    const b = this.board;
    const hs = this.speed;
    const ux = hs > 0.3 ? this.vx / hs : Math.sin(this.heading);
    const uz = hs > 0.3 ? this.vz / hs : Math.cos(this.heading);
    b.loose = false;
    b.kicked = true;
    b.x = this.x;
    b.z = this.z;
    b.vx = this.vx + ux * KICK;
    b.vz = this.vz + uz * KICK;
    b.heading = Math.atan2(ux, uz);
    this.emit('throw', hs, 'Kicked it');
  }

  private pickUp() {
    this.board.active = false;
    this.hasBoard = true;
    this.emit('pickup');
  }

  private mountBoard(quality: 'perfect' | 'good' | 'sloppy', quiet = false, sloppyText = 'Stepped on — hop it next time') {
    const b = this.board;
    const bs = Math.hypot(b.vx, b.vz);
    const ps = this.speed;
    const base = b.kicked ? ps : Math.max(bs, ps);
    const mult = quality === 'perfect' ? 1.2 + 0.08 * this.flow : quality === 'good' ? 1.06 : 0.86;
    // Each drop multiplies your speed, so hop-off / hop-on chains snowball. The gain
    // tapers (never stops) at highway speeds; drag then sets the top end (~40-50 m/s).
    const sp = base * (mult > 1 ? 1 + (mult - 1) * dropTaper(base) : mult);
    const dirx = bs > 0.3 ? b.vx / bs : Math.sin(b.heading);
    const dirz = bs > 0.3 ? b.vz / bs : Math.cos(b.heading);
    this.vx = dirx * sp;
    this.vz = dirz * sp;
    this.vy = 0;
    this.heading = b.heading;
    this.x = lerp(this.x, b.x, 0.6);
    this.z = lerp(this.z, b.z, 0.6);
    this.mode = 'board';
    this.riding = true;
    this.hasBoard = false;
    b.active = false;
    b.loose = false;
    b.kicked = false;
    this.bogged = false;
    this.boardYaw = 0;
    this.platform = null;
    if (quiet) return;
    if (quality === 'perfect') {
      this.flow = clamp(this.flow + 0.2, 0, 1);
      this.emit('perfect-drop', sp, 'PERFECT DROP');
    } else if (quality === 'good') {
      this.flow = clamp(this.flow + 0.08, 0, 1);
      this.emit('good-drop', sp, 'Clean drop');
    } else {
      this.emit('sloppy-drop', sp, sloppyText);
    }
  }

  private stepThrownBoard(h: number, platformAt?: PlatformQuery) {
    const b = this.board;
    if (!b.active) return;
    const plat = platformAt?.(b.x, b.z) ?? null;
    const ground = plat && b.y >= plat.y - 0.3 ? plat.y : surfaceY(b.x, b.z, this.time);
    b.vy -= G * h;
    b.x += b.vx * h;
    b.z += b.vz * h;
    b.y += b.vy * h;
    if (b.y <= ground) {
      b.y = ground;
      b.vy = 0;
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > 0.01) {
        surfaceGrad(b.x, b.z, this.time, this.tmp);
        b.vx -= this.tmp.x * G * 0.8 * h;
        b.vz -= this.tmp.z * G * 0.8 * h;
        const drag = sp > 1.4 ? 0.55 + 0.05 * sp : 2.6;
        const ns = Math.max(0, sp - drag * h);
        b.vx *= ns / sp;
        b.vz *= ns / sp;
      }
      b.moving = Math.hypot(b.vx, b.vz) > 0.3;
    }
  }

  // ---------------------------------------------------------------- riding
  private stepBoard(h: number, inp: SkimInput, platformAt?: PlatformQuery) {
    const s = surfaceAt(this.x, this.z, this.time, this.surf);
    this.depth = s.depth;
    const deep = s.depth > 0.3;
    const grad = surfaceGrad(this.x, this.z, this.time, this.grad);

    // Skimming into a skimboat hull: hop aboard.
    const plat = platformAt?.(this.x, this.z) ?? null;
    if (plat && plat.boardable !== false && this.y > plat.y - 1.8) {
      this.y = plat.y;
      this.mode = 'foot';
      this.riding = false;
      this.hasBoard = true;
      this.sailOut = false;
      this.platform = plat;
      this.emit('aboard', 1, 'All aboard!');
      return;
    }

    let sp = Math.hypot(this.vx, this.vz);
    // --- steering: lean turns the board, grip drags velocity after it
    const turnMax = 1.45 + 0.85 * this.crouch;
    const speedFactor = clamp(sp / 6, 0.35, 1.25);
    const turn = clamp(inp.lean, -1, 1) * turnMax * speedFactor;
    this.heading -= turn * h;
    this.carve = lerp(this.carve, turn, 1 - Math.exp(-h * 10));
    if (sp > 0.05) {
      const velAng = Math.atan2(this.vx, this.vz);
      const diff = wrapAngle(this.heading - velAng);
      const grip = (deep ? 2.6 : 4.3) * (0.75 + 0.35 * this.crouch) * this.skill;
      const rot = clamp(diff, -grip * h, grip * h);
      const na = velAng + rot;
      this.vx = Math.sin(na) * sp;
      this.vz = Math.cos(na) * sp;
      const residual = Math.abs(Math.sin(diff - rot));
      this.skid = lerp(this.skid, residual, 1 - Math.exp(-h * 12));
    }

    // --- forces
    const g2 = 1 + grad.x * grad.x + grad.z * grad.z;
    let ax = (-G * grad.x) / g2;
    let az = (-G * grad.z) / g2;
    const flow = flowAt(this.x, this.z, this.tmp);
    ax += flow.x;
    az += flow.z;
    if (this.sailOut) {
      const [sx, sz] = this.sailForce(inp);
      ax += sx;
      az += sz;
    } else this.sailEff = 0;
    this.vx += ax * h;
    this.vz += az * h;
    sp = Math.hypot(this.vx, this.vz);
    const dirx = sp > 0.01 ? this.vx / sp : Math.sin(this.heading);
    const dirz = sp > 0.01 ? this.vz / sp : Math.cos(this.heading);

    // --- pumping: extend into down-slopes, absorb up-slopes
    this.slopeAlong = -(grad.x * dirx + grad.z * dirz);
    this.pumpA = clamp(22 * this.extend * this.slopeAlong, -3, 5) * this.skill;
    if (this.pumpA > 0.35) this.pumpGood += h;
    else this.pumpGood = Math.max(0, this.pumpGood - h * 0.5);
    if (this.pumpA < -0.35) this.pumpBad += h;
    else this.pumpBad = Math.max(0, this.pumpBad - h * 0.5);
    if (this.pumpGood > 0.2 && this.time - this.lastPump > 0.6) {
      this.lastPump = this.time;
      this.pumpGood = 0;
      this.flow = clamp(this.flow + 0.05, 0, 1);
      this.emit('pump', this.pumpA, 'Pump!');
    }
    if (this.pumpBad > 0.3) {
      this.pumpBad = 0;
      this.flow = clamp(this.flow - 0.03, 0, 1);
      this.emit('mispump', this.pumpA);
    }

    // --- drag: planing vs bogging
    const vPlane = deep ? 3.6 : 1.5;
    let drag: number;
    if (sp > vPlane) {
      drag = (0.28 + 0.03 * sp + 0.0032 * sp * sp) * (1 - 0.25 * this.flow) * (deep ? 0.85 : 1);
      drag += this.skid * (1.4 + 0.3 * sp);
      this.bogged = false;
    } else {
      drag = deep ? 3.5 : 2.0;
      if (!this.bogged) {
        this.bogged = true;
        this.emit('bog', sp);
      }
    }
    const ns = Math.max(0, sp + this.pumpA * h - drag * h);
    if (sp > 1e-4) {
      this.vx *= ns / sp;
      this.vz *= ns / sp;
    }
    sp = ns;

    // --- stopped: step off
    const pull = Math.hypot(grad.x, grad.z);
    if (sp < 0.6 && pull < 0.05) {
      this.mode = 'foot';
      this.riding = false;
      this.hasBoard = true;
      this.sailOut = this.sailOut && !deep;
      if (deep) this.emit('splash', 0.6, 'Sank — skim faster over deep water');
      return;
    }

    // --- integrate along the surface; leave it when it falls away faster than gravity
    const nx = this.x + this.vx * h;
    const nz = this.z + this.vz * h;
    const ny = surfaceY(nx, nz, this.time);
    const ballistic = this.y + this.vy * h - 0.5 * G * h * h;
    this.x = nx;
    this.z = nz;
    if (ny < ballistic - 0.03) {
      this.vy -= G * h;
      this.y = ballistic;
      this.enterAir();
      if (this.vy > 1.2) this.emit('launch', this.vy);
    } else {
      this.vy = (ny - this.y) / h;
      this.y = ny;
    }

    if (inp.jump && this.mode === 'board') {
      const pop = (2.4 + 2.8 * this.charge + 0.03 * sp) * (1 + 0.1 * this.flow);
      this.vy = Math.max(this.vy, 0) + pop;
      this.enterAir();
      this.emit('ollie', pop);
    } else if (inp.drop && this.mode === 'board') {
      if (sp < KICK_OUT_BELOW) {
        // kick out: step off, board in hand
        this.mode = 'foot';
        this.riding = false;
        this.hasBoard = true;
        this.emit('pickup');
      } else this.hopOff(sp);
    }
  }

  private sailForce(inp: SkimInput): [number, number] {
    const w = windAt(this.x, this.z, this.time, this.tmp);
    const apx = w.x - this.vx;
    const apz = w.z - this.vz;
    const A = Math.hypot(apx, apz);
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    // optimal plate normal bisects the apparent wind and the direction of travel
    let bx = apx / (A || 1) + fx;
    let bz = apz / (A || 1) + fz;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl;
    bz /= bl;
    const optimal = Math.atan2(bx, bz);
    this.sailAngle = inp.sailTrim === null ? optimal + inp.sailTrimOffset : this.heading + inp.sailTrim;
    const nx = Math.sin(this.sailAngle);
    const nz = Math.cos(this.sailAngle);
    const k = 0.016;
    const press = k * A * (apx * nx + apz * nz);
    const Fx = press * nx;
    const Fz = press * nz;
    const fwd = Fx * fx + Fz * fz;
    const best = k * A * A * Math.pow(Math.cos(Math.acos(clamp((apx * fx + apz * fz) / (A || 1), -1, 1)) / 2), 2);
    this.sailEff = best > 0.05 ? clamp(fwd / best, -1, 1) : 0;
    // the board's rail resists most of the side force
    const side = 0.25;
    return [fx * fwd + (Fx - fx * fwd) * side, fz * fwd + (Fz - fz * fwd) * side];
  }

  private enterAir() {
    this.mode = 'air';
    this.riding = true;
    this.airTime = 0;
    this.spinAccum = 0;
    this.boardYaw = 0;
    this.airPeakFall = 0;
  }

  // ---------------------------------------------------------------- air
  private stepAir(h: number, inp: SkimInput, platformAt?: PlatformQuery) {
    this.airTime += h;
    if (inp.drop && !this.riding) {
      if (this.hasBoard) this.tossUnder();
      else if (this.board.active && this.board.loose) this.kickForward();
    }
    const wantWing = this.riding && this.hasWing && inp.wing && this.airTime > 0.15;
    if (wantWing && !this.gliding) this.emit('glide', 1, 'Wing out');
    this.gliding = wantWing;

    if (this.gliding) {
      const sp = Math.hypot(this.vx, this.vy, this.vz) || 0.01;
      const dx = this.vx / sp;
      const dy = this.vy / sp;
      const dz = this.vz / sp;
      let lx = -dx * dy;
      let ly = 1 - dy * dy;
      let lz = -dz * dy;
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx /= ll;
      ly /= ll;
      lz /= ll;
      const pitch = clamp(inp.pitch, -1, 1);
      const cl = 0.9 + 0.5 * pitch;
      const L = 0.032 * cl * sp * sp;
      const D = L / 7 + 0.0035 * sp * sp + Math.max(0, pitch) * 0.008 * sp * sp;
      const thermal = thermalAt(this.x, this.z);
      this.vx += (lx * L - dx * D) * h;
      this.vy += (ly * L - dy * D - G + 1.5 * Math.max(0, thermal - Math.max(0, this.vy))) * h;
      this.vz += (lz * L - dz * D) * h;
      // bank-turn
      const yaw = -clamp(inp.lean, -1, 1) * 0.9 * h;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const vx = this.vx * c + this.vz * s;
      const vz = -this.vx * s + this.vz * c;
      this.vx = vx;
      this.vz = vz;
      this.heading = Math.atan2(this.vx, this.vz);
    } else {
      this.vy -= G * h;
      const sp = Math.hypot(this.vx, this.vz);
      const dragA = 0.004 * sp * sp;
      if (sp > 0.01) {
        this.vx -= (this.vx / sp) * dragA * h;
        this.vz -= (this.vz / sp) * dragA * h;
      }
      if (this.riding) {
        this.heading -= clamp(inp.lean, -1, 1) * 1.6 * h;
        const spin = clamp(inp.spin, -1, 1) * 8.5 * h;
        this.boardYaw += spin;
        this.spinAccum += spin;
      }
    }
    this.x += this.vx * h;
    this.y += this.vy * h;
    this.z += this.vz * h;
    this.airPeakFall = Math.min(this.airPeakFall, this.vy);

    const plat = platformAt?.(this.x, this.z) ?? null;
    const onDeck = plat && this.y >= plat.y - 0.4 && this.vy <= 0;
    const ground = onDeck ? plat!.y : surfaceY(this.x, this.z, this.time);
    if (this.y > ground) return;
    this.y = ground;
    const impact = -this.vy;
    this.vy = 0;
    this.gliding = false;

    if (onDeck) {
      this.mode = 'foot';
      this.riding = false;
      this.hasBoard = true;
      this.platform = plat;
      this.emit('aboard', impact, 'Landed on deck');
      return;
    }

    const s = surfaceAt(this.x, this.z, this.time, this.surf);
    this.depth = s.depth;

    if (!this.riding) {
      // a hop on foot: did we land on the sliding board?
      const b = this.board;
      if (b.active && b.moving && this.distToBoard() < 1.35 && Math.abs(b.y - this.y) < 0.6) {
        const d = this.distToBoard();
        if (b.loose) this.mountBoard('sloppy', false, 'Kick it forward before you land');
        else this.mountBoard(d < 0.85 ? 'perfect' : 'good');
      } else if (Math.hypot(this.vx, this.vz) > MISS_TUMBLE) {
        this.wipeout('Missed the board — tumbled');
      } else {
        this.mode = 'foot';
        this.emit('splash', impact * 0.15);
      }
      return;
    }

    // board landing
    const hs = Math.hypot(this.vx, this.vz);
    const velAng = Math.atan2(this.vx, this.vz);
    const boardDir = this.heading + this.boardYaw;
    const diff = wrapAngle(boardDir - velAng);
    const fold = Math.abs(diff) > Math.PI / 2 ? Math.PI - Math.abs(diff) : Math.abs(diff);
    const hard = (impact > 15 && s.depth < 0.5) || impact > 26;
    if ((hs > 2 && fold > 0.65) || hard) {
      this.wipeout(hard ? 'Too high — wiped out' : 'Caught a rail — wiped out');
      return;
    }
    if (Math.abs(diff) > Math.PI / 2) {
      this.heading = boardDir + Math.PI;
      this.emit('switch', 1, 'Switch!');
    } else this.heading = boardDir;
    this.heading = velAng + wrapAngle(this.heading - velAng);
    this.boardYaw = 0;

    // landing on a down-slope turns fall into speed
    surfaceGrad(this.x, this.z, this.time, this.grad);
    if (hs > 0.1) {
      const downslope = Math.max(0, -(this.grad.x * this.vx + this.grad.z * this.vz) / hs);
      const bonus = Math.min(impact * downslope * 0.9, 8);
      this.vx += (this.vx / hs) * bonus;
      this.vz += (this.vz / hs) * bonus;
    }

    const spins = Math.round(Math.abs(this.spinAccum) / Math.PI);
    if (spins >= 1) {
      this.flow = clamp(this.flow + 0.1 * spins, 0, 1);
      this.emit('trick', spins, `${spins * 180} SHUVIT`);
    }
    const stomp = this.crouch > 0.3 || impact < 3;
    if (stomp) {
      if (this.airTime > 0.35) {
        this.flow = clamp(this.flow + 0.06, 0, 1);
        this.emit('stomp', impact, 'Stomped');
      }
    } else {
      this.vx *= 0.9;
      this.vz *= 0.9;
      this.emit('land', impact, 'Bend your knees on landing');
    }
    this.emit('splash', impact * 0.3 + hs * 0.05);
    this.mode = 'board';
    this.riding = true;
  }

  private wipeout(text: string) {
    this.mode = 'wipeout';
    this.riding = false;
    this.wipeTimer = 1.4;
    this.flow = 0;
    this.sailOut = false;
    this.gliding = false;
    this.emit('wipeout', this.speed, text);
    this.emit('splash', 2);
  }

  private stepWipeout(h: number) {
    this.wipeTimer -= h;
    const sp = Math.hypot(this.vx, this.vz);
    const ns = Math.max(0, sp - 7 * h);
    if (sp > 1e-4) {
      this.vx *= ns / sp;
      this.vz *= ns / sp;
    }
    this.x += this.vx * h;
    this.z += this.vz * h;
    this.y = surfaceY(this.x, this.z, this.time);
    this.vy = 0;
    if (this.wipeTimer <= 0) {
      this.mode = 'foot';
      this.hasBoard = true;
      this.board.active = false;
    }
  }
}

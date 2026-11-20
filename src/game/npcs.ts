// Villagers in the world. Each one rides the same Skimmer physics as you: they
// run, throw, hop on (sometimes sloppily), pump, carve and pop ollies while
// following a daily schedule. At work/home they climb up onto their deck.

import * as THREE from 'three';
import { clamp, mulberry32, wrapAngle } from '../../shared/noise';
import { activityAt, PERSONAS, ROUTES, type Activity, type Persona } from '../../shared/npcs';
import { building, doorstep } from '../../shared/villages';
import { surfaceY } from '../../shared/world';
import { makeAvatar, makeAvatarLod, makeNameTag, poseAvatar, type Avatar } from '../render/models';
import type { Fleet } from './boats';
import { emptyInput, KICK_OUT_BELOW, Skimmer, type SkimEvent } from './skimmer';

type State = 'travel' | 'perched' | 'talk' | 'boat';

/** Metres within which a villager (and its reflection) is drawn with full, posed limbs. */
export const AVATAR_FULL = 22;
export const MIRROR_FULL = 12;

export class Npc {
  sk: Skimmer;
  avatar: Avatar;
  mirror: Avatar;
  private lod: THREE.Mesh;
  private mirrorLod: THREE.Mesh;
  tag: THREE.Sprite;
  state: State = 'travel';
  activity: Activity;
  routeIdx = 0;
  perch = { x: 0, y: 0, z: 0, facing: 0 };
  facing = 0;
  talkTarget: THREE.Vector3 | null = null;
  wave = 0;
  talkAnim = 0;
  runPhase = 0;
  lean = 0;
  crouch = 0.3;
  private rand: () => number;
  private throwT = -1;
  private hopAt = 0;
  private nextOllie = 0;
  private stuck = 0;
  private lastPos = new THREE.Vector2();
  private tick = 0;
  private wantTrick = 0;

  constructor(public p: Persona, private scene: THREE.Scene, hour: number, private fleet: Fleet) {
    this.rand = mulberry32(p.id.length * 977 + p.name.charCodeAt(0));
    this.sk = new Skimmer(p.skill);
    this.avatar = makeAvatar(p.look);
    this.avatar.root.traverse((o) => (o.castShadow = true));
    this.mirror = makeAvatar(p.look);
    this.mirror.root.traverse((o) => (o.castShadow = false));
    // Far away, each body (and its reflection) is drawn as one merged mesh instead of ~18 parts.
    this.lod = makeAvatarLod(this.avatar);
    this.avatar.root.add(this.lod);
    this.mirrorLod = new THREE.Mesh(this.lod.geometry, this.lod.material);
    this.mirror.root.add(this.mirrorLod);
    this.tag = makeNameTag(p.name.replace(/".*?" /, ''), p.role.split(';')[0].split(',')[0].slice(0, 34));
    this.tag.position.y = p.look.height + 0.45;
    this.avatar.root.add(this.tag);
    scene.add(this.avatar.root, this.mirror.root);
    this.activity = activityAt(p, hour);
    this.spawnFor(this.activity);
  }

  private target(): { x: number; z: number } | null {
    const a = this.activity;
    if (a.act === 'skim') {
      const r = ROUTES[a.route];
      const [x, z] = r[this.routeIdx % r.length];
      return { x, z };
    }
    if (a.act === 'captain') return null;
    return doorstep(building(a.at));
  }

  private spawnFor(a: Activity) {
    if (a.act === 'skim') {
      const r = ROUTES[a.route];
      this.routeIdx = Math.floor(this.rand() * r.length);
      const [x, z] = r[this.routeIdx];
      this.sk.place(x + (this.rand() - 0.5) * 10, z + (this.rand() - 0.5) * 10, this.rand() * 6);
      this.routeIdx++;
      this.state = 'travel';
    } else if (a.act === 'captain') {
      this.state = 'boat';
    } else {
      this.perchAt(a.at);
    }
  }

  private perchAt(id: string) {
    const bd = building(id);
    const base = surfaceY(bd.x, bd.z, 0);
    const fx = Math.sin(bd.rot);
    const fz = Math.cos(bd.rot);
    const side = (this.rand() - 0.5) * bd.w * 0.6;
    this.perch.x = bd.x + fx * (bd.d / 2 + 0.5) + fz * side;
    this.perch.z = bd.z + fz * (bd.d / 2 + 0.5) - fx * side;
    this.perch.y = base + bd.stilt;
    this.perch.facing = bd.rot + (this.rand() - 0.5) * 0.8;
    this.facing = this.perch.facing;
    this.state = 'perched';
    this.sk.place(this.perch.x, this.perch.z, this.perch.facing);
    this.sk.y = this.perch.y;
  }

  setHour(hour: number) {
    const a = activityAt(this.p, hour);
    if (a === this.activity) return;
    this.activity = a;
    if (this.state === 'talk') return;
    if (this.state === 'perched' || this.state === 'boat') {
      // climb down the ladder and set off
      const prev = this.state === 'boat' ? null : { x: this.perch.x, z: this.perch.z };
      if (prev) this.sk.place(prev.x + Math.sin(this.perch.facing) * 2.5, prev.z + Math.cos(this.perch.facing) * 2.5, this.perch.facing);
      if (a.act === 'captain') this.state = 'boat';
      else this.state = 'travel';
    }
    if (a.act === 'skim') this.routeIdx = this.nearestRouteIdx(ROUTES[a.route]);
  }

  private nearestRouteIdx(r: Array<[number, number]>) {
    let best = 0;
    let bd = Infinity;
    r.forEach(([x, z], i) => {
      const d = Math.hypot(x - this.sk.x, z - this.sk.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  startTalk(player: THREE.Vector3) {
    this.talkTarget = player.clone();
    if (this.state === 'travel') {
      if (this.sk.mode === 'board') {
        this.sk.mode = 'foot';
        this.sk.riding = false;
        this.sk.hasBoard = true;
      }
    }
    this.state = this.state === 'boat' ? 'boat' : 'talk';
    this.wave = 1;
  }

  endTalk() {
    this.talkTarget = null;
    if (this.state === 'talk') {
      const a = this.activity;
      if (a.act === 'skim' || a.act === 'captain') this.state = a.act === 'captain' ? 'boat' : 'travel';
      else if (this.sk.y > surfaceY(this.sk.x, this.sk.z, this.sk.time) + 1) this.state = 'perched';
      else this.state = 'travel';
    }
  }

  get position() {
    return new THREE.Vector3(this.sk.x, this.sk.y, this.sk.z);
  }

  update(dt: number, time: number, playerPos: THREE.Vector3, hooks: { onEvent?: (n: Npc, e: SkimEvent) => void }) {
    const dist = Math.hypot(playerPos.x - this.sk.x, playerPos.z - this.sk.z);
    // far away villagers think less often
    this.tick++;
    const skip = dist > 420 ? 6 : dist > 180 ? 2 : 1;
    if (this.tick % skip !== 0) return;
    dt *= skip;

    const inp = emptyInput();
    const sk = this.sk;
    sk.time = time - dt; // share the world clock (waves move with it)

    if (this.state === 'boat') {
      const a = this.activity;
      const boat = a.act === 'captain' ? this.fleet.get(a.boat) : null;
      if (boat) {
        const w = boat.world(0, -5.5);
        sk.x = w.x;
        sk.z = w.z;
        sk.y = boat.deckY;
        this.facing = boat.heading;
        if (this.talkTarget) this.facing = Math.atan2(this.talkTarget.x - sk.x, this.talkTarget.z - sk.z);
      }
      sk.mode = 'foot';
      sk.vx = sk.vz = 0;
    } else if (this.state === 'perched' || this.state === 'talk') {
      if (this.state === 'perched') {
        sk.x = this.perch.x;
        sk.z = this.perch.z;
        sk.y = this.perch.y;
        sk.mode = 'foot';
        sk.vx = sk.vz = 0;
        this.facing = this.perch.facing + Math.sin(time * 0.2 + this.p.age) * 0.4;
      } else {
        // stop where we are
        const onDeck = sk.y > surfaceY(sk.x, sk.z, time) + 1;
        if (!onDeck) sk.update(dt, inp);
      }
      if (this.talkTarget) {
        const want = Math.atan2(this.talkTarget.x - sk.x, this.talkTarget.z - sk.z);
        this.facing += wrapAngle(want - this.facing) * Math.min(1, dt * 4);
      }
    } else {
      this.pilot(dt, time, inp);
      sk.update(dt, inp, this.fleet.platformAt);
      if (sk.mode === 'board' || sk.mode === 'air') this.facing = sk.heading;
      else if (sk.speed > 0.5) this.facing = Math.atan2(sk.vx, sk.vz);
      for (const e of sk.events) hooks.onEvent?.(this, e);
    }
    sk.events.length = 0;

    // animation
    this.wave = Math.max(0, this.wave - dt * 0.6);
    this.talkAnim += ((this.talkTarget ? 1 : 0) - this.talkAnim) * Math.min(1, dt * 3);
    const runAmount = sk.mode === 'foot' ? clamp(Math.hypot(sk.vx, sk.vz) / 7, 0, 1) : 0;
    this.runPhase += dt * (4 + runAmount * 8) * (runAmount > 0.05 ? 1 : 0);
    const mode = sk.mode === 'foot' ? 'foot' : sk.mode;
    const pose = {
      mode,
      crouch: sk.mode === 'board' || sk.mode === 'air' ? sk.crouch : 0,
      lean: this.lean,
      runPhase: this.runPhase,
      runAmount,
      boardYaw: sk.boardYaw,
      armsOut: 0,
      wave: this.wave > 0.4 ? 1 : 0,
      talk: this.talkAnim,
      time,
    } as const;
    // Full articulated bodies only up close; the merged stand-in beyond that.
    const full = dist < AVATAR_FULL;
    const fullMirror = dist < MIRROR_FULL;
    this.avatar.body.visible = full;
    this.lod.visible = !full;
    this.mirror.body.visible = fullMirror;
    this.mirrorLod.visible = !fullMirror;
    if (full) poseAvatar(this.avatar, pose);
    if (fullMirror) poseAvatar(this.mirror, pose);
    const carry = sk.mode === 'foot' && sk.hasBoard;
    this.avatar.board.visible = sk.riding || carry;
    this.mirror.board.visible = this.avatar.board.visible;
    for (const av of [this.avatar, this.mirror]) {
      if (carry) {
        av.board.position.set(0.32, 0.9 * (this.p.look.height / 1.75), 0);
        av.board.rotation.set(0, 0, Math.PI / 2);
      }
    }
    const r = this.avatar.root;
    r.position.set(sk.x, sk.y, sk.z);
    r.rotation.y = this.facing;
    const water = surfaceY(sk.x, sk.z, time);
    const m = this.mirror.root;
    m.position.set(sk.x, 2 * water - sk.y, sk.z);
    m.rotation.set(-r.rotation.x, r.rotation.y, -r.rotation.z);
    m.scale.set(1, -1, 1);
    this.tag.visible = dist < 30;
    m.visible = dist < 70; // reflections are the expensive part on Quest
    this.avatar.root.visible = dist < 600;
  }

  private pilot(dt: number, time: number, inp: ReturnType<typeof emptyInput>) {
    const sk = this.sk;
    const tgt = this.target();
    if (!tgt) return;
    const dx = tgt.x - sk.x;
    const dz = tgt.z - sk.z;
    const d = Math.hypot(dx, dz);
    const a = this.activity;
    const want = Math.atan2(dx, dz);

    // reached a waypoint / destination
    if (a.act === 'skim' && d < 14) this.routeIdx++;
    if ((a.act === 'work' || a.act === 'home' || a.act === 'hang') && d < 3.5 && sk.mode === 'foot') {
      this.perchAt(a.at);
      return;
    }

    // unstick
    if (this.lastPos.distanceTo(new THREE.Vector2(sk.x, sk.z)) < 0.02 * dt * 60 && sk.mode === 'foot') this.stuck += dt;
    else this.stuck = 0;
    this.lastPos.set(sk.x, sk.z);
    if (this.stuck > 6) {
      this.stuck = 0;
      if (a.act === 'skim') this.routeIdx++;
    }

    const arrive = a.act !== 'skim' && d < 22;
    if (sk.mode === 'foot') {
      inp.viewYaw = want;
      inp.moveY = 1;
      inp.run = arrive ? 0.2 : 1;
      if (sk.hasBoard && !arrive && sk.speed > 6.2 * Math.min(1, this.p.skill) && this.throwT < 0) {
        inp.drop = true;
        this.throwT = time;
        this.hopAt = 0.3 + this.rand() * 0.22 + (1 - this.p.skill) * 0.3;
      }
      if (this.throwT > 0 && time - this.throwT > this.hopAt && sk.board.active) {
        inp.jump = true;
        this.throwT = -1;
      }
      if (this.throwT > 0 && time - this.throwT > 2) this.throwT = -1;
      this.lean = 0;
    } else if (sk.mode === 'board') {
      const diff = wrapAngle(want - sk.heading);
      inp.lean = clamp(-diff * 2.2, -1, 1);
      this.lean += (inp.lean - this.lean) * Math.min(1, dt * 5);
      // pump with the terrain like a local
      const target = sk.slopeAlong < -0.01 ? 1 : sk.slopeAlong > 0.01 ? 0 : 0.4;
      this.crouch += clamp(target - this.crouch, -dt * 2.5, dt * 2.5);
      inp.crouch = this.crouch;
      if (time > this.nextOllie && sk.speed > 6.5 && Math.abs(diff) < 0.3) {
        if (this.crouch < 0.7) this.crouch = Math.min(1, this.crouch + dt * 6);
        else {
          inp.jump = true;
          this.wantTrick = this.p.skill > 1.05 && this.rand() < 0.5 ? (this.rand() < 0.5 ? 1 : -1) : 0;
          this.nextOllie = time + 5 + this.rand() * 9;
        }
      }
      if (sk.speed < (sk.depth > 0.3 ? 4.2 : 2.4) || (arrive && sk.speed < KICK_OUT_BELOW - 0.5)) inp.drop = true; // kick out, run again
    } else if (sk.mode === 'air') {
      inp.lean = 0;
      inp.spin = sk.airTime < 0.35 ? this.wantTrick : 0;
      inp.crouch = sk.vy < 0 ? 0.6 : 0.2; // absorb landing
    }
  }

  dispose() {
    this.scene.remove(this.avatar.root, this.mirror.root);
  }
}

export class Villagers {
  list: Npc[];
  constructor(scene: THREE.Scene, hour: number, fleet: Fleet) {
    this.list = PERSONAS.map((p) => new Npc(p, scene, hour, fleet));
  }
  setHour(hour: number) {
    for (const n of this.list) n.setHour(hour);
  }
  update(dt: number, time: number, player: THREE.Vector3, hooks: { onEvent?: (n: Npc, e: SkimEvent) => void }) {
    for (const n of this.list) n.update(dt, time, player, hooks);
  }
  nearest(pos: THREE.Vector3, max = 6): Npc | null {
    let best: Npc | null = null;
    let bd = max;
    for (const n of this.list) {
      const d = n.position.distanceTo(pos);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }
  byId(id: string) {
    return this.list.find((n) => n.p.id === id);
  }
}

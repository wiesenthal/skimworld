// Skimboats: giant skimboards with a deck, cabin and sail, running trade loops.
// Ride into one and you hop aboard; run off the deck with your board for a
// "boat drop" — you inherit the boat's speed.

import * as THREE from 'three';
import { wrapAngle } from '../../shared/noise';
import { BOATS, type BoatId } from '../../shared/npcs';
import { surfaceY } from '../../shared/world';
import { BOAT_DIMS, makeSkimBoat } from '../render/models';
import type { Platform } from './skimmer';

const ROUTES: Record<BoatId, Array<[number, number]>> = {
  longglide: [
    [10, 140],
    [300, 400],
    [640, 640],
    [900, 350],
    [870, -30],
    [400, -120],
    [150, 60],
  ],
  wavecutter: [
    [-10, 145],
    [-200, 420],
    [-330, 745],
    [-560, 560],
    [-860, -170],
    [-500, -150],
    [-200, 40],
  ],
};

export class SkimBoat {
  group: THREE.Group;
  mirror: THREE.Group;
  curve: THREE.CatmullRomCurve3;
  length: number;
  u: number;
  speed = 8.5;
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  water = 0;
  private sail: THREE.Object3D | undefined;

  constructor(public id: BoatId, scene: THREE.Scene, start: number) {
    const pts = ROUTES[id].map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    this.u = start;
    const colors = id === 'longglide' ? ['#fcbf49', '#d62828', '#fff3d6'] : ['#e9f1f7', '#1d3557', '#a8dadc'];
    this.group = makeSkimBoat(colors[0], colors[1], colors[2], BOATS[id].name);
    this.sail = this.group.getObjectByName('boatsail');
    scene.add(this.group);
    this.mirror = this.group.clone();
    this.mirror.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) o.visible = false;
      o.castShadow = false;
    });
    scene.add(this.mirror);
    this.update(0, 0);
  }

  get deckY() {
    return this.y + BOAT_DIMS.deck;
  }

  update(dt: number, time: number) {
    const prevH = this.heading;
    const px = this.x;
    const pz = this.z;
    this.u = (this.u + (this.speed * dt) / this.length) % 1;
    const p = this.curve.getPointAt(this.u);
    const t = this.curve.getTangentAt(this.u);
    this.x = p.x;
    this.z = p.z;
    this.heading = Math.atan2(t.x, t.z);
    this.water = surfaceY(p.x, p.z, time);
    const bob = Math.sin(time * 1.3 + this.u * 50) * 0.06;
    this.y = this.water + bob;
    if (dt > 0) {
      this.vx = (this.x - px) / dt;
      this.vz = (this.z - pz) / dt;
      this.yawRate = wrapAngle(this.heading - prevH) / dt;
    }
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(Math.sin(time * 0.9) * 0.012, this.heading, -this.yawRate * 0.6);
    if (this.sail) this.sail.rotation.y = Math.PI / 2 + Math.sin(time * 0.4) * 0.15 - 0.35;
    this.mirror.position.set(this.x, 2 * this.water - this.y, this.z);
    this.mirror.rotation.copy(this.group.rotation);
    this.mirror.scale.set(1, -1, 1);
    const ms = this.mirror.getObjectByName('boatsail');
    if (ms && this.sail) ms.rotation.copy(this.sail.rotation);
  }

  /** Local coordinates of a world point (lateral, along). */
  local(x: number, z: number) {
    const dx = x - this.x;
    const dz = z - this.z;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    return { lx: dx * fz - dz * fx, lz: dx * fx + dz * fz };
  }

  world(lx: number, lz: number) {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    return { x: this.x + lx * fz + lz * fx, z: this.z - lx * fx + lz * fz };
  }

  platformAt(x: number, z: number): Platform | null {
    const { lx, lz } = this.local(x, z);
    const a = BOAT_DIMS.width / 2 - 1.2;
    const b = BOAT_DIMS.length / 2 - 2.5;
    if ((lx / a) ** 2 + (lz / b) ** 2 > 1) return null;
    return { id: this.id, y: this.deckY, vx: this.vx, vz: this.vz, yawRate: this.yawRate, cx: this.x, cz: this.z };
  }
}

export class Fleet {
  boats: SkimBoat[];
  constructor(scene: THREE.Scene) {
    this.boats = [new SkimBoat('longglide', scene, 0.02), new SkimBoat('wavecutter', scene, 0.5)];
  }
  update(dt: number, time: number) {
    for (const b of this.boats) b.update(dt, time);
  }
  platformAt = (x: number, z: number): Platform | null => {
    for (const b of this.boats) {
      const p = b.platformAt(x, z);
      if (p) return p;
    }
    return null;
  };
  get(id: BoatId) {
    return this.boats.find((b) => b.id === id)!;
  }
}

// Stilt villages. Every building, boardwalk, palm and turbine is built from
// primitives, merged per material (few draw calls on Quest), and baked a second
// time mirrored about the water surface beneath it — the film reflects them.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../shared/noise';
import { BOARDWALKS, BUILDINGS, building, doorstep, GEAR_SPOTS, type Building } from '../../shared/villages';
import { LIFT, REGIONS, surfaceY, terrainHeight, type RegionId } from '../../shared/world';
import { makeSail, makeWing, roundRect } from './models';

type MatKey = string;

interface StyleDef {
  stilt: MatKey;
  stiltR: number;
  deck: MatKey;
  walls: MatKey[];
  roof: MatKey;
  roofKind: 'thatch' | 'flat' | 'shed' | 'pagoda' | 'dome';
  window: MatKey;
  trim: MatKey;
}

const STYLES: Record<RegionId, StyleDef> = {
  tidewell: { stilt: 'bamboo', stiltR: 0.13, deck: 'wood', walls: ['woven'], roof: 'thatch', roofKind: 'thatch', window: 'warmGlow', trim: 'bamboo' },
  saltglass: { stilt: 'steel', stiltR: 0.09, deck: 'whiteDeck', walls: ['white'], roof: 'white', roofKind: 'flat', window: 'coolGlass', trim: 'orange' },
  brinehook: {
    stilt: 'drift',
    stiltR: 0.17,
    deck: 'drift',
    walls: ['paintBlue', 'paintYellow', 'paintCoral', 'paintGreen', 'paintPeach'],
    roof: 'tin',
    roofKind: 'shed',
    window: 'warmGlow',
    trim: 'white',
  },
  highfall: { stilt: 'lacquer', stiltR: 0.16, deck: 'darkwood', walls: ['paper'], roof: 'tile', roofKind: 'pagoda', window: 'lanternGlow', trim: 'lacquer' },
  glowmarsh: { stilt: 'black', stiltR: 0.12, deck: 'black', walls: ['shell'], roof: 'shell2', roofKind: 'dome', window: 'magentaGlow', trim: 'neonCyan' },
};

function makeMaterials() {
  const M = (color: string, rough = 0.8, metal = 0, emissive?: string, ei = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive ?? '#000000', emissiveIntensity: ei });
  return {
    bamboo: M('#c9ab6c', 0.6),
    wood: M('#9a6a3c', 0.85),
    woven: M('#dcbc8c', 0.95),
    thatch: M('#b08d4a', 1.0),
    steel: M('#c5cbd2', 0.3, 0.7),
    whiteDeck: M('#e8ecef', 0.5),
    white: M('#f7f8fa', 0.4),
    orange: M('#ff7a3d', 0.5),
    drift: M('#a39280', 0.95),
    paintBlue: M('#3fa7d6', 0.7),
    paintYellow: M('#f6c85f', 0.7),
    paintCoral: M('#e85d75', 0.7),
    paintGreen: M('#59cd90', 0.7),
    paintPeach: M('#f79d84', 0.7),
    tin: M('#9aa5ad', 0.45, 0.6),
    lacquer: M('#9b2d20', 0.4),
    darkwood: M('#5a3a28', 0.8),
    paper: M('#f1e8d4', 0.9),
    tile: M('#334457', 0.6),
    black: M('#1c1a26', 0.6),
    shell: M('#3e3160', 0.5),
    shell2: M('#261c3d', 0.4),
    door: M('#4a3020', 0.8),
    rope: M('#d8c8a0', 1),
    palmTrunk: M('#8a6a45', 1),
    palmLeaf: M('#2f9a4a', 0.8),
    rock: M('#7d746a', 1),
    warmGlow: M('#ffd18a', 0.5, 0, '#ffa640', 0.3),
    coolGlass: M('#a9dcff', 0.1, 0.2, '#7fc8ff', 0.25),
    lanternGlow: M('#ffb070', 0.5, 0, '#ff6a2a', 0.4),
    magentaGlow: M('#ff7ae0', 0.4, 0, '#ff38d0', 1.6),
    neonCyan: M('#5ff9ff', 0.3, 0, '#00f0ff', 2.5),
    neonPink: M('#ff8bf0', 0.3, 0, '#ff2bd6', 2.5),
    mushroom: M('#9be7ff', 0.4, 0, '#33d6ff', 1.8),
  } satisfies Record<string, THREE.MeshStandardMaterial>;
}

type Mats = ReturnType<typeof makeMaterials>;

function flipWinding(geo: THREE.BufferGeometry) {
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name] as THREE.BufferAttribute;
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    for (let t = 0; t < a.count; t += 3) {
      for (let c = 0; c < n; c++) {
        const i1 = (t + 1) * n + c;
        const i2 = (t + 2) * n + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
  }
}

class Bucket {
  parts = new Map<MatKey, THREE.BufferGeometry[]>();
  add(key: MatKey, geo: THREE.BufferGeometry, m: THREE.Matrix4, mirrorY: number | null) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    this.push(key, g);
    if (mirrorY !== null) {
      const mm = new THREE.Matrix4().makeTranslation(0, 2 * mirrorY, 0).multiply(new THREE.Matrix4().makeScale(1, -1, 1));
      const r = g.clone().applyMatrix4(mm);
      flipWinding(r);
      this.push(key + '#mirror', r);
    }
  }
  private push(key: string, g: THREE.BufferGeometry) {
    let arr = this.parts.get(key);
    if (!arr) this.parts.set(key, (arr = []));
    arr.push(g);
  }
  build(mats: Mats, group: THREE.Group) {
    for (const [key, geos] of this.parts) {
      const isMirror = key.endsWith('#mirror');
      const mk = key.replace('#mirror', '') as keyof Mats;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mats[mk]);
      mesh.castShadow = !isMirror;
      mesh.receiveShadow = !isMirror;
      mesh.name = key;
      group.add(mesh);
    }
  }
}

// shared unit geometries
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 6);
const CONE4 = new THREE.ConeGeometry(1, 1, 4, 1);
const CONE8 = new THREE.ConeGeometry(1, 1, 8, 1);
const SPH = new THREE.SphereGeometry(1, 10, 8);
const DOME = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const TORUS = new THREE.TorusGeometry(1, 0.04, 6, 32);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function trs(px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) {
  return _m.compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)).clone();
}

export interface VillageDynamics {
  rotors: THREE.Object3D[];
  flames: THREE.Mesh[];
  pickups: Array<{ kind: 'sail' | 'wing'; obj: THREE.Object3D; x: number; z: number }>;
  liftCabin: THREE.Group;
  notices: Map<RegionId, { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }>;
  glowMats: Array<{ m: THREE.MeshStandardMaterial; base: number; always: boolean }>;
  fireLight: THREE.PointLight;
}

export function buildVillages(scene: THREE.Scene): VillageDynamics {
  const mats = makeMaterials();
  const bucket = new Bucket();
  const group = new THREE.Group();
  group.name = 'villages';
  const rand = mulberry32(7);

  const deckY = new Map<string, number>();
  for (const bd of BUILDINGS) deckY.set(bd.id, buildBuilding(bd, bucket, rand));

  for (const [a, b] of BOARDWALKS) boardwalk(building(a), building(b), deckY, bucket);

  // Tidewell palms
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const r = 92 + rand() * 110;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (BUILDINGS.some((b) => Math.hypot(b.x - x, b.z - z) < 12)) continue;
    palm(x, z, rand, bucket);
  }
  // Brinehook palms along the beach
  for (let i = 0; i < 20; i++) {
    const x = -520 + rand() * 560;
    const z = 790 + rand() * 50;
    if (BUILDINGS.some((b) => Math.hypot(b.x - x, b.z - z) < 12)) continue;
    palm(x, z, rand, bucket);
  }
  // Glowmarsh mushrooms
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2;
    const r = 30 + rand() * 230;
    const x = 700 + Math.cos(a) * r;
    const z = 780 + Math.sin(a) * r;
    const base = surfaceY(x, z, 0);
    const hgt = 1.5 + rand() * 4;
    bucket.add('black', CYL, trs(x, base + hgt / 2, z, 0, 0, 0, 0.12, hgt, 0.12), base);
    bucket.add('mushroom', DOME, trs(x, base + hgt, z, 0, 0, 0, 0.8 + hgt * 0.25, 0.5 + hgt * 0.1, 0.8 + hgt * 0.25), base);
  }
  // Highfall rocks / torii-ish gates near the launch
  for (let i = 0; i < 12; i++) {
    const a = rand() * Math.PI * 2;
    const r = 40 + rand() * 120;
    const x = -900 + Math.cos(a) * r;
    const z = -550 + Math.sin(a) * r;
    const base = terrainHeight(x, z);
    bucket.add('rock', SPH, trs(x, base, z, rand(), rand(), rand(), 1 + rand() * 2.5, 0.8 + rand() * 1.5, 1 + rand() * 2), null);
  }

  // Saltglass turbines
  const rotors: THREE.Object3D[] = [];
  for (let i = 0; i < 5; i++) {
    const x = 1060 + (i % 3) * 38;
    const z = -280 + i * 32;
    const base = surfaceY(x, z, 0);
    bucket.add('steel', CYL, trs(x, base + 14, z, 0, 0, 0, 0.45, 28, 0.45), base);
    bucket.add('white', BOX, trs(x, base + 28.2, z, 0, 0, 0, 1.2, 1.2, 2.6), base);
    const rotor = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 11, 0.08), mats.white);
      blade.position.y = 5.5;
      const arm = new THREE.Group();
      arm.rotation.z = (k / 3) * Math.PI * 2;
      arm.add(blade);
      rotor.add(arm);
    }
    rotor.position.set(x - 1.6, base + 28.2, z);
    rotor.rotation.y = Math.PI / 2;
    rotor.userData.speed = 1.2 + i * 0.1;
    group.add(rotor);
    rotors.push(rotor);
  }

  // Brinehook bonfire
  const flames: THREE.Mesh[] = [];
  const fire = { x: -250, z: 905 };
  const fy = surfaceY(fire.x, fire.z, 0);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    bucket.add('drift', CYL, trs(fire.x + Math.cos(a) * 0.5, fy + 0.3, fire.z + Math.sin(a) * 0.5, 1.1, a, 0, 0.12, 1.6, 0.12), fy);
  }
  const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  for (let k = 0; k < 3; k++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.5 - k * 0.12, 1.6 + k * 0.4, 7), flameMat);
    f.position.set(fire.x, fy + 0.9 + k * 0.1, fire.z);
    f.renderOrder = 3;
    group.add(f);
    flames.push(f);
  }
  const fireLight = new THREE.PointLight('#ff9a3c', 0, 30, 2);
  fireLight.position.set(fire.x, fy + 2, fire.z);
  group.add(fireLight);

  // The Mist Lift: tower at the base, gantry to the mesa top
  const lb = LIFT.base;
  const lt = LIFT.top;
  const lby = surfaceY(lb.x, lb.z, 0);
  const lty = surfaceY(lt.x, lt.z, 0);
  for (const [ox, oz] of [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ]) {
    bucket.add('lacquer', CYL, trs(lb.x + ox, lby + (lty + 6 - lby) / 2, lb.z + oz, 0, 0, 0, 0.25, lty + 6 - lby, 0.25), lby);
  }
  const gdx = lt.x - lb.x;
  const gdz = lt.z - lb.z;
  const glen = Math.hypot(gdx, gdz);
  const gang = Math.atan2(gdx, gdz);
  bucket.add('darkwood', BOX, trs((lb.x + lt.x) / 2, lty + 6, (lb.z + lt.z) / 2, 0, gang, 0, 1.4, 0.5, glen), null);
  // waterwheel
  bucket.add('darkwood', CYL, trs(lb.x + 4.5, lby + 3, lb.z, 0, 0, Math.PI / 2, 3, 0.8, 3), lby);
  const liftCabin = new THREE.Group();
  const cab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 4), mats.darkwood);
  liftCabin.add(cab);
  for (const [ox, oz] of [
    [-1.8, -1.8],
    [1.8, -1.8],
    [-1.8, 1.8],
    [1.8, 1.8],
  ]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), mats.lacquer);
    post.position.set(ox, 0.55, oz);
    liftCabin.add(post);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), mats.lanternGlow);
  lamp.position.y = 1.4;
  liftCabin.add(lamp);
  liftCabin.position.set(lb.x, lby + 0.15, lb.z);
  group.add(liftCabin);

  // Gear pickups
  const pickups: VillageDynamics['pickups'] = [];
  {
    const s = makeSail();
    const y = surfaceY(GEAR_SPOTS.sail.x, GEAR_SPOTS.sail.z, 0);
    s.position.set(GEAR_SPOTS.sail.x, y + 0.2, GEAR_SPOTS.sail.z);
    s.scale.setScalar(0.8);
    group.add(s);
    pickups.push({ kind: 'sail', obj: s, x: GEAR_SPOTS.sail.x, z: GEAR_SPOTS.sail.z });
    const w = makeWing();
    const wy = surfaceY(GEAR_SPOTS.wing.x, GEAR_SPOTS.wing.z, 0);
    w.position.set(GEAR_SPOTS.wing.x, wy + 2.2, GEAR_SPOTS.wing.z);
    w.scale.setScalar(0.5);
    group.add(w);
    pickups.push({ kind: 'wing', obj: w, x: GEAR_SPOTS.wing.x, z: GEAR_SPOTS.wing.z });
  }

  // Notice boards (life events from the NPC server)
  const notices: VillageDynamics['notices'] = new Map();
  const noticeAt: Record<RegionId, string> = {
    tidewell: 'tidewell.cafe',
    saltglass: 'saltglass.loft',
    brinehook: 'brinehook.shack',
    highfall: 'highfall.tea',
    glowmarsh: 'glowmarsh.club',
  };
  for (const r of REGIONS) {
    const bd = building(noticeAt[r.id]);
    const ds = doorstep(bd);
    const side = { x: Math.cos(bd.rot) * 4, z: -Math.sin(bd.rot) * 4 };
    const x = ds.x + side.x;
    const z = ds.z + side.z;
    const y = surfaceY(x, z, 0);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 384;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.8), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false }));
    board.position.set(x, y + 1.9, z);
    board.rotation.y = bd.rot;
    group.add(board);
    for (const ox of [-1.1, 1.1]) {
      bucket.add(STYLES[r.id].deck, BOX, trs(x + Math.cos(bd.rot) * ox, y + 1.4, z - Math.sin(bd.rot) * ox, 0, bd.rot, 0, 0.12, 2.8, 0.12), y);
    }
    notices.set(r.id, { canvas, tex });
    drawNotice(r.id, [`Welcome to ${r.name}`, r.tagline, 'News from the villagers will appear here.'], notices);
  }

  bucket.build(mats, group);
  scene.add(group);

  const glowMats = [
    { m: mats.warmGlow, base: 2.2, always: false },
    { m: mats.coolGlass, base: 1.4, always: false },
    { m: mats.lanternGlow, base: 2.6, always: false },
    { m: mats.magentaGlow, base: 1.6, always: true },
    { m: mats.neonCyan, base: 2.5, always: true },
    { m: mats.neonPink, base: 2.5, always: true },
    { m: mats.mushroom, base: 1.8, always: true },
  ];
  return { rotors, flames, pickups, liftCabin, notices, glowMats, fireLight };
}

export function drawNotice(region: RegionId, lines: string[], notices: VillageDynamics['notices']) {
  const n = notices.get(region);
  if (!n) return;
  const g = n.canvas.getContext('2d')!;
  g.fillStyle = '#f3e7cf';
  g.fillRect(0, 0, 512, 384);
  g.strokeStyle = '#7a5532';
  g.lineWidth = 14;
  g.strokeRect(7, 7, 498, 370);
  g.fillStyle = '#3b2a1a';
  g.font = '700 30px Georgia, serif';
  g.fillText('VILLAGE NEWS', 24, 50);
  g.font = '400 21px Georgia, serif';
  let y = 88;
  for (const line of lines) {
    for (const l of wrapText(g, line, 460)) {
      if (y > 360) break;
      g.fillText(l, 26, y);
      y += 26;
    }
    y += 8;
  }
  n.tex.needsUpdate = true;
}

export function wrapText(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > width && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// ------------------------------------------------------------------ builders

function buildBuilding(bd: Building, bucket: Bucket, rand: () => number): number {
  const st = STYLES[bd.region];
  const base = surfaceY(bd.x, bd.z, 0);
  const S = bd.stilt;
  const deckWorld = base + S;
  const mirror = base;
  const c = Math.cos(bd.rot);
  const s = Math.sin(bd.rot);
  const toWorld = (lx: number, lz: number) => ({ x: bd.x + lx * c + lz * s, z: bd.z - lx * s + lz * c });
  const part = (key: MatKey, geo: THREE.BufferGeometry, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) => {
    const w = toWorld(lx, lz);
    bucket.add(key, geo, trs(w.x, base + ly, w.z, rx, bd.rot + ry, rz, sx, sy, sz), mirror);
  };
  const W = bd.w;
  const D = bd.d;
  const wallKey = st.walls[Math.floor(rand() * st.walls.length)];

  // stilts down to the sand
  const nx = W > 7 ? 3 : 2;
  const nz = D > 7 ? 3 : 2;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const lx = (i / (nx - 1) - 0.5) * (W + 0.8);
      const lz = (j / (nz - 1) - 0.5) * (D + 0.8);
      const w = toWorld(lx, lz);
      const g = terrainHeight(w.x, w.z) - 0.4;
      const len = deckWorld - g;
      bucket.add(st.stilt, CYL, trs(w.x, g + len / 2, w.z, 0, 0, 0, st.stiltR, len, st.stiltR), mirror);
      if (st.stilt === 'bamboo') {
        for (let k = 1; k < len; k += 1.1) bucket.add('bamboo', CYL, trs(w.x, g + k, w.z, 0, 0, 0, st.stiltR * 1.25, 0.06, st.stiltR * 1.25), mirror);
      }
    }
  // cross braces
  part(st.stilt, CYL, 0, S * 0.45, (D + 0.8) / 2, 0.05, Math.hypot(W, S * 0.6), 0.05, 0, 0, Math.atan2(W, S * 0.6));

  // deck
  part(st.deck, BOX, 0, S - 0.11, 0, W + 1.6, 0.22, D + 1.6);
  // railing
  const railY = S + 0.5;
  for (const sz of [-1, 1]) part(st.trim, BOX, 0, railY + 0.45, (sz * (D + 1.5)) / 2, W + 1.6, 0.07, 0.07);
  for (const sx of [-1, 1]) part(st.trim, BOX, (sx * (W + 1.5)) / 2, railY + 0.45, 0, 0.07, 0.07, D + 1.6);
  for (let i = 0; i <= 4; i++) {
    const t = i / 4 - 0.5;
    for (const sz of [-1, 1]) part(st.trim, BOX, t * (W + 1.5), railY, (sz * (D + 1.5)) / 2, 0.06, 0.95, 0.06);
  }

  // ladder at the front
  const ladderX = W / 2 - 0.4;
  const ladderZ = D / 2 + 1.0;
  const lw = toWorld(ladderX, ladderZ);
  const lg = terrainHeight(lw.x, lw.z);
  const llen = deckWorld - lg;
  for (const off of [-0.3, 0.3]) part(st.trim, BOX, ladderX + off, S - llen / 2, ladderZ, 0.06, llen, 0.06);
  for (let k = 0.4; k < llen; k += 0.4) part(st.trim, BOX, ladderX, S - k, ladderZ, 0.6, 0.04, 0.05);

  if (bd.role === 'dock') {
    for (const sx of [-1, 1]) {
      part('rope', CYL, sx * (W / 2), S + 0.35, D / 2, 0.15, 0.7, 0.15);
      part(st.window, SPH, sx * (W / 2), S + 1.6, -D / 2, 0.18, 0.18, 0.18);
      part(st.trim, CYL, sx * (W / 2), S + 0.8, -D / 2, 0.05, 1.6, 0.05);
    }
    return deckWorld;
  }
  if (bd.role === 'shrine') {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) part('lacquer', CYL, sx * (W / 2 - 0.4), S + 1.4, sz * (D / 2 - 0.4), 0.15, 2.8, 0.15);
    part('tile', CONE4, 0, S + 3.4, 0, W * 0.85, 1.4, D * 0.85, 0, Math.PI / 4, 0);
    part('lanternGlow', SPH, 0, S + 2.4, 0, 0.3, 0.4, 0.3);
    return deckWorld;
  }

  // walls
  const H = bd.role === 'tower' ? 2.2 : 2.7;
  part(wallKey, BOX, 0, S + H / 2, 0, W, H, D);
  part('door', BOX, -W * 0.15, S + 0.95, D / 2 + 0.03, 1.0, 1.9, 0.06);
  // windows on all four sides
  for (const side of [0, 1, 2, 3]) {
    const along = side % 2 === 0 ? W : D;
    const across = side % 2 === 0 ? D : W;
    const n = along > 7 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0.25 : (k / (n - 1) - 0.5) * 0.55;
      const lx = side % 2 === 0 ? t * along : ((side === 1 ? 1 : -1) * across) / 2 + (side === 1 ? 0.03 : -0.03);
      const lz = side % 2 === 0 ? ((side === 0 ? 1 : -1) * across) / 2 + (side === 0 ? 0.03 : -0.03) : t * along;
      if (side === 0 && Math.abs(lx + W * 0.15) < 0.9) continue;
      const sx = side % 2 === 0 ? 1.0 : 0.06;
      const sz = side % 2 === 0 ? 0.06 : 1.0;
      part(st.window, BOX, lx, S + 1.55, lz, sx, 0.85, sz);
    }
  }

  let top = S + H;
  if (bd.floors > 1) {
    part(wallKey, BOX, 0, top + 0.3 + 1.1, 0, W * 0.75, 2.2, D * 0.75);
    part(st.window, BOX, 0, top + 1.4, (D * 0.75) / 2 + 0.03, W * 0.4, 0.7, 0.06);
    roof(st, part, W * 0.75, D * 0.75, top + 0.2, true);
    top += 2.5;
  }
  roof(st, part, W, D, top, false);

  // signage-ish accents
  if (bd.region === 'glowmarsh') {
    part('neonCyan', TORUS, 0, S + H + 0.05, 0, Math.max(W, D) * 0.62, Math.max(W, D) * 0.62, 1.2, Math.PI / 2, 0, 0);
    part('neonPink', BOX, 0, S + 0.05, D / 2 + 0.85, W + 1.6, 0.06, 0.06);
  }
  if (bd.region === 'highfall') {
    for (const sx of [-1, 1]) part('lanternGlow', SPH, sx * (W / 2 + 0.6), S + 2.0, D / 2 + 0.6, 0.22, 0.3, 0.22);
  }
  if (bd.region === 'tidewell') {
    for (const sx of [-1, 1]) part('warmGlow', SPH, sx * (W / 2 + 0.7), S + 1.9, D / 2 + 0.7, 0.14, 0.14, 0.14);
  }
  if (bd.region === 'saltglass') {
    part('steel', CYL, W / 2 + 0.6, S + H + 2.5, D / 2 + 0.6, 0.04, 5, 0.04);
    part('orange', BOX, W / 2 + 1.3, S + H + 4.4, D / 2 + 0.6, 1.4, 0.8, 0.02);
  }
  if (bd.region === 'brinehook' && bd.role !== 'tower') {
    for (let k = 0; k < 3; k++) part(['paintCoral', 'paintBlue', 'paintYellow'][k], SPH, -W / 2 - 0.5, S + 1.2, -D / 4 + k * 0.6, 0.05, 1.1, 0.28, 0.15, 0, 0);
  }
  return deckWorld;
}

type PartFn = (key: MatKey, geo: THREE.BufferGeometry, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, rx?: number, ry?: number, rz?: number) => void;

function roof(st: StyleDef, part: PartFn, W: number, D: number, y: number, upper: boolean) {
  const R = Math.max(W, D);
  switch (st.roofKind) {
    case 'thatch':
      part('thatch', CONE4, 0, y + 1.3, 0, R * 0.92, 2.6, R * 0.92, 0, Math.PI / 4, 0);
      part('thatch', CONE4, 0, y + 2.9, 0, R * 0.25, 0.8, R * 0.25, 0, Math.PI / 4, 0);
      break;
    case 'flat':
      part('white', BOX, 0, y + 0.15, 0, W + 1.2, 0.3, D + 1.2);
      if (!upper) part('coolGlass', BOX, W * 0.15, y + 0.45, 0, W * 0.4, 0.06, D * 0.5, 0.25, 0, 0);
      break;
    case 'shed':
      part('tin', BOX, 0, y + 0.55, 0, W + 1.2, 0.12, D + 1.4, 0.18, 0, 0);
      break;
    case 'pagoda':
      part('tile', CONE4, 0, y + 0.55, 0, R * 1.02, 1.1, R * 1.02, 0, Math.PI / 4, 0);
      part('tile', CONE4, 0, y + 1.4, 0, R * 0.55, 1.2, R * 0.55, 0, Math.PI / 4, 0);
      if (!upper) part('lacquer', CYL, 0, y + 2.3, 0, 0.08, 1.2, 0.08);
      break;
    case 'dome':
      part('shell2', DOME, 0, y, 0, R * 0.62, R * 0.4, R * 0.62);
      part('magentaGlow', SPH, 0, y + R * 0.4, 0, 0.25, 0.25, 0.25);
      break;
  }
}

function boardwalk(a: Building, b: Building, deckY: Map<string, number>, bucket: Bucket) {
  const ya = deckY.get(a.id)!;
  const yb = deckY.get(b.id)!;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const ang = Math.atan2(dx, dz);
  const pitch = Math.atan2(yb - ya, len);
  const st = STYLES[a.region];
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const my = (ya + yb) / 2 - 0.1;
  const mirror = surfaceY(mx, mz, 0);
  bucket.add(st.deck, BOX, trs(mx, my, mz, -pitch, ang, 0, 1.7, 0.16, len), mirror);
  const steps = Math.floor(len / 5);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const y = ya + (yb - ya) * t;
    const g = terrainHeight(x, z) - 0.3;
    for (const off of [-0.75, 0.75]) {
      const ox = Math.cos(ang) * off;
      const oz = -Math.sin(ang) * off;
      bucket.add(st.stilt, CYL, trs(x + ox, (g + y) / 2, z + oz, 0, 0, 0, st.stiltR * 0.8, y - g, st.stiltR * 0.8), mirror);
      bucket.add(st.trim, CYL, trs(x + ox, y + 0.45, z + oz, 0, 0, 0, 0.04, 0.9, 0.04), mirror);
    }
  }
  for (const off of [-0.8, 0.8]) {
    const ox = Math.cos(ang) * off;
    const oz = -Math.sin(ang) * off;
    bucket.add('rope', BOX, trs(mx + ox, my + 0.95, mz + oz, -pitch, ang, 0, 0.04, 0.04, len), mirror);
  }
}

function palm(x: number, z: number, rand: () => number, bucket: Bucket) {
  const base = surfaceY(x, z, 0);
  const g = terrainHeight(x, z);
  const h = 6 + rand() * 5;
  const lean = (rand() - 0.5) * 0.5;
  const dir = rand() * Math.PI * 2;
  const segs = 6;
  let px = x;
  let pz = z;
  let py = g;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const bend = lean * t * t * 3;
    const nx = x + Math.cos(dir) * bend * h * 0.3;
    const nz = z + Math.sin(dir) * bend * h * 0.3;
    const ny = g + (h * (i + 1)) / segs;
    const mx = (px + nx) / 2;
    const my = (py + ny) / 2;
    const mz = (pz + nz) / 2;
    const seg = Math.hypot(nx - px, ny - py, nz - pz);
    const tilt = Math.atan2(Math.hypot(nx - px, nz - pz), ny - py);
    const yaw = Math.atan2(nx - px, nz - pz);
    bucket.add('palmTrunk', CYL, trs(mx, my, mz, tilt, yaw, 0, 0.22 - t * 0.08, seg, 0.22 - t * 0.08), base);
    px = nx;
    py = ny;
    pz = nz;
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + rand() * 0.5;
    const droop = 0.35 + rand() * 0.35;
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(droop), -Math.sin(droop), Math.sin(a) * Math.cos(droop));
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    // roll the blade flat (its thin axis toward the sky)
    const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a + Math.PI / 2);
    q.multiply(roll);
    const len = 3.2 + rand() * 0.8;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(px + dir.x * len * 0.5, py + dir.y * len * 0.5, pz + dir.z * len * 0.5),
      q,
      new THREE.Vector3(0.55, len, 0.06),
    );
    bucket.add('palmLeaf', CONE8, m, base);
  }
  bucket.add('palmTrunk', SPH, trs(px, py, pz, 0, 0, 0, 0.35, 0.3, 0.35), base);
}

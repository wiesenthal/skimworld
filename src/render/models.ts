// Procedural low-poly models: skimboards, riders, skim boats, sail, wing.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Look } from '../../shared/npcs';

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, opts: { rough?: number; metal?: number; emissive?: string; ei?: number } = {}) {
  const key = `${color}|${opts.rough ?? 0.7}|${opts.metal ?? 0}|${opts.emissive ?? ''}|${opts.ei ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.7,
      metalness: opts.metal ?? 0,
      emissive: opts.emissive ? new THREE.Color(opts.emissive) : undefined,
      emissiveIntensity: opts.ei ?? 0,
    });
    matCache.set(key, m);
  }
  return m;
}

// ------------------------------------------------------------------ board
function boardGeometry(length: number, width: number, thick: number, rocker: number) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, width / 2, length / 2, 0, Math.PI * 2, false, 0);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: thick * 0.4,
    bevelSize: thick * 0.6,
    bevelSegments: 2,
    curveSegments: 28,
  });
  // lay flat: shape XY -> XZ, extrude along +Y
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) / (length / 2);
    p.setY(i, p.getY(i) + rocker * Math.pow(Math.abs(z), 3));
  }
  geo.computeVertexNormals();
  return geo;
}

function boardTexture(color: string) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(0, 54, 64, 6);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 62, 64, 3);
  g.beginPath();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.arc(32, 30, 12, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const boardGeo = boardGeometry(1.3, 0.56, 0.018, 0.05);
const boardTexCache = new Map<string, THREE.MeshStandardMaterial>();

export function makeBoard(color: string): THREE.Mesh {
  let m = boardTexCache.get(color);
  if (!m) {
    const tex = boardTexture(color);
    m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.05 });
    // planar map from above
    boardTexCache.set(color, m);
  }
  const mesh = new THREE.Mesh(boardGeo, m);
  // generate simple top-down UVs once
  if (!boardGeo.userData.uvd) {
    const p = boardGeo.attributes.position as THREE.BufferAttribute;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv[i * 2] = p.getX(i) / 0.56 + 0.5;
      uv[i * 2 + 1] = p.getZ(i) / 1.3 + 0.5;
    }
    boardGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    boardGeo.userData.uvd = true;
  }
  mesh.castShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ rider
export interface Avatar {
  root: THREE.Group; // at feet, facing +z (direction of travel)
  body: THREE.Group; // rotated for stance
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  board: THREE.Mesh;
  height: number;
}

function limb(len: number, r: number, m: THREE.Material) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - r * 2, 3, 8), m);
  mesh.position.y = -len / 2;
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

export function makeAvatar(look: Look): Avatar {
  const s = look.height / 1.75;
  const skin = mat(look.skin, { rough: 0.6 });
  const top = mat(look.top, { rough: 0.8 });
  const bottom = mat(look.bottom, { rough: 0.8 });
  const hairM = mat(look.hair, { rough: 0.9 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const hips = new THREE.Group();
  hips.position.y = 0.92 * s;
  body.add(hips);

  const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.15 * s, 0.12 * s, 3, 8), bottom);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.castShadow = true;
  hips.add(pelvis);

  const torso = new THREE.Group();
  hips.add(torso);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17 * s, 0.32 * s, 4, 10), top);
  chest.position.y = 0.3 * s;
  chest.scale.set(1.1, 1, 0.75);
  chest.castShadow = true;
  torso.add(chest);

  const head = new THREE.Group();
  head.position.y = 0.68 * s;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115 * s, 16, 12), skin);
  skull.position.y = 0.1 * s;
  skull.castShadow = true;
  head.add(skull);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.1 * s, 8), skin);
  head.add(neck);
  // simple eyes so faces read at a distance
  const eyeM = mat('#1a1a1a', { rough: 0.3 });
  for (const ex of [-0.04, 0.04]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014 * s, 6, 6), eyeM);
    eye.position.set(ex * s, 0.12 * s, 0.105 * s);
    head.add(eye);
  }
  addHair(head, look.hairStyle, hairM, s);

  const shoulderY = 0.52 * s;
  const armL = limb(0.3 * s, 0.05 * s, top);
  armL.position.set(0.22 * s, shoulderY, 0);
  const armR = limb(0.3 * s, 0.05 * s, top);
  armR.position.set(-0.22 * s, shoulderY, 0);
  torso.add(armL, armR);
  const foreL = limb(0.28 * s, 0.042 * s, skin);
  foreL.position.y = -0.3 * s;
  armL.add(foreL);
  const foreR = limb(0.28 * s, 0.042 * s, skin);
  foreR.position.y = -0.3 * s;
  armR.add(foreR);

  const legL = limb(0.46 * s, 0.07 * s, bottom);
  legL.position.set(0.1 * s, 0, 0);
  const legR = limb(0.46 * s, 0.07 * s, bottom);
  legR.position.set(-0.1 * s, 0, 0);
  hips.add(legL, legR);
  const shinL = limb(0.46 * s, 0.055 * s, skin);
  shinL.position.y = -0.46 * s;
  legL.add(shinL);
  const shinR = limb(0.46 * s, 0.055 * s, skin);
  shinR.position.y = -0.46 * s;
  legR.add(shinR);

  const board = makeBoard(look.board);
  root.add(board);
  return { root, body, hips, torso, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, board, height: look.height };
}

/**
 * A one-draw-call stand-in for a distant rider: every body part of `a` (in its current pose,
 * board excluded) merged into one mesh, coloured per vertex. A full avatar is ~18 draw calls
 * (36 with its reflection), which is what made the village slow on Quest.
 */
const lodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
export function makeAvatarLod(a: Avatar): THREE.Mesh {
  a.root.updateMatrixWorld(true);
  const toRoot = a.root.matrixWorld.clone().invert();
  const parts: THREE.BufferGeometry[] = [];
  a.body.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld));
    const c = (o.material as THREE.MeshStandardMaterial).color;
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  });
  const mesh = new THREE.Mesh(mergeGeometries(parts)!, lodMat);
  mesh.castShadow = true;
  return mesh;
}

function addHair(head: THREE.Group, style: Look['hairStyle'], m: THREE.Material, s: number) {
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x * s, y * s, z * s);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    head.add(mesh);
  };
  const cap = new THREE.SphereGeometry(0.122 * s, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
  switch (style) {
    case 'bald':
      break;
    case 'short':
      add(cap, 0, 0.11, -0.005);
      break;
    case 'long':
      add(cap, 0, 0.11, -0.005);
      add(new THREE.BoxGeometry(0.22 * s, 0.3 * s, 0.08 * s), 0, -0.02, -0.08);
      break;
    case 'bun':
      add(cap, 0, 0.11, -0.005);
      add(new THREE.SphereGeometry(0.06 * s, 10, 8), 0, 0.2, -0.09);
      break;
    case 'curly':
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        add(new THREE.SphereGeometry(0.055 * s, 8, 6), Math.cos(a) * 0.09, 0.19 + Math.sin(i) * 0.02, Math.sin(a) * 0.08 - 0.02);
      }
      add(cap, 0, 0.12, -0.005, 1.1, 1.1, 1.1);
      break;
    case 'mohawk':
      add(new THREE.BoxGeometry(0.04 * s, 0.1 * s, 0.24 * s), 0, 0.24, -0.01);
      break;
  }
}

export interface PoseParams {
  mode: 'foot' | 'board' | 'air' | 'wipeout' | 'idle' | 'sit';
  crouch: number; // 0..1
  lean: number; // -1..1
  runPhase: number;
  runAmount: number; // 0..1
  boardYaw: number;
  armsOut: number; // 0..1 (gliding)
  wave: number; // 0..1 waving hello
  talk: number; // 0..1 gesturing while talking
  time: number;
}

/** Board stance is sideways (regular foot, left foot forward), like real skimboarding. */
export function poseAvatar(a: Avatar, p: PoseParams) {
  const s = a.height / 1.75;
  const riding = p.mode === 'board' || p.mode === 'air';
  a.board.visible = riding;
  a.board.rotation.set(0, p.boardYaw, 0);
  a.board.position.set(0, 0.02, 0);

  if (riding) {
    a.body.rotation.set(0, -Math.PI / 2 * 0.85 + p.boardYaw, 0);
    const c = 0.15 + p.crouch * 0.6;
    a.hips.position.y = (0.92 - c * 0.38) * s;
    a.body.rotation.z = 0;
    // lean into the turn: tilt body toward the inside rail
    a.hips.rotation.set(0, 0, 0);
    a.root.rotation.z = -p.lean * 0.32;
    a.torso.rotation.set(c * 0.35, 0, p.lean * 0.15);
    a.legL.rotation.set(-c * 0.9, 0, 0.32);
    a.legR.rotation.set(-c * 0.9, 0, -0.32);
    a.shinL.rotation.set(c * 1.6, 0, 0);
    a.shinR.rotation.set(c * 1.6, 0, 0);
    const out = 0.9 + p.armsOut * 0.6;
    a.armL.rotation.set(0.2, 0, out + Math.sin(p.time * 2) * 0.05);
    a.armR.rotation.set(-0.2, 0, -out - Math.sin(p.time * 2.3) * 0.05);
    a.foreL.rotation.set(-0.3, 0, 0);
    a.foreR.rotation.set(-0.3, 0, 0);
    a.head.rotation.set(0, Math.PI / 2 * 0.8 - p.boardYaw, 0);
  } else if (p.mode === 'wipeout') {
    a.root.rotation.z = Math.sin(p.time * 9) * 0.6;
    a.body.rotation.set(-1.2, p.time * 4, 0);
    a.hips.position.y = 0.35 * s;
    a.armL.rotation.set(-2, 0, 0.5);
    a.armR.rotation.set(-2, 0, -0.5);
  } else {
    a.root.rotation.z = 0;
    a.body.rotation.set(0, 0, 0);
    const run = p.runAmount;
    const ph = p.runPhase;
    a.hips.position.y = (0.92 - p.crouch * 0.3 - Math.abs(Math.sin(ph)) * 0.04 * run) * s;
    a.torso.rotation.set(0.25 * run + p.crouch * 0.3, 0, 0);
    a.legL.rotation.set(Math.sin(ph) * 0.9 * run - p.crouch * 0.6, 0, 0.04);
    a.legR.rotation.set(-Math.sin(ph) * 0.9 * run - p.crouch * 0.6, 0, -0.04);
    a.shinL.rotation.set(Math.max(0, -Math.cos(ph)) * 1.2 * run + p.crouch * 1.1, 0, 0);
    a.shinR.rotation.set(Math.max(0, Math.cos(ph)) * 1.2 * run + p.crouch * 1.1, 0, 0);
    const breathe = Math.sin(p.time * 1.6) * 0.03;
    a.armL.rotation.set(-Math.sin(ph) * 1.0 * run, 0, 0.12 + breathe);
    a.armR.rotation.set(Math.sin(ph) * 1.0 * run, 0, -0.12 - breathe);
    a.foreL.rotation.set(-0.3 - run * 0.9, 0, 0);
    a.foreR.rotation.set(-0.3 - run * 0.9, 0, 0);
    if (p.wave > 0) {
      a.armR.rotation.set(0, 0, -2.6 * p.wave);
      a.foreR.rotation.set(0, 0, -0.4 + Math.sin(p.time * 10) * 0.5 * p.wave);
    } else if (p.talk > 0) {
      a.armR.rotation.x = -0.6 - Math.sin(p.time * 3.1) * 0.25 * p.talk;
      a.foreR.rotation.x = -0.9 + Math.sin(p.time * 4.3) * 0.3 * p.talk;
      a.armL.rotation.x = -0.3 - Math.sin(p.time * 2.3 + 1) * 0.2 * p.talk;
    }
    a.head.rotation.set(Math.sin(p.time * 0.7) * 0.05, Math.sin(p.time * 0.37) * 0.25 * (1 - run), 0);
  }
}

// ------------------------------------------------------------------ name tag
export function makeNameTag(text: string, sub: string, color = '#ffffff'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8,20,30,0.55)';
  roundRect(g, 8, 8, 496, 112, 36);
  g.fill();
  g.fillStyle = color;
  g.font = '600 50px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(text, 256, 62);
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.font = '400 30px system-ui, sans-serif';
  g.fillText(sub, 256, 102);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, fog: false }));
  sp.scale.set(1.6, 0.4, 1);
  sp.renderOrder = 5;
  return sp;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ------------------------------------------------------------------ sail + wing
export function makeSail(color = '#f7f3e8'): THREE.Group {
  const g = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 3.4, 6), mat('#d9d9d9', { metal: 0.6, rough: 0.3 }));
  mast.position.y = 1.7;
  g.add(mast);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.3);
  shape.lineTo(0, 3.3);
  shape.quadraticCurveTo(1.0, 2.0, 1.6, 0.35);
  shape.lineTo(0, 0.3);
  const sailGeo = new THREE.ShapeGeometry(shape, 12);
  const sail = new THREE.Mesh(
    sailGeo,
    new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.6, transparent: true, opacity: 0.92 }),
  );
  sail.name = 'sailcloth';
  sail.castShadow = true;
  g.add(sail);
  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(0.05, 2.9),
    new THREE.MeshBasicMaterial({ color: '#ff6b35', side: THREE.DoubleSide }),
  );
  stripe.position.set(0.5, 1.8, 0.002);
  stripe.rotation.z = -0.35;
  g.add(stripe);
  return g;
}

export function makeWing(color = '#219ebc'): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-3.2, 0);
  shape.quadraticCurveTo(-1.6, 0.9, 0, 1.1);
  shape.quadraticCurveTo(1.6, 0.9, 3.2, 0);
  shape.quadraticCurveTo(0, 0.35, -3.2, 0);
  const geo = new THREE.ShapeGeometry(shape, 16);
  geo.rotateX(-Math.PI / 2);
  const wing = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.5, emissive: color, emissiveIntensity: 0.15 }),
  );
  wing.castShadow = true;
  g.add(wing);
  const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 6.4, 6), mat('#333333'));
  spar.rotation.z = Math.PI / 2;
  spar.position.z = -0.3;
  g.add(spar);
  return g;
}

// ------------------------------------------------------------------ skim boat
export function makeSkimBoat(hullColor: string, accent: string, sailColor: string, name: string): THREE.Group {
  const g = new THREE.Group();
  const L = 34;
  const W = 12;
  const hull = new THREE.Mesh(boardGeometry(L, W, 0.6, 1.8), mat(hullColor, { rough: 0.35 }));
  hull.castShadow = true;
  hull.receiveShadow = true;
  g.add(hull);
  // stripe along the rail
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 64), mat(accent, { rough: 0.4 }));
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(W / 2 + 0.05, L / 2 + 0.05, 1);
  rim.position.y = 0.75;
  g.add(rim);
  // deck planks
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.08, L * 0.62), mat('#b98a5a', { rough: 0.85 }));
  deck.position.y = 0.88;
  deck.receiveShadow = true;
  g.add(deck);
  // cabin aft
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 6), mat('#f2ead8'));
  cabin.position.set(0, 2.1, -9);
  cabin.castShadow = true;
  g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.25, 7), mat(accent));
  roof.position.set(0, 3.4, -9);
  roof.castShadow = true;
  g.add(roof);
  const win = mat('#ffd98a', { emissive: '#ffb347', ei: 0.6 });
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.8, 3.5), win);
    w.position.set(sx * 2.53, 2.3, -9);
    g.add(w);
  }
  // mast + big sail
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 16, 8), mat('#6b4a2b'));
  mast.position.set(0, 8.9, 1);
  mast.castShadow = true;
  g.add(mast);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0, 13);
  shape.quadraticCurveTo(4, 7, 7.5, 0.5);
  shape.lineTo(0, 0);
  const sail = new THREE.Mesh(
    new THREE.ShapeGeometry(shape, 16),
    new THREE.MeshStandardMaterial({ color: sailColor, side: THREE.DoubleSide, roughness: 0.7 }),
  );
  sail.rotation.y = Math.PI / 2;
  sail.position.set(0, 2.5, 1.2);
  sail.castShadow = true;
  sail.name = 'boatsail';
  g.add(sail);
  // railing posts
  const postM = mat('#5a3d22');
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 5), postM);
    post.position.set(Math.cos(a) * (W / 2 - 1.3), 1.4, Math.sin(a) * (L / 2 - 2.6));
    g.add(post);
  }
  // lanterns
  const lantern = mat('#ffcf6e', { emissive: '#ffae42', ei: 2 });
  for (const z of [-14, 13]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), lantern);
    l.position.set(0, 2.2, z);
    l.name = 'lantern';
    g.add(l);
  }
  // name board
  const tag = makeNameTag(name, 'skimboat', '#ffe7b0');
  tag.position.set(0, 4.6, -9);
  tag.scale.set(4.8, 1.2, 1);
  g.add(tag);
  return g;
}

export const BOAT_DIMS = { length: 34, width: 12, deck: 0.92 };

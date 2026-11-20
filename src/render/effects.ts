// Water + air effects: spray, wake ribbon, wind streaks, waterfalls, thermals, gulls.

import * as THREE from 'three';
import { CHUTE_ANGLES, LIFT, MESA, mesaInfo, THERMALS, windAt } from '../../shared/world';

// ------------------------------------------------------------------ spray
export class Spray {
  readonly N = 2400;
  points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  uniforms = { uScale: { value: 800 }, uColor: { value: new THREE.Color('#f4fbff') }, uGlow: { value: 0 } };

  constructor() {
    const N = this.N;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N);
    this.maxLife = new Float32Array(N).fill(1);
    this.size = new Float32Array(N);
    this.alpha = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; uniform float uScale; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale * projectionMatrix[1][1] / max(-mv.z, 0.1);
          vA = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uGlow; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = dot(c, c);
          if (d > 0.25) discard;
          float a = vA * smoothstep(0.25, 0.05, d);
          vec3 col = mix(uColor, vec3(0.2, 0.95, 1.0) * 2.0, uGlow);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, spread: number, size = 0.08, life = 0.9) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.N;
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      this.vel[i * 3] = vx + (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 1] = vy + Math.random() * spread * 0.6;
      this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * spread;
      this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.life[i] = this.maxLife[i];
      this.size[i] = size * (0.6 + Math.random() * 0.9);
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      const drag = 1 - dt * 1.2;
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 1.5) * 0.85;
      this.size[i] *= 1 + dt * 0.8;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ wake ribbon
export class Wake {
  readonly N = 120;
  mesh: THREE.Mesh;
  private samples: Array<{ x: number; y: number; z: number; rx: number; rz: number; t: number; s: number }> = [];
  private pos: Float32Array;
  private uv: Float32Array;
  private alpha: Float32Array;
  private lastT = -1;
  uniforms = { uGlow: { value: 0 } };

  constructor(private life = 2.6) {
    const N = this.N;
    this.pos = new Float32Array(N * 2 * 3);
    this.uv = new Float32Array(N * 2 * 2);
    this.alpha = new Float32Array(N * 2);
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying float vA; varying vec2 vUv;
        void main() { vA = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uGlow; varying float vA; varying vec2 vUv;
        void main() {
          float e = abs(vUv.x * 2.0 - 1.0);
          float edge = smoothstep(0.55, 0.95, e) * (1.0 - smoothstep(0.95, 1.0, e));
          float center = (1.0 - e) * 0.25;
          float n = 0.75 + 0.25 * sin(vUv.y * 90.0 + vUv.x * 13.0);
          float a = (edge * n + center) * vA;
          vec3 col = mix(vec3(0.97, 0.99, 1.0), vec3(0.2, 1.0, 1.0) * 1.8, uGlow);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** strength 0 = not touching water */
  push(x: number, y: number, z: number, heading: number, strength: number, time: number) {
    if (time - this.lastT < 0.05) return;
    this.lastT = time;
    this.samples.unshift({ x, y: y + 0.02, z, rx: -Math.cos(heading), rz: Math.sin(heading), t: time, s: strength });
    if (this.samples.length > this.N) this.samples.pop();
  }

  update(time: number) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      const s = this.samples[Math.min(i, this.samples.length - 1)];
      if (!s) {
        this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0;
        continue;
      }
      const age = time - s.t;
      const w = 0.28 + age * 1.6;
      const a = i < this.samples.length ? Math.max(0, 1 - age / this.life) * s.s : 0;
      this.pos[i * 6] = s.x + s.rx * w;
      this.pos[i * 6 + 1] = s.y;
      this.pos[i * 6 + 2] = s.z + s.rz * w;
      this.pos[i * 6 + 3] = s.x - s.rx * w;
      this.pos[i * 6 + 4] = s.y;
      this.pos[i * 6 + 5] = s.z - s.rz * w;
      this.uv[i * 4] = 0;
      this.uv[i * 4 + 1] = i / N;
      this.uv[i * 4 + 2] = 1;
      this.uv[i * 4 + 3] = i / N;
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = a * (i === 0 ? 0 : 1);
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ wind streaks
export class WindStreaks {
  readonly N = 160;
  lines: THREE.LineSegments;
  private p: Float32Array;
  private seeds: Float32Array;
  private mat: THREE.LineBasicMaterial;

  constructor() {
    this.p = new Float32Array(this.N * 6);
    this.seeds = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; i++) {
      this.seeds[i * 3] = (Math.random() - 0.5) * 120;
      this.seeds[i * 3 + 1] = 0.3 + Math.random() * 5;
      this.seeds[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
  }

  update(dt: number, focus: THREE.Vector3, time: number, groundY: number) {
    const w = windAt(focus.x, focus.z, time);
    const ws = Math.hypot(w.x, w.z);
    this.mat.opacity = Math.min(0.55, Math.max(0, (ws - 5) / 14));
    if (this.mat.opacity <= 0) return;
    const L = 1.2 + ws * 0.12;
    for (let i = 0; i < this.N; i++) {
      let sx = this.seeds[i * 3] + w.x * dt * 1.4;
      let sz = this.seeds[i * 3 + 2] + w.z * dt * 1.4;
      if (sx > 60) sx -= 120;
      if (sx < -60) sx += 120;
      if (sz > 60) sz -= 120;
      if (sz < -60) sz += 120;
      this.seeds[i * 3] = sx;
      this.seeds[i * 3 + 2] = sz;
      const x = focus.x + sx;
      const z = focus.z + sz;
      const y = groundY + this.seeds[i * 3 + 1];
      this.p[i * 6] = x;
      this.p[i * 6 + 1] = y;
      this.p[i * 6 + 2] = z;
      this.p[i * 6 + 3] = x - (w.x / ws) * L;
      this.p[i * 6 + 4] = y;
      this.p[i * 6 + 5] = z - (w.z / ws) * L;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ waterfalls
export function makeWaterfalls(): { mesh: THREE.Mesh; uniforms: { uTime: { value: number } }; spots: Array<{ x: number; z: number }> } {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const spots: Array<{ x: number; z: number }> = [];
  const liftAng = Math.atan2(LIFT.base.z - MESA.z, LIFT.base.x - MESA.x);
  let v = 0;
  for (let deg = 0; deg < 360; deg += 7) {
    const ang = (deg * Math.PI) / 180;
    if (CHUTE_ANGLES.some((a) => Math.cos(ang - a) > 0.9)) continue;
    if (Math.cos(ang - liftAng) > 0.97) continue;
    const probe = mesaInfo(MESA.x + Math.cos(ang) * 150, MESA.z + Math.sin(ang) * 150);
    const r0 = probe.rEdge + 1.5;
    const width = 9 + (deg % 3) * 3;
    const tx = -Math.sin(ang);
    const tz = Math.cos(ang);
    const ox = Math.cos(ang);
    const oz = Math.sin(ang);
    const rows = 8;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const y = MESA.h + 0.3 - t * (MESA.h + 1.5);
      const out = 2 + Math.pow(t, 0.6) * 9 + Math.sin(t * 3) * 0.6;
      for (const side of [-0.5, 0.5]) {
        const cx = MESA.x + ox * (r0 + out) + tx * side * width;
        const cz = MESA.z + oz * (r0 + out) + tz * side * width;
        pos.push(cx, y, cz);
        uv.push(side + 0.5 + deg * 0.13, t);
      }
      if (j < rows) {
        const a = v + j * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    v += (rows + 1) * 2;
    spots.push({ x: MESA.x + ox * (r0 + 11), z: MESA.z + oz * (r0 + 11) });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      float h(float x){ return fract(sin(x * 91.7) * 4375.85); }
      void main() {
        float col = floor(vUv.x * 40.0);
        float speed = 0.9 + h(col) * 0.6;
        float s = fract(vUv.y * 3.0 - uTime * speed + h(col + 3.0));
        float streak = smoothstep(0.0, 0.2, s) * smoothstep(1.0, 0.5, s);
        float edge = smoothstep(0.0, 0.08, fract(vUv.x)) * smoothstep(1.0, 0.92, fract(vUv.x));
        float a = (0.55 + streak * 0.45) * edge;
        gl_FragColor = vec4(mix(vec3(0.82, 0.97, 1.0), vec3(1.15), streak) * 1.1, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return { mesh, uniforms, spots };
}

// ------------------------------------------------------------------ thermals
export function makeThermals(): { points: THREE.Points; uniforms: { uTime: { value: number }; uScale: { value: number } } } {
  const per = 90;
  const pos: number[] = [];
  const seed: number[] = [];
  for (const th of THERMALS) {
    for (let i = 0; i < per; i++) {
      pos.push(th.x, 0, th.z);
      seed.push(Math.random(), Math.random(), th.r);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3));
  const uniforms = { uTime: { value: 0 }, uScale: { value: 800 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aSeed; uniform float uTime; uniform float uScale; varying float vA;
      void main() {
        float t = fract(aSeed.x + uTime * 0.03);
        float a = aSeed.y * 6.2831 + uTime * (0.4 + aSeed.y * 0.4);
        float r = aSeed.z * (0.3 + 0.7 * aSeed.y) * (0.6 + t * 0.6);
        vec3 p = position + vec3(cos(a) * r, 2.0 + t * 90.0, sin(a) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = 0.35 * uScale * projectionMatrix[1][1] / max(-mv.z, 0.1);
        vA = sin(t * 3.14159) * 0.5;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.85), vA * smoothstep(0.25, 0.0, d)); }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  return { points, uniforms };
}

// ------------------------------------------------------------------ gulls
export class Gulls {
  group = new THREE.Group();
  private birds: Array<{ obj: THREE.Object3D; cx: number; cz: number; r: number; h: number; sp: number; ph: number; wingL: THREE.Mesh; wingR: THREE.Mesh }> = [];
  constructor(centers: Array<[number, number, number]>) {
    const m = new THREE.MeshStandardMaterial({ color: '#f4f4f4', side: THREE.DoubleSide, roughness: 0.8 });
    const wingGeo = new THREE.PlaneGeometry(0.7, 0.22);
    wingGeo.translate(0.35, 0, 0);
    for (const [cx, cz, h] of centers) {
      for (let i = 0; i < 4; i++) {
        const obj = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.3, 2, 6), m);
        body.rotation.x = Math.PI / 2;
        obj.add(body);
        const wingL = new THREE.Mesh(wingGeo, m);
        const wingR = new THREE.Mesh(wingGeo, m);
        wingR.scale.x = -1;
        wingL.rotation.x = wingR.rotation.x = -Math.PI / 2;
        obj.add(wingL, wingR);
        this.group.add(obj);
        this.birds.push({ obj, cx, cz, r: 25 + Math.random() * 40, h: h + Math.random() * 15, sp: 0.15 + Math.random() * 0.15, ph: Math.random() * 6.28, wingL, wingR });
      }
    }
  }
  update(time: number) {
    for (const b of this.birds) {
      const a = b.ph + time * b.sp;
      b.obj.position.set(b.cx + Math.cos(a) * b.r, b.h + Math.sin(time * 0.5 + b.ph) * 2, b.cz + Math.sin(a) * b.r);
      b.obj.rotation.set(0, -a, 0.35);
      const flap = Math.sin(time * 9 + b.ph) * 0.5;
      b.wingL.rotation.y = flap;
      b.wingR.rotation.y = -flap;
    }
  }
}

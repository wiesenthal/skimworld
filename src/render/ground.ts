// The everywhere-film: streamed terrain chunks rendered with a MeshStandardMaterial
// patched for (a) the sea's travelling waves, (b) wind ripples + expanding ripple
// rings from every board, footstep and landing, (c) flowing chute streaks,
// (d) bioluminescent glow in Glowmarsh, and (e) a Fresnel alpha so the mirrored
// sky / mirrored stilt houses show through as reflections.

import * as THREE from 'three';
import { smoothstep } from '../../shared/noise';
import { FILM, MESA, mesaInfo, regionWeights, seaMask, terrainHeight, type RegionId } from '../../shared/world';

export const CHUNK = 128;
const RIPPLES = 32;

const SAND: Record<RegionId | 'base', string> = {
  base: '#dcc79d',
  tidewell: '#ecd9b0',
  saltglass: '#f5f3ee',
  brinehook: '#e6c993',
  highfall: '#c4623c',
  glowmarsh: '#3d3656',
};
const WATER: Record<RegionId | 'base', string> = {
  base: '#49bec6',
  tidewell: '#25d6c6',
  saltglass: '#9cc8e6',
  brinehook: '#1a86b4',
  highfall: '#19c9a2',
  glowmarsh: '#170c3a',
};

const glslCommon = /* glsl */ `
uniform float uTime;
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// MUST match shared/world.ts waveHeight()
float waveH(vec2 p, float t) {
  float m = sstep(860.0, 960.0, p.y) * (1.0 - sstep(380.0, 650.0, abs(p.x + 250.0)));
  if (m <= 0.0) return -100.0;
  float phase = 6.28318530718 * (p.y + 6.2 * t) / 42.0 + 0.25 * sin(p.x * 0.013);
  float s = 0.5 + 0.5 * sin(phase);
  float crest = s * s * s * s;
  float amp = (0.5 + 1.2 * sstep(1250.0, 1030.0, p.y)) * sstep(900.0, 980.0, p.y);
  return m * amp * (crest * 2.2 - 0.35);
}
`;

export class Ground {
  material: THREE.MeshStandardMaterial;
  uniforms = {
    uTime: { value: 0 },
    uRip: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },
    uMirror: { value: 0.85 },
    uGlow: { value: 0 },
    uCalm: { value: 0 },
    uMesa: { value: new THREE.Vector2(MESA.x, MESA.z) },
  };
  private ripIdx = 0;
  private chunks = new Map<string, THREE.Mesh>();
  private pool: THREE.Mesh[] = [];
  private queue: Array<[number, number]> = [];
  private index: THREE.BufferAttribute;
  group = new THREE.Group();

  constructor(private seg = 48, private radius = 2) {
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.07,
      metalness: 0.0,
      transparent: true,
      depthWrite: true,
    });
    this.material.onBeforeCompile = (shader) => this.patch(shader);
    this.material.customProgramCacheKey = () => 'skim-ground-v1';

    const n = seg + 1;
    const idx: number[] = [];
    for (let j = 0; j < seg; j++)
      for (let i = 0; i < seg; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1);
    this.group.name = 'ground';
  }

  ripple(x: number, z: number, strength: number, time: number) {
    const r = this.uniforms.uRip.value[this.ripIdx];
    r.set(x, z, time, strength);
    this.ripIdx = (this.ripIdx + 1) % RIPPLES;
  }

  private patch(shader: THREE.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${glslCommon}
attribute float aGround;
attribute float aFlow;
attribute vec3 aTint;
varying float vDepth;
varying vec2 vXZ;
varying float vSteep;
varying float vFoam;
varying float vFlow;
varying vec3 vTint;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float gW = waveH(position.xz, uTime);
float gSurf = max(aGround + ${FILM.toFixed(3)}, gW);
vec3 objectNormal = vec3(normal);
vFoam = 0.0;
if (gW > aGround + ${FILM.toFixed(3)}) {
  float e = 0.7;
  float hx = waveH(position.xz + vec2(e, 0.0), uTime) - waveH(position.xz - vec2(e, 0.0), uTime);
  float hz = waveH(position.xz + vec2(0.0, e), uTime) - waveH(position.xz - vec2(0.0, e), uTime);
  objectNormal = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
  vFoam = smoothstep(0.55, 1.6, gW) * smoothstep(0.25, 0.9, abs(hz / (2.0 * e)) * 2.0 + 0.2);
}
vDepth = gSurf - aGround;
vXZ = position.xz;
vSteep = objectNormal.y;
vFlow = aFlow;
vTint = aTint;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, gSurf, position.z);');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec4 uRip[${RIPPLES}];
uniform float uMirror;
uniform float uGlow;
uniform float uCalm;
uniform vec2 uMesa;
varying float vDepth;
varying vec2 vXZ;
varying float vSteep;
varying float vFoam;
varying float vFlow;
varying vec3 vTint;
float gEnergy = 0.0;
float sstepf(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec2 rippleGrad(vec2 p) {
  float calm = 1.0 - uCalm * 0.8;
  vec2 g = vec2(0.0);
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 3.1 + uTime * 2.2) * 0.014 * calm;
  g += vec2(-0.5, 0.85) * cos(dot(p, vec2(-0.5, 0.85)) * 5.3 + uTime * 3.1) * 0.009 * calm;
  g += vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 11.7 + uTime * 4.3) * 0.006 * calm;
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 3.2 || r.w <= 0.0) continue;
    vec2 dp = p - r.xy;
    float d = length(dp) + 1e-3;
    float rad = age * 2.8;
    float x = d - rad;
    float env = exp(-x * x * 2.5) * r.w * (1.0 - age / 3.2) / (1.0 + rad * 0.5);
    g += (dp / d) * cos(x * 8.0) * env * 0.45;
    gEnergy += env;
  }
  if (vFlow > 0.0) {
    vec2 dir = normalize(p - uMesa);
    float s = sin(dot(p, dir) * 1.3 - uTime * 11.0 + sin(dot(p, vec2(-dir.y, dir.x)) * 0.7) * 2.0);
    g += dir * s * 0.09 * vFlow;
    gEnergy += max(s, 0.0) * vFlow * 0.4;
  }
  return g;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float water = sstepf(0.02, 0.9, vDepth);
vec3 wetSand = mix(diffuseColor.rgb * 0.55, vTint * 0.8, 0.32);
vec3 waterCol = mix(vTint, vTint * 0.3, sstepf(0.3, 2.5, vDepth));
diffuseColor.rgb = mix(wetSand, waterCol, water * 0.9);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.98, 1.0), clamp(vFoam + vFlow * 0.12, 0.0, 1.0));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
vec2 rg = rippleGrad(vXZ);
vec3 dn = (viewMatrix * vec4(-rg.x, 0.0, -rg.y, 0.0)).xyz;
normal = normalize(normal + dn * sstepf(0.3, 0.8, vSteep));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float glowN = 0.5 + 0.5 * sin(vXZ.x * 0.21 + uTime * 0.7) * sin(vXZ.y * 0.17 - uTime * 0.5);
totalEmissiveRadiance += vec3(0.08, 0.85, 1.0) * uGlow * (min(gEnergy, 2.0) * 1.6 + glowN * 0.05 * sstepf(0.2, 1.0, vDepth));`,
      )
      .replace(
        '#include <opaque_fragment>',
        `float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 5.0);
float waterness = sstepf(0.35, 0.75, vSteep);
float refl = mix(0.22, 1.0, fres) * uMirror * waterness * (1.0 - vFoam * 0.8);
gl_FragColor = vec4(outgoingLight, 1.0 - refl * 0.94);`,
      );
  }

  update(focus: THREE.Vector3, time: number, mirror: number, glow: number, calm: number, immediate = false) {
    this.uniforms.uTime.value = time;
    this.uniforms.uMirror.value = mirror;
    this.uniforms.uGlow.value = glow;
    this.uniforms.uCalm.value = calm;

    const ccx = Math.floor(focus.x / CHUNK);
    const ccz = Math.floor(focus.z / CHUNK);
    const want = new Set<string>();
    for (let dz = -this.radius; dz <= this.radius; dz++)
      for (let dx = -this.radius; dx <= this.radius; dx++) want.add(`${ccx + dx},${ccz + dz}`);
    for (const [key, mesh] of this.chunks) {
      if (!want.has(key)) {
        this.chunks.delete(key);
        mesh.visible = false;
        this.pool.push(mesh);
      }
    }
    for (const key of want) {
      if (this.chunks.has(key) || this.queue.some(([x, z]) => `${x},${z}` === key)) continue;
      const [x, z] = key.split(',').map(Number);
      this.queue.push([x, z]);
    }
    // nearest first
    this.queue.sort((a, b) => Math.hypot(a[0] - ccx, a[1] - ccz) - Math.hypot(b[0] - ccx, b[1] - ccz));
    this.queue = this.queue.filter(([x, z]) => want.has(`${x},${z}`));
    let budget = immediate ? Infinity : 1;
    while (budget-- > 0 && this.queue.length) {
      const [x, z] = this.queue.shift()!;
      this.chunks.set(`${x},${z}`, this.build(x, z));
    }
  }

  get pending() {
    return this.queue.length;
  }

  private build(cx: number, cz: number): THREE.Mesh {
    const seg = this.seg;
    const n = seg + 1;
    const step = CHUNK / seg;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    // heights with a 1-vertex border for normals
    const nb = n + 2;
    const hb = new Float32Array(nb * nb);
    const sb = new Float32Array(nb * nb);
    for (let j = 0; j < nb; j++)
      for (let i = 0; i < nb; i++) {
        const g = terrainHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
        hb[j * nb + i] = g;
        sb[j * nb + i] = Math.max(g + FILM, 0);
      }

    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const tint = new Float32Array(n * n * 3);
    const gnd = new Float32Array(n * n);
    const flow = new Float32Array(n * n);
    const cS = new THREE.Color();
    const cW = new THREE.Color();
    const tmp = new THREE.Color();
    const rock = new THREE.Color('#8a3f26');
    const sandBase = new THREE.Color(SAND.base);
    const waterBase = new THREE.Color(WATER.base);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const bi = (j + 1) * nb + (i + 1);
        const x = x0 + i * step;
        const z = z0 + j * step;
        const y = sb[bi];
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        gnd[k] = hb[bi];
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        const dx = (sb[bi + 1] - sb[bi - 1]) / (2 * step);
        const dz = (sb[bi + nb] - sb[bi - nb]) / (2 * step);
        const l = Math.hypot(dx, 1, dz);
        nor[k * 3] = -dx / l;
        nor[k * 3 + 1] = 1 / l;
        nor[k * 3 + 2] = -dz / l;

        const w = regionWeights(x, z);
        cS.copy(sandBase);
        cW.copy(waterBase);
        for (const id of Object.keys(w) as RegionId[]) {
          if (w[id] <= 0) continue;
          cS.lerp(tmp.set(SAND[id]), w[id]);
          cW.lerp(tmp.set(WATER[id]), w[id]);
        }
        const slope = Math.hypot(dx, dz);
        cS.lerp(rock, smoothstep(0.6, 1.5, slope));
        const mottle = 0.94 + 0.12 * Math.sin(x * 0.31 + Math.sin(z * 0.27) * 2);
        col[k * 3] = cS.r * mottle;
        col[k * 3 + 1] = cS.g * mottle;
        col[k * 3 + 2] = cS.b * mottle;
        tint[k * 3] = cW.r;
        tint[k * 3 + 1] = cW.g;
        tint[k * 3 + 2] = cW.b;

        const dm = Math.hypot(x - MESA.x, z - MESA.z);
        if (dm < MESA.r + 260 && dm > MESA.r - 40) {
          const m = mesaInfo(x, z);
          flow[k] =
            m.chute * smoothstep(m.rEdge - 4, m.rEdge + 6, m.d) * smoothstep(m.rEdge + m.width + 10, m.rEdge + m.width - 20, m.d);
        }
        if (seaMask(x, z) > 0) {
          maxY = Math.max(maxY, 2.5);
          minY = Math.min(minY, -1);
        }
      }

    let mesh = this.pool.pop();
    let geo: THREE.BufferGeometry;
    if (mesh) {
      geo = mesh.geometry;
      (geo.getAttribute('position') as THREE.BufferAttribute).copyArray(pos).needsUpdate = true;
      (geo.getAttribute('normal') as THREE.BufferAttribute).copyArray(nor).needsUpdate = true;
      (geo.getAttribute('color') as THREE.BufferAttribute).copyArray(col).needsUpdate = true;
      (geo.getAttribute('aTint') as THREE.BufferAttribute).copyArray(tint).needsUpdate = true;
      (geo.getAttribute('aGround') as THREE.BufferAttribute).copyArray(gnd).needsUpdate = true;
      (geo.getAttribute('aFlow') as THREE.BufferAttribute).copyArray(flow).needsUpdate = true;
    } else {
      geo = new THREE.BufferGeometry();
      geo.setIndex(this.index);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
      geo.setAttribute('aGround', new THREE.BufferAttribute(gnd, 1));
      geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 1));
      mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1; // after other transparents' default order? keep stable
      this.group.add(mesh);
    }
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, minY - 0.5, z0), new THREE.Vector3(x0 + CHUNK, maxY + 0.5, z0 + CHUNK));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    mesh.visible = true;
    return mesh;
  }
}

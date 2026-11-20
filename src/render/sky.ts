// Sky dome + day cycle + regional "vibe". The lower hemisphere renders the sky
// mirrored, so wherever the water film is reflective (transparent at grazing
// angles) you see the sky reflected in it — the core thin-water look.

import * as THREE from 'three';
import { clamp, lerp } from '../../shared/noise';
import type { RegionId } from '../../shared/world';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const frag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uStars;
uniform float uTime;
uniform float uClouds;
varying vec3 vDir;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 d = normalize(vDir);
  float below = step(d.y, 0.0);
  vec3 m = vec3(d.x, abs(d.y), d.z);
  float t = pow(1.0 - m.y, 3.0);
  vec3 col = mix(uZenith, uHorizon, t);
  float sd = max(dot(m, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 14.0 + pow(sd, 10.0) * 0.32 + pow(sd, 2.0) * 0.06);

  // clouds: a soft drifting band
  vec2 cp = m.xz / (m.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
  float c = vnoise(cp) * 0.6 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.1;
  c = smoothstep(0.55, 0.85, c) * smoothstep(0.0, 0.25, m.y) * uClouds;
  vec3 cloudCol = mix(uHorizon * 1.05, uSunColor * 0.9 + 0.1, pow(sd, 3.0) * 0.6);
  col = mix(col, cloudCol, c * 0.75);

  // stars
  vec3 sp = floor(m * 260.0);
  float st = fract(sin(dot(sp, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  float tw = 0.6 + 0.4 * sin(uTime * 3.0 + st * 100.0);
  col += uStars * step(0.9978, st) * smoothstep(0.02, 0.3, m.y) * tw * (1.0 - c);

  col *= mix(1.0, 0.86, below);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface Vibe {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  fogDensity: number;
  stars: number;
  exposure: number;
  glow: number; // bioluminescence
  mirror: number; // how glassy the film reads
}

const C = (h: string) => new THREE.Color(h);

// Base palettes by time of day
const DAY = { zenith: C('#1f6fd1'), horizon: C('#9fd3ef') };
const GOLD = { zenith: C('#2f5ea8'), horizon: C('#ffaa5e') };
const NIGHT = { zenith: C('#030817'), horizon: C('#14223f') };

// Regional overrides (blended by proximity)
const REGION_VIBES: Partial<Record<RegionId, { zenith: THREE.Color; horizon: THREE.Color; amount: number; fogDensity: number; glow: number; mirror: number; stars: number }>> = {
  glowmarsh: { zenith: C('#0d0326'), horizon: C('#5a1a73'), amount: 0.85, fogDensity: 0.0042, glow: 1, mirror: 0.95, stars: 1 },
  saltglass: { zenith: C('#1c6fe0'), horizon: C('#bcdcf2'), amount: 0.45, fogDensity: 0.0006, glow: 0, mirror: 1.0, stars: 0 },
  highfall: { zenith: C('#3f7cc0'), horizon: C('#cfe3ea'), amount: 0.3, fogDensity: 0.0016, glow: 0, mirror: 0.75, stars: 0 },
  brinehook: { zenith: C('#2b7cc4'), horizon: C('#cde9ef'), amount: 0.2, fogDensity: 0.0016, glow: 0, mirror: 0.7, stars: 0 },
  tidewell: { zenith: C('#1d7fd6'), horizon: C('#a8e6ea'), amount: 0.25, fogDensity: 0.0011, glow: 0, mirror: 0.85, stars: 0 },
};

export class SkySystem {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xbfe3ff, 0xe8d3a8, 1.2);
  sunDir = new THREE.Vector3(0.4, 0.5, 0.3).normalize();
  vibe: Vibe = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    fogDensity: 0.0015,
    stars: 0,
    exposure: 1,
    glow: 0,
    mirror: 0.85,
  };
  night = 0;

  constructor(private scene: THREE.Scene, shadows: boolean) {
    this.uniforms = {
      uSunDir: { value: this.sunDir },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uStars: { value: 0 },
      uTime: { value: 0 },
      uClouds: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    scene.fog = new THREE.FogExp2(0xbfe4f2, 0.0015);
    scene.add(this.hemi);
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(1024, 1024);
      const cam = this.sun.shadow.camera;
      cam.left = -45;
      cam.right = 45;
      cam.top = 45;
      cam.bottom = -45;
      cam.near = 1;
      cam.far = 260;
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.04;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);
  }

  update(hour: number, time: number, focus: THREE.Vector3, weights: Record<RegionId, number>) {
    // Sun path: rises ~6, sets ~19
    const dayT = (hour - 6.5) / 12.5;
    const elev = Math.sin(clamp(dayT, -0.25, 1.25) * Math.PI) * 1.15;
    const az = lerp(-1.9, 1.9, dayT);
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev) * 0.6 - 0.4).normalize();
    const sunUp = this.sunDir.y;

    const golden = clamp(1 - Math.abs(sunUp - 0.12) / 0.22, 0, 1);
    const night = clamp((0.05 - sunUp) / 0.2, 0, 1);
    this.night = night;
    const z = this.vibe.zenith.copy(DAY.zenith).lerp(GOLD.zenith, golden).lerp(NIGHT.zenith, night);
    const hz = this.vibe.horizon.copy(DAY.horizon).lerp(GOLD.horizon, golden).lerp(NIGHT.horizon, night);
    let fogDensity = 0.0012;
    let stars = night;
    let glow = 0;
    let mirror = 0.8;
    let wsum = 0;
    for (const [id, v] of Object.entries(REGION_VIBES)) {
      const w = (weights[id as RegionId] ?? 0) * v!.amount;
      if (w <= 0) continue;
      z.lerp(v!.zenith, w * (id === 'glowmarsh' ? 1 : 1 - night * 0.8));
      hz.lerp(v!.horizon, w * (id === 'glowmarsh' ? 1 : 1 - night * 0.8));
      fogDensity = lerp(fogDensity, v!.fogDensity, w);
      stars = Math.max(stars, v!.stars * w);
      glow = Math.max(glow, v!.glow * w);
      mirror = lerp(mirror, v!.mirror, w);
      wsum += w;
    }
    void wsum;
    this.vibe.fogDensity = fogDensity;
    this.vibe.stars = stars;
    this.vibe.glow = Math.max(glow, night * 0.35);
    this.vibe.mirror = mirror;
    this.vibe.fog.copy(hz);

    (this.uniforms.uZenith.value as THREE.Color).copy(z);
    (this.uniforms.uHorizon.value as THREE.Color).copy(hz);
    this.uniforms.uStars.value = stars;
    this.uniforms.uTime.value = time;
    const sunCol = this.uniforms.uSunColor.value as THREE.Color;
    sunCol.setRGB(1, lerp(0.95, 0.62, golden), lerp(0.86, 0.38, golden)).multiplyScalar(1 - night * 0.9);

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(hz);
    fog.density = fogDensity;

    // lights
    const glowDim = 1 - (weights.glowmarsh ?? 0) * 0.75;
    this.sun.intensity = clamp(sunUp * 6, 0, 1) * 3.2 * glowDim + night * 0.25;
    this.sun.color.copy(sunCol).lerp(new THREE.Color('#9fb6ff'), night);
    const lightDir = night > 0.5 ? new THREE.Vector3(-0.3, 0.8, 0.4) : this.sunDir;
    this.sun.position.copy(focus).addScaledVector(lightDir, 120);
    this.sun.target.position.copy(focus);
    this.hemi.color.copy(z).lerp(new THREE.Color('#ffffff'), 0.45);
    this.hemi.groundColor.copy(hz).multiplyScalar(0.6);
    this.hemi.intensity = lerp(1.25, 0.35, night) * glowDim + (weights.glowmarsh ?? 0) * 0.35;

    this.mesh.position.copy(focus);
  }
}

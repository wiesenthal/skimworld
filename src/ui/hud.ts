// HUD: HTML overlay on desktop; a wrist display + floating callouts in VR.

import * as THREE from 'three';
import { roundRect } from '../render/models';
import { CanvasPanel } from './panel';

export interface HudState {
  speed: number; // m/s
  flow: number;
  mode: string;
  pump: number; // recent pump accel (m/s^2)
  sailEff: number | null;
  hour: number;
  day: number;
  region: string;
  hint: string;
  ai: string;
}

export class Hud {
  private el = {
    speed: document.getElementById('speed')!,
    flow: document.getElementById('flowbar')!,
    pump: document.getElementById('pumpbar')!,
    sail: document.getElementById('sail')!,
    mode: document.getElementById('mode')!,
    clock: document.getElementById('clock')!,
    region: document.getElementById('region')!,
    hint: document.getElementById('hint')!,
    pops: document.getElementById('pops')!,
    ai: document.getElementById('ai')!,
    help: document.getElementById('help')!,
  };
  wrist = new CanvasPanel(512, 300, 0.17);
  private popGroup = new THREE.Group();
  private vrPops: Array<{ sprite: THREE.Sprite; t: number }> = [];
  private last = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.popGroup);
  }

  toggleHelp() {
    this.el.help.classList.toggle('hidden');
  }

  pop(text: string, kind: 'big' | 'small' | 'region' = 'big', vrHead?: { pos: THREE.Vector3; dir: THREE.Vector3 }) {
    const d = document.createElement('div');
    d.className = `pop ${kind}`;
    d.textContent = text;
    this.el.pops.appendChild(d);
    setTimeout(() => d.remove(), kind === 'region' ? 3600 : 1700);
    if (vrHead) this.vrPop(text, kind, vrHead);
  }

  private vrPop(text: string, kind: string, head: { pos: THREE.Vector3; dir: THREE.Vector3 }) {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 192;
    const g = c.getContext('2d')!;
    g.font = `800 ${kind === 'big' ? 96 : 64}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(0,30,40,0.6)';
    g.strokeText(text, 512, 96);
    g.fillStyle = kind === 'region' ? '#ffe7b0' : '#ffffff';
    g.fillText(text, 512, 96);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
    sp.renderOrder = 20;
    const dir = head.dir.clone().setY(0).normalize();
    sp.position.copy(head.pos).addScaledVector(dir, 2.4).add(new THREE.Vector3(0, 0.35, 0));
    sp.scale.set(1.4, 0.26, 1);
    this.popGroup.add(sp);
    this.vrPops.push({ sprite: sp, t: 0 });
  }

  updateVR(dt: number, head: { pos: THREE.Vector3; dir: THREE.Vector3 }) {
    for (const p of this.vrPops) {
      p.t += dt;
      const dir = head.dir.clone().setY(0).normalize();
      const target = head.pos.clone().addScaledVector(dir, 2.4).add(new THREE.Vector3(0, 0.35 + p.t * 0.12, 0));
      p.sprite.position.lerp(target, Math.min(1, dt * 8));
      (p.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - Math.max(0, p.t - 1.1) / 0.6);
    }
    for (const p of this.vrPops.filter((x) => x.t > 1.7)) {
      this.popGroup.remove(p.sprite);
      (p.sprite.material as THREE.SpriteMaterial).map?.dispose();
    }
    this.vrPops = this.vrPops.filter((x) => x.t <= 1.7);
  }

  update(s: HudState, vr: boolean) {
    const kph = Math.round(s.speed * 3.6);
    this.el.speed.textContent = String(kph);
    this.el.flow.style.width = `${Math.round(s.flow * 100)}%`;
    const pumpPct = Math.max(-1, Math.min(1, s.pump / 4));
    this.el.pump.style.width = `${Math.abs(pumpPct) * 50}%`;
    this.el.pump.style.left = pumpPct >= 0 ? '50%' : `${50 - Math.abs(pumpPct) * 50}%`;
    this.el.pump.className = pumpPct >= 0 ? 'good' : 'bad';
    this.el.sail.textContent = s.sailEff === null ? '' : `sail trim ${Math.round(s.sailEff * 100)}%`;
    this.el.mode.textContent = s.mode;
    const hh = Math.floor(s.hour);
    const mm = Math.floor((s.hour - hh) * 60);
    this.el.clock.textContent = `Day ${s.day} · ${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
    this.el.region.textContent = s.region;
    this.el.hint.textContent = s.hint;
    this.el.hint.style.opacity = s.hint ? '1' : '0';
    this.el.ai.textContent = s.ai;

    if (!vr) return;
    const key = `${kph}|${Math.round(s.flow * 20)}|${s.mode}|${hh}:${Math.floor(mm / 5)}|${s.hint}|${s.region}`;
    if (key === this.last) return;
    this.last = key;
    const P = this.wrist;
    const g = P.g;
    P.clear('rgba(8,22,32,0.85)', 30);
    g.fillStyle = '#ffffff';
    g.font = '800 96px system-ui, sans-serif';
    g.fillText(String(kph), 28, 108);
    const numW = g.measureText(String(kph)).width;
    g.font = '500 30px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('km/h', 40 + numW, 106);
    g.fillText(this.el.clock.textContent ?? '', 290, 50);
    g.fillText(s.region, 290, 92);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    roundRect(g, 28, 140, 456, 26, 13);
    g.fill();
    const grd = g.createLinearGradient(28, 0, 484, 0);
    grd.addColorStop(0, '#3fd6c8');
    grd.addColorStop(1, '#ff7ae0');
    g.fillStyle = grd;
    roundRect(g, 28, 140, Math.max(26, 456 * s.flow), 26, 13);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '500 26px system-ui, sans-serif';
    g.fillText(`FLOW · ${s.mode}`, 28, 205);
    g.fillStyle = '#ffe7b0';
    g.font = '400 24px system-ui, sans-serif';
    g.fillText(s.hint.slice(0, 40), 28, 256);
    P.commit();
  }
}

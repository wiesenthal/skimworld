// A canvas-textured plane for in-headset UI, with clickable regions.

import * as THREE from 'three';
import { roundRect } from '../render/models';

export interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CanvasPanel {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  regions: Region[] = [];
  hover: string | null = null;

  constructor(public pw: number, public ph: number, worldW: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: true, toneMapped: false, side: THREE.DoubleSide, fog: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, (worldW * ph) / pw), mat);
    this.mesh.renderOrder = 10;
  }

  clear(bg = 'rgba(10,24,34,0.82)', radius = 36) {
    const g = this.g;
    g.clearRect(0, 0, this.pw, this.ph);
    g.fillStyle = bg;
    roundRect(g, 4, 4, this.pw - 8, this.ph - 8, radius);
    g.fill();
    this.regions = [];
  }

  button(id: string, label: string, x: number, y: number, w: number, h: number, accent = '#3fd6c8') {
    const g = this.g;
    const hot = this.hover === id;
    g.fillStyle = hot ? accent : 'rgba(255,255,255,0.12)';
    roundRect(g, x, y, w, h, h / 2);
    g.fill();
    g.fillStyle = hot ? '#06222a' : '#ffffff';
    g.font = `500 ${Math.round(h * 0.42)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + w / 2, y + h / 2, w - 24);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    this.regions.push({ id, x, y, w, h });
  }

  commit() {
    this.tex.needsUpdate = true;
  }

  hitTest(uv: THREE.Vector2): string | null {
    const x = uv.x * this.pw;
    const y = (1 - uv.y) * this.ph;
    for (const r of this.regions) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    return null;
  }
}

export function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > width && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out;
}

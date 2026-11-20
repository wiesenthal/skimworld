// Procedural soundscape. No samples: filtered noise and oscillators.
//  - board hiss: the film tearing under the board, pitch/volume follow speed
//  - spray: skid hiss, wind rush: speed^2, splash one-shots, pump whoosh
//  - ambient per region + a generative pad that swells with Flow

import type { RegionId } from '../../shared/world';

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private hiss!: { f: BiquadFilterNode; g: GainNode };
  private spray!: { f: BiquadFilterNode; g: GainNode };
  private wind!: { f: BiquadFilterNode; g: GainNode };
  private surf!: { f: BiquadFilterNode; g: GainNode };
  private falls!: { f: BiquadFilterNode; g: GainNode };
  private pad!: { oscs: OscillatorNode[]; g: GainNode; f: BiquadFilterNode };
  private chordIdx = 0;
  private chordTimer = 0;
  muted = false;
  private voiceSrc: AudioBufferSourceNode | null = null;
  private voiceGain: GainNode | null = null;

  /** Play a villager's spoken line (mp3 bytes). Replaces any line still playing. */
  async playVoice(mp3: ArrayBuffer): Promise<boolean> {
    if (!this.ctx) this.start();
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    const buf = await ctx.decodeAudioData(mp3);
    this.stopVoice();
    if (!this.voiceGain) {
      this.voiceGain = ctx.createGain();
      this.voiceGain.connect(ctx.destination); // straight out: keep speech clear of the mix compressor
    }
    this.voiceGain.gain.value = this.muted ? 0 : 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.voiceGain);
    src.start();
    this.voiceSrc = src;
    return true;
  }

  stopVoice() {
    try {
      this.voiceSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.voiceSrc = null;
  }

  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // pink-ish mix
      d[i] = w * 0.55 + b * 2.5;
    }
    this.hiss = this.loop('bandpass', 900, 0.8);
    this.spray = this.loop('highpass', 2600, 0.5);
    this.wind = this.loop('lowpass', 400, 0.5);
    this.surf = this.loop('lowpass', 500, 0.7);
    this.falls = this.loop('lowpass', 1200, 0.4);

    const padG = ctx.createGain();
    padG.gain.value = 0;
    const padF = ctx.createBiquadFilter();
    padF.type = 'lowpass';
    padF.frequency.value = 900;
    padF.connect(padG).connect(this.master);
    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      const og = ctx.createGain();
      og.gain.value = 0.18;
      o.connect(og).connect(padF);
      o.start();
      oscs.push(o);
    }
    this.pad = { oscs, g: padG, f: padF };
    this.setChord(0);
  }

  private loop(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return { f, g };
  }

  private setChord(i: number) {
    // Dmaj9 -> Bm9 -> Gmaj7#11 -> Aadd9 : sunny, open
    const chords = [
      [146.83, 220.0, 277.18, 329.63],
      [123.47, 185.0, 220.0, 293.66],
      [98.0, 146.83, 185.0, 277.18],
      [110.0, 164.81, 246.94, 329.63],
    ];
    const c = chords[i % chords.length];
    const t = this.ctx!.currentTime;
    this.pad.oscs.forEach((o, k) => o.frequency.setTargetAtTime(c[k], t, 0.8));
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx!.currentTime, 0.1);
  }

  update(
    dt: number,
    s: { speed: number; riding: boolean; airborne: boolean; skid: number; flow: number; depth: number; surfNear: number; fallsNear: number; region: RegionId; glow: number },
  ) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = 0.06;
    const ride = s.riding && !s.airborne ? 1 : 0;
    const v = s.speed;
    this.hiss.g.gain.setTargetAtTime(ride * Math.min(0.55, v * 0.04), t, k);
    this.hiss.f.frequency.setTargetAtTime(500 + v * 90 + (s.depth > 0.3 ? -200 : 0), t, k);
    this.spray.g.gain.setTargetAtTime(ride * s.skid * Math.min(0.6, v * 0.06), t, k);
    this.wind.g.gain.setTargetAtTime(Math.min(0.5, v * v * 0.0012), t, k);
    this.wind.f.frequency.setTargetAtTime(250 + v * 40, t, k);
    this.surf.g.gain.setTargetAtTime(s.surfNear * 0.35, t, 0.4);
    this.falls.g.gain.setTargetAtTime(s.fallsNear * 0.4, t, 0.4);
    this.pad.g.gain.setTargetAtTime(0.025 + s.flow * 0.11 + s.glow * 0.04, t, 0.8);
    this.pad.f.frequency.setTargetAtTime(600 + s.flow * 2200, t, 0.5);
    this.chordTimer += dt;
    if (this.chordTimer > 7) {
      this.chordTimer = 0;
      this.setChord(++this.chordIdx);
    }
  }

  splash(strength: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3500, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    const g = ctx.createGain();
    const v = Math.min(0.9, 0.12 + strength * 0.15);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45 + strength * 0.08);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 1);
  }

  step(strength: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400 + Math.random() * 600;
    f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 + strength * 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.2);
  }

  whoosh(strength: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.12 + strength * 0.05, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.5);
  }

  chime(level: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const base = [587.33, 739.99, 880.0, 1174.66];
    base.slice(0, 2 + Math.min(2, level)).forEach((freq, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = ctx.createGain();
      const st = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.12, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.7);
      o.connect(g).connect(this.master);
      o.start(st);
      o.stop(st + 0.8);
    });
  }

  thud() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.35);
  }
}

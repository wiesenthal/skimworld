// Conversations with villagers. Desktop: HTML panel with a text box.
// Quest: a floating panel by the villager; point + trigger to pick a reply, or talk freely:
// hold A (or tap "Speak") and say anything. The clip is transcribed on the server, because
// the Quest browser has no SpeechRecognition.
// Replies are spoken aloud with each villager's own voice settings.

import * as THREE from 'three';
import type { Npc } from '../game/npcs';
import { api, type ChatContext } from '../net/api';
import { micSupported, record, type Recording } from './mic';
import { CanvasPanel, wrap } from './panel';

type Line = { who: 'npc' | 'you'; text: string };

const report = (e: string, d = '') => (window as unknown as { __skimReport?: (e: string, d: string) => void }).__skimReport?.(e, d);

const SR: (new () => SpeechRecognitionLike) | undefined =
  (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

// Speech synthesis is missing in some browsers (the Quest browser among them). Touching the
// bare global there threw inside new Game(), so nothing on the page worked. Always go through this.
const synth = (): SpeechSynthesis | undefined =>
  typeof SpeechSynthesisUtterance === 'undefined' ? undefined : (window as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? undefined;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export class Dialog {
  npc: Npc | null = null;
  lines: Line[] = [];
  suggestions: string[] = [];
  busy = false;
  /** Freeform talk: idle, recording you, or waiting for the transcription. */
  mic: 'idle' | 'listening' | 'hearing' = 'idle';
  micNote = '';
  private recording: Recording | null = null;
  private recordingStarting = false;
  private stopWhenStarted = false;
  aiLive: boolean | null = null;
  panel = new CanvasPanel(1024, 680, 1.25);
  private el: HTMLElement;
  private input: HTMLInputElement;
  private voices: SpeechSynthesisVoice[] = [];

  constructor(
    private context: () => ChatContext,
    private onClose: () => void,
    private voiceOut?: { play: (mp3: ArrayBuffer) => Promise<boolean>; stop: () => void },
  ) {
    this.panel.mesh.visible = false;
    this.el = document.getElementById('dialog')!;
    this.input = this.el.querySelector('input')!;
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = this.input.value.trim();
      if (t) this.send(t);
      this.input.value = '';
    });
    this.el.querySelector('.close')!.addEventListener('click', () => this.close());
    this.el.querySelector('.mic')!.addEventListener('click', () => this.listen());
    if (!this.canSpeak) (this.el.querySelector('.mic') as HTMLElement).style.display = 'none';
    const load = () => (this.voices = (synth()?.getVoices() ?? []).filter((v) => v.lang.startsWith('en')));
    load();
    synth()?.addEventListener?.('voiceschanged', load);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation();
    });
  }

  get open() {
    return !!this.npc;
  }

  get canSpeak() {
    return micSupported() || !!SR;
  }

  start(npc: Npc) {
    if (this.npc === npc) return;
    this.close();
    this.npc = npc;
    this.lines = [];
    this.suggestions = [];
    this.el.classList.add('open');
    this.el.querySelector('.who')!.textContent = npc.p.name;
    this.el.querySelector('.role')!.textContent = npc.p.role;
    this.panel.mesh.visible = true;
    this.send('');
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    if (!this.npc) return;
    this.npc.endTalk();
    this.npc = null;
    this.recording?.cancel();
    this.recording = null;
    this.stopWhenStarted = false;
    this.mic = 'idle';
    this.micNote = '';
    this.speakSeq++;
    synth()?.cancel();
    this.voiceOut?.stop();
    this.el.classList.remove('open');
    this.panel.mesh.visible = false;
    this.input.blur();
    this.onClose();
  }

  async send(text: string) {
    const npc = this.npc;
    if (!npc || this.busy) return;
    if (text) this.lines.push({ who: 'you', text });
    this.busy = true;
    this.suggestions = [];
    this.render();
    try {
      const r = await api.chat(npc.p.id, text, this.context());
      if (this.npc !== npc) return;
      this.aiLive = r.ai;
      this.lines.push({ who: 'npc', text: r.reply });
      this.suggestions = r.suggestions;
      this.speak(r.reply, r.voiceSig);
    } catch {
      if (this.npc !== npc) return;
      this.aiLive = false;
      const fallback = text ? "Sorry — the wind took that. Say again?" : npc.p.greeting;
      this.lines.push({ who: 'npc', text: fallback });
      this.suggestions = ['Any riding tips?', 'Tell me about this place.', 'See you around!'];
      this.speak(fallback);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  pick(id: string) {
    if (id === 'bye') return this.close();
    if (id === 'speak') return this.mic === 'listening' ? this.stopListening() : this.listen();
    if (id.startsWith('s')) {
      const s = this.suggestions[Number(id.slice(1))];
      if (s) {
        if (/see you|bye|later/i.test(s)) {
          this.lines.push({ who: 'you', text: s });
          this.send(s).then(() => setTimeout(() => this.close(), 2500));
        } else this.send(s);
      }
    }
  }

  /** Start talking: records until you go quiet, tap again, or let go of A. */
  listen() {
    if (!this.npc || this.busy || this.mic !== 'idle' || this.recordingStarting) return;
    // Hush the villager so the mic hears you, not them.
    this.speakSeq++;
    synth()?.cancel();
    this.voiceOut?.stop();
    if (!micSupported()) return this.listenBrowser();
    const npc = this.npc;
    this.recordingStarting = true;
    this.stopWhenStarted = false;
    this.micNote = '';
    this.mic = 'listening';
    this.render();
    record()
      .then((rec) => {
        this.recordingStarting = false;
        if (this.npc !== npc) return rec.cancel();
        this.recording = rec;
        if (this.stopWhenStarted) rec.stop();
        return rec.done.then((clip) => this.heard(npc, clip));
      })
      .catch((e: unknown) => {
        this.recordingStarting = false;
        const name = e instanceof Error ? e.name : '';
        report('mic-fail', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        this.mic = 'idle';
        this.micNote = name === 'NotAllowedError' ? 'Mic blocked: allow it for this site in browser settings' : "Couldn't open the mic";
        this.render();
      });
  }

  /** Done talking (tap again / A released): send what was said. */
  stopListening() {
    if (this.recording) this.recording.stop();
    else if (this.recordingStarting) this.stopWhenStarted = true;
  }

  private async heard(npc: Npc, clip: Blob | null) {
    this.recording = null;
    if (this.npc !== npc) return;
    if (!clip) {
      this.mic = 'idle';
      this.micNote = "Didn't catch anything. Hold A and talk.";
      return this.render();
    }
    this.mic = 'hearing';
    this.render();
    let text = '';
    try {
      text = await api.hear(clip);
    } catch (e) {
      report('hear-fail', String(e));
    }
    if (this.npc !== npc) return;
    this.mic = 'idle';
    if (!text.trim()) {
      this.micNote = "Didn't catch that. Try again?";
      return this.render();
    }
    this.micNote = '';
    void this.send(text.trim());
  }

  /** Desktop browsers with built-in speech recognition and no MediaRecorder. */
  private listenBrowser() {
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    this.mic = 'listening';
    this.render();
    rec.onresult = (e) => {
      const t = e.results[0]?.[0]?.transcript;
      if (t) this.send(t);
    };
    rec.onend = rec.onerror = () => {
      this.mic = 'idle';
      this.render();
    };
    rec.start();
  }

  private speakSeq = 0;

  /** Speak a villager line: the server's voice (works on Quest) first, the browser's own TTS as a fallback. */
  private speak(text: string, sig?: string) {
    const npc = this.npc;
    if (!npc) return;
    const seq = ++this.speakSeq;
    synth()?.cancel();
    this.voiceOut?.stop();
    if (sig && this.voiceOut) {
      void api.voice(npc.p.id, text, sig).then(async (mp3) => {
        if (seq !== this.speakSeq || this.npc !== npc) return; // closed or a newer line came in
        const played = mp3 ? await this.voiceOut!.play(mp3).catch(() => false) : false;
        if (!played) this.speakLocal(text);
      });
      return;
    }
    this.speakLocal(text);
  }

  private speakLocal(text: string) {
    const tts = synth();
    if (!this.npc || !tts) return;
    tts.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = this.npc.p.voice.pitch;
    u.rate = this.npc.p.voice.rate;
    if (this.voices.length) {
      let h = 0;
      for (const c of this.npc.p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      u.voice = this.voices[h % this.voices.length];
    }
    tts.speak(u);
  }

  private micStatus(): string {
    if (this.mic === 'listening') return 'Listening… (stop talking, or let go of A, to send)';
    if (this.mic === 'hearing') return 'Hearing you…';
    return this.micNote;
  }

  /** Keep the VR panel beside the villager, facing you. */
  place(head: THREE.Vector3) {
    if (!this.npc) return;
    const n = this.npc.position;
    const toHead = new THREE.Vector3(head.x - n.x, 0, head.z - n.z).normalize();
    const side = new THREE.Vector3(-toHead.z, 0, toHead.x);
    const p = new THREE.Vector3().copy(n).addScaledVector(toHead, 0.9).addScaledVector(side, 0.85);
    p.y = head.y - 0.15;
    this.panel.mesh.position.lerp(p, 0.2);
    this.panel.mesh.lookAt(head);
  }

  render() {
    // HTML
    const log = this.el.querySelector('.log')!;
    log.innerHTML = '';
    for (const l of this.lines.slice(-6)) {
      const d = document.createElement('div');
      d.className = l.who;
      d.textContent = l.text;
      log.appendChild(d);
    }
    if (this.busy) {
      const d = document.createElement('div');
      d.className = 'npc typing';
      d.textContent = '…';
      log.appendChild(d);
    }
    const status = this.micStatus();
    if (status) {
      const d = document.createElement('div');
      d.className = 'you typing';
      d.textContent = status;
      log.appendChild(d);
    }
    const micBtn = this.el.querySelector('.mic') as HTMLButtonElement;
    micBtn.textContent = this.mic === 'listening' ? '■' : '🎤';
    micBtn.classList.toggle('on', this.mic === 'listening');
    log.scrollTop = log.scrollHeight;
    const chips = this.el.querySelector('.chips')!;
    chips.innerHTML = '';
    this.suggestions.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.onclick = () => this.pick(`s${i}`);
      chips.appendChild(b);
    });
    const badge = this.el.querySelector('.badge')!;
    badge.textContent = this.aiLive === null ? '' : this.aiLive ? 'live mind' : 'scripted (no AI key)';

    // VR panel
    const P = this.panel;
    const g = P.g;
    P.clear();
    if (!this.npc) return P.commit();
    g.fillStyle = '#ffffff';
    g.font = '700 46px system-ui, sans-serif';
    g.fillText(this.npc.p.name, 44, 76);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '400 28px system-ui, sans-serif';
    g.fillText(this.npc.p.role.slice(0, 60), 44, 116);
    // Lay out newest-first from the bottom so the latest reply is always fully visible;
    // older lines scroll off the top. A very long reply drops to a smaller size to fit.
    const top = 150, bottom = 478;
    const busyH = this.busy ? 46 : 0;
    type Row = { text: string; font: string; color: string; h: number };
    const rowsFor = (l: { who: string; text: string }, small: boolean): Row[] => {
      const npc = l.who === 'npc';
      const size = small ? 28 : npc ? 34 : 30;
      const font = `${npc ? '' : 'italic '}400 ${size}px system-ui, sans-serif`;
      g.font = font;
      const color = npc ? '#ffffff' : '#8fe9df';
      return wrap(g, npc ? l.text : `You: ${l.text}`, 936).map((text) => ({ text, font, color, h: size + 8 }));
    };
    const blocks: Row[][] = [];
    let used = busyH;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      let rows = rowsFor(this.lines[i], false);
      let h = rows.reduce((a, r) => a + r.h, 0) + 10;
      if (blocks.length === 0 && used + h > bottom - top) {
        rows = rowsFor(this.lines[i], true);
        h = rows.reduce((a, r) => a + r.h, 0) + 10;
        while (rows.length > 1 && used + h > bottom - top) {
          h -= rows.pop()!.h;
          rows[rows.length - 1].text += '…';
        }
      }
      if (blocks.length && used + h > bottom - top) break;
      blocks.unshift(rows);
      used += h;
    }
    let y = top + 26;
    for (const rows of blocks) {
      for (const r of rows) {
        g.font = r.font;
        g.fillStyle = r.color;
        g.fillText(r.text, 44, y);
        y += r.h;
      }
      y += 10;
    }
    if (this.busy) {
      g.font = '400 34px system-ui, sans-serif';
      g.fillStyle = '#8fe9df';
      g.fillText('…', 44, y);
      y += 42;
    }
    if (status) {
      g.font = 'italic 400 28px system-ui, sans-serif';
      g.fillStyle = this.mic === 'idle' ? '#ffb38a' : '#ffcf6e';
      g.fillText(status, 44, Math.min(y, bottom - 4));
    }
    let by = 500;
    this.suggestions.forEach((s, i) => {
      P.button(`s${i}`, s, 40 + (i % 2) * 476, by + Math.floor(i / 2) * 76, 460, 64);
    });
    by = 500 + 76;
    if (this.canSpeak) P.button('speak', this.mic === 'listening' ? '■ Send' : this.mic === 'hearing' ? 'Hearing…' : '🎤 Speak', 516, by, 220, 64, '#ffcf6e');
    P.button('bye', 'Bye', 756, by, 220, 64, '#ff8b8b');
    P.commit();
  }
}

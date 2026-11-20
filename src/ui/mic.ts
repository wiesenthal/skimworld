// Microphone capture for freeform talk with villagers. The Quest browser has no
// SpeechRecognition, so we record a short clip and the server transcribes it.
//
// Recording stops on its own once you've said something and gone quiet, or when you
// tap again / let go of A. Level polling uses setInterval because requestAnimationFrame
// on window doesn't run during a WebXR session.

const report = (e: string, d = '') => (window as unknown as { __skimReport?: (e: string, d: string) => void }).__skimReport?.(e, d);

export const micSupported = (): boolean =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export interface Recording {
  /** Resolves with the clip (null if nothing was said, or it was cancelled). */
  done: Promise<Blob | null>;
  stop(): void;
  cancel(): void;
}

export interface MicOptions {
  onLevel?: (level: number) => void;
  silenceMs?: number; // quiet time after speech that ends the clip
  maxMs?: number;
  noSpeechMs?: number; // give up if nothing is said for this long
}

/** Ask for mic permission ahead of time (e.g. from the splash, outside VR). */
export async function warmUpMic(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    report('mic-denied', String(e));
    return false;
  }
}

export async function record(opts: MicOptions = {}): Promise<Recording> {
  const { silenceMs = 1300, maxMs = 15000, noSpeechMs = 7000 } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);

  let spoke = false;
  let cancelled = false;
  let lastLoud = performance.now();
  const t0 = performance.now();
  let floor = 0.01; // adapts to background noise

  const done = new Promise<Blob | null>((resolve) => {
    rec.onstop = () => {
      clearInterval(poll);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      const type = rec.mimeType || mimeType || 'audio/webm';
      resolve(cancelled || !spoke || !chunks.length ? null : new Blob(chunks, { type: type.split(';')[0] }));
    };
  });

  const stop = () => rec.state !== 'inactive' && rec.stop();
  const poll = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (!spoke) floor = floor * 0.95 + rms * 0.05;
    const loud = rms > Math.max(0.02, floor * 2.5);
    if (loud) {
      spoke = true;
      lastLoud = now;
    }
    opts.onLevel?.(Math.min(1, rms * 8));
    if ((spoke && now - lastLoud > silenceMs) || now - t0 > maxMs || (!spoke && now - t0 > noSpeechMs)) stop();
  }, 50);

  rec.start(250);
  return {
    done,
    stop: () => {
      // a manual stop counts as "I said something" even if the level detector missed it
      if (performance.now() - t0 > 400) spoke = true;
      stop();
    },
    cancel: () => {
      cancelled = true;
      stop();
    },
  };
}

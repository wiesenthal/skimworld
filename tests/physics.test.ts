import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyInput, Skimmer, type SkimInput } from '../src/game/skimmer';
import { KICKERS, surfaceY, terrainHeight } from '../shared/world';

const DT = 1 / 72;

function run(sk: Skimmer, seconds: number, inp: (t: number) => Partial<SkimInput>) {
  const events: string[] = [];
  let t = 0;
  let crouch = 0;
  while (t < seconds) {
    const i = { ...emptyInput(), ...inp(t) };
    // legs (and the desktop crouch key) move at a finite rate
    crouch += Math.max(-3 * DT, Math.min(3 * DT, i.crouch - crouch));
    i.crouch = crouch;
    sk.update(DT, i);
    for (const e of sk.events) events.push(e.type);
    sk.events.length = 0;
    t += DT;
  }
  return events;
}

// Saltglass is dead flat: a clean lab.
const FLAT = { x: 950, z: -150 };

function runUpAndThrow(sk: Skimmer, hopAt: number | null) {
  sk.place(FLAT.x, FLAT.z, 0);
  let thrownAt = -1;
  const ev = run(sk, 4, (t) => {
    const inp: Partial<SkimInput> = { moveY: 1, run: 1, viewYaw: 0 };
    if (t > 1.6 && thrownAt < 0) {
      thrownAt = t;
      inp.drop = true;
    }
    if (hopAt !== null && thrownAt > 0 && Math.abs(t - thrownAt - hopAt) < DT / 2) inp.jump = true;
    return inp;
  });
  return ev;
}

test('flat film: a board planes for a long glide but does stop', () => {
  const sk = new Skimmer();
  sk.place(FLAT.x, FLAT.z, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.hasBoard = false;
  sk.vz = 9;
  run(sk, 3, () => ({}));
  assert.ok(sk.speed > 4 && sk.speed < 9, `after 3s speed ${sk.speed}`);
  run(sk, 15, () => ({}));
  assert.equal(sk.mode, 'foot');
});

test('perfect drop (hop onto the sliding board) beats running onto it', () => {
  const a = new Skimmer();
  const evA = runUpAndThrow(a, 0.4);
  const b = new Skimmer();
  const evB = runUpAndThrow(b, null);
  assert.ok(evA.includes('perfect-drop') || evA.includes('good-drop'), `hop events: ${evA.join(',')}`);
  assert.ok(evB.includes('sloppy-drop'), `no-hop events: ${evB.join(',')}`);
  assert.equal(a.mode, 'board');
  assert.ok(a.speed > b.speed + 1, `hop ${a.speed.toFixed(2)} vs run-on ${b.speed.toFixed(2)}`);
});

test('pumping the rollers in phase keeps speed; out of phase loses it', () => {
  // Tidewell roller ring: radial sine bumps between r=260..430
  const ride = (mode: 'none' | 'good' | 'bad') => {
    const sk = new Skimmer();
    sk.place(0, 300, 0);
    sk.mode = 'board';
    sk.riding = true;
    sk.hasBoard = false;
    sk.vz = 8;
    run(sk, 6, () => {
      // Real pumping: be compressed over each crest, extend down the back side.
      // Crest/trough phase of the Tidewell rollers is sin(r / 6.5).
      const phase = Math.sin(Math.hypot(sk.x, sk.z) / 6.5);
      if (mode === 'none') return { crouch: 0.5 };
      const want = 0.5 + 0.5 * phase;
      return { crouch: mode === 'good' ? want : 1 - want };
    });
    return sk.speed;
  };
  const none = ride('none');
  const good = ride('good');
  const bad = ride('bad');
  assert.ok(good > none + 0.5, `good ${good.toFixed(2)} vs none ${none.toFixed(2)}`);
  assert.ok(bad < none, `bad ${bad.toFixed(2)} vs none ${none.toFixed(2)}`);
});

test('kickers launch you into the air', () => {
  const k = KICKERS[0];
  const sk = new Skimmer();
  sk.place(k.x, k.z - 12, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.hasBoard = false;
  sk.vz = 10;
  const ev = run(sk, 3, () => ({}));
  assert.ok(ev.includes('launch'), ev.join(','));
  assert.ok(terrainHeight(k.x, k.z + k.len - 0.1) > 1, 'ramp exists');
});

test('water film is everywhere and the lagoon is deep', () => {
  for (let i = 0; i < 200; i++) {
    const x = Math.sin(i * 12.9898) * 1400;
    const z = Math.cos(i * 78.233) * 1400;
    assert.ok(surfaceY(x, z, 0) >= terrainHeight(x, z) + 0.03);
  }
  assert.ok(surfaceY(0, 0, 0) - terrainHeight(0, 0) > 0.5);
});

// Hop-off chains: drop while riding fast = jump off (the board slides on, loose).
// Drop again late in the hop = kick it forward. Land on it = another drop boost.
// `kickWhen` returns true on the frame to kick (null = never kick).
function hopChain(sk: Skimmer, seconds: number, kickWhen: ((sk: Skimmer) => boolean) | null) {
  const events: string[] = [];
  let top = 0;
  let t = 0;
  while (t < seconds) {
    const i = emptyInput();
    if (sk.mode === 'board' && sk.speed > 5) i.drop = true;
    else if (sk.mode === 'air' && sk.board.loose && kickWhen?.(sk)) i.drop = true;
    sk.update(DT, i);
    for (const e of sk.events) events.push(e.type);
    sk.events.length = 0;
    top = Math.max(top, sk.speed);
    t += DT;
  }
  return { events, top };
}

const riding = (v: number) => {
  const sk = new Skimmer();
  sk.place(FLAT.x, FLAT.z, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.hasBoard = false;
  sk.vz = v;
  return sk;
};
// a rider who kicks ~0.1 s before touching down (a flat hop-off lasts ~0.55 s)
const lateKick = (sk: Skimmer) => sk.airTime >= 0.45;
// ...and one who kicks at the top of the hop: it lands, but only "good"
const midKick = (sk: Skimmer) => sk.airTime >= 0.25;

test('hop off, kick it forward late, land on it: chains snowball to scary speed, then taper', () => {
  const sk = riding(9);
  const { events, top } = hopChain(sk, 20, lateKick);
  const drops = events.filter((e) => e === 'perfect-drop').length;
  assert.ok(drops >= 15, `landed perfect ${drops} times: ${events.slice(0, 14).join(',')}`);
  assert.ok(!events.includes('wipeout'), 'well-timed kicks never wipe out');
  assert.ok(top > 30, `top speed ${(top * 3.6).toFixed(0)} km/h should be scary (>108)`);
  assert.ok(top < 70, `top speed ${(top * 3.6).toFixed(0)} km/h should not run away`);
});

test('a kick at the top of the hop builds far less speed than a late one', () => {
  const late = hopChain(riding(9), 8, lateKick).top;
  const mid = hopChain(riding(9), 8, midKick).top;
  assert.ok(late > mid * 1.5, `late ${(late * 3.6).toFixed(0)} vs mid ${(mid * 3.6).toFixed(0)} km/h`);
});

test('mashing hop-off without the kick loses speed', () => {
  const sk = riding(14);
  const { events } = hopChain(sk, 3, null);
  assert.ok(events.includes('sloppy-drop'), events.join(','));
  assert.ok(!events.includes('perfect-drop'));
  assert.ok(sk.speed < 9, `speed ${sk.speed.toFixed(1)} after mashing`);
});

test('kicking the board right as you hop off sends it away: you miss and tumble', () => {
  const sk = riding(16);
  const { events } = hopChain(sk, 1, (s) => s.vy > 0);
  assert.ok(events.includes('wipeout'), events.join(','));
});

test('drop while riding slowly still kicks out with the board in hand', () => {
  const sk = new Skimmer();
  sk.place(FLAT.x, FLAT.z, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.hasBoard = false;
  sk.vz = 3.5;
  run(sk, 2 * DT, (t) => ({ drop: t < DT / 2 }));
  assert.equal(sk.mode, 'foot');
  assert.ok(sk.hasBoard);
});

test('hop first, then toss the board down under you mid-air and land on it', () => {
  const sk = new Skimmer();
  sk.place(FLAT.x, FLAT.z, 0);
  let hopAt = -1;
  let tossed = false;
  const ev = run(sk, 3, (t) => {
    const inp: Partial<SkimInput> = { moveY: 1, run: 1, viewYaw: 0 };
    if (sk.mode === 'foot' && sk.hasBoard && t > 1.6 && hopAt < 0) {
      hopAt = t;
      inp.jump = true;
    }
    if (hopAt > 0 && !tossed && t - hopAt > 0.15) {
      tossed = true;
      inp.drop = true;
    }
    return inp;
  });
  assert.ok(ev.includes('throw'), ev.join(','));
  assert.ok(ev.includes('perfect-drop'), `landed on it: ${ev.join(',')}`);
  assert.equal(sk.mode, 'board');
  assert.ok(sk.speed > 7, `still riding at ${sk.speed.toFixed(1)}`);
});

test('missing the board at speed tumbles you', () => {
  const sk = new Skimmer();
  sk.place(FLAT.x, FLAT.z, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.hasBoard = false;
  sk.vz = 20;
  sk.update(DT, { ...emptyInput(), drop: true });
  sk.board.vz = 0; // board snags and stops dead under you
  sk.board.vx = 0;
  const ev = run(sk, 1.5, () => ({}));
  assert.ok(ev.includes('wipeout'), ev.join(','));
});

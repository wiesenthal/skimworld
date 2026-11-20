import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, deckAt, deckY, LADDERS } from '../shared/villages';
import { ladderToClimb, startClimb, stepClimb } from '../src/game/climb';
import { emptyInput, Skimmer, type Platform } from '../src/game/skimmer';

const DT = 1 / 72;
const L = LADDERS[0];

test('every building has a ladder from the ground to its deck, and the deck is standable', () => {
  assert.equal(LADDERS.length, BUILDINGS.length);
  for (const [i, bd] of BUILDINGS.entries()) {
    const lad = LADDERS[i];
    assert.ok(lad.topY - lad.bottomY > 1, `${bd.id} ladder is ${lad.topY - lad.bottomY}m`);
    // the deck covers the building centre and the ladder's top step-off point...
    assert.equal(deckAt(bd.x, bd.z)?.bd.id, bd.id);
    assert.equal(deckAt(lad.topX, lad.topZ)?.bd.id, bd.id);
    // ...but not where you stand at the foot of the ladder
    assert.notEqual(deckAt(lad.x, lad.z)?.bd.id, bd.id);
    assert.equal(deckY(bd), lad.topY);
  }
});

test('walking into a ladder from below climbs it; standing next to it does not', () => {
  const foot = { x: L.x, y: L.bottomY, z: L.z };
  assert.equal(ladderToClimb(foot, 0, 0, null), null);
  const found = ladderToClimb(foot, -L.nx * 2, -L.nz * 2, null);
  assert.equal(found?.ladder.id, L.id);
  assert.equal(found?.dir, 1);
});

test('in VR, gripping the rails starts a climb without walking', () => {
  const foot = { x: L.x, y: L.bottomY, z: L.z };
  const hand = { x: L.railX, y: L.bottomY + 1.4, z: L.railZ };
  assert.equal(ladderToClimb(foot, 0, 0, null, [hand])?.dir, 1);
  const farHand = { x: L.railX + 2, y: L.bottomY + 1.4, z: L.railZ };
  assert.equal(ladderToClimb(foot, 0, 0, null, [farHand]), null);
});

test('stick climbing reaches the deck; hand-over-hand pulls lift you', () => {
  const st = startClimb(L, 1);
  let at = 'ladder';
  let rungs = 0;
  for (let t = 0; t < 30 && at === 'ladder'; t += DT) {
    const s = stepClimb(st, DT, 1, 0);
    at = s.at;
    if (s.rung) rungs++;
  }
  assert.equal(at, 'top');
  assert.ok(rungs >= 3, `felt ${rungs} rungs`);

  const pull = startClimb(L, 1);
  const y0 = pull.y;
  stepClimb(pull, DT, 0, 0.12); // hand dragged 12 cm down
  assert.ok(Math.abs(pull.y - y0 - 0.12) < 1e-9);
  stepClimb(pull, DT, 0, 0); // hold still: you hang there
  assert.ok(Math.abs(pull.y - y0 - 0.12) < 1e-9);
});

test('from the deck, walking off the ladder edge climbs down to the ground', () => {
  const top = { x: L.topX, y: L.topY, z: L.topZ };
  const found = ladderToClimb(top, L.nx * 2, L.nz * 2, L.id);
  assert.equal(found?.dir, -1);
  const st = startClimb(L, -1);
  let at = 'ladder';
  for (let t = 0; t < 30 && at === 'ladder'; t += DT) at = stepClimb(st, DT, -1, 0).at;
  assert.equal(at, 'bottom');
});

test('riding a board under a house deck does not hop you aboard it (boats still do)', () => {
  const bd = BUILDINGS[0];
  const deck: Platform = { id: bd.id, y: deckY(bd), vx: 0, vz: 0, yawRate: 0, cx: bd.x, cz: bd.z, boardable: false };
  const sk = new Skimmer(1);
  sk.place(bd.x, bd.z, 0);
  sk.mode = 'board';
  sk.riding = true;
  sk.vx = 6;
  sk.update(DT, emptyInput(), () => deck);
  assert.equal(sk.mode, 'board');
  assert.ok(sk.y < deck.y - 1, 'stayed down on the water');

  const boat: Platform = { ...deck, boardable: undefined, y: sk.y + 1 };
  sk.update(DT, emptyInput(), () => boat);
  assert.equal(sk.mode, 'foot');
});

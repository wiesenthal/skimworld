import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { unlocked } from '../server/access';

const req = (key?: string) => ({ headers: key === undefined ? {} : { 'x-skim-key': key } }) as unknown as IncomingMessage;

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('hosted with a key: only the matching header unlocks', () =>
  withEnv({ VERCEL: '1', SKIM_ACCESS_KEY: 'right-key' }, () => {
    assert.equal(unlocked(req('right-key')), true);
    assert.equal(unlocked(req('wrong-key')), false);
    assert.equal(unlocked(req('')), false);
    assert.equal(unlocked(req()), false);
  }));

test('hosted with no key configured: everyone is locked', () =>
  withEnv({ VERCEL: '1', SKIM_ACCESS_KEY: undefined }, () => {
    assert.equal(unlocked(req()), false);
    assert.equal(unlocked(req('anything')), false);
  }));

test('local dev with no key configured: unlocked', () =>
  withEnv({ VERCEL: undefined, SKIM_ACCESS_KEY: undefined }, () => assert.equal(unlocked(req()), true)));

// Who may spend money: only requests carrying the owner's access key get Claude, server
// voice, speech-to-text and paid life ticks. Everyone else still plays, with scripted
// villagers and the browser's own voice.
//  - SKIM_ACCESS_KEY set: the request's x-skim-key header must match it.
//  - Unset on Vercel: nobody is unlocked (fail closed, so a missing env var can't open the bill).
//  - Unset locally: unlocked, so `npm run dev` just works.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function unlocked(req: IncomingMessage): boolean {
  const want = process.env.SKIM_ACCESS_KEY;
  if (!want) return !process.env.VERCEL;
  const got = req.headers['x-skim-key'];
  if (typeof got !== 'string' || !got) return false;
  return timingSafeEqual(digest(got), digest(want));
}

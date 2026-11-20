// Skimworld NPC server: villager conversations + the life simulation.
// In production it also serves the built game from ./dist.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, json } from './api.js';
import { aiStatus } from './brain.js';

// NPC_PORT in dev (Vite proxies /api here); PORT when serving the built game in production.
const PORT = Number(process.env.NPC_PORT ?? (process.env.NODE_ENV === 'production' ? process.env.PORT ?? 8787 : 8787));
const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (await handleApi(req, res)) return;

    // static (production)
    if (existsSync(DIST)) {
      let p = normalize(join(DIST, url.pathname));
      if (!p.startsWith(DIST)) return json(res, 403, { error: 'nope' });
      if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      createReadStream(p).pipe(res);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  const s = aiStatus();
  console.log(`[skimworld] npc server on :${PORT} — villager minds: ${s.ai ? `Claude (${s.model})` : `scripted fallback (${s.reason})`}`);
});

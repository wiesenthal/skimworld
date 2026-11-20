// Vercel function: every /api/* request is rewritten here (vercel.json) and handled by the
// same code the local dev server uses. The built game is served statically from dist/.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi, json } from '../server/api.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if (!(await handleApi(req, res))) json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
}

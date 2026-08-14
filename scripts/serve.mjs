/**
 * A tiny static server for `dist/`, for local development only.
 *
 * The shipped product needs no server at all — it is static files — but a
 * worker and a service worker both require a real origin, so `file://` will not
 * do. Binds to localhost only.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// `URL.pathname` keeps its percent-encoding and its leading slash, so a checkout
// in a directory with a space (or any non-ASCII character) would resolve to a
// path that does not exist. `fileURLToPath` is the only correct conversion.
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  // Contain the path inside dist/ — no traversal out of the served root.
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      // No caching in dev so a rebuild is always what you see.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Vecline Studio → http://localhost:${PORT}`);
});

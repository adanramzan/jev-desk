import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function safePath(base, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const full = normalize(join(base, decoded));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;

  let filePath;

  // /core/* → ROOT/core/* (read-only access for marks.js)
  try {
    if (pathname.startsWith('/core/')) {
      filePath = safePath(join(ROOT, 'core'), pathname.slice('/core'.length));
    } else {
      // Everything else → helpdesk/
      if (pathname === '/') pathname = '/index.html';
      filePath = safePath(join(ROOT, 'helpdesk'), pathname);
    }
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

/**
 * Start the static server.
 * @param {number} [port]
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export function startServer(port = Number(process.env.PORT) || 5180) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(port, () => {
      const url = `http://localhost:${server.address().port}`;
      resolve({
        url,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// Run directly: start and log
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { url } = await startServer();
  console.log(`Helpline server running at ${url}`);
}

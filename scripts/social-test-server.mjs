import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';
import { createSocialService } from '../netlify/functions/social-core.mjs';
import { createMemorySocialStore } from '../netlify/functions/social-memory-store.mjs';

const root = resolve(process.argv[2] || 'manual-app');
const port = Number(process.env.PORT || process.argv[3] || 4173);
const store = createMemorySocialStore();
const service = createSocialService({ store });
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2']
]);

function requestFromNode(req, origin) {
  const url = new URL(req.url || '/', origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) init.body = Readable.toWeb(req);
  if (init.body) init.duplex = 'half';
  return new Request(url, init);
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).pipe(res);
}

function staticPath(pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const safe = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = resolve(join(root, safe));
  return file.startsWith(root) ? file : '';
}

const server = http.createServer(async (req, res) => {
  const origin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const url = new URL(req.url || '/', origin);
  try {
    if (url.pathname === '/__test/events') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ events: await store.listEvents() }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(4) || '/';
      const response = await service(requestFromNode(req, origin), { route });
      await sendWebResponse(res, response);
      return;
    }
    const file = staticPath(url.pathname);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('content-type', MIME.get(extname(file).toLowerCase()) || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Test server failed.' }));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`social test server http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

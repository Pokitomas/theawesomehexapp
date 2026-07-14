import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryStore, createSocialService } from '../netlify/functions/social-core.mjs';

const root = path.resolve(process.argv[2] || 'dist/manual');
const port = Number(process.argv[3] || 4174);
const store = createMemoryStore();
const social = createSocialService({ store });
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.webp', 'image/webp']
]);

async function nodeRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

async function send(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/social')) {
      await send(res, await social(await nodeRequest(req)));
      return;
    }
    let pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    if (pathname === '/' || pathname === '/manual' || pathname === '/manual/') pathname = '/index.html';
    else if (pathname.startsWith('/manual/')) pathname = pathname.slice('/manual'.length);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error('bad path');
    const info = await stat(file);
    const target = info.isDirectory() ? path.join(file, 'index.html') : file;
    res.statusCode = 200;
    res.setHeader('content-type', types.get(path.extname(target)) || 'application/octet-stream');
    res.end(await readFile(target));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ port, root })));

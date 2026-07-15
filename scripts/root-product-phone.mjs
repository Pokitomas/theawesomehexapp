import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(process.argv[2] || 'dist');
const executablePath = [process.env.CHROME_BIN, process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(candidate => fs.existsSync(candidate));
if (!executablePath) throw new Error('No Chromium executable is available for root product proof.');

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.webp', 'image/webp']
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid path.');
    const info = await stat(target);
    const file = info.isDirectory() ? path.join(target, 'index.html') : target;
    response.statusCode = 200;
    response.setHeader('content-type', types.get(path.extname(file)) || 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function prove({ name, viewport, isMobile = false, screenshot }) {
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const promise = page.locator('#sideways-product-promise');
  await promise.waitFor({ state: 'visible', timeout: 20000 });
  const promiseText = (await promise.innerText()).trim();
  if (!/Discover the public world/i.test(promiseText) || !/private archive that belongs to you/i.test(promiseText)) throw new Error(`${name}: ordinary product promise missing: ${promiseText}`);
  if (/Founder Room|\bMaker\b|protocol|debug/i.test(promiseText)) throw new Error(`${name}: internal vocabulary leaked into default promise: ${promiseText}`);

  const archiveLink = promise.locator('[data-primary-archive="true"]');
  await archiveLink.waitFor({ state: 'visible' });
  const href = await archiveLink.getAttribute('href');
  if (href !== './manual/') throw new Error(`${name}: direct archive route is ${href}`);
  const targetSize = await archiveLink.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
  if (targetSize.height < 44 || targetSize.width < 44) throw new Error(`${name}: archive target is too small ${JSON.stringify(targetSize)}`);

  await page.waitForSelector('[data-root-explanation-control="true"]', { timeout: 30000 });
  const why = page.locator('[data-root-explanation-control="true"]').first();
  await why.click();
  const panelId = await why.getAttribute('aria-controls');
  const panel = page.locator(`#${panelId}`);
  await panel.waitFor({ state: 'visible' });
  const explanation = await panel.innerText();
  for (const term of ['Source eligibility', 'Score contributions', 'Saturation and diversity', 'Why it is present']) {
    if (!explanation.includes(term)) throw new Error(`${name}: explanation missing ${term}`);
  }
  if (!/does not read your private archive/i.test(explanation) || !/grants no publishing or moderation authority/i.test(explanation)) throw new Error(`${name}: explanation crossed privacy or authority boundaries`);

  const reducedMotion = await archiveLink.evaluate(node => getComputedStyle(node).transitionDuration);
  if (!reducedMotion.split(',').every(value => value.trim() === '0s')) throw new Error(`${name}: reduced-motion transition remained ${reducedMotion}`);

  for (const zoom of [200, 400]) {
    const overflow = await promise.evaluate((node, zoom) => {
      document.documentElement.style.fontSize = `${zoom}%`;
      const value = Math.max(0, node.scrollWidth - node.clientWidth);
      document.documentElement.style.fontSize = '';
      return value;
    }, zoom);
    if (overflow > 1) throw new Error(`${name}: promise overflowed at ${zoom}% text zoom by ${overflow}px`);
  }

  const pageOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  if (pageOverflow > 1) throw new Error(`${name}: horizontal overflow ${pageOverflow}px`);

  await context.setOffline(true);
  await why.click();
  await why.click();
  if ((await why.getAttribute('aria-expanded')) !== 'true') throw new Error(`${name}: explanation stopped working offline`);
  await context.setOffline(false);

  await archiveLink.focus();
  const focused = await page.evaluate(() => document.activeElement?.matches?.('[data-primary-archive="true"]') === true);
  if (!focused) throw new Error(`${name}: primary archive link is not keyboard focusable`);
  if (errors.length) throw new Error(`${name}: unexpected page errors: ${errors.join(' | ')}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  return { name, viewport, promise: promiseText, archiveHref: href, explanationTerms: 4, horizontalOverflow: pageOverflow, reducedMotion, offlineExplanation: true };
}

try {
  const phone = await prove({ name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, screenshot: 'root-product-phone.png' });
  const desktop = await prove({ name: 'desktop', viewport: { width: 1440, height: 1000 }, screenshot: 'root-product-desktop.png' });
  process.stdout.write(`${JSON.stringify({ schema: 'sideways-root-product-browser-proof/v1', phone, desktop }, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

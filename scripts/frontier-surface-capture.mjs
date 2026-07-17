#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VIEWPORTS = Object.freeze([
  { id: 'desktop-1280x900', width: 1280, height: 900, isMobile: false, hasTouch: false },
  { id: 'phone-390x844', width: 390, height: 844, isMobile: true, hasTouch: true }
]);
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');

function safeRelative(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Capture path must be repository-relative.');
  return normalized;
}

export function buildCapturePlan(assembly) {
  if (assembly?.schema !== 'frontier-surface-assembly/v1') throw new Error('Unsupported frontier surface assembly.');
  if (!/^[0-9a-f]{64}$/i.test(assembly.assembly_digest || '')) throw new Error('Assembly digest is missing.');
  const entries = [];
  for (const candidate of assembly.candidates || []) {
    const target = safeRelative(candidate.target_prefix);
    if (!candidate.interaction?.selector) throw new Error(`Candidate ${candidate.candidate_id} lacks an interaction selector.`);
    for (const viewport of VIEWPORTS) {
      entries.push(Object.freeze({
        candidate_id: candidate.candidate_id,
        role: candidate.role,
        target_prefix: target,
        visual_grammar_id: candidate.visual_grammar_id,
        interaction: candidate.interaction,
        viewport
      }));
    }
  }
  if (entries.length !== (assembly.candidates || []).length * VIEWPORTS.length) throw new Error('Capture plan is incomplete.');
  return Object.freeze({
    schema: 'frontier-surface-capture-plan/v1',
    assembly_digest: assembly.assembly_digest,
    entries,
    evidence_class: 'headless-browser-fixture',
    real_device_claim: false
  });
}

function chromePath() {
  return [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .filter(Boolean)
    .find(filename => fs.existsSync(filename));
}

async function startServer(root) {
  const base = path.resolve(root);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const normalized = path.normalize(relative);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('path escape');
      let filename = path.resolve(base, normalized);
      if (!filename.startsWith(`${base}${path.sep}`) && filename !== base) throw new Error('path escape');
      const stat = await fsp.stat(filename);
      if (stat.isDirectory()) filename = path.join(filename, 'index.html');
      const bytes = await fsp.readFile(filename);
      response.writeHead(200, { 'content-type': MIME[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(bytes);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

async function shaFile(filename) {
  return digest(await fsp.readFile(filename));
}

export async function captureFrontierAssembly({ repository_root = process.cwd(), assembly, output_directory, executable_path } = {}) {
  const plan = buildCapturePlan(assembly);
  const browserPath = executable_path || chromePath();
  if (!browserPath) throw new Error('No Chromium executable found for frontier surface capture.');
  const { chromium } = await import('playwright-core');
  const output = path.resolve(output_directory);
  await fsp.mkdir(output, { recursive: true });
  const { server, origin } = await startServer(repository_root);
  const browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const captures = [];
  try {
    for (const entry of plan.entries) {
      const context = await browser.newContext({
        viewport: { width: entry.viewport.width, height: entry.viewport.height },
        isMobile: entry.viewport.isMobile,
        hasTouch: entry.viewport.hasTouch,
        deviceScaleFactor: 1
      });
      await context.route(url => url.origin !== origin, route => route.abort('blockedbyclient'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const started = Date.now();
      const url = `${origin}/${entry.target_prefix}/index.html`;
      await page.goto(url, { waitUntil: 'networkidle' });
      const marker = await page.locator(`[data-frontier-candidate="${entry.candidate_id}"]`).count();
      if (marker !== 1) throw new Error(`Candidate marker did not render: ${entry.candidate_id}.`);
      const directory = path.join(output, entry.candidate_id);
      await fsp.mkdir(directory, { recursive: true });
      const before = path.join(directory, `${entry.viewport.id}-before.png`);
      const after = path.join(directory, `${entry.viewport.id}-after.png`);
      await page.screenshot({ path: before, fullPage: true });
      const target = page.locator(entry.interaction.selector).first();
      await target.waitFor({ state: 'visible' });
      if (entry.interaction.kind === 'click') await target.click();
      else if (entry.interaction.kind === 'press') await target.press(entry.interaction.key || 'Enter');
      else throw new Error(`Unsupported capture interaction: ${entry.interaction.kind}.`);
      await page.waitForTimeout(120);
      await page.screenshot({ path: after, fullPage: true });
      const trace = {
        schema: 'frontier-surface-interaction-trace/v1',
        candidate_id: entry.candidate_id,
        role: entry.role,
        viewport: entry.viewport.id,
        url_path: `/${entry.target_prefix}/index.html`,
        interaction: entry.interaction,
        before_sha256: await shaFile(before),
        after_sha256: await shaFile(after),
        changed: (await shaFile(before)) !== (await shaFile(after)),
        browser_errors: errors,
        duration_ms: Date.now() - started,
        evidence_class: 'headless-browser-fixture',
        real_device_claim: false
      };
      const tracePath = path.join(directory, `${entry.viewport.id}-trace.json`);
      await fsp.writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
      captures.push({ ...trace, trace_sha256: await shaFile(tracePath) });
      await context.close();
    }
  } finally {
    await browser.close();
    await closeServer(server);
  }
  const body = {
    schema: 'frontier-surface-capture-receipt/v1',
    assembly_digest: assembly.assembly_digest,
    browser: { executable_path: browserPath, headless: true },
    viewports: VIEWPORTS.map(({ id, width, height }) => ({ id, width, height })),
    captures,
    candidates: assembly.candidates.length,
    expected_capture_pairs: assembly.candidates.length * VIEWPORTS.length,
    complete_capture_pairs: captures.length,
    evidence_class: 'headless-browser-fixture',
    real_device_claim: false,
    claim_boundary: 'Automated headless screenshots and interaction traces only; cannot satisfy physical-device or model-capability evidence.'
  };
  const receipt = { ...body, receipt_digest: digest(body) };
  await fsp.writeFile(path.join(output, 'capture-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return Object.freeze(receipt);
}

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags.set(value, true);
    else { flags.set(value, next); index += 1; }
  }
  return flags;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const assemblyFile = flags.get('--assembly-file');
  const output = flags.get('--output');
  if (!assemblyFile || !output) throw new Error('frontier surface capture requires --assembly-file and --output.');
  const assembly = JSON.parse(await fsp.readFile(path.resolve(assemblyFile), 'utf8'));
  const result = await captureFrontierAssembly({
    repository_root: path.resolve(flags.get('--root') || process.cwd()),
    assembly,
    output_directory: output,
    executable_path: flags.get('--chrome')
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}

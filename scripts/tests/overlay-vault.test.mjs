import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = path.resolve(import.meta.dirname, '..', 'overlay-vault.mjs');

function run(cwd, ...args) {
  return execFileSync('node', [TOOL, ...args], { cwd, encoding: 'utf8' });
}

// execFileSync throws on non-zero exit with the real output on err.stdout,
// not in err.message — use this when a failing exit code is the point.
function runExpectFailure(cwd, ...args) {
  try {
    execFileSync('node', [TOOL, ...args], { cwd, encoding: 'utf8' });
    throw new Error('expected command to exit non-zero, but it succeeded');
  } catch (err) {
    if (err.status == null) throw err; // not a process-exit failure, rethrow
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function makeOverlaySet(dir, name, chunkSize) {
  const srcDir = path.join(dir, `${name}-src`);
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'app.js'), `// ${name}\nconsole.log('${name}');\n`);
  fs.writeFileSync(path.join(srcDir, 'index.html'), `<title>${name}</title>`);
  const tarBuf = execFileSync('tar', ['-C', dir, '-cf', '-', `${name}-src`]);
  const xzBuf = execFileSync('xz', ['-z', '-c'], { input: tarBuf, maxBuffer: 1 << 30 });
  const b64 = xzBuf.toString('base64');
  for (let i = 0; i * chunkSize < b64.length; i++) {
    fs.writeFileSync(
      path.join(dir, `${name}.part.${String(i).padStart(2, '0')}`),
      b64.slice(i * chunkSize, (i + 1) * chunkSize),
    );
  }
  fs.rmSync(srcDir, { recursive: true });
  return xzBuf;
}

test('pack consolidates every loose part set and preserves exact payload bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const alpha = makeOverlaySet(dir, 'alpha-overlay', 120);
  const beta = makeOverlaySet(dir, 'beta-overlay', 90);

  const out = run(dir, 'pack');
  assert.match(out, /packed alpha-overlay/);
  assert.match(out, /packed beta-overlay/);
  assert.ok(fs.existsSync(path.join(dir, 'overlays.vault')));

  const listing = run(dir, 'list');
  assert.match(listing, /alpha-overlay/);
  assert.match(listing, /beta-overlay/);

  run(dir, 'extract', 'alpha-overlay');
  const roundtrip = fs.readFileSync(path.join(dir, 'alpha-overlay.tar.xz'));
  assert.deepEqual(roundtrip, alpha);
  run(dir, 'extract', 'beta-overlay');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'beta-overlay.tar.xz')), beta);
});

test('pack is idempotent: re-running skips entries already vaulted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  makeOverlaySet(dir, 'gamma-overlay', 100);
  run(dir, 'pack');
  const second = run(dir, 'pack');
  assert.match(second, /skip gamma-overlay: already in vault/);
});

test('pack refuses a set with a missing part instead of silently corrupting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  makeOverlaySet(dir, 'delta-overlay', 60);
  const parts = fs.readdirSync(dir).filter((f) => f.startsWith('delta-overlay.part.'));
  assert.ok(parts.length >= 3, 'test needs at least 3 parts');
  fs.rmSync(path.join(dir, parts[1]));
  const out = runExpectFailure(dir, 'pack');
  assert.match(out ?? '', /missing part 1/);
});

test('verify detects payload corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  makeOverlaySet(dir, 'epsilon-overlay', 100);
  run(dir, 'pack');
  assert.match(run(dir, 'verify'), /OK\s+epsilon-overlay/);

  const vaultPath = path.join(dir, 'overlays.vault');
  const buf = fs.readFileSync(vaultPath);
  buf[buf.length - 5] ^= 0xff; // flip a payload byte
  fs.writeFileSync(vaultPath, buf);
  assert.match(runExpectFailure(dir, 'verify'), /FAIL epsilon-overlay/);
});

test('add appends a directory as a new overlay and restore-loose reproduces legacy parts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const appDir = path.join(dir, 'zeta-app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'main.js'), 'export default 1;\n');
  run(dir, 'add', 'zeta-app', '--name', 'zeta-overlay');
  assert.match(run(dir, 'list'), /zeta-overlay/);

  run(dir, 'restore-loose', 'zeta-overlay', '--chunk', '80');
  const parts = fs.readdirSync(dir).filter((f) => f.startsWith('zeta-overlay.part.'));
  assert.ok(parts.length > 1);
  const joined = parts.sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  run(dir, 'extract', 'zeta-overlay');
  const original = fs.readFileSync(path.join(dir, 'zeta-overlay.tar.xz'));
  assert.equal(joined, original.toString('base64'));
});

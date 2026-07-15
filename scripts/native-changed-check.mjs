import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();

function parseStatusEntries(stdout) {
  const entries = stdout.split('\u0000').filter(Boolean);
  const files = [];
  for (const entry of entries) {
    const status = entry.slice(0, 2);
    let name = entry.slice(3);
    if (status.includes('R') && name.includes(' -> ')) name = name.split(' -> ').at(-1);
    if (name && !status.includes('D')) files.push(name);
  }
  return files;
}

function parseDiffEntries(stdout) {
  const values = stdout.split('\u0000').filter(Boolean);
  const files = [];
  for (let index = 0; index < values.length;) {
    const status = values[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      index += 1;
      const destination = values[index++];
      if (destination && !status.startsWith('D')) files.push(destination);
      continue;
    }
    const name = values[index++];
    if (name && !status.startsWith('D')) files.push(name);
  }
  return files;
}

async function committedCandidateFiles() {
  const explicit = process.env.NATIVE_CHANGED_BASE?.trim();
  const pullBase = process.env.GITHUB_BASE_REF?.trim();
  const candidates = [explicit, pullBase ? `origin/${pullBase}` : '', 'origin/main'].filter(Boolean);
  for (const base of candidates) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', base], { cwd: root });
      const { stdout } = await execFileAsync('git', ['diff', '--name-status', '-z', `${base}...HEAD`], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024
      });
      return { base, files: parseDiffEntries(stdout) };
    } catch {}
  }
  return { base: null, files: [] };
}

const { stdout: statusOutput } = await execFileAsync(
  'git',
  ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  { cwd: root, maxBuffer: 4 * 1024 * 1024 }
);
let files = parseStatusEntries(statusOutput);
let mode = 'worktree';
let base = null;
if (!files.length) {
  const committed = await committedCandidateFiles();
  files = committed.files;
  base = committed.base;
  mode = base ? 'committed-candidate' : 'clean-worktree';
}

const checked = [];
for (const file of [...new Set(files)].sort()) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`changed path escapes repository: ${file}`);
  }
  if (/\.(?:mjs|cjs|js)$/i.test(file)) {
    await execFileAsync(process.execPath, ['--check', file], {
      cwd: root,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CI: '1', NODE_ENV: 'test' },
      maxBuffer: 1024 * 1024
    });
    checked.push({ file, witness: 'node --check' });
  } else if (/\.json$/i.test(file)) {
    JSON.parse(await fs.readFile(absolute, 'utf8'));
    checked.push({ file, witness: 'JSON.parse' });
  }
}

console.log(JSON.stringify({ mode, base, changed: files.length, checked }, null, 2));

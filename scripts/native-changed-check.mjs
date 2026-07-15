import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
const entries = stdout.split('\u0000').filter(Boolean);
const files = [];
for (const entry of entries) {
  const status = entry.slice(0, 2);
  let name = entry.slice(3);
  if (status.includes('R') && name.includes(' -> ')) name = name.split(' -> ').at(-1);
  if (name && !status.includes('D')) files.push(name);
}

const checked = [];
for (const file of [...new Set(files)].sort()) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`changed path escapes repository: ${file}`);
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
console.log(JSON.stringify({ changed: files.length, checked }, null, 2));

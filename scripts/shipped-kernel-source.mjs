#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const SOURCE_PREFIX = 'source.xz.part.';

async function findFile(root, relativeSuffix) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(target, relativeSuffix);
      if (nested) return nested;
    } else if (target.replaceAll('\\', '/').endsWith(relativeSuffix)) return target;
  }
  return null;
}

export async function loadShippedRootSource({ root = process.cwd() } = {}) {
  const names = (await readdir(root)).filter(name => name.startsWith(SOURCE_PREFIX)).sort();
  if (!names.length) throw new Error(`No ${SOURCE_PREFIX}* shards exist at ${root}.`);
  const encoded = (await Promise.all(names.map(name => readFile(path.join(root, name), 'utf8')))).join('').replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('Root source shards are not valid base64 text.');
  const archive = Buffer.from(encoded, 'base64');
  if (!archive.length) throw new Error('Root source archive decoded to zero bytes.');
  const directory = await mkdtemp(path.join(tmpdir(), 'sideways-shipped-kernel-'));
  try {
    const archivePath = path.join(directory, 'source.tar.xz');
    await writeFile(archivePath, archive);
    const extracted = path.join(directory, 'extracted');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(extracted));
    const result = spawnSync('tar', ['-xJf', archivePath, '-C', extracted], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Unable to extract tracked root source: ${String(result.stderr || result.stdout).trim()}`);
    const sourcePath = await findFile(extracted, '/src/app.js');
    if (!sourcePath || !(await stat(sourcePath)).isFile()) throw new Error('Tracked root archive does not contain src/app.js.');
    return await readFile(sourcePath, 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function openingIndex(source, name, kind) {
  const matcher = kind === 'function'
    ? new RegExp(`(?:^|\\n)function\\s+${name}\\s*\\(`)
    : new RegExp(`(?:^|\\n)const\\s+${name}\\s*=`);
  const match = matcher.exec(source);
  if (!match) throw new Error(`Shipped kernel declaration ${kind} ${name} is missing.`);
  return match.index + (match[0].startsWith('\n') ? 1 : 0);
}

function balancedEnd(source, start) {
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const stack = [];
  let sawStructure = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if ('{[('.includes(char)) { stack.push(char); sawStructure = true; continue; }
    if ('}])'.includes(char)) {
      stack.pop();
      if (sawStructure && stack.length === 0) {
        let end = index + 1;
        while (end < source.length && /[\s;]/.test(source[end])) end += 1;
        return end;
      }
    }
  }
  throw new Error('Shipped kernel declaration is unbalanced.');
}

export function extractDeclaration(source, name, kind = 'const') {
  const start = openingIndex(source, name, kind);
  return source.slice(start, balancedEnd(source, start)).trim();
}

export function evaluateConstDeclaration(source, name) {
  const declaration = extractDeclaration(source, name, 'const');
  const expression = declaration.replace(new RegExp(`^const\\s+${name}\\s*=\\s*`), '').replace(/;\s*$/, '');
  const value = vm.runInNewContext(`(${expression})`, Object.freeze({}), { timeout: 1000 });
  return structuredClone(value);
}

export function kernelSourceContract(source) {
  const required = [
    ['base_score', /baseScore\s*=\s*\.55\*post\.base\s*\+\s*\.30\*f\.affinity\s*\+\s*\.15\*post\.relevance/],
    ['lateral_value', /\.24\*f\.sameWhyDifferentAxis[\s\S]{0,260}?[-+]\s*\.06\*f\.topicDistance[\s\S]{0,160}?-\s*\.16\*f\.duplicateRisk[\s\S]{0,120}?-\s*\.15\*f\.graphicRepeat/],
    ['posterior_sigmoid', /sigmoid\(\s*4\.2\s*\*\s*delta\s*\+\s*1\.15\s*\*\s*\(maxZ\s*-\s*\.85\)\s*\)/],
    ['risk_floor', /clamp\(\s*\(maxZ\s*-\s*\.55\)\s*\/\s*2\.8\s*,\s*0\s*,\s*\.43\s*\)/],
    ['gate_blend', /riskFloor\s*\+\s*\.54\s*\*\s*posteriorChoice/],
    ['deep_floor', /Math\.max\(target,\s*\.48\)/]
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(source)).map(([id]) => id);
  if (missing.length) throw new Error(`Shipped kernel contract markers are missing: ${missing.join(', ')}.`);
  let config = null;
  try { config = evaluateConstDeclaration(source, 'CONFIG'); } catch {}
  return {
    schema: 'sideways-shipped-kernel-source/v1',
    source_bytes: Buffer.byteLength(source),
    markers: Object.fromEntries(required.map(([id]) => [id, true])),
    config
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const source = await loadShippedRootSource();
  process.stdout.write(`${JSON.stringify(kernelSourceContract(source), null, 2)}\n`);
}

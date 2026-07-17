#!/usr/bin/env node
// Overlay Vault: one append-only container for dead-run overlay state dumps.
//
// Replaces root-level `<name>.part.NN` / `<name>.b64.part.NNN` sprawl with a
// single self-describing binary file (default: overlays.vault).
//
// Container format (SWVAULT1):
//   magic "SWVAULT1\n"
//   repeated records:
//     [8-byte big-endian uint64: header length]
//     [JSON header: {name, createdAt, sha256, bytes, encoding, files}]
//     [payload bytes: the xz-compressed tarball, stored verbatim]
//
// Appending a new dead state is a pure append; no rewrite, no index to corrupt.
//
// Commands:
//   pack [--root DIR] [--vault FILE]      consolidate all loose part sets
//   add <tarball.tar.xz|dir> [--name N]   append one overlay
//   list [--vault FILE]                   show entries
//   verify [--vault FILE]                 re-hash every payload
//   extract <name> [--out DIR]            write <name>.tar.xz back out
//   restore-loose <name> [--chunk BYTES]  re-emit legacy base64 part files

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('SWVAULT1\n');
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const PART_RE = /^(?<name>.+?)\.(?:b64\.)?part\.(?<num>\d+)$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? true, i++;
    else args._.push(argv[i]);
  }
  return args;
}

function discoverPartSets(root) {
  const sets = new Map();
  for (const entry of fs.readdirSync(root)) {
    const m = PART_RE.exec(entry);
    if (!m) continue;
    const list = sets.get(m.groups.name) ?? [];
    list.push({ file: entry, num: Number(m.groups.num) });
    sets.set(m.groups.name, list);
  }
  for (const [name, list] of sets) {
    list.sort((a, b) => a.num - b.num);
    const nums = list.map((p) => p.num);
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i) throw new Error(`${name}: missing part ${i} (have ${nums.join(',')})`);
    }
  }
  return sets;
}

function joinSet(root, list) {
  const joined = Buffer.concat(list.map((p) => fs.readFileSync(path.join(root, p.file))));
  // Sets may be stored as base64 text or raw bytes; normalize to raw xz.
  if (joined.subarray(0, XZ_MAGIC.length).equals(XZ_MAGIC)) return joined;
  const text = joined.toString('utf8').replace(/\s+/g, '');
  const decoded = Buffer.from(text, 'base64');
  if (!decoded.subarray(0, XZ_MAGIC.length).equals(XZ_MAGIC)) {
    throw new Error('joined parts are neither raw xz nor base64-encoded xz');
  }
  return decoded;
}

function xz(args, input) {
  return execFileSync('xz', args, { input, maxBuffer: 1 << 30 });
}

function tarFileCount(tarBuf) {
  const listing = execFileSync('tar', ['-tf', '-'], { input: tarBuf, maxBuffer: 1 << 30 })
    .toString('utf8').trim();
  return listing ? listing.split('\n').length : 0;
}

function validatePayload(xzBuf) {
  if (!xzBuf.subarray(0, XZ_MAGIC.length).equals(XZ_MAGIC)) throw new Error('payload is not xz');
  const tarBuf = xz(['-d', '-c'], xzBuf); // throws on corrupt stream / bad CRC
  return { files: tarFileCount(tarBuf), rawBytes: tarBuf.length };
}

function appendRecord(vaultPath, header, payload) {
  if (!fs.existsSync(vaultPath)) fs.writeFileSync(vaultPath, MAGIC);
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(headerBuf.length));
  fs.appendFileSync(vaultPath, Buffer.concat([len, headerBuf, payload]));
}

function* readRecords(vaultPath) {
  const buf = fs.readFileSync(vaultPath);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad vault magic');
  let off = MAGIC.length;
  while (off < buf.length) {
    const headerLen = Number(buf.readBigUInt64BE(off)); off += 8;
    const header = JSON.parse(buf.subarray(off, off + headerLen).toString('utf8'));
    off += headerLen;
    const payload = buf.subarray(off, off + header.bytes);
    off += header.bytes;
    yield { header, payload };
  }
}

function existingNames(vaultPath) {
  if (!fs.existsSync(vaultPath)) return new Set();
  return new Set([...readRecords(vaultPath)].map((r) => r.header.name));
}

const cmds = {
  pack({ root = '.', vault = 'overlays.vault' }) {
    const sets = discoverPartSets(root);
    if (sets.size === 0) return console.log('no loose part sets found');
    const have = existingNames(vault);
    const consumed = [];
    for (const [name, list] of sets) {
      if (have.has(name)) { console.log(`skip ${name}: already in vault`); continue; }
      const payload = joinSet(root, list);
      const { files, rawBytes } = validatePayload(payload);
      appendRecord(vault, {
        name, createdAt: new Date().toISOString(), sha256: sha256(payload),
        bytes: payload.length, rawBytes, encoding: 'xz-tar', files,
      }, payload);
      console.log(`packed ${name}: ${list.length} parts -> ${payload.length} bytes, ${files} files`);
      consumed.push(...list.map((p) => path.join(root, p.file)));
    }
    if (consumed.length) {
      console.log(`\nverified and vaulted. loose files now safe to remove:`);
      console.log(consumed.map((f) => `  git rm ${f}`).join('\n'));
    }
  },

  add({ _: [, src], name, vault = 'overlays.vault' }) {
    if (!src) throw new Error('usage: add <tarball.tar.xz|dir> [--name N]');
    let payload;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      const tarBuf = execFileSync('tar', ['-C', path.dirname(path.resolve(src)), '-cf', '-',
        path.basename(src)], { maxBuffer: 1 << 30 });
      payload = xz(['-z', '-c', '-6'], tarBuf);
    } else {
      payload = fs.readFileSync(src);
    }
    const entryName = name ?? path.basename(src).replace(/\.tar(\.xz)?$/, '');
    if (existingNames(vault).has(entryName)) throw new Error(`${entryName} already in vault`);
    const { files, rawBytes } = validatePayload(payload);
    appendRecord(vault, {
      name: entryName, createdAt: new Date().toISOString(), sha256: sha256(payload),
      bytes: payload.length, rawBytes, encoding: 'xz-tar', files,
    }, payload);
    console.log(`added ${entryName}: ${payload.length} bytes, ${files} files`);
  },

  list({ vault = 'overlays.vault' }) {
    for (const { header: h } of readRecords(vault)) {
      console.log(`${h.name}  ${h.bytes}B xz / ${h.rawBytes}B raw  ${h.files} files  ${h.createdAt}  ${h.sha256.slice(0, 12)}`);
    }
  },

  verify({ vault = 'overlays.vault' }) {
    let ok = true;
    for (const { header: h, payload } of readRecords(vault)) {
      const good = sha256(payload) === h.sha256 && payload.length === h.bytes;
      let stream = good;
      if (good) { try { validatePayload(payload); } catch { stream = false; } }
      ok &&= good && stream;
      console.log(`${good && stream ? 'OK  ' : 'FAIL'} ${h.name}`);
    }
    if (!ok) process.exit(1);
  },

  extract({ _: [, name], out = '.', vault = 'overlays.vault' }) {
    for (const { header: h, payload } of readRecords(vault)) {
      if (h.name !== name) continue;
      const dest = path.join(out, `${name}.tar.xz`);
      fs.writeFileSync(dest, payload);
      return console.log(`wrote ${dest} (${payload.length} bytes)`);
    }
    throw new Error(`${name} not found in vault`);
  },

  'restore-loose'({ _: [, name], chunk = '8000', vault = 'overlays.vault' }) {
    for (const { header: h, payload } of readRecords(vault)) {
      if (h.name !== name) continue;
      const b64 = payload.toString('base64');
      const size = Number(chunk);
      for (let i = 0; i * size < b64.length; i++) {
        const file = `${name}.part.${String(i).padStart(2, '0')}`;
        fs.writeFileSync(file, b64.slice(i * size, (i + 1) * size));
        console.log(`wrote ${file}`);
      }
      return;
    }
    throw new Error(`${name} not found in vault`);
  },
};

const args = parseArgs(process.argv.slice(2));
const cmd = cmds[args._[0]];
if (!cmd) {
  console.error(`usage: overlay-vault.mjs <${Object.keys(cmds).join('|')}> [options]`);
  process.exit(2);
}
try { cmd(args); } catch (err) { console.error(`overlay-vault: ${err.message}`); process.exit(1); }

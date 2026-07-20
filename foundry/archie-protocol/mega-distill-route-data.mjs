#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const i = args.indexOf(flag); return i === -1 ? fallback : args[i + 1]; };
const input = value('--input');
const output = value('--out');
const rejectedOut = value('--rejected-out', output ? `${output}.rejected.jsonl` : null);
const copies = Number(value('--copies', 6));
if (!input || !output) throw new Error('Usage: mega-distill-route-data.mjs --input route-train.json --out distilled.json [--copies 6]');

const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s'_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = text => new Set(norm(text).split(' ').filter(Boolean));
const overlap = (a, b) => {
  const A = tokens(a), B = tokens(b); let hit = 0;
  for (const item of A) if (B.has(item)) hit += 1;
  return hit / Math.max(1, Math.min(A.size, B.size));
};

const openers = [
  p => `hey can you ${p}`,
  p => `real quick, ${p}`,
  p => `ok so i need you to ${p}`,
  p => `could you help me ${p}`,
  p => `i'm trying to ${p}`,
  p => `please ${p}`,
  p => `yo, ${p}`,
  p => `can we ${p}`
];
const closers = [
  p => `${p} and keep it simple`,
  p => `${p} without making me set everything up`,
  p => `${p} using what i already gave you`,
  p => `${p} and tell me the next real step`,
  p => `${p} without losing the important details`,
  p => `${p} like a normal person would ask`
];
const reorder = p => {
  const parts = norm(p).split(/\b(?:and then|then|and|after that)\b/).map(x => x.trim()).filter(Boolean);
  return parts.length > 1 ? `${parts.at(-1)} after you ${parts.slice(0, -1).join(' and ')}` : `before anything else, ${p}`;
};

function contextVariants(row) {
  const variants = [];
  if (row.attachments || row.files || row.has_attachment || row.has_file) variants.push({ ...row, prompt: `${row.prompt} using the attached file`, has_attachment: true });
  if (row.memory || row.memories || row.has_memory) variants.push({ ...row, prompt: `${row.prompt} based on what you remember from earlier`, has_memory: true });
  if (row.thread || row.reply_to) variants.push({ ...row, prompt: `${row.prompt} in this same thread`, thread: true });
  return variants;
}

const accepted = [], rejected = [], seen = new Set();
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const source = norm(row.prompt);
  const candidates = [source];
  for (let i = 0; i < copies; i += 1) {
    const first = openers[(index + i) % openers.length](source);
    const second = closers[(index * 3 + i) % closers.length](source);
    candidates.push(first, second, reorder(source));
  }
  for (const extra of contextVariants(row)) candidates.push(extra.prompt);
  for (const prompt of candidates) {
    const normalized = norm(prompt);
    const key = `${row.route}\0${normalized}`;
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    const lexicalFidelity = overlap(source, normalized);
    const preservesRoute = lexicalFidelity >= 0.45 || /attached|remember|thread/.test(normalized);
    const differentEnough = normalized !== source && normalized.length >= Math.max(8, source.length * 0.65);
    const reward = Number((0.55 * lexicalFidelity + 0.25 * Number(preservesRoute) + 0.20 * Number(differentEnough)).toFixed(4));
    const trajectory = {
      id: sha({ route: row.route, source, normalized }).slice(0, 20),
      route: row.route,
      prompt: normalized,
      source_prompt: source,
      context: {
        has_attachment: /attached/.test(normalized) || Boolean(row.has_attachment || row.has_file || row.attachments || row.files),
        has_memory: /remember/.test(normalized) || Boolean(row.has_memory || row.memory || row.memories),
        has_thread: /thread/.test(normalized) || Boolean(row.thread || row.reply_to)
      },
      trajectory: [
        { stage: 'observe', evidence: 'source prompt and governed route label' },
        { stage: 'rewrite', evidence: normalized },
        { stage: 'critic', evidence: { lexical_fidelity: lexicalFidelity, preserves_route: preservesRoute, different_enough: differentEnough } },
        { stage: 'reward', evidence: reward }
      ],
      verification: {
        source_route: row.route,
        rewritten_route: row.route,
        lexical_fidelity: Number(lexicalFidelity.toFixed(4)),
        route_preserved: preservesRoute,
        non_duplicate: differentEnough,
        accepted: preservesRoute && (normalized === source || differentEnough) && reward >= 0.65
      },
      weight: Number(Math.max(0.25, reward).toFixed(4)),
      provenance: { method: 'deterministic-diverse-rewrite/v1', source_digest: sha(row), synthetic: normalized !== source }
    };
    (trajectory.verification.accepted ? accepted : rejected).push(trajectory);
  }
}

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(accepted, null, 2)}\n`);
if (rejectedOut) fs.writeFileSync(rejectedOut, rejected.map(row => JSON.stringify(row)).join('\n') + (rejected.length ? '\n' : ''));
const receipt = {
  schema: 'archie-mega-distill-route-receipt/v1',
  source_rows: rows.length,
  accepted_rows: accepted.length,
  rejected_rows: rejected.length,
  routes: Object.fromEntries([...new Set(rows.map(row => row.route))].sort().map(route => [route, accepted.filter(row => row.route === route).length])),
  source_digest: sha(rows),
  accepted_digest: sha(accepted),
  promotion: 'not-admitted',
  claim_boundary: 'Synthetic route-preserving rewrites and metadata trajectories only. No teacher-model intelligence, general generation ability, or benchmark gain is claimed.'
};
fs.writeFileSync(`${output}.receipt.json`, `${JSON.stringify({ ...receipt, receipt_digest: sha(receipt) }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output: path.resolve(output), accepted: accepted.length, rejected: rejected.length, receipt: path.resolve(`${output}.receipt.json`) }, null, 2));

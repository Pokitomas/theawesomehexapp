#!/usr/bin/env node
import fs from 'node:fs';
import zlib from 'node:zlib';
import { safeSourceURL } from './web-source-security.mjs';

const [snapshotPath = 'corpus/general.jsonl.gz', metaPath = `${snapshotPath}.meta.json`] = process.argv.slice(2);
const minimums = Object.freeze({
  article: Number(process.env.SIDEWAYS_MIN_ARTICLES || 500),
  forum: Number(process.env.SIDEWAYS_MIN_FORUMS || 300),
  social: Number(process.env.SIDEWAYS_MIN_SOCIAL || 150)
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const text = zlib.gunzipSync(fs.readFileSync(snapshotPath)).toString('utf8');
const records = text.split('\n').filter(Boolean).map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`snapshot line ${index + 1} is invalid JSON: ${error.message}`);
  }
});

requireValue(meta.schema === 'sideways-web-source-snapshot/v2', 'snapshot metadata schema mismatch');
requireValue(meta.records === records.length, 'snapshot metadata count mismatch');
requireValue(records.length <= Number(meta.limits?.totalRecords || 0), 'snapshot exceeded total record limit');
requireValue(Array.isArray(meta.receipts) && meta.receipts.length > 0, 'source receipts are missing');
requireValue(meta.receipts.some(receipt => receipt.status === 'ready' && receipt.admitted > 0), 'no public source admitted records');

const counts = { article: 0, forum: 0, social: 0 };
const providers = new Set();
const urls = new Set();
for (const record of records) {
  requireValue(record && typeof record === 'object', 'snapshot record is not an object');
  requireValue(record.synthetic === false, 'synthetic record entered bounded snapshot');
  requireValue(['article', 'forum', 'social'].includes(record.kind), `unsupported record kind: ${record.kind}`);
  requireValue(record.provenance?.schema === 'sideways-web-provenance/v1', 'record provenance is missing');
  requireValue(record.provenance?.cache === 'bounded-build-snapshot', 'record crossed the public cache boundary');
  requireValue(record.url, 'record canonical URL is missing');
  const canonical = safeSourceURL(record.url).href;
  requireValue(!urls.has(canonical), `duplicate canonical URL: ${canonical}`);
  urls.add(canonical);
  counts[record.kind] += 1;
  providers.add(record.provenance.provider);
}

for (const [kind, floor] of Object.entries(minimums)) {
  requireValue(counts[kind] > floor, `too few ${kind} records: ${counts[kind]} <= ${floor}`);
}
requireValue(providers.size >= 6, `provider diversity is too small: ${providers.size}`);

const receiptText = JSON.stringify(meta.receipts);
requireValue(!/(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|password)\s*[:=]\s*["'][^"']+/i.test(receiptText), 'source receipt contains secret material');

console.log(JSON.stringify({
  schema: 'sideways-web-source-snapshot-verification/v1',
  snapshot: snapshotPath,
  records: records.length,
  counts,
  providers: providers.size,
  receipts: meta.receipts.map(({ provider, status, admitted, error }) => ({ provider, status, admitted, error: error || null })),
  limits: meta.limits
}, null, 2));

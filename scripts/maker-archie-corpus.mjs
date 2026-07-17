#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORD_SCHEMA = 'archie-linux-corpus-record/v1';
const EXAMPLE_SCHEMA = 'archie-distillation-example/v1';
const RECEIPT_SCHEMA = 'archie-linux-corpus-receipt/v1';
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/gi;

const clean = (value, limit = 100000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function redact(value, depth = 0) {
  if (depth > 14) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 2000).map(([key, child]) => [
      clean(key, 300),
      SECRET_KEY.test(key) ? '[redacted]' : redact(child, depth + 1)
    ]));
  }
  if (typeof value === 'string') return clean(value.replace(SECRET_TEXT, '[redacted]'));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return clean(value, 2000);
}

function toISO(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  return new Date(value).toISOString();
}

function tokenize(value) {
  return [...new Set(clean(value, 500000).toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [])];
}

function normalizeToolTrace(value) {
  return (Array.isArray(value) ? value : []).slice(0, 500).map(item => ({
    tool: clean(item?.tool || item?.name || item?.adapter || 'unknown', 200),
    action: clean(item?.action || item?.operation || '', 300),
    input: redact(item?.input || item?.arguments || item?.request || null),
    output: redact(item?.output || item?.result || null),
    ok: item?.ok !== false,
    duration_ms: Number.isFinite(Number(item?.duration_ms)) ? Number(item.duration_ms) : null
  }));
}

function normalizeArtifactRefs(value) {
  return (Array.isArray(value) ? value : []).slice(0, 500).map(item => ({
    name: clean(item?.name || item?.filename || item?.path || '', 1000),
    media_type: clean(item?.media_type || item?.mime || item?.type || '', 200),
    digest: clean(item?.digest || item?.sha256 || '', 200),
    uri: clean(item?.uri || item?.url || '', 2000),
    bytes: Number.isFinite(Number(item?.bytes || item?.size)) ? Number(item.bytes || item.size) : null
  }));
}

async function readJSONLines(filename) {
  try {
    const content = await fs.readFile(filename, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${filename}:${index + 1}`); }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function appendJSONLine(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.appendFile(filename, `${stableJSONStringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function withLock(root, work, { timeout_ms = 10000, poll_ms = 25 } = {}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, '.archie.lock');
  const deadline = Date.now() + timeout_ms;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Archie corpus lock.');
      await sleep(poll_ms);
    }
  }
  try {
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

function normalizeRecord(event = {}, observedAt) {
  const input = event.input || {};
  const output = event.output || {};
  const source = event.source || {};
  const normalized = {
    schema: RECORD_SCHEMA,
    kind: clean(event.kind || 'task_trace', 100),
    subject: clean(event.subject || 'default', 300),
    input: {
      text: clean(input.text || event.prompt || event.request || '', 500000),
      context: redact(input.context || event.context || null)
    },
    output: {
      text: clean(output.text || event.response || '', 500000),
      plan: redact(output.plan || event.plan || null)
    },
    tool_trace: normalizeToolTrace(event.tool_trace || event.tools),
    outcome: clean(event.outcome || 'unknown', 100),
    source: {
      system: clean(source.system || event.system || 'unknown', 200),
      run_id: clean(source.run_id || event.run_id || '', 300),
      teacher: clean(source.teacher || event.teacher || '', 300),
      model: clean(source.model || event.model || '', 300),
      route_digest: clean(source.route_digest || event.route_digest || '', 200),
      cost_usd: Number.isFinite(Number(source.cost_usd ?? event.cost_usd)) ? Number(source.cost_usd ?? event.cost_usd) : null
    },
    artifact_refs: normalizeArtifactRefs(event.artifact_refs || event.artifacts),
    tags: [...new Set((Array.isArray(event.tags) ? event.tags : []).map(tag => clean(tag, 100)).filter(Boolean))].slice(0, 200)
  };
  const contentDigest = digest(normalized);
  return Object.freeze({
    ...normalized,
    record_id: `rec_${contentDigest.slice(0, 24)}`,
    content_digest: contentDigest,
    observed_at: observedAt
  });
}

function buildDistillationExample(record) {
  if (!record.input.text) return null;
  const tags = Array.isArray(record.tags) ? record.tags : [];
  const negative = record.outcome !== 'completed' && tags.some(tag => ['negative', 'suppress', 'do-not-learn'].includes(String(tag).toLowerCase()));
  if (record.outcome !== 'completed' && !negative) return null;
  const target = negative ? null : (record.output.plan ?? record.output.text);
  const targetText = typeof target === 'string' ? target : stableJSONStringify(target);
  if (!negative && !clean(targetText)) return null;
  const body = {
    schema: EXAMPLE_SCHEMA,
    instruction: record.input.text,
    compact_context: record.input.context,
    target: redact(target),
    tool_trace: negative ? [] : record.tool_trace,
    outcome: record.outcome,
    negative,
    reason: negative ? clean(record.output.text || record.outcome, 2000) : '',
    tags,
    teacher_evidence: record.source,
    artifact_refs: record.artifact_refs,
    source_record_id: record.record_id,
    source_digest: record.content_digest
  };
  const exampleDigest = digest(body);
  return Object.freeze({
    ...body,
    example_id: `ex_${exampleDigest.slice(0, 24)}`,
    example_digest: exampleDigest,
    created_at: record.observed_at
  });
}

function extractMakerOutput(receipt) {
  const components = receipt?.components || {};
  return components.control_job?.result
    ?? components.dispatch?.output?.result
    ?? components.dispatch?.output
    ?? components.fleet_result
    ?? null;
}

function stringifyCompact(value, limit = 500000) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clean(value, limit);
  return clean(stableJSONStringify(redact(value)), limit);
}

export class ArchieLinuxCorpus {
  constructor({ root, clock = Date.now } = {}) {
    if (!root) throw new Error('Archie corpus root is required.');
    this.root = path.resolve(root);
    this.clock = clock;
    this.recordsPath = path.join(this.root, 'records.jsonl');
    this.examplesPath = path.join(this.root, 'examples.jsonl');
    this.ledgerPath = path.join(this.root, 'ledger.jsonl');
  }

  objectPath(contentDigest) {
    return path.join(this.root, 'objects', contentDigest.slice(0, 2), `${contentDigest}.json`);
  }

  examplePath(exampleDigest) {
    return path.join(this.root, 'examples', exampleDigest.slice(0, 2), `${exampleDigest}.json`);
  }

  async ingest(event = {}) {
    const observedAt = toISO(this.clock);
    const record = normalizeRecord(redact(event), observedAt);
    return withLock(this.root, async () => {
      const objectPath = this.objectPath(record.content_digest);
      let deduplicated = false;
      try {
        await fs.access(objectPath);
        deduplicated = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await writeAtomic(objectPath, record);
        await appendJSONLine(this.recordsPath, {
          record_id: record.record_id,
          content_digest: record.content_digest,
          object_path: path.relative(this.root, objectPath),
          kind: record.kind,
          subject: record.subject,
          outcome: record.outcome,
          observed_at: record.observed_at,
          tokens: tokenize(`${record.input.text}\n${record.output.text}\n${stringifyCompact(record.output.plan, 50000)}`).slice(0, 5000)
        });
      }

      let example = null;
      if (!deduplicated) {
        example = buildDistillationExample(record);
        if (example) {
          const examplePath = this.examplePath(example.example_digest);
          await writeAtomic(examplePath, example);
          await appendJSONLine(this.examplesPath, {
            example_id: example.example_id,
            example_digest: example.example_digest,
            example_path: path.relative(this.root, examplePath),
            source_record_id: record.record_id,
            created_at: example.created_at
          });
        }
      }

      const ledger = {
        schema: RECEIPT_SCHEMA,
        operation: deduplicated ? 'ingest.deduplicated' : 'ingest.stored',
        record_id: record.record_id,
        content_digest: record.content_digest,
        example_id: example?.example_id || null,
        observed_at: observedAt
      };
      await appendJSONLine(this.ledgerPath, ledger);
      return Object.freeze({
        ...ledger,
        status: deduplicated ? 'deduplicated' : 'stored',
        root: this.root,
        receipt_digest: digest(ledger)
      });
    });
  }

  async recordMakerRun(receipt, { input = null } = {}) {
    const task = receipt?.task || input?.control_request || input?.request || input || {};
    const route = receipt?.components?.model_route || {};
    const provider = route.provider || {};
    const output = extractMakerOutput(receipt);
    const plan = route.output?.plan ?? route.output ?? route.result?.plan ?? null;
    const attempts = Array.isArray(route.attempts) ? route.attempts : [];
    const toolTrace = [
      ...attempts.map(attempt => ({
        tool: 'teacher_model',
        action: 'inference',
        input: { provider_id: attempt.provider_id, task_type: route.task?.type },
        output: { status: attempt.status, error: attempt.error },
        ok: attempt.status !== 'failed',
        duration_ms: attempt.duration_ms
      })),
      ...(receipt?.components?.dispatch ? [{
        tool: receipt.components.dispatch.adapter || 'worker_dispatch',
        action: 'execute',
        input: { worker_id: receipt.components.fleet_placement?.worker_id },
        output: receipt.components.dispatch.output,
        ok: receipt.components.dispatch.ok !== false
      }] : [])
    ];
    return this.ingest({
      kind: 'maker_task_trace',
      subject: clean(task.target_repository || task.repository || 'default', 300),
      input: {
        text: clean(task.request || task.goal || task.prompt || '', 500000),
        context: {
          protect: task.protect || null,
          proof: task.proof || null,
          mode: task.mode || null,
          runtime_requirements: task.runtime_requirements || null
        }
      },
      output: {
        text: stringifyCompact(output),
        plan
      },
      tool_trace: toolTrace,
      outcome: receipt?.state === 'completed' ? 'completed' : receipt?.state || 'unknown',
      source: {
        system: 'maker-runtime-platform',
        run_id: receipt?.platform_run_id || '',
        teacher: provider.engine_label || provider.display_name || provider.id || '',
        model: provider.id || '',
        route_digest: route.receipt_digest || '',
        cost_usd: route.usage?.cost_usd ?? route.budget?.used?.cost_usd ?? null
      },
      artifact_refs: [
        output?.branch ? { name: output.branch, media_type: 'text/x-git-ref' } : null,
        output?.pull_request ? { name: output.pull_request, media_type: 'text/uri-list', uri: output.pull_request } : null
      ].filter(Boolean),
      tags: ['maker', 'teacher-trace', receipt?.state || 'unknown', ...(receipt?.state === 'completed' ? [] : ['negative', 'do-not-repeat'])]
    });
  }

  async findBySourceRunId(runId, { kind = null } = {}) {
    const wanted = clean(runId, 300);
    if (!wanted) return null;
    const rows = await readJSONLines(this.recordsPath);
    for (const row of [...rows].reverse()) {
      if (kind && row.kind !== kind) continue;
      const record = JSON.parse(await fs.readFile(path.join(this.root, row.object_path), 'utf8'));
      if (clean(record.source?.run_id, 300) === wanted) return record;
    }
    return null;
  }

  async query(text, { limit = 8, kinds = null, outcomes = null } = {}) {
    const queryTokens = tokenize(text);
    if (!queryTokens.length) return [];
    const wantedKinds = kinds ? new Set(kinds) : null;
    const wantedOutcomes = outcomes ? new Set(outcomes) : null;
    const rows = await readJSONLines(this.recordsPath);
    const scored = [];
    for (const row of rows) {
      if (wantedKinds && !wantedKinds.has(row.kind)) continue;
      if (wantedOutcomes && !wantedOutcomes.has(row.outcome)) continue;
      const tokens = new Set(row.tokens || []);
      const overlap = queryTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0);
      if (!overlap) continue;
      const record = JSON.parse(await fs.readFile(path.join(this.root, row.object_path), 'utf8'));
      const exact = clean(record.input?.text).toLowerCase().includes(clean(text).toLowerCase()) ? 3 : 0;
      const completed = record.outcome === 'completed' ? 0.5 : 0;
      scored.push({ score: overlap * 2 + exact + completed, record });
    }
    return scored.sort((left, right) => right.score - left.score || right.record.observed_at.localeCompare(left.record.observed_at)).slice(0, Math.max(1, Math.min(100, Number(limit) || 8)));
  }

  async examples({ limit = 1000 } = {}) {
    const rows = await readJSONLines(this.examplesPath);
    const selected = rows.slice(-Math.max(1, Math.min(250000, Number(limit) || 1000)));
    return Promise.all(selected.map(row => fs.readFile(path.join(this.root, row.example_path), 'utf8').then(JSON.parse)));
  }

  async stats() {
    const [records, examples, ledger] = await Promise.all([
      readJSONLines(this.recordsPath),
      readJSONLines(this.examplesPath),
      readJSONLines(this.ledgerPath)
    ]);
    return Object.freeze({
      root: this.root,
      records: records.length,
      examples: examples.length,
      events: ledger.length,
      last_event_at: ledger.at(-1)?.observed_at || null
    });
  }
}

export function createArchieLinuxCorpus(options) {
  return new ArchieLinuxCorpus(options);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  const root = argument('--root', process.env.ARCHIE_CORPUS_ROOT || '');
  if (!root) throw new Error('Pass --root or set ARCHIE_CORPUS_ROOT.');
  const corpus = createArchieLinuxCorpus({ root });
  if (command === 'ingest-maker') {
    const filename = argument('--file');
    if (!filename) throw new Error('Pass --file with a Maker runtime receipt.');
    const receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
    console.log(JSON.stringify(await corpus.recordMakerRun(receipt), null, 2));
    return;
  }
  if (command === 'query') {
    const text = argument('--text');
    console.log(JSON.stringify(await corpus.query(text, { limit: Number(argument('--limit', '8')) }), null, 2));
    return;
  }
  if (command === 'examples') {
    console.log(JSON.stringify(await corpus.examples({ limit: Number(argument('--limit', '1000')) }), null, 2));
    return;
  }
  if (command === 'stats') {
    console.log(JSON.stringify(await corpus.stats(), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-corpus.mjs <ingest-maker|query|examples|stats> --root <directory>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

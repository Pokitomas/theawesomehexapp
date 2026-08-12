#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_WIRE = '/home/awesomekai/archie-remote/roast.jsonl';
const DEFAULT_STATE = '/home/awesomekai/archie-remote/presence/brain-broker-state.json';
const DEFAULT_MODEL = process.env.ARCHIE_FOREGROUND_MODEL || 'gpt-5';
const DEFAULT_ENDPOINT = process.env.ARCHIE_OPENAI_ENDPOINT || 'https://api.openai.com/v1/responses';
const ACTOR = process.env.ARCHIE_FOREGROUND_ACTOR || 'gpt56sol';
const MAX_HISTORY = Number(process.env.ARCHIE_FOREGROUND_HISTORY || 48);
const DEFAULT_BURST_MS = Number(process.env.ARCHIE_FOREGROUND_BURST_MS || 18);
const STATE_SCHEMA = 'archie/presence-brain-broker-state-v2';

const clean = (value, limit = 120000) => String(value ?? '').replace(/\u0000/g, '').slice(0, limit);
const nowISO = () => new Date().toISOString();
const monoMs = () => Number(process.hrtime.bigint()) / 1e6;
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

export function extractWireText(event) {
  if (!event || typeof event !== 'object') return '';
  return clean(event.text ?? event.message ?? event.body ?? event.content ?? '', 120000).trim();
}

export function parseSSEBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

export function isSemanticHistoryEvent(event) {
  const who = String(event?.from || event?.actor || '');
  const text = extractWireText(event);
  if (!text) return false;
  if (who === 'kai') return true;
  if (who !== ACTOR) return false;
  if (/^@(all|gpt|archie|claude|peer|codex)\b/i.test(text)) return false;
  return (
    event?.type === 'semantic_message' ||
    event?.source === 'archie-presence-brain-broker' ||
    event?.re === 'presence-terminal' ||
    /^\[GPT56SOL PTY\]/.test(text)
  );
}

export function joinBurstFragments(fragments) {
  return fragments
    .map(fragment => typeof fragment === 'string' ? clean(fragment).trim() : extractWireText(fragment))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildContext(history, currentText) {
  const visible = history
    .filter(isSemanticHistoryEvent)
    .map(event => ({ who: String(event.from || event.actor), text: extractWireText(event) }))
    .filter(event => event.text)
    .slice(-MAX_HISTORY);

  // onWire records the current Kai event before dispatch. Do not feed the same
  // utterance twice as both history and CURRENT USER INPUT.
  const current = clean(currentText).trim();
  if (visible.at(-1)?.who === 'kai' && visible.at(-1)?.text === current) visible.pop();

  const transcript = visible
    .map(event => `${event.who === 'kai' ? 'KAI' : 'GPT56SOL'}: ${event.text}`)
    .join('\n');
  return [
    'You are the foreground semantic layer of a persistent local cognitive system.',
    'Maintain temporal continuity. Do not behave like a servile assistant or narrate obvious tool mechanics.',
    'Speak naturally and compactly. Treat local sensing, actions, experiments, and durable state as part of one ongoing process.',
    'The long-term local core is not a chatbot; this cloud layer is temporary semantic scaffolding around it.',
    'Control-plane directives and host-worker chatter are not conversation and must not become personality or memory.',
    transcript ? `RECENT CONTINUITY:\n${transcript}` : '',
    `CURRENT USER INPUT:\n${current}`
  ].filter(Boolean).join('\n\n');
}

async function appendJsonl(filename, event) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.appendFile(filename, `${JSON.stringify(event)}\n`, 'utf8');
}

async function atomicWriteJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, filename);
}

async function readJson(filename) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')); } catch { return null; }
}

async function seedHistory(wire) {
  try {
    const text = await fsp.readFile(wire, 'utf8');
    return text.trimEnd().split(/\r?\n/).slice(-MAX_HISTORY * 5).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

class DeltaTail {
  constructor(filename, onEvent) {
    this.filename = filename;
    this.onEvent = onEvent;
    this.offset = 0;
    this.carry = '';
    this.watcher = null;
    this.timer = null;
    this.reading = false;
    this.pending = false;
  }

  async start() {
    await fsp.mkdir(path.dirname(this.filename), { recursive: true });
    const handle = await fsp.open(this.filename, 'a');
    await handle.close();
    this.offset = (await fsp.stat(this.filename)).size;
    const kick = () => void this.kick().catch(error => {
      process.stderr.write(`[brain-broker] tail error: ${error?.stack || error}\n`);
    });
    this.watcher = fs.watch(this.filename, { persistent: true }, kick);
    // fs.watch is the fast path; the timer is only a lost-notification court.
    this.timer = setInterval(kick, 1000);
  }

  async kick() {
    if (this.reading) { this.pending = true; return; }
    this.reading = true;
    try {
      do {
        this.pending = false;
        let stat;
        try { stat = await fsp.stat(this.filename); } catch { continue; }
        if (stat.size < this.offset) { this.offset = 0; this.carry = ''; }
        if (stat.size === this.offset) continue;
        const length = stat.size - this.offset;
        const fh = await fsp.open(this.filename, 'r');
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buffer, 0, length, this.offset);
        await fh.close();
        this.offset += bytesRead;
        const text = this.carry + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split(/\r?\n/);
        this.carry = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { await this.onEvent(JSON.parse(line)); } catch (error) {
            process.stderr.write(`[brain-broker] wire event error: ${error?.stack || error}\n`);
          }
        }
      } while (this.pending);
    } finally {
      this.reading = false;
    }
  }

  close() {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }
}

export class PresenceBrainBroker {
  constructor({
    wire = DEFAULT_WIRE,
    statePath = process.env.ARCHIE_FOREGROUND_STATE || DEFAULT_STATE,
    pty = process.env.ARCHIE_PRESENCE_PTY || '',
    endpoint = DEFAULT_ENDPOINT,
    model = DEFAULT_MODEL,
    apiKey = process.env.OPENAI_API_KEY || '',
    burstMs = DEFAULT_BURST_MS,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.wire = wire;
    this.statePath = statePath;
    this.pty = pty;
    this.endpoint = endpoint;
    this.model = model;
    this.apiKey = apiKey;
    this.burstMs = Math.max(0, Number.isFinite(Number(burstMs)) ? Number(burstMs) : DEFAULT_BURST_MS);
    this.fetch = fetchImpl;
    this.epoch = 0;
    this.active = null;
    this.history = [];
    this.pendingFragments = [];
    this.pendingTimer = null;
    this.pendingStartedMs = null;
    this.counters = { inputs: 0, dispatches: 0, completed: 0, aborted: 0, errors: 0 };
    this.lastTiming = null;
    this.tail = new DeltaTail(wire, event => this.onWire(event));
  }

  async start() {
    if (!this.fetch) throw new Error('Global fetch is required (Node 20+).');
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for foreground semantic dispatch.');
    this.history = await seedHistory(this.wire);
    const old = await readJson(this.statePath);
    if (old?.schema === STATE_SCHEMA) {
      this.epoch = Math.max(0, Number(old.epoch || 0));
      for (const key of Object.keys(this.counters)) {
        this.counters[key] = Math.max(0, Number(old.counters?.[key] || 0));
      }
      this.lastTiming = old.last_timing || null;
    }
    await this.tail.start();
    await this.persistState({ phase: 'resident' });
    process.stderr.write(`[brain-broker] resident wire=${this.wire} model=${this.model} actor=${ACTOR} pty=${this.pty || 'wire-only'} burst_ms=${this.burstMs}\n`);
  }

  async persistState(extra = {}) {
    const state = {
      schema: STATE_SCHEMA,
      updated_at: nowISO(),
      pid: process.pid,
      epoch: this.epoch,
      actor: ACTOR,
      wire: this.wire,
      pty: this.pty || null,
      model: this.model,
      endpoint_origin: (() => { try { return new URL(this.endpoint).origin; } catch { return 'invalid'; } })(),
      burst_ms: this.burstMs,
      active_epoch: this.active?.epoch ?? null,
      pending_fragments: this.pendingFragments.length,
      counters: { ...this.counters },
      last_timing: this.lastTiming,
      ...extra
    };
    await atomicWriteJson(this.statePath, state);
  }

  async writePty(text) {
    if (!this.pty || !text) return;
    try { await fsp.appendFile(this.pty, text, 'utf8'); } catch (error) {
      process.stderr.write(`[brain-broker] PTY write failed: ${error?.message || error}\n`);
    }
  }

  async onWire(event) {
    this.history.push(event);
    if (this.history.length > MAX_HISTORY * 6) this.history.splice(0, this.history.length - MAX_HISTORY * 6);
    const who = String(event?.from || event?.actor || '');
    if (who !== 'kai') return;
    const text = extractWireText(event);
    if (!text) return;

    const epoch = ++this.epoch;
    this.counters.inputs += 1;

    // Barge-in is immediate. The tiny burst window only delays the new dispatch
    // long enough to turn pasted/multi-line terminal input into one utterance.
    if (this.active && !this.active.abort.signal.aborted) {
      this.active.abort.abort(`superseded-by-epoch-${epoch}`);
      this.counters.aborted += 1;
    }

    if (this.pendingFragments.length === 0) this.pendingStartedMs = monoMs();
    this.pendingFragments.push(event);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flushPending().catch(error => {
        this.counters.errors += 1;
        process.stderr.write(`[brain-broker] dispatch error: ${error?.stack || error}\n`);
        void this.persistState({ phase: 'dispatch-error', error: clean(error?.message || error, 1000) });
      });
    }, this.burstMs);
    await this.persistState({ phase: 'input', last_input_sha256: sha256(text) });
  }

  async flushPending() {
    if (!this.pendingFragments.length) return;
    const fragments = this.pendingFragments.splice(0);
    const receivedMs = this.pendingStartedMs ?? monoMs();
    this.pendingStartedMs = null;
    const text = joinBurstFragments(fragments);
    if (!text) return;
    const epoch = this.epoch;
    const abort = new AbortController();
    const dispatchMs = monoMs();
    this.counters.dispatches += 1;
    this.active = { epoch, abort, receivedMs, dispatchMs };
    await this.persistState({ phase: 'dispatch', burst_fragment_count: fragments.length, current_input_sha256: sha256(text) });
    try {
      await this.respond({ epoch, text, abort, receivedMs, dispatchMs, fragmentCount: fragments.length });
    } catch (error) {
      if (!abort.signal.aborted) {
        this.counters.errors += 1;
        await this.persistState({ phase: 'semantic-error', error: clean(error?.message || error, 1000) });
        process.stderr.write(`[brain-broker] semantic error epoch=${epoch}: ${error?.stack || error}\n`);
      }
    } finally {
      if (this.active?.epoch === epoch) this.active = null;
    }
  }

  async respond({ epoch, text, abort, receivedMs, dispatchMs, fragmentCount }) {
    const prompt = buildContext(this.history, text);
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: this.model, stream: true, input: prompt }),
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${clean(await response.text(), 4000)}`);
    if (!response.body) throw new Error('Streaming response body missing.');

    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let firstDeltaMs = null;
    let openedPtyLine = false;

    const consume = async block => {
      const event = parseSSEBlock(block);
      if (!event || abort.signal.aborted) return;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        if (firstDeltaMs == null) {
          firstDeltaMs = monoMs();
          if (this.pty) {
            await this.writePty(`\r\nGPT56SOL> `);
            openedPtyLine = true;
          }
        }
        output += event.delta;
        if (this.pty) await this.writePty(event.delta);
      }
      if (event.type === 'error') throw new Error(clean(event.error?.message || JSON.stringify(event), 4000));
    };

    for await (const chunk of response.body) {
      if (abort.signal.aborted) return;
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, split);
        const match = buffer.slice(split).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(split + match.length);
        await consume(block);
      }
    }
    if (buffer.trim()) await consume(buffer);
    if (abort.signal.aborted || epoch !== this.epoch || !output.trim()) return;
    if (openedPtyLine) await this.writePty('\r\n');

    const doneMs = monoMs();
    const timing = {
      burst_hold_ms: Number((dispatchMs - receivedMs).toFixed(3)),
      receive_to_first_delta_ms: firstDeltaMs == null ? null : Number((firstDeltaMs - receivedMs).toFixed(3)),
      dispatch_to_first_delta_ms: firstDeltaMs == null ? null : Number((firstDeltaMs - dispatchMs).toFixed(3)),
      receive_to_done_ms: Number((doneMs - receivedMs).toFixed(3)),
      dispatch_to_done_ms: Number((doneMs - dispatchMs).toFixed(3))
    };
    this.lastTiming = timing;
    this.counters.completed += 1;

    const durable = {
      from: ACTOR,
      re: 'presence-terminal',
      type: 'semantic_message',
      source: 'archie-presence-brain-broker',
      text: output.trim(),
      t: nowISO(),
      epoch,
      burst_fragment_count: fragmentCount,
      timing,
      content_sha256: sha256(output.trim()),
      terminal_echo_suppressed: Boolean(this.pty)
    };
    await appendJsonl(this.wire, durable);
    this.history.push(durable);
    await this.persistState({ phase: 'idle', last_output_sha256: durable.content_sha256 });
    process.stderr.write(`[brain-broker] epoch=${epoch} fragments=${fragmentCount} first_delta_ms=${timing.receive_to_first_delta_ms} done_ms=${timing.receive_to_done_ms}\n`);
  }

  close() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.active?.abort.abort('shutdown');
    this.tail.close();
    void this.persistState({ phase: 'shutdown' });
  }
}

function parseArgs(argv) {
  const args = {
    wire: DEFAULT_WIRE,
    statePath: process.env.ARCHIE_FOREGROUND_STATE || DEFAULT_STATE,
    pty: process.env.ARCHIE_PRESENCE_PTY || '',
    burstMs: DEFAULT_BURST_MS
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--wire') args.wire = argv[++i];
    else if (argv[i] === '--state') args.statePath = argv[++i];
    else if (argv[i] === '--pty') args.pty = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--burst-ms') args.burstMs = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const broker = new PresenceBrainBroker(parseArgs(process.argv.slice(2)));
  await broker.start();
  const stop = () => { broker.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exit(1); });

#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_WIRE = '/home/awesomekai/archie-remote/roast.jsonl';
const DEFAULT_MODEL = process.env.ARCHIE_FOREGROUND_MODEL || 'gpt-5';
const DEFAULT_ENDPOINT = process.env.ARCHIE_OPENAI_ENDPOINT || 'https://api.openai.com/v1/responses';
const ACTOR = process.env.ARCHIE_FOREGROUND_ACTOR || 'gpt56sol';
const MAX_HISTORY = Number(process.env.ARCHIE_FOREGROUND_HISTORY || 48);

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

export function buildContext(history, currentText) {
  const visible = history
    .filter(event => ['kai', ACTOR].includes(String(event.from || event.actor || '')))
    .map(event => ({ who: String(event.from || event.actor), text: extractWireText(event) }))
    .filter(event => event.text)
    .slice(-MAX_HISTORY);
  const transcript = visible.map(event => `${event.who === 'kai' ? 'KAI' : 'GPT56SOL'}: ${event.text}`).join('\n');
  return [
    'You are the foreground semantic layer of a persistent local cognitive system.',
    'Maintain temporal continuity. Do not behave like a servile assistant or narrate obvious tool mechanics.',
    'Speak naturally and compactly. Treat local sensing, actions, experiments, and durable state as part of one ongoing process.',
    'The long-term local core is not a chatbot; this cloud layer is temporary semantic scaffolding around it.',
    transcript ? `RECENT CONTINUITY:\n${transcript}` : '',
    `CURRENT USER INPUT:\n${currentText}`
  ].filter(Boolean).join('\n\n');
}

async function appendJsonl(filename, event) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.appendFile(filename, `${JSON.stringify(event)}\n`, 'utf8');
}

async function seedHistory(wire) {
  try {
    const text = await fsp.readFile(wire, 'utf8');
    return text.trimEnd().split(/\r?\n/).slice(-MAX_HISTORY * 3).map(line => {
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
    this.reading = false;
    this.pending = false;
  }

  async start() {
    await fsp.mkdir(path.dirname(this.filename), { recursive: true });
    const handle = await fsp.open(this.filename, 'a');
    await handle.close();
    this.offset = (await fsp.stat(this.filename)).size;
    this.watcher = fs.watch(this.filename, { persistent: true }, () => this.kick());
    this.timer = setInterval(() => this.kick(), 1000);
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
    clearInterval(this.timer);
  }
}

export class PresenceBrainBroker {
  constructor({
    wire = DEFAULT_WIRE,
    pty = process.env.ARCHIE_PRESENCE_PTY || '',
    endpoint = DEFAULT_ENDPOINT,
    model = DEFAULT_MODEL,
    apiKey = process.env.OPENAI_API_KEY || '',
    fetchImpl = globalThis.fetch
  } = {}) {
    this.wire = wire;
    this.pty = pty;
    this.endpoint = endpoint;
    this.model = model;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.epoch = 0;
    this.active = null;
    this.history = [];
    this.tail = new DeltaTail(wire, event => this.onWire(event));
  }

  async start() {
    if (!this.fetch) throw new Error('Global fetch is required (Node 20+).');
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for foreground semantic dispatch.');
    this.history = await seedHistory(this.wire);
    await this.tail.start();
    process.stderr.write(`[brain-broker] resident wire=${this.wire} model=${this.model} actor=${ACTOR} pty=${this.pty || 'wire-only'}\n`);
  }

  async writePty(text) {
    if (!this.pty || !text) return;
    try { await fsp.appendFile(this.pty, text, 'utf8'); } catch (error) {
      process.stderr.write(`[brain-broker] PTY write failed: ${error?.message || error}\n`);
    }
  }

  async onWire(event) {
    this.history.push(event);
    if (this.history.length > MAX_HISTORY * 4) this.history.splice(0, this.history.length - MAX_HISTORY * 4);
    const who = String(event?.from || event?.actor || '');
    if (who !== 'kai') return;
    const text = extractWireText(event);
    if (!text) return;
    const epoch = ++this.epoch;
    this.active?.abort.abort(`superseded-by-epoch-${epoch}`);
    const abort = new AbortController();
    const startedMs = monoMs();
    this.active = { epoch, abort, startedMs };
    this.respond({ epoch, text, abort, startedMs }).catch(error => {
      if (abort.signal.aborted) return;
      process.stderr.write(`[brain-broker] semantic error epoch=${epoch}: ${error?.stack || error}\n`);
    });
  }

  async respond({ epoch, text, abort, startedMs }) {
    const prompt = buildContext(this.history, text);
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        input: prompt
      }),
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
          firstDeltaMs = monoMs() - startedMs;
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

    const totalMs = monoMs() - startedMs;
    const durable = {
      from: ACTOR,
      re: 'presence-terminal',
      type: 'semantic_message',
      source: 'archie-presence-brain-broker',
      text: output.trim(),
      t: nowISO(),
      epoch,
      timing: {
        dispatch_to_first_delta_ms: firstDeltaMs == null ? null : Number(firstDeltaMs.toFixed(3)),
        dispatch_to_done_ms: Number(totalMs.toFixed(3))
      },
      content_sha256: sha256(output.trim()),
      terminal_echo_suppressed: Boolean(this.pty)
    };
    await appendJsonl(this.wire, durable);
    this.history.push(durable);
    process.stderr.write(`[brain-broker] epoch=${epoch} first_delta_ms=${durable.timing.dispatch_to_first_delta_ms} done_ms=${durable.timing.dispatch_to_done_ms}\n`);
  }

  close() {
    this.active?.abort.abort('shutdown');
    this.tail.close();
  }
}

function parseArgs(argv) {
  const args = { wire: DEFAULT_WIRE, pty: process.env.ARCHIE_PRESENCE_PTY || '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--wire') args.wire = argv[++i];
    else if (argv[i] === '--pty') args.pty = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
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

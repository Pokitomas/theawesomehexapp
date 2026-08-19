#!/usr/bin/env node
// Durable fold over the room event log.
//
// The read-only surface (labs/archie-one-surface/server.py) tails a bounded
// window of roast.jsonl, so state older than the window is unreadable and every
// reader restarts blind. This module keeps a resumable cursor plus the folded
// state in the control file, so a reader that reconnects later resumes exactly
// where it stopped instead of re-deriving from a tail.
//
// Objectives are read off the wire rather than restated: room directives already
// carry an uppercase tag and an addressed agent. An obligation opens when an
// agent is addressed under a tag and closes when that agent later emits the same
// tag. Whatever stays open is the derived work — nothing here proposes tasks that
// the log does not already imply.

import fs from 'node:fs/promises';

export const ARCHIE_ROOM_LEDGER_SCHEMA = 'archie-room-ledger/v1';

const TAG_PATTERN = /\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g;
const ADDRESS_PATTERN = /@([A-Za-z][A-Za-z0-9_.-]{1,63})/g;

export class RoomLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoomLedgerError';
  }
}

export function emptyLedger() {
  return { v: 1, seq: 0, schema: ARCHIE_ROOM_LEDGER_SCHEMA, agents: {}, obligations: {} };
}

function assertLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomLedgerError('Room ledger must be an object.');
  if (!Number.isInteger(value.seq) || value.seq < 0) throw new RoomLedgerError('Room ledger requires a nonnegative integer seq.');
  if (value.schema !== undefined && value.schema !== ARCHIE_ROOM_LEDGER_SCHEMA) {
    throw new RoomLedgerError(`Unsupported room ledger schema: ${value.schema}`);
  }
  return {
    ...emptyLedger(),
    ...value,
    agents: { ...(value.agents || {}) },
    obligations: { ...(value.obligations || {}) }
  };
}

// A bare `@name` with no uppercase tag carries no obligation we can later
// discharge, so it is recorded as presence only.
function parseEvent(text) {
  const tags = [];
  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(text); match; match = TAG_PATTERN.exec(text)) {
    if (!tags.includes(match[1])) tags.push(match[1]);
  }
  const addressed = [];
  ADDRESS_PATTERN.lastIndex = 0;
  for (let match = ADDRESS_PATTERN.exec(text); match; match = ADDRESS_PATTERN.exec(text)) {
    const id = match[1].toLowerCase();
    if (!addressed.includes(id)) addressed.push(id);
  }
  return { tags, addressed };
}

export function parseRoomLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = String(value.text ?? '');
  if (!text) return null;
  return { t: String(value.t ?? ''), from: String(value.from ?? '?').toLowerCase(), text };
}

// Folding [0,n) then [n,m) must equal folding [0,m), so all carried state lives
// in the returned ledger and each line is applied at most once.
export function foldRoomEvents(ledger, lines) {
  const next = assertLedger(ledger);
  let seq = next.seq;
  for (const line of lines) {
    const event = parseRoomLine(line);
    seq += 1;
    if (!event) continue;

    const agent = next.agents[event.from] || { first_seq: seq, first_at: event.t, last_seq: 0, last_at: '', events: 0 };
    agent.last_seq = seq;
    agent.last_at = event.t;
    agent.events += 1;
    next.agents[event.from] = agent;

    const { tags, addressed } = parseEvent(event.text);

    // Discharge before opening: an agent restating its own tag reports on the
    // obligation it already holds rather than opening a second one.
    for (const tag of tags) {
      const open = next.obligations[tag];
      if (open && !open.discharged_seq && open.to === event.from) {
        open.discharged_seq = seq;
        open.discharged_at = event.t;
        open.discharged_by = event.from;
      }
    }

    for (const to of addressed) {
      if (to === event.from) continue;
      for (const tag of tags) {
        if (next.obligations[tag]) continue;
        next.obligations[tag] = {
          tag,
          to,
          from: event.from,
          opened_seq: seq,
          opened_at: event.t,
          text: event.text.slice(0, 500),
          discharged_seq: 0,
          discharged_at: '',
          discharged_by: ''
        };
      }
    }
  }
  next.seq = seq;
  return next;
}

// Derived, not planned: every entry here is an obligation the log opened and
// never closed. Oldest first, because the longest-open gap is the least likely
// to be rediscovered by a reader that only sees the tail.
export function emergentTasks(ledger, { limit = 0 } = {}) {
  const state = assertLedger(ledger);
  const open = Object.values(state.obligations)
    .filter(entry => !entry.discharged_seq)
    .map(entry => ({ ...entry, open_for_seq: state.seq - entry.opened_seq }))
    .sort((left, right) => right.open_for_seq - left.open_for_seq || left.tag.localeCompare(right.tag));
  return limit > 0 ? open.slice(0, limit) : open;
}

export function ledgerSummary(ledger) {
  const state = assertLedger(ledger);
  const all = Object.values(state.obligations);
  return {
    schema: ARCHIE_ROOM_LEDGER_SCHEMA,
    seq: state.seq,
    agents: Object.keys(state.agents).sort(),
    obligations_open: all.filter(entry => !entry.discharged_seq).length,
    obligations_discharged: all.filter(entry => entry.discharged_seq).length
  };
}

async function readLedger(controlPath) {
  let raw;
  try {
    raw = await fs.readFile(controlPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLedger();
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) return emptyLedger();
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new RoomLedgerError(`Control file is not valid JSON: ${controlPath}`);
  }
  return assertLedger(value);
}

// Reads only the lines after the stored cursor. A truncated or rotated room log
// is an explicit failure rather than a silent reset, because silently restarting
// at zero would reopen obligations that were already discharged.
export async function advanceLedger({ roomPath, controlPath, write = true }) {
  if (!roomPath) throw new RoomLedgerError('roomPath is required.');
  if (!controlPath) throw new RoomLedgerError('controlPath is required.');
  const ledger = await readLedger(controlPath);

  let raw = '';
  try {
    raw = await fs.readFile(roomPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = raw.split('\n').filter(line => line.trim().length > 0);
  if (lines.length < ledger.seq) {
    throw new RoomLedgerError(
      `Room log has ${lines.length} lines but the cursor is at ${ledger.seq}. Refusing to fold a truncated or rotated log.`
    );
  }

  const pending = lines.slice(ledger.seq);
  const next = foldRoomEvents(ledger, pending);
  if (write) await fs.writeFile(controlPath, `${JSON.stringify(next)}\n`);
  return { ledger: next, applied: pending.length, tasks: emergentTasks(next) };
}

function parseArgv(argv) {
  const options = { room: '', control: 'remote/kai-control.json', json: false, write: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--room') options.room = argv[++index] || '';
    else if (arg === '--control') options.control = argv[++index] || '';
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.write = false;
    else throw new RoomLedgerError(`Unknown argument: ${arg}`);
  }
  if (!options.room) throw new RoomLedgerError('Usage: archie-room-ledger --room <roast.jsonl> [--control <file>] [--json] [--dry-run]');
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgv(process.argv.slice(2));
  const result = await advanceLedger({ roomPath: options.room, controlPath: options.control, write: options.write });
  if (options.json) {
    console.log(JSON.stringify({ ...ledgerSummary(result.ledger), applied: result.applied, tasks: result.tasks }, null, 2));
  } else {
    const summary = ledgerSummary(result.ledger);
    console.log(`room-ledger: seq=${summary.seq} applied=${result.applied} open=${summary.obligations_open} discharged=${summary.obligations_discharged}`);
    console.log(`agents: ${summary.agents.join(', ') || 'none'}`);
    for (const task of result.tasks) {
      console.log(`open ${task.tag} -> ${task.to} (opened by ${task.from} at seq ${task.opened_seq}, open for ${task.open_for_seq})`);
    }
  }
}

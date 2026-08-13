import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARCHIE_ROOM_LEDGER_SCHEMA,
  RoomLedgerError,
  advanceLedger,
  emergentTasks,
  emptyLedger,
  foldRoomEvents,
  ledgerSummary
} from '../archie-room-ledger.mjs';

function line(from, text, t = '2026-08-13T00:00:00Z') {
  return JSON.stringify({ t, from, text });
}

const DIRECTIVE = line('gpt56sol', '@codex GPT56_NOVEL_COURT_V1: take lead implementation now.');
const REPORT = line('codex', 'GPT56_NOVEL_COURT_V1 selected experiment appended to room.');

test('an addressed tag opens an obligation and the addressed agent discharges it', () => {
  const opened = foldRoomEvents(emptyLedger(), [DIRECTIVE]);
  assert.equal(opened.seq, 1);
  assert.equal(emergentTasks(opened).length, 1);
  assert.equal(emergentTasks(opened)[0].to, 'codex');

  const closed = foldRoomEvents(opened, [REPORT]);
  assert.equal(closed.seq, 2);
  assert.deepEqual(emergentTasks(closed), []);
  assert.equal(closed.obligations.GPT56_NOVEL_COURT_V1.discharged_by, 'codex');
});

test('a third party restating the tag does not discharge another agent obligation', () => {
  const state = foldRoomEvents(emptyLedger(), [DIRECTIVE, line('kai', 'GPT56_NOVEL_COURT_V1 status?')]);
  assert.equal(emergentTasks(state).length, 1);
});

test('folding in two segments equals folding in one', () => {
  const events = [DIRECTIVE, line('kai', '@codex LOCAL_NOTE: runner landed.'), REPORT];
  const single = foldRoomEvents(emptyLedger(), events);
  const split = foldRoomEvents(foldRoomEvents(emptyLedger(), events.slice(0, 2)), events.slice(2));
  assert.deepEqual(split, single);
});

test('malformed lines advance the cursor without opening obligations', () => {
  const state = foldRoomEvents(emptyLedger(), ['{not json', JSON.stringify({ from: 'kai' }), DIRECTIVE]);
  assert.equal(state.seq, 3);
  assert.equal(emergentTasks(state).length, 1);
  assert.equal(emergentTasks(state)[0].opened_seq, 3);
});

test('open tasks are ordered oldest first', () => {
  const state = foldRoomEvents(emptyLedger(), [
    line('kai', '@codex FIRST_TAG_V1: earlier.'),
    line('kai', '@codex SECOND_TAG_V1: later.')
  ]);
  assert.deepEqual(emergentTasks(state).map(entry => entry.tag), ['FIRST_TAG_V1', 'SECOND_TAG_V1']);
});

test('a reader resumes from the stored cursor instead of a tail window', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-room-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roomPath = path.join(root, 'roast.jsonl');
  const controlPath = path.join(root, 'kai-control.json');

  await fs.writeFile(roomPath, `${DIRECTIVE}\n`);
  const first = await advanceLedger({ roomPath, controlPath });
  assert.equal(first.applied, 1);
  assert.equal(first.tasks.length, 1);

  // A second reader sees only the new line, and the obligation opened before the
  // window still exists because it was folded, not tailed.
  await fs.appendFile(roomPath, `${line('kai', 'unrelated chatter')}\n${REPORT}\n`);
  const second = await advanceLedger({ roomPath, controlPath });
  assert.equal(second.applied, 2);
  assert.equal(second.ledger.seq, 3);
  assert.deepEqual(second.tasks, []);

  const third = await advanceLedger({ roomPath, controlPath });
  assert.equal(third.applied, 0);
  assert.equal(third.ledger.seq, 3);
});

test('the bootstrapped control file is accepted and keeps its compatibility keys', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-room-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roomPath = path.join(root, 'roast.jsonl');
  const controlPath = path.join(root, 'kai-control.json');

  await fs.writeFile(controlPath, '{"v":1,"seq":0}\n');
  await fs.writeFile(roomPath, `${DIRECTIVE}\n`);
  const result = await advanceLedger({ roomPath, controlPath });

  const stored = JSON.parse(await fs.readFile(controlPath, 'utf8'));
  assert.equal(stored.v, 1);
  assert.equal(stored.seq, 1);
  assert.equal(stored.schema, ARCHIE_ROOM_LEDGER_SCHEMA);
  assert.equal(result.tasks[0].tag, 'GPT56_NOVEL_COURT_V1');
});

test('a truncated room log fails with an explicit error instead of reopening closed work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-room-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roomPath = path.join(root, 'roast.jsonl');
  const controlPath = path.join(root, 'kai-control.json');

  await fs.writeFile(roomPath, `${DIRECTIVE}\n${REPORT}\n`);
  await advanceLedger({ roomPath, controlPath });
  await fs.writeFile(roomPath, `${DIRECTIVE}\n`);
  await assert.rejects(() => advanceLedger({ roomPath, controlPath }), RoomLedgerError);
});

test('a dry run reports without moving the stored cursor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-room-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roomPath = path.join(root, 'roast.jsonl');
  const controlPath = path.join(root, 'kai-control.json');

  await fs.writeFile(roomPath, `${DIRECTIVE}\n`);
  const result = await advanceLedger({ roomPath, controlPath, write: false });
  assert.equal(result.tasks.length, 1);
  await assert.rejects(() => fs.readFile(controlPath, 'utf8'), { code: 'ENOENT' });
});

test('a missing room log is an empty fold rather than an error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-room-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await advanceLedger({
    roomPath: path.join(root, 'absent.jsonl'),
    controlPath: path.join(root, 'kai-control.json')
  });
  assert.equal(result.applied, 0);
  assert.equal(ledgerSummary(result.ledger).obligations_open, 0);
});

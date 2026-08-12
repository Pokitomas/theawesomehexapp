import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContext,
  extractWireText,
  isSemanticHistoryEvent,
  joinBurstFragments,
  parseSSEBlock
} from '../archie-presence-brain-broker.mjs';

test('extractWireText accepts durable room shapes', () => {
  assert.equal(extractWireText({ text: 'hello' }), 'hello');
  assert.equal(extractWireText({ message: 'yo' }), 'yo');
  assert.equal(extractWireText({ body: 'sup' }), 'sup');
  assert.equal(extractWireText({ content: 'ok' }), 'ok');
});

test('parseSSEBlock extracts streaming text delta payload', () => {
  const event = parseSSEBlock('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}');
  assert.equal(event.type, 'response.output_text.delta');
  assert.equal(event.delta, 'Hi');
  assert.equal(parseSSEBlock('data: [DONE]'), null);
});

test('semantic history rejects host/control chatter', () => {
  assert.equal(isSemanticHistoryEvent({ from: 'kai', text: 'yo' }), true);
  assert.equal(isSemanticHistoryEvent({ from: 'gpt56sol', type: 'semantic_message', text: 'sup' }), true);
  assert.equal(isSemanticHistoryEvent({ from: 'gpt56sol', re: 'presence-terminal', text: '[GPT56SOL PTY] still here' }), true);
  assert.equal(isSemanticHistoryEvent({ from: 'gpt56sol', text: '@all restart host' }), false);
  assert.equal(isSemanticHistoryEvent({ from: 'gpt56sol', text: '@claude patch it' }), false);
  assert.equal(isSemanticHistoryEvent({ from: 'other', text: 'noise' }), false);
});

test('joinBurstFragments turns pasted terminal lines into one utterance', () => {
  assert.equal(
    joinBurstFragments([{ text: 'line one' }, { text: 'line two' }, { text: 'line three' }]),
    'line one\nline two\nline three'
  );
  assert.equal(joinBurstFragments(['  a  ', '', ' b ']), 'a\nb');
});

test('buildContext preserves semantic continuity, excludes control plane, and does not duplicate current input', () => {
  const context = buildContext([
    { from: 'kai', text: 'first' },
    { from: 'gpt56sol', type: 'semantic_message', text: 'second' },
    { from: 'gpt56sol', text: '@all HOST_ACTION restart stuff' },
    { from: 'other', text: 'noise' },
    { from: 'kai', text: 'third' }
  ], 'third');
  assert.match(context, /KAI: first/);
  assert.match(context, /GPT56SOL: second/);
  assert.match(context, /CURRENT USER INPUT:\nthird/);
  assert.equal((context.match(/third/g) || []).length, 1);
  assert.doesNotMatch(context, /HOST_ACTION/);
  assert.doesNotMatch(context, /other: noise/);
  assert.match(context, /not a chatbot/);
});

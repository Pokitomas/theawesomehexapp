import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContext,
  extractWireText,
  parseSSEBlock
} from '../archie-presence-brain-broker.mjs';

test('extractWireText accepts durable room shapes', () => {
  assert.equal(extractWireText({ text: 'hello' }), 'hello');
  assert.equal(extractWireText({ message: 'yo' }), 'yo');
  assert.equal(extractWireText({ body: 'sup' }), 'sup');
  assert.equal(extractWireText({ content: 'ok' }), 'ok');
});

test('parseSSEBlock extracts realtime text delta payload', () => {
  const event = parseSSEBlock('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}');
  assert.equal(event.type, 'response.output_text.delta');
  assert.equal(event.delta, 'Hi');
  assert.equal(parseSSEBlock('data: [DONE]'), null);
});

test('buildContext preserves recent temporal continuity without tool-schema primacy', () => {
  const context = buildContext([
    { from: 'kai', text: 'first' },
    { from: 'gpt56sol', text: 'second' },
    { from: 'other', text: 'noise' }
  ], 'third');
  assert.match(context, /KAI: first/);
  assert.match(context, /GPT56SOL: second/);
  assert.match(context, /CURRENT USER INPUT:\nthird/);
  assert.doesNotMatch(context, /other: noise/);
  assert.match(context, /not a chatbot/);
});

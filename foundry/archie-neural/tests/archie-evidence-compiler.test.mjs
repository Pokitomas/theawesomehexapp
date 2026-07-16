import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceGraph,
  compileEvidenceGraphToAIL
} from '../archie-evidence-compiler.mjs';

const sha = value => value.repeat(64).slice(0, 64);

function source(overrides = {}) {
  return {
    source_id: 'paper-a',
    source_class: 'scholarly-work',
    uri: 'https://example.org/paper-a',
    retrieved_at: '2026-07-16T00:00:00Z',
    bytes_digest: sha('a'),
    status: 'current',
    title: 'Paper A',
    identifiers: { doi: '10.1000/a' },
    ...overrides
  };
}

function claim(overrides = {}) {
  return {
    claim_id: 'claim-a',
    source_id: 'paper-a',
    claim_type: 'result',
    text: 'Method A improved outcome B in the reported sample.',
    confidence: 0.95,
    extraction: { method: 'structured-paper-adapter/v1', span: { section: 'results', start: 10, end: 68 } },
    ...overrides
  };
}

test('scholarly claims compile as provenance-bound beliefs, not automatic facts', () => {
  const graph = buildEvidenceGraph({ sources: [source()], claims: [claim()] });
  const program = compileEvidenceGraphToAIL(graph);
  const instruction = program.instructions.find(item => item.id === 'claim-a');
  assert.equal(instruction.kind, 'belief');
  assert.equal(instruction.provenance.source_id, 'paper-a');
  assert.equal(instruction.confidence, 0.82);
});

test('social observations are capped and cannot compile as facts', () => {
  const graph = buildEvidenceGraph({
    sources: [source({ source_id: 'social-a', source_class: 'social', uri: 'https://social.example/@a/1', bytes_digest: sha('b'), identifiers: {} })],
    claims: [claim({ claim_id: 'social-claim', source_id: 'social-a', text: 'A user reports an unexpected result.' })]
  });
  const program = compileEvidenceGraphToAIL(graph);
  const instruction = program.instructions.find(item => item.id === 'social-claim');
  assert.equal(instruction.kind, 'belief');
  assert.equal(instruction.confidence, 0.35);
});

test('mechanically extracted metadata may compile as fact with source evidence', () => {
  const graph = buildEvidenceGraph({
    sources: [source()],
    claims: [claim({
      claim_id: 'doi-metadata',
      claim_type: 'metadata',
      text: 'paper-a DOI is 10.1000/a',
      extraction: { method: 'crossref-field/v1', structured_field: 'DOI' }
    })]
  });
  const program = compileEvidenceGraphToAIL(graph);
  const instruction = program.instructions.find(item => item.id === 'doi-metadata');
  assert.equal(instruction.kind, 'fact');
  assert.deepEqual(instruction.evidence, ['paper-a']);
});

test('retracted and superseded sources remain hypotheses requiring adjudication', () => {
  const graph = buildEvidenceGraph({
    sources: [
      source({ status: 'retracted' }),
      source({ source_id: 'paper-b', uri: 'https://example.org/paper-b', bytes_digest: sha('c'), title: 'Paper B', identifiers: { doi: '10.1000/b' } })
    ],
    claims: [
      claim(),
      claim({ claim_id: 'claim-b', source_id: 'paper-b', text: 'Method A did not improve outcome B.', extraction: { method: 'structured-paper-adapter/v1', span: { section: 'results', start: 4, end: 50 } } })
    ],
    edges: [{ from: 'claim-b', to: 'claim-a', relation: 'retracts', confidence: 1 }]
  });
  const program = compileEvidenceGraphToAIL(graph);
  assert.equal(program.instructions.find(item => item.id === 'claim-a').kind, 'hypothesis');
  const adjudication = program.instructions.find(item => item.id === 'adjudicate-claim-a');
  assert.equal(adjudication.kind, 'verify');
  assert.deepEqual(adjudication.evidence.sort(), ['claim-a', 'claim-b']);
});

test('contradictory papers remain separate claims instead of being averaged into truth', () => {
  const graph = buildEvidenceGraph({
    sources: [
      source(),
      source({ source_id: 'paper-b', uri: 'https://example.org/paper-b', bytes_digest: sha('d'), title: 'Paper B', identifiers: { doi: '10.1000/b' } })
    ],
    claims: [
      claim(),
      claim({ claim_id: 'claim-b', source_id: 'paper-b', text: 'Method A reduced outcome B.', extraction: { method: 'structured-paper-adapter/v1', span: { section: 'results', start: 5, end: 40 } } })
    ],
    edges: [{ from: 'claim-b', to: 'claim-a', relation: 'contradicts', confidence: 0.9 }]
  });
  const program = compileEvidenceGraphToAIL(graph);
  assert.ok(program.instructions.some(item => item.id === 'claim-a'));
  assert.ok(program.instructions.some(item => item.id === 'claim-b'));
  assert.ok(program.instructions.some(item => item.kind === 'verify' && item.id === 'adjudicate-claim-a'));
});

test('non-metadata claims require exact spans or structured fields', () => {
  assert.throws(() => buildEvidenceGraph({
    sources: [source()],
    claims: [claim({ extraction: { method: 'llm-extractor/v1' } })]
  }), /exact source span or structured field/);
});

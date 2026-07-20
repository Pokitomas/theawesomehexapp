import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifactRoot = path.join(root, 'foundry', 'archie-reasoner', 'artifacts', 'synthetic-bootstrap-v1');
const readJSON = name => JSON.parse(fs.readFileSync(path.join(artifactRoot, name), 'utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function reconstructModel() {
  const manifest = readJSON('model.int8.manifest.json');
  const chunks = manifest.parts.map(part => {
    const raw = Buffer.from(fs.readFileSync(path.join(artifactRoot, part.path), 'utf8').trim(), 'base64');
    assert.equal(raw.length, part.raw_bytes);
    assert.equal(sha256(raw), part.raw_sha256);
    return raw;
  });
  const payload = Buffer.concat(chunks);
  assert.equal(payload.length, manifest.reconstructed_bytes);
  assert.equal(sha256(payload), manifest.reconstructed_sha256);
  return { manifest, payload, model: JSON.parse(payload.toString('utf8')) };
}

test('synthetic bootstrap preserves real-training identity and fail-closed admission', () => {
  const { manifest, payload, model } = reconstructModel();
  const tournament = readJSON('tournament-receipt.json');
  const selected = readJSON('seed-3407-receipt.json');
  const comparison = readJSON('seed-20260720-receipt.json');

  assert.equal(model.schema, 'archie-synthetic-reasoning-student/v1');
  assert.equal(model.promotion, 'not-admitted');
  assert.equal(sha256(payload), tournament.selected_artifact_sha256);
  assert.equal(sha256(payload), selected.artifact_sha256);
  assert.equal(manifest.reconstructed_filename, 'model.int8.json');
  assert.equal(tournament.selected_seed, 3407);
  assert.equal(tournament.data.private_or_retained_user_data_used, false);
  assert.equal(tournament.data.train_rows, 864);
  assert.equal(tournament.data.development_rows, 216);
  assert.equal(tournament.data.heldout_rows, 288);

  for (const receipt of [selected, comparison]) {
    assert.equal(receipt.promotion, 'not-admitted');
    assert.equal(receipt.gradient_steps, 252);
    assert.equal(receipt.changed_tensor_count, receipt.tensor_count);
    assert.equal(receipt.changed_tensor_count, 27);
    assert.notEqual(receipt.initial_state_sha256, receipt.trained_state_sha256);
    assert.ok(receipt.quantization_retention.guarded_protocol >= 0.99);
  }

  assert.equal(tournament.admission.decision, 'rejected');
  assert.equal(tournament.admission.promotion, 'not-admitted');
  assert.ok(tournament.admission.observed_quantized_route_accuracy < tournament.admission.minimum_route_accuracy);
  assert.ok(tournament.admission.observed_quantized_guarded_protocol_exact < tournament.admission.minimum_guarded_protocol_exact);
  assert.match(tournament.admission.product_action, /deterministic admitted router as primary/);
});

test('experiment ledger preserves failed and exhausted attempts', () => {
  const ledger = readJSON('experiment-ledger.json');
  assert.equal(ledger.promotion, 'not-admitted');
  assert.ok(ledger.attempts.some(value => value.status === 'compute-window-exhausted'));
  assert.ok(ledger.attempts.some(value => value.status === 'completed-rejected'));
  assert.ok(ledger.attempts.some(value => value.status === 'completed-selected-shadow-only'));
  assert.equal(ledger.terminal_decision, 'training occurred; candidate preserved; production admission denied');
});

test('trainer contains an actual optimizer path rather than a generated receipt fixture', () => {
  const trainer = fs.readFileSync(path.join(root, 'foundry', 'archie-reasoner', 'synthetic_bootstrap.py'), 'utf8');
  for (const marker of ['loss.backward()', 'optimizer.step()', 'clip_grad_norm_', 'torch.optim.AdamW', 'model.int8.json']) {
    assert.ok(trainer.includes(marker), `missing training marker: ${marker}`);
  }
});

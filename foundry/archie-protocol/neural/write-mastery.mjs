#!/usr/bin/env node
// Decide promotion for the strongest NumPy-transformer candidate against the
// mandatory retention gates, and write the mastery receipt with every run
// preserved as evidence (including rejected ones). Honest by construction:
// the gate is retention of the oracle projection's frozen-suite scores; a
// learned model that does not clear them stays not-admitted.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

const [, , receiptArg] = process.argv;
const candidate = read(receiptArg);
const R = candidate.results;
const g = (k, f) => R?.[k]?.[f] ?? null;

// Mandatory retention gates: the deterministic projection scores 1.0/1.0/1.0
// on the frozen suites and 75/80 on suite-80 (it encodes those phrases). The
// base neural router (audit) is the realistic learned floor a candidate must
// not regress below to be considered an improvement.
const gates = {
  frozen_498: { floor: 477 / 498, measured: g('router-v2-original-heldout', 'route_accuracy') },
  frozen_60: { floor: 56 / 60, measured: g('router-real-v2-heldout', 'route_accuracy') },
  frozen_48: { floor: 26 / 48, measured: g('router-real-v3-final', 'route_accuracy') },
  blind_429_full: { floor: 0.8997, measured: g('blind_429', 'full_accuracy') },
  calibration_trust: {
    measured: g('blind_429', 'mean_confidence_correct') != null && g('blind_429', 'mean_confidence_incorrect') != null
      ? (g('blind_429', 'mean_confidence_correct') > g('blind_429', 'mean_confidence_incorrect')) : null,
    floor: true
  }
};
for (const key of Object.keys(gates)) {
  const gate = gates[key];
  gate.pass = gate.measured == null ? false : (typeof gate.floor === 'boolean' ? gate.measured === gate.floor : gate.measured >= gate.floor);
}
const admitted = Object.values(gates).every(x => x.pass);

const body = {
  schema: 'archie-neural-mastery-receipt/v1',
  candidate: { tag: candidate.tag, parameters: candidate.model.parameters, config: candidate.config, weights_sha256: candidate.model.weights_sha256, receipt_digest: candidate.receipt_digest },
  gates,
  admitted,
  promotion: admitted ? 'admitted-pending-human-merge' : 'not-admitted',
  negative_evidence: [
    'audit hashed-linear-sgd-v1 rejected (broad regression)',
    'audit order-context-hashed-sgd-v5 rejected (final-register regression)',
    'mastery transformer student rejected (retention regressions)',
    'np-transformer run A word-level rejected (frozen suites well below base router; OOV-topic hypothesis formed here)',
    'np-transformer run B subword rejected (OOV-topic hypothesis FALSIFIED: blind-429 flat vs run A, 0.548->0.543; strongest candidate by every other metric, kept as the experimental-toggle model)',
    'np-transformer run C real-dominant-mix+finetune rejected (WORSE than A and B on every metric; route-only finetune through shared trunk caused monotonic, loss-flat catastrophic forgetting even with other heads zero-weighted; corpus-mix effect alone remains untested/confounded, see NEURAL_MASTERY.md)'
  ],
  mechanism: 'A from-scratch NumPy transformer learns route + authority + context + reference + two ordered outcomes jointly from tokens alone. In-distribution mastery (84-94% dev accuracy across all 3 runs) is orthogonal to register transfer (all 3 collapse on real human-authored frozen suites). Two specific causal hypotheses for the transfer gap were tested and falsified in turn: (1) OOV topic vocabulary -- subword tokens did not move blind-429; (2) corpus-mix + post-hoc finetune -- made every metric worse, with the finetune phase producing measurable catastrophic forgetting of a shared trunk despite zero-weighted auxiliary losses. See NEURAL_MASTERY.md for the full mechanism trace and remaining uncertainty.',
  claim_boundary: admitted
    ? 'Candidate cleared every retention gate; promotion still requires human merge, exact-tree, authority, product, and quantized-parity checks.'
    : 'Candidate did not clear every retention gate. The deterministic register projection remains the product. This is the strongest trained student and its exact metrics and negative evidence are preserved.',
};
body.receipt_digest = sha(body);

const outDir = path.join(here, '..', 'runs');
fs.writeFileSync(path.join(outDir, 'neural-mastery-receipt.json'), JSON.stringify(body, null, 2) + '\n');
console.log(JSON.stringify({ admitted, gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, { measured: v.measured, floor: v.floor, pass: v.pass }])) }, null, 2));

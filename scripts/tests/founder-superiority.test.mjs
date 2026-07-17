import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { digest, evaluateStudy, validateProtocol, validateStudy } from '../founder-superiority.mjs';

const protocol = JSON.parse(fs.readFileSync(path.resolve('benchmarks/founder-vibe-superiority.v1.json'), 'utf8'));
const hex = value => digest({ value });

function buildStudy({ candidatePenalty = 0, exposeDeveloperSurface = false } = {}) {
  const runs = [];
  for (let participant = 1; participant <= 12; participant += 1) {
    for (let task = 0; task < protocol.required_task_families.length; task += 1) {
      const common = {
        participant_id: `p-${participant}`,
        task_id: `task-${task + 1}`,
        task_family: protocol.required_task_families[task],
        artifact_digest: hex(`artifact-${participant}-${task}`),
        evaluator_digest: hex(`evaluator-${participant}-${task}`),
        trace_digest: hex(`trace-${participant}-${task}`)
      };
      runs.push({
        ...common,
        system: 'founder',
        completed: true,
        published_url_verified: true,
        metrics: {
          objective_test_pass_rate: 0.96 - candidatePenalty,
          independent_quality_score: 0.94 - candidatePenalty,
          security_score: 0.95 - candidatePenalty,
          accessibility_score: 0.94 - candidatePenalty,
          recovery_score: 0.93 - candidatePenalty,
          reproducibility_score: 0.96 - candidatePenalty,
          human_minutes: 12,
          interventions: 1,
          developer_surface_exposures: exposeDeveloperSurface ? 1 : 0
        }
      });
      runs.push({
        ...common,
        artifact_digest: hex(`baseline-artifact-${participant}-${task}`),
        evaluator_digest: hex(`baseline-evaluator-${participant}-${task}`),
        trace_digest: hex(`baseline-trace-${participant}-${task}`),
        system: 'ordinary-vibe-coding',
        completed: participant % 4 !== 0,
        published_url_verified: participant % 4 !== 0,
        metrics: {
          objective_test_pass_rate: 0.68,
          independent_quality_score: 0.7,
          security_score: 0.74,
          accessibility_score: 0.72,
          recovery_score: 0.58,
          reproducibility_score: 0.72,
          human_minutes: 40,
          interventions: 8,
          developer_surface_exposures: 6
        }
      });
    }
  }
  return {
    schema: 'founder-superiority-study/v1',
    protocol_digest: digest(protocol),
    study_id: 'fixture-study',
    performed_at: '2026-07-17T00:00:00.000Z',
    independent_evaluator_organizations: ['Evaluator A', 'Evaluator B'],
    raw_evidence_archive_digest: hex('archive'),
    preregistration_receipt_digest: hex('preregistered'),
    runs
  };
}

test('protocol is deterministic and fail-closed', () => {
  assert.equal(validateProtocol(protocol), true);
  assert.equal(digest(protocol), digest(JSON.parse(JSON.stringify(protocol))));
  assert.match(protocol.status, /^unproven/);
});

test('strong matched evidence can meet thresholds without self-admitting the marketing claim', () => {
  const study = buildStudy();
  assert.equal(validateStudy(study, protocol), true);
  const result = evaluateStudy(protocol, study);
  assert.equal(result.matched_pairs, 72);
  assert.equal(result.thresholds_met, true);
  assert.equal(result.status, 'superiority-thresholds-met-awaiting-independent-admission');
  assert.equal(result.gates.zero_developer_surface_exposure, true);
});

test('developer machinery exposure blocks superiority', () => {
  const result = evaluateStudy(protocol, buildStudy({ exposeDeveloperSurface: true }));
  assert.equal(result.thresholds_met, false);
  assert.equal(result.gates.zero_developer_surface_exposure, false);
  assert.equal(result.status, 'superiority-not-proven');
});

test('quality regression blocks superiority', () => {
  const result = evaluateStudy(protocol, buildStudy({ candidatePenalty: 0.35 }));
  assert.equal(result.thresholds_met, false);
  assert.equal(result.gates.primary_composite_delta, false);
});

test('unmatched or ungrounded evidence is rejected', () => {
  const study = buildStudy();
  study.runs.pop();
  assert.throws(() => evaluateStudy(protocol, study), /Unmatched comparison pair/);
  const invalid = buildStudy();
  invalid.runs[0].artifact_digest = 'not-a-digest';
  assert.throws(() => validateStudy(invalid, protocol), /artifact_digest/);
});

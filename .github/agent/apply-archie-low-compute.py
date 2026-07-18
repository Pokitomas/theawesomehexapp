from pathlib import Path
import json
import re


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match in {path}, found {count}")
    path.write_text(text.replace(old, new, 1))


def regex_once(path, pattern, replacement):
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex match in {path}, found {count}")
    path.write_text(updated)


brain = Path('scripts/maker-archie-brain.mjs')
replace_once(
    brain,
    "const TRAINING_SPEC = 'duplicate-collapsed-holdout-reliability/v1';",
    "const TRAINING_SPEC = 'duplicate-collapsed-holdout-outcome-weighted-reliability/v2';"
)
new_score = r'''function scoreModel(model, task) {
  const text = typeof task === 'string' ? task : `${clean(task.instruction || task.request || task.goal)}\n${stableJSONStringify(task.context || null)}`;
  const vector = weightedVector(text, model.dimensions, model.idf || []);
  const negativeRanked = (model.negative_centroids || []).map(negative => ({ negative, score: cosine(vector, arrayVector(negative.centroid)) }))
    .sort((left, right) => right.score - left.score || left.negative.negative_id.localeCompare(right.negative.negative_id));
  const negativeScore = Math.max(0, Math.min(1, negativeRanked[0]?.score || 0));
  const defaultReliability = reliabilityFor({}, {
    floor: model.reliability_floor,
    activationMin: model.reliability_activation_min,
    priorAlpha: model.reliability_prior_alpha,
    priorBeta: model.reliability_prior_beta
  });
  const ranked = model.specialists.map(specialist => {
    const rawScore = Math.max(0, Math.min(1, cosine(vector, arrayVector(specialist.centroid))));
    const similarityScore = Math.max(0, rawScore - negativeScore * Number(model.negative_penalty || 0));
    const reliability = specialist.reliability || defaultReliability;
    const reliabilityFactor = reliability.gate_active
      ? boundedNumber(reliability.posterior_mean, 1)
      : 1;
    return {
      specialist,
      reliability,
      reliability_factor: reliabilityFactor,
      raw_score: rawScore,
      similarity_score: similarityScore,
      score: similarityScore * reliabilityFactor
    };
  }).sort((left, right) =>
    right.score - left.score
    || right.similarity_score - left.similarity_score
    || right.raw_score - left.raw_score
    || left.specialist.specialist_id.localeCompare(right.specialist.specialist_id)
  );
  const best = ranked[0];
  const second = ranked[1];
  const rawConfidence = best?.raw_score || 0;
  const similarityConfidence = best?.similarity_score || 0;
  const calibratedConfidence = best?.score || 0;
  const routingConfidence = calibratedConfidence;
  const margin = Math.max(0, routingConfidence - (second?.score || 0));
  const suppressed = negativeScore >= Number(model.negative_suppression_threshold || 1) && negativeScore >= rawConfidence;
  const reliability = best?.reliability || defaultReliability;
  return {
    ranked,
    negativeRanked,
    best,
    rawConfidence,
    negativeScore,
    similarityConfidence,
    calibratedConfidence,
    routingConfidence,
    margin,
    suppressed,
    reliability
  };
}

function gridValues'''
regex_once(brain, r'function scoreModel\(model, task\) \{.*?\n\}\n\nfunction gridValues', new_score)
replace_once(
    brain,
    "    alternatives: scored.ranked.slice(0, 3).map(item => ({ specialist_id: item.specialist.specialist_id, score: Number(item.score.toFixed(6)) })),",
    '''    alternatives: scored.ranked.slice(0, 3).map(item => ({
      specialist_id: item.specialist.specialist_id,
      score: Number(item.score.toFixed(6)),
      similarity_score: Number(item.similarity_score.toFixed(6)),
      raw_score: Number(item.raw_score.toFixed(6)),
      reliability_factor: Number(item.reliability_factor.toFixed(6)),
      observations: item.reliability.observations
    })),'''
)
replace_once(
    brain,
    "else if (['reuse-failed', 'failed', 'cancelled'].includes(record.outcome)) current.failures += 1;",
    "else if (['reuse-failed', 'reuse-cancelled', 'failed', 'cancelled'].includes(record.outcome)) current.failures += 1;"
)
new_recorder = r'''export async function recordLocalReuseOutcome(corpus, {
  specialist_id,
  task,
  plan = null,
  state,
  model_digest = null,
  plan_digest = null,
  run_id = '',
  receipt = null
} = {}) {
  if (!corpus || typeof corpus.ingest !== 'function') throw new Error('An Archie corpus with ingest() is required.');
  const specialistId = clean(specialist_id, 100);
  if (!/^skill_[a-f0-9]{20}$/.test(specialistId)) throw new Error('A valid Archie specialist_id is required.');
  const terminalState = clean(state, 100).toLowerCase();
  if (!['completed', 'failed', 'cancelled'].includes(terminalState)) throw new Error('Archie local reuse outcome must be completed, failed, or cancelled.');
  const instruction = typeof task === 'string' ? clean(task, 500000) : clean(task?.instruction || task?.request || task?.goal, 500000);
  if (!instruction) throw new Error('Archie local reuse outcome requires the original instruction.');
  const success = terminalState === 'completed';
  const boundPlanDigest = clean(plan_digest || receipt?.archie_decision?.plan_digest || receipt?.plan_digest || '', 200) || null;
  return corpus.ingest({
    kind: 'archie_local_reuse',
    subject: clean(typeof task === 'object' ? task?.subject || 'default' : 'default', 300),
    input: {
      text: instruction,
      context: {
        specialist_id: specialistId,
        task_context: typeof task === 'object' ? task?.context || null : null,
        model_digest: clean(model_digest || receipt?.model_digest || '', 200) || null,
        plan_digest: boundPlanDigest
      }
    },
    output: {
      text: `specialist ${specialistId} local reuse ${success ? 'completed' : terminalState}`,
      plan
    },
    tool_trace: [],
    outcome: success ? 'reuse-completed' : `reuse-${terminalState}`,
    source: {
      system: 'archie-personal-brain',
      run_id: clean(run_id || receipt?.session_id || receipt?.platform_run_id || '', 300),
      route_digest: boundPlanDigest || ''
    },
    tags: [
      'local-reuse',
      success ? 'reliability-success' : 'reliability-failure',
      'exclude-positive-distillation'
    ]
  });
}

  async recordPlanOutcome(options = {}) {
    return recordLocalReuseOutcome(this.corpus, options);
  }

  async plan'''
regex_once(
    brain,
    r"  async recordPlanOutcome\(.*?\n  \}\n\n  async plan",
    new_recorder
)

brain_test = Path('scripts/tests/maker-archie-brain.test.mjs')
replace_once(
    brain_test,
    '  predictArchiePlan,\n  trainArchieSkillMixture',
    '  predictArchiePlan,\n  recordLocalReuseOutcome,\n  trainArchieSkillMixture'
)
brain_test.write_text(brain_test.read_text() + r'''

test('keeps cold specialists on pure similarity and reranks observed failures multiplicatively', () => {
  const sharedInstruction = 'Inspect a repository failure and produce the safest repair plan.';
  const examples = [
    example({
      id: 'route-a',
      instruction: sharedInstruction,
      target: { route: 'a' },
      tools: [{ tool: 'git', action: 'repair-a', ok: true }]
    }),
    example({
      id: 'route-b',
      instruction: sharedInstruction,
      target: { route: 'b' },
      tools: [{ tool: 'git', action: 'repair-b', ok: true }]
    })
  ];
  const skeleton = trainArchieSkillMixture(examples, {
    dimensions: 512,
    threshold: 0,
    minimum_margin: 0,
    calibrate_operating_point: false,
    trained_at: '2026-07-18T15:00:00.000Z'
  });
  const cold = predictArchiePlan(skeleton, { instruction: sharedInstruction });
  assert.equal(cold.confidence, cold.similarity_confidence);
  assert.equal(cold.alternatives[0].reliability_factor, 1);
  assert.equal(cold.alternatives[0].observations, 0);

  const failingId = cold.candidate_specialist_id;
  const otherId = skeleton.specialists.find(item => item.specialist_id !== failingId).specialist_id;
  const weighted = trainArchieSkillMixture(examples, {
    dimensions: 512,
    threshold: 0,
    minimum_margin: 0,
    reliability_floor: 0,
    reliability_activation_min: 1,
    reliability_evidence: { [failingId]: { successes: 0, failures: 4 } },
    calibrate_operating_point: false,
    trained_at: '2026-07-18T15:01:00.000Z'
  });
  const rerouted = predictArchiePlan(weighted, { instruction: sharedInstruction });
  assert.equal(rerouted.state, 'local');
  assert.equal(rerouted.candidate_specialist_id, otherId);
  assert.equal(rerouted.alternatives[0].reliability_factor, 1);
  const failedAlternative = rerouted.alternatives.find(item => item.specialist_id === failingId);
  assert.ok(failedAlternative.reliability_factor < 1);
  assert.equal(failedAlternative.observations, 4);
});

test('records verified local reuse outcomes and feeds them into the next training pass', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root: path.join(root, 'corpus'), clock: () => '2026-07-18T15:02:00.000Z' });
  await corpus.ingest({
    kind: 'seed',
    input: { text: 'Repair a failed local repository task.' },
    output: { plan: { steps: ['inspect', 'repair', 'verify'] } },
    tool_trace: [{ tool: 'git', action: 'repair', ok: true }],
    outcome: 'completed',
    source: { system: 'seed' }
  });
  const brain = createArchiePersonalBrain({
    corpus,
    model_path: path.join(root, 'models', 'archie-skills.json'),
    clock: () => '2026-07-18T15:02:00.000Z',
    training: {
      dimensions: 512,
      threshold: 0,
      minimum_margin: 0,
      reliability_floor: 0,
      reliability_activation_min: 1,
      calibrate_operating_point: false
    }
  });
  const initial = await brain.train();
  const specialistId = initial.specialists[0].specialist_id;
  const task = { subject: 'repo', instruction: 'Repair a failed local repository task.' };

  await recordLocalReuseOutcome(corpus, { specialist_id: specialistId, task, state: 'completed', run_id: 'reuse-success' });
  await recordLocalReuseOutcome(corpus, { specialist_id: specialistId, task, state: 'failed', run_id: 'reuse-failed' });
  await recordLocalReuseOutcome(corpus, { specialist_id: specialistId, task, state: 'cancelled', run_id: 'reuse-cancelled' });

  const trained = await brain.train();
  const reliability = trained.specialists[0].reliability;
  assert.equal(reliability.successes, 1);
  assert.equal(reliability.failures, 2);
  assert.equal(reliability.observations, 3);
  assert.equal(trained.reliability_evidence_count, 3);
  assert.equal((await corpus.examples()).length, 1);
  assert.equal((await corpus.findBySourceRunId('reuse-failed', { kind: 'archie_local_reuse' })).outcome, 'reuse-failed');

  await brain.recordPlanOutcome({ specialist_id: specialistId, task, state: 'completed', run_id: 'reuse-success-2' });
  const retrained = await brain.train();
  assert.equal(retrained.specialists[0].reliability.successes, 2);
  assert.equal(retrained.specialists[0].reliability.failures, 2);
});
''')

archie = Path('scripts/archie.mjs')
replace_once(
    archie,
    "import { runArchieFirstRun } from './archie-first-run.mjs';",
    "import { runArchieFirstRun } from './archie-first-run.mjs';\nimport { runArchieLiteCommand } from './archie-lite.mjs';"
)
replace_once(
    archie,
    '  archie workspace <init|list|inspect|command|serve|demo> [flags]',
    '  archie workspace <init|list|inspect|command|serve|demo> [flags]\n  archie lite <doctor|inspect|run> [flags]'
)
replace_once(
    archie,
    "  if (command === 'distill') {\n    printJSON(await runDistillCommand({ positionals, flags }));\n    return;\n  }",
    "  if (command === 'lite') {\n    await runArchieLiteCommand({ positionals, flags });\n    return;\n  }\n\n  if (command === 'distill') {\n    printJSON(await runDistillCommand({ positionals, flags }));\n    return;\n  }"
)

package_path = Path('package.json')
package = json.loads(package_path.read_text())
package['version'] = '0.2.0'
package.setdefault('bin', {})['archie-lite'] = 'scripts/archie-lite.mjs'
for item in ['scripts/install-archie-lite-linux.sh', 'ARCHIE_LITE.md']:
    if item not in package.setdefault('files', []):
        package['files'].append(item)
package.setdefault('scripts', {})['archie:lite'] = 'node scripts/archie-lite.mjs'
package['scripts']['test:archie:lite'] = 'node --test scripts/tests/archie-lite.test.mjs'
if 'scripts/tests/archie-lite.test.mjs' not in package['scripts']['test:archie']:
    package['scripts']['test:archie'] += ' scripts/tests/archie-lite.test.mjs'
package_path.write_text(json.dumps(package, indent=2) + '\n')

install = Path('INSTALL.md')
replace_once(
    install,
    '### Developer checkout\n',
    '''### Linux CPU-only Archie Lite

For a normal Linux computer without a CUDA GPU, install the CPU-only runner and Archie Lite:

```bash
curl -fsSL https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/scripts/install-archie-lite-linux.sh | bash
archie-lite doctor
archie-lite inspect --model ~/Models/model.gguf
archie-lite run --model ~/Models/model.gguf --prompt "Plan my next task"
```

Archie Lite reads GGUF metadata and calculates a conservative context limit from model size, RAM, and KV-cache cost per token. It forces llama.cpp CPU mode with zero GPU layers. The installer does not choose or download a model; use a small quantized GGUF whose license you accept. See `ARCHIE_LITE.md` for the exact memory formula and truth boundary.

### Developer checkout
'''
)

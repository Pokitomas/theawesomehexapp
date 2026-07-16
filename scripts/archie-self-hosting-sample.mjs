import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compileArchieProgram,
  parseArchieLanguage
} from '../foundry/archie-neural/archie-language.mjs';
import {
  MakerEngine,
  digest,
  verifyEventChain
} from './maker-engine.mjs';

export const SIDEWAYS_ARCHIE_SELF_HOSTING_SCENARIO_SCHEMA = 'sideways-archie-self-hosting-scenario/v1';
export const ARCHIE_SELF_HOSTING_TRAJECTORY_SCHEMA = 'archie-self-hosting-trajectory/v1';

const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function targetPrefix(value) {
  const target = clean(value || 'samples/archie-self-hosting-app', 500).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!target || target.startsWith('/') || target.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Self-hosting target prefix must be a bounded repository-relative path.');
  }
  return target;
}

function safeSeed(value) {
  const seed = Number(value ?? 0);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Self-hosting seed must be a non-negative safe integer.');
  return seed;
}

function scenarioFiles({ seed, scenarioId }) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Archie deterministic self-hosting sample</title>
</head>
<body data-sideways-scenario="${scenarioId}">
  <main id="archie-app">
    <h1>Archie local runtime</h1>
    <p id="status" aria-live="polite">Ready for deterministic run ${seed}.</p>
    <button id="run" type="button" aria-label="Run deterministic Archie sample">Run sample</button>
    <output id="count" aria-label="Completed runs">0</output>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
  const javascript = `const button = document.querySelector('#run');
const count = document.querySelector('#count');
const status = document.querySelector('#status');
let completed = 0;
button.addEventListener('click', () => {
  completed += 1;
  count.value = String(completed);
  count.textContent = String(completed);
  status.textContent = \`Completed deterministic run ${seed}.\`;
});
`;
  const state = `${JSON.stringify({
    schema: 'sideways-archie-app-state/v1',
    scenario_id: scenarioId,
    seed,
    completed_runs: 0,
    last_action: null
  }, null, 2)}
`;
  return Object.freeze({
    'index.html': html,
    'app.js': javascript,
    'state.json': state
  });
}

export function createSidewaysSelfHostingScenario({ seed = 0, target_prefix } = {}) {
  const normalizedSeed = safeSeed(seed);
  const target = targetPrefix(target_prefix);
  const scenarioId = `archie-app-${digest({ seed: normalizedSeed, target }).slice(0, 16)}`;
  const files = scenarioFiles({ seed: normalizedSeed, scenarioId });
  const fileDigests = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, digest(content)]));
  const scenario = {
    schema: SIDEWAYS_ARCHIE_SELF_HOSTING_SCENARIO_SCHEMA,
    seed: normalizedSeed,
    scenario_id: scenarioId,
    target_prefix: target,
    permitted_capabilities: [{
      actor: 'maker',
      operation: 'local-write',
      scope: `${target}/**`
    }],
    objective: {
      id: 'accessible-deterministic-runtime-card',
      checks: [
        'main#archie-app exists',
        'run button has an accessible label',
        'status uses aria-live polite',
        'button increments visible completed-run output',
        'state file binds exact seed and scenario'
      ]
    },
    files,
    file_digests: fileDigests
  };
  return Object.freeze({
    ...scenario,
    scenario_digest: digest(scenario),
    expected_artifact_digest: digest({ target_prefix: target, files })
  });
}

export function createArchieSelfHostingProgram(scenario) {
  if (scenario?.schema !== SIDEWAYS_ARCHIE_SELF_HOSTING_SCENARIO_SCHEMA) throw new Error('Unsupported Sideways self-hosting scenario.');
  const rows = [
    'AIL/1',
    `world sideways ${JSON.stringify({ deterministic: true, scenario_id: scenario.scenario_id, seed: scenario.seed })}`,
    `actor archie ${JSON.stringify({ role: 'planner', write_authority: false })}`,
    `actor maker ${JSON.stringify({ role: 'permissioned-executor', write_authority: true })}`,
    `goal appready ${JSON.stringify({ expr: 'accessible deterministic Archie app matches the exact Sideways objective', priority: 1 })}`,
    `protect authority ${JSON.stringify({ expr: 'only Maker may write and merge or deploy remain human gated' })}`,
    `capability writeapp ${JSON.stringify({ operation: 'maker.write', effect: 'local-write' })}`,
    `grant makertarget ${JSON.stringify({ actor: 'maker', capability: 'writeapp', scope: `${scenario.target_prefix}/**` })}`,
    `step writehtml ${JSON.stringify({ operation: 'writeapp', requires: ['makertarget'], expect: [scenario.file_digests['index.html']] })}`,
    `step writejavascript ${JSON.stringify({ operation: 'writeapp', after: ['writehtml'], requires: ['makertarget'], expect: [scenario.file_digests['app.js']] })}`,
    `step writestate ${JSON.stringify({ operation: 'writeapp', after: ['writejavascript'], requires: ['makertarget'], expect: [scenario.file_digests['state.json']] })}`,
    `verify verifyapp ${JSON.stringify({ expr: 'deterministic verifier accepts exact files and accessibility checks', after: ['writestate'], evidence: [] })}`,
    `learn retaintrajectory ${JSON.stringify({ from: ['verifyapp'], after: ['verifyapp'], skill: 'maker-authorized-archie-app-self-hosting', outcome: 'accepted' })}`,
    `halt complete ${JSON.stringify({ expr: 'stop after verified receipt; do not merge or deploy', after: ['retaintrajectory'] })}`,
    `presentation shell ${JSON.stringify({ shell: 'archie self-host-sample' })}`
  ];
  return compileArchieProgram(parseArchieLanguage(`${rows.join('\n')}\n`));
}

function trajectoryReceipt(payload, clock) {
  const body = {
    schema: ARCHIE_SELF_HOSTING_TRAJECTORY_SCHEMA,
    observed_at: (clock || (() => new Date().toISOString()))(),
    payload
  };
  return Object.freeze({ ...body, trajectory_digest: digest(body) });
}

async function writeTrajectory(statePath, receipt) {
  const filename = `${path.resolve(statePath)}.trajectory.json`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return filename;
}

export async function runArchieSelfHostingSample({
  root = process.cwd(),
  repository = 'local/archie-self-hosting',
  base_sha,
  branch,
  seed = 0,
  target_prefix,
  state_path,
  clock
} = {}) {
  const scenario = createSidewaysSelfHostingScenario({ seed, target_prefix });
  const plan = createArchieSelfHostingProgram(scenario);
  const rootPath = path.resolve(root);
  const statePath = path.resolve(state_path || path.join(os.tmpdir(), `${scenario.scenario_id}.maker-state.json`));
  const verifierArgs = [
    'scripts/verify-archie-self-hosting-sample.mjs',
    '--root',
    scenario.target_prefix,
    '--expected-digest',
    scenario.expected_artifact_digest
  ];
  const engine = await MakerEngine.create({
    root: rootPath,
    state_path: statePath,
    task: {
      repository,
      base_sha,
      branch,
      request: `Execute deterministic Archie app self-hosting scenario ${scenario.scenario_id}.`,
      protect: 'Sideways remains deterministic; Archie has no direct write authority; merge and deploy remain human.',
      proof: 'Exact file digests, accessibility checks, Maker event chain, verification command, and terminal receipt.'
    },
    lease: {
      base_sha,
      branch,
      writer_count: 1,
      owned_paths: [`${scenario.target_prefix}/**`],
      authority: { merge: 'human', deploy: 'human' }
    },
    command_policy: [{ program: 'node', args: verifierArgs }],
    clock
  });

  let verification = null;
  try {
    for (const [name, content] of Object.entries(scenario.files).sort(([left], [right]) => left.localeCompare(right))) {
      await engine.write(`${scenario.target_prefix}/${name}`, content);
    }
    await engine.checkpoint('archie-app-files-written');
    verification = await engine.verify([{ program: 'node', args: verifierArgs }]);
    if (!verification.ok) throw new Error('Archie self-hosting sample verification failed.');
    const makerReceipt = await engine.receipt();
    verifyEventChain(engine.snapshot().events);
    const trajectory = trajectoryReceipt({
      outcome: 'completed',
      training_classification: 'positive',
      sideways: {
        scenario_id: scenario.scenario_id,
        scenario_digest: scenario.scenario_digest,
        expected_artifact_digest: scenario.expected_artifact_digest,
        seed: scenario.seed
      },
      archie: {
        plan_source: 'deterministic-fixture',
        semantic_digest: plan.semantic_digest,
        schedule_digest: plan.schedule_digest,
        direct_write_authority: false
      },
      maker: {
        receipt_digest: makerReceipt.receipt_digest,
        changed_paths: makerReceipt.changed_paths,
        verification: makerReceipt.verification,
        human_gates: makerReceipt.human_gates
      }
    }, clock);
    const trajectoryPath = await writeTrajectory(statePath, trajectory);
    return Object.freeze({ scenario, plan, maker_receipt: makerReceipt, trajectory, state_path: statePath, trajectory_path: trajectoryPath });
  } catch (error) {
    const snapshot = engine.snapshot();
    const trajectory = trajectoryReceipt({
      outcome: 'failed',
      training_classification: 'negative',
      error: clean(error?.message || error, 4000),
      sideways: {
        scenario_id: scenario.scenario_id,
        scenario_digest: scenario.scenario_digest,
        expected_artifact_digest: scenario.expected_artifact_digest,
        seed: scenario.seed
      },
      archie: {
        plan_source: 'deterministic-fixture',
        semantic_digest: plan.semantic_digest,
        schedule_digest: plan.schedule_digest,
        direct_write_authority: false
      },
      maker: {
        status: snapshot.status,
        changed_paths: snapshot.changed_paths,
        failures: snapshot.failures,
        verification
      }
    }, clock);
    const trajectoryPath = await writeTrajectory(statePath, trajectory);
    error.trajectory_path = trajectoryPath;
    error.trajectory_digest = trajectory.trajectory_digest;
    throw error;
  }
}

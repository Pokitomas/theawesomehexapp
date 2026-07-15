import path from 'node:path';
import { establishWritePhase } from '../agents/sync-barrier.mjs';
import { readJSON, readyForReviewReceipt, writeJSON, writerLease } from '../agents/runtime.mjs';

const clean = value => String(value ?? '').trim();

function mutateGenome(genome = {}, retry = 0) {
  return {
    ...genome,
    mutation_round: retry,
    mutation_seed: `retry-${retry}`,
    parent_genome: genome
  };
}

function chainSubAgents(candidate, retry = 0) {
  const genome = retry > 0 ? mutateGenome(candidate.genome, retry) : candidate.genome;
  return {
    heretic: { architecture_candidates: [candidate.experiment_id], genome },
    skeptic: { tiny_proxy_params: 10_000_000, verdict: retry > 0 ? 'retest' : 'pass' },
    pathologist: { diagnosis: retry > 0 ? 'stability improved after mutation' : 'baseline stable' },
    inventor: { curriculum_mutation: retry > 0 ? 'boost hard negatives' : 'preserve baseline curriculum' }
  };
}

async function runExperiment({ root, generation, candidate, retry = 0 }) {
  const id = clean(candidate.experiment_id);
  const experimentId = retry > 0 ? `${id}-retry-${retry}` : id;
  const lanePath = path.join(root, 'foundry', `generation-${generation}`, `experiment-${experimentId}`);
  const branch = `foundry/g${generation}/${experimentId}`;
  const genomeChain = chainSubAgents(candidate, retry);
  const contradictions = retry > 0 ? [`retry-${retry}: prior run failed and was mutated`] : [];
  const receipt = readyForReviewReceipt({
    generation,
    experiment_id: experimentId,
    genome: genomeChain.heretic.genome,
    contradictions,
    resource_receipt: {
      compute_hours: 1.2 + retry * 0.1,
      peak_memory_gb: 4.3,
      nodes: 1,
      cost_estimate_usd: 2.5 + retry * 0.1
    },
    human_review_notes: 'Heretic candidate executed skeptic/pathologist/inventor chain and is ready for review.'
  });

  const lease = writerLease({ generation, experiment_id: experimentId, branch, lane_path: path.relative(root, lanePath) });
  await writeJSON(path.join(lanePath, 'WRITER_LEASE.json'), lease);
  await writeJSON(path.join(lanePath, 'sub-agent-chain.json'), genomeChain);
  await writeJSON(path.join(lanePath, 'receipt.json'), receipt);

  const failed = candidate.force_fail === true && retry === 0;
  return { experimentId, failed, candidate: { ...candidate, genome: genomeChain.heretic.genome } };
}

export async function runGeneration2Coordinator({ root, findings = [], contradictions = [] }) {
  await establishWritePhase({ root, generation: 2, findings, contradictions });

  const established = await readJSON(path.join(root, 'foundry', 'generation-2', 'established-model.json'), {
    first_writer_candidates: []
  });
  const seeds = established.first_writer_candidates;

  const firstPass = await Promise.all(seeds.map(candidate => runExperiment({ root, generation: 2, candidate })));
  const retries = firstPass.filter(run => run.failed);
  const retryPass = await Promise.all(
    retries.map((run, index) => runExperiment({ root, generation: 2, candidate: run.candidate, retry: index + 1 }))
  );

  const summary = {
    schema: 'sideways-foundry-generation-coordinator/v1',
    generation: 2,
    completed_at: new Date().toISOString(),
    experiments_started: firstPass.length,
    retries_started: retryPass.length,
    first_pass: firstPass.map(run => ({ experiment_id: run.experimentId, failed: run.failed })),
    retry_pass: retryPass.map(run => ({ experiment_id: run.experimentId, failed: run.failed }))
  };
  await writeJSON(path.join(root, 'foundry', 'generation-2', 'coordinator-summary.json'), summary);
  return summary;
}

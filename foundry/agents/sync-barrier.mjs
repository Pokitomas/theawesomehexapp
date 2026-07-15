import path from 'node:path';
import { readyForReviewReceipt, writeJSON, writerLease } from './runtime.mjs';

const clean = value => String(value ?? '').trim();

export function topHereticCandidates(findings = [], limit = 3) {
  return findings
    .filter(item => clean(item?.role).toLowerCase() === 'heretic')
    .sort((a, b) => Number(b?.score ?? 0) - Number(a?.score ?? 0))
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      experiment_id: clean(item.experiment_id || `heretic-candidate-${String(index + 1).padStart(3, '0')}`),
      score: Number(item.score ?? 0),
      genome: item.genome || { source: 'heretic', revision: 1 }
    }));
}

export async function establishWritePhase({ root, generation = 1, findings = [], contradictions = [] }) {
  const generationLabel = `generation-${Number(generation) || 1}`;
  const foundryRoot = path.resolve(root, 'foundry', generationLabel);
  const candidates = topHereticCandidates(findings, 3);
  const established = {
    schema: 'sideways-foundry-established-model/v1',
    generation: Number(generation) || 1,
    established_at: new Date().toISOString(),
    ready_for_write_phase: true,
    approval_required: false,
    contradictions,
    first_writer_candidates: candidates
  };

  await writeJSON(path.join(foundryRoot, 'established-model.json'), established);

  const primary = candidates[0] || { experiment_id: 'heretic-candidate-001', genome: { source: 'heretic', revision: 1 } };
  const lease = writerLease({
    generation: established.generation,
    experiment_id: primary.experiment_id,
    branch: `foundry/g${established.generation}/${primary.experiment_id}`,
    lane_path: `foundry/${generationLabel}/experiments/${primary.experiment_id}`
  });
  await writeJSON(path.join(foundryRoot, 'WRITER_LEASE.json'), lease);

  const bootstrapReceipt = readyForReviewReceipt({
    generation: established.generation,
    experiment_id: primary.experiment_id,
    genome: primary.genome,
    contradictions,
    resource_receipt: { compute_hours: 0, peak_memory_gb: 0, nodes: 1, cost_estimate_usd: 0 },
    human_review_notes: 'Write phase auto-unlocked from grouping establishment.'
  });
  await writeJSON(path.join(foundryRoot, 'first-writer-receipt.json'), bootstrapReceipt);

  return { established, lease, bootstrapReceipt };
}

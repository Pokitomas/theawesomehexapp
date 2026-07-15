import fs from 'node:fs/promises';
import path from 'node:path';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();

export function resolveFoundryPath(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const base = path.resolve(root);
  if (!target.startsWith(`${base}${path.sep}`) && target !== base) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return target;
}

export function writerLease({ generation, experiment_id, branch, lane_path }) {
  const now = Date.now();
  return {
    schema: 'sideways-foundry-writer-lease/v1',
    generation,
    experiment_id: clean(experiment_id),
    branch: clean(branch),
    lane_path: clean(lane_path),
    issued_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    write_access: true
  };
}

export function readyForReviewReceipt({
  generation,
  experiment_id,
  genome,
  contradictions = [],
  resource_receipt = {},
  human_review_notes = ''
}) {
  return {
    generation,
    experiment_id,
    genome,
    resource_receipt: {
      compute_hours: Number(resource_receipt.compute_hours ?? 0),
      peak_memory_gb: Number(resource_receipt.peak_memory_gb ?? 0),
      nodes: Number(resource_receipt.nodes ?? 1),
      cost_estimate_usd: Number(resource_receipt.cost_estimate_usd ?? 0)
    },
    contradictions,
    ready_for_merge: true,
    human_review_notes
  };
}

export async function writeJSON(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJSON(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createArchieComputeLadder,
  digest,
  discoverLocalCompute,
  makeComputeNode,
  planComputePlacement
} from '../maker-archie-compute.mjs';

function task(overrides = {}) {
  return {
    task_id: overrides.task_id || 'task-one',
    operation: overrides.operation || 'unit-test',
    input: overrides.input || { prompt: 'hello' },
    requirements: {
      min_memory_gb: 4,
      min_disk_gb: 10,
      accelerator: 'cpu',
      privacy: 'public',
      max_cost_usd: 1,
      checkpoint_format: 'gguf',
      corpus_pack: 'local-fs',
      ...overrides.requirements
    },
    metadata: overrides.metadata || {}
  };
}

function remoteNode(overrides = {}) {
  return makeComputeNode({
    provider_id: overrides.provider_id || 'remote-a',
    node_id: overrides.node_id || 'remote-a-1',
    adapter_id: overrides.adapter_id || overrides.provider_id || 'remote-a',
    kind: overrides.kind || 'remote-http',
    observed: overrides.observed ?? true,
    local: overrides.local ?? false,
    capabilities: {
      memory_gb: 32,
      disk_gb: 100,
      accelerators: [{ kind: 'cpu', observed: true, available: true, memory_gb: 0, count: 8 }],
      privacy_modes: ['public', 'private'],
      regions: ['us-west'],
      cost: { known: true, amount_usd: 0.2 },
      checkpoint_formats: ['gguf', 'onnx'],
      corpus_packs: ['local-fs', 's3-pack'],
      ...overrides.capabilities
    }
  });
}

function adapter({ run, recover, onLease, onCancel } = {}) {
  return {
    async acquireLease({ node, attestation }) {
      onLease?.({ node, attestation });
      return {
        lease_id: `lease-${node.node_id}`,
        provider_id: node.provider_id,
        node_id: node.node_id,
        attestation_digest: attestation.digest
      };
    },
    async run(args) {
      return run ? run(args) : {
        status: 'completed',
        artifacts: [{ name: 'out.json', content: '{"ok":true}', digest: digest('{"ok":true}') }],
        cost: { known: true, actual_usd: 0.1 },
        result: { ok: true }
      };
    },
    async recover(args) {
      return recover(args);
    },
    async cancelLease(args) {
      onCancel?.(args);
    }
  };
}

test('falls back to local CPU without inventing a permanent NVIDIA box', () => {
  const nodes = discoverLocalCompute({ memory_gb: 16, disk_gb: 200, accelerators: [], wsl: null });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'local-cpu');
  assert.equal(nodes[0].capabilities.accelerators.some(item => item.kind === 'cuda'), false);

  const placement = planComputePlacement(task({ requirements: { privacy: 'local-only', region: 'local' } }), nodes);
  assert.equal(placement.state, 'placed');
  assert.equal(placement.selected.kind, 'local-cpu');
});

test('tells the truth when CUDA/ROCm/Metal are not genuinely observed', () => {
  const nodes = discoverLocalCompute({
    memory_gb: 32,
    disk_gb: 200,
    accelerators: [{ kind: 'cuda', observed: false, available: true, memory_gb: 80 }],
    wsl: null
  });
  assert.equal(nodes.some(node => node.kind === 'local-gpu'), false);
  const placement = planComputePlacement(task({ requirements: { accelerator: { kind: 'cuda', min_vram_gb: 1 } } }), nodes);
  assert.equal(placement.state, 'rejected');
  assert.ok(placement.rejections.some(item => item.reason === 'accelerator_cuda_unavailable'));
});

test('admits a future burst-GPU adapter only when its capabilities and attestation are explicit', async () => {
  const node = remoteNode({
    provider_id: 'burst-one',
    node_id: 'burst-gpu-80gb',
    kind: 'burst-gpu',
    capabilities: {
      memory_gb: 96,
      disk_gb: 500,
      accelerators: [{ kind: 'burst-gpu', observed: true, available: true, memory_gb: 80, count: 1 }],
      regions: ['us-west'],
      privacy_modes: ['public'],
      cost: { known: true, amount_usd: 0.75 },
      checkpoint_formats: ['safetensors'],
      corpus_packs: ['s3-pack']
    }
  });
  const ladder = createArchieComputeLadder({ adapters: { 'burst-one': adapter() }, nodes: [node] });
  const receipt = await ladder.dispatch(task({
    requirements: {
      accelerator: { kind: 'burst-gpu', min_vram_gb: 48 },
      checkpoint_format: 'safetensors',
      corpus_pack: 's3-pack',
      max_cost_usd: 1
    }
  }));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.provider_id, 'burst-one');
  assert.equal(receipt.attestation_digest, node.attestation.digest);
});

test('rejects a GPU node with mismatched VRAM before dispatch', () => {
  const node = remoteNode({
    provider_id: 'small-gpu',
    kind: 'self-hosted',
    capabilities: {
      accelerators: [{ kind: 'cuda', observed: true, available: true, memory_gb: 12, count: 1 }]
    }
  });
  const placement = planComputePlacement(task({ requirements: { accelerator: { kind: 'cuda', min_vram_gb: 24 } } }), [node]);
  assert.equal(placement.state, 'rejected');
  assert.ok(placement.rejections.some(item => item.reason === 'accelerator_vram_too_small'));
});

test('fails closed when provider cost is unknown', () => {
  const node = remoteNode({ provider_id: 'mystery-cost', capabilities: { cost: { known: false } } });
  const placement = planComputePlacement(task(), [node]);
  assert.equal(placement.state, 'rejected');
  assert.ok(placement.rejections.some(item => item.reason === 'cost_unknown'));
});

test('rejects private locality requirements for non-local workers', () => {
  const node = remoteNode({
    provider_id: 'remote-private',
    capabilities: { privacy_modes: ['public', 'private', 'local-only'], regions: ['us-west'] }
  });
  const placement = planComputePlacement(task({ requirements: { privacy: 'local-only', region: 'local' } }), [node]);
  assert.equal(placement.state, 'rejected');
  assert.ok(placement.rejections.some(item => item.reason === 'locality_rejected'));
  assert.ok(placement.rejections.some(item => item.reason === 'region_rejected'));
});

test('recovers from a lost worker through the same injected adapter and lease', async () => {
  const node = remoteNode({ provider_id: 'worker-fleet' });
  const ladder = createArchieComputeLadder({
    nodes: [node],
    adapters: {
      'worker-fleet': adapter({
        run() {
          throw Object.assign(new Error('worker disappeared'), { code: 'WORKER_LOST' });
        },
        recover({ lease }) {
          return {
            status: 'completed',
            artifacts: [{ name: 'recovered.json', content: 'recovered', digest: digest('recovered') }],
            cost: { known: true, actual_usd: 0.12 },
            result: { recovered_lease: lease.lease_id }
          };
        }
      })
    }
  });
  const receipt = await ladder.dispatch(task());
  assert.equal(receipt.status, 'recovered');
  assert.equal(receipt.result.recovered_lease, 'lease-remote-a-1');
});

test('rejects artifact tampering after adapter execution', async () => {
  const node = remoteNode({ provider_id: 'tamper-worker' });
  const ladder = createArchieComputeLadder({
    nodes: [node],
    adapters: {
      'tamper-worker': adapter({
        run() {
          return {
            status: 'completed',
            artifacts: [{ name: 'out.txt', content: 'mutated', digest: digest('original') }],
            cost: { known: true, actual_usd: 0.1 }
          };
        }
      })
    }
  });
  await assert.rejects(ladder.dispatch(task()), /Artifact digest mismatch/);
});

test('times out and cancels the lease without mutating infrastructure', async () => {
  const node = remoteNode({ provider_id: 'slow-worker' });
  const cancellations = [];
  const ladder = createArchieComputeLadder({
    nodes: [node],
    adapters: {
      'slow-worker': adapter({
        run() {
          return new Promise(() => {});
        },
        onCancel(event) {
          cancellations.push(event.reason);
        }
      })
    },
    default_timeout_ms: 5
  });
  await assert.rejects(ladder.dispatch(task()), error => error.code === 'COMPUTE_TIMEOUT');
  assert.deepEqual(cancellations, ['COMPUTE_TIMEOUT']);
});

test('placement is deterministic and chooses the lowest admitted cost', () => {
  const expensive = remoteNode({ provider_id: 'remote-expensive', node_id: 'b', capabilities: { cost: { known: true, amount_usd: 0.8 } } });
  const cheap = remoteNode({ provider_id: 'remote-cheap', node_id: 'a', capabilities: { cost: { known: true, amount_usd: 0.1 } } });
  const first = planComputePlacement(task(), [expensive, cheap]);
  const second = planComputePlacement(task(), [cheap, expensive]);
  assert.equal(first.selected.provider_id, 'remote-cheap');
  assert.equal(second.selected.provider_id, 'remote-cheap');
  assert.deepEqual(first.ranked, second.ranked);
});

test('redacts secrets before adapter dispatch and from receipts', async () => {
  const node = remoteNode({ provider_id: 'redaction-worker' });
  const seen = [];
  const ladder = createArchieComputeLadder({
    nodes: [node],
    adapters: {
      'redaction-worker': adapter({
        run({ task: redactedTask }) {
          seen.push(redactedTask);
          return {
            status: 'completed',
            artifacts: [{ name: 'safe.txt', content: 'safe', digest: digest('safe') }],
            cost: { known: true, actual_usd: 0.1 },
            result: { token: 'ghp_should_not_escape', nested: { api_key: 'sk-secret' }, message: 'Bearer live_secret' }
          };
        }
      })
    }
  });
  const receipt = await ladder.dispatch(task({
    input: { prompt: 'run', api_key: 'sk-live', nested: { authorization: 'Bearer abc123' } },
    metadata: { access_token: 'ghp_live' }
  }));
  assert.equal(seen[0].input.api_key, '[REDACTED]');
  assert.equal(seen[0].input.nested.authorization, '[REDACTED]');
  assert.equal(seen[0].metadata.access_token, '[REDACTED]');
  assert.equal(receipt.result.token, '[REDACTED]');
  assert.equal(receipt.result.nested.api_key, '[REDACTED]');
  assert.equal(receipt.result.message, '[REDACTED]');
});

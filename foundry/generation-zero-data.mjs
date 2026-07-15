import process from 'node:process';
import { createAssignments, validateCandidateGenome, validateMission } from './core.mjs';

const SEEDS = Object.freeze([11, 29]);
const DESIGN_LOCK_KEY = /(^|_)(architecture|model[_-]?family|parameter(?:s|[_-]?(?:count|range|cap|limit))?|tokenizer|context[_-]?length|layer[_-]?count|modality|representation|phone[_-]?size|model[_-]?size)($|_)/i;

function clone(value) {
  return structuredClone(value);
}

function scanDesignLocks(value, pathName = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanDesignLocks(entry, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (DESIGN_LOCK_KEY.test(key)) throw new Error(`Generation-zero mission precommits model design at ${pathName}.${key}.`);
    scanDesignLocks(child, `${pathName}.${key}`);
  }
}

export function generationZeroMission() {
  return {
    id: 'emergent-language-physics-generation-zero',
    objective: 'Discover falsifiable model architectures and learning systems in which language, physical/world dynamics, memory, abstraction, simulation, planning, and tool use may co-emerge without privileging plaintext tokens or any named architecture.',
    hardware: {
      class: 'runtime-measured-experiment-host',
      accelerator: 'optional',
      topology_discovered_at_runtime: true
    },
    budget: {
      proxy_compute_units: 8,
      maximum_parallel_agents: 10,
      external_install_authority: false,
      training_spend_authority: false
    },
    success_metrics: [
      'cross-representation language prediction',
      'physical rollout accuracy and conservation behavior',
      'joint delayed memory across symbolic and continuous state',
      'adaptation under changed dynamics',
      'out-of-distribution generalization',
      'calibration and failure recognition',
      'active operations and bytes moved',
      'peak resident memory and wall-clock latency',
      'reproducibility and lineage completeness'
    ],
    forbidden_defaults: [
      'Do not preselect an LLM, Transformer, state-space model, graph, field, simulator, program, or other named family.',
      'Do not preselect a parameter-count range, tokenizer, context length, layer count, modality boundary, phone-size target, or final representation.',
      'Plaintext tokens are one candidate surface, never the privileged substrate.',
      'Do not call orchestration, retrieval, prompting, or tool use a native model improvement.',
      'Do not infer final-scale behavior from a tiny proxy result.'
    ],
    operator_constraints: [
      'All ideation reports are read-only and preserve contradictions.',
      'Every executed proxy records its finite resources, seeds, revision, and failure state.',
      'Synthetic physical systems are controlled probes, not the corpus and not proof of general intelligence.',
      'External corpus acquisition, dependencies, training spend, model export, merge, and deployment remain human-authorized.'
    ]
  };
}

export function validateGenerationZeroMission(input) {
  scanDesignLocks(input?.hardware, '$.hardware');
  scanDesignLocks(input?.budget, '$.budget');
  const mission = validateMission(input);
  const metrics = mission.success_metrics.join(' ').toLowerCase();
  if (!/(language|symbol|code|mathemat)/.test(metrics)) throw new Error('Generation-zero mission requires a linguistic or symbolic success metric.');
  if (!/(physical|dynamics|world|conservation)/.test(metrics)) throw new Error('Generation-zero mission requires a physical/world-dynamics success metric.');
  if (!mission.forbidden_defaults.some(value => /plaintext tokens/i.test(value))) {
    throw new Error('Generation-zero mission must state that plaintext tokens are not privileged.');
  }
  return mission;
}

const CANDIDATES = Object.freeze([
  {
    id: 'candidate:sequence-predictive-baseline',
    family: 'sequence predictive control',
    distance: 'conservative',
    cost: 2,
    gain: 4,
    roles: ['frontier-cartographer', 'scaling-law-skeptic'],
    tags: ['language', 'physics', 'plaintext-candidate', 'matched-baseline'],
    representation: { kind: 'discrete-sequence', surfaces: ['subword-or-byte events', 'quantized physical observations'], plaintext_tokens: 'candidate-only' },
    dynamics: { kind: 'learned-next-event-transition', reversibility: 'not-guaranteed', continuous_state: 'quantized' },
    memory: { kind: 'bounded-sequence-window', update: 'append-and-evict' },
    learning: { objectives: ['next-event prediction', 'masked reconstruction'], adaptation: 'gradient updates to transition parameters' },
    proxy: 'sequence-baseline'
  },
  {
    id: 'candidate:event-field-dual',
    family: 'coupled event-field substrate',
    distance: 'adjacent',
    cost: 2,
    gain: 8,
    roles: ['architecture-heretic', 'efficiency-physicist'],
    tags: ['language', 'physics', 'continuous-state', 'discrete-events', 'joint-representation'],
    representation: { kind: 'dual-event-field', surfaces: ['discrete communicative events', 'continuous physical fields'], coupling: 'learned bidirectional projection', plaintext_tokens: 'optional-adapter' },
    dynamics: { kind: 'coupled-symplectic-event-update', reversibility: 'measured', continuous_state: 'native' },
    memory: { kind: 'multiscale field plus event ledger', update: 'local transition and sparse event write' },
    learning: { objectives: ['event prediction', 'field rollout', 'cross-surface consistency'], adaptation: 'local plasticity plus global error correction' },
    proxy: 'event-field-dual'
  },
  {
    id: 'candidate:reversible-object-field',
    family: 'reversible object-field dynamics',
    distance: 'heretical',
    cost: 2,
    gain: 7,
    roles: ['architecture-heretic', 'mechanistic-pathologist'],
    tags: ['physics', 'objects', 'fields', 'reversible-dynamics', 'language-adapter-uncertain'],
    representation: { kind: 'object-field-state', surfaces: ['objects', 'relations', 'continuous fields'], communicative_symbols: 'emergent-readout-not-assumed', plaintext_tokens: 'absent-from-core' },
    dynamics: { kind: 'reversible-relational-flow', reversibility: 'structural', continuous_state: 'native' },
    memory: { kind: 'persistent objects and conserved field state', update: 'reversible transition with explicit creation events' },
    learning: { objectives: ['inverse-consistent rollout', 'conservation residual', 'relational prediction'], adaptation: 'learned local interaction law' },
    proxy: 'reversible-object-field'
  },
  {
    id: 'candidate:predictive-energy-plasticity',
    family: 'multiscale predictive energy system',
    distance: 'adjacent',
    cost: 2,
    gain: 6,
    roles: ['learning-dynamics-inventor', 'benchmark-saboteur'],
    tags: ['language', 'physics', 'energy-objective', 'multiscale-state', 'online-adaptation'],
    representation: { kind: 'multiscale-latent-state', surfaces: ['events', 'continuous observations', 'structured relations'], plaintext_tokens: 'adapter-only' },
    dynamics: { kind: 'energy-minimizing predictive flow', reversibility: 'tested-not-assumed', continuous_state: 'native' },
    memory: { kind: 'slow-fast predictive state', update: 'error-gated plastic state' },
    learning: { objectives: ['prediction energy', 'cross-scale consistency', 'uncertainty calibration'], adaptation: 'online predictive-state update' },
    proxy: 'predictive-energy'
  },
  {
    id: 'candidate:program-dynamics-memory',
    family: 'induced executable dynamics and memory',
    distance: 'heretical',
    cost: 5,
    gain: 5,
    roles: ['distillation-breaker', 'open-world-toolsmith'],
    tags: ['language', 'physics', 'program-induction', 'tool-use', 'explicit-memory'],
    representation: { kind: 'typed events plus induced programs', surfaces: ['language events', 'physical observations', 'tool contracts'], plaintext_tokens: 'one possible parser input' },
    dynamics: { kind: 'induced transition programs', reversibility: 'program-specific', continuous_state: 'through typed numeric values' },
    memory: { kind: 'addressable facts, state, and executable procedures', update: 'verified write and rollback' },
    learning: { objectives: ['program likelihood', 'execution correctness', 'counterfactual prediction'], adaptation: 'search and verified rewrite' },
    proxy: 'program-memory'
  },
  {
    id: 'candidate:active-inference-graph',
    family: 'active-inference relational graph',
    distance: 'adjacent',
    cost: 4,
    gain: 4,
    roles: ['product-reality-agent', 'benchmark-saboteur'],
    tags: ['language', 'physics', 'relational-graph', 'active-acquisition', 'calibration'],
    representation: { kind: 'typed relational graph', surfaces: ['entities', 'relations', 'observations', 'utterance acts'], plaintext_tokens: 'parsed observation type only' },
    dynamics: { kind: 'belief and world-state transition', reversibility: 'not-assumed', continuous_state: 'node-and-edge attributes' },
    memory: { kind: 'versioned relational belief state', update: 'evidence-weighted graph mutation' },
    learning: { objectives: ['expected free-energy proxy', 'calibration', 'intervention value'], adaptation: 'active observation and posterior update' },
    proxy: 'active-graph'
  }
]);

function proposalFor(candidate) {
  return {
    candidate_id: candidate.id,
    family: candidate.family,
    distance: candidate.distance,
    mechanism: `${candidate.representation.kind} coupled to ${candidate.dynamics.kind}; memory=${candidate.memory.kind}; learning=${candidate.learning.objectives.join(', ')}.`,
    falsifier: 'Fails the same-seed cross-domain proxy by losing either symbolic prediction, physical rollout, delayed joint memory, or adaptation while consuming no less measured proxy resource than the baseline.',
    cost: candidate.cost,
    expected_information_gain: candidate.gain,
    matched_compute_baseline: 'Generation-zero proxy uses identical seeds, samples, horizons, numeric precision, and observation surfaces; operation and byte estimates are reported rather than hidden.',
    hidden_evaluation: 'A procedural holdout seed set and cross-domain perturbations not encoded in candidate-specific thresholds.',
    reproduction_seeds: SEEDS.length,
    novelty_tags: candidate.tags,
    dependencies: []
  };
}

const ROLE_CLAIMS = Object.freeze({
  'frontier-cartographer': [
    ['claim:plaintext-sufficient', 'A sequence baseline may remain competitive when physical observations are quantized into events.', 0.35, ['generation-zero baseline definition'], ['claim:plaintext-insufficient'], 'hypothesis:representation-substrate']
  ],
  'architecture-heretic': [
    ['claim:plaintext-insufficient', 'Joint emergence may require native continuous or relational state rather than forcing every physical variable through plaintext-like tokens.', 0.55, ['representation search-space audit'], ['claim:plaintext-sufficient'], 'hypothesis:representation-substrate'],
    ['claim:reversibility-useful', 'Reversible local dynamics may preserve physical information and improve long-horizon rollout.', 0.45, ['controlled oscillator probe proposed'], ['claim:reversibility-costly'], 'hypothesis:reversible-dynamics']
  ],
  'learning-dynamics-inventor': [
    ['claim:online-plasticity', 'A slow-fast state updated by prediction error may adapt to changed dynamics without full weight retraining.', 0.5, ['adaptation proxy proposed'], [], 'hypothesis:fast-adaptation']
  ],
  'distillation-breaker': [
    ['claim:teacher-policy-transfer', 'Teacher traces may transfer search and verification policies without copying hidden activations or proprietary weights.', 0.5, ['structured action receipts'], ['claim:teacher-ceiling'], 'hypothesis:teacher-transfer']
  ],
  'benchmark-saboteur': [
    ['claim:teacher-ceiling', 'Teacher-shaped traces can cap novelty and create benchmark-shaped imitation.', 0.65, ['teacher dependence attack'], ['claim:teacher-policy-transfer'], 'hypothesis:teacher-transfer'],
    ['claim:proxy-scale-risk', 'Tiny physical probes can reward analytic shortcuts that do not scale to open-world learning.', 0.9, ['proxy contamination review'], [], 'hypothesis:proxy-transfer']
  ],
  'efficiency-physicist': [
    ['claim:reversibility-costly', 'Reversible or field-like state may reduce information loss while increasing memory traffic.', 0.6, ['resource accounting requirement'], ['claim:reversibility-useful'], 'hypothesis:reversible-dynamics']
  ],
  'mechanistic-pathologist': [
    ['claim:surface-collapse', 'A joint model can collapse into one surface and ignore the other while appearing competent on aggregate metrics.', 0.7, ['require separate language and physics metrics'], [], 'hypothesis:joint-collapse']
  ],
  'open-world-toolsmith': [
    ['claim:corpus-registry', 'Internet-scale planning must begin with source-level license, provenance, deduplication, and revocation records rather than a scrape-first pipeline.', 0.95, ['corpus plan contract'], [], 'hypothesis:lawful-corpus']
  ],
  'scaling-law-skeptic': [
    ['claim:proxy-nontransfer', 'No generation-zero result establishes a parameter scale, tokenizer, or final architecture.', 0.99, ['explicit admission boundary'], [], 'hypothesis:proxy-transfer']
  ],
  'product-reality-agent': [
    ['claim:runtime-discovery', 'Deployment constraints should be measured after candidate discovery instead of becoming architectural priors.', 0.8, ['runtime capability receipt'], [], 'hypothesis:deployment-prior']
  ]
});

function claimObject(role, entry, index) {
  const [id, statement, confidence, evidence, contradicts, hypothesis_id] = entry;
  return { id, statement, confidence, evidence, contradicts, hypothesis_id, status: role === 'benchmark-saboteur' ? 'inferred' : 'hypothesis', source_index: index };
}

export function generationZeroReports(missionInput = generationZeroMission()) {
  const mission = validateGenerationZeroMission(missionInput);
  const assignments = createAssignments(mission);
  return assignments.map(assignment => {
    const candidates = CANDIDATES.filter(candidate => candidate.roles.includes(assignment.role));
    return {
      assignment_id: assignment.assignment_id,
      role: assignment.role,
      claims: (ROLE_CLAIMS[assignment.role] || []).map((entry, index) => claimObject(assignment.role, entry, index)),
      proposals: candidates.map(proposalFor),
      external_resources: [],
      uncertainty: 'Generation-zero mechanisms are hypotheses. Proxy behavior cannot establish final architecture, scale, corpus sufficiency, or general intelligence.'
    };
  });
}

export function lawfulCorpusPlan() {
  return {
    schema: 'sideways-foundry-corpus-plan/v1',
    state: 'planned-not-acquired',
    whole_internet_claim: false,
    purpose: 'Future broad pretraining and evaluation across communicative and physical/world representations.',
    source_classes: [
      { id: 'web-text', surfaces: ['natural language', 'documents'], acquisition: 'source registry only', required_basis: ['license-or-permission', 'provenance', 'revocation path'] },
      { id: 'code', surfaces: ['source code', 'tests', 'execution receipts'], acquisition: 'repository-level allowlist only', required_basis: ['license compatibility', 'commit provenance', 'secret scan'] },
      { id: 'mathematics-science', surfaces: ['mathematics', 'scientific papers', 'structured measurements'], acquisition: 'dataset-level review only', required_basis: ['license-or-public-domain basis', 'citation metadata', 'contamination tags'] },
      { id: 'physical-observations', surfaces: ['time series', 'object tracks', 'fields', 'graphs', 'diagrams where licensed'], acquisition: 'dataset-level review only', required_basis: ['consent-or-license', 'sensor provenance', 'units and calibration'] },
      { id: 'teacher-agent-traces', surfaces: ['tool actions', 'test evidence', 'failure receipts'], acquisition: 'explicitly exported structured traces only', required_basis: ['no private chain-of-thought', 'no credentials', 'teacher and repository provenance'] }
    ],
    controls: {
      document_and_near_duplicate_removal: true,
      train_evaluation_firewall: true,
      benchmark_contamination_registry: true,
      personal_data_minimization: true,
      secret_and_credential_rejection: true,
      paywall_and_access_control_bypass: false,
      source_revocation_and_rebuild: true,
      mixture_weights: 'experiment variable, not predetermined'
    },
    representation_policy: 'Retain source-native structure where lawful and useful; plaintext tokenization is one experimental adapter, not the canonical substrate.',
    training_status: 'not-started',
    external_authority_required: ['corpus acquisition', 'dependency installation', 'training spend', 'model artifact export']
  };
}

export function generationZeroGenomes(codeRevision) {
  if (!/^[0-9a-f]{40}$/i.test(String(codeRevision || ''))) throw new Error('Generation-zero genomes require a full 40-character code revision.');
  return CANDIDATES.map(candidate => validateCandidateGenome({
    identity: { candidate_id: candidate.id, generation: 0, status: 'hypothesis-not-admitted' },
    lineage: { parents: [], source_roles: candidate.roles, mutation: 'generation-zero independent proposal' },
    model_graph: {
      nodes: [
        { id: 'representation', operation: candidate.representation.kind },
        { id: 'dynamics', operation: candidate.dynamics.kind },
        { id: 'memory', operation: candidate.memory.kind },
        { id: 'learning', operation: candidate.learning.adaptation }
      ],
      edges: [
        { from: 'representation', to: 'dynamics' },
        { from: 'dynamics', to: 'memory' },
        { from: 'memory', to: 'learning' },
        { from: 'learning', to: 'representation' }
      ]
    },
    representation: clone(candidate.representation),
    dynamics: clone(candidate.dynamics),
    state_memory: clone(candidate.memory),
    learning: clone(candidate.learning),
    data: {
      curriculum: 'lawful broad corpus plus controlled physical probes',
      corpus_state: 'planned-not-acquired',
      generators: ['procedural oscillator', 'procedural symbol grammar'],
      contamination_controls: ['held-out seeds', 'source registry', 'train-evaluation firewall']
    },
    optimizer: { name: 'not-selected-before-experiment', schedule: 'serialized-per-future-experiment', update_scope: candidate.learning.adaptation },
    precision: { state: 'float64 proxy only', future_weights: 'not-selected' },
    inference: { budget: 'measured-per-experiment', halting: 'candidate-defined and serialized', external_costs: 'must be included' },
    hardware: { selection: 'runtime-detected', architecture_prior: 'none', proxy_runtime: `${process.platform}/${process.arch}` },
    seeds: [...SEEDS],
    code_revision: String(codeRevision).toLowerCase(),
    external_tools: [],
    evaluation: { proxy_suite: candidate.proxy, final_scale_claim: false }
  }));
}

export const GENERATION_ZERO_SEEDS = SEEDS;
export const GENERATION_ZERO_CANDIDATES = CANDIDATES;

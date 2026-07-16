const SCHEMA = 'archie-phone-runtime-cockpit/v1';
const COMMAND_SCHEMA = 'archie-phone-command-packet/v1';
const STORAGE_PREFIX = 'archie.phone.runtime';
const SECRET_KEY = /(secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential)/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/i;
const COMMAND_ACTIONS = new Set(['export_pack', 'import_pack', 'request_teacher', 'start_retrain', 'sync_control', 'clear_local_cache']);

function clean(value, limit = 2000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, number(value, min)));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(stable(value));
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function containsSecret(value, depth = 0) {
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.some(item => containsSecret(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || containsSecret(child, depth + 1));
  }
  return typeof value === 'string' && SECRET_TEXT.test(value);
}

export function redactSensitive(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      clean(key, 300),
      SECRET_KEY.test(key) ? '[redacted]' : redactSensitive(child, depth + 1)
    ]));
  }
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '[redacted]');
  return value;
}

export function assertNoSecrets(value) {
  if (containsSecret(value)) throw new Error('Archie phone runtime refuses to store or export secrets.');
  return value;
}

function item(id, label, state, evidence = '', detail = '') {
  return Object.freeze({ id, label, state, evidence: clean(evidence, 4000), detail: clean(detail, 4000) });
}

function statusFromBoolean(value, trueState = 'available', falseState = 'blocked') {
  return value ? trueState : falseState;
}

function normalizeTimeline(runtime = {}) {
  const plan = runtime.plan || runtime.local_plan || {};
  const teacher = runtime.teacher || runtime.escalation || {};
  const corpus = runtime.corpus || {};
  const retrain = runtime.retrain || runtime.training || {};
  const localHit = plan.state === 'local' || Boolean(plan.specialist_id || runtime.local_hit);
  const confidence = clamp(plan.confidence ?? runtime.confidence, 0, 1);
  const margin = clamp(plan.margin ?? runtime.margin, 0, 1);
  const escalated = plan.state === 'teacher' || plan.state === 'escalate' || teacher.state === 'requested' || teacher.state === 'completed';
  const lessonStored = Boolean(corpus.last_record_id || corpus.last_example_id || runtime.lesson_stored || plan.corpus_record?.record_id);
  const retrained = ['trained', 'completed', 'ready'].includes(clean(retrain.state || retrain.status).toLowerCase());
  const retrainRunning = ['running', 'queued', 'training'].includes(clean(retrain.state || retrain.status).toLowerCase());

  return [
    item(
      'local-specialist-hit',
      'Local specialist hit',
      localHit ? 'complete' : 'unavailable',
      localHit ? `specialist=${clean(plan.specialist_id || runtime.specialist_id || 'local')}` : 'No local specialist activation receipt present.',
      localHit ? 'The phone may display the local plan because the runtime supplied an actual specialist id or local state.' : 'Static browser state must not claim a local hit without runtime evidence.'
    ),
    item(
      'confidence-margin',
      'Confidence and margin gate',
      confidence > 0 || margin > 0 ? 'measured' : 'unknown',
      `confidence=${confidence.toFixed(3)} margin=${margin.toFixed(3)} threshold=${number(plan.threshold ?? runtime.threshold, 0).toFixed(3)} minimum_margin=${number(plan.minimum_margin ?? runtime.minimum_margin, 0).toFixed(3)}`,
      'The gate reports numeric evidence only; absent values remain unknown rather than successful.'
    ),
    item(
      'teacher-escalation',
      'Teacher escalation',
      escalated ? statusFromBoolean(teacher.blocked !== true, 'requested', 'blocked') : 'idle',
      escalated ? clean(teacher.receipt_digest || teacher.run_id || teacher.reason || plan.state || 'escalation requested') : 'No escalation command has been submitted.',
      teacher.blocked ? clean(teacher.blocker || 'External teacher unavailable.') : 'Escalation is shown as requested/completed only when an authenticated runtime or command packet says so.'
    ),
    item(
      'lesson-stored',
      'Lesson stored',
      lessonStored ? 'complete' : 'not-stored',
      lessonStored ? clean(corpus.last_record_id || corpus.last_example_id || plan.corpus_record?.record_id) : 'No corpus record/example id supplied.',
      'The UI never turns teacher output into training evidence unless a corpus receipt exists.'
    ),
    item(
      'retrain-state',
      'Retrain state',
      retrained ? 'complete' : (retrainRunning ? 'running' : 'idle'),
      clean(retrain.model_digest || retrain.job_id || retrain.status || retrain.state || 'No retrain receipt.'),
      retrained ? 'A trained model digest is present.' : 'No browser-only path may claim retraining has happened.'
    )
  ];
}

function normalizeCompute(runtime = {}, environment = {}) {
  const compute = runtime.compute || {};
  const ladder = Array.isArray(compute.ladder) ? compute.ladder : [
    { id: 'phone-browser', label: 'Phone browser', state: 'available', evidence: 'UI shell only; no local training claim.' },
    { id: 'authenticated-control-plane', label: 'Authenticated control/runtime contracts', state: compute.control_authenticated ? 'available' : 'blocked', evidence: compute.control_authenticated ? 'Authenticated session supplied.' : 'Missing authenticated runtime session.' },
    { id: 'linux-corpus', label: 'Linux corpus backend', state: compute.linux_available ? 'available' : 'blocked', evidence: compute.linux_available ? clean(compute.linux_evidence || 'Linux corpus reachable.') : 'No Linux runtime receipt available from the phone.' },
    { id: 'gpu', label: 'GPU acceleration', state: compute.gpu_available ? 'available' : 'blocked', evidence: compute.gpu_available ? clean(compute.gpu_evidence || 'GPU advertised by runtime.') : 'Unavailable until a runtime reports a GPU receipt.' },
    { id: 'storage', label: 'Writable pack storage', state: compute.storage_available ? 'available' : 'blocked', evidence: compute.storage_available ? clean(compute.storage_evidence || 'Storage writable.') : 'No storage quota/write receipt supplied.' }
  ];
  return ladder.map(entry => item(
    clean(entry.id || entry.label, 80),
    clean(entry.label || entry.id || 'compute rung', 100),
    clean(entry.state || 'unknown', 80),
    clean(entry.evidence || '', 1000),
    clean(entry.detail || '', 1000)
  ));
}

function normalizePackHealth(runtime = {}) {
  const corpus = runtime.corpus || {};
  const pack = runtime.pack || {};
  return Object.freeze({
    records: Math.max(0, number(corpus.records ?? pack.records, 0)),
    examples: Math.max(0, number(corpus.examples ?? pack.examples, 0)),
    events: Math.max(0, number(corpus.events ?? pack.events, 0)),
    last_event_at: clean(corpus.last_event_at || pack.last_event_at || '', 120) || null,
    pack_digest: clean(pack.digest || corpus.pack_digest || '', 200) || null,
    importable: pack.importable === true,
    exportable: pack.exportable === true || number(corpus.records, 0) > 0,
    health: clean(pack.health || corpus.health || (number(corpus.records, 0) > 0 ? 'evidence-present' : 'empty'), 100)
  });
}

function normalizeCost(runtime = {}) {
  const usage = runtime.usage || runtime.cost || {};
  return Object.freeze({
    cost_usd: usage.cost_usd === null || usage.cost_usd === undefined ? null : number(usage.cost_usd, 0),
    teacher_calls: Math.max(0, number(usage.teacher_calls, 0)),
    local_hits: Math.max(0, number(usage.local_hits, 0)),
    escalations: Math.max(0, number(usage.escalations, 0)),
    source: clean(usage.source || usage.receipt_digest || 'No usage receipt.', 500)
  });
}

function normalizeBlockers(runtime = {}, environment = {}) {
  const provided = Array.isArray(runtime.blockers) ? runtime.blockers : [];
  const generated = [];
  const compute = runtime.compute || {};
  if (environment.onLine === false) generated.push({ id: 'offline', label: 'Offline', state: 'blocked', evidence: 'Browser reports offline; only command export remains safe.' });
  if (!compute.control_authenticated) generated.push({ id: 'auth', label: 'Authentication required', state: 'blocked', evidence: 'Control/runtime calls require an authenticated session.' });
  if (!compute.linux_available) generated.push({ id: 'linux', label: 'Linux backend unavailable', state: 'blocked', evidence: 'No Linux corpus/training runtime receipt supplied.' });
  if (!compute.gpu_available) generated.push({ id: 'gpu', label: 'GPU unavailable', state: 'blocked', evidence: 'GPU is not assumed from a static browser.' });
  if (!compute.storage_available) generated.push({ id: 'storage', label: 'Storage unverified', state: 'blocked', evidence: 'No pack write/read receipt supplied.' });
  return [...provided, ...generated].map(entry => item(
    clean(entry.id || entry.label, 80),
    clean(entry.label || entry.id || 'external blocker', 100),
    clean(entry.state || 'blocked', 80),
    clean(entry.evidence || entry.reason || '', 1000),
    clean(entry.detail || '', 1000)
  ));
}

export function storageKey(scope, name) {
  const cleanScope = clean(scope, 200).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '-');
  const cleanName = clean(name, 80).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  if (!cleanScope || !cleanName) throw new Error('Archie storage requires explicit scope and key name.');
  return `${STORAGE_PREFIX}:${digest(cleanScope)}:${cleanName}`;
}

export function deriveArchieViewModel(runtimeState = {}, environment = {}) {
  const runtime = redactSensitive(runtimeState || {});
  const env = {
    onLine: environment.onLine ?? (typeof navigator !== 'undefined' ? navigator.onLine : true),
    viewport: environment.viewport || null,
    reducedMotion: environment.reducedMotion ?? false
  };
  const timeline = normalizeTimeline(runtime);
  const pack = normalizePackHealth(runtime);
  const compute = normalizeCompute(runtime, env);
  const cost = normalizeCost(runtime);
  const blockers = normalizeBlockers(runtime, env);
  const local = timeline.find(step => step.id === 'local-specialist-hit')?.state === 'complete';
  const retrained = timeline.find(step => step.id === 'retrain-state')?.state === 'complete';
  const status = blockers.some(blocker => blocker.state === 'blocked') ? 'blocked' : (local || retrained ? 'evidence-present' : 'waiting-for-runtime');
  return Object.freeze({
    schema: SCHEMA,
    status,
    generated_at: clean(runtime.generated_at || new Date(0).toISOString(), 120),
    loop: Object.freeze(timeline),
    pack,
    compute: Object.freeze(compute),
    cost,
    blockers: Object.freeze(blockers),
    commands: Object.freeze(['export_pack', 'import_pack', 'request_teacher', 'start_retrain', 'sync_control']),
    notices: Object.freeze([
      'Phone UI displays receipts and exports commands; it does not train by itself.',
      'Missing runtime evidence remains blocked or idle, never complete.'
    ])
  });
}

export function createArchieCommandPacket(action, payload = {}, options = {}) {
  const normalizedAction = clean(action, 80);
  if (!COMMAND_ACTIONS.has(normalizedAction)) throw new Error(`Unsupported Archie phone command: ${normalizedAction}`);
  assertNoSecrets(payload);
  const redactedPayload = redactSensitive(payload);
  const body = {
    schema: COMMAND_SCHEMA,
    action: normalizedAction,
    status: 'ready_to_submit',
    requires_authenticated_runtime: normalizedAction !== 'clear_local_cache',
    created_at: clean(options.now || new Date(0).toISOString(), 120),
    target_contract: clean(options.target_contract || 'existing-maker-control-runtime-contract', 200),
    payload: redactedPayload,
    evidence_digest: digest(redactedPayload),
    truthful_limitations: [
      'This packet is not proof that training, compute, import, export, or teacher escalation happened.',
      'Completion requires an authenticated runtime receipt returned after submission.'
    ]
  };
  return Object.freeze({ ...body, packet_digest: digest(body) });
}

export async function callAuthenticatedRuntime(endpoint, payload = {}, { token = '', fetchImpl = globalThis.fetch } = {}) {
  if (!/^https?:\/\//.test(clean(endpoint, 2048))) throw new Error('Archie runtime endpoint must be an absolute http(s) URL.');
  if (!token) throw new Error('Authenticated runtime token required.');
  if (containsSecret(payload)) throw new Error('Archie refuses secret-bearing payloads in browser runtime calls.');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation required.');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(redactSensitive(payload))
  });
  if (!response || response.ok === false) throw new Error(`Runtime call failed: ${response?.status || 'unknown'}`);
  return response.json ? response.json() : response;
}

function tag(name, attrs = {}, children = []) {
  const element = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function renderList(title, entries) {
  return tag('section', { class: 'card', 'aria-labelledby': `${title}-title` }, [
    tag('h2', { id: `${title}-title`, text: title.replace(/-/g, ' ') }),
    tag('ol', { class: 'receipt-list' }, entries.map(entry => tag('li', { class: `receipt is-${entry.state}` }, [
      tag('strong', { text: entry.label }),
      tag('span', { class: 'pill', text: entry.state }),
      tag('p', { text: entry.evidence || 'No evidence supplied.' }),
      entry.detail ? tag('small', { text: entry.detail }) : null
    ])))
  ]);
}

export function renderArchieCockpit(root, runtimeState = {}, environment = {}) {
  if (!root) throw new Error('A root element is required.');
  const vm = deriveArchieViewModel(runtimeState, environment);
  root.replaceChildren(
    tag('header', { class: 'hero' }, [
      tag('p', { class: 'eyebrow', text: 'Archie phone runtime' }),
      tag('h1', { text: 'Learning loop cockpit' }),
      tag('p', { class: 'hero-copy', text: vm.notices.join(' ') }),
      tag('div', { class: `status is-${vm.status}`, role: 'status', 'aria-live': 'polite', text: vm.status })
    ]),
    tag('main', { class: 'cockpit' }, [
      renderList('learning-loop', vm.loop),
      tag('section', { class: 'card pack-card', 'aria-labelledby': 'pack-title' }, [
        tag('h2', { id: 'pack-title', text: 'corpus and pack health' }),
        tag('dl', { class: 'metrics' }, [
          tag('div', {}, [tag('dt', { text: 'records' }), tag('dd', { text: vm.pack.records })]),
          tag('div', {}, [tag('dt', { text: 'examples' }), tag('dd', { text: vm.pack.examples })]),
          tag('div', {}, [tag('dt', { text: 'events' }), tag('dd', { text: vm.pack.events })]),
          tag('div', {}, [tag('dt', { text: 'health' }), tag('dd', { text: vm.pack.health })]),
          tag('div', {}, [tag('dt', { text: 'digest' }), tag('dd', { text: vm.pack.pack_digest || 'none' })])
        ]),
        tag('div', { class: 'actions' }, vm.commands.map(command => tag('button', { type: 'button', 'data-command': command, text: command.replace(/_/g, ' ') })))
      ]),
      renderList('compute-ladder', vm.compute),
      tag('section', { class: 'card', 'aria-labelledby': 'usage-title' }, [
        tag('h2', { id: 'usage-title', text: 'cost and usage evidence' }),
        tag('dl', { class: 'metrics' }, [
          tag('div', {}, [tag('dt', { text: 'cost usd' }), tag('dd', { text: vm.cost.cost_usd === null ? 'unknown' : vm.cost.cost_usd.toFixed(4) })]),
          tag('div', {}, [tag('dt', { text: 'teacher calls' }), tag('dd', { text: vm.cost.teacher_calls })]),
          tag('div', {}, [tag('dt', { text: 'local hits' }), tag('dd', { text: vm.cost.local_hits })]),
          tag('div', {}, [tag('dt', { text: 'escalations' }), tag('dd', { text: vm.cost.escalations })])
        ]),
        tag('p', { class: 'evidence', text: vm.cost.source })
      ]),
      renderList('external-blockers', vm.blockers)
    ])
  );
  root.querySelectorAll('[data-command]').forEach(button => {
    button.addEventListener('click', () => {
      const packet = createArchieCommandPacket(button.dataset.command, { pack: vm.pack, generated_from_status: vm.status }, { now: vm.generated_at });
      root.dispatchEvent(new CustomEvent('archie-command', { bubbles: true, detail: packet }));
    });
  });
  return vm;
}

export function initArchieCockpit({ root = document.querySelector('[data-archie-root]'), runtimeState = globalThis.__ARCHIE_RUNTIME_STATE__ || {}, environment = {} } = {}) {
  const render = () => renderArchieCockpit(root, runtimeState, { ...environment, onLine: navigator.onLine });
  const vm = render();
  addEventListener('online', render);
  addEventListener('offline', render);
  return vm;
}

if (typeof document !== 'undefined' && document.currentScript?.hasAttribute('data-auto-init')) {
  initArchieCockpit();
}

export const archiePhoneRuntime = Object.freeze({
  SCHEMA,
  COMMAND_SCHEMA,
  STORAGE_PREFIX,
  deriveArchieViewModel,
  createArchieCommandPacket,
  callAuthenticatedRuntime,
  containsSecret,
  redactSensitive,
  assertNoSecrets,
  storageKey,
  renderArchieCockpit,
  initArchieCockpit
});

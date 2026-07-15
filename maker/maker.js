export const MAKER_VERSION = 'sideways-maker/v2';
export const LEGACY_MAKER_VERSION = 'sideways-maker/v1';
export const STORAGE_KEY = 'sideways:maker:draft:v2';
export const LEGACY_STORAGE_KEY = 'sideways:maker:draft:v1';
export const REPOSITORY = 'Pokitomas/theawesomehexapp';
export const MODES = Object.freeze(['construct', 'distill', 'adapt', 'repair']);
export const ARCHITECTURES = Object.freeze(['auto', 'recurrent', 'state-space', 'hybrid']);
export const RUNTIMES = Object.freeze(['phone', 'browser', 'local', 'server', 'hybrid']);

const LIMITS = Object.freeze({ request: 2400, protect: 1200, proof: 1200 });
const SECRET_PATTERNS = Object.freeze([
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:REMOTE_KEY|SOCIAL_SESSION_SECRET|DATABASE_URL)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i
]);

const clean = (value, limit) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const finiteBudget = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 100 ? Math.round(parsed * 10) / 10 : 1.3;
};

export function forgeLifecycle(input = {}) {
  const architecture = ARCHITECTURES.includes(input.architecture_prior) ? input.architecture_prior : 'auto';
  return Object.freeze([
    Object.freeze({ id: 'crawl', objective: 'Map repository evidence and explicitly allowed public sources.', network: 'public-read-only', mutation: false }),
    Object.freeze({ id: 'architect', objective: 'Compare recurrent, selective state-space, hybrid, and matched compact-transformer candidates.', prior: architecture, mutation: false }),
    Object.freeze({ id: 'lease', objective: 'Install a candidate only inside an isolated temporary workspace with a mandatory cleanup receipt.', external_install: 'explicit-operator-only', production_target: false }),
    Object.freeze({ id: 'distill', objective: 'Compress the admitted capability into a bounded artifact without claiming quality beyond measured evidence.', matched_evaluation_required: true }),
    Object.freeze({ id: 'integrate', objective: 'Change the actual Sideways product rather than leave a detached research demo.', repository_mutation: 'leased-writer-only' }),
    Object.freeze({ id: 'prove', objective: 'Run product-visible, hostile, exact-head witnesses.', required: true }),
    Object.freeze({ id: 'clean', objective: 'Remove temporary installs, caches, and disposable workspaces before admission.', required_after_install: true })
  ]);
}

export function normalizeIntent(input = {}) {
  const rawMode = String(input.mode || 'construct').trim().toLowerCase();
  const legacyMode = rawMode === 'build' || rawMode === 'explore' || rawMode === 'audit' ? 'construct' : rawMode === 'fix' ? 'repair' : rawMode;
  const architecture = String(input.architecture_prior || input.architecture || 'auto').trim().toLowerCase();
  const runtime = String(input.target_runtime || input.runtime || 'phone').trim().toLowerCase();
  const intent = {
    version: MAKER_VERSION,
    repository: REPOSITORY,
    mode: MODES.includes(legacyMode) ? legacyMode : 'construct',
    request: clean(input.request, LIMITS.request),
    protect: clean(input.protect, LIMITS.protect),
    proof: clean(input.proof, LIMITS.proof),
    budget_envelope: finiteBudget(input.budget_envelope ?? input.budget),
    architecture_prior: ARCHITECTURES.includes(architecture) ? architecture : 'auto',
    target_runtime: RUNTIMES.includes(runtime) ? runtime : 'phone',
    lifecycle: null,
    termination: {
      success: 'product-visible proof passes at the exact candidate head and every temporary installation has a cleanup receipt',
      no_gain: 'stop without admission when no candidate beats the matched baseline inside the budget envelope',
      budget_exhausted: 'stop without admission and preserve receipts',
      cleanup_failure: 'block release until temporary external state is removed or explicitly quarantined'
    },
    authority: {
      repository_write: 'leased-branch-only',
      external_install: 'explicit-operator-only',
      training_spend: 'explicit-operator-only',
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none'
    }
  };
  intent.lifecycle = forgeLifecycle(intent);
  return intent;
}

export function stableReceipt(input = {}) {
  return `${JSON.stringify(normalizeIntent(input), null, 2)}\n`;
}

export function hasSecretLikeMaterial(input = {}) {
  const intent = normalizeIntent(input);
  const text = [intent.request, intent.protect, intent.proof].join('\n');
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function legacyWorkerMode(mode) {
  return mode === 'repair' ? 'fix' : mode === 'distill' ? 'explore' : 'build';
}

export function nativeWorkerBridge(input = {}) {
  const intent = normalizeIntent(input);
  const lifecycle = intent.lifecycle.map(stage => `${stage.id}: ${stage.objective}`).join('\n');
  return {
    version: LEGACY_MAKER_VERSION,
    repository: REPOSITORY,
    mode: legacyWorkerMode(intent.mode),
    request: [
      `Capability mode: ${intent.mode}`,
      `Budget envelope: ${intent.budget_envelope}`,
      `Architecture search prior: ${intent.architecture_prior}`,
      `Target product runtime: ${intent.target_runtime}`,
      '',
      'Requested capability:',
      intent.request,
      '',
      'Required lifecycle:',
      lifecycle
    ].join('\n'),
    protect: intent.protect,
    proof: [
      intent.proof || 'Show the capability operating in the actual product at the exact candidate head.',
      'Terminate only after matched evaluation, product integration, product-visible proof, and cleanup of every temporary installation.'
    ].join('\n'),
    device_requirement: intent.target_runtime === 'phone' ? 'phone-first' : intent.target_runtime,
    authority: {
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none'
    }
  };
}

export function buildIssueTitle(input = {}) {
  const intent = normalizeIntent(input);
  const firstLine = intent.request.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'Capability request';
  const compact = firstLine.replace(/\s+/g, ' ').slice(0, 92);
  return `[maker:${legacyWorkerMode(intent.mode)}] ${compact}`.slice(0, 120);
}

export function buildIssueBody(input = {}) {
  const intent = normalizeIntent(input);
  return [
    '## Capability to construct',
    '',
    intent.request || '_No capability supplied._',
    '',
    '## Search envelope',
    '',
    `- budget envelope: ${intent.budget_envelope}`,
    `- architecture prior: ${intent.architecture_prior}`,
    `- product runtime: ${intent.target_runtime}`,
    '- compare the preferred prior against matched recurrent, state-space, hybrid, and compact-transformer baselines',
    '- temporary external installs require an isolated lease and mandatory cleanup receipt',
    '',
    '## Reality that must survive',
    '',
    intent.protect || '_Nothing named._',
    '',
    '## Product termination condition',
    '',
    intent.proof || 'Show the capability operating in the actual product with exact-head tests and no temporary installation left behind.',
    '',
    '## Machine plan',
    '',
    '```json',
    stableReceipt(intent).trimEnd(),
    '```',
    '',
    '## Native worker bridge',
    '',
    'The compatibility receipt below carries the same capability lifecycle into the existing bounded worker while Maker v2 is admitted.',
    '',
    '```json',
    JSON.stringify(nativeWorkerBridge(intent), null, 2),
    '```',
    '',
    'This plan was created by the static Sideways Maker capability surface. It grants no merge, deploy, credential, production-data, training-spend, or unrestricted installation authority.'
  ].join('\n');
}

export function buildIssueUrl(input = {}) {
  const intent = normalizeIntent(input);
  if (!intent.request) throw new Error('A capability request is required.');
  if (hasSecretLikeMaterial(intent)) throw new Error('Secret-like material must be removed before creating a public issue.');
  const url = new URL(`https://github.com/${REPOSITORY}/issues/new`);
  url.searchParams.set('title', buildIssueTitle(intent));
  url.searchParams.set('body', buildIssueBody(intent));
  return url.toString();
}

export function createDraftStorage(storage) {
  return Object.freeze({
    load() {
      try {
        const current = storage?.getItem(STORAGE_KEY);
        const legacy = current ? null : storage?.getItem(LEGACY_STORAGE_KEY);
        return normalizeIntent(JSON.parse(current || legacy || '{}'));
      } catch {
        return normalizeIntent();
      }
    },
    save(intent) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeIntent(intent)));
        storage?.removeItem(LEGACY_STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
        storage?.removeItem(LEGACY_STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    }
  });
}

export function normalizeRepositoryState(commitPayload = {}, issuesPayload = [], runsPayload = {}) {
  const issues = Array.isArray(issuesPayload) ? issuesPayload : [];
  const rawRuns = Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [];
  const openPullRequests = issues.filter(item => item?.pull_request).length;
  const openIssues = issues.length - openPullRequests;
  const runs = rawRuns.map(item => ({
    id: Number(item?.id) || 0,
    name: clean(item?.name || item?.display_title || 'workflow', 180),
    status: clean(item?.status || 'unknown', 40),
    conclusion: clean(item?.conclusion || '', 40),
    event: clean(item?.event || '', 40),
    branch: clean(item?.head_branch || '', 120),
    head: clean(item?.head_sha || '', 40).slice(0, 12),
    created_at: clean(item?.created_at || '', 64),
    url: typeof item?.html_url === 'string' ? item.html_url : null
  }));
  return {
    repository: REPOSITORY,
    head: typeof commitPayload?.sha === 'string' ? commitPayload.sha : null,
    short_head: typeof commitPayload?.sha === 'string' ? commitPayload.sha.slice(0, 12) : 'unknown',
    open_issues: Math.max(0, openIssues),
    open_pull_requests: Math.max(0, openPullRequests),
    running_workflows: runs.filter(item => item.status === 'queued' || item.status === 'in_progress' || item.status === 'waiting').length,
    active: issues.map(item => ({
      number: Number(item?.number) || 0,
      title: clean(item?.title, 240),
      kind: item?.pull_request ? 'pull_request' : 'issue',
      updated_at: clean(item?.updated_at || '', 64),
      url: typeof item?.html_url === 'string' ? item.html_url : null
    })),
    runs
  };
}

export async function fetchRepositoryState(fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json' };
  const [commitResponse, issuesResponse, runsResponse] = await Promise.all([
    fetchImpl(`https://api.github.com/repos/${REPOSITORY}/commits/main`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${REPOSITORY}/issues?state=open&per_page=100&sort=updated&direction=desc`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/runs?per_page=30`, { headers, cache: 'no-store' })
  ]);
  if (!commitResponse?.ok) throw new Error(`main state unavailable (${commitResponse?.status || 'network'})`);
  if (!issuesResponse?.ok) throw new Error(`open work unavailable (${issuesResponse?.status || 'network'})`);
  if (!runsResponse?.ok) throw new Error(`workflow state unavailable (${runsResponse?.status || 'network'})`);
  return normalizeRepositoryState(
    await commitResponse.json(),
    await issuesResponse.json(),
    await runsResponse.json()
  );
}

function operationLink(doc, item, kind) {
  const link = doc.createElement('a');
  link.className = 'operation-row';
  link.href = item.url || `https://github.com/${REPOSITORY}`;
  link.target = '_blank';
  link.rel = 'noreferrer';

  const badge = doc.createElement('span');
  badge.className = `badge ${kind}`;
  badge.textContent = kind === 'pull_request' ? 'PR' : kind === 'issue' ? 'ISSUE' : (item.conclusion || item.status || 'RUN').toUpperCase();

  const text = doc.createElement('span');
  text.className = 'operation-text';
  text.textContent = kind === 'run'
    ? `${item.name}${item.branch ? ` · ${item.branch}` : ''}`
    : `#${item.number} ${item.title}`;

  const meta = doc.createElement('span');
  meta.className = 'operation-meta';
  meta.textContent = kind === 'run'
    ? [item.status, item.event, item.head].filter(Boolean).join(' · ')
    : item.updated_at ? `updated ${new Date(item.updated_at).toLocaleString()}` : '';

  link.append(badge, text, meta);
  return link;
}

export function mountMakerConsole(doc = document, storage = localStorage, fetchImpl = fetch) {
  const persistence = createDraftStorage(storage);
  let intent = persistence.load();

  const request = doc.querySelector('#maker-request');
  const protect = doc.querySelector('#maker-protect');
  const proof = doc.querySelector('#maker-proof');
  const budget = doc.querySelector('#maker-budget');
  const runtime = doc.querySelector('#maker-runtime');
  const receipt = doc.querySelector('#receipt-preview');
  const commandStatus = doc.querySelector('#command-status');
  const stateStatus = doc.querySelector('#state-status');
  const send = doc.querySelector('#send-command');
  const modeButtons = [...doc.querySelectorAll('[data-mode]')];
  const architectureButtons = [...doc.querySelectorAll('[data-architecture]')];

  const setCommandStatus = message => { if (commandStatus) commandStatus.textContent = message; };
  const setStateStatus = message => { if (stateStatus) stateStatus.textContent = message; };

  const renderIntent = () => {
    if (request && request.value !== intent.request) request.value = intent.request;
    if (protect && protect.value !== intent.protect) protect.value = intent.protect;
    if (proof && proof.value !== intent.proof) proof.value = intent.proof;
    if (budget && Number(budget.value) !== intent.budget_envelope) budget.value = String(intent.budget_envelope);
    if (runtime && runtime.value !== intent.target_runtime) runtime.value = intent.target_runtime;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === intent.mode));
    for (const button of architectureButtons) button.setAttribute('aria-pressed', String(button.dataset.architecture === intent.architecture_prior));
    if (receipt) receipt.textContent = stableReceipt(intent);

    if (!send) return;
    try {
      send.href = buildIssueUrl(intent);
      send.removeAttribute('aria-disabled');
      send.classList.remove('disabled');
    } catch (error) {
      send.removeAttribute('href');
      send.setAttribute('aria-disabled', 'true');
      send.classList.add('disabled');
      if (intent.request && hasSecretLikeMaterial(intent)) setCommandStatus(error.message);
    }
  };

  const commit = next => {
    intent = normalizeIntent(next);
    const saved = persistence.save(intent);
    setCommandStatus(saved ? 'Plan saved on this device.' : 'Storage blocked. Keep this tab open or copy the machine plan.');
    renderIntent();
  };

  const readForm = () => normalizeIntent({
    ...intent,
    request: request?.value,
    protect: protect?.value,
    proof: proof?.value,
    budget_envelope: budget?.value,
    target_runtime: runtime?.value
  });

  for (const field of [request, protect, proof, budget, runtime]) field?.addEventListener('input', () => commit(readForm()));
  runtime?.addEventListener('change', () => commit(readForm()));
  for (const button of modeButtons) button.addEventListener('click', () => commit({ ...readForm(), mode: button.dataset.mode }));
  for (const button of architectureButtons) button.addEventListener('click', () => commit({ ...readForm(), architecture_prior: button.dataset.architecture }));

  send?.addEventListener('click', event => {
    if (!send.href || send.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      setCommandStatus(intent.request ? 'Remove secret-like material.' : 'Describe the capability first.');
    } else {
      setCommandStatus('GitHub opened with the complete capability plan.');
    }
  });

  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(stableReceipt(intent));
      setCommandStatus('Machine plan copied.');
    } catch {
      setCommandStatus('Clipboard unavailable. Open MACHINE PLAN and select it.');
    }
  });

  doc.querySelector('#reset-maker')?.addEventListener('click', () => {
    const cleared = persistence.clear();
    intent = normalizeIntent();
    setCommandStatus(cleared ? 'Plan cleared.' : 'Cleared in this tab only.');
    renderIntent();
  });

  const renderState = state => {
    const head = doc.querySelector('#repo-head');
    const issues = doc.querySelector('#open-issues');
    const prs = doc.querySelector('#open-prs');
    const running = doc.querySelector('#running-workflows');
    const work = doc.querySelector('#active-work');
    const workflows = doc.querySelector('#workflow-runs');
    if (head) head.textContent = state.short_head;
    if (issues) issues.textContent = String(state.open_issues);
    if (prs) prs.textContent = String(state.open_pull_requests);
    if (running) running.textContent = String(state.running_workflows);
    if (work) work.replaceChildren(...state.active.map(item => operationLink(doc, item, item.kind)));
    if (work && state.active.length === 0) work.textContent = 'No active construction.';
    if (workflows) workflows.replaceChildren(...state.runs.map(item => operationLink(doc, item, 'run')));
    if (workflows && state.runs.length === 0) workflows.textContent = 'No proof runs returned.';
    setStateStatus(`Updated ${new Date().toLocaleTimeString()} · ${state.active.length} active objects · ${state.runs.length} recent proofs`);
  };

  const refreshState = async () => {
    setStateStatus(navigator.onLine === false ? 'Offline. Capability planning still works.' : 'Reading product state…');
    try { renderState(await fetchRepositoryState(fetchImpl)); }
    catch (error) { setStateStatus(`Product state unavailable. ${error.message}`); }
  };

  doc.querySelector('#refresh-state')?.addEventListener('click', refreshState);
  globalThis.addEventListener?.('offline', () => setStateStatus('Offline. Capability planning still works.'));
  globalThis.addEventListener?.('online', refreshState);

  renderIntent();
  refreshState();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  return Object.freeze({ getIntent: () => normalizeIntent(intent), refreshState });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountMakerConsole();

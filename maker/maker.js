export const MAKER_VERSION = 'sideways-maker/v1';
export const MAKER_CONSOLE_VERSION = 'maker-engineering-console/v2';
export const STORAGE_KEY = 'maker:engineering:task:v2';
export const DEFAULT_REPOSITORY = 'Pokitomas/theawesomehexapp';
export const REPOSITORY = DEFAULT_REPOSITORY;
export const MODES = Object.freeze(['build', 'fix', 'explore', 'audit']);
export const BACKENDS = Object.freeze(['auto', 'native', 'github-models', 'configured']);

const LIMITS = Object.freeze({ repository: 300, base: 200, request: 8000, protect: 4000, proof: 4000 });
const SECRET_PATTERNS = Object.freeze([
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:REMOTE_KEY|SOCIAL_SESSION_SECRET|DATABASE_URL|SIDEWAYS_MODEL_API_KEY)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i
]);

const clean = (value, limit) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const validRepository = value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const validBase = value => value === 'main' || /^[A-Za-z0-9._/-]{1,200}$/.test(value);

export function normalizeIntent(input = {}) {
  const mode = clean(input.mode || 'build', 40).toLowerCase();
  const backend = clean(input.backend || 'auto', 40).toLowerCase();
  return {
    version: MAKER_VERSION,
    console_version: MAKER_CONSOLE_VERSION,
    repository: clean(input.repository || DEFAULT_REPOSITORY, LIMITS.repository),
    base_revision: clean(input.base_revision || input.base || 'main', LIMITS.base),
    backend: BACKENDS.includes(backend) ? backend : 'auto',
    mode: MODES.includes(mode) ? mode : 'build',
    request: clean(input.request, LIMITS.request),
    protect: clean(input.protect, LIMITS.protect),
    proof: clean(input.proof, LIMITS.proof),
    device_requirement: 'phone-first-and-desktop',
    authority: {
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none',
      production_data: 'none',
      training_spend: 'human'
    },
    execution_boundary: {
      browser_role: 'task-author-only',
      writer_count: 1,
      branch_lease_required: true,
      truthful_provider_state_required: true
    }
  };
}

export function validateIntent(input = {}) {
  const intent = normalizeIntent(input);
  if (!validRepository(intent.repository)) throw new Error('Repository must use owner/repository form.');
  if (!validBase(intent.base_revision)) throw new Error('Base revision is invalid.');
  if (!intent.request) throw new Error('An engineering end state is required.');
  if (hasSecretLikeMaterial(intent)) throw new Error('Secret-like material must be removed before creating a public task.');
  return intent;
}

export function stableReceipt(input = {}) {
  return `${JSON.stringify(normalizeIntent(input), null, 2)}\n`;
}

export function hasSecretLikeMaterial(input = {}) {
  const intent = normalizeIntent(input);
  const text = [intent.repository, intent.base_revision, intent.request, intent.protect, intent.proof].join('\n');
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function buildIssueTitle(input = {}) {
  const intent = validateIntent(input);
  const firstLine = intent.request.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'Engineering task';
  const compact = firstLine.replace(/\s+/g, ' ').slice(0, 92);
  return `[maker:${intent.mode}] ${compact}`.slice(0, 120);
}

export function buildIssueBody(input = {}) {
  const intent = validateIntent(input);
  return [
    '## Engineering command',
    '',
    intent.request,
    '',
    '## Repository identity',
    '',
    `- repository: \`${intent.repository}\``,
    `- base revision: \`${intent.base_revision}\``,
    `- requested backend: \`${intent.backend}\``,
    '',
    '## Protected reality',
    '',
    intent.protect || '_No additional boundary named._',
    '',
    '## Admission proof',
    '',
    intent.proof || 'Run focused tests, inspect the diff, and produce an exact-head receipt.',
    '',
    '## Machine receipt',
    '',
    '```json',
    stableReceipt(intent).trimEnd(),
    '```',
    '',
    'This task was authored in the static Maker engineering console. The browser did not execute code, receive credentials, acquire a lease, or start a writer. Execution begins only through an authorized repository worker. Merge, deployment, production data, and training spend remain human-only.'
  ].join('\n');
}

export function buildIssueUrl(input = {}) {
  const intent = validateIntent(input);
  const url = new URL(`https://github.com/${intent.repository}/issues/new`);
  url.searchParams.set('title', buildIssueTitle(intent));
  url.searchParams.set('body', buildIssueBody(intent));
  return url.toString();
}

export function createDraftStorage(storage) {
  return Object.freeze({
    load() {
      try { return normalizeIntent(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')); }
      catch { return normalizeIntent(); }
    },
    save(intent) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeIntent(intent)));
        return true;
      } catch { return false; }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
        return true;
      } catch { return false; }
    }
  });
}

export function executionTruth(input = {}, nativeRegistry = {}) {
  const intent = normalizeIntent(input);
  const admitted = Array.isArray(nativeRegistry?.admitted_native_models) ? nativeRegistry.admitted_native_models : [];
  let backend = `${intent.backend} · unresolved until worker starts`;
  const native = admitted.length ? `${admitted.length} admitted checkpoint${admitted.length === 1 ? '' : 's'}` : 'No admitted checkpoint';
  if (intent.backend === 'native' && !admitted.length) backend = 'native requested · blocked until checkpoint admission';
  if (intent.backend === 'github-models') backend = 'GitHub Models requested · availability resolved by worker';
  if (intent.backend === 'configured') backend = 'configured provider requested · credentials remain server-side';
  return Object.freeze({
    browser: 'Task author only',
    writer: 'One leased branch',
    backend,
    native,
    tools: 'read · search · write · replace · delete · run · verify · rollback',
    lease: 'required before first write',
    human_gates: 'merge · deploy · production data · training spend'
  });
}

export function normalizeRepositoryState(repository, commitPayload = {}, issuesPayload = [], runsPayload = {}) {
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
    repository,
    head: typeof commitPayload?.sha === 'string' ? commitPayload.sha : null,
    short_head: typeof commitPayload?.sha === 'string' ? commitPayload.sha.slice(0, 12) : 'unknown',
    open_issues: Math.max(0, openIssues),
    open_pull_requests: Math.max(0, openPullRequests),
    running_workflows: runs.filter(item => ['queued', 'in_progress', 'waiting', 'pending'].includes(item.status)).length,
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

export async function fetchRepositoryState(repositoryOrFetch = DEFAULT_REPOSITORY, fetchMaybe = fetch) {
  const repository = typeof repositoryOrFetch === 'function' ? DEFAULT_REPOSITORY : clean(repositoryOrFetch || DEFAULT_REPOSITORY, LIMITS.repository);
  const fetchImpl = typeof repositoryOrFetch === 'function' ? repositoryOrFetch : fetchMaybe;
  if (!validRepository(repository)) throw new Error('Repository must use owner/repository form.');
  const headers = { Accept: 'application/vnd.github+json' };
  const [commitResponse, issuesResponse, runsResponse] = await Promise.all([
    fetchImpl(`https://api.github.com/repos/${repository}/commits/main`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${repository}/issues?state=open&per_page=100&sort=updated&direction=desc`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${repository}/actions/runs?per_page=30`, { headers, cache: 'no-store' })
  ]);
  if (!commitResponse?.ok) throw new Error(`base state unavailable (${commitResponse?.status || 'network'})`);
  if (!issuesResponse?.ok) throw new Error(`open work unavailable (${issuesResponse?.status || 'network'})`);
  if (!runsResponse?.ok) throw new Error(`workflow state unavailable (${runsResponse?.status || 'network'})`);
  return normalizeRepositoryState(repository, await commitResponse.json(), await issuesResponse.json(), await runsResponse.json());
}

function operationLink(doc, item, kind, repository) {
  const link = doc.createElement('a');
  link.className = 'operation-row';
  link.href = item.url || `https://github.com/${repository}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  const badge = doc.createElement('span');
  badge.className = `badge ${kind === 'run' ? (item.conclusion || item.status || 'run') : kind}`;
  badge.textContent = kind === 'pull_request' ? 'PR' : kind === 'issue' ? 'ISSUE' : (item.conclusion || item.status || 'RUN').toUpperCase();
  const text = doc.createElement('span');
  text.className = 'operation-text';
  text.textContent = kind === 'run' ? `${item.name}${item.branch ? ` · ${item.branch}` : ''}` : `#${item.number} ${item.title}`;
  const meta = doc.createElement('span');
  meta.className = 'operation-meta';
  meta.textContent = kind === 'run' ? [item.status, item.event, item.head].filter(Boolean).join(' · ') : item.updated_at ? `updated ${new Date(item.updated_at).toLocaleString()}` : '';
  link.append(badge, text, meta);
  return link;
}

export function mountMakerConsole(doc = document, storage = localStorage, fetchImpl = fetch) {
  const persistence = createDraftStorage(storage);
  let intent = persistence.load();
  const repository = doc.querySelector('#maker-repository');
  const base = doc.querySelector('#maker-base');
  const backend = doc.querySelector('#maker-backend');
  const request = doc.querySelector('#maker-request');
  const protect = doc.querySelector('#maker-protect');
  const proof = doc.querySelector('#maker-proof');
  const receipt = doc.querySelector('#receipt-preview');
  const commandStatus = doc.querySelector('#command-status');
  const stateStatus = doc.querySelector('#state-status');
  const send = doc.querySelector('#send-command');
  const modeButtons = [...doc.querySelectorAll('[data-mode]')];
  const setCommandStatus = message => { if (commandStatus) commandStatus.textContent = message; };
  const setStateStatus = message => { if (stateStatus) stateStatus.textContent = message; };

  const renderTruth = () => {
    const truth = executionTruth(intent);
    const values = {
      '#backend-state': truth.backend,
      '#tool-state': truth.tools,
      '#lease-state': truth.lease,
      '#human-gates': truth.human_gates,
      '#native-model-state': truth.native
    };
    for (const [selector, value] of Object.entries(values)) {
      const node = doc.querySelector(selector);
      if (node) node.textContent = value;
    }
  };

  const renderIntent = () => {
    if (repository && repository.value !== intent.repository) repository.value = intent.repository;
    if (base && base.value !== intent.base_revision) base.value = intent.base_revision;
    if (backend && backend.value !== intent.backend) backend.value = intent.backend;
    if (request && request.value !== intent.request) request.value = intent.request;
    if (protect && protect.value !== intent.protect) protect.value = intent.protect;
    if (proof && proof.value !== intent.proof) proof.value = intent.proof;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === intent.mode));
    if (receipt) receipt.textContent = stableReceipt(intent);
    const repoLink = doc.querySelector('.repo-link');
    if (repoLink && validRepository(intent.repository)) repoLink.href = `https://github.com/${intent.repository}`;
    renderTruth();
    if (!send) return;
    try {
      send.href = buildIssueUrl(intent);
      send.removeAttribute('aria-disabled');
      send.classList.remove('disabled');
    } catch (error) {
      send.removeAttribute('href');
      send.setAttribute('aria-disabled', 'true');
      send.classList.add('disabled');
      if (intent.request || hasSecretLikeMaterial(intent)) setCommandStatus(error.message);
    }
  };

  const commit = next => {
    intent = normalizeIntent(next);
    const saved = persistence.save(intent);
    setCommandStatus(saved ? 'Draft stored only in the Maker engineering namespace.' : 'Storage blocked. Keep this tab open or copy the receipt.');
    renderIntent();
  };

  const readForm = () => normalizeIntent({
    ...intent,
    repository: repository?.value,
    base_revision: base?.value,
    backend: backend?.value,
    request: request?.value,
    protect: protect?.value,
    proof: proof?.value
  });

  for (const field of [repository, base, backend, request, protect, proof]) field?.addEventListener('input', () => commit(readForm()));
  backend?.addEventListener('change', () => commit(readForm()));
  for (const button of modeButtons) button.addEventListener('click', () => commit({ ...readForm(), mode: button.dataset.mode }));
  send?.addEventListener('click', event => {
    if (!send.href || send.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      setCommandStatus(intent.request ? 'Correct the repository/base or remove secret-like material.' : 'Enter an engineering end state first.');
    } else {
      setCommandStatus('GitHub opened. Submitting the issue requests an authorized worker; this browser did not start execution.');
    }
  });
  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(stableReceipt(intent));
      setCommandStatus('Machine receipt copied.');
    } catch { setCommandStatus('Clipboard unavailable. Open MACHINE RECEIPT and select it.'); }
  });
  doc.querySelector('#reset-maker')?.addEventListener('click', () => {
    const cleared = persistence.clear();
    intent = normalizeIntent();
    setCommandStatus(cleared ? 'Local Maker draft cleared.' : 'Cleared in this tab only.');
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
    if (work) work.replaceChildren(...state.active.map(item => operationLink(doc, item, item.kind, state.repository)));
    if (work && state.active.length === 0) work.textContent = 'No open work returned.';
    if (workflows) workflows.replaceChildren(...state.runs.map(item => operationLink(doc, item, 'run', state.repository)));
    if (workflows && state.runs.length === 0) workflows.textContent = 'No workflow runs returned.';
    setStateStatus(`Public state for ${state.repository} · ${state.active.length} open objects · ${state.runs.length} recent runs`);
  };

  const refreshState = async () => {
    setStateStatus(navigator.onLine === false ? 'Offline. Task authoring remains local.' : 'Reading public repository state…');
    try { renderState(await fetchRepositoryState(intent.repository, fetchImpl)); }
    catch (error) { setStateStatus(`Execution state unavailable. ${error.message}`); }
  };
  doc.querySelector('#refresh-state')?.addEventListener('click', refreshState);
  repository?.addEventListener('change', refreshState);
  globalThis.addEventListener?.('offline', () => setStateStatus('Offline. Task authoring remains local.'));
  globalThis.addEventListener?.('online', refreshState);
  renderIntent();
  refreshState();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('./sw.js').catch(() => {});
  return Object.freeze({ getIntent: () => normalizeIntent(intent), refreshState });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountMakerConsole();

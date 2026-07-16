export const MAKER_VERSION = 'sideways-maker/v1';
export const MAKER_CONSOLE_VERSION = 'maker-operator-cockpit/v3';
export const STORAGE_KEY = 'maker:engineering:task:v3';
export const RECEIPT_HISTORY_KEY = 'maker:engineering:receipts:v1';
export const CONTROL_REPOSITORY = 'Pokitomas/theawesomehexapp';
export const DEFAULT_REPOSITORY = CONTROL_REPOSITORY;
export const REPOSITORY = CONTROL_REPOSITORY;
export const MODES = Object.freeze([
  'build', 'fix', 'explore', 'audit', 'create-repository', 'bootstrap',
  'fork', 'migrate', 'review', 'repair', 'release'
]);
export const BACKENDS = Object.freeze(['auto', 'native', 'github-models', 'configured']);
export const INTERVENTIONS = Object.freeze(['resume', 'cancel', 'rollback', 'rerun', 'request-review', 'reopen']);
export const MAX_DIRECT_ISSUE_URL = 7000;

const LIMITS = Object.freeze({ repository: 300, base: 200, branch: 240, request: 8000, protect: 4000, proof: 4000 });
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
const validBranch = value => /^[A-Za-z0-9._/-]{1,240}$/.test(value) && !value.includes('..') && !value.endsWith('/');
const fnvFingerprint = text => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

export function normalizeIntent(input = {}) {
  const mode = clean(input.mode || 'build', 40).toLowerCase();
  const backend = clean(input.backend || 'auto', 40).toLowerCase();
  const target = clean(input.repository || input.target_repository || DEFAULT_REPOSITORY, LIMITS.repository);
  return {
    version: MAKER_VERSION,
    console_version: MAKER_CONSOLE_VERSION,
    control_repository: CONTROL_REPOSITORY,
    repository: target,
    target_repository: target,
    head_repository: clean(input.head_repository || target, LIMITS.repository),
    base_revision: clean(input.base_revision || input.base || 'main', LIMITS.base),
    branch: clean(input.branch || 'maker/task', LIMITS.branch),
    backend: BACKENDS.includes(backend) ? backend : 'auto',
    mode: MODES.includes(mode) ? mode : 'build',
    request: clean(input.request, LIMITS.request),
    protect: clean(input.protect, LIMITS.protect),
    proof: clean(input.proof, LIMITS.proof),
    device_requirement: 'phone-first-and-desktop',
    authority: {
      issue_creation: 'human-browser',
      execution: 'authenticated-control-runtime',
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none',
      production_data: 'none',
      training_spend: 'human'
    },
    execution_boundary: {
      browser_role: 'task-author-and-observer-only',
      writer_count: 1,
      branch_lease_required: true,
      truthful_provider_state_required: true,
      static_success_claims: false
    }
  };
}

export function validateIntent(input = {}) {
  const intent = normalizeIntent(input);
  if (intent.control_repository !== CONTROL_REPOSITORY) throw new Error('Control repository is fixed by the admitted runtime.');
  if (!validRepository(intent.repository)) throw new Error('Target repository must use owner/repository form.');
  if (!validRepository(intent.head_repository)) throw new Error('Head repository must use owner/repository form.');
  if (!validBase(intent.base_revision)) throw new Error('Base revision is invalid.');
  if (!validBranch(intent.branch)) throw new Error('Branch is invalid.');
  if (!intent.request) throw new Error('An engineering end state is required.');
  if (hasSecretLikeMaterial(intent)) throw new Error('Secret-like material must be removed before creating a public task.');
  return intent;
}

export function stableReceipt(input = {}) {
  return `${JSON.stringify(normalizeIntent(input), null, 2)}\n`;
}

export function hasSecretLikeMaterial(input = {}) {
  const intent = normalizeIntent(input);
  const text = [intent.control_repository, intent.repository, intent.head_repository, intent.base_revision, intent.branch, intent.request, intent.protect, intent.proof].join('\n');
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
    '## Engineering command', '', intent.request, '',
    '## Repository routing', '',
    `- control repository: \`${intent.control_repository}\``,
    `- target repository: \`${intent.repository}\``,
    `- base revision: \`${intent.base_revision}\``,
    `- head repository: \`${intent.head_repository}\``,
    `- leased branch: \`${intent.branch}\``,
    `- requested backend: \`${intent.backend}\``, '',
    '## Protected reality', '', intent.protect || '_No additional boundary named._', '',
    '## Admission proof', '', intent.proof || 'Run focused tests, inspect the diff, and produce an exact-head receipt.', '',
    '## Machine receipt', '', '```json', stableReceipt(intent).trimEnd(), '```', '',
    'This task was authored in the static Maker operator cockpit. The issue is opened in the control repository while the receipt preserves the target repository. The browser did not execute code, receive credentials, acquire a lease, start a writer, mutate a repository, merge, deploy, or train a model.'
  ].join('\n');
}

export function buildCompactIssueBody(input = {}) {
  const intent = validateIntent(input);
  const receipt = stableReceipt(intent);
  return [
    '## Compact Maker command', '',
    `Target: \`${intent.repository}\` at \`${intent.base_revision}\``,
    `Head: \`${intent.head_repository}:${intent.branch}\``,
    `Mode/backend: \`${intent.mode}\` / \`${intent.backend}\``, '',
    clean(intent.request, 1000), '',
    `Full receipt length: ${receipt.length} bytes`,
    `Receipt fingerprint (non-cryptographic transport hint): \`${fnvFingerprint(receipt)}\``, '',
    'The full machine receipt exceeded the safe issue-URL budget. Attach the downloaded receipt or paste the copied receipt before an authenticated worker starts. No execution is claimed by this compact packet.'
  ].join('\n');
}

export function buildIssueUrl(input = {}, { compact = false } = {}) {
  const intent = validateIntent(input);
  const url = new URL(`https://github.com/${CONTROL_REPOSITORY}/issues/new`);
  url.searchParams.set('title', buildIssueTitle(intent));
  url.searchParams.set('body', compact ? buildCompactIssueBody(intent) : buildIssueBody(intent));
  return url.toString();
}

export function buildDispatch(input = {}, maxUrlLength = MAX_DIRECT_ISSUE_URL) {
  const intent = validateIntent(input);
  const direct = buildIssueUrl(intent);
  const receipt = stableReceipt(intent);
  if (direct.length <= maxUrlLength) {
    return Object.freeze({ strategy: 'direct_issue', issue_url: direct, receipt, requires_full_receipt_attachment: false, receipt_filename: 'maker-command.json' });
  }
  return Object.freeze({
    strategy: 'compact_issue_with_receipt',
    issue_url: buildIssueUrl(intent, { compact: true }),
    receipt,
    requires_full_receipt_attachment: true,
    receipt_filename: `maker-command-${fnvFingerprint(receipt)}.json`
  });
}

export function buildInterventionUrl(action, input = {}) {
  const intent = normalizeIntent(input);
  if (!validRepository(intent.repository) || !validRepository(intent.head_repository)) throw new Error('Intervention routing is invalid.');
  if (!validBase(intent.base_revision) || !validBranch(intent.branch)) throw new Error('Intervention base or branch is invalid.');
  if (hasSecretLikeMaterial(intent)) throw new Error('Secret-like material must be removed before creating a public intervention.');
  const normalized = clean(action, 60).toLowerCase();
  if (!INTERVENTIONS.includes(normalized)) throw new Error('Unsupported intervention action.');
  const url = new URL(`https://github.com/${CONTROL_REPOSITORY}/issues/new`);
  url.searchParams.set('title', `[maker:command] ${normalized} ${intent.repository}:${intent.branch}`.slice(0, 120));
  url.searchParams.set('body', [
    '## Operator intervention request', '',
    `- action: \`${normalized}\``,
    `- control repository: \`${CONTROL_REPOSITORY}\``,
    `- target repository: \`${intent.repository}\``,
    `- exact base: \`${intent.base_revision}\``,
    `- head repository: \`${intent.head_repository}\``,
    `- branch: \`${intent.branch}\``, '',
    'This link records an instruction only. The static cockpit did not perform the intervention.'
  ].join('\n'));
  return url.toString();
}

export function createDraftStorage(storage) {
  const readHistory = () => {
    try {
      const value = JSON.parse(storage?.getItem(RECEIPT_HISTORY_KEY) || '[]');
      return Array.isArray(value) ? value.slice(0, 10).map(normalizeIntent) : [];
    } catch { return []; }
  };
  return Object.freeze({
    load() {
      try { return normalizeIntent(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')); }
      catch { return normalizeIntent(); }
    },
    save(intent) {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeIntent(intent))); return true; }
      catch { return false; }
    },
    record(intent) {
      try {
        const normalized = normalizeIntent(intent);
        const history = [normalized, ...readHistory().filter(item => stableReceipt(item) !== stableReceipt(normalized))].slice(0, 10);
        storage?.setItem(RECEIPT_HISTORY_KEY, JSON.stringify(history));
        return true;
      } catch { return false; }
    },
    history: readHistory,
    clear() {
      try { storage?.removeItem(STORAGE_KEY); return true; }
      catch { return false; }
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
    browser: 'Task author and observer only', writer: 'One leased branch', backend, native,
    tools: 'workspace · files · commands · dependencies · network · browser · artifacts · GitHub · CI · review · release · rollback',
    lease: 'required before first write', human_gates: 'merge · deploy · repository lifecycle · production data · training spend',
    routing: `${CONTROL_REPOSITORY} → ${intent.repository}`
  });
}

function classifyRun(item = {}) {
  if (item.status === 'completed') return item.conclusion || 'unknown';
  if (['queued', 'waiting', 'pending'].includes(item.status)) return 'queued';
  if (item.status === 'in_progress') return 'running';
  return item.status || 'unknown';
}

export function parseMachineComments(comments = []) {
  return comments.map(comment => {
    const body = clean(comment?.body, 20000);
    const value = key => body.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*([^\\n]+)`, 'i'))?.[1]?.replace(/`/g, '').trim() || null;
    const branch = value('branch');
    const base = value('base_sha');
    const run = body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/)?.[0] || null;
    return {
      id: Number(comment?.id) || 0,
      kind: body.includes('sideways-native-worker:v1') ? 'worker' : 'comment',
      state: /failed|blocked/i.test(body) ? 'failed' : /ready|completed|success/i.test(body) ? 'ready' : /started|running/i.test(body) ? 'running' : 'recorded',
      branch, base, run, body: clean(body, 1000), url: comment?.html_url || comment?.url || null
    };
  });
}

export function normalizeRepositoryState(repository, commitPayload = {}, issuesPayload = [], runsPayload = {}, commentsPayload = []) {
  const issues = Array.isArray(issuesPayload) ? issuesPayload : [];
  const rawRuns = Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [];
  const openPullRequests = issues.filter(item => item?.pull_request).length;
  const openIssues = issues.length - openPullRequests;
  const runs = rawRuns.map(item => ({
    id: Number(item?.id) || 0, name: clean(item?.name || item?.display_title || 'workflow', 180),
    status: clean(item?.status || 'unknown', 40), conclusion: clean(item?.conclusion || '', 40),
    state: classifyRun(item), event: clean(item?.event || '', 40), branch: clean(item?.head_branch || '', 120),
    head: clean(item?.head_sha || '', 64).slice(0, 12), created_at: clean(item?.created_at || '', 64),
    url: typeof item?.html_url === 'string' ? item.html_url : null
  }));
  const active = issues.map(item => ({
    number: Number(item?.number) || 0, title: clean(item?.title, 240), kind: item?.pull_request ? 'pull_request' : 'issue',
    updated_at: clean(item?.updated_at || '', 64), url: typeof item?.html_url === 'string' ? item.html_url : null
  }));
  const comments = parseMachineComments(commentsPayload);
  const timeline = [
    ...active.map(item => ({ type: item.kind, state: 'open', label: `#${item.number} ${item.title}`, url: item.url, at: item.updated_at })),
    ...runs.map(item => ({ type: 'run', state: item.state, label: item.name, url: item.url, at: item.created_at, branch: item.branch, head: item.head })),
    ...comments.map(item => ({ type: item.kind, state: item.state, label: item.branch ? `Worker ${item.branch}` : 'Machine comment', url: item.run || item.url, at: '', branch: item.branch, head: item.base?.slice(0, 12) || '' }))
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return {
    control_repository: CONTROL_REPOSITORY, target_repository: repository, repository,
    head: typeof commitPayload?.sha === 'string' ? commitPayload.sha : null,
    short_head: typeof commitPayload?.sha === 'string' ? commitPayload.sha.slice(0, 12) : 'unknown',
    open_issues: Math.max(0, openIssues), open_pull_requests: Math.max(0, openPullRequests),
    running_workflows: runs.filter(item => ['queued', 'running'].includes(item.state)).length,
    active, runs, comments, timeline
  };
}

export async function fetchRepositoryState(repositoryOrFetch = DEFAULT_REPOSITORY, fetchMaybe = fetch) {
  const repository = typeof repositoryOrFetch === 'function' ? DEFAULT_REPOSITORY : clean(repositoryOrFetch || DEFAULT_REPOSITORY, LIMITS.repository);
  const fetchImpl = typeof repositoryOrFetch === 'function' ? repositoryOrFetch : fetchMaybe;
  if (!validRepository(repository)) throw new Error('Target repository must use owner/repository form.');
  const headers = { Accept: 'application/vnd.github+json' };
  const [commitResponse, issuesResponse, runsResponse] = await Promise.all([
    fetchImpl(`https://api.github.com/repos/${repository}/commits/main`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${CONTROL_REPOSITORY}/issues?state=open&per_page=100&sort=updated&direction=desc`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${CONTROL_REPOSITORY}/actions/runs?per_page=30`, { headers, cache: 'no-store' })
  ]);
  if (!commitResponse?.ok) throw new Error(`target base state unavailable (${commitResponse?.status || 'network'})`);
  if (!issuesResponse?.ok) throw new Error(`control work unavailable (${issuesResponse?.status || 'network'})`);
  if (!runsResponse?.ok) throw new Error(`control workflow state unavailable (${runsResponse?.status || 'network'})`);
  const issues = await issuesResponse.json();
  const latestTask = Array.isArray(issues) ? issues.find(item => !item?.pull_request && /^\[maker:/.test(item?.title || '')) : null;
  let comments = [];
  if (latestTask?.number) {
    const response = await fetchImpl(`https://api.github.com/repos/${CONTROL_REPOSITORY}/issues/${latestTask.number}/comments?per_page=100`, { headers, cache: 'no-store' });
    if (response?.ok) comments = await response.json();
  }
  return normalizeRepositoryState(repository, await commitResponse.json(), issues, await runsResponse.json(), comments);
}

function operationLink(doc, item, kind, repository) {
  const link = doc.createElement('a');
  link.className = 'operation-row'; link.href = item.url || `https://github.com/${repository}`; link.target = '_blank'; link.rel = 'noreferrer';
  const badge = doc.createElement('span'); badge.className = `badge ${kind === 'run' ? (item.state || item.conclusion || item.status || 'run') : kind}`;
  badge.textContent = kind === 'pull_request' ? 'PR' : kind === 'issue' ? 'ISSUE' : (item.state || item.conclusion || item.status || 'RUN').toUpperCase();
  const text = doc.createElement('span'); text.className = 'operation-text'; text.textContent = kind === 'run' ? `${item.name}${item.branch ? ` · ${item.branch}` : ''}` : `#${item.number} ${item.title}`;
  const meta = doc.createElement('span'); meta.className = 'operation-meta'; meta.textContent = kind === 'run' ? [item.status, item.event, item.head].filter(Boolean).join(' · ') : item.updated_at ? `updated ${new Date(item.updated_at).toLocaleString()}` : '';
  link.append(badge, text, meta); return link;
}

function timelineLink(doc, item) {
  const link = doc.createElement(item.url ? 'a' : 'div');
  link.className = 'operation-row';
  if (item.url) { link.href = item.url; link.target = '_blank'; link.rel = 'noreferrer'; }
  const badge = doc.createElement('span'); badge.className = `badge ${item.state}`; badge.textContent = String(item.state || item.type).toUpperCase();
  const text = doc.createElement('span'); text.className = 'operation-text'; text.textContent = item.label;
  const meta = doc.createElement('span'); meta.className = 'operation-meta'; meta.textContent = [item.branch, item.head, item.at].filter(Boolean).join(' · ');
  link.append(badge, text, meta); return link;
}

export function mountMakerConsole(doc = document, storage = localStorage, fetchImpl = fetch) {
  const persistence = createDraftStorage(storage);
  let intent = persistence.load();
  const byId = id => doc.querySelector(`#${id}`);
  const control = byId('maker-control-repository'); const repository = byId('maker-repository');
  const headRepository = byId('maker-head-repository'); const base = byId('maker-base'); const branch = byId('maker-branch');
  const backend = byId('maker-backend'); const request = byId('maker-request'); const protect = byId('maker-protect'); const proof = byId('maker-proof');
  const receipt = byId('receipt-preview'); const commandStatus = byId('command-status'); const stateStatus = byId('state-status');
  const send = byId('send-command'); const download = byId('download-receipt'); const modeButtons = [...doc.querySelectorAll('[data-mode]')];
  const setCommandStatus = message => { if (commandStatus) commandStatus.textContent = message; };
  const setStateStatus = message => { if (stateStatus) stateStatus.textContent = message; };

  const renderTruth = () => {
    const truth = executionTruth(intent);
    const values = { '#backend-state': truth.backend, '#tool-state': truth.tools, '#lease-state': truth.lease, '#human-gates': truth.human_gates, '#native-model-state': truth.native, '#routing-state': truth.routing };
    for (const [selector, value] of Object.entries(values)) { const node = doc.querySelector(selector); if (node) node.textContent = value; }
  };
  const renderHistory = () => {
    const node = byId('recent-receipts'); if (!node) return;
    const history = persistence.history();
    if (!history.length) { node.textContent = 'No locally recorded task receipts.'; return; }
    node.replaceChildren(...history.map(item => {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'operation-row';
      button.textContent = `${item.mode.toUpperCase()} · ${item.repository} · ${item.base_revision}`;
      button.addEventListener('click', () => commit(item)); return button;
    }));
  };
  const renderInterventions = () => {
    const node = byId('intervention-links'); if (!node) return;
    try {
      node.replaceChildren(...INTERVENTIONS.map(action => {
        const link = doc.createElement('a'); link.className = 'operation-row'; link.target = '_blank'; link.rel = 'noreferrer';
        link.href = buildInterventionUrl(action, intent); link.textContent = `${action.toUpperCase()} — creates a control-repository instruction`; return link;
      }));
    } catch (error) { node.textContent = `Interventions unavailable: ${error.message}`; }
  };
  const renderIntent = () => {
    if (control) control.value = CONTROL_REPOSITORY;
    if (repository && repository.value !== intent.repository) repository.value = intent.repository;
    if (headRepository && headRepository.value !== intent.head_repository) headRepository.value = intent.head_repository;
    if (base && base.value !== intent.base_revision) base.value = intent.base_revision;
    if (branch && branch.value !== intent.branch) branch.value = intent.branch;
    if (backend && backend.value !== intent.backend) backend.value = intent.backend;
    if (request && request.value !== intent.request) request.value = intent.request;
    if (protect && protect.value !== intent.protect) protect.value = intent.protect;
    if (proof && proof.value !== intent.proof) proof.value = intent.proof;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === intent.mode));
    if (receipt) receipt.textContent = stableReceipt(intent);
    const controlLink = doc.querySelector('.repo-link'); if (controlLink) controlLink.href = `https://github.com/${CONTROL_REPOSITORY}`;
    const targetLink = byId('target-repo-link'); if (targetLink && validRepository(intent.repository)) targetLink.href = `https://github.com/${intent.repository}`;
    renderTruth(); renderInterventions();
    if (!send) return;
    try {
      const dispatch = buildDispatch(intent);
      send.href = dispatch.issue_url; send.removeAttribute('aria-disabled'); send.classList.remove('disabled');
      send.textContent = dispatch.strategy === 'direct_issue' ? 'OPEN AUTHORIZED TASK' : 'OPEN COMPACT TASK';
      const strategy = byId('dispatch-strategy'); if (strategy) strategy.textContent = dispatch.strategy === 'direct_issue' ? 'Direct control-repository issue' : 'Compact issue + full receipt required';
      if (download) download.hidden = false;
    } catch (error) {
      send.removeAttribute('href'); send.setAttribute('aria-disabled', 'true'); send.classList.add('disabled');
      if (intent.request || hasSecretLikeMaterial(intent)) setCommandStatus(error.message);
    }
  };
  const commit = next => {
    intent = normalizeIntent(next); const saved = persistence.save(intent);
    setCommandStatus(saved ? 'Draft stored only in the Maker engineering namespace.' : 'Storage blocked. Keep this tab open or copy the receipt.');
    renderIntent();
  };
  const readForm = () => normalizeIntent({ ...intent, repository: repository?.value, head_repository: headRepository?.value, base_revision: base?.value, branch: branch?.value, backend: backend?.value, request: request?.value, protect: protect?.value, proof: proof?.value });
  for (const field of [repository, headRepository, base, branch, backend, request, protect, proof]) field?.addEventListener('input', () => commit(readForm()));
  backend?.addEventListener('change', () => commit(readForm()));
  for (const button of modeButtons) button.addEventListener('click', () => commit({ ...readForm(), mode: button.dataset.mode }));
  send?.addEventListener('click', event => {
    if (!send.href || send.getAttribute('aria-disabled') === 'true') { event.preventDefault(); setCommandStatus(intent.request ? 'Correct the repository/base/branch or remove secret-like material.' : 'Enter an engineering end state first.'); }
    else { persistence.record(intent); renderHistory(); setCommandStatus('GitHub control task opened. This browser did not start execution.'); }
  });
  byId('copy-receipt')?.addEventListener('click', async () => {
    try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(stableReceipt(intent)); persistence.record(intent); renderHistory(); setCommandStatus('Full machine receipt copied.'); }
    catch { setCommandStatus('Clipboard unavailable. Open MACHINE RECEIPT and select it.'); }
  });
  download?.addEventListener('click', () => {
    try {
      const dispatch = buildDispatch(intent); const blob = new Blob([dispatch.receipt], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const anchor = doc.createElement('a'); anchor.href = url; anchor.download = dispatch.receipt_filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      persistence.record(intent); renderHistory(); setCommandStatus('Full machine receipt downloaded. No task was executed.');
    } catch (error) { setCommandStatus(error.message); }
  });
  byId('reset-maker')?.addEventListener('click', () => { const cleared = persistence.clear(); intent = normalizeIntent(); setCommandStatus(cleared ? 'Local Maker draft cleared.' : 'Cleared in this tab only.'); renderIntent(); });

  const renderState = state => {
    const head = byId('repo-head'); const issues = byId('open-issues'); const prs = byId('open-prs'); const running = byId('running-workflows');
    const work = byId('active-work'); const workflows = byId('workflow-runs'); const timeline = byId('task-timeline');
    if (head) head.textContent = state.short_head; if (issues) issues.textContent = String(state.open_issues); if (prs) prs.textContent = String(state.open_pull_requests); if (running) running.textContent = String(state.running_workflows);
    if (work) work.replaceChildren(...state.active.map(item => operationLink(doc, item, item.kind, state.control_repository)));
    if (work && state.active.length === 0) work.textContent = 'No open control-repository work returned.';
    if (workflows) workflows.replaceChildren(...state.runs.map(item => operationLink(doc, item, 'run', state.control_repository)));
    if (workflows && state.runs.length === 0) workflows.textContent = 'No control-repository workflow runs returned.';
    if (timeline) timeline.replaceChildren(...state.timeline.map(item => timelineLink(doc, item)));
    if (timeline && state.timeline.length === 0) timeline.textContent = 'No public task timeline returned.';
    setStateStatus(`Control ${state.control_repository} · target ${state.target_repository} · ${state.active.length} open objects · ${state.runs.length} recent runs`);
  };
  const refreshState = async () => {
    setStateStatus(navigator.onLine === false ? 'Offline. Task authoring and receipt export remain local.' : 'Reading target identity and control-repository execution state…');
    try { renderState(await fetchRepositoryState(intent.repository, fetchImpl)); }
    catch (error) { setStateStatus(`Execution state unavailable. ${error.message}`); }
  };
  byId('refresh-state')?.addEventListener('click', refreshState); repository?.addEventListener('change', refreshState);
  globalThis.addEventListener?.('offline', () => setStateStatus('Offline. Task authoring and receipt export remain local.'));
  globalThis.addEventListener?.('online', refreshState);
  renderIntent(); renderHistory(); refreshState();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('./sw.js').catch(() => {});
  return Object.freeze({ getIntent: () => normalizeIntent(intent), refreshState });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountMakerConsole();

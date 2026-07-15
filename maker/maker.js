export const MAKER_VERSION = 'sideways-maker/v1';
export const STORAGE_KEY = 'sideways:maker:draft:v1';
export const REPOSITORY = 'Pokitomas/theawesomehexapp';
export const MODES = Object.freeze(['build', 'fix', 'explore', 'audit']);

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

export function normalizeIntent(input = {}) {
  const mode = String(input.mode || 'build').trim().toLowerCase();
  return {
    version: MAKER_VERSION,
    repository: REPOSITORY,
    mode: MODES.includes(mode) ? mode : 'build',
    request: clean(input.request, LIMITS.request),
    protect: clean(input.protect, LIMITS.protect),
    proof: clean(input.proof, LIMITS.proof),
    device_requirement: 'phone-first',
    authority: {
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none'
    }
  };
}

export function stableReceipt(input = {}) {
  return `${JSON.stringify(normalizeIntent(input), null, 2)}\n`;
}

export function hasSecretLikeMaterial(input = {}) {
  const intent = normalizeIntent(input);
  const text = [intent.request, intent.protect, intent.proof].join('\n');
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function buildIssueTitle(input = {}) {
  const intent = normalizeIntent(input);
  const firstLine = intent.request.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'Founder command';
  const compact = firstLine.replace(/\s+/g, ' ').slice(0, 92);
  return `[maker:${intent.mode}] ${compact}`.slice(0, 120);
}

export function buildIssueBody(input = {}) {
  const intent = normalizeIntent(input);
  return [
    '## Founder command',
    '',
    intent.request || '_No request supplied._',
    '',
    '## Protected reality',
    '',
    intent.protect || '_Nothing named._',
    '',
    '## Required proof',
    '',
    intent.proof || 'Show the result as a runnable phone-visible artifact.',
    '',
    '## Machine receipt',
    '',
    '```json',
    stableReceipt(intent).trimEnd(),
    '```',
    '',
    'This command was created by the static Sideways Maker phone surface. It grants no merge, deploy, credential, spending, or external communication authority.'
  ].join('\n');
}

export function buildIssueUrl(input = {}) {
  const intent = normalizeIntent(input);
  if (!intent.request) throw new Error('A founder request is required.');
  if (hasSecretLikeMaterial(intent)) throw new Error('Secret-like material must be removed before creating a public issue.');
  const url = new URL(`https://github.com/${REPOSITORY}/issues/new`);
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
      } catch {
        return false;
      }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    }
  });
}

export function normalizeRepositoryState(commitPayload = {}, issuesPayload = []) {
  const issues = Array.isArray(issuesPayload) ? issuesPayload : [];
  const openPullRequests = issues.filter(item => item?.pull_request).length;
  const openIssues = issues.length - openPullRequests;
  return {
    repository: REPOSITORY,
    head: typeof commitPayload?.sha === 'string' ? commitPayload.sha : null,
    short_head: typeof commitPayload?.sha === 'string' ? commitPayload.sha.slice(0, 12) : 'unknown',
    open_issues: Math.max(0, openIssues),
    open_pull_requests: Math.max(0, openPullRequests),
    active: issues.slice(0, 8).map(item => ({
      number: Number(item?.number) || 0,
      title: clean(item?.title, 240),
      kind: item?.pull_request ? 'pull_request' : 'issue',
      url: typeof item?.html_url === 'string' ? item.html_url : null
    }))
  };
}

export async function fetchRepositoryState(fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json' };
  const [commitResponse, issuesResponse] = await Promise.all([
    fetchImpl(`https://api.github.com/repos/${REPOSITORY}/commits/main`, { headers, cache: 'no-store' }),
    fetchImpl(`https://api.github.com/repos/${REPOSITORY}/issues?state=open&per_page=100`, { headers, cache: 'no-store' })
  ]);
  if (!commitResponse?.ok) throw new Error(`main state unavailable (${commitResponse?.status || 'network'})`);
  if (!issuesResponse?.ok) throw new Error(`open work unavailable (${issuesResponse?.status || 'network'})`);
  return normalizeRepositoryState(await commitResponse.json(), await issuesResponse.json());
}

export function mountMakerConsole(doc = document, storage = localStorage, fetchImpl = fetch) {
  const persistence = createDraftStorage(storage);
  let intent = persistence.load();

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

  const renderIntent = () => {
    if (request && request.value !== intent.request) request.value = intent.request;
    if (protect && protect.value !== intent.protect) protect.value = intent.protect;
    if (proof && proof.value !== intent.proof) proof.value = intent.proof;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === intent.mode));
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
    setCommandStatus(saved ? 'Draft saved on this phone.' : 'Phone storage is blocked. Keep this tab open or copy the receipt.');
    renderIntent();
  };

  const readForm = () => normalizeIntent({
    ...intent,
    request: request?.value,
    protect: protect?.value,
    proof: proof?.value
  });

  for (const field of [request, protect, proof]) field?.addEventListener('input', () => commit(readForm()));
  for (const button of modeButtons) button.addEventListener('click', () => commit({ ...readForm(), mode: button.dataset.mode }));

  send?.addEventListener('click', event => {
    if (!send.href || send.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      setCommandStatus(intent.request ? 'Remove secret-like material before sending.' : 'Tell the machine what should exist first.');
    } else {
      setCommandStatus('Opening GitHub with the command prefilled. Tap Submit there.');
    }
  });

  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(stableReceipt(intent));
      setCommandStatus('Receipt copied.');
    } catch {
      setCommandStatus('Clipboard unavailable. Select the receipt text below.');
    }
  });

  doc.querySelector('#reset-maker')?.addEventListener('click', () => {
    const cleared = persistence.clear();
    intent = normalizeIntent();
    setCommandStatus(cleared ? 'Draft cleared.' : 'Draft cleared in this tab; phone storage could not be changed.');
    renderIntent();
  });

  const renderState = state => {
    const head = doc.querySelector('#repo-head');
    const issues = doc.querySelector('#open-issues');
    const prs = doc.querySelector('#open-prs');
    const work = doc.querySelector('#active-work');
    if (head) head.textContent = state.short_head;
    if (issues) issues.textContent = String(state.open_issues);
    if (prs) prs.textContent = String(state.open_pull_requests);
    if (work) {
      work.replaceChildren(...state.active.slice(0, 4).map(item => {
        const link = doc.createElement('a');
        link.textContent = `#${item.number} ${item.title}`;
        link.href = item.url || `https://github.com/${REPOSITORY}/${item.kind === 'pull_request' ? 'pull' : 'issues'}/${item.number}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        return link;
      }));
    }
    setStateStatus(`Live public state loaded from ${state.repository}.`);
  };

  const refreshState = async () => {
    setStateStatus(navigator.onLine === false ? 'Offline. Drafting still works; live repository state cannot refresh.' : 'Reading public repository state…');
    try { renderState(await fetchRepositoryState(fetchImpl)); }
    catch (error) { setStateStatus(`Live state unavailable. Drafting still works. ${error.message}`); }
  };

  doc.querySelector('#refresh-state')?.addEventListener('click', refreshState);
  globalThis.addEventListener?.('offline', () => setStateStatus('Offline. Drafting still works; sending waits for a connection.'));
  globalThis.addEventListener?.('online', refreshState);

  renderIntent();
  refreshState();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  return Object.freeze({ getIntent: () => normalizeIntent(intent), refreshState });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountMakerConsole();

export const TURN_VERSION = 'human-founder-turn/v2';
export const STORAGE_KEY = 'archie:founder:human-turn';
export const SHARED_TASK_KEY = 'archie:shared-task:v2';
export const BRANCH_LENSES = Object.freeze([
  {
    id: 'literal-artifact',
    title: 'Build the thing literally',
    prompt: 'What is the strongest complete artifact directly implied by the intention?'
  },
  {
    id: 'premise-inversion',
    title: 'Assume the premise is backward',
    prompt: 'What becomes possible if the obvious product assumption is rejected?'
  },
  {
    id: 'missing-capability',
    title: 'Invent the missing faculty',
    prompt: 'What reusable capability would solve this and many unrelated problems?'
  },
  {
    id: 'real-investigation',
    title: 'Investigate before designing',
    prompt: 'What external evidence could reveal a different or more consequential objective?'
  },
  {
    id: 'alien-transfer',
    title: 'Import a non-software form',
    prompt: 'What ritual, craft, institution, game, performance, or physical object should shape the result?'
  },
  {
    id: 'unexpected-output',
    title: 'Return something other than an answer',
    prompt: 'What finished site, application, experiment, media object, system, or event should exist when the turn ends?'
  }
]);

function clean(value, limit = 1800) {
  return String(value || '').trim().slice(0, limit);
}

export function deriveBranches(intention = '') {
  const source = clean(intention) || 'an unfinished intention';
  return BRANCH_LENSES.map((lens, index) => ({
    id: lens.id,
    title: lens.title,
    proposition: `${lens.prompt} Begin from “${source},” but do not preserve its framing merely to sound agreeable.`,
    probability_state: 'open',
    order: index + 1
  }));
}

export function normalizeTurn(input = {}) {
  const intention = clean(input.intention);
  const branches = Array.isArray(input.branches)
    ? input.branches.slice(0, BRANCH_LENSES.length).map((branch, index) => ({
        id: BRANCH_LENSES.some(lens => lens.id === branch?.id) ? branch.id : BRANCH_LENSES[index]?.id,
        title: clean(branch?.title, 120) || BRANCH_LENSES[index]?.title,
        proposition: clean(branch?.proposition, 700),
        probability_state: branch?.probability_state === 'selected' ? 'selected' : 'open',
        order: index + 1
      })).filter(branch => branch.id && branch.proposition)
    : [];
  const selected = clean(input.selected_branch, 80);
  const selectedBranch = branches.some(branch => branch.id === selected) ? selected : '';
  return {
    schema: TURN_VERSION,
    intention,
    branches: branches.map(branch => ({
      ...branch,
      probability_state: branch.id === selectedBranch ? 'selected' : 'open'
    })),
    selected_branch: selectedBranch,
    push_state: input.push_state === 'pushed-objective-only' ? 'pushed-objective-only' : 'open',
    authority_state: 'not-granted',
    execution_claim: 'none',
    user_workflow_requires_git: false,
    mirror_response_is_completion: false
  };
}

export function openProbabilityField(input = {}) {
  const intention = clean(input.intention);
  return normalizeTurn({
    intention,
    branches: deriveBranches(intention),
    selected_branch: '',
    push_state: 'open'
  });
}

export function selectBranch(input, branchId) {
  const turn = normalizeTurn(input);
  if (!turn.branches.some(branch => branch.id === branchId)) return turn;
  return normalizeTurn({ ...turn, selected_branch: branchId, push_state: 'open' });
}

export function pushTurn(input = {}) {
  const turn = normalizeTurn(input);
  if (!turn.intention || !turn.selected_branch) return turn;
  return normalizeTurn({ ...turn, push_state: 'pushed-objective-only' });
}

export function selectedObjective(input = {}) {
  const turn = normalizeTurn(input);
  const branch = turn.branches.find(item => item.id === turn.selected_branch);
  if (!turn.intention || !branch) return '';
  return clean(`${branch.title}. ${branch.proposition}`, 12000);
}

export function stableReceipt(input = {}) {
  return `${JSON.stringify(normalizeTurn(input), null, 2)}\n`;
}

export function summarizeTurn(input = {}) {
  const turn = normalizeTurn(input);
  if (!turn.intention) return 'Nothing has been interpreted yet.';
  if (!turn.branches.length) return 'The intention exists, but the probability field is still closed.';
  if (!turn.selected_branch) return `${turn.branches.length} branches remain open. Select one only when you are ready to push.`;
  const branch = turn.branches.find(item => item.id === turn.selected_branch);
  if (turn.push_state === 'pushed-objective-only') return `Objective pushed through “${branch?.title || turn.selected_branch}.” No execution authority has been granted.`;
  return `Selected “${branch?.title || turn.selected_branch}.” The other branches remain preserved until push.`;
}

export function createTurnStorage(storage) {
  return Object.freeze({
    load() {
      try { return normalizeTurn(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')); }
      catch { return normalizeTurn(); }
    },
    save(turn) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeTurn(turn)));
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

export function handoffSelectedObjective(storage, input = {}, clock = () => new Date()) {
  const turn = normalizeTurn(input);
  const text = selectedObjective(turn);
  if (!text || turn.push_state !== 'pushed-objective-only') return false;
  const createdAt = clock().toISOString();
  const shared = { schema: 'archie-shared-task/v2', text, route: 'maker', created_at: createdAt, source: 'founder-selected-direction' };
  const maker = { repository: 'Pokitomas/theawesomehexapp', base_revision: 'main', backend: 'auto', mode: 'build', request: text, protect: '', proof: '' };
  const archie = { objective: text, project: '', base: '', protected: '', proof: '', authorities: ['read', 'research'] };
  try {
    storage?.setItem(SHARED_TASK_KEY, JSON.stringify(shared));
    storage?.setItem('maker:engineering:task:v2', JSON.stringify(maker));
    storage?.setItem('archie:knowledge-utility:v2', JSON.stringify(archie));
    return true;
  } catch {
    return false;
  }
}

function downloadReceipt(doc, receipt) {
  const blob = new Blob([receipt], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = 'founder-human-turn.json';
  link.click();
  URL.revokeObjectURL(href);
}

export function mountFounder(doc = document, storage = localStorage) {
  const persistence = createTurnStorage(storage);
  let turn = persistence.load();
  const intention = doc.querySelector('#founder-intention');
  const field = doc.querySelector('#branch-field');
  const branchCount = doc.querySelector('#branch-count');
  const status = doc.querySelector('#room-status');
  const preview = doc.querySelector('#turn-preview');

  const setStatus = message => { if (status) status.textContent = message; };

  const render = () => {
    if (intention && intention.value !== turn.intention) intention.value = turn.intention;
    if (branchCount) branchCount.textContent = `${turn.branches.length} live branches`;
    if (field) {
      field.replaceChildren();
      if (!turn.branches.length) {
        const empty = doc.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Your directions will appear here.';
        field.append(empty);
      } else {
        for (const branch of turn.branches) {
          const article = doc.createElement('article');
          article.className = 'branch';
          article.dataset.branch = branch.id;
          article.setAttribute('aria-pressed', String(turn.selected_branch === branch.id));
          const button = doc.createElement('button');
          button.type = 'button';
          button.dataset.selectBranch = branch.id;
          const label = doc.createElement('b');
          label.textContent = `${String(branch.order).padStart(2, '0')} / ${branch.id}`;
          const title = doc.createElement('h3');
          title.textContent = branch.title;
          const proposition = doc.createElement('p');
          proposition.textContent = branch.proposition;
          button.append(label, title, proposition);
          article.append(button);
          field.append(article);
        }
      }
    }
    if (preview) preview.textContent = turn.intention ? stableReceipt(turn) : 'No turn receipt yet.';
    setStatus(summarizeTurn(turn));
  };

  const commit = next => {
    turn = normalizeTurn(next);
    persistence.save(turn);
    render();
  };

  doc.querySelector('#open-field')?.addEventListener('click', () => {
    const raw = clean(intention?.value);
    if (!raw) {
      setStatus('Say the unfinished thing first. Bad wording is allowed.');
      intention?.focus();
      return;
    }
    commit(openProbabilityField({ intention: raw }));
  });

  field?.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-select-branch]') : null;
    if (!target) return;
    commit(selectBranch(turn, target.dataset.selectBranch));
  });

  doc.querySelector('#push-turn')?.addEventListener('click', () => {
    const pushed = pushTurn(turn);
    if (pushed.push_state !== 'pushed-objective-only') {
      setStatus(turn.branches.length ? 'Select one direction before using it. The others will remain preserved.' : 'Show different directions first.');
      return;
    }
    commit(pushed);
    if (!handoffSelectedObjective(storage, pushed)) setStatus(`${summarizeTurn(pushed)} Shared handoff could not be stored on this device.`);
  });

  doc.querySelector('#copy-receipt')?.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(stableReceipt(turn));
      setStatus('Turn receipt copied. This is an objective packet, not proof of execution.');
    } catch {
      setStatus('Clipboard unavailable. Use Download JSON instead.');
    }
  });

  doc.querySelector('#download-receipt')?.addEventListener('click', () => {
    downloadReceipt(doc, stableReceipt(turn));
    setStatus('Turn receipt downloaded.');
  });

  doc.querySelector('#reset-room')?.addEventListener('click', () => {
    persistence.clear();
    turn = normalizeTurn();
    render();
  });

  render();
  return Object.freeze({ getTurn: () => normalizeTurn(turn) });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountFounder();

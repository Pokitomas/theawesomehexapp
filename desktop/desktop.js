const TASK_KEY = 'archie:shared-task:v2';
const ROUTES = Object.freeze({
  archie: '../archie/',
  maker: '../maker/',
  founder: '../founder/',
  foundry: '../foundry/'
});
const LABELS = Object.freeze({ archie: 'Answer', maker: 'Build', founder: 'Explore', foundry: 'Research' });

function clean(value, limit = 12000) {
  return String(value || '').trim().slice(0, limit);
}

function loadTask() {
  try { return JSON.parse(localStorage.getItem(TASK_KEY) || '{}'); }
  catch { return {}; }
}

function inferRoute(text) {
  const value = clean(text).toLowerCase();
  if (/\b(build|make|create|draw|design|generate|ship|code|app|site|website|image|picture|video|audio|fix|repair|repo|repository|deploy)\b/.test(value)) return 'maker';
  if (/\b(research|investigate|compare|evidence|benchmark|experiment|evaluate|why did|what caused|test whether)\b/.test(value)) return 'foundry';
  if (/\b(brainstorm|explore|directions|possibilities|ideas|rethink|what else|different concepts)\b/.test(value)) return 'founder';
  return 'archie';
}

function routeDraft(route, text) {
  if (route === 'archie') {
    localStorage.setItem('archie:knowledge-utility:v2', JSON.stringify({ objective: text, project: '', base: '', protected: '', proof: '', authorities: ['read', 'research'] }));
  } else if (route === 'maker') {
    localStorage.setItem('maker:engineering:task:v2', JSON.stringify({ repository: 'Pokitomas/theawesomehexapp', base_revision: 'main', backend: 'auto', mode: 'build', request: text, protect: '', proof: '' }));
  } else if (route === 'founder') {
    localStorage.setItem('archie:founder:human-turn', JSON.stringify({ intention: text, branches: [], selected_branch: '', push_state: 'open' }));
  } else if (route === 'foundry') {
    localStorage.setItem('archie:human-foundry:campaign', JSON.stringify({ objective: text, subsidy: 'massive', candidate_count: 24, lanes: ['models', 'tools', 'embodiment', 'evaluation', 'alien'], candidates: [] }));
  }
}

function saveTask(text, route) {
  const task = { schema: 'archie-shared-task/v2', text: clean(text), route, created_at: new Date().toISOString() };
  localStorage.setItem(TASK_KEY, JSON.stringify(task));
  routeDraft(route, task.text);
  return task;
}

function updateSharedTask(text, route) {
  const prior = loadTask();
  const next = {
    schema: 'archie-shared-task/v2',
    text: clean(text),
    route,
    created_at: prior.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: prior.source || 'shared-progressive-view'
  };
  localStorage.setItem(TASK_KEY, JSON.stringify(next));
  return next;
}

function routeHref(route) {
  const href = ROUTES[route] || ROUTES.archie;
  const atRoot = !/\/desktop\/$/.test(location.pathname) && !/\/(?:archie|maker|founder|foundry|world-expo)\//.test(location.pathname);
  return atRoot ? href.replace('../', './') : href;
}

function describe(route) {
  return route === 'maker'
    ? 'Build: Archie will carry the request into the workbench and reveal repository or permission fields only when needed.'
    : route === 'foundry'
      ? 'Research: Archie will preserve several serious approaches and keep the evidence boundary visible.'
      : route === 'founder'
        ? 'Explore: Archie will open genuinely different directions before committing to one.'
        : 'Answer: Archie will shape one request and keep optional proof and authority details collapsed.';
}

const form = document.querySelector('#universal-form');
const input = document.querySelector('#universal-task');
const preview = document.querySelector('#route-preview');
let selectedRoute = 'auto';

function updatePreview() {
  if (!preview) return;
  const route = selectedRoute === 'auto' ? inferRoute(input?.value) : selectedRoute;
  preview.textContent = input?.value.trim() ? describe(route) : 'Archie will choose the smallest workflow that can actually finish the request.';
}

document.querySelectorAll('[data-route]').forEach(button => {
  button.addEventListener('click', () => {
    selectedRoute = button.dataset.route || 'auto';
    document.querySelectorAll('[data-route]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updatePreview();
  });
});

input?.addEventListener('input', updatePreview);
form?.addEventListener('submit', event => {
  event.preventDefault();
  const text = clean(input?.value);
  if (!text) {
    preview.textContent = 'Say what should happen first. Bad wording is fine.';
    input?.focus();
    return;
  }
  const route = selectedRoute === 'auto' ? inferRoute(text) : selectedRoute;
  saveTask(text, route);
  preview.textContent = `${LABELS[route]} selected. Opening the smallest useful view…`;
  location.href = routeHref(route);
});

const task = loadTask();
if (input && !input.value && task.text) input.value = task.text;
updatePreview();

const currentTask = document.querySelector('#current-task');
if (currentTask) currentTask.textContent = task.text || 'No shared task yet. Start from Home or type below.';

const fieldBySurface = {
  archie: '#objective',
  maker: '#maker-request',
  founder: '#founder-intention',
  foundry: '#research-objective'
};
const surface = document.body?.dataset.surface;
const target = surface ? document.querySelector(fieldBySurface[surface]) : null;
if (target && surface) {
  target.addEventListener('input', () => {
    const next = updateSharedTask(target.value, surface);
    if (currentTask) currentTask.textContent = next.text || 'No shared task yet. Start from Home or type below.';
  });
  if (task.text && !target.value.trim()) {
    target.value = task.text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

if (surface === 'maker') {
  import('../maker/runtime-receipt.js').catch(error => {
    const status = document.querySelector('#archie-status');
    if (status) status.textContent = `Runtime receipt controls unavailable: ${clean(error?.message, 240)} No runtime fact was admitted.`;
  });
}

document.querySelectorAll('[data-clear-shared-task]').forEach(button => button.addEventListener('click', () => {
  localStorage.removeItem(TASK_KEY);
  if (currentTask) currentTask.textContent = 'No shared task yet. Start from Home or type below.';
}));

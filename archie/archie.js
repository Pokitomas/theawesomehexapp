const STORAGE_KEY = 'archie-personal-operator/v4';
const LEGACY_KEY = 'archie-personal-operator/v3';
const MAX_HISTORY = 30;
const MODEL_SHA256 = '202a6957bd0bbf0a9b4e92cd74014b2b9689393be539de8f5ab44f567a691916';
const $ = id => document.getElementById(id);
const clean = value => String(value || '').replace(/\r/g, '').trim();
const compact = value => clean(value).replace(/\s+/g, ' ');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function loadState() {
  for (const key of [STORAGE_KEY, LEGACY_KEY]) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      if (parsed && typeof parsed === 'object') {
        return {
          history: Array.isArray(parsed.history) ? parsed.history : [],
          activeObjective: typeof parsed.activeObjective === 'string' ? parsed.activeObjective : ''
        };
      }
    } catch {}
  }
  return { history: [], activeObjective: '' };
}

const state = loadState();
let neuralRouter = null;
let modelReady = null;
let currentResult = null;
let attachments = [];
const mindReady = import('./mind-core.mjs');

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function digest(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function fnv1a(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function neuralFeatures(text, dimension) {
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  const features = words.map(word => `w:${word}`);
  for (let index = 0; index < words.length - 1; index += 1) features.push(`b:${words[index]}_${words[index + 1]}`);
  const joined = words.join(' ');
  for (let index = 0; index < Math.max(0, joined.length - 2); index += 1) features.push(`c:${joined.slice(index, index + 3)}`);
  const counts = new Map();
  for (const feature of features) {
    const index = fnv1a(feature) % dimension;
    counts.set(index, (counts.get(index) || 0) + 1);
  }
  let norm = 0;
  const values = [];
  for (const [index, count] of counts) {
    const value = Math.log1p(count);
    norm += value * value;
    values.push([index, value]);
  }
  norm = Math.sqrt(norm) || 1;
  return values.map(([index, value]) => [index, value / norm]);
}

function decodeWeights(value) {
  const binary = atob(value);
  const output = new Int8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    const byte = binary.charCodeAt(index);
    output[index] = byte > 127 ? byte - 256 : byte;
  }
  return output;
}

async function loadNeuralRouter() {
  try {
    const response = await fetch('./router-model.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const observed = await sha256(text);
    if (observed !== MODEL_SHA256) throw new Error('digest mismatch');
    const model = JSON.parse(text);
    if (model.schema !== 'archie-local-neural-router/v1' || model.model_id !== 'archie-router-bytehash-perceptron-v1') throw new Error('manifest mismatch');
    const weights = decodeWeights(model.weights_base64);
    const classes = model.classes.length;
    if (weights.length !== model.feature_dim * classes) throw new Error('weight shape mismatch');
    neuralRouter = { ...model, weights, digest: observed };
    $('modelState').textContent = 'Admitted local neural router verified.';
    $('modelDetail').textContent = 'The trained router proposes a task mode; the local language core checks order, negation, context, files, and authority before responding.';
    return true;
  } catch (error) {
    neuralRouter = null;
    $('modelState').textContent = 'Neural router unavailable.';
    $('modelDetail').textContent = 'Archie is using its local language core and will not claim neural evidence.';
    return false;
  }
}

function neuralInference(text) {
  if (!neuralRouter) return null;
  const model = neuralRouter;
  const classes = model.classes.length;
  const scores = model.bias.slice();
  for (const [index, value] of neuralFeatures(text, model.feature_dim)) {
    const offset = index * classes;
    for (let classIndex = 0; classIndex < classes; classIndex += 1) scores[classIndex] += model.weights[offset + classIndex] * model.scales[classIndex] * value;
  }
  const ranked = scores.map((score, index) => ({ score, index, route: model.classes[index] })).sort((left, right) => right.score - left.score);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const margin = winner.score - runnerUp.score;
  const maximum = winner.score;
  const exponentials = ranked.map(item => Math.exp(item.score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0) || 1;
  const alternatives = ranked.slice(0, 4).map((item, index) => ({ route: item.route, confidence: exponentials[index] / total }));
  return {
    mode: winner.route,
    route: winner.route,
    confidence: alternatives[0].confidence,
    margin,
    admitted: margin >= model.margin_threshold,
    alternatives,
    model_id: model.model_id,
    model_sha256: model.digest
  };
}

function truthfulModelCandidate(text) {
  const inference = neuralInference(text);
  if (!inference) return { mode: null, route: null, confidence: 0, alternatives: [], admitted: false };
  if (inference.admitted) return inference;
  return { ...inference, mode: null, route: null };
}

function objectiveFromRequest(request) {
  return compact(request)
    .replace(/^(?:please\s+)?(?:archie[, :]*)?/i, '')
    .replace(/^(?:track|save|remember|make|set)\s+(?:this\s+)?(?:as\s+)?(?:my\s+)?(?:active\s+)?(?:objective|goal)\s*:?[\s-]*/i, '')
    .replace(/[.!?]+$/, '');
}

function resultReceipt(result) {
  const model = result.neural_evidence
    ? `verified neural candidate · ${result.model_id} · margin ${result.neural_margin.toFixed(3)}`
    : 'neural_evidence: false';
  const context = result.analysis?.context_used ? ` · context ${result.analysis.context_used}` : '';
  const files = result.analysis?.attachment_count ? ` · ${result.analysis.attachment_count} local file${result.analysis.attachment_count === 1 ? '' : 's'}` : '';
  const boundary = result.analysis?.authority_boundary ? ` · boundary ${result.analysis.authority_boundary}` : '';
  return `${model} · route ${result.route_source} · local language core · ${result.protocol.join('›')}${context}${files}${boundary} · receipt ${result.digest}`;
}

function show(result) {
  currentResult = result;
  $('modeLabel').textContent = result.title || result.mode;
  $('answer').textContent = result.response;
  $('receipt').textContent = resultReceipt(result);
  $('result').classList.add('open');
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function ask() {
  const request = clean($('prompt').value);
  if (!request) return $('prompt').focus();
  $('ask').disabled = true;
  try {
    const [, mind] = await Promise.all([modelReady, mindReady]);
    const candidate = truthfulModelCandidate(request);
    const composed = mind.composeLocalResponse(request, candidate, {
      history: state.history.slice(0, 5),
      activeObjective: state.activeObjective,
      attachments
    });
    if (composed.mode === 'objective') {
      state.activeObjective = objectiveFromRequest(request);
    }
    const result = {
      request,
      response: composed.response,
      mode: composed.mode,
      title: composed.title,
      protocol: composed.protocol,
      route_source: composed.route_source,
      analysis: composed.analysis,
      timestamp: new Date().toISOString(),
      digest: digest(`${composed.mode}\n${request}\n${composed.response}\n${composed.route_source}`),
      neural_evidence: Boolean(candidate.admitted),
      model_id: candidate.admitted ? candidate.model_id : null,
      model_sha256: candidate.admitted ? candidate.model_sha256 : null,
      neural_margin: candidate.admitted ? candidate.margin : null,
      response_generation: 'deterministic-context-language-core',
      attachment_names: attachments.map(file => file.name)
    };
    state.history.unshift(result);
    state.history = state.history.slice(0, MAX_HISTORY);
    saveState();
    show(result);
    render();
  } finally {
    $('ask').disabled = false;
  }
}

function render() {
  const objective = clean(state.activeObjective);
  $('objective').classList.toggle('open', Boolean(objective));
  $('objectiveText').textContent = objective;
  $('count').textContent = `${state.history.length} saved`;
  $('clearHistory').hidden = !state.history.length;
  if (!state.history.length) {
    $('items').innerHTML = '<div class="empty"><strong>Archie is new.</strong> There are no users, shared projects, or community activity here yet. Your work stays on this device.</div>';
    return;
  }
  $('items').innerHTML = state.history.map((item, index) => {
    const context = item.analysis?.context_used ? ` · ${escapeHtml(item.analysis.context_used)}` : '';
    const files = item.analysis?.attachment_count ? ` · ${item.analysis.attachment_count} file${item.analysis.attachment_count === 1 ? '' : 's'}` : '';
    return `<article class="history-item"><h3>${escapeHtml(item.request)}</h3><div class="history-meta">${escapeHtml(item.title || item.mode)} · ${escapeHtml(new Date(item.timestamp).toLocaleString())} · ${item.neural_evidence ? 'neural candidate' : 'language core'}${context}${files} · ${escapeHtml(item.digest)}</div><p class="history-preview">${escapeHtml(item.response.length > 180 ? `${item.response.slice(0, 177)}…` : item.response)}</p><button class="history-open" type="button" data-history-index="${index}">Open result</button></article>`;
  }).join('');
}

function addButton(id, label, title) {
  const button = document.createElement('button');
  button.className = 'win-button';
  button.id = id;
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  return button;
}

function setupVoice() {
  const row = document.querySelector('.button-row');
  const recognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recognitionClass) {
    const mic = addButton('voiceInput', 'Speak', 'Dictate a request');
    row.insertBefore(mic, $('clearPrompt'));
    const recognition = new recognitionClass();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    let base = '';
    recognition.onstart = () => {
      base = clean($('prompt').value);
      mic.textContent = 'Listening…';
      mic.setAttribute('aria-pressed', 'true');
    };
    recognition.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join(' ');
      $('prompt').value = [base, transcript].filter(Boolean).join(base ? ' ' : '');
    };
    recognition.onerror = () => {
      mic.textContent = 'Speak';
      mic.setAttribute('aria-pressed', 'false');
    };
    recognition.onend = () => {
      mic.textContent = 'Speak';
      mic.setAttribute('aria-pressed', 'false');
      $('prompt').focus();
    };
    mic.addEventListener('click', () => {
      try { recognition.start(); } catch { recognition.stop(); }
    });
  }

  if ('speechSynthesis' in window) {
    const receiptRow = document.querySelector('.receipt-row');
    const speak = addButton('voiceOutput', 'Read aloud', 'Read the result aloud');
    receiptRow.appendChild(speak);
    speak.addEventListener('click', () => {
      if (!currentResult) return;
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(currentResult.response);
      utterance.rate = 1.02;
      utterance.pitch = 0.96;
      speechSynthesis.speak(utterance);
    });
  }
}

function isReadableTextFile(file) {
  if (file.type.startsWith('text/')) return true;
  return /\.(?:txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|toml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|rb|php|java|c|cc|cpp|h|hpp|swift|kt|go|rs|sh|sql)$/i.test(file.name);
}

function setupAttachments() {
  const row = document.querySelector('.button-row');
  const attach = addButton('attachFiles', 'Attach', 'Attach local files; readable text stays on this device');
  row.insertBefore(attach, $('clearPrompt'));
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  document.body.appendChild(input);
  attach.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files].slice(0, 5);
    attachments = await Promise.all(files.map(async file => ({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      text: isReadableTextFile(file) ? await file.slice(0, 32000).text() : ''
    })));
    attach.textContent = attachments.length ? `Attach (${attachments.length})` : 'Attach';
    attach.title = attachments.length ? attachments.map(file => file.name).join(', ') : 'Attach local files';
  });
}

function updateTruthStrip() {
  const strip = document.querySelector('.truth-strip');
  if (strip) strip.innerHTML = '<strong>Actual runtime:</strong> admitted local neural router for task selection; deterministic context-aware language core for order, multiple outcomes, negation, local thread memory, attachment text, abstention, and authority boundaries; browser voice when supported; saved only on this phone.';
}

document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
  $('prompt').value = button.dataset.example;
  $('prompt').focus();
  $('prompt').setSelectionRange($('prompt').value.length, $('prompt').value.length);
}));
$('ask').addEventListener('click', () => ask().catch(error => {
  console.error(error);
  $('modelDetail').textContent = 'The local language core hit an error and did not claim a result.';
}));
$('clearPrompt').addEventListener('click', () => {
  $('prompt').value = '';
  attachments = [];
  const attach = $('attachFiles');
  if (attach) attach.textContent = 'Attach';
  $('prompt').focus();
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('answer').textContent);
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy result'; }, 1200);
  } catch {
    $('copy').textContent = 'Copy unavailable';
  }
});
$('clearObjective').addEventListener('click', () => {
  state.activeObjective = '';
  saveState();
  render();
});
$('clearHistory').addEventListener('click', () => {
  state.history = [];
  saveState();
  $('result').classList.remove('open');
  render();
});
$('items').addEventListener('click', event => {
  const button = event.target.closest('[data-history-index]');
  const item = button ? state.history[Number(button.dataset.historyIndex)] : null;
  if (item) show(item);
});
$('prompt').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ask();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

setupVoice();
setupAttachments();
updateTruthStrip();
modelReady = loadNeuralRouter();
render();

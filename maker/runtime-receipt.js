const $ = id => document.getElementById(id);
const storageKey = 'maker:archie:receipt:v1';
const clean = (value, limit = 2000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : stable(value))));
const secretKey = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|session)(?:$|[_-])/i;
const secretText = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})\b/i;

function assertSafe(value, depth = 0) {
  if (depth > 30) throw new Error('Receipt nesting exceeds browser limit.');
  if (Array.isArray(value)) return value.forEach(item => assertSafe(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && secretText.test(value)) throw new Error('Secret-like material rejected.');
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key) && child !== null && child !== '' && child !== '[redacted]') throw new Error('Unredacted secret-like field rejected.');
    assertSafe(child, depth + 1);
  }
}

const set = (id, value) => {
  const node = $(id);
  if (node) node.textContent = clean(value || 'Unobserved', 1200);
};

function empty() {
  for (const id of ['archie-sparse', 'archie-planner', 'archie-confidence', 'archie-route', 'archie-budget', 'archie-teacher', 'archie-learning', 'archie-corpus', 'archie-sync', 'archie-compute', 'archie-usage', 'archie-storage']) set(id, 'Unobserved');
  set('archie-source', 'None');
  $('archie-blockers')?.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No authenticated runtime receipt loaded.' }));
}

async function verify(receipt) {
  assertSafe(receipt);
  if (receipt?.schema !== 'archie-operator-runtime-receipt/v1' || receipt.namespace !== 'maker:archie') throw new Error('Unsupported receipt or namespace.');
  if (await digest(receipt.payload) !== receipt.payload_digest) throw new Error('Payload digest mismatch.');
  const { receipt_digest, ...body } = receipt;
  if (await digest(body) !== receipt_digest) throw new Error('Receipt digest mismatch.');
  const observed = Date.parse(receipt.observed_at);
  const expires = Date.parse(receipt.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > Date.now() + 30000) throw new Error('Receipt observation time is invalid.');
  if (expires <= Date.now()) throw new Error('Receipt is stale.');
  return receipt;
}

function render(receipt) {
  const payload = receipt.payload || {};
  const route = payload.route || {};
  const budget = payload.budget || {};
  const teacher = payload.teacher || {};
  const learning = payload.learning || {};
  const corpus = payload.corpus || {};
  const sync = payload.sync || {};
  const compute = payload.compute || {};
  set('archie-sparse', route.sparse);
  set('archie-planner', route.planner);
  set('archie-confidence', Number.isFinite(Number(route.confidence)) ? `${route.confidence} / ${Number.isFinite(Number(route.margin)) ? route.margin : '—'}` : 'Unobserved');
  set('archie-route', route.selected);
  set('archie-budget', `${budget.decision || 'Unobserved'} · ${Number.isFinite(Number(budget.charged_credits)) ? `${budget.charged_credits} credits` : 'cost unobserved'}`);
  set('archie-teacher', `${teacher.state || 'Unobserved'} · ${teacher.reason || 'no observed reason'}`);
  set('archie-learning', `${learning.lesson || 'Unobserved'} / ${learning.retraining || 'Unobserved'}`);
  set('archie-corpus', `${corpus.health || 'Unobserved'} / ${corpus.pack || 'Unobserved'}`);
  set('archie-sync', `${sync.state || 'Unobserved'}${sync.error ? ` · ${sync.error}` : ''} · generation ${Number.isSafeInteger(sync.generation) ? sync.generation : 'unobserved'} · relay plaintext authority: none`);
  const ladder = Array.isArray(compute.ladder) ? compute.ladder.map(item => `${item.kind || 'unknown'}:${item.state || 'unobserved'}`).join(' · ') : '';
  set('archie-compute', ladder || `${compute.selected || 'Unobserved'} · Linux ${compute.linux || 'unavailable until observed'} · GPU ${compute.gpu || 'unavailable until observed'}`);
  set('archie-usage', `${budget.usage_evidence || 'Unobserved'} · ${Number.isFinite(Number(budget.charged_credits)) ? `${budget.charged_credits} credits` : 'cost unobserved'}`);
  set('archie-storage', compute.storage || 'Unobserved');
  const blockers = Array.isArray(payload.blockers) && payload.blockers.length ? payload.blockers : ['No external blocker reported by this receipt.'];
  $('archie-blockers')?.replaceChildren(...blockers.slice(0, 30).map(item => Object.assign(document.createElement('li'), { textContent: clean(item, 500) })));
  set('archie-source', `${receipt.source} · observed ${receipt.observed_at} · expires ${receipt.expires_at}`);
}

async function apply(raw) {
  const parsed = JSON.parse(raw);
  const receipt = await verify(parsed);
  render(receipt);
  try {
    localStorage.setItem(storageKey, JSON.stringify(receipt));
    set('archie-status', 'Digest-valid receipt applied. Storage contains this receipt only; no runtime action was executed.');
  } catch {
    set('archie-status', 'Digest-valid receipt applied in memory. Storage unavailable; no runtime action was executed.');
  }
}

async function command(operation) {
  const body = { schema: 'archie-operator-command/v1', namespace: 'maker:archie', created_at: new Date().toISOString(), operation, payload: {}, execution_claimed: false, requires_authenticated_runtime: true, requires_explicit_authority: true };
  assertSafe(body);
  const packet = { ...body, command_digest: await digest(body) };
  set('archie-command-preview', JSON.stringify(packet, null, 2));
  set('archie-status', `Command packet exported for ${operation}. It does not claim execution.`);
}

$('archie-apply')?.addEventListener('click', async () => {
  try { await apply($('archie-receipt-input')?.value || ''); }
  catch (error) {
    empty();
    set('archie-status', `Receipt rejected: ${clean(error.message, 400)} No runtime fact was admitted.`);
  }
});
$('archie-receipt-input')?.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    $('archie-apply')?.click();
  }
});
$('archie-export-pack')?.addEventListener('click', () => command('export_pack'));
$('archie-import-pack')?.addEventListener('click', () => command('import_pack'));
$('archie-sync-command')?.addEventListener('click', () => command('sync'));
$('archie-clear')?.addEventListener('click', () => {
  let cleared = false;
  try { localStorage.removeItem(storageKey); cleared = true; } catch {}
  if ($('archie-receipt-input')) $('archie-receipt-input').value = '';
  empty();
  set('archie-status', cleared ? 'Local receipt cleared. No runtime action was executed.' : 'Receipt cleared in memory. Storage unavailable; no runtime action was executed.');
});

empty();
try {
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    if ($('archie-receipt-input')) $('archie-receipt-input').value = stored;
    await apply(stored);
  }
} catch {
  set('archie-status', 'Storage unavailable. Receipt-only cockpit remains usable in memory; no runtime action was executed.');
}

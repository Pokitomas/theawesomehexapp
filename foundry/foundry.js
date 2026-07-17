export const FOUNDRY_VERSION = 'human-foundry-campaign/v1';
export const STORAGE_KEY = 'archie:human-foundry:campaign';

const LENSES = Object.freeze([
  ['capacity', 'What new general faculty would make this easy in unrelated domains?'],
  ['inversion', 'What if the obvious product assumption is exactly backward?'],
  ['operator', 'Can a new tool, planner, memory form, or evaluator create the gain instead of a larger model?'],
  ['embodiment', 'What physical, ambient, visual, sonic, or screenless form changes the problem?'],
  ['adversary', 'What candidate is most likely to expose that the current objective is wrong?'],
  ['transfer', 'What non-software craft, ritual, institution, or scientific method should be imported?'],
  ['minimal', 'What tiny low-resource candidate preserves the essential intelligence?'],
  ['maximal', 'What becomes possible if token and compute scarcity is temporarily ignored?']
]);

function clean(value, limit = 1600) { return String(value || '').trim().slice(0, limit); }

export function normalizeCampaign(input = {}) {
  const count = Math.max(6, Math.min(64, Number(input.candidate_count) || 24));
  const subsidy = ['generous', 'massive', 'maximum'].includes(input.subsidy) ? input.subsidy : 'massive';
  const allowedLanes = ['models', 'tools', 'embodiment', 'evaluation', 'alien'];
  const lanes = [...new Set((Array.isArray(input.lanes) ? input.lanes : allowedLanes).filter(item => allowedLanes.includes(item)))];
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.slice(0, count).map((candidate, index) => ({
        id: `candidate-${String(index + 1).padStart(2, '0')}`,
        lens: clean(candidate?.lens, 40) || LENSES[index % LENSES.length][0],
        proposition: clean(candidate?.proposition, 500)
      })).filter(candidate => candidate.proposition)
    : [];
  return {
    schema: FOUNDRY_VERSION,
    objective: clean(input.objective),
    subsidy,
    candidate_count: count,
    lanes,
    candidates,
    promotion_state: 'blocked-pending-independent-evidence',
    human_operator_required: true,
    ordinary_use_is_training_data: false
  };
}

export function deriveCandidates(objective, count = 24) {
  const source = clean(objective) || 'an unnamed capability';
  const total = Math.max(6, Math.min(64, Number(count) || 24));
  return Array.from({ length: total }, (_, index) => {
    const [lens, question] = LENSES[index % LENSES.length];
    const cycle = Math.floor(index / LENSES.length) + 1;
    return {
      id: `candidate-${String(index + 1).padStart(2, '0')}`,
      lens,
      proposition: `${question} Research cycle ${cycle} begins from “${source}” but is not required to preserve its framing.`
    };
  });
}

export function buildCampaign(input = {}) {
  const normalized = normalizeCampaign(input);
  return normalizeCampaign({ ...normalized, candidates: deriveCandidates(normalized.objective, normalized.candidate_count) });
}
export function stableManifest(input = {}) { return `${JSON.stringify(normalizeCampaign(input), null, 2)}\n`; }

function createStorage(storage) {
  return {
    load() { try { return normalizeCampaign(JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')); } catch { return normalizeCampaign(); } },
    save(campaign) { try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeCampaign(campaign))); return true; } catch { return false; } },
    clear() { try { storage?.removeItem(STORAGE_KEY); return true; } catch { return false; } }
  };
}
function download(doc, campaign) {
  const blob = new Blob([stableManifest(campaign)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = 'human-foundry-campaign.json';
  link.click();
  URL.revokeObjectURL(href);
}

export function mountFoundry(doc = document, storage = localStorage) {
  const persistence = createStorage(storage);
  let campaign = persistence.load();
  const objective = doc.querySelector('#research-objective');
  const subsidy = doc.querySelector('#subsidy');
  const count = doc.querySelector('#candidate-count');
  const countOutput = doc.querySelector('#candidate-output');
  const field = doc.querySelector('#candidate-field');
  const fieldCount = doc.querySelector('#field-count');
  const status = doc.querySelector('#status');
  const preview = doc.querySelector('#manifest-preview');
  const selectedLanes = () => [...doc.querySelectorAll('input[name="lane"]:checked')].map(input => input.value);
  const setStatus = text => { if (status) status.textContent = text; };

  const render = () => {
    if (objective && objective.value !== campaign.objective) objective.value = campaign.objective;
    if (subsidy) subsidy.value = campaign.subsidy;
    if (count) count.value = String(campaign.candidate_count);
    if (countOutput) countOutput.value = String(campaign.candidate_count);
    for (const input of doc.querySelectorAll('input[name="lane"]')) input.checked = campaign.lanes.includes(input.value);
    if (fieldCount) fieldCount.textContent = `${campaign.candidates.length} live branches`;
    if (field) {
      field.replaceChildren();
      if (!campaign.candidates.length) {
        const empty = doc.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'The specimen table is empty. Run the field to derive contradictory branches.';
        field.append(empty);
      } else {
        for (const candidate of campaign.candidates) {
          const row = doc.createElement('article');
          row.className = 'candidate';
          const label = doc.createElement('b');
          label.textContent = `${candidate.id} / ${candidate.lens}`;
          const proposition = doc.createElement('p');
          proposition.textContent = candidate.proposition;
          row.append(label, proposition);
          field.append(row);
        }
      }
    }
    if (preview) preview.textContent = campaign.objective ? stableManifest(campaign) : 'No manifest yet.';
  };

  count?.addEventListener('input', () => { if (countOutput) countOutput.value = count.value; });
  doc.querySelector('#open-field')?.addEventListener('click', () => {
    const raw = clean(objective?.value);
    if (!raw) { setStatus('Enter an objective first. Bad wording is allowed.'); objective?.focus(); return; }
    campaign = buildCampaign({ objective: raw, subsidy: subsidy?.value, candidate_count: count?.value, lanes: selectedLanes() });
    persistence.save(campaign);
    setStatus(`Derived ${campaign.candidates.length} specimens under ${campaign.subsidy} subsidy. No capability has been promoted.`);
    render();
  });
  doc.querySelector('#push-campaign')?.addEventListener('click', async () => {
    if (!campaign.candidates.length) { setStatus('Run the field before copying a campaign manifest.'); return; }
    try { await navigator.clipboard?.writeText(stableManifest(campaign)); setStatus('Manifest copied. This authorizes research planning, not capability promotion.'); }
    catch { setStatus('Manifest is ready in the evidence console. Clipboard access was unavailable.'); }
  });
  doc.querySelector('#download-manifest')?.addEventListener('click', () => {
    if (!campaign.candidates.length) { setStatus('Run the field before saving a campaign.'); return; }
    download(doc, campaign); setStatus('Campaign manifest saved.');
  });
  doc.querySelector('#reset-foundry')?.addEventListener('click', () => {
    persistence.clear(); campaign = normalizeCampaign(); setStatus('Station reset. No campaign exists.'); render();
  });
  doc.querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', () => {
    setStatus(button.dataset.menu === 'help'
      ? 'Help: configure a field, derive specimens, inspect the manifest, then carry it into an admitted research runtime.'
      : `${button.textContent} menu contains no hidden execution command in this prototype.`);
  }));
  render();
  return Object.freeze({ getCampaign: () => normalizeCampaign(campaign) });
}

if (typeof document !== 'undefined' && typeof localStorage !== 'undefined') mountFoundry();

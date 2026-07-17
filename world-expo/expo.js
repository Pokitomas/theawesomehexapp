const state = {
  constitution: null,
  seed: Number(localStorage.getItem('frontier-world-expo-seed') || 466)
};

const palettes = ['#e9ff70', '#ff9b85', '#7bdff2', '#c8a2ff', '#9bea8f', '#ffd166'];
const forms = {
  'familiar-control': ['commission atlas', 'walkable studio index', 'artifact workshop'],
  'assumption-inversion': ['screenless listening procession', 'single evolving object', 'silent spatial score'],
  'eccentric-transfer': ['repair café × radio play', 'shadow theatre × annotated map', 'street procession × woven score'],
  'loser-recombination': ['abandoned dashboard × opaque agent', 'overloaded canvas × sterile feed', 'decorative map × command room'],
  'low-resource-offline': ['one-file neighborhood', 'offline pocket folio', 'local radio notebook'],
  'maximal-expressive-variance': ['mutable relic garden', 'personal weather system', 'house of alternate selves']
};

function random(seed) {
  let value = seed || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function title(value) {
  return value.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function drawRoute() {
  const target = document.querySelector('#candidate-route');
  const roles = state.constitution.round_contract.required_candidate_roles;
  const next = random(state.seed);
  document.querySelector('#route-seed').textContent = String(state.seed).padStart(4, '0');
  target.replaceChildren(...roles.map((role, index) => {
    const ticket = document.createElement('article');
    const options = forms[role];
    const description = options[Math.floor(next() * options.length)];
    const substrates = ['paper', 'sound', 'space', 'gesture', 'memory', 'code'].sort(() => next() - .5).slice(0, 3);
    ticket.className = 'ticket';
    ticket.style.setProperty('--ticket', palettes[index % palettes.length]);
    ticket.style.setProperty('--tilt', `${(next() * 2.4 - 1.2).toFixed(2)}deg`);
    ticket.innerHTML = `<p class="role">${title(role)}</p><h3>${description}</h3><p class="substrates">MATERIALS: ${substrates.join(' / ')}<br>AUTOMATION: ${Math.round((.55 + next() * .27) * 100)}%<br>CLAIM: UNMEASURED</p>`;
    return ticket;
  }));
}

function renderDistricts() {
  const grouped = new Map();
  for (const commission of state.constitution.commissions) {
    const existing = grouped.get(commission.district) || [];
    existing.push(commission);
    grouped.set(commission.district, existing);
  }
  const target = document.querySelector('#districts');
  let number = 1;
  const sections = [];
  for (const [district, commissions] of grouped) {
    const section = document.createElement('section');
    section.className = 'district';
    section.dataset.number = String(number).padStart(2, '0');
    section.style.setProperty('--district', palettes[(number - 1) % palettes.length]);
    section.innerHTML = `<h2>${title(district)}</h2><div class="exhibits"></div>`;
    const exhibits = section.querySelector('.exhibits');
    for (const commission of commissions) {
      const article = document.createElement('article');
      article.className = 'exhibit';
      article.innerHTML = `<div><p class="hidden">${commission.modalities.join(' + ').toUpperCase()} / ${commission.hidden_tests.length} HIDDEN TRIALS</p><h3>${title(commission.id)}</h3><p class="brief">${commission.brief}</p></div><div class="metrics">${commission.metrics.map(metric => `<span>${metric}</span>`).join('')}</div>`;
      exhibits.append(article);
    }
    sections.push(section);
    number += 1;
  }
  target.replaceChildren(...sections);
}

function renderFrontiers() {
  const target = document.querySelector('#frontiers');
  target.replaceChildren(...Object.entries(state.constitution.evaluation_frontiers).map(([name, items]) => {
    const section = document.createElement('section');
    section.className = 'frontier';
    section.innerHTML = `<h3>${title(name)} frontier</h3><ol>${items.map(item => `<li>${title(item)}</li>`).join('')}</ol>`;
    return section;
  }));
}

function exportRoute() {
  const payload = {
    schema: 'frontier-world-expo-route/v1',
    seed: state.seed,
    constitution_schema: state.constitution.schema,
    roles: state.constitution.round_contract.required_candidate_roles,
    claim_boundary: 'Route only; no capability or promotion claim.'
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `frontier-world-expo-route-${state.seed}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function openGates() {
  const status = document.querySelector('#load-state');
  try {
    const response = await fetch('../design/frontier-world-expo.json');
    if (!response.ok) throw new Error(`constitution request failed: ${response.status}`);
    state.constitution = await response.json();
    renderDistricts();
    renderFrontiers();
    drawRoute();
    status.textContent = `${state.constitution.commissions.length} commissions open. Every result remains unpromoted until its evidence envelope is complete.`;
  } catch (error) {
    status.textContent = `The gates could not open: ${error.message}`;
  }
}

document.querySelector('#new-route').addEventListener('click', () => {
  state.seed += 1;
  localStorage.setItem('frontier-world-expo-seed', String(state.seed));
  drawRoute();
});
document.querySelector('#export-route').addEventListener('click', exportRoute);
openGates();

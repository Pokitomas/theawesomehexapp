export const STATE_MARKER = '<!-- coordination-tick-state:v1';
export const STATE_SUFFIX = '-->';
export const DEFAULT_POLICY = Object.freeze({ quietTicks: 3, staleTicks: 8, seenLimit: 128, signalLimit: 40, completedLaneLimit: 64, claimLimit: 256 });

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const unique = values => [...new Set(values.filter(Boolean))];
const clone = value => structuredClone(value);

export function emptyTickState(policy = {}) {
  return {
    version: 1,
    tick: 0,
    updated_at: null,
    last_event: null,
    policy: { ...DEFAULT_POLICY, ...policy },
    seen: [],
    lanes: {},
    claims: {},
    signals: []
  };
}

export function closingIssueNumbers(text = '') {
  const refs = [];
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:issue\s+)?#(\d+)/gi;
  for (const match of String(text).matchAll(pattern)) refs.push(Number(match[1]));
  return unique(refs.filter(Number.isFinite)).sort((a, b) => a - b);
}

export function parseDeclarationLines(text = '', context = {}) {
  const actor = clean(context.actor || 'unknown');
  const source = clean(context.source || '');
  const fallbackBranch = clean(context.branch || '');
  const fallbackIssues = unique((context.issueNumbers || []).map(Number).filter(Number.isFinite));
  const output = [];
  const branchPattern = /\b(?:agent|assembly|claude|codex|copilot|audit|fix|feature|chore|hotfix|release)\/[A-Za-z0-9._/-]+\b/g;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = clean(rawLine);
    if (!line || line.includes('coordination-tick-state:v1')) continue;
    if (!/\b(?:MATCHED|BRANCH|CLAIM(?:ED)?|OWN(?:ING|ED)?|RELEASED?|SUPERSEDED|ABANDONED|UNMATCHED)\b/i.test(line)) continue;

    const release = /\b(?:RELEASED?|SUPERSEDED|ABANDONED|UNMATCHED)\b/i.test(line);
    const issues = unique([...line.matchAll(/#(\d+)/g)].map(match => Number(match[1])).filter(Number.isFinite));
    const branches = unique(line.match(branchPattern) || []);
    const targetIssues = issues.length ? issues : fallbackIssues;
    const targetBranches = branches.length ? branches : (fallbackBranch ? [fallbackBranch] : ['']);

    for (const issue of targetIssues) {
      for (const branch of targetBranches) {
        output.push({
          type: release ? 'release' : 'claim',
          issue,
          branch: clean(branch) || null,
          actor,
          source,
          line: line.slice(0, 500)
        });
      }
    }
  }

  return output;
}

function signalId(type, lane, tick, detail = '') {
  return `${tick}:${type}:${lane || 'repo'}:${detail}`;
}

function makeSignal(type, lane, tick, detail, event) {
  return {
    id: signalId(type, lane, tick, detail),
    type,
    lane: lane || null,
    tick,
    detail: clean(detail).slice(0, 500),
    event_key: event?.key || null,
    source: event?.source || null
  };
}

function phaseFor(lane, policy) {
  if (lane.state === 'complete') return 'complete';
  if (lane.collision) return 'collision';
  if (lane.stasis_ticks >= policy.staleTicks) return 'stale';
  if (lane.stasis_ticks >= policy.quietTicks) return 'quiet';
  return 'active';
}

function syncInventory(state, inventory, tick, newSignals, event) {
  const present = new Set();
  for (const item of inventory) {
    const key = clean(item.key);
    if (!key) continue;
    present.add(key);
    const previous = state.lanes[key];
    const lane = previous || {
      key,
      kind: clean(item.kind),
      number: Number(item.number) || null,
      title: clean(item.title).slice(0, 240),
      url: clean(item.url) || null,
      branch: clean(item.branch) || null,
      issue_refs: unique((item.issue_refs || []).map(Number).filter(Number.isFinite)),
      state: 'open',
      phase: 'active',
      collision: false,
      discovered_tick: tick,
      last_activity_tick: tick,
      stasis_ticks: 0,
      activity_count: 0,
      completed_tick: null
    };
    lane.kind = clean(item.kind) || lane.kind;
    lane.number = Number(item.number) || lane.number;
    lane.title = clean(item.title).slice(0, 240) || lane.title;
    lane.url = clean(item.url) || lane.url;
    lane.branch = clean(item.branch) || null;
    lane.issue_refs = unique((item.issue_refs || []).map(Number).filter(Number.isFinite));
    if (lane.state === 'complete') {
      lane.state = 'open';
      lane.completed_tick = null;
      lane.last_activity_tick = tick;
      lane.stasis_ticks = 0;
      newSignals.push(makeSignal('reopened', key, tick, 'lane returned to open inventory', event));
    }
    state.lanes[key] = lane;
  }

  for (const lane of Object.values(state.lanes)) {
    if (lane.state === 'open' && !present.has(lane.key)) {
      lane.state = 'complete';
      lane.phase = 'complete';
      lane.collision = false;
      lane.completed_tick = tick;
      newSignals.push(makeSignal('completed', lane.key, tick, 'lane left open inventory', event));
    }
  }
}

function applyDeclarations(state, declarations, tick) {
  for (const declaration of declarations || []) {
    if (!Number.isFinite(Number(declaration.issue))) continue;
    const issue = Number(declaration.issue);
    const actor = clean(declaration.actor || 'unknown');
    const branch = clean(declaration.branch || '');
    const identity = `${issue}|${actor}`;
    if (declaration.type === 'release') {
      for (const claim of Object.values(state.claims)) {
        if (claim.issue !== issue || !claim.active) continue;
        const actorMatch = !actor || actor === 'unknown' || claim.actor === actor;
        const branchMatch = !branch || claim.branch === branch;
        if (actorMatch && branchMatch) {
          claim.active = false;
          claim.released_tick = tick;
          claim.release_source = clean(declaration.source) || null;
        }
      }
      continue;
    }
    state.claims[identity] = {
      id: identity,
      issue,
      actor,
      branch: branch || null,
      active: true,
      claimed_tick: state.claims[identity]?.claimed_tick || tick,
      last_seen_tick: tick,
      source: clean(declaration.source) || null,
      line: clean(declaration.line).slice(0, 500)
    };
  }
}

function touchedLaneKeys(state, event) {
  const touched = new Set(event?.lane_keys || []);
  const branch = clean(event?.branch || '');
  if (branch) {
    for (const lane of Object.values(state.lanes)) {
      if (lane.state === 'open' && lane.branch === branch) touched.add(lane.key);
    }
  }
  for (const key of [...touched]) {
    const lane = state.lanes[key];
    if (!lane) continue;
    if (lane.kind === 'pr') {
      for (const issue of lane.issue_refs || []) touched.add(`issue:${issue}`);
    } else if (lane.kind === 'issue') {
      for (const candidate of Object.values(state.lanes)) {
        if (candidate.kind === 'pr' && candidate.state === 'open' && candidate.issue_refs?.includes(lane.number)) touched.add(candidate.key);
      }
    }
  }
  return touched;
}

function advanceActivityAndStasis(state, touched, tick, newSignals, event) {
  for (const lane of Object.values(state.lanes)) {
    if (lane.state !== 'open') continue;
    const priorPhase = lane.phase;
    if (touched.has(lane.key)) {
      lane.last_activity_tick = tick;
      lane.stasis_ticks = 0;
      lane.activity_count = Number(lane.activity_count || 0) + 1;
    } else {
      lane.stasis_ticks = Math.max(0, tick - Number(lane.last_activity_tick || lane.discovered_tick || tick));
    }
    lane.phase = phaseFor(lane, state.policy);
    if (priorPhase !== lane.phase) {
      if (lane.phase === 'quiet') newSignals.push(makeSignal('quiet', lane.key, tick, `${lane.stasis_ticks} untargeted ticks`, event));
      if (lane.phase === 'stale') newSignals.push(makeSignal('stale', lane.key, tick, `${lane.stasis_ticks} untargeted ticks`, event));
      if (lane.phase === 'active' && ['quiet', 'stale'].includes(priorPhase)) newSignals.push(makeSignal('reactivated', lane.key, tick, `activity after ${priorPhase}`, event));
    }
  }
}

function retireCompletedBranchClaims(state, tick) {
  const completedBranches = new Set(
    Object.values(state.lanes)
      .filter(lane => lane.state === 'complete' && lane.branch)
      .map(lane => lane.branch)
  );
  for (const claim of Object.values(state.claims)) {
    if (!claim.active || !claim.branch || !completedBranches.has(claim.branch)) continue;
    claim.active = false;
    claim.released_tick = tick;
    claim.release_source = 'completed-branch';
  }
}

function pruneBoundedHistory(state) {
  const completed = Object.values(state.lanes)
    .filter(lane => lane.state === 'complete')
    .sort((a, b) => Number(b.completed_tick || 0) - Number(a.completed_tick || 0));
  const keepCompleted = new Set(completed.slice(0, state.policy.completedLaneLimit).map(lane => lane.key));
  for (const lane of completed) if (!keepCompleted.has(lane.key)) delete state.lanes[lane.key];

  const claims = Object.values(state.claims)
    .sort((a, b) => Number(b.last_seen_tick || b.released_tick || 0) - Number(a.last_seen_tick || a.released_tick || 0));
  const keepClaims = new Set(claims.slice(0, state.policy.claimLimit).map(claim => claim.id));
  for (const claim of claims) if (!keepClaims.has(claim.id)) delete state.claims[claim.id];
}

function detectCollisions(state, tick, newSignals, event) {
  const branchesByIssue = new Map();
  const add = (issue, branch, sourceLane = null) => {
    if (!Number.isFinite(Number(issue)) || !clean(branch)) return;
    const map = branchesByIssue.get(Number(issue)) || new Map();
    const entry = map.get(clean(branch)) || { branch: clean(branch), lanes: new Set() };
    if (sourceLane) entry.lanes.add(sourceLane);
    map.set(entry.branch, entry);
    branchesByIssue.set(Number(issue), map);
  };

  for (const lane of Object.values(state.lanes)) {
    if (lane.kind !== 'pr' || lane.state !== 'open' || !lane.branch) continue;
    for (const issue of lane.issue_refs || []) add(issue, lane.branch, lane.key);
  }
  for (const claim of Object.values(state.claims)) {
    if (!claim.active) continue;
    add(claim.issue, claim.branch || `actor:${claim.actor}`);
  }

  const collided = new Set();
  for (const [issue, branchMap] of branchesByIssue) {
    if (branchMap.size < 2) continue;
    collided.add(`issue:${issue}`);
    for (const entry of branchMap.values()) for (const lane of entry.lanes) collided.add(lane);
  }

  for (const lane of Object.values(state.lanes)) {
    if (lane.state !== 'open') continue;
    const was = Boolean(lane.collision);
    lane.collision = collided.has(lane.key);
    lane.phase = phaseFor(lane, state.policy);
    if (!was && lane.collision) {
      const issue = lane.kind === 'issue' ? lane.number : (lane.issue_refs || []).find(number => collided.has(`issue:${number}`));
      const branchList = issue ? [...(branchesByIssue.get(issue)?.keys() || [])].sort().join(', ') : 'multiple branches';
      newSignals.push(makeSignal('collision', lane.key, tick, branchList, event));
    }
    if (was && !lane.collision) newSignals.push(makeSignal('collision-cleared', lane.key, tick, 'one canonical claim remains', event));
  }
}

export function reduceCoordinationTick(previous, input = {}) {
  const state = clone(previous || emptyTickState(input.policy));
  state.policy = { ...DEFAULT_POLICY, ...(state.policy || {}), ...(input.policy || {}) };
  const event = input.event || {};
  const key = clean(event.key);
  if (!key) throw new Error('event.key is required');
  if (state.seen.includes(key)) return { state, changed: false, duplicate: true, newSignals: [] };

  state.tick = Number(state.tick || 0) + 1;
  const tick = state.tick;
  const newSignals = [];
  state.seen = [...state.seen, key].slice(-state.policy.seenLimit);
  state.updated_at = clean(event.observed_at) || new Date().toISOString();
  state.last_event = {
    key,
    name: clean(event.name),
    action: clean(event.action),
    actor: clean(event.actor),
    source: clean(event.source) || null,
    lane_keys: unique(event.lane_keys || []),
    branch: clean(event.branch) || null
  };

  syncInventory(state, input.inventory || [], tick, newSignals, event);
  applyDeclarations(state, input.declarations || [], tick);
  const touched = touchedLaneKeys(state, event);
  advanceActivityAndStasis(state, touched, tick, newSignals, event);
  retireCompletedBranchClaims(state, tick);
  detectCollisions(state, tick, newSignals, event);
  pruneBoundedHistory(state);

  state.signals = [...newSignals.reverse(), ...(state.signals || [])].slice(0, state.policy.signalLimit);
  return { state, changed: true, duplicate: false, newSignals: newSignals.reverse() };
}

export function parseStateComment(body = '') {
  const text = String(body);
  const start = text.indexOf(`${STATE_MARKER}\n`);
  if (start < 0) return null;
  const jsonStart = start + STATE_MARKER.length + 1;
  const end = text.indexOf(`\n${STATE_SUFFIX}`, jsonStart);
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart, end));
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function laneTable(state) {
  return Object.values(state.lanes)
    .filter(lane => lane.state === 'open')
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(lane => `| ${lane.key} | ${lane.phase} | ${lane.last_activity_tick} | ${lane.stasis_ticks} | ${lane.branch || '—'} |`)
    .join('\n') || '| — | — | — | — | — |';
}

function collisionLines(state) {
  const collisions = Object.values(state.lanes).filter(lane => lane.state === 'open' && lane.collision);
  return collisions.length ? collisions.map(lane => `- ${lane.key}: collision`).join('\n') : '- none';
}

function signalLines(state) {
  return (state.signals || []).slice(0, 12).map(signal => `- tick ${signal.tick}: **${signal.type}** ${signal.lane || 'repository'} — ${signal.detail}`).join('\n') || '- none';
}

export function renderStateComment(state) {
  const json = JSON.stringify(state);
  return `${STATE_MARKER}\n${json}\n${STATE_SUFFIX}\n\n# Event-counted coordination state\n\n**Tick:** ${state.tick}  \n**Last event:** ${state.last_event?.name || 'none'} / ${state.last_event?.action || 'none'}  \n**Boundary:** repository events create ticks. Total repository silence creates no tick and therefore cannot be detected without a clock or external dispatcher.\n\n## Four atomic legs\n\n1. **Activity:** touched lanes reset stasis and advance their activity receipt.\n2. **Non-activity:** every untouched open lane accrues stasis in repository-event ticks, not minutes.\n3. **Collision:** multiple active branches or MATCHED claims for one issue force collision state.\n4. **Completion:** lanes leave active state only when GitHub no longer reports them open.\n\n## Open lanes\n\n| Lane | Phase | Last activity tick | Stasis ticks | Branch |\n|---|---:|---:|---:|---|\n${laneTable(state)}\n\n## Collisions\n\n${collisionLines(state)}\n\n## Latest transitions\n\n${signalLines(state)}\n`;
}

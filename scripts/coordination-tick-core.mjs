import { createHash } from 'node:crypto';

export const STATE_MARKER = '<!-- coordination-tick-state:v1';
export const STATE_SUFFIX = '-->';
export const MAX_STATE_COMMENT_CHARS = 60_000;
export const DEFAULT_POLICY = Object.freeze({
  quietTicks: 3,
  staleTicks: 8,
  seenLimit: 512,
  signalLimit: 24,
  completedLaneLimit: 48,
  claimLimit: 96,
  tableLimit: 40
});

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const unique = values => [...new Set((values || []).filter(Boolean))];
const clone = value => structuredClone(value);
const fingerprint = value => createHash('sha256').update(clean(value)).digest('hex').slice(0, 24);

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
          source: source.slice(0, 500),
          line: line.slice(0, 500)
        });
      }
    }
  }

  return output;
}

function makeSignal(type, lane, tick, detail, event) {
  const conciseDetail = clean(detail).slice(0, 240);
  return {
    id: `${tick}:${type}:${lane || 'repo'}:${conciseDetail}`,
    type,
    lane: lane || null,
    tick,
    detail: conciseDetail,
    event_key: clean(event?.key).slice(0, 240) || null,
    source: clean(event?.source).slice(0, 500) || null
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
      url: clean(item.url).slice(0, 500) || null,
      branch: clean(item.branch).slice(0, 240) || null,
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
    lane.url = clean(item.url).slice(0, 500) || lane.url;
    lane.branch = clean(item.branch).slice(0, 240) || null;
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

function claimIdentity(issue, actor, branch) {
  return `${issue}|${actor}|${branch || 'actor'}`;
}

function applyDeclarations(state, declarations, tick) {
  for (const declaration of declarations || []) {
    if (!Number.isFinite(Number(declaration.issue))) continue;
    const issue = Number(declaration.issue);
    const actor = clean(declaration.actor || 'unknown');
    const branch = clean(declaration.branch || '');
    if (declaration.type === 'release') {
      for (const claim of Object.values(state.claims)) {
        if (claim.issue !== issue || !claim.active) continue;
        const actorMatch = !actor || actor === 'unknown' || claim.actor === actor;
        const branchMatch = !branch || claim.branch === branch;
        if (actorMatch && branchMatch) {
          claim.active = false;
          claim.released_tick = tick;
          claim.release_source = clean(declaration.source).slice(0, 500) || null;
        }
      }
      continue;
    }

    const identity = claimIdentity(issue, actor, branch);
    state.claims[identity] = {
      id: identity,
      issue,
      actor,
      branch: branch || null,
      active: true,
      claimed_tick: state.claims[identity]?.claimed_tick || tick,
      last_seen_tick: tick,
      source: clean(declaration.source).slice(0, 500) || null,
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

  const inactiveClaims = Object.values(state.claims)
    .filter(claim => !claim.active)
    .sort((a, b) => Number(b.last_seen_tick || b.released_tick || 0) - Number(a.last_seen_tick || a.released_tick || 0));
  const keepInactive = new Set(inactiveClaims.slice(0, state.policy.claimLimit).map(claim => claim.id));
  for (const claim of inactiveClaims) if (!keepInactive.has(claim.id)) delete state.claims[claim.id];
}

function detectCollisions(state, tick, newSignals, event) {
  const branchesByIssue = new Map();
  const add = (issue, branch, sourceLane = null) => {
    if (!Number.isFinite(Number(issue)) || !clean(branch)) return;
    const map = branchesByIssue.get(Number(issue)) || new Map();
    const normalizedBranch = clean(branch);
    const entry = map.get(normalizedBranch) || { branch: normalizedBranch, lanes: new Set() };
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

function eventWasSeen(state, key) {
  const digest = fingerprint(key);
  return (state.seen || []).includes(key) || (state.seen || []).includes(digest);
}

export function reduceCoordinationTick(previous, input = {}) {
  const state = clone(previous || emptyTickState(input.policy));
  state.policy = { ...DEFAULT_POLICY, ...(state.policy || {}), ...(input.policy || {}) };
  const event = input.event || {};
  const key = clean(event.key);
  if (!key) throw new Error('event.key is required');
  if (eventWasSeen(state, key)) return { state, changed: false, duplicate: true, newSignals: [] };

  state.tick = Number(state.tick || 0) + 1;
  const tick = state.tick;
  const newSignals = [];
  state.seen = [...(state.seen || []).map(value => /^[a-f0-9]{24}$/.test(value) ? value : fingerprint(value)), fingerprint(key)]
    .slice(-state.policy.seenLimit);
  state.updated_at = clean(event.observed_at) || new Date().toISOString();
  state.last_event = {
    key: key.slice(0, 240),
    name: clean(event.name).slice(0, 80),
    action: clean(event.action).slice(0, 80),
    actor: clean(event.actor).slice(0, 160),
    source: clean(event.source).slice(0, 500) || null,
    lane_keys: unique(event.lane_keys || []).slice(0, 128),
    branch: clean(event.branch).slice(0, 240) || null
  };

  syncInventory(state, input.inventory || [], tick, newSignals, event);
  applyDeclarations(state, input.declarations || [], tick);
  const touched = touchedLaneKeys(state, event);
  advanceActivityAndStasis(state, touched, tick, newSignals, event);
  retireCompletedBranchClaims(state, tick);
  detectCollisions(state, tick, newSignals, event);
  pruneBoundedHistory(state);

  state.signals = [...newSignals].reverse().concat(state.signals || []).slice(0, state.policy.signalLimit);
  return { state, changed: true, duplicate: false, newSignals };
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
  const lanes = Object.values(state.lanes)
    .filter(lane => lane.state === 'open')
    .sort((a, b) => a.key.localeCompare(b.key));
  const limit = Math.max(1, Number(state.policy?.tableLimit || DEFAULT_POLICY.tableLimit));
  const rows = lanes.slice(0, limit)
    .map(lane => `| ${lane.key} | ${lane.phase} | ${lane.last_activity_tick} | ${lane.stasis_ticks} | ${lane.branch || '—'} |`);
  if (lanes.length > limit) rows.push(`| … | ${lanes.length - limit} more open lanes | — | — | — |`);
  return rows.join('\n') || '| — | — | — | — | — |';
}

function collisionLines(state) {
  const collisions = Object.values(state.lanes).filter(lane => lane.state === 'open' && lane.collision);
  const shown = collisions.slice(0, 20).map(lane => `- ${lane.key}: collision`);
  if (collisions.length > shown.length) shown.push(`- ${collisions.length - shown.length} additional collisions omitted from the human view`);
  return shown.join('\n') || '- none';
}

function signalLines(state) {
  return (state.signals || []).slice(0, 12)
    .map(signal => `- tick ${signal.tick}: **${signal.type}** ${signal.lane || 'repository'} — ${signal.detail}`)
    .join('\n') || '- none';
}

function compactPersistedState(state) {
  const compact = clone(state);
  compact.seen = unique((compact.seen || []).map(value => /^[a-f0-9]{24}$/.test(value) ? value : fingerprint(value)))
    .slice(-Number(compact.policy?.seenLimit || DEFAULT_POLICY.seenLimit));
  for (const lane of Object.values(compact.lanes || {})) {
    delete lane.title;
    delete lane.url;
  }
  for (const claim of Object.values(compact.claims || {})) {
    delete claim.line;
    delete claim.source;
    delete claim.release_source;
  }
  if (compact.last_event) delete compact.last_event.source;
  for (const signal of compact.signals || []) {
    delete signal.source;
    delete signal.event_key;
  }
  return compact;
}

function renderWithState(persisted, displayState) {
  const json = JSON.stringify(persisted);
  return `${STATE_MARKER}\n${json}\n${STATE_SUFFIX}\n\n# Event-counted coordination state\n\n**Tick:** ${displayState.tick}  \n**Last event:** ${displayState.last_event?.name || 'none'} / ${displayState.last_event?.action || 'none'}  \n**Boundary:** repository events create ticks. Total repository silence creates no tick and therefore cannot be detected without a clock or external dispatcher.\n\n## Four atomic legs\n\n1. **Activity:** touched lanes reset stasis and advance their activity receipt.\n2. **Non-activity:** every untouched open lane accrues stasis in repository-event ticks, not minutes.\n3. **Collision:** multiple active branches or MATCHED claims for one issue force collision state.\n4. **Completion:** lanes leave active state only when GitHub no longer reports them open.\n\n## Open lanes\n\n| Lane | Phase | Last activity tick | Stasis ticks | Branch |\n|---|---:|---:|---:|---|\n${laneTable(displayState)}\n\n## Collisions\n\n${collisionLines(displayState)}\n\n## Latest transitions\n\n${signalLines(displayState)}\n`;
}

function fitPersistedState(state) {
  const compact = compactPersistedState(state);
  let rendered = renderWithState(compact, state);
  if (rendered.length <= MAX_STATE_COMMENT_CHARS) return { persisted: compact, rendered };

  const completed = Object.values(compact.lanes || {})
    .filter(lane => lane.state === 'complete')
    .sort((a, b) => Number(a.completed_tick || 0) - Number(b.completed_tick || 0));
  for (const lane of completed) {
    delete compact.lanes[lane.key];
    rendered = renderWithState(compact, state);
    if (rendered.length <= MAX_STATE_COMMENT_CHARS) return { persisted: compact, rendered };
  }

  const inactive = Object.values(compact.claims || {})
    .filter(claim => !claim.active)
    .sort((a, b) => Number(a.last_seen_tick || a.released_tick || 0) - Number(b.last_seen_tick || b.released_tick || 0));
  for (const claim of inactive) {
    delete compact.claims[claim.id];
    rendered = renderWithState(compact, state);
    if (rendered.length <= MAX_STATE_COMMENT_CHARS) return { persisted: compact, rendered };
  }

  while ((compact.signals || []).length > 8) {
    compact.signals.pop();
    rendered = renderWithState(compact, state);
    if (rendered.length <= MAX_STATE_COMMENT_CHARS) return { persisted: compact, rendered };
  }
  while ((compact.seen || []).length > 128) {
    compact.seen.shift();
    rendered = renderWithState(compact, state);
    if (rendered.length <= MAX_STATE_COMMENT_CHARS) return { persisted: compact, rendered };
  }

  throw new Error(`Coordination state exceeds the ${MAX_STATE_COMMENT_CHARS}-character issue-comment boundary.`);
}

export function renderStateComment(state) {
  const direct = renderWithState(state, state);
  if (direct.length <= MAX_STATE_COMMENT_CHARS) return direct;
  return fitPersistedState(state).rendered;
}

const clean = value => String(value ?? '').trim().toLowerCase();
const tokens = value => new Set(clean(value).split(/[^\p{L}\p{N}_.:-]+/u).filter(Boolean));

function eventText(event) {
  return JSON.stringify({ kind: event.kind, body: event.body, issuer: event.issuer });
}

function overlapScore(queryTokens, event) {
  const eventTokens = tokens(eventText(event));
  let score = 0;
  for (const token of queryTokens) if (eventTokens.has(token)) score += 1;
  return score;
}

function eventReferences(event) {
  const body = event?.body || {};
  return new Set([
    ...(event?.source_event_ids || []),
    ...(event?.parent ? [event.parent] : []),
    ...(body.supports || []),
    ...(body.opposes || []),
    ...(body.left_id ? [body.left_id] : []),
    ...(body.right_id ? [body.right_id] : []),
    ...(body.goal_ids || []),
    ...(body.supporting_ids || []),
    ...(body.opposing_ids || []),
    ...(body.resolves || []),
    ...(body.targets || []),
    ...(body.target_id ? [body.target_id] : []),
    ...(body.unresolved_ids || []),
    ...(body.minority_report_ids || []),
    ...(body.synthesis_id ? [body.synthesis_id] : []),
    ...(body.blocking_event_ids || []),
    ...(body.target_ids || []),
    ...(body.assignment_event_id ? [body.assignment_event_id] : []),
    ...(body.assignment_ids || []),
    ...(body.output_ids || [])
  ].filter(Boolean));
}

function categoryOf(state, event) {
  if (state?.superseded?.[event.id]) return 'history';
  if (state?.failed_test_ids?.includes(event.id)) return 'failed';
  if (state?.open_question_ids?.includes(event.id) || state?.unresolved_contradiction_ids?.includes(event.id) || state?.unresolved_critique_ids?.includes(event.id)) return 'unresolved';
  if (state?.dissent_event_ids?.includes(event.id) || event.kind === 'contradiction' || (event.kind === 'evidence' && event.body.opposes?.length)) return 'dissent';
  if (event.kind === 'evidence' || event.kind === 'test.result' || event.kind === 'artifact') return 'support';
  return 'other';
}

function dependencyClosure(id, byId, allowedIds, selected = new Set(), visiting = new Set()) {
  if (selected.has(id)) return selected;
  if (visiting.has(id)) return selected;
  const event = byId.get(id);
  if (!event || !allowedIds.has(id)) return selected;
  visiting.add(id);
  for (const reference of eventReferences(event)) dependencyClosure(reference, byId, allowedIds, selected, visiting);
  visiting.delete(id);
  selected.add(id);
  return selected;
}

function safePublicEventIds(events) {
  const publicEvents = events.filter(event => event.visibility === 'public');
  const safeIds = new Set(publicEvents.map(event => event.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of publicEvents) {
      if (!safeIds.has(event.id)) continue;
      if ([...eventReferences(event)].some(id => !safeIds.has(id))) {
        safeIds.delete(event.id);
        changed = true;
      }
    }
  }
  return safeIds;
}

export function retrieveCognitionMemory(state, query = {}, options = {}) {
  const visibility = options.visibility === 'private' ? 'private' : 'public';
  const maxChars = Math.max(256, Math.min(64000, Number(options.max_chars ?? 12000) || 12000));
  const maxEvents = Math.max(1, Math.min(256, Number(options.max_events ?? 48) || 48));
  const queryTokens = tokens([query.text, query.role, ...(query.tags || [])].filter(Boolean).join(' '));
  const requestedTargetIds = new Set((query.target_ids || []).map(String));
  const allEvents = Array.isArray(state?.events) ? state.events : [];
  const safePublicIds = safePublicEventIds(allEvents);
  const targetIds = visibility === 'private'
    ? requestedTargetIds
    : new Set([...requestedTargetIds].filter(id => safePublicIds.has(id)));
  const events = visibility === 'private'
    ? allEvents
    : allEvents.filter(event => safePublicIds.has(event.id));
  const allowedIds = new Set(events.map(event => event.id));
  const byId = new Map(events.map(event => [event.id, event]));
  const orderedByTime = [...events].sort((left, right) => {
    const stamp = Date.parse(left.issued_at) - Date.parse(right.issued_at);
    return stamp || left.id.localeCompare(right.id);
  });
  const recencyRank = new Map(orderedByTime.map((event, index) => [event.id, index]));
  const recencyDenominator = Math.max(1, orderedByTime.length - 1);

  const scored = events.map(event => {
    const references = eventReferences(event);
    const components = {
      relevance: overlapScore(queryTokens, event) * 10,
      direct_target: targetIds.has(event.id) ? 100 : 0,
      target_reference: [...targetIds].some(target => references.has(target)) ? 60 : 0,
      dissent: state?.dissent_event_ids?.includes(event.id) ? 25 : 0,
      unresolved: (state?.open_question_ids?.includes(event.id) || state?.unresolved_contradiction_ids?.includes(event.id) || state?.unresolved_critique_ids?.includes(event.id)) ? 30 : 0,
      failed_test: state?.failed_test_ids?.includes(event.id) ? 30 : 0,
      recency: Math.round(((recencyRank.get(event.id) || 0) / recencyDenominator) * 1000) / 100,
      superseded: state?.superseded?.[event.id] ? -20 : 0
    };
    const score = Object.values(components).reduce((sum, value) => sum + value, 0);
    return { event, score, components, category: categoryOf(state, event) };
  }).sort((left, right) => right.score - left.score || right.components.recency - left.components.recency || left.event.id.localeCompare(right.event.id));

  const buckets = new Map(['unresolved', 'dissent', 'failed', 'support', 'other', 'history'].map(name => [name, []]));
  for (const item of scored) buckets.get(item.category).push(item);
  const candidateOrder = [];
  const priority = ['unresolved', 'dissent', 'failed', 'support', 'other', 'history'];
  while (priority.some(name => buckets.get(name).length)) {
    for (const name of priority) {
      const item = buckets.get(name).shift();
      if (item) candidateOrder.push(item);
    }
  }

  const selectedIds = new Set();
  const selected = [];
  const omitted = [];
  let used = 0;
  const addEvent = item => {
    if (selectedIds.has(item.event.id)) return true;
    const entry = {
      id: item.event.id,
      kind: item.event.kind,
      issuer: item.event.issuer,
      issued_at: item.event.issued_at,
      visibility: item.event.visibility,
      superseded_by: state?.superseded?.[item.event.id] || null,
      source_event_ids: item.event.source_event_ids,
      body: item.event.body,
      retrieval_score: item.score,
      retrieval_score_components: item.components,
      retrieval_category: item.category
    };
    const length = JSON.stringify(entry).length;
    if (selected.length >= maxEvents) return false;
    if (used + length > maxChars) return false;
    selected.push(entry);
    selectedIds.add(item.event.id);
    used += length;
    return true;
  };

  for (const item of candidateOrder) {
    if (selectedIds.has(item.event.id)) continue;
    const closure = [...dependencyClosure(item.event.id, byId, allowedIds)].filter(id => !selectedIds.has(id));
    const closureItems = closure.map(id => scored.find(value => value.event.id === id)).filter(Boolean)
      .sort((left, right) => Date.parse(left.event.issued_at) - Date.parse(right.event.issued_at) || left.event.id.localeCompare(right.event.id));
    const snapshot = { count: selected.length, used };
    let complete = true;
    for (const closureItem of closureItems) {
      if (!addEvent(closureItem)) {
        complete = false;
        break;
      }
    }
    if (!complete) {
      while (selected.length > snapshot.count) selectedIds.delete(selected.pop().id);
      used = snapshot.used;
      omitted.push({ id: item.event.id, reason: selected.length >= maxEvents ? 'max_events' : 'max_chars', dependency_count: closure.length });
    }
  }

  return {
    query: { role: query.role || null, target_ids: [...targetIds], text: query.text || '' },
    visibility,
    events: selected,
    chars: used,
    max_chars: maxChars,
    max_events: maxEvents,
    omitted,
    truncated: omitted.length > 0 || selected.length < scored.length
  };
}

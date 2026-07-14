const clean = value => String(value ?? '').trim().toLowerCase();
const tokens = value => new Set(clean(value).split(/[^a-z0-9_.:-]+/).filter(Boolean));

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
  const body = event.body || {};
  return new Set([
    ...(event.source_event_ids || []),
    ...(event.parent ? [event.parent] : []),
    ...(body.supports || []),
    ...(body.opposes || []),
    ...(body.target_ids || []),
    ...(body.supporting_ids || []),
    ...(body.opposing_ids || []),
    ...(body.resolves || []),
    ...(body.unresolved_ids || []),
    ...(body.minority_report_ids || []),
    ...(body.blocking_event_ids || [])
  ]);
}

export function retrieveCognitionMemory(state, query = {}, options = {}) {
  const visibility = options.visibility === 'private' ? 'private' : 'public';
  const maxChars = Math.max(256, Math.min(64000, Number(options.max_chars ?? 12000) || 12000));
  const maxEvents = Math.max(1, Math.min(256, Number(options.max_events ?? 48) || 48));
  const queryTokens = tokens([query.text, query.role, ...(query.tags || [])].filter(Boolean).join(' '));
  const requestedTargetIds = new Set((query.target_ids || []).map(String));
  const publicIds = new Set((state?.events || []).filter(event => event.visibility === 'public').map(event => event.id));
  const targetIds = visibility === 'private'
    ? requestedTargetIds
    : new Set([...requestedTargetIds].filter(id => publicIds.has(id)));
  const events = (state?.events || []).filter(event => {
    if (visibility === 'private') return true;
    if (event.visibility !== 'public') return false;
    return [...eventReferences(event)].every(id => publicIds.has(id));
  });

  const scored = events.map(event => {
    const references = eventReferences(event);
    let score = overlapScore(queryTokens, event) * 10;
    if (targetIds.has(event.id)) score += 100;
    for (const target of targetIds) if (references.has(target)) score += 60;
    if (state?.dissent_event_ids?.includes(event.id)) score += 25;
    if (state?.superseded?.[event.id]) score -= 5;
    score += Math.min(10, Math.max(0, Math.floor(Date.parse(event.issued_at) / 86400000) % 10));
    return { event, score };
  }).sort((left, right) => right.score - left.score || left.event.id.localeCompare(right.event.id));

  const buckets = { support: [], dissent: [], unresolved: [], history: [], other: [] };
  for (const item of scored) {
    const { event } = item;
    if (state?.dissent_event_ids?.includes(event.id) || event.kind === 'contradiction') buckets.dissent.push(item);
    else if (state?.open_question_ids?.includes(event.id) || state?.unresolved_contradiction_ids?.includes(event.id)) buckets.unresolved.push(item);
    else if (state?.superseded?.[event.id]) buckets.history.push(item);
    else if (event.kind === 'evidence' || event.kind === 'test.result') buckets.support.push(item);
    else buckets.other.push(item);
  }

  const ordered = [];
  const names = ['unresolved', 'dissent', 'support', 'other', 'history'];
  while (ordered.length < maxEvents && names.some(name => buckets[name].length)) {
    for (const name of names) {
      const item = buckets[name].shift();
      if (item) ordered.push(item);
      if (ordered.length >= maxEvents) break;
    }
  }

  const selected = [];
  let used = 0;
  for (const { event, score } of ordered) {
    const entry = {
      id: event.id,
      kind: event.kind,
      issuer: event.issuer,
      issued_at: event.issued_at,
      visibility: event.visibility,
      superseded_by: state?.superseded?.[event.id] || null,
      source_event_ids: event.source_event_ids,
      body: event.body,
      retrieval_score: score
    };
    const length = JSON.stringify(entry).length;
    if (selected.length && used + length > maxChars) continue;
    if (!selected.length && length > maxChars) {
      selected.push({ id: event.id, kind: event.kind, truncated: true, retrieval_score: score });
      break;
    }
    selected.push(entry);
    used += length;
  }

  return {
    query: { role: query.role || null, target_ids: [...targetIds], text: query.text || '' },
    visibility,
    events: selected,
    chars: used,
    truncated: selected.length < Math.min(scored.length, maxEvents)
  };
}

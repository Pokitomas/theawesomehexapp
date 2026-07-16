import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
};

export const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export class ChamberError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ChamberError';
    this.code = code;
    this.detail = detail;
  }
}

export function createEventLog({ runId = crypto.randomUUID(), clock = () => new Date().toISOString(), maxEvents = 10000 } = {}) {
  const events = [];
  let sequence = 0;
  return {
    append(event) {
      if (events.length >= maxEvents) throw new ChamberError('event_limit', 'event retention limit reached', { maxEvents });
      const record = {
        schema: 'archie-distilling-event/v1',
        run_id: runId,
        sequence: ++sequence,
        observed_at: clock(),
        parent_event_id: null,
        phase: 'observation',
        before: null,
        after: null,
        causal_edges: [],
        ...event,
      };
      record.event_id = `evt-${record.sequence}-${digest(record).slice(0, 16)}`;
      events.push(Object.freeze(record));
      return record;
    },
    read(cursor = 0, limit = 100) {
      const start = Math.max(0, Number(cursor) || 0);
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
      const slice = events.slice(start, start + bounded);
      return { events: slice, cursor: start + slice.length, has_more: start + slice.length < events.length };
    },
    replay() { return events.slice(); },
    get size() { return events.length; },
    get runId() { return runId; },
  };
}

const defaultLimits = Object.freeze({ max_depth: 4, max_children: 4, max_episodes: 64, max_wall_ms: 60_000, max_failures: 16 });

export function createDistillingChamber(options = {}) {
  const limits = { ...defaultLimits, ...(options.limits || {}) };
  const clockMs = options.clockMs || (() => Date.now());
  const eventLog = options.eventLog || createEventLog(options);
  const execute = options.execute || (async task => ({ ok: true, output: task.input ?? null, metrics: {} }));
  const evaluate = options.evaluate || (async ({ result }) => ({ accepted: Boolean(result?.ok), score: result?.ok ? 1 : 0, weaknesses: result?.ok ? [] : ['execution_failure'] }));
  const selectChildren = options.selectChildren || (() => []);
  const seen = new Set();
  const lessons = [];
  const episodes = new Map();
  let stopped = false;
  let paused = false;
  const startMs = clockMs();

  const assertBudget = () => {
    if (stopped) throw new ChamberError('stopped', 'chamber is stopped');
    if (clockMs() - startMs > limits.max_wall_ms) throw new ChamberError('wall_time_exhausted', 'wall time exhausted');
    if (episodes.size >= limits.max_episodes) throw new ChamberError('episode_limit', 'episode limit reached');
  };

  async function runEpisode(task, context = {}) {
    assertBudget();
    if (paused) throw new ChamberError('paused', 'chamber is paused');
    const depth = context.depth || 0;
    if (depth > limits.max_depth) throw new ChamberError('depth_limit', 'recursion depth exceeded', { depth });
    const taskDigest = digest({ task, depth });
    if (seen.has(taskDigest)) {
      return eventLog.append({ phase: 'rejection', task_id: task.id, episode_id: context.episode_id || null, recursion_depth: depth, reason: 'repeated_state', state_digest: taskDigest });
    }
    seen.add(taskDigest);
    const episodeId = context.episode_id || `ep-${episodes.size + 1}-${taskDigest.slice(0, 10)}`;
    const parent = context.parent_event_id || null;
    const episode = { id: episodeId, task, depth, status: 'running', attempts: [], children: [] };
    episodes.set(episodeId, episode);
    const intention = eventLog.append({ phase: 'intention', parent_event_id: parent, episode_id: episodeId, task_id: task.id, recursion_depth: depth, before: null, after: { status: 'running' }, causal_edges: parent ? [{ from: parent, relation: 'spawned' }] : [] });

    let result;
    try {
      result = await execute(task, { episode_id: episodeId, depth, signal: context.signal });
      episode.attempts.push({ ok: true, result_digest: digest(result) });
      eventLog.append({ phase: 'execution', parent_event_id: intention.event_id, episode_id: episodeId, task_id: task.id, recursion_depth: depth, before: { status: 'running' }, after: { status: 'executed' }, metrics: result.metrics || {}, result_digest: digest(result) });
    } catch (error) {
      const failure = { ok: false, code: error.code || 'execution_error', message: String(error.message || error) };
      episode.attempts.push(failure);
      episode.status = 'failed';
      const rejected = eventLog.append({ phase: 'rejection', parent_event_id: intention.event_id, episode_id: episodeId, task_id: task.id, recursion_depth: depth, before: { status: 'running' }, after: { status: 'failed' }, failure });
      lessons.push({ task_digest: taskDigest, accepted: false, failure, event_id: rejected.event_id });
      return rejected;
    }

    const verdict = await evaluate({ task, result, baseline: context.baseline, lessons: lessons.slice() });
    const effect = eventLog.append({ phase: verdict.accepted ? 'verified_effect' : 'rejection', parent_event_id: intention.event_id, episode_id: episodeId, task_id: task.id, recursion_depth: depth, before: { status: 'executed' }, after: { status: verdict.accepted ? 'accepted' : 'rejected', score: verdict.score }, verdict, result_digest: digest(result) });
    episode.status = verdict.accepted ? 'accepted' : 'rejected';
    lessons.push({ task_digest: taskDigest, accepted: Boolean(verdict.accepted), score: verdict.score, weaknesses: verdict.weaknesses || [], event_id: effect.event_id, result_digest: digest(result) });

    const children = (await selectChildren({ task, result, verdict, lessons: lessons.slice(), depth })) || [];
    if (children.length > limits.max_children) throw new ChamberError('child_limit', 'child budget exceeded', { requested: children.length });
    if (depth < limits.max_depth) {
      for (const child of children) {
        const childResult = await runEpisode(child, { depth: depth + 1, parent_event_id: effect.event_id, baseline: context.baseline, signal: context.signal });
        episode.children.push(childResult.event_id);
      }
    }
    return effect;
  }

  return {
    runEpisode,
    pause() { paused = true; return eventLog.append({ phase: 'blocker', reason: 'paused' }); },
    resume() { paused = false; return eventLog.append({ phase: 'observation', reason: 'resumed' }); },
    stop() { stopped = true; return eventLog.append({ phase: 'blocker', reason: 'stopped' }); },
    status() { return { run_id: eventLog.runId, paused, stopped, episodes: episodes.size, lessons: lessons.length, events: eventLog.size, limits }; },
    lessons() { return lessons.slice(); },
    events(cursor = 0, limit = 100) { return eventLog.read(cursor, limit); },
    async checkpoint(file) {
      const payload = { schema: 'archie-distilling-checkpoint/v1', status: this.status(), lessons: this.lessons(), events: eventLog.replay() };
      payload.digest = digest(payload);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(payload, null, 2));
      return payload;
    },
  };
}

import { randomUUID } from 'node:crypto';
export { signRemoteRequest } from './remote-engine.mjs';
import {
  DEFAULT_SKEW_MS, MAX_CLAIM_MS, appendMessage, authenticate, claimKey, clean, currentKey, defaultState,
  hasCapability, keyPart, listMessages, loadCurrent, loadState, opaque, principalKey,
  proposalPrefix, pruneClaims, publicProjection, readJSON, reply, requireSession,
  requiredCapability, sanitizeCapabilities, stateKey, terminalKey, validateTerminalEvidence
} from './remote-engine.mjs';

export function createRemoteHandler({ getStore, env = process.env, now = () => Date.now(), uuid = randomUUID, skewMs = DEFAULT_SKEW_MS } = {}) {
  if (typeof getStore !== 'function') throw new TypeError('getStore is required');

  return async request => {
    if (request.method === 'OPTIONS') return reply(204, {});
    const url = new URL(request.url);
    const store = getStore('universal-remote');
    const nowMs = Number(now());
    const session = opaque(url.searchParams.get('session') || '', 160);
    const view = url.searchParams.get('view') || (url.pathname.endsWith('/state') ? 'state' : 'messages');
    const publicRead = url.searchParams.get('public') === '1';

    if (request.method === 'GET') {
      if (!session) return reply(400, { error: 'session required' });
      const current = await loadCurrent(store, session);
      if (!current) return reply(404, { error: 'session not found' });
      const generation = Number(url.searchParams.get('generation') || current.generation);
      if (generation !== current.generation) return reply(409, { error: 'invalid session generation', current_generation: current.generation });

      if (view === 'state' && publicRead) {
        const projection = await publicProjection(store, session, generation, nowMs);
        return projection ? reply(200, projection) : reply(404, { error: 'session state missing' });
      }

      const authResult = await authenticate({ request, bodyText: '', store, env, session, nowMs, skewMs });
      if (authResult.error) return authResult.error;
      if (!hasCapability(authResult.auth, 'read')) return reply(403, { error: 'read capability required' });
      const state = await loadState(store, session, generation, nowMs);
      if (!state) return reply(404, { error: 'session state missing' });
      if (view === 'state') {
        const terminal = state.terminal ? await readJSON(store, terminalKey(session, generation)) : null;
        return reply(200, { state, terminal });
      }
      const page = await listMessages(store, state, {
        after: clean(url.searchParams.get('after'), 240),
        limit: Number(url.searchParams.get('limit') || 50),
        publicOnly: false,
        nowMs
      });
      return reply(200, { session, generation, ...page });
    }

    if (request.method !== 'POST') return reply(405, { error: 'method not allowed' });
    const bodyText = await request.text();
    if (Buffer.byteLength(bodyText) > 256 * 1024) return reply(413, { error: 'request too large' });
    let body;
    try { body = JSON.parse(bodyText || '{}'); }
    catch { return reply(400, { error: 'invalid json' }); }

    const bodySession = opaque(body.session || session, 160);
    if (!bodySession) return reply(400, { error: 'session required' });
    const authResult = await authenticate({ request, bodyText, store, env, session: bodySession, nowMs, skewMs });
    if (authResult.error) return authResult.error;
    const auth = authResult.auth;
    const op = clean(body.op || 'message', 40);
    const capability = requiredCapability(op, body);
    if (!hasCapability(auth, capability)) return reply(403, { error: `${capability} capability required` });

    if (op === 'open') {
      if (await loadCurrent(store, bodySession)) return reply(409, { error: 'session already exists' });
      const generation = Number(body.generation || 1);
      if (!Number.isInteger(generation) || generation < 1) return reply(400, { error: 'valid generation required' });
      const nowISO = new Date(nowMs).toISOString();
      const state = { ...defaultState(bodySession, generation, nowISO), head_sha: body.head_sha || null };
      await store.setJSON(stateKey(bodySession, generation), state);
      await store.setJSON(currentKey(bodySession), { session: bodySession, generation, opened_at: nowISO, opened_by: auth.principal });
      return reply(201, { state });
    }

    const loaded = await requireSession(store, bodySession, body.generation, nowMs);
    if (loaded.error) return loaded.error;
    let { state, generation } = loaded;
    if (state.terminal && op !== 'new_generation') return reply(409, { error: 'session generation is terminal' });

    if (op === 'message') {
      const appended = await appendMessage(store, state, auth.principal, body.message || body, nowMs);
      if (appended.error) return appended.error;
      state = { ...state, updated_at: new Date(nowMs).toISOString() };
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(201, { message: appended.message, cursor: appended.cursor });
    }

    if (op === 'grant') {
      const principal = opaque(body.principal, 160);
      const capabilities = sanitizeCapabilities(body.capabilities);
      if (!principal || principal === 'root' || !capabilities.length) return reply(400, { error: 'principal and capabilities required' });
      const record = { principal, capabilities, expires_at: body.expires_at || null, revoked: false, updated_at: new Date(nowMs).toISOString(), updated_by: auth.principal };
      await store.setJSON(principalKey(bodySession, principal), record);
      return reply(200, { principal: record });
    }

    if (op === 'revoke') {
      const principal = opaque(body.principal, 160);
      if (!principal || principal === 'root') return reply(400, { error: 'revocable principal required' });
      const record = (await readJSON(store, principalKey(bodySession, principal))) || { principal, capabilities: [] };
      record.revoked = true;
      record.updated_at = new Date(nowMs).toISOString();
      record.updated_by = auth.principal;
      await store.setJSON(principalKey(bodySession, principal), record);
      return reply(200, { principal: record });
    }

    if (op === 'claim') {
      const scope = opaque(body.scope, 200);
      if (!scope) return reply(400, { error: 'claim scope required' });
      state = pruneClaims(state, nowMs);
      const existing = state.claims?.[scope];
      if (existing && existing.holder !== auth.principal && !auth.root && !hasCapability(auth, 'admin')) {
        return reply(409, { error: 'scope already claimed', claim: existing });
      }
      const requestedExpiry = body.expires_at ? Date.parse(body.expires_at) : nowMs + 20 * 60 * 1000;
      const expiresMs = Math.min(Number.isFinite(requestedExpiry) ? requestedExpiry : nowMs + 20 * 60 * 1000, nowMs + MAX_CLAIM_MS);
      if (expiresMs <= nowMs) return reply(400, { error: 'claim must expire in the future' });
      const claim = { scope, holder: auth.principal, issued_at: new Date(nowMs).toISOString(), expires_at: new Date(expiresMs).toISOString() };
      state = { ...state, claims: { ...(state.claims || {}), [scope]: claim }, updated_at: new Date(nowMs).toISOString() };
      await store.setJSON(claimKey(bodySession, generation, scope), claim);
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(200, { claim });
    }

    if (op === 'release') {
      const scope = opaque(body.scope, 200);
      const claim = state.claims?.[scope];
      if (!scope || !claim) return reply(404, { error: 'claim not found' });
      if (claim.holder !== auth.principal && !auth.root && !hasCapability(auth, 'admin')) return reply(403, { error: 'claim belongs to another principal' });
      const claims = { ...(state.claims || {}) };
      delete claims[scope];
      state = { ...state, claims, updated_at: new Date(nowMs).toISOString() };
      await store.delete(claimKey(bodySession, generation, scope));
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(200, { released: scope });
    }

    if (op === 'state') {
      const decision = clean(body.decision || state.decision, 40);
      if (!['proceed', 'pause', 'stop', 'superseded'].includes(decision)) return reply(400, { error: 'invalid decision' });
      const nextHead = body.head_sha === undefined ? state.head_sha : clean(body.head_sha, 80) || null;
      state = {
        ...state,
        decision,
        head_sha: nextHead,
        blocking: body.blocking === undefined ? state.blocking : Boolean(body.blocking),
        blocker_count: body.blocker_count === undefined ? Number(state.blocker_count || 0) : Math.max(0, Number(body.blocker_count) || 0),
        updated_at: new Date(nowMs).toISOString()
      };
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(200, { state });
    }

    if (op === 'propose_terminal') {
      const proposal = body.proposal || {};
      const validation = validateTerminalEvidence(proposal, state);
      if (validation.errors.length) return reply(409, { error: 'terminal proposal rejected', reasons: validation.errors });
      const id = opaque(proposal.id || uuid(), 180);
      const stored = {
        id,
        session: bodySession,
        generation,
        head_sha: validation.headSha,
        checks: validation.checks,
        artifacts: validation.artifacts,
        remaining_test_records: 0,
        active_blockers: 0,
        merge: validation.merge,
        production: validation.production,
        evidence: proposal.evidence || {},
        proposed_at: new Date(nowMs).toISOString(),
        proposed_by: auth.principal
      };
      await store.setJSON(`${proposalPrefix(bodySession, generation)}${keyPart(id)}.json`, stored);
      state = { ...state, terminal_proposal: id, updated_at: new Date(nowMs).toISOString() };
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(201, { proposal: stored });
    }

    if (op === 'terminalize') {
      if (await readJSON(store, terminalKey(bodySession, generation))) return reply(409, { error: 'terminal receipt already exists' });
      const proposalId = opaque(body.proposal_id || state.terminal_proposal, 180);
      const proposal = proposalId ? await readJSON(store, `${proposalPrefix(bodySession, generation)}${keyPart(proposalId)}.json`) : null;
      if (!proposal) return reply(404, { error: 'terminal proposal not found' });
      state = pruneClaims(state, nowMs);
      const validation = validateTerminalEvidence(proposal, state);
      if (validation.errors.length) return reply(409, { error: 'terminalization rejected', reasons: validation.errors });
      const receipt = {
        session: bodySession,
        generation,
        head_sha: proposal.head_sha,
        merge_sha: proposal.merge.merge_sha,
        evidence: {
          checks: proposal.checks,
          artifacts: proposal.artifacts,
          remaining_test_records: 0,
          active_blockers: 0,
          ...proposal.evidence
        },
        production: proposal.production,
        terminated_at: new Date(nowMs).toISOString(),
        terminated_by: auth.principal
      };
      await store.setJSON(terminalKey(bodySession, generation), receipt);
      state = { ...state, decision: 'terminal', terminal: true, claims: {}, updated_at: receipt.terminated_at };
      await store.setJSON(stateKey(bodySession, generation), state);
      return reply(200, { terminal: receipt });
    }

    if (op === 'new_generation') {
      if (!state.terminal) return reply(409, { error: 'current generation must be terminal' });
      const nextGeneration = Number(body.next_generation || generation + 1);
      if (nextGeneration !== generation + 1) return reply(409, { error: 'next generation must increment by one' });
      const nowISO = new Date(nowMs).toISOString();
      const nextState = { ...defaultState(bodySession, nextGeneration, nowISO), head_sha: body.head_sha || null };
      await store.setJSON(stateKey(bodySession, nextGeneration), nextState);
      await store.setJSON(currentKey(bodySession), { session: bodySession, generation: nextGeneration, opened_at: nowISO, opened_by: auth.principal, previous_generation: generation });
      return reply(201, { state: nextState });
    }

    return reply(400, { error: 'unknown operation' });
  };
}

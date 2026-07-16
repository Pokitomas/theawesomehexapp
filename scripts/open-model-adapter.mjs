import { setTimeout as delay } from 'node:timers/promises';

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function endpoint(baseUrl, protocol) {
  const url = new URL(clean(baseUrl, 4000));
  if (protocol === 'ollama') {
    if (!/\/api\/chat\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/api/chat`.replace(/\/+/g, '/');
    return url;
  }
  if (!/\/chat\/completions\/?$/.test(url.pathname)) {
    const root = url.pathname.replace(/\/$/, '');
    url.pathname = `${root.endsWith('/v1') ? root : `${root}/v1`}/chat/completions`.replace(/\/+/g, '/');
  }
  return url;
}

export function parseModelJSON(value) {
  const text = clean(value, 200000);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = clean(fenced || text, 200000);
  try { return JSON.parse(candidate); }
  catch {
    const firstObject = candidate.indexOf('{');
    const lastObject = candidate.lastIndexOf('}');
    if (firstObject !== -1 && lastObject > firstObject) return JSON.parse(candidate.slice(firstObject, lastObject + 1));
    const firstArray = candidate.indexOf('[');
    const lastArray = candidate.lastIndexOf(']');
    if (firstArray !== -1 && lastArray > firstArray) return JSON.parse(candidate.slice(firstArray, lastArray + 1));
    throw new Error('Model output was not valid JSON.');
  }
}

function retryableStatus(status) {
  return [408, 409, 425, 429].includes(Number(status)) || Number(status) >= 500;
}

function boundedDelay(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(number)));
}

function responseRetryDelay(response, attempt, baseMs, maximumMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return boundedDelay(seconds * 1000, baseMs, maximumMs);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return boundedDelay(timestamp - Date.now(), baseMs, maximumMs);
  }
  const reset = Number(response?.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return boundedDelay((reset * 1000) - Date.now(), baseMs, maximumMs);
  const exponential = baseMs * (2 ** attempt);
  const deterministicJitter = Math.min(250, attempt * 37);
  return boundedDelay(exponential + deterministicJitter, baseMs, maximumMs);
}

function modelError(message, fields = {}) {
  const error = new Error(clean(message, 2000));
  for (const [key, value] of Object.entries(fields)) error[key] = value;
  return error;
}

export function createOpenModelClient({
  base_url,
  model,
  protocol = 'openai',
  api_key = '',
  fetch_impl = fetch,
  timeout_ms = 120000,
  retries = 3,
  retry_base_ms = 750,
  max_retry_ms = 10000
} = {}) {
  const normalizedProtocol = clean(protocol, 40).toLowerCase() || 'openai';
  if (!['openai', 'ollama'].includes(normalizedProtocol)) throw new Error(`Unsupported model protocol: ${normalizedProtocol}.`);
  if (!clean(base_url, 4000)) throw new Error('Model base URL is required.');
  if (!clean(model, 500)) throw new Error('Model name is required.');
  const url = endpoint(base_url, normalizedProtocol);
  const retryCount = Math.max(0, Math.min(8, Number(retries) || 0));
  const requestTimeout = Math.max(1000, Number(timeout_ms) || 120000);
  const baseDelay = Math.max(100, Number(retry_base_ms) || 750);
  const maximumDelay = Math.max(baseDelay, Number(max_retry_ms) || 10000);

  async function complete(messages, options = {}) {
    const headers = {
      accept: 'application/vnd.github+json, application/json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28'
    };
    if (clean(api_key, 10000)) headers.authorization = `Bearer ${clean(api_key, 10000)}`;
    const body = normalizedProtocol === 'ollama'
      ? {
          model: clean(model, 500),
          stream: false,
          format: 'json',
          messages,
          options: {
            temperature: Number(options.temperature ?? 0.1),
            num_predict: Number(options.max_tokens ?? 4096)
          }
        }
      : {
          model: clean(model, 500),
          messages,
          temperature: Number(options.temperature ?? 0.1),
          max_tokens: Number(options.max_tokens ?? 4096),
          ...(options.response_format === false ? {} : { response_format: { type: 'json_object' } })
        };

    let lastError = null;
    const attempts = [];
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(modelError('Model request timed out.', { code: 'MODEL_TIMEOUT' })), requestTimeout);
      try {
        const response = await fetch_impl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = clean(data.error?.message || data.error || data.message || response.statusText || `HTTP ${response.status}`, 1000);
          const error = modelError(`Model endpoint ${response.status}: ${message}`, {
            code: 'MODEL_HTTP_ERROR',
            status: Number(response.status),
            retryable: retryableStatus(response.status)
          });
          attempts.push({ attempt: attempt + 1, ok: false, status: Number(response.status), retryable: error.retryable, error: error.message });
          if (!error.retryable || attempt >= retryCount) throw error;
          const waitMs = responseRetryDelay(response, attempt, baseDelay, maximumDelay);
          await delay(waitMs);
          lastError = error;
          continue;
        }
        const text = normalizedProtocol === 'ollama'
          ? data.message?.content
          : data.choices?.[0]?.message?.content;
        if (!clean(text, 200000)) throw modelError('Model endpoint returned no message content.', { code: 'MODEL_EMPTY_RESPONSE', retryable: false });
        attempts.push({ attempt: attempt + 1, ok: true, status: Number(response.status || 200) });
        return {
          text: clean(text, 200000),
          data,
          usage: data.usage || null,
          protocol: normalizedProtocol,
          model: clean(model, 500),
          endpoint: url.toString(),
          attempts
        };
      } catch (error) {
        const normalized = error?.name === 'AbortError'
          ? modelError('Model request timed out.', { code: 'MODEL_TIMEOUT', retryable: true })
          : error;
        if (!attempts.some(value => value.attempt === attempt + 1)) {
          attempts.push({ attempt: attempt + 1, ok: false, status: Number(normalized?.status || 0) || null, retryable: normalized?.retryable !== false, error: clean(normalized?.message || normalized, 1000) });
        }
        lastError = normalized;
        const retryable = normalized?.retryable !== false;
        if (!retryable || attempt >= retryCount) {
          normalized.attempts = attempts;
          throw normalized;
        }
        await delay(boundedDelay(baseDelay * (2 ** attempt), baseDelay, maximumDelay));
      } finally {
        clearTimeout(timer);
      }
    }
    const failure = lastError || modelError('Model request failed.', { code: 'MODEL_REQUEST_FAILED' });
    failure.attempts = attempts;
    throw failure;
  }

  return Object.freeze({
    id: `open-model:${normalizedProtocol}:${clean(model, 500)}`,
    protocol: normalizedProtocol,
    model: clean(model, 500),
    endpoint: url.toString(),
    complete
  });
}

const ROLE_CONTRACTS = Object.freeze({
  proposer: 'Propose one concrete repository model and the smallest executable plan. Name assumptions and required evidence.',
  opponent: 'Attack the leading plan. Find a contradiction, hidden cost, authority violation, or simpler deletion. Do not merely restate risk.',
  verifier: 'Define or report decisive witnesses. Separate observed evidence from unverified claims and reject proofs that do not test the requested reality.',
  implementer: 'Translate admitted intent into bounded file-level work, dependencies, and stop conditions. Do not claim implementation occurred.',
  integrator: 'Reconcile compatible outputs, expose collisions, order dependencies, and preserve protected invariants. Prefer one coherent plan over accumulation.',
  historian: 'Recover relevant prior decisions, failures, artifacts, and superseded assumptions from supplied memory. Mark provenance and staleness.',
  critic: 'Evaluate the assembled answer against the human goal, proof requirement, evidence, and unresolved contradictions. Recommend admission, revision, or rejection.',
  default: 'Produce only the narrow typed output requested by the assignment and explicitly mark uncertainty.'
});

export function roleSystemPrompt(role = 'default') {
  const normalizedRole = clean(role, 80).toLowerCase() || 'default';
  const contract = ROLE_CONTRACTS[normalizedRole];
  if (!contract) throw new Error(`Unsupported planning role: ${normalizedRole}.`);
  return [
    `You are the ${normalizedRole} role inside a bounded typed software-engineering weave.`,
    contract,
    'Return JSON only. Never return private chain-of-thought.',
    'Return an object with exactly one field named events.',
    'events must be an array of concise typed cognition events accepted by the supplied role packet.',
    'Every event must cite the assignment event ID in source_event_ids.',
    'Do not claim a file changed, command ran, test passed, merge happened, or deployment occurred unless supplied evidence says so.',
    'Do not emit decisions or authority actions.'
  ].join(' ');
}

export function createOpenModelRoleAdapter(client, { id = client?.id || 'open-model', role = 'default' } = {}) {
  if (!client?.complete) throw new Error('Open model client is required.');
  const normalizedRole = clean(role, 80).toLowerCase() || 'default';
  const systemPrompt = roleSystemPrompt(normalizedRole);
  return Object.freeze({
    id,
    role: normalizedRole,
    async execute(packet) {
      if (packet?.assignment?.role && clean(packet.assignment.role, 80).toLowerCase() !== normalizedRole && normalizedRole !== 'default') {
        throw new Error(`Role packet mismatch: adapter=${normalizedRole} assignment=${clean(packet.assignment.role, 80).toLowerCase()}.`);
      }
      const response = await client.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(packet) }
      ]);
      const parsed = parseModelJSON(response.text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.events)) return parsed.events;
      throw new Error('Model JSON must contain an events array.');
    }
  });
}

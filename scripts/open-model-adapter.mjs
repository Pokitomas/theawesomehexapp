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

export function createOpenModelClient({
  base_url,
  model,
  protocol = 'openai',
  api_key = '',
  fetch_impl = fetch,
  timeout_ms = 120000,
  retries = 1
} = {}) {
  const normalizedProtocol = clean(protocol, 40).toLowerCase() || 'openai';
  if (!['openai', 'ollama'].includes(normalizedProtocol)) throw new Error(`Unsupported model protocol: ${normalizedProtocol}.`);
  if (!clean(base_url, 4000)) throw new Error('Model base URL is required.');
  if (!clean(model, 500)) throw new Error('Model name is required.');
  const url = endpoint(base_url, normalizedProtocol);

  async function complete(messages, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Model request timed out.')), Math.max(1000, Number(timeout_ms) || 120000));
    const headers = { 'content-type': 'application/json' };
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
          response_format: { type: 'json_object' }
        };

    try {
      let lastError;
      for (let attempt = 0; attempt <= Math.max(0, Number(retries) || 0); attempt += 1) {
        try {
          const response = await fetch_impl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`Model endpoint ${response.status}: ${clean(data.error?.message || data.error || response.statusText, 1000)}`);
          const text = normalizedProtocol === 'ollama'
            ? data.message?.content
            : data.choices?.[0]?.message?.content;
          if (!clean(text, 200000)) throw new Error('Model endpoint returned no message content.');
          return { text: clean(text, 200000), data, protocol: normalizedProtocol, model: clean(model, 500), endpoint: url.toString() };
        } catch (error) {
          lastError = error;
          if (attempt >= Math.max(0, Number(retries) || 0) || controller.signal.aborted) throw error;
          await delay(250 * (attempt + 1));
        }
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    id: `open-model:${normalizedProtocol}:${clean(model, 500)}`,
    protocol: normalizedProtocol,
    model: clean(model, 500),
    endpoint: url.toString(),
    complete
  });
}

function roleSystemPrompt() {
  return [
    'You are one bounded worker inside a typed software-engineering weave.',
    'Return JSON only. Never return private chain-of-thought.',
    'Return an object with exactly one field named events.',
    'events must be an array of concise typed cognition events accepted by the supplied role packet.',
    'Every event must cite the assignment event ID in source_event_ids.',
    'Do not claim a file changed, command ran, test passed, merge happened, or deployment occurred unless supplied evidence says so.',
    'Do not emit decisions or authority actions.'
  ].join(' ');
}

export function createOpenModelRoleAdapter(client, { id = client?.id || 'open-model' } = {}) {
  if (!client?.complete) throw new Error('Open model client is required.');
  return Object.freeze({
    id,
    async execute(packet) {
      const response = await client.complete([
        { role: 'system', content: roleSystemPrompt() },
        { role: 'user', content: JSON.stringify(packet) }
      ]);
      const parsed = parseModelJSON(response.text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.events)) return parsed.events;
      throw new Error('Model JSON must contain an events array.');
    }
  });
}

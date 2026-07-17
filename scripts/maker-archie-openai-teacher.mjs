import crypto from 'node:crypto';
import { MAKER_LANES, planSchema } from './maker-core.mjs';
import { normalizeMakerExecutionPlan } from './maker-archie-runtime-contract.mjs';

export const ARCHIE_OPENAI_TEACHER_RECEIPT_SCHEMA = 'archie-openai-teacher-receipt/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function outputText(response) {
  const direct = clean(response?.output_text, 1_000_000);
  if (direct) return direct;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'refusal') throw new Error(`OpenAI teacher refused the request: ${clean(content.refusal, 4000) || 'unspecified refusal'}`);
      if (content?.type === 'output_text' && clean(content.text, 1_000_000)) return clean(content.text, 1_000_000);
    }
  }
  throw new Error('OpenAI teacher returned no structured plan text.');
}

function teacherSchema() {
  return {
    ...planSchema,
    properties: {
      ...planSchema.properties,
      selected_lane: { type: 'string', enum: MAKER_LANES.map(value => value.id) },
      owned_paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      focused_tests: { type: 'array', maxItems: 12, items: { type: 'string' } },
      deferred: { type: 'array', maxItems: 12, items: { type: 'string' } }
    }
  };
}

function normalizedTeacherPlan(value) {
  const plan = normalizeMakerExecutionPlan(value);
  if (!plan) throw new Error('OpenAI teacher returned an invalid Maker plan.');
  if (plan.owned_paths.includes('**')) throw new Error('OpenAI teacher cannot acquire a repository-wide path lease.');
  return plan;
}

function apiUrl(env) {
  const base = clean(env?.OPENAI_BASE_URL, 2000).replace(/\/+$/, '') || 'https://api.openai.com/v1';
  return `${base}/responses`;
}

export function isOpenAIArchieTeacherConfigured(env = process.env) {
  return clean(env?.OPENAI_API_KEY, 10000).length >= 20 && !/^(?:1|true|yes|on)$/i.test(clean(env?.ARCHIE_OPENAI_DISABLED, 20));
}

export function createOpenAIArchieTeacher({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  timeoutMs = 120000
} = {}) {
  if (!isOpenAIArchieTeacherConfigured(env)) return null;
  if (typeof fetchImpl !== 'function') throw new Error('OpenAI Archie teacher requires fetch.');

  const key = clean(env.OPENAI_API_KEY, 10000);
  const model = clean(env.ARCHIE_OPENAI_MODEL || env.OPENAI_MODEL, 300) || 'gpt-5.1';
  const effort = clean(env.ARCHIE_OPENAI_REASONING_EFFORT, 30) || 'high';

  return async function openAIArchieTeacher(task = {}, { local_attempt: localAttempt = null } = {}) {
    const instruction = clean(typeof task === 'string' ? task : task.instruction || task.request || task.goal, 12000);
    if (!instruction) throw new Error('OpenAI Archie teacher requires an instruction.');
    const context = canonical(typeof task === 'object' && task ? task.context || null : null);
    const started = new Date(typeof clock === 'function' ? clock() : clock ?? Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('OpenAI Archie teacher timed out.')), Math.max(1000, Number(timeoutMs) || 120000));

    const body = {
      model,
      store: false,
      reasoning: { effort },
      instructions: [
        'You are the bounded reasoning faculty inside Archie, not an autonomous executor.',
        'Produce one dense implementation plan for Maker. Maker is the only component allowed to cause effects.',
        'Prefer the smallest coherent architecture and direct data flow. Reject agent swarms, handoff chains, dashboards, neuron metaphors, and middleware that does not add necessary evidence or authority.',
        'Use the repository-relative paths most likely to own the change. Never request a repository-wide ** lease.',
        'Do not claim code was inspected, tests passed, or deployment occurred. Return only the strict plan object.'
      ].join('\n'),
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: stable({
            outcome: instruction,
            repository_context: context,
            local_attempt: localAttempt ? {
              state: clean(localAttempt.state, 100),
              confidence: Number(localAttempt.confidence || 0),
              margin: Number(localAttempt.margin || 0),
              alternatives: Array.isArray(localAttempt.alternatives) ? localAttempt.alternatives.slice(0, 3) : []
            } : null
          })
        }]
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'archie_maker_plan',
          description: 'One bounded Maker implementation plan.',
          strict: true,
          schema: teacherSchema()
        }
      }
    };

    let response;
    try {
      response = await fetchImpl(apiUrl(env), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response?.ok) {
      let detail = '';
      try { detail = clean(await response.text(), 4000); } catch {}
      throw new Error(`OpenAI Archie teacher failed with HTTP ${response?.status || 'unknown'}${detail ? `: ${detail}` : ''}`);
    }

    const payload = await response.json();
    if (payload?.status && payload.status !== 'completed') throw new Error(`OpenAI Archie teacher response status was ${clean(payload.status, 100)}.`);
    let parsed;
    try { parsed = JSON.parse(outputText(payload)); }
    catch (error) { throw new Error(`OpenAI Archie teacher returned invalid JSON: ${clean(error?.message || error, 1000)}`); }
    const plan = normalizedTeacherPlan(parsed);
    const planDigest = digest(plan);
    const receiptBody = {
      schema: ARCHIE_OPENAI_TEACHER_RECEIPT_SCHEMA,
      created_at: started.toISOString(),
      response_id: clean(payload.id, 300),
      teacher: 'openai-responses',
      model: clean(payload.model || model, 300),
      request_digest: digest(instruction),
      context_digest: digest(context),
      base_branch: clean(context?.base_branch, 200) || null,
      base_sha: clean(context?.base_sha, 200) || null,
      plan_digest: planDigest,
      usage: {
        input_tokens: Number(payload?.usage?.input_tokens || 0),
        output_tokens: Number(payload?.usage?.output_tokens || 0),
        total_tokens: Number(payload?.usage?.total_tokens || 0)
      },
      storage: 'disabled',
      effect_authority: 'maker-only'
    };
    const receipt = Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
    return Object.freeze({
      text: stable(plan),
      plan,
      tool_trace: [],
      outcome: 'completed',
      run_id: receipt.response_id,
      teacher: receipt.teacher,
      model: receipt.model,
      cost_usd: null,
      receipt
    });
  };
}

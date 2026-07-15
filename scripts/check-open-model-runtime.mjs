#!/usr/bin/env node
import process from 'node:process';
import { createOpenModelClient, parseModelJSON } from './open-model-adapter.mjs';

const args = process.argv.slice(2);
const valueFor = name => {
  const index = args.indexOf(name);
  return index === -1 ? '' : String(args[index + 1] || '').trim();
};

const baseUrl = valueFor('--base-url') || process.env.SIDEWAYS_MODEL_BASE_URL || '';
const model = valueFor('--model') || process.env.SIDEWAYS_MODEL_NAME || '';
const protocol = (valueFor('--protocol') || process.env.SIDEWAYS_MODEL_PROTOCOL || 'ollama').toLowerCase();
const apiKey = process.env.SIDEWAYS_MODEL_API_KEY || '';

if (!baseUrl || !model) {
  console.error([
    'Open-model runtime configuration is incomplete.',
    'Provide --base-url and --model, or set SIDEWAYS_MODEL_BASE_URL and SIDEWAYS_MODEL_NAME.',
    'Optional: --protocol openai|ollama and SIDEWAYS_MODEL_API_KEY.'
  ].join('\n'));
  process.exit(2);
}

const client = createOpenModelClient({
  base_url: baseUrl,
  model,
  protocol,
  api_key: apiKey,
  retries: 0,
  timeout_ms: Number(process.env.SIDEWAYS_MODEL_TIMEOUT_MS || 120000)
});

try {
  const response = await client.complete([
    {
      role: 'system',
      content: 'Return JSON only. Return {"runtime":"ready","tool_protocol":"json"}.'
    },
    {
      role: 'user',
      content: 'Prove this endpoint can answer one bounded JSON request.'
    }
  ], { temperature: 0, max_tokens: 128 });
  const parsed = parseModelJSON(response.text);
  console.log(JSON.stringify({
    ready: true,
    protocol: client.protocol,
    model: client.model,
    endpoint: client.endpoint,
    response: parsed,
    api_key_present: Boolean(apiKey)
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ready: false,
    protocol: client.protocol,
    model: client.model,
    endpoint: client.endpoint,
    api_key_present: Boolean(apiKey),
    error: String(error?.message || error).slice(0, 2000)
  }, null, 2));
  process.exit(1);
}

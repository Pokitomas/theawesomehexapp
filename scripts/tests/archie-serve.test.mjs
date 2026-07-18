import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createArchieServer, runServeCommand } from '../archie-serve.mjs';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function mockDeps(models = [], runResult = null, runError = null) {
  return {
    listModelsFn: async () => models,
    runModelFn: async (_ref, _opts) => {
      if (runError) throw runError;
      return runResult;
    }
  };
}

async function withServer(deps, fn) {
  const server = createArchieServer({ home: '/tmp/archie-test', runner_path: 'llama-cli', ...deps });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GET / returns the chat UI HTML', async () => {
  await withServer(mockDeps(), async port => {
    const res = await get(port, '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('<title>Archie</title>'), 'HTML must include page title');
    assert.ok(res.body.includes('/api/models'), 'HTML must reference models API');
    assert.ok(res.body.includes('/api/chat'), 'HTML must reference chat API');
  });
});

test('GET /api/ping returns ok with schema', async () => {
  await withServer(mockDeps(), async port => {
    const res = await get(port, '/api/ping');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.schema, 'archie-serve/v1');
  });
});

test('GET /api/models returns installed model list', async () => {
  const models = [
    { model_ref: 'tinyllama@1.0', artifact_digest: 'abc', directory: '/tmp/m', installed_at: '2024-01-01T00:00:00.000Z' }
  ];
  await withServer(mockDeps(models), async port => {
    const res = await get(port, '/api/models');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.models.length, 1);
    assert.equal(data.models[0].model_ref, 'tinyllama@1.0');
  });
});

test('GET /api/models returns empty list when no models installed', async () => {
  await withServer(mockDeps([]), async port => {
    const res = await get(port, '/api/models');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.deepEqual(data.models, []);
  });
});

test('POST /api/chat rejects missing model field', async () => {
  await withServer(mockDeps(), async port => {
    const res = await post(port, '/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
  });
});

test('POST /api/chat rejects empty messages array', async () => {
  await withServer(mockDeps(), async port => {
    const res = await post(port, '/api/chat', { model: 'tinyllama@1.0', messages: [] });
    assert.equal(res.status, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
  });
});

test('POST /api/chat rejects invalid JSON body', async () => {
  await withServer(mockDeps(), async port => {
    const res = await post(port, '/api/chat', 'not-json');
    assert.equal(res.status, 400);
  });
});

test('POST /api/chat returns content from successful model run', async () => {
  const runResult = { stdout: 'Hello, world!', stderr: '', code: 0 };
  await withServer(mockDeps([], runResult), async port => {
    const res = await post(port, '/api/chat', {
      model: 'tinyllama@1.0',
      messages: [{ role: 'user', content: 'say hello' }]
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.content, 'Hello, world!');
    assert.equal(data.model, 'tinyllama@1.0');
  });
});

test('POST /api/chat returns 422 when model is not installed', async () => {
  const runError = new Error('Model is not installed: tinyllama@1.0.');
  await withServer(mockDeps([], null, runError), async port => {
    const res = await post(port, '/api/chat', {
      model: 'tinyllama@1.0',
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(res.status, 422);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('not installed'));
  });
});

test('POST /api/chat formats multi-turn conversation for the model', async () => {
  let capturedPrompt = null;
  const deps = {
    listModelsFn: async () => [],
    runModelFn: async (_ref, opts) => { capturedPrompt = opts.prompt; return { stdout: 'ok', stderr: '', code: 0 }; }
  };
  await withServer(deps, async port => {
    await post(port, '/api/chat', {
      model: 'tinyllama@1.0',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second message' }
      ]
    });
    assert.ok(capturedPrompt.includes('User: first message'), 'prompt must include first user turn');
    assert.ok(capturedPrompt.includes('Assistant: first reply'), 'prompt must include assistant reply');
    assert.ok(capturedPrompt.includes('User: second message'), 'prompt must include second user turn');
    assert.ok(capturedPrompt.endsWith('Assistant:'), 'prompt must end with Assistant: cue');
  });
});

test('GET /unknown returns 404', async () => {
  await withServer(mockDeps(), async port => {
    const res = await get(port, '/nonexistent');
    assert.equal(res.status, 404);
  });
});

test('runServeCommand starts server and resolves with address', async () => {
  let listened = null;
  const server = await runServeCommand({
    port: 0,
    host: '127.0.0.1',
    home: '/tmp/archie-test',
    runner_path: 'llama-cli',
    listModelsFn: async () => [],
    runModelFn: async () => ({ stdout: '', stderr: '', code: 0 }),
    onListen: info => { listened = info; }
  });
  try {
    assert.ok(listened, 'onListen must have been called');
    assert.ok(Number.isInteger(listened.port) && listened.port > 0, 'port must be a positive integer');
    assert.ok(listened.url.startsWith('http://'), 'url must be http');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

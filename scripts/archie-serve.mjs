import http from 'node:http';
import process from 'node:process';
import { listModels, runModel, resolveArchieHome } from './archie-runtime-core.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();

function formatConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must be a non-empty array.');
  const turns = messages.map(m => {
    const role = clean(m?.role || '').toLowerCase();
    const content = clean(m?.content || '');
    if (role === 'system') return `System: ${content}`;
    if (role === 'user') return `User: ${content}`;
    if (role === 'assistant') return `Assistant: ${content}`;
    throw new Error(`Unsupported message role: ${role}.`);
  });
  return `${turns.join('\n\n')}\n\nAssistant:`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const CHAT_UI = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Archie</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --bg:#fff;--surface:#f9fafb;--border:#e5e7eb;
      --text:#111827;--muted:#6b7280;--accent:#2563eb;
      --user-bg:#2563eb;--user-fg:#fff;
      --ai-bg:#f3f4f6;--ai-fg:#111827;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      font-size:15px;line-height:1.5;
    }
    html,body{height:100%;background:var(--bg);color:var(--text)}
    #app{display:flex;flex-direction:column;height:100dvh;max-width:720px;margin:0 auto}
    header{
      display:flex;align-items:center;gap:12px;
      padding:14px 20px;border-bottom:1px solid var(--border);
      background:var(--bg);flex-shrink:0
    }
    .logo{font-weight:700;font-size:17px;letter-spacing:-.3px}
    .logo span{color:var(--accent)}
    .model-wrap{margin-left:auto;display:flex;align-items:center;gap:8px}
    select{
      background:var(--surface);border:1px solid var(--border);
      border-radius:8px;padding:6px 10px;font-size:13px;
      color:var(--text);cursor:pointer;outline:none
    }
    select:focus{border-color:var(--accent)}
    #clear-btn{
      background:none;border:1px solid var(--border);border-radius:8px;
      padding:6px 10px;font-size:13px;color:var(--muted);cursor:pointer
    }
    #clear-btn:hover{border-color:var(--text);color:var(--text)}
    #messages{
      flex:1;overflow-y:auto;padding:28px 20px;
      display:flex;flex-direction:column;gap:18px
    }
    .empty-state{
      margin:auto;text-align:center;color:var(--muted);
      padding:40px 20px
    }
    .empty-state h2{font-size:22px;font-weight:600;color:var(--text);margin-bottom:6px}
    .empty-state p{font-size:14px}
    .message{display:flex;flex-direction:column;gap:4px;max-width:84%}
    .message.user{align-self:flex-end;align-items:flex-end}
    .message.assistant{align-self:flex-start;align-items:flex-start}
    .bubble{
      padding:11px 15px;border-radius:16px;
      font-size:15px;word-break:break-word;white-space:pre-wrap
    }
    .user .bubble{
      background:var(--user-bg);color:var(--user-fg);
      border-bottom-right-radius:4px
    }
    .assistant .bubble{
      background:var(--ai-bg);color:var(--ai-fg);
      border-bottom-left-radius:4px
    }
    .thinking .bubble{
      background:var(--ai-bg);color:var(--muted);
      animation:pulse 1.4s ease-in-out infinite
    }
    .error .bubble{background:#fef2f2;color:#dc2626;border-bottom-left-radius:4px}
    @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
    .input-row{
      padding:14px 20px;border-top:1px solid var(--border);
      display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:var(--bg)
    }
    textarea{
      flex:1;background:var(--surface);border:1px solid var(--border);
      border-radius:12px;padding:10px 14px;font-size:15px;font-family:inherit;
      resize:none;line-height:1.5;max-height:140px;height:44px;
      overflow-y:hidden;outline:none;color:var(--text)
    }
    textarea:focus{border-color:var(--accent);background:var(--bg)}
    #send{
      height:44px;padding:0 18px;background:var(--accent);color:#fff;
      border:none;border-radius:12px;font-size:15px;font-weight:600;
      cursor:pointer;white-space:nowrap;flex-shrink:0
    }
    #send:disabled{opacity:.45;cursor:not-allowed}
    .footer{
      text-align:center;padding:6px;font-size:11px;color:var(--muted);
      background:var(--surface);border-top:1px solid var(--border);flex-shrink:0
    }
    @media(max-width:480px){
      header{padding:12px 14px}
      #messages{padding:20px 14px}
      .input-row{padding:10px 14px}
    }
  </style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo">Arch<span>ie</span></div>
    <div class="model-wrap">
      <select id="model-select"></select>
      <button id="clear-btn" type="button">Clear</button>
    </div>
  </header>
  <div id="messages">
    <div class="empty-state" id="empty">
      <h2>What can I help you with?</h2>
      <p id="empty-hint">Select a model above, then start talking.</p>
    </div>
  </div>
  <div class="input-row">
    <textarea id="input" placeholder="Message Archie…" rows="1"></textarea>
    <button id="send" type="button">Send</button>
  </div>
  <div class="footer" id="footer">Local &middot; private &middot; no data leaves this machine</div>
</div>
<script>
(function(){
  const $ = id => document.getElementById(id);
  const modelSelect = $('model-select');
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendBtn = $('send');
  const emptyEl = $('empty');
  const emptyHint = $('empty-hint');
  const footer = $('footer');
  let history = [];
  let busy = false;

  async function loadModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      const models = data.models || [];
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models installed</option>';
        emptyHint.textContent = 'Install a model with: archie pull <manifest>';
        sendBtn.disabled = true;
      } else {
        modelSelect.innerHTML = models.map(m =>
          '<option value="'+escHtml(m.model_ref)+'">'+escHtml(m.model_ref)+'</option>'
        ).join('');
        sendBtn.disabled = false;
      }
    } catch {
      modelSelect.innerHTML = '<option value="">Could not load models</option>';
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function addMessage(role, text, extra) {
    emptyEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'message ' + (extra || role);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { el: div, bubble };
  }

  function updateThinking(node, text) {
    node.el.className = 'message assistant';
    node.bubble.textContent = text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function send() {
    if (busy) return;
    const model = modelSelect.value;
    if (!model) { alert('No model selected.'); return; }
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';
    inputEl.style.height = '44px';
    busy = true;
    sendBtn.disabled = true;
    footer.textContent = 'Running…';

    history.push({ role: 'user', content: text });
    addMessage('user', text);
    const thinking = addMessage('assistant', '…', 'thinking');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: history })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        updateThinking(thinking, data.error || 'Error.');
        thinking.el.className = 'message error';
        history.pop();
      } else {
        const reply = data.content || '';
        updateThinking(thinking, reply);
        history.push({ role: 'assistant', content: reply });
      }
    } catch (err) {
      updateThinking(thinking, 'Network error: ' + err.message);
      thinking.el.className = 'message error';
      history.pop();
    }

    busy = false;
    sendBtn.disabled = modelSelect.value === '';
    footer.textContent = 'Local \u00b7 private \u00b7 no data leaves this machine';
    inputEl.focus();
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });
  $('clear-btn').addEventListener('click', () => {
    history = [];
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyEl);
    emptyEl.style.display = '';
    footer.textContent = 'Local \u00b7 private \u00b7 no data leaves this machine';
  });

  loadModels();
})();
</script>
</body>
</html>`;

export function createArchieServer({
  home = resolveArchieHome(),
  runner_path = process.env.ARCHIE_RUNNER || 'llama-cli',
  max_tokens = 512,
  timeout_ms = 300_000,
  listModelsFn = listModels,
  runModelFn = runModel
} = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      html(res, CHAT_UI);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      try {
        const models = await listModelsFn({ home });
        json(res, 200, { models });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      json(res, 200, { ok: true, schema: 'archie-serve/v1' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }

      const model = clean(body?.model || '');
      if (!model) {
        json(res, 400, { error: 'model is required.' });
        return;
      }

      const messages = body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        json(res, 400, { error: 'messages must be a non-empty array.' });
        return;
      }

      let prompt;
      try {
        prompt = formatConversation(messages);
      } catch (err) {
        json(res, 400, { error: String(err?.message || err) });
        return;
      }

      try {
        const result = await runModelFn(model, {
          home,
          runner_path,
          prompt,
          max_tokens,
          timeout_ms,
          temperature: 0.7,
          seed: 0,
          verify_artifact: false
        });
        const content = clean(result.stdout || '');
        json(res, 200, { content, model, exit_code: result.code });
      } catch (err) {
        const message = String(err?.message || err);
        const status = /not installed|not found|runner/i.test(message) ? 422 : 500;
        json(res, status, { error: message });
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found.\n');
  });

  return server;
}

export async function runServeCommand({
  port = 7474,
  host = '127.0.0.1',
  home = resolveArchieHome(),
  runner_path = process.env.ARCHIE_RUNNER || 'llama-cli',
  max_tokens = 512,
  timeout_ms = 300_000,
  listModelsFn = listModels,
  runModelFn = runModel,
  onListen
} = {}) {
  const server = createArchieServer({ home, runner_path, max_tokens, timeout_ms, listModelsFn, runModelFn });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address();
      const boundPort = actual?.port || port;
      if (onListen) {
        onListen({ port: boundPort, host, url: `http://${host}:${boundPort}` });
      } else {
        process.stdout.write(`Archie serving at http://${host}:${boundPort}\nPress Ctrl+C to stop.\n`);
      }
      resolve();
    });
  });
  return server;
}

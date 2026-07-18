export function renderStandaloneClient() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Archie</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f3efe5; color: #171714; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #f7f3e9 0, #ece5d7 100%); }
    button, textarea, input { font: inherit; }
    .shell { width: min(1120px, 100%); margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 18px max(40px, env(safe-area-inset-bottom)); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 11px; font-weight: 900; letter-spacing: -.04em; font-size: 25px; }
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; background: #171714; color: #f7f3e9; font-size: 16px; }
    .mode { border: 1px solid #c8bfad; background: rgba(255,255,255,.55); border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 750; }
    main { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); gap: 16px; }
    .card { border: 1px solid #cfc5b2; background: rgba(255,255,255,.72); border-radius: 22px; box-shadow: 0 16px 40px rgba(50,43,28,.08); overflow: hidden; }
    .card-body { padding: 22px; }
    h1 { margin: 0 0 8px; font-size: clamp(30px, 6vw, 58px); line-height: .98; letter-spacing: -.065em; max-width: 780px; }
    .lede { margin: 0 0 22px; max-width: 680px; color: #5a5448; font-size: 15px; line-height: 1.55; }
    label { display: block; margin: 0 0 7px; font-size: 12px; font-weight: 850; text-transform: uppercase; letter-spacing: .08em; }
    textarea { width: 100%; min-height: 118px; resize: vertical; border: 1px solid #bbb09c; background: #fffefa; border-radius: 15px; padding: 14px; outline: none; }
    textarea:focus { border-color: #171714; box-shadow: 0 0 0 3px rgba(23,23,20,.1); }
    .field + .field { margin-top: 14px; }
    .approve { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0; padding: 13px; background: #ece7dc; border-radius: 14px; }
    .approve input { margin-top: 3px; width: 18px; height: 18px; }
    .approve span { font-size: 13px; line-height: 1.45; color: #474137; }
    .run { width: 100%; border: 0; border-radius: 15px; background: #171714; color: #fffdf7; padding: 15px 18px; font-weight: 850; cursor: pointer; }
    .run:disabled { opacity: .5; cursor: wait; }
    .side-head { padding: 18px 20px; border-bottom: 1px solid #d8cfbd; display: flex; align-items: center; justify-content: space-between; }
    .side-head strong { font-size: 14px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #9e978a; }
    .dot.running { background: #b56d19; box-shadow: 0 0 0 6px rgba(181,109,25,.12); }
    .dot.done { background: #277748; box-shadow: 0 0 0 6px rgba(39,119,72,.12); }
    .status { min-height: 390px; padding: 18px 20px; }
    .empty { color: #756d60; font-size: 14px; line-height: 1.55; }
    .receipt { display: grid; gap: 11px; }
    .row { padding: 12px; border: 1px solid #d8cfbd; border-radius: 13px; background: #fffdf8; }
    .row span { display: block; color: #746c5f; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 800; margin-bottom: 4px; }
    .row strong, .row code { overflow-wrap: anywhere; font-size: 13px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }
    .actions button, .actions a { border: 1px solid #bdb29e; background: #f8f4ea; color: #171714; border-radius: 12px; padding: 10px; text-align: center; text-decoration: none; font-size: 12px; font-weight: 800; cursor: pointer; }
    details { margin-top: 14px; border-top: 1px solid #d8cfbd; padding-top: 12px; }
    summary { cursor: pointer; font-size: 12px; font-weight: 800; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.45; background: #181815; color: #f5f0e5; padding: 12px; border-radius: 12px; max-height: 280px; overflow: auto; }
    .error { color: #8f2d24; background: #f8e3df; border: 1px solid #e1afa8; border-radius: 13px; padding: 12px; font-size: 13px; }
    @media (max-width: 780px) { main { grid-template-columns: 1fr; } .shell { padding-inline: 12px; } .card-body { padding: 18px; } .status { min-height: 280px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><span class="mark">A</span> Archie</div>
      <div class="mode">Local · source-host independent</div>
    </header>
    <main>
      <section class="card">
        <div class="card-body">
          <h1>State what should be true.</h1>
          <p class="lede">Archie will bind the objective to protected reality, create a bounded task graph, run a real local Maker pass, preserve a requested revision, verify the result, record approval and rollback, and export the workspace.</p>
          <form id="journey-form">
            <div class="field">
              <label for="objective">Desired reality</label>
              <textarea id="objective" required>Make this workflow genuinely good on a phone. Reduce work, mistakes, and uncertainty without losing human control or the final audit trail.</textarea>
            </div>
            <div class="field">
              <label for="revision">Required revision</label>
              <textarea id="revision" required>Add a complete final audit trail and preserve why the alternative product hypothesis was rejected.</textarea>
            </div>
            <label class="approve">
              <input id="approve" type="checkbox" required>
              <span>I explicitly approve promotion only after the bounded run, independent review, passing evidence, and requested revision are recorded.</span>
            </label>
            <button class="run" id="run" type="submit">Run bounded local journey</button>
          </form>
        </div>
      </section>
      <aside class="card">
        <div class="side-head"><strong>Workspace payoff</strong><span class="dot" id="dot"></span></div>
        <div class="status" id="status"><p class="empty">No run yet. The canonical record will appear here; GitHub is not required to inspect progress or completion.</p></div>
      </aside>
    </main>
  </div>
  <script type="module">
    const form = document.querySelector('#journey-form');
    const button = document.querySelector('#run');
    const status = document.querySelector('#status');
    const dot = document.querySelector('#dot');
    let latest = null;

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));

    function render(result) {
      latest = result;
      status.innerHTML = '<div class="receipt">' +
        '<div class="row"><span>Workspace</span><strong>' + escapeHtml(result.workspace_id) + '</strong></div>' +
        '<div class="row"><span>Selected hypothesis</span><strong>' + escapeHtml(result.selected_hypothesis_id) + '</strong></div>' +
        '<div class="row"><span>Rejected hypothesis</span><strong>' + escapeHtml(result.rejected_hypothesis_id) + '</strong></div>' +
        '<div class="row"><span>Evidence + approval</span><strong>' + escapeHtml(result.evidence_id) + ' · ' + escapeHtml(result.approval_id) + '</strong></div>' +
        '<div class="row"><span>Rollback</span><strong>' + escapeHtml(result.rollback_id) + '</strong></div>' +
        '<div class="row"><span>Portable bundle</span><code>' + escapeHtml(result.bundle_digest) + '</code></div>' +
        '</div>' +
        '<div class="actions"><a href="/v1/workspaces/' + encodeURIComponent(result.workspace_id) + '" target="_blank">Inspect state</a><button id="export" type="button">Download export</button></div>' +
        '<details><summary>Exact terminal receipt</summary><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + '</pre></details>';
      document.querySelector('#export').addEventListener('click', exportBundle);
    }

    async function exportBundle() {
      if (!latest) return;
      const response = await fetch('/v1/standalone/workspaces/' + encodeURIComponent(latest.workspace_id) + '/export', {
        headers: { 'x-archie-principal': 'owner_local' }
      });
      if (!response.ok) throw new Error((await response.json()).message || 'Export failed.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = latest.workspace_id + '.archie.json';
      link.click();
      URL.revokeObjectURL(url);
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      button.textContent = 'Archie is working…';
      dot.className = 'dot running';
      status.innerHTML = '<p class="empty">Creating the native workspace, deriving the bounded task, executing Maker, preserving the requested revision, verifying evidence, approving, recording rollback, and exporting…</p>';
      try {
        const response = await fetch('/v1/standalone/journeys', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-archie-principal': 'owner_local' },
          body: JSON.stringify({
            objective: document.querySelector('#objective').value,
            requested_change: document.querySelector('#revision').value,
            approve: document.querySelector('#approve').checked
          })
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.message || 'Journey failed.');
        render(value);
        dot.className = 'dot done';
      } catch (error) {
        status.innerHTML = '<div class="error">' + escapeHtml(error.message) + '</div>';
        dot.className = 'dot';
      } finally {
        button.disabled = false;
        button.textContent = 'Run bounded local journey';
      }
    });
  </script>
</body>
</html>`;
}

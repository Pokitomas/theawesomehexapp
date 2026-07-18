function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

export function renderHostedLogin({ message = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Private Archie access</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171714; background: #eee7d9; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 18px; background: radial-gradient(circle at top, #fbf7ee, #e8dfcf 62%); }
    main { width: min(460px, 100%); border: 1px solid #c9bfac; border-radius: 24px; background: rgba(255,255,255,.78); padding: 24px; box-shadow: 0 22px 55px rgba(50,43,28,.12); }
    .brand { display: flex; align-items: center; gap: 11px; font-weight: 900; font-size: 24px; letter-spacing: -.04em; }
    .mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px; background: #171714; color: #fffaf0; }
    h1 { margin: 28px 0 8px; font-size: 38px; line-height: 1; letter-spacing: -.055em; }
    p { color: #5f584c; line-height: 1.55; font-size: 14px; }
    label { display: block; margin: 22px 0 7px; font-size: 12px; font-weight: 850; text-transform: uppercase; letter-spacing: .08em; }
    input { width: 100%; border: 1px solid #b8ad99; border-radius: 14px; background: #fffefa; padding: 14px; font: inherit; }
    button { width: 100%; margin-top: 12px; border: 0; border-radius: 14px; padding: 14px; background: #171714; color: #fffaf0; font: inherit; font-weight: 850; cursor: pointer; }
    .message { padding: 10px 12px; border-radius: 12px; background: #f7e1dc; color: #862d25; font-size: 13px; }
    small { display: block; margin-top: 14px; color: #756c5e; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark">A</span> Archie</div>
    <h1>Private workspace</h1>
    <p>Authenticate as a configured founder or developer. The service stores only token digests; raw credentials never enter workspace events, artifacts, receipts, or exports.</p>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}
    <form id="login">
      <label for="token">Access token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Open Archie</button>
    </form>
    <small>Production access must terminate TLS before Archie. The reference Compose stack accepts traffic on port 8787 and is vendor-neutral.</small>
  </main>
  <script>
    const form = document.querySelector('#login');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const response = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: document.querySelector('#token').value })
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.message || 'Authentication failed.');
        location.replace(value.redirect || '/');
      } catch (error) {
        location.replace('/login?error=' + encodeURIComponent(error.message));
      }
    });
  </script>
</body>
</html>`;
}

function hardenUnifiedIngestion() {
  const form = document.querySelector('.web-source-form');
  if (form) {
    const submit = form.querySelector('.import-primary');
    if (submit) submit.type = 'submit';
  }
  for (const button of document.querySelectorAll('.add-sideways-choice button,.connection-card button,.add-sideways-subview>button')) {
    if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.textContent.trim());
  }
}

window.addEventListener('sideways:importworkbench', hardenUnifiedIngestion);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hardenUnifiedIngestion, { once: true });
else hardenUnifiedIngestion();

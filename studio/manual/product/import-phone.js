const IOS_PICKER = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  || !('webkitdirectory' in document.createElement('input'));

let scheduled = false;

function importerFileInput() {
  return [...document.querySelectorAll('body > input[type="file"][hidden]')]
    .find(input => !input.id && !input.hasAttribute('webkitdirectory'))
    || document.getElementById('filePicker');
}

function patchPhonePicker() {
  if (!IOS_PICKER) return;
  const terminals = [...document.querySelectorAll('#importWorkbenchHost .import-terminal')];
  const folder = terminals.find(node => node.querySelector('strong')?.textContent === 'PICK FOLDER'
    || node.dataset.phonePicker === 'true');
  if (!folder) return;

  folder.dataset.phonePicker = 'true';
  const label = folder.querySelector('strong');
  const help = folder.querySelector('span');
  if (label && label.textContent !== 'PICK MORE FILES') label.textContent = 'PICK MORE FILES';
  if (help && help.textContent !== 'Choose several files on this device.') {
    help.textContent = 'Choose several files on this device.';
  }
  if (folder.dataset.phoneBound === 'true') return;
  folder.dataset.phoneBound = 'true';
  folder.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    importerFileInput()?.click();
  }, true);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    patchPhonePicker();
  });
}

new MutationObserver(schedule).observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden']
});
window.addEventListener('hashchange', schedule);
window.addEventListener('sideways:ready', schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();

window.SidewaysImportPhone = Object.freeze({ patch: patchPhonePicker, isPhoneFallback: IOS_PICKER });

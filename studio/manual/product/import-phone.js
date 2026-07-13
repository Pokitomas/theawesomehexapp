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
  if (!IOS_PICKER) return false;
  const terminals = [...document.querySelectorAll('#importWorkbenchHost .import-terminal')];
  const folder = terminals.find(node => node.querySelector('strong')?.textContent === 'PICK FOLDER'
    || node.dataset.phonePicker === 'true');
  if (!folder) return false;

  folder.dataset.phonePicker = 'true';
  const label = folder.querySelector('strong');
  const help = folder.querySelector('span');
  if (label && label.textContent !== 'PICK MORE FILES') label.textContent = 'PICK MORE FILES';
  if (help && help.textContent !== 'Choose several files on this device.') {
    help.textContent = 'Choose several files on this device.';
  }
  if (folder.dataset.phoneBound === 'true') return true;
  folder.dataset.phoneBound = 'true';
  folder.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    importerFileInput()?.click();
  }, true);
  return true;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    patchPhonePicker();
  });
}

function boot() {
  schedule();
  for (const delay of [100, 320, 900, 1800]) setTimeout(schedule, delay);
}

for (const eventName of ['hashchange', 'popstate', 'sideways:ready', 'sideways:importworkbench']) {
  window.addEventListener(eventName, schedule);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

window.SidewaysImportPhone = Object.freeze({ patch: patchPhonePicker, isPhoneFallback: IOS_PICKER });

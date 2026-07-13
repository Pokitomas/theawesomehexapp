const IOS_PICKER = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  || !('webkitdirectory' in document.createElement('input'));

let scheduled = false;

function patchPhonePicker() {
  const input = document.getElementById('sidewaysImportFiles');
  if (!input) return false;
  input.multiple = true;
  input.removeAttribute('webkitdirectory');
  input.removeAttribute('directory');
  input.dataset.phoneReady = IOS_PICKER ? 'yes' : 'not-needed';
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

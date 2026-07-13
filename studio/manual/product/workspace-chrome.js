let scheduled = false;

function icon(name, className = 'workspace-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./system-icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function installBrandMark() {
  const brand = document.querySelector('.brand-lockup');
  if (!brand || brand.querySelector('.workspace-brand-icon')) return;
  brand.prepend(icon('window', 'workspace-brand-icon'));
}

function installTitleActions(topline) {
  let actions = topline.querySelector('[data-workspace-title-actions]');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'workspace-title-actions';
    actions.dataset.workspaceTitleActions = 'true';
    topline.append(actions);
  }

  const status = document.getElementById('corpusStatus');
  const profile = document.getElementById('navProfile');
  if (status) actions.append(status);
  if (profile) actions.append(profile);
}

function installCommandbar(topbar, topline) {
  let commandbar = topbar.querySelector('[data-workspace-commandbar]');
  if (!commandbar) {
    commandbar = document.createElement('div');
    commandbar.className = 'workspace-commandbar';
    commandbar.dataset.workspaceCommandbar = 'true';
    commandbar.setAttribute('role', 'toolbar');
    commandbar.setAttribute('aria-label', 'Workspace commands');
    topline.insertAdjacentElement('afterend', commandbar);
  }

  const newButton = document.querySelector('[data-workspace-new]');
  const nav = document.querySelector('[data-workspace-nav]');
  if (newButton) commandbar.append(newButton);

  let separator = commandbar.querySelector('[data-workspace-command-separator]');
  if (!separator) {
    separator = document.createElement('span');
    separator.className = 'workspace-command-separator';
    separator.dataset.workspaceCommandSeparator = 'true';
    separator.setAttribute('aria-hidden', 'true');
  }
  if (newButton && !separator.isConnected) commandbar.append(separator);
  if (nav) commandbar.append(nav);
}

function installChrome() {
  const topbar = document.querySelector('.topbar');
  const topline = document.querySelector('.topline');
  if (!topbar || !topline) return;
  document.documentElement.classList.add('workspace-chrome');
  installBrandMark();
  installTitleActions(topline);
  installCommandbar(topbar, topline);
  document.documentElement.dataset.workspaceChrome = 'ready';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    installChrome();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:profilechange', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900]) setTimeout(schedule, delay);

window.SidewaysChrome = Object.freeze({ refresh: schedule });

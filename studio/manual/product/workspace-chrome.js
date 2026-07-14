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

function installTitleBrand(topline) {
  let brand = topline.querySelector('[data-workspace-title-brand]');
  if (!brand) {
    brand = document.createElement('div');
    brand.className = 'workspace-title-brand';
    brand.dataset.workspaceTitleBrand = 'true';
    brand.append(icon('window', 'workspace-brand-icon'));
    const label = document.createElement('span');
    label.textContent = 'Sideways';
    brand.append(label);
    topline.prepend(brand);
  }
}

function normalizeStatus(status) {
  if (!status) return;
  const match = String(status.textContent || '').match(/\d[\d,]*/);
  const count = match?.[0] || '0';
  const number = document.createElement('span');
  number.className = 'future-status-number';
  number.textContent = count;
  const contract = document.createElement('span');
  contract.className = 'future-status-contract';
  contract.textContent = ' THINGS';
  status.replaceChildren(number, contract);
  status.dataset.count = count.replace(/,/g, '');
  status.setAttribute('aria-label', `${count} items`);
}

function installTitleActions(topline) {
  let actions = topline.querySelector('[data-workspace-title-actions]');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'workspace-title-actions';
    actions.dataset.workspaceTitleActions = 'true';
    topline.append(actions);
  }

  const liveWork = document.querySelector('[data-sideways-remote-launch]');
  const status = document.getElementById('corpusStatus');
  const profile = document.getElementById('navProfile');
  normalizeStatus(status);
  if (liveWork) actions.prepend(liveWork);
  if (status) actions.append(status);
  if (profile) actions.append(profile);
}

function normalizeFeedCommand() {
  const feed = document.getElementById('navFeed');
  if (!feed) return;
  feed.classList.remove('brand', 'button-plain', 'brand-lockup');
  feed.classList.add('workspace-nav-button');
  const label = feed.querySelector('.workspace-button-label');
  if (label) label.textContent = 'Feed';
  feed.setAttribute('aria-label', 'Feed');
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

  normalizeFeedCommand();
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
  installTitleBrand(topline);
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

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:profilechange', 'sideways:remoteupdate', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900]) setTimeout(schedule, delay);

window.SidewaysChrome = Object.freeze({ refresh: schedule });

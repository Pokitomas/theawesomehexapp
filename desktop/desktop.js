const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const status = $('#desktop-status');
const selectedProgram = $('#selected-program');
const selectedClaim = $('#selected-claim');
const programLinks = $$('.program-list a');

function selectProgram(link) {
  programLinks.forEach(item => item.classList.toggle('selected', item === link));
  selectedProgram.textContent = `${link.dataset.program.toUpperCase()}.EXE`;
  selectedClaim.textContent = link.dataset.program === 'Expo'
    ? 'Public experiment gallery; preserved output is not automatic promotion.'
    : 'Interface prototype; runtime capability remains evidence-bound.';
  status.textContent = `${link.dataset.program} selected. Press Enter or choose Open to launch its separate application.`;
}

programLinks.forEach(link => {
  link.addEventListener('focus', () => selectProgram(link));
  link.addEventListener('pointerdown', () => selectProgram(link));
});
selectProgram(programLinks[0]);

$$('.tree-item').forEach(button => {
  button.addEventListener('click', () => {
    $$('.tree-item').forEach(item => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    const group = button.dataset.group;
    $$('.program-list li').forEach(row => { row.hidden = !row.dataset.groups.split(' ').includes(group); });
    const visible = $$('.program-list li:not([hidden]) a');
    if (visible[0]) selectProgram(visible[0]);
    status.textContent = `${visible.length} programs shown in ${button.textContent.trim()}.`;
  });
});

const startButton = $('#start-button');
const startMenu = $('#start-menu');
startButton.addEventListener('click', () => {
  const opening = startMenu.hidden;
  startMenu.hidden = !opening;
  startButton.setAttribute('aria-expanded', String(opening));
  if (opening) startMenu.querySelector('a')?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !startMenu.hidden) {
    startMenu.hidden = true;
    startButton.setAttribute('aria-expanded', 'false');
    startButton.focus();
  }
});

$$('[data-menu]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.menu === 'help') $('#system-dialog').showModal();
  else status.textContent = `${button.textContent} menu contains no hidden commands in this prototype.`;
}));
$$('[data-window-action]').forEach(button => button.addEventListener('click', () => {
  status.textContent = `${button.getAttribute('aria-label')}: decorative desktop command only; no application state changed.`;
}));

function updateClock() {
  $('#clock').textContent = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date());
}
updateClock();
setInterval(updateClock, 30000);

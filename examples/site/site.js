const cards = [...document.querySelectorAll('.thing')];
const filters = [...document.querySelectorAll('[data-filter]')];

function applyFilter(filter) {
  for (const card of cards) card.hidden = filter !== 'all' && card.dataset.category !== filter;
  for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
}

for (const button of filters) {
  button.addEventListener('click', () => applyFilter(button.dataset.filter));
}

document.querySelector('#surprise')?.addEventListener('click', () => {
  applyFilter('all');
  const index = Math.floor(Math.random() * cards.length);
  const card = cards[index];
  card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('flash');
  requestAnimationFrame(() => card.classList.add('flash'));
});

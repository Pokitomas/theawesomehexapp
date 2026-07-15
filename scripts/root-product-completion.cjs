'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HTML_MARKER = 'data-root-product-completion';
const PROMISE = 'Discover the public world, then keep what matters in a private archive that belongs to you.';
const LINK_MARKER = `<link rel="stylesheet" href="./root-product-completion.css" ${HTML_MARKER}>`;
const SCRIPT_MARKER = `<script src="./root-product-completion.js" ${HTML_MARKER}></script>`;

const ROOT_CSS = `
.sideways-product-promise{box-sizing:border-box;margin:clamp(.75rem,2vw,1.5rem) auto;padding:clamp(1rem,3vw,1.75rem);width:min(72rem,calc(100% - 1.5rem));border:1px solid currentColor;border-radius:1rem;background:Canvas;color:CanvasText;display:grid;gap:.75rem;overflow-wrap:anywhere}
.sideways-product-promise h1{font:inherit;font-size:clamp(1.35rem,4vw,2.35rem);line-height:1.1;margin:0;max-width:25ch}
.sideways-product-promise p{margin:0;max-width:65ch;line-height:1.55}
.sideways-archive-link,.sideways-why-button{box-sizing:border-box;min-height:44px;max-width:100%;display:inline-flex;align-items:center;justify-content:center;border:2px solid currentColor;border-radius:999px;padding:.65rem 1rem;background:CanvasText;color:Canvas;text-decoration:none;font:inherit;font-weight:700;white-space:normal;text-align:center;cursor:pointer}
.sideways-archive-link{justify-self:start}
.sideways-archive-link:focus-visible,.sideways-why-button:focus-visible{outline:4px solid Highlight;outline-offset:3px}
.sideways-explanation-wrap{box-sizing:border-box;display:grid;gap:.55rem;margin-top:.75rem;max-width:100%}
.sideways-why-button{justify-self:start;background:transparent;color:inherit}
.sideways-rank-explanation{box-sizing:border-box;border-left:4px solid currentColor;padding:.75rem 1rem;margin:0;max-width:70ch;overflow-wrap:anywhere;background:color-mix(in srgb,CanvasText 6%,Canvas)}
.sideways-rank-explanation[hidden]{display:none}
.sideways-rank-explanation dl{display:grid;grid-template-columns:minmax(8rem,12rem) minmax(0,1fr);gap:.5rem .75rem;margin:0}
.sideways-rank-explanation dt{font-weight:800}
.sideways-rank-explanation dd{margin:0;min-width:0}
@media(max-width:35rem){.sideways-product-promise{width:calc(100% - 1rem);margin:.5rem}.sideways-rank-explanation dl{grid-template-columns:1fr}.sideways-rank-explanation dd{margin-bottom:.55rem}}
@media(prefers-reduced-motion:reduce){.sideways-product-promise *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const ROOT_JS = `
'use strict';
(() => {
  const promiseText = ${JSON.stringify(PROMISE)};
  const marker = 'sideways-product-promise';
  const cardSelector = '#feed .post, #feed article, main [data-post-id], main article';
  const clean = value => String(value ?? '').trim();
  const displayed = (card, keys) => {
    for (const key of keys) {
      const value = clean(card.dataset?.[key]);
      if (value && Number.isFinite(Number(value))) return Number(value).toFixed(3);
    }
    return '';
  };
  function mountPromise() {
    if (document.getElementById(marker)) return;
    const section = document.createElement('section');
    section.id = marker;
    section.className = 'sideways-product-promise';
    section.setAttribute('aria-labelledby', marker + '-title');
    const title = document.createElement('h1');
    title.id = marker + '-title';
    title.textContent = promiseText;
    const detail = document.createElement('p');
    detail.textContent = 'Read public recommendations here. Your saved history, imports, and recovery copies stay in the private archive on your device unless you deliberately publish something.';
    const link = document.createElement('a');
    link.className = 'sideways-archive-link';
    link.href = './manual/';
    link.textContent = 'Open your private archive';
    link.dataset.primaryArchive = 'true';
    section.append(title, detail, link);
    const target = document.querySelector('main') || document.body;
    target.prepend(section);
  }
  function explanationRows(card) {
    const source = clean(card.dataset?.eligibilitySource || card.dataset?.source || card.dataset?.feed) || 'the current public source pool';
    const base = displayed(card, ['baseScore', 'score', 'rankScore']);
    const lateral = displayed(card, ['lateralValue', 'diversityScore']);
    const posterior = displayed(card, ['posteriorAdvantage', 'posterior']);
    const exploration = displayed(card, ['explorationNoise', 'exploration']);
    const scoreText = [base && 'base ' + base, lateral && 'lateral ' + lateral, posterior && 'posterior ' + posterior, exploration && 'exploration ' + exploration].filter(Boolean).join('; ');
    return [
      ['Source eligibility', 'This item passed ' + source + ' eligibility before ranking. Eligibility selects the public candidate pool; it does not read your private archive.'],
      ['Score contributions', scoreText ? 'Values exposed by this card: ' + scoreText + '.' : 'The shipped kernel combines relevance, affinity, and engagement. This static card does not expose invented per-item numbers.'],
      ['Saturation and diversity', 'Repeated sources or topics can be downweighted at the slate level so one cluster does not occupy every position.'],
      ['Why it is present', 'It passed eligibility and remained in the selected slate after score, saturation, diversity, and bounded exploration effects. This explanation grants no publishing or moderation authority.']
    ];
  }
  function decorateCard(card, index) {
    if (!(card instanceof HTMLElement) || card.closest('#' + marker) || card.dataset.rootExplanation === 'true') return;
    if (!card.querySelector('h1,h2,h3,.title,[data-title],p')) return;
    card.dataset.rootExplanation = 'true';
    const wrap = document.createElement('div');
    wrap.className = 'sideways-explanation-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sideways-why-button';
    button.textContent = 'Why this is here';
    button.dataset.rootExplanationControl = 'true';
    const panel = document.createElement('section');
    panel.className = 'sideways-rank-explanation';
    panel.hidden = true;
    panel.id = 'sideways-rank-explanation-' + index;
    panel.setAttribute('aria-label', 'Recommendation explanation');
    const list = document.createElement('dl');
    for (const [term, value] of explanationRows(card)) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    panel.append(list);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) panel.focus?.({ preventScroll: true });
    });
    wrap.append(button, panel);
    const actionHost = card.querySelector('.actions,footer,[data-actions]') || card;
    actionHost.append(wrap);
  }
  function decorateAll() {
    mountPromise();
    [...document.querySelectorAll(cardSelector)].forEach(decorateCard);
  }
  function start() {
    decorateAll();
    const observer = new MutationObserver(decorateAll);
    observer.observe(document.body, { childList: true, subtree: true });
    window.SidewaysRootProduct = Object.freeze({ refresh: decorateAll, promise: promiseText });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
`;

function injectOnce(source, marker, before) {
  if (source.includes(marker)) return source;
  if (!source.includes(before)) throw new Error(`Root product completion cannot find ${before}.`);
  return source.replace(before, `  ${marker}\n${before}`);
}

function applyRootCompletion({ outputDir = 'dist' } = {}) {
  const root = path.resolve(outputDir);
  const indexPath = path.join(root, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`Root product index is missing: ${indexPath}`);
  let html = fs.readFileSync(indexPath, 'utf8');
  html = injectOnce(html, LINK_MARKER, '</head>');
  html = injectOnce(html, SCRIPT_MARKER, '</body>');
  fs.writeFileSync(indexPath, html);
  fs.writeFileSync(path.join(root, 'root-product-completion.css'), ROOT_CSS.trimStart());
  fs.writeFileSync(path.join(root, 'root-product-completion.js'), ROOT_JS.trimStart());
  return {
    schema: 'sideways-root-product-completion/v1',
    outputDir: root,
    index: indexPath,
    assets: ['root-product-completion.css', 'root-product-completion.js'],
    promise: PROMISE,
    directArchive: './manual/',
    sharedMutation: false
  };
}

function main() {
  const receipt = applyRootCompletion({ outputDir: process.argv[2] || 'dist' });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = { HTML_MARKER, PROMISE, ROOT_CSS, ROOT_JS, applyRootCompletion };

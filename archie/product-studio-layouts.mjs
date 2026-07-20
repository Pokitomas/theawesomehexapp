export function layoutMarkup(layout, copy) {
  const form = `<form class="capture" id="capture"><label>${copy.fields[0]}<input id="field0" required maxlength="120"></label><label>${copy.fields[1]}<input id="field1" maxlength="180"></label><label>${copy.fields[2]}<textarea id="field2" maxlength="600"></textarea></label><button type="submit">${copy.action}</button></form>`;
  const list = `<section class="collection"><div class="collection-head"><strong>${copy.noun}</strong><input id="search" type="search" placeholder="Filter ${copy.noun}"></div><div id="items" class="items"></div></section>`;
  const stats = `<section class="stats"><article><strong id="total">0</strong><span>Total</span></article><article><strong id="active">0</strong><span>Active</span></article><article><strong id="done">0</strong><span>Done</span></article></section>`;
  const layouts = {
    'split-workbench': `<div class="split">${form}${list}</div>`,
    'card-mosaic': `${form}<div class="mosaic-wrap">${stats}${list}</div>`,
    ledger: `${form}${stats}<div class="ledger-wrap">${list}</div>`,
    timeline: `${form}<div class="timeline-wrap">${list}</div>`,
    'command-deck': `${stats}<div class="deck">${form}${list}</div>`,
    canvas: `<div class="canvas">${form}${list}</div>`,
    'list-detail': `<div class="master-detail">${list}<aside class="detail"><span>Selected ${copy.singular}</span><strong id="selectedTitle">Nothing selected</strong><p id="selectedBody">Add or choose an item to inspect it here.</p></aside></div>${form}`,
    kiosk: `<div class="kiosk">${form}${stats}${list}</div>`,
    board: `${form}${stats}<div class="board-wrap">${list}</div>`,
    'stacked-flow': `<div class="flow">${form}${stats}${list}</div>`,
  };
  return layouts[layout] || layouts['stacked-flow'];
}

export function layoutCss(layout) {
  const common = `.split{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(320px,1.25fr);gap:18px}.mosaic-wrap{display:grid;gap:18px}.ledger-wrap .item{display:grid;grid-template-columns:minmax(130px,1fr) minmax(100px,.55fr) 90px 44px;align-items:center}.timeline-wrap .item{position:relative;margin-left:22px}.timeline-wrap .item:before{content:"";position:absolute;left:-22px;top:13px;width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid var(--panel)}.timeline-wrap .items{border-left:2px solid var(--line);padding-left:12px}.deck{display:grid;grid-template-columns:1fr 1.4fr;gap:18px}.canvas{position:relative;min-height:520px;border:1px dashed var(--line);padding:18px}.canvas .capture{width:min(360px,100%)}.canvas .collection{margin:28px 0 0 auto;width:min(620px,92%);transform:rotate(-.4deg)}.master-detail{display:grid;grid-template-columns:minmax(250px,.8fr) minmax(260px,1.2fr);gap:18px}.detail{border:1px solid var(--line);background:var(--panel);padding:24px;min-height:280px}.detail span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.12em}.detail strong{display:block;font-size:28px;margin-top:12px}.detail p{color:var(--muted);line-height:1.6}.kiosk{width:min(640px,100%);margin:auto;text-align:center}.kiosk .capture{text-align:left}.board-wrap .items{display:grid;grid-template-columns:repeat(3,minmax(190px,1fr));align-items:start}.board-wrap .item:nth-child(3n+1){grid-column:1}.board-wrap .item:nth-child(3n+2){grid-column:2}.board-wrap .item:nth-child(3n){grid-column:3}.flow{display:grid;gap:22px}`;
  return `${common}\nbody[data-layout="${layout}"] .collection{outline-offset:4px}`;
}

export function densityCss(density) {
  return density === 'compact' ? ':root{--space:8px;--control:36px}.item{padding:8px}.shell{padding:12px}' : density === 'spacious' ? ':root{--space:22px;--control:52px}.item{padding:20px}.shell{padding:clamp(18px,5vw,56px)}' : ':root{--space:14px;--control:44px}.item{padding:13px}.shell{padding:clamp(14px,3vw,34px)}';
}

export function motionCss(motion) {
  if (motion === 'still') return '*{scroll-behavior:auto!important;animation:none!important;transition:none!important}';
  if (motion === 'expressive') return '.item{animation:arrive .48s cubic-bezier(.2,.9,.2,1) both}.item:hover{transform:translateY(-4px) rotate(.2deg)}@keyframes arrive{from{opacity:0;transform:translateY(18px) scale(.97)}}';
  return '.item,button{transition:transform .16s ease,opacity .16s ease,background .16s ease}.item:hover{transform:translateY(-2px)}';
}

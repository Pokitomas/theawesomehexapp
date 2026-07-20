export const PRODUCT_ARCHETYPES = Object.freeze([
  'tracker', 'dashboard', 'planner', 'editor', 'catalog',
  'communication', 'learning', 'utility', 'field', 'decision'
]);
export const LAYOUT_FAMILIES = Object.freeze([
  'split-workbench', 'card-mosaic', 'ledger', 'timeline', 'command-deck',
  'canvas', 'list-detail', 'kiosk', 'board', 'stacked-flow'
]);
export const VISUAL_LANGUAGES = Object.freeze([
  'editorial', 'industrial', 'playful', 'clinical', 'brutalist', 'neo-retro',
  'calm', 'craft', 'cinematic', 'high-contrast', 'terminal', 'glass'
]);

export const ARCHETYPE_COPY = Object.freeze({
  tracker: { noun: 'items', singular: 'item', action: 'Add item', title: 'Progress tracker', fields: ['Name', 'Status', 'Note'] },
  dashboard: { noun: 'signals', singular: 'signal', action: 'Add signal', title: 'Signal dashboard', fields: ['Metric', 'Value', 'Context'] },
  planner: { noun: 'milestones', singular: 'milestone', action: 'Add milestone', title: 'Action planner', fields: ['Milestone', 'When', 'Owner'] },
  editor: { noun: 'drafts', singular: 'draft', action: 'Save draft', title: 'Working editor', fields: ['Title', 'Draft', 'Tag'] },
  catalog: { noun: 'entries', singular: 'entry', action: 'Add entry', title: 'Local catalog', fields: ['Name', 'Category', 'Details'] },
  communication: { noun: 'threads', singular: 'thread', action: 'Start thread', title: 'Message desk', fields: ['Person', 'Subject', 'Draft'] },
  learning: { noun: 'lessons', singular: 'lesson', action: 'Add lesson', title: 'Learning loop', fields: ['Topic', 'Practice', 'Confidence'] },
  utility: { noun: 'runs', singular: 'run', action: 'Run tool', title: 'One-purpose utility', fields: ['Input', 'Rule', 'Output'] },
  field: { noun: 'captures', singular: 'capture', action: 'Capture note', title: 'Field capture', fields: ['Observation', 'Location', 'Evidence'] },
  decision: { noun: 'options', singular: 'option', action: 'Add option', title: 'Decision table', fields: ['Option', 'Score', 'Tradeoff'] },
});

export const STYLE_TOKENS = Object.freeze({
  editorial: { bg: '#f5f1e8', panel: '#fffdf8', ink: '#161412', muted: '#756d62', accent: '#9d2f23', line: '#cfc3b2', radius: '2px', shadow: '0 18px 50px rgba(50,35,20,.12)', font: 'Georgia, Cambria, serif', display: 'Georgia, Cambria, serif' },
  industrial: { bg: '#171a19', panel: '#222625', ink: '#eff4ef', muted: '#9aa59f', accent: '#f3b61f', line: '#59615d', radius: '3px', shadow: '0 15px 30px rgba(0,0,0,.28)', font: 'Arial, Helvetica, sans-serif', display: 'Arial Black, Arial, sans-serif' },
  playful: { bg: '#fff4d8', panel: '#ffffff', ink: '#242039', muted: '#756f89', accent: '#ff5c8a', line: '#342d57', radius: '22px', shadow: '8px 8px 0 #342d57', font: 'Trebuchet MS, system-ui, sans-serif', display: 'Trebuchet MS, system-ui, sans-serif' },
  clinical: { bg: '#eef6f7', panel: '#ffffff', ink: '#18343b', muted: '#657f85', accent: '#0a8c93', line: '#bad3d6', radius: '10px', shadow: '0 16px 42px rgba(27,73,80,.10)', font: 'Arial, Helvetica, sans-serif', display: 'Arial, Helvetica, sans-serif' },
  brutalist: { bg: '#e8ff31', panel: '#ffffff', ink: '#000000', muted: '#252525', accent: '#ff3b00', line: '#000000', radius: '0px', shadow: '7px 7px 0 #000', font: 'Arial, Helvetica, sans-serif', display: 'Impact, Arial Black, sans-serif' },
  'neo-retro': { bg: '#008080', panel: '#c0c0c0', ink: '#000000', muted: '#303030', accent: '#000080', line: '#ffffff', radius: '0px', shadow: '3px 3px 0 #000', font: 'Tahoma, Arial, sans-serif', display: 'Tahoma, Arial, sans-serif' },
  calm: { bg: '#edf1ec', panel: '#f9fbf7', ink: '#26332c', muted: '#718077', accent: '#537966', line: '#cad5cc', radius: '18px', shadow: '0 18px 48px rgba(50,75,58,.08)', font: 'system-ui, -apple-system, sans-serif', display: 'system-ui, -apple-system, sans-serif' },
  craft: { bg: '#e9ddc8', panel: '#fffaf0', ink: '#392c22', muted: '#856f5d', accent: '#9d4b32', line: '#bca98d', radius: '8px', shadow: '0 16px 34px rgba(73,48,28,.14)', font: 'Georgia, serif', display: 'Georgia, serif' },
  cinematic: { bg: '#07080b', panel: '#11131a', ink: '#f8f3e8', muted: '#999bab', accent: '#ef3f2f', line: '#343641', radius: '4px', shadow: '0 28px 80px rgba(0,0,0,.55)', font: 'Arial, Helvetica, sans-serif', display: 'Arial Black, Arial, sans-serif' },
  'high-contrast': { bg: '#000000', panel: '#111111', ink: '#ffffff', muted: '#d3d3d3', accent: '#ffff00', line: '#ffffff', radius: '6px', shadow: 'none', font: 'Arial, Helvetica, sans-serif', display: 'Arial Black, Arial, sans-serif' },
  terminal: { bg: '#020704', panel: '#07140c', ink: '#a8ffbf', muted: '#5ea970', accent: '#ffffff', line: '#2f7841', radius: '0px', shadow: '0 0 30px rgba(34,255,93,.08)', font: 'ui-monospace, SFMono-Regular, Consolas, monospace', display: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
  glass: { bg: '#101728', panel: 'rgba(255,255,255,.11)', ink: '#ffffff', muted: '#bec8dc', accent: '#8de8ff', line: 'rgba(255,255,255,.28)', radius: '24px', shadow: '0 25px 80px rgba(0,0,0,.30)', font: 'system-ui, -apple-system, sans-serif', display: 'system-ui, -apple-system, sans-serif' },
});

export const LAYOUT_DISTANCE = Object.freeze({
  'split-workbench': { axis: 'horizontal', family: 'workspace' },
  'card-mosaic': { axis: 'grid', family: 'collection' },
  ledger: { axis: 'rows', family: 'data' },
  timeline: { axis: 'time', family: 'sequence' },
  'command-deck': { axis: 'grid', family: 'operations' },
  canvas: { axis: 'spatial', family: 'workspace' },
  'list-detail': { axis: 'horizontal', family: 'navigation' },
  kiosk: { axis: 'focus', family: 'single-task' },
  board: { axis: 'columns', family: 'workflow' },
  'stacked-flow': { axis: 'vertical', family: 'sequence' },
});

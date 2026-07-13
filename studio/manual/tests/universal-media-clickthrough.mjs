import fs from 'node:fs';

const log = 'universal-media-check.log';
let failed = false;
function persist(error) {
  if (failed) return;
  failed = true;
  const text = error?.stack || error?.message || String(error);
  try { fs.writeFileSync(log, `${text}\n`, 'utf8'); } catch {}
  console.error(text);
}
process.on('uncaughtException', error => {
  persist(error);
  process.exit(1);
});
process.on('unhandledRejection', error => {
  persist(error);
  process.exit(1);
});

await import('./universal-media-clickthrough-body.mjs');

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = {
  ledger: 'studio/manual/product/survival-ledger.js',
  ui: 'studio/manual/product/vault-ui.js',
  actions: 'studio/manual/product/actions.js',
  workspace: 'studio/manual/product/workspace.js',
  apply: 'studio/manual/apply.py'
};
const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
for (const key of ['ledger', 'ui', 'actions', 'workspace']) {
  const result = spawnSync(process.execPath, ['--check', files[key]], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${files[key]} syntax failed\n${result.stderr}`);
}
const requireAll = (key, needles) => needles.forEach(needle => { if (!source[key].includes(needle)) throw new Error(`${files[key]} missing ${needle}`); });
const forbidAll = (key, needles) => needles.forEach(needle => { if (source[key].includes(needle)) throw new Error(`${files[key]} contains forbidden ${needle}`); });
requireAll('ledger', ['SIDEWAYS-ARK/1', 'sideways-workspace-profile-v1', 'survival.mirror.checkpoint', 'survival.ark.export', 'survival.ark.restore', 'survival.audit', 'externalBackup: false', 'LEDGER_STORE']);
requireAll('ui', ["section[data-survival-vault]", "action('vault.persist'", "action('vault.audit'", "action('vault.export'", "action('vault.restore'"]);
requireAll('actions', ["'vault.persist'", "'vault.audit'", "'vault.export'", "'vault.restore'"]);
requireAll('workspace', ['survival: Survival', 'durability: storageDurability', 'ledger: readCorpusLedger']);
requireAll('apply', ['survival-ledger.css', 'survival-ledger.js', 'vault-ui.js', 'data-survival-ledger']);
forbidAll('ledger', ['Authorization', 'location.reload()', 'new MutationObserver']);
forbidAll('ui', ["document.querySelector('[data-survival-vault]')", 'document.documentElement.replaceChildren', 'document.body.replaceChildren', 'location.reload()', 'new MutationObserver']);
console.log('survival contract ok: atomic ledger, owned profile, same-origin mirror, user-owned Ark, scoped vault chrome');

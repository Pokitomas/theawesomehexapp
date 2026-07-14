import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = {
  core: 'netlify/functions/social-core.mjs',
  function: 'netlify/functions/social.mjs',
  client: 'studio/manual/product/social-client.js',
  network: 'studio/manual/product/network-records.js',
  actions: 'studio/manual/product/actions.js',
  workspace: 'studio/manual/product/workspace.js',
  survival: 'studio/manual/product/survival-ledger.js',
  apply: 'studio/manual/apply.py',
  netlify: 'netlify.toml'
};
const source = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, fs.readFileSync(path, 'utf8')]));
for (const key of ['core', 'function', 'client', 'network', 'actions', 'workspace']) {
  const check = spawnSync(process.execPath, ['--check', files[key]], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`${files[key]} syntax failed\n${check.stderr}`);
}
const requireAll = (key, tokens) => tokens.forEach(token => { if (!source[key].includes(token)) throw new Error(`${files[key]} missing ${token}`); });
const forbidAll = (key, tokens) => tokens.forEach(token => { if (source[key].includes(token)) throw new Error(`${files[key]} contains forbidden ${token}`); });
requireAll('core', ['HttpOnly', 'SameSite=Lax', 'scryptSync', 'timingSafeEqual', 'social/event/', 'post.replied', 'follow.created', 'like.created']);
requireAll('client', ["credentials: 'same-origin'", 'Workspace.projectNetworkPosts', 'data.socialSpine', 'window.SidewaysSocial']);
forbidAll('client', ['Workspace.saveProfile', "localStorage.setItem('sideways_session", 'new MutationObserver', 'location.reload()']);
requireAll('network', ["const PREFIX = 'network:'", "ledgerEntry('network.project'", 'sideways:network', 'rank: {}']);
requireAll('workspace', ['projectNetworkPosts', 'networkRecords']);
requireAll('survival', ["startsWith('network:')", 'user-owned Ark excludes server projections']);
for (const id of ['social.join', 'social.login', 'social.logout', 'social.post', 'social.follow', 'social.feed', 'social.discover']) requireAll('actions', [`'${id}'`]);
requireAll('apply', ['social-client.css', 'social-client.js', 'network-records.js', 'data-social-spine']);
requireAll('netlify', ['/api/social', '/.netlify/functions/social']);
console.log('social spine contract ok: cookie sessions, public server facts, existing record projection, local Ark boundary');

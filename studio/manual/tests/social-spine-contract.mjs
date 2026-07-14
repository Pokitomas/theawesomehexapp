import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const required = [
  'netlify/functions/social-core.mjs',
  'netlify/functions/social-postgres-store.mjs',
  'netlify/functions/social-schema.mjs',
  'netlify/functions/social.mjs',
  'migrations/001_social_spine.sql',
  'studio/manual/product/network/index.js',
  'studio/manual/product/network/schema.js',
  'studio/manual/product/network/sync.js',
  'studio/manual/product/network-ui.js',
  'studio/manual/product/network.css'
];
for (const file of required) if (!fs.existsSync(path.join(root, file))) throw new Error(`missing ${file}`);

const schema = read('migrations/001_social_spine.sql');
for (const table of ['users', 'profiles', 'sessions', 'posts', 'follows', 'reactions', 'events']) {
  if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\b`, 'i').test(schema)) throw new Error(`missing ${table} table`);
}
for (const choices of [['PRIMARY KEY (follower_id, followed_id)', 'UNIQUE (follower_id, followed_id)'], ['PRIMARY KEY (actor_id, post_id, kind)', 'UNIQUE (actor_id, post_id, kind)'], ['UNIQUE (actor_id, idempotency_key)']]) {
  if (!choices.some(constraint => schema.includes(constraint))) throw new Error(`missing constraint ${choices.join(' or ')}`);
}
const core = read('netlify/functions/social-core.mjs');
for (const route of ['/auth/signup', '/auth/login', '/auth/logout', '/auth/refresh', '/me', '/me/profile', '/posts', '/feed/following']) {
  if (!core.includes(route)) throw new Error(`missing endpoint ${route}`);
}
if (!core.includes("segments[2] === 'follow'") || !core.includes("segments[2] === 'like'") || !core.includes("segments[2] === 'thread'")) throw new Error('social graph/thread routes missing');
const redirects = read('netlify.toml');
if (redirects.includes('from = "/api/profile"')) throw new Error('legacy device profile remains a second server identity authority');
if (!redirects.includes('from = "/api/me/*"')) throw new Error('account-owned public profile route missing');
const postgres = read('netlify/functions/social-postgres-store.mjs');
if (!postgres.includes('safeEventUser(bundle)') || /response:\s*bundle/.test(postgres)) throw new Error('persistent events can retain internal user credentials');
const record = read('studio/manual/product/network/schema.js');
for (const field of ["type: 'social'", "source: 'Sideways network'", 'author:', 'published:', 'engagement:', 'rank: {}']) {
  if (!record.includes(field)) throw new Error(`network projection missing ${field}`);
}
const sync = read('studio/manual/product/network/sync.js');
if (!sync.includes('startsWith(PREFIX)') || !sync.includes("localRole: 'offline-cache'")) throw new Error('network cache boundary is not explicit');
const apply = read('studio/manual/imports/apply.py');
if (!apply.includes('network-ui.js') || !apply.includes('network.css') || !apply.includes('PRODUCT / "network"')) throw new Error('manual product does not install network adapter');
const all = required.map(read).join('\n');
if (/\bReact\b|createRoot\s*\(/.test(all)) throw new Error('React rewrite introduced');
if (/function\s+(sigmoid|weightedMean|thompson|rankCandidates)\b/.test(read('studio/manual/product/network-ui.js'))) throw new Error('network layer copied ranking kernel');
for (const stale of ['studio/manual/product/social-client.js', 'studio/manual/product/social-client.css', 'studio/manual/product/network-records.js']) if (fs.existsSync(path.join(root, stale))) throw new Error(`duplicate social architecture remains: ${stale}`);
console.log(JSON.stringify({ socialSpine: true, authoritativeServer: true, onePublicIdentityAuthority: true, secretFreeEvents: true, localPrivateWorkspace: true, oneRecordSchema: true, reactRewrite: false }));

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const frontier = read('studio/manual/product/frontier.js');
const starterPack = read('studio/manual/product/starter-pack.js');
const actions = read('studio/manual/product/actions.js');
const studio = read('studio/manual/product/studio.js');
const copy = read('studio/manual/product/copy.js');
const apply = read('studio/manual/apply.py');
const profileFn = read('netlify/functions/profile.mjs');
const starterFn = read('netlify/functions/starter.mjs');

const requirements = [
  [frontier.includes("backend('/api/profile'"), 'profile writes through the backend'],
  [frontier.includes("backend('/api/starter'"), 'starter pack prefers the backend without a file chooser'],
  [frontier.includes('starterUnavailable') && frontier.includes("source: 'built-in'") && frontier.includes('starterPack(profile)'), 'static Drop deployments fall back inside the starter action'],
  [!copy.includes('window.fetch =') && !copy.includes('installStaticStarterFallback'), 'product copy does not monkey-patch global networking'],
  [starterPack.includes('export function starterPack') && starterFn.includes("from '../../studio/manual/product/starter-pack.js'"), 'browser and backend share one starter pack'],
  [studio.includes("actionWithIcon('profile.start'") && studio.includes('startFromEmpty'), 'the empty-state instant button calls the starter instead of the file picker'],
  [frontier.includes('PENDING_PROFILE_KEY') && frontier.includes('syncPendingProfile'), 'offline profile saves retry against the real backend'],
  [frontier.includes("'post.like'"), 'Like is a real action'],
  [frontier.includes("'post.reply'"), 'Reply is a real action'],
  [frontier.includes("'post.remix'"), 'Remix is a real action'],
  [actions.includes("'profile.start'"), 'starter button belongs to the action contract'],
  [actions.includes("'post.like'"), 'Like belongs to the action contract'],
  [apply.includes('frontier.css') && apply.includes('frontier.js') && apply.includes('starter-pack.js'), 'overlay builder owns the frontier and starter layers'],
  [profileFn.includes("getStore('sideways-profiles')"), 'profiles have a durable Netlify Blobs store'],
  [profileFn.includes('new Response(') && starterFn.includes('new Response('), 'backend functions use the deployed Request/Response contract'],
  [!profileFn.includes('deviceId, updatedAt') && !profileFn.includes('{ ...profile, deviceId }'), 'backend stores hashed profile ownership rather than raw device identifiers'],
  [starterFn.includes('sideways-profiles'), 'starter pack reads the backend profile'],
  [!frontier.includes('Proof post') && !copy.includes('Proof post') && !starterPack.includes('Proof post'), 'temporary proof posts do not ship in product code']
];

const failed = requirements.filter(([passed]) => !passed).map(([, label]) => label);
if (failed.length) throw new Error(`frontier contract failed: ${failed.join('; ')}`);
console.log(JSON.stringify({ passed: requirements.map(([, label]) => label) }, null, 2));

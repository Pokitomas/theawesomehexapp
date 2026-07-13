import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.join(__dirname, '..', 'product');
const workspaceSrc = fs.readFileSync(path.join(productDir, 'workspace.js'), 'utf8');
const socialSrc = fs.readFileSync(path.join(productDir, 'social.js'), 'utf8');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(candidate => fs.existsSync(candidate));
if (!executablePath) throw new Error('no Chromium found');

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async ({ workspaceSrc, socialSrc }) => {
  const out = { checks: [], events: [] };
  const check = (name, pass, detail = '') => out.checks.push({ name, pass, detail });

  await Promise.all(['sideways-social-v1', 'sideways-workspace-meta-v1'].map(name => new Promise(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  })));
  localStorage.clear();

  await new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-social-v1', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const posts = db.createObjectStore('posts', { keyPath: 'id' });
      posts.createIndex('createdAt', 'createdAt');
      posts.createIndex('placeId', 'placeId');
      const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
      drafts.createIndex('updatedAt', 'updatedAt');
      const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      events.createIndex('actionId', 'actionId');
      events.createIndex('at', 'at');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('posts', 'readwrite');
      tx.objectStore('posts').put({ id: 'legacy-1', text: 'legacy record', createdAt: '2025-01-01T00:00:00.000Z' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

  window.addEventListener('sideways:workspacechange', event => out.events.push(event.detail));
  const mod = await import(URL.createObjectURL(new Blob([workspaceSrc], { type: 'text/javascript' })));
  const ws = mod.createWorkspaceBackend();
  await ws.ready();

  check('window backend auto-installs', typeof window.SidewaysWorkspace?.ready === 'function', typeof window.SidewaysWorkspace);
  const initialPlaces = await ws.listPlaces();
  check('default Places are stable', initialPlaces.map(place => place.id).join('|') === 'everything|later|archive', JSON.stringify(initialPlaces));
  check('Later is persistent while Everything and Archive are virtual', initialPlaces.find(place => place.id === 'later')?.virtual === false && initialPlaces.find(place => place.id === 'everything')?.virtual === true && initialPlaces.find(place => place.id === 'archive')?.virtual === true, JSON.stringify(initialPlaces));

  const migrated = await ws.getEntity('legacy-1');
  check('legacy entity migrates without data loss', migrated.text === 'legacy record' && migrated.placeId === 'everything' && migrated.archived === false && migrated.updatedAt, JSON.stringify(migrated));

  const alpha = await ws.createPlace({ name: 'Alpha', icon: 'folder', color: '#9cc7ff' });
  const beta = await ws.createPlace({ name: 'Beta', icon: 'folder', color: '#ffd66b' });
  await ws.renamePlace(alpha.id, 'Field Notes');
  const reordered = await ws.reorderPlaces(['everything', beta.id, alpha.id, 'later', 'archive']);
  check('custom Places receive durable IDs', alpha.id.startsWith('place-') && beta.id.startsWith('place-'));
  check('Places reorder durably', reordered.map(place => place.id).slice(0, 5).join('|') === `everything|${beta.id}|${alpha.id}|later|archive`, JSON.stringify(reordered));

  await ws.updateEntity('legacy-1', { text: 'migrated and edited' });
  await ws.moveEntity('legacy-1', alpha.id);
  const inAlpha = await ws.listEntities({ placeId: alpha.id });
  check('entities update and move into custom Places', inAlpha.length === 1 && inAlpha[0].text === 'migrated and edited', JSON.stringify(inAlpha));

  await ws.archiveEntity('legacy-1');
  const archived = await ws.listArchived();
  check('Archive is a real queryable location', archived.length === 1 && archived[0].id === 'legacy-1', JSON.stringify(archived));
  check('archived entity leaves Everything', !(await ws.listEntities({ placeId: 'everything' })).some(entity => entity.id === 'legacy-1'));
  await ws.restoreEntity('legacy-1');
  check('restore returns entity to its Place', (await ws.listEntities({ placeId: alpha.id })).some(entity => entity.id === 'legacy-1'));

  ws.setActivePlace(alpha.id);
  check('active Place persists synchronously', ws.getActivePlace() === alpha.id, ws.getActivePlace());

  await ws.saveDraft({ id: 'draft-1', text: 'atomic draft', placeId: beta.id });
  const published = await ws.publishDraft('draft-1', { id: 'post-2', text: 'published', placeId: beta.id, author: { name: 'Kai' } });
  check('publish preserves requested entity and Place', published.id === 'post-2' && published.placeId === beta.id, JSON.stringify(published));
  check('publish removes draft atomically', (await ws.listDrafts()).length === 0, JSON.stringify(await ws.listDrafts()));

  await ws.saveDraft({ id: 'draft-undo', text: 'restore me', placeId: 'later' });
  await ws.deleteDraft('draft-undo');
  check('draft deletion is durable', !(await ws.listDrafts()).some(draft => draft.id === 'draft-undo'));
  const undoDraft = await ws.undo();
  check('draft deletion is undoable', undoDraft.restored && (await ws.listDrafts()).some(draft => draft.id === 'draft-undo'), JSON.stringify(undoDraft));

  const snapshot = await ws.exportSnapshot();
  check('snapshot exports Places posts drafts and active Place', snapshot.places.length >= 5 && snapshot.posts.length === 2 && snapshot.drafts.length === 1 && snapshot.activePlace === alpha.id, JSON.stringify(snapshot));

  const beforePlaceDelete = await ws.getEntity('legacy-1');
  const deletePlaceResult = await ws.deletePlace(alpha.id);
  const afterPlaceDelete = await ws.getEntity('legacy-1');
  check('deleting a Place never orphans entities', beforePlaceDelete.placeId === alpha.id && deletePlaceResult.movedEntities === 1 && afterPlaceDelete.placeId === 'everything', JSON.stringify({ deletePlaceResult, afterPlaceDelete }));
  check('deleted Place leaves navigation', !(await ws.listPlaces()).some(place => place.id === alpha.id));
  const undoPlace = await ws.undo();
  check('Place deletion undo restores Place and entity membership', undoPlace.restored && (await ws.listPlaces()).some(place => place.id === alpha.id) && (await ws.getEntity('legacy-1')).placeId === alpha.id, JSON.stringify(undoPlace));

  await ws.deleteEntity('legacy-1');
  check('entity deletion is durable', !(await ws.getEntity('legacy-1')));
  const undoEntity = await ws.undo();
  check('entity deletion undo restores exact entity', undoEntity.restored && (await ws.getEntity('legacy-1')).id === 'legacy-1', JSON.stringify(undoEntity));

  const throwaway = await ws.createPlace({ name: 'Throwaway' });
  await ws.updateEntity('post-2', { text: 'mutated after snapshot' });
  await ws.importSnapshot(snapshot);
  const restoredPlaces = await ws.listPlaces();
  const restoredPosts = await ws.listEntities({ placeId: 'everything' });
  const restoredDrafts = await ws.listDrafts();
  check('snapshot import removes later throwaway Places', !restoredPlaces.some(place => place.id === throwaway.id), JSON.stringify(restoredPlaces));
  check('snapshot import restores custom Places', restoredPlaces.some(place => place.id === alpha.id));
  check('snapshot import restores every post', restoredPosts.length === 2, JSON.stringify(restoredPosts));
  check('snapshot import restores drafts', restoredDrafts.some(draft => draft.id === 'draft-undo'), JSON.stringify(restoredDrafts));
  check('snapshot import restores active Place', ws.getActivePlace() === alpha.id, ws.getActivePlace());
  check('snapshot import restores entity contents', (await ws.getEntity('post-2')).text === 'published', JSON.stringify(await ws.getEntity('post-2')));

  check('workspace emits post-transaction typed events', out.events.length >= 16 && out.events.every(event => event && typeof event.type === 'string'), JSON.stringify(out.events));

  try {
    const stubActions = `export function actionButton(){const b=document.createElement('button');b.type='button';return b}export function bindAction(){}export function emitAction(){}`;
    const stubUrl = URL.createObjectURL(new Blob([stubActions], { type: 'text/javascript' }));
    const socialPatched = socialSrc.replace("from './actions.js'", `from '${stubUrl}'`);
    await import(URL.createObjectURL(new Blob([socialPatched], { type: 'text/javascript' })));
    check('current social.js imports cleanly against workspace.js', true);
  } catch (error) {
    check('current social.js imports cleanly against workspace.js', false, error.message);
  }

  out.allPassed = out.checks.every(item => item.pass);
  return out;
}, { workspaceSrc, socialSrc });

console.log(JSON.stringify(result, null, 2));
console.log('PAGE ERRORS:', JSON.stringify(pageErrors));
if (!result.allPassed || pageErrors.length) process.exitCode = 1;
await browser.close();

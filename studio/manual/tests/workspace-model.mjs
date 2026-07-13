// Real-browser test of createWorkspaceBackend() against the interface
// social.js actually calls (checked against its current HEAD directly,
// not just the original issue text): getActivePlace, setActivePlace,
// listPlaces, listEntities, getEntity, updateEntity, moveEntity,
// archiveEntity, restoreEntity, deleteEntity, undo, listDrafts, saveDraft,
// deleteDraft, publishDraft. Plus createPlace/renamePlace/deletePlace/
// exportSnapshot/importSnapshot from the original issue spec.
//
// social.js itself has zero exports (it self-mounts UI as a side effect),
// so it can't be safely called into directly without mounting its full DOM
// -- fragile and would risk false failures unrelated to this file. Real
// verification here: exercise every method of the actual public API this
// file ships, against a real browser's real IndexedDB, plus confirm
// social.js at least parses cleanly against the current environment.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.join(__dirname, '..', 'product');
const workspaceSrc = fs.readFileSync(path.join(productDir, 'workspace.js'), 'utf8');
const socialSrc = fs.readFileSync(path.join(productDir, 'social.js'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:4174/');

const result = await page.evaluate(async ({ workspaceSrc, socialSrc }) => {
  const out = { checks: [] };
  const check = (name, pass, detail) => out.checks.push({ name, pass, detail });

  const wsBlob = new Blob([workspaceSrc], { type: 'text/javascript' });
  const mod = await import(URL.createObjectURL(wsBlob));

  const ws = mod.createWorkspaceBackend();
  await ws.ready();
  check('window.SidewaysWorkspace auto-installs on import', typeof window.SidewaysWorkspace?.ready === 'function', typeof window.SidewaysWorkspace);

  check('getActivePlace defaults to everything', (await ws.getActivePlace()) === 'everything', await ws.getActivePlace());
  ws.setActivePlace('later');
  check('setActivePlace persists (sync, matches social.js usage)', (await ws.getActivePlace()) === 'later', await ws.getActivePlace());
  ws.setActivePlace('everything');

  const places = await ws.listPlaces();
  check('listPlaces returns lowercase default ids in order', places.map(p => p.id).join(',') === 'everything,later,archive', places.map(p => p.id).join(','));
  check('later is virtual:false (persistent), everything/archive are virtual:true', places.find(p => p.id === 'later')?.virtual === false && places.find(p => p.id === 'everything')?.virtual === true && places.find(p => p.id === 'archive')?.virtual === true, JSON.stringify(places));

  const d1 = await ws.saveDraft({ text: 'first real post' });
  const p1 = await ws.publishDraft(d1.id, { text: 'first real post', mood: 'REAL', author: { name: 'Test' } });
  const d2 = await ws.saveDraft({ text: 'second real post' });
  const p2 = await ws.publishDraft(d2.id, { text: 'second real post', mood: 'REAL', author: { name: 'Test' } });
  check('publishDraft creates a real entity with a placeId field on it', p1.placeId === 'everything', p1.placeId);

  const everythingList = await ws.listEntities({ placeId: 'everything' });
  check('listEntities returns full entities, not just counts', everythingList.length === 2 && typeof everythingList[0].text === 'string', JSON.stringify(everythingList.map(e => e.text)));

  await ws.moveEntity(p1.id, 'later');
  const laterList = await ws.listEntities({ placeId: 'later' });
  check('moveEntity + listEntities(later) shows exactly the moved post', laterList.length === 1 && laterList[0].id === p1.id, JSON.stringify(laterList.map(e => e.id)));
  const placesAfterMove = await ws.listPlaces();
  check('listPlaces count reflects the move', placesAfterMove.find(p => p.id === 'later')?.count === 1, JSON.stringify(placesAfterMove.find(p => p.id === 'later')));

  const patched = await ws.updateEntity(p2.id, { text: 'edited text' });
  check('updateEntity patches fields and stamps updatedAt', patched.text === 'edited text' && !!patched.updatedAt, patched.text);

  await ws.archiveEntity(p2.id);
  const archiveList = await ws.listEntities({ placeId: 'archive' });
  check('archiveEntity moves post into the archive listing', archiveList.some(e => e.id === p2.id), JSON.stringify(archiveList.map(e => e.id)));
  const everythingAfterArchive = await ws.listEntities({ placeId: 'everything' });
  check('archived post excluded from everything', !everythingAfterArchive.some(e => e.id === p2.id), '');

  await ws.restoreEntity(p2.id);
  const everythingAfterRestore = await ws.listEntities({ placeId: 'everything' });
  check('restoreEntity brings it back to everything', everythingAfterRestore.some(e => e.id === p2.id), '');

  await ws.deleteEntity(p2.id);
  check('deleteEntity actually removes the entity', !(await ws.getEntity(p2.id)), '');
  const undoResult = await ws.undo();
  check('undo restores the deleted entity (single-slot, matches social.js UNDO_KEY pattern)', undoResult.restored && !!(await ws.getEntity(p2.id)), JSON.stringify(undoResult));

  let deleteDefaultThrew = false;
  try { await ws.deletePlace('everything'); } catch { deleteDefaultThrew = true; }
  check('cannot delete a default place', deleteDefaultThrew, '');
  let renameDefaultThrew = false;
  try { await ws.renamePlace('later', 'nope'); } catch { renameDefaultThrew = true; }
  check('cannot rename a default place', renameDefaultThrew, '');

  const customPlace = await ws.createPlace({ name: 'Deep Cuts' });
  await ws.moveEntity(p2.id, customPlace.id);
  const del = await ws.deletePlace(customPlace.id);
  check('deletePlace never orphans -- reports the moved entity', del.movedEntities === 1, JSON.stringify(del));
  const afterPlaceDelete = await ws.listEntities({ placeId: 'everything' });
  check('entity survives its place being deleted, lands back in everything', afterPlaceDelete.some(e => e.id === p2.id), '');

  const draftsBefore = await ws.listDrafts();
  const strayDraft = await ws.saveDraft({ text: 'never published' });
  await ws.deleteDraft(strayDraft.id);
  const draftsAfter = await ws.listDrafts();
  check('deleteDraft removes without publishing', draftsAfter.length === draftsBefore.length, `before=${draftsBefore.length} after=${draftsAfter.length}`);

  const snap = await ws.exportSnapshot();
  check('exportSnapshot has posts/drafts/places', Array.isArray(snap.posts) && Array.isArray(snap.drafts) && Array.isArray(snap.places), '');
  await ws.createPlace({ name: 'Should Disappear' });
  await ws.importSnapshot(snap);
  const placesAfterImport = await ws.listPlaces();
  check('importSnapshot restores prior place list exactly', !placesAfterImport.some(p => p.name === 'Should Disappear'), JSON.stringify(placesAfterImport.map(p => p.name)));

  // Smoke check: does the real, current social.js at least parse and load
  // cleanly against this environment (catches gross incompatibilities
  // without the fragility of mounting its full DOM/UI).
  try {
    const stubActions = `export function actionButton(){const b=document.createElement('button');b.type='button';return b}export function bindAction(){}export function emitAction(){}`;
    const stubUrl = URL.createObjectURL(new Blob([stubActions], { type: 'text/javascript' }));
    const socialPatched = socialSrc.replace("from './actions.js'", `from '${stubUrl}'`);
    await import(URL.createObjectURL(new Blob([socialPatched], { type: 'text/javascript' })));
    check('current social.js imports cleanly against this workspace.js', true, '');
  } catch (e) {
    check('current social.js imports cleanly against this workspace.js', false, e.message);
  }

  out.allPassed = out.checks.every(c => c.pass);
  return out;
}, { workspaceSrc, socialSrc });

console.log(JSON.stringify(result, null, 2));
console.log('PAGE ERRORS:', JSON.stringify(errors));
if (!result.allPassed || errors.length) process.exitCode = 1;
await browser.close();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BRANCH_LENSES,
  TURN_VERSION,
  createTurnStorage,
  deriveBranches,
  normalizeTurn,
  openProbabilityField,
  pushTurn,
  selectBranch,
  stableReceipt,
  summarizeTurn
} from '../../founder/founder.js';

const html = fs.readFileSync('founder/index.html', 'utf8');
const css = fs.readFileSync('founder/founder.css', 'utf8');

for (const id of ['founder-intention', 'open-field', 'branch-field', 'push-turn', 'copy-receipt', 'download-receipt', 'reset-room', 'room-status', 'turn-preview']) {
  assert.ok(html.includes(`id="${id}"`), `missing Founder control ${id}`);
}
assert.ok(html.includes('Make something true.'));
assert.ok(html.includes('Say it badly.'));
assert.ok(html.includes('../foundry/'));
assert.ok(html.includes('../examples/site/'));
assert.ok(html.includes('<link rel="icon" href="data:,">'));
assert.match(css, /@media\s*\(max-width:\s*560px\)/);
assert.match(css, /NO DEV LICENSE REQUIRED/);

const intention = '  make some actual site about something idk completely different but make it alive  ';
const branches = deriveBranches(intention);
assert.equal(branches.length, 6);
assert.deepEqual(branches.map(branch => branch.id), BRANCH_LENSES.map(lens => lens.id));
assert.ok(branches.every(branch => branch.probability_state === 'open'));
assert.ok(branches.every(branch => branch.proposition.includes('do not preserve its framing')));

const opened = openProbabilityField({ intention });
assert.equal(opened.schema, TURN_VERSION);
assert.equal(opened.intention, intention.trim());
assert.equal(opened.branches.length, 6);
assert.equal(opened.selected_branch, '');
assert.equal(opened.push_state, 'open');
assert.equal(opened.authority_state, 'not-granted');
assert.equal(opened.execution_claim, 'none');
assert.equal(opened.user_workflow_requires_git, false);
assert.equal(opened.mirror_response_is_completion, false);

const selected = selectBranch(opened, 'missing-capability');
assert.equal(selected.selected_branch, 'missing-capability');
assert.equal(selected.branches.find(branch => branch.id === 'missing-capability').probability_state, 'selected');
assert.equal(selected.branches.filter(branch => branch.probability_state === 'open').length, 5);
assert.deepEqual(selectBranch(selected, 'unknown'), selected);

const pushed = pushTurn(selected);
assert.equal(pushed.push_state, 'pushed-objective-only');
assert.equal(pushed.authority_state, 'not-granted');
assert.equal(pushed.execution_claim, 'none');
assert.equal(pushTurn(opened).push_state, 'open');

const receipt = stableReceipt(pushed);
assert.equal(receipt, stableReceipt(JSON.parse(receipt)));
assert.ok(receipt.endsWith('\n'));
assert.match(summarizeTurn(opened), /6 branches remain open/);
assert.match(summarizeTurn(selected), /other branches remain preserved/);
assert.match(summarizeTurn(pushed), /No execution authority has been granted/);
assert.equal(summarizeTurn({}), 'Nothing has been interpreted yet.');

const memory = new Map();
const storage = createTurnStorage({
  getItem: key => memory.get(key) || null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: key => memory.delete(key)
});
assert.equal(storage.save(pushed), true);
assert.deepEqual(storage.load(), pushed);
assert.equal(storage.clear(), true);
assert.deepEqual(storage.load(), normalizeTurn());

const brokenStorage = createTurnStorage({
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); }
});
assert.deepEqual(brokenStorage.load(), normalizeTurn());
assert.equal(brokenStorage.save(pushed), false);
assert.equal(brokenStorage.clear(), false);

console.log('Founder contract ok: one human intention opens six non-mirroring branches and push creates an authority-free objective receipt');

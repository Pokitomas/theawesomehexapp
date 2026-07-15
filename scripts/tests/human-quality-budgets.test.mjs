import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const budgets = JSON.parse(await readFile(new URL('../../audit/human-quality-budgets.json', import.meta.url), 'utf8'));

test('quality evidence names the currently automated phone viewport exactly', () => {
  assert.equal(budgets.schema, 'sideways-human-quality-budgets/v1');
  const automated = budgets.viewports.filter(viewport => viewport.automated);
  assert.deepEqual(automated, [{ id: 'phone-portrait', width: 390, height: 844, automated: true }]);
});

test('current automated evidence matches assertions consumed by the phone journey', () => {
  assert.equal(budgets.currently_measured.profile_close_minimum_px, 42);
  assert.equal(budgets.currently_measured.selected_touch_targets_unobstructed, true);
  assert.equal(budgets.currently_measured.uncaught_page_errors, 0);
  assert.equal(budgets.currently_measured.primary_journey_completion, true);
});

test('proposed budgets remain explicitly unenforced rather than reported as passing', () => {
  assert.equal(budgets.declared_not_yet_enforced.horizontal_overflow_px, 0);
  assert.ok(budgets.declared_not_yet_enforced.minimum_touch_target_px >= 44);
  assert.ok(budgets.declared_not_yet_enforced.startup_dom_content_loaded_ms > 0);
  assert.match(budgets.rule, /Only thresholds consumed by the browser journey/);
  assert.match(budgets.rule, /unenforced budgets.*remain pending/i);
});

test('manual and missing-browser acceptance cannot be represented as automated success', () => {
  assert.ok(budgets.manual_acceptance.includes('screen-reader names and reading order'));
  assert.ok(budgets.manual_acceptance.includes('Firefox journey'));
  assert.ok(budgets.manual_acceptance.includes('WebKit journey'));
  assert.ok(budgets.manual_acceptance.includes('blocked storage and quota pressure'));
  assert.match(budgets.rule, /manual or unavailable-browser review remain pending/);
});

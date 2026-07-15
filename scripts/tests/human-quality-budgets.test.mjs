import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const budgets = JSON.parse(await readFile(new URL('../../audit/human-quality-budgets.json', import.meta.url), 'utf8'));

test('quality budget names the currently automated phone viewport exactly', () => {
  assert.equal(budgets.schema, 'sideways-human-quality-budgets/v1');
  const automated = budgets.viewports.filter(viewport => viewport.automated);
  assert.deepEqual(automated, [{ id: 'phone-portrait', width: 390, height: 844, automated: true }]);
});

test('minimum automated release budgets reject overflow, small targets, and page errors', () => {
  assert.equal(budgets.automated_budgets.horizontal_overflow_px, 0);
  assert.ok(budgets.automated_budgets.minimum_touch_target_px >= 44);
  assert.equal(budgets.automated_budgets.uncaught_page_errors, 0);
  assert.equal(budgets.automated_budgets.failed_primary_actions, 0);
  assert.ok(budgets.automated_budgets.startup_dom_content_loaded_ms > 0);
});

test('manual and missing-browser acceptance cannot be represented as automated success', () => {
  assert.ok(budgets.manual_acceptance.includes('screen-reader names and reading order'));
  assert.ok(budgets.manual_acceptance.includes('Firefox journey'));
  assert.ok(budgets.manual_acceptance.includes('WebKit journey'));
  assert.ok(budgets.manual_acceptance.includes('blocked storage and quota pressure'));
  assert.match(budgets.rule, /remains pending/);
  assert.match(budgets.rule, /screenshot cannot satisfy it/);
});

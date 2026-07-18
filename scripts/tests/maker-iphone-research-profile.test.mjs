import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IPHONE_RESEARCH_MARKER,
  applyIPhoneResearchDirective,
  patchMakerIssueHref,
  receiptFromMakerIssueHref
} from '../../maker/iphone-research.js';

function issueHref(receipt) {
  const body = [
    '## Engineering command', '', receipt.request, '', '## Machine receipt', '',
    '```json', JSON.stringify(receipt, null, 2), '```', '', 'The browser did not execute code.'
  ].join('\n');
  const url = new URL('https://github.com/Pokitomas/theawesomehexapp/issues/new');
  url.searchParams.set('title', '[maker:build] task');
  url.searchParams.set('body', body);
  return url.toString();
}

const baseReceipt = {
  version: 'sideways-maker/v1', console_version: 'maker-engineering-console/v2',
  repository: 'Pokitomas/theawesomehexapp', base_revision: 'main', backend: 'auto', mode: 'build',
  request: 'Make the model stronger.', protect: '', proof: '', device_requirement: 'phone-first-and-desktop',
  authority: { human_merge_required: true, human_deploy_required: true, training_spend: 'human' },
  execution_boundary: { browser_role: 'task-author-only', writer_count: 1, branch_lease_required: true }
};

test('patches Maker packets into an iPhone-primary research task without weakening human gates', () => {
  const receipt = receiptFromMakerIssueHref(patchMakerIssueHref(issueHref(baseReceipt)));
  assert.equal(receipt.device_requirement, 'iphone-primary-a15-4gb-floor-and-desktop-fallback');
  assert.equal(receipt.research_focus.primary_device, 'iphone-a15-4gb-floor');
  assert.equal(receipt.research_focus.allocation.iphone_model_quality_and_quantization, 1);
  assert.equal(receipt.research_focus.allocation.desktop_specific_research, 0);
  assert.equal(receipt.authority.training_spend, 'human');
  assert.match(receipt.request, /physical-iPhone evidence/);
  assert.match(receipt.request, /Do not start paid training/);
});

test('directive application is idempotent', () => {
  const once = applyIPhoneResearchDirective('Build it.');
  const twice = applyIPhoneResearchDirective(once);
  assert.equal(once, twice);
  assert.equal(once.split(IPHONE_RESEARCH_MARKER).length, 2);
});

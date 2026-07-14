import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLocalControlPair,
  localControlSets,
  viewerPostEligible,
  viewerThreadProjection
} from '../../netlify/functions/social-viewer-controls.mjs';

const post = {
  id: 'post-a',
  text: 'visible text',
  rawTextAvailable: true,
  author: { id: 'author-a' },
  community: { id: 'community-a' }
};

test('local control target-kind pairs are exact', () => {
  assert.deepEqual(assertLocalControlPair('post', 'hide'), { targetType: 'post', kind: 'hide' });
  assert.deepEqual(assertLocalControlPair('community', 'mute'), { targetType: 'community', kind: 'mute' });
  assert.deepEqual(assertLocalControlPair('user', 'block'), { targetType: 'user', kind: 'block' });
  for (const pair of [['post', 'mute'], ['community', 'hide'], ['user', 'hide'], ['banana', 'block']]) {
    assert.throws(() => assertLocalControlPair(...pair), /Unsupported local control/);
  }
});

test('hide, mute, and block affect only viewer eligibility', () => {
  for (const row of [
    { target_type: 'post', target_id: 'post-a', kind: 'hide' },
    { target_type: 'community', target_id: 'community-a', kind: 'mute' },
    { target_type: 'user', target_id: 'author-a', kind: 'mute' },
    { target_type: 'user', target_id: 'author-a', kind: 'block' }
  ]) {
    const controls = localControlSets([row]);
    assert.equal(viewerPostEligible(post, controls), false);
    assert.equal(viewerPostEligible({ ...post, id: 'other', author: { id: 'other' }, community: { id: 'other' } }, controls), true);
  }
});

test('thread projection preserves the node while masking viewer-local ineligible text', () => {
  const controls = localControlSets([{ target_type: 'post', target_id: post.id, kind: 'hide' }]);
  const masked = viewerThreadProjection(post, controls);
  assert.equal(masked.id, post.id);
  assert.equal(masked.text, '[hidden locally]');
  assert.equal(masked.rawTextAvailable, false);
  assert.equal(masked.locallyHidden, true);
  assert.equal(post.text, 'visible text');
});

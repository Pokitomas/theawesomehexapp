import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const authorPath = 'studio/manual/product/social-author-controls.js';
const governancePath = 'studio/manual/product/social-governance-controls.js';
const installerPath = 'studio/manual/imports/apply.py';
const author = fs.readFileSync(authorPath, 'utf8');
const governance = fs.readFileSync(governancePath, 'utf8');
const installer = fs.readFileSync(installerPath, 'utf8');
for (const target of [authorPath, governancePath]) {
  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(`${target} syntax failed\n${syntax.stderr}`);
}

const requireAll = (source, tokens, label) => tokens.forEach(token => assert.ok(source.includes(token), `${label} missing ${token}`));
const forbidAll = (source, tokens, label) => tokens.forEach(token => assert.ok(!source.includes(token), `${label} contains forbidden ${token}`));

test('author controls preserve owner-only fail-honest public removal', () => {
  requireAll(author, ["op=post-state", "method: 'POST'", 'active: false'], 'author controls');
  forbidAll(author, ['Workspace.deleteRecord', 'indexedDB.deleteDatabase', 'localStorage.removeItem'], 'author controls');
});

test('governance controls expose complete exact-method authority without local archive mutation', () => {
  requireAll(governance, [
    'OPERATION_METHODS', "community: Object.freeze(['GET', 'POST'])", "post: Object.freeze(['POST', 'PATCH'])",
    "'community-role': Object.freeze(['POST'])", "'appeal-decide': Object.freeze(['POST'])", "'local-control': Object.freeze(['POST'])",
    "record?.social?.mine", "if (role !== 'owner') return", "if (!['moderator', 'owner'].includes(role)) return",
    'No shared change was simulated.', 'Private archive unchanged.', "headers['idempotency-key']"
  ], 'governance controls');
  forbidAll(governance, ['Workspace.deleteRecord', 'indexedDB.deleteDatabase', 'localStorage.removeItem', 'openCorpusDB'], 'governance controls');
});

test('installer ships both control modules only with a live social endpoint', () => {
  requireAll(installer, [
    'SOCIAL_AUTHOR_CONTROLS_SCRIPT', 'SOCIAL_GOVERNANCE_CONTROLS_SCRIPT',
    'social-author-controls.js', 'social-governance-controls.js', 'if social_live:',
    'inject_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT, "</body>")',
    'inject_once(html, SOCIAL_GOVERNANCE_CONTROLS_SCRIPT, "</body>")',
    'remove_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT)',
    'remove_once(html, SOCIAL_GOVERNANCE_CONTROLS_SCRIPT)'
  ], 'social installer');
});

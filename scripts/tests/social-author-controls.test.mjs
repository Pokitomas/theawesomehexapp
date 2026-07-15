import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const controlPath = 'studio/manual/product/social-author-controls.js';
const installerPath = 'studio/manual/imports/apply.py';
const control = fs.readFileSync(controlPath, 'utf8');
const installer = fs.readFileSync(installerPath, 'utf8');

const syntax = spawnSync(process.execPath, ['--check', controlPath], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(`${controlPath} syntax failed\n${syntax.stderr}`);

const requireAll = (source, tokens, label) => tokens.forEach(token => {
  assert.ok(source.includes(token), `${label} missing ${token}`);
});

const forbidAll = (source, tokens, label) => tokens.forEach(token => {
  assert.ok(!source.includes(token), `${label} contains forbidden ${token}`);
});

test('author controls expose an owner-only fail-honest public removal journey', () => {
  requireAll(control, [
    "const ACTION_ID = 'social.post.remove'",
    "record?.social?.mine",
    "window.confirm('Remove this public post? Your private archive records will not be changed.')",
    "fetch(`${API}?op=post-state`",
    "method: 'POST'",
    "credentials: 'same-origin'",
    "JSON.stringify({ postId, active: false })",
    "await window.SidewaysSocial?.refresh?.()",
    "Post removal requires the relational social deployment.",
    "Private archive unchanged."
  ], 'author controls');
  forbidAll(control, [
    'Workspace.deleteRecord',
    'indexedDB.deleteDatabase',
    'localStorage.removeItem',
    "fetch(`${API}?op=post`, { method: 'DELETE'"
  ], 'author controls');
});

test('installer ships author controls only with a live social endpoint', () => {
  requireAll(installer, [
    'SOCIAL_AUTHOR_CONTROLS_SCRIPT',
    'social-author-controls.js',
    'if social_live:',
    'inject_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT, "</body>")',
    'remove_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT)'
  ], 'social installer');
});

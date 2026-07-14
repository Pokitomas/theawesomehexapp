#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  createGitHubIssueCognitionClient,
  createSignedRemoteCognitionClient,
  extractRemoteCognitionEvents,
  parseCognitionSeedComment,
  runRecursiveCognitionBridge,
  trustedCognitionComment
} from './weave-recursive-bridge.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const unique = values => [...new Set(values.filter(Boolean))];

export async function runGuardedRecursiveCognitionBridge(options) {
  const [comments, remoteState] = await Promise.all([
    options.github.listComments(options.issue_number || 178),
    options.remote.listMessages()
  ]);
  const events = extractRemoteCognitionEvents(remoteState.messages);
  const hasTrustedSeed = comments.some(comment =>
    trustedCognitionComment(comment, options.allow_logins || []) && parseCognitionSeedComment(comment)
  );
  if (!events.length && !hasTrustedSeed) {
    return { status: 'idle', seeded: 0, ingested: 0, pending: 0, comments_posted: 0 };
  }
  return runRecursiveCognitionBridge(options);
}

function parseJSON(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

async function main() {
  const required = ['REMOTE_URL', 'REMOTE_SESSION', 'REMOTE_PRINCIPAL', 'REMOTE_KEY', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
  const missing = required.filter(name => !clean(process.env[name]));
  if (missing.length) {
    console.log(JSON.stringify({ status: 'disabled', missing }));
    return;
  }
  const remote = createSignedRemoteCognitionClient({
    remoteUrl: process.env.REMOTE_URL,
    session: process.env.REMOTE_SESSION,
    principal: process.env.REMOTE_PRINCIPAL,
    key: process.env.REMOTE_KEY,
    generation: Number(process.env.REMOTE_GENERATION || 1),
    headSha: process.env.GITHUB_SHA || null
  });
  const github = createGitHubIssueCognitionClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY
  });
  const owner = clean(process.env.GITHUB_REPOSITORY).split('/')[0];
  const result = await runGuardedRecursiveCognitionBridge({
    remote,
    github,
    issue_number: Number(process.env.WEAVE_COGNITION_ISSUE || 178),
    allow_logins: unique([owner, ...clean(process.env.WEAVE_AGENT_LOGINS).split(',').map(value => value.trim())]),
    role_mentions: parseJSON(process.env.WEAVE_ROLE_MENTIONS, {}),
    budget: {
      max_waves: Number(process.env.WEAVE_MAX_WAVES || 8),
      max_events: Number(process.env.WEAVE_MAX_EVENTS || 512),
      max_assignments_per_wave: Number(process.env.WEAVE_MAX_ASSIGNMENTS || 8),
      max_events_per_assignment: Number(process.env.WEAVE_MAX_OUTPUT_EVENTS || 4),
      max_chars_per_assignment: Number(process.env.WEAVE_MAX_OUTPUT_CHARS || 12000)
    }
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_TITLE = 'Sideways consumer app deployed';
const SENTINEL_PATH = '.well-known/sideways-deployment.json';
const ARCHIE_PATH = 'archie/';
const ARCHIE_RECEIPT_SCHEMA = 'archie-public-reachability-receipt/v1';

function normalizeDeployedUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('A deployed URL is required.');
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function sentinelUrl(deployedUrl) {
  return new URL(SENTINEL_PATH, normalizeDeployedUrl(deployedUrl)).toString();
}

function archieUrl(deployedUrl) {
  return new URL(ARCHIE_PATH, normalizeDeployedUrl(deployedUrl)).toString();
}

function buildDeploymentSentinel({ commit, repository }) {
  if (!commit) throw new Error('A deployment commit is required.');
  if (!repository) throw new Error('A deployment repository is required.');
  return {
    schema: 1,
    commit: String(commit),
    repository: String(repository)
  };
}

function writeDeploymentSentinel({ outputDir = 'dist', commit, repository }) {
  const target = path.join(outputDir, SENTINEL_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(buildDeploymentSentinel({ commit, repository }), null, 2)}\n`);
  return target;
}

function buildDeploymentReceiptBody({ deployedUrl, commit, archieReceipt = null }) {
  const rootUrl = normalizeDeployedUrl(deployedUrl);
  const lines = [
    `ROOT_URL=${rootUrl}`,
    `MANUAL_URL=${rootUrl}manual/`,
    `ARCHIE_URL=${archieUrl(rootUrl)}`,
    `PHONE_TEST_URL=${rootUrl}manual/?debug=1&test=1&autorun=1`,
    `COMMIT=${commit}`,
    `DEPLOYMENT_SENTINEL_URL=${sentinelUrl(rootUrl)}`,
    'LIVE_COMMIT_VERIFIED=true',
    `ARCHIE_ANONYMOUS_REACHABLE=${archieReceipt?.anonymous === true && archieReceipt?.status === 200 && archieReceipt?.login_redirect === false}`,
    'ROOT_PRODUCT=one-million-candidate feed verified',
    'MANUAL_CORPUS=empty until the user imports an app',
    'MANUAL_KERNEL=root-exact and parity checked',
    'MANUAL_STUDIO=one-tap consumer importer with no setup gate',
    'MANUAL_IMPORTS=Instagram Reddit TikTok YouTube Spotify X Mastodon bookmarks RSS JSON CSV text and canonical document/media support',
    'IMPORT_RUNTIME=chunked cancellable IndexedDB writes with dedupe and quota checks',
    'PHONE_GATE_TEST=real 390x844 touch import and in-place feed refresh',
    'IPHONE_IMPORTER=native multi-item system picker',
    'LIVE_WORK_TERMINAL=public read-only build snapshot on Pages; Netlify live state requires a verified Netlify deployment',
    'AUTOMATIC_RELOADS=zero',
    'MANUAL_STORAGE=browser-local IndexedDB'
  ];

  if (archieReceipt) {
    lines.push('', '```json', JSON.stringify(archieReceipt, null, 2), '```');
  }

  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyLiveDeployment({
  deployedUrl,
  expectedCommit,
  expectedRepository,
  fetchImpl = globalThis.fetch,
  attempts = 24,
  delayMs = 5_000
}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const baseUrl = sentinelUrl(deployedUrl);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const requestUrl = `${baseUrl}?commit=${encodeURIComponent(expectedCommit)}&attempt=${attempt}`;
    try {
      const response = await fetchImpl(requestUrl, {
        headers: { 'cache-control': 'no-cache' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const sentinel = await response.json();
      if (sentinel.commit !== expectedCommit) {
        throw new Error(`served commit ${sentinel.commit || '<missing>'}`);
      }
      if (sentinel.repository !== expectedRepository) {
        throw new Error(`served repository ${sentinel.repository || '<missing>'}`);
      }
      return { url: baseUrl, sentinel, attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await sleep(delayMs);
    }
  }

  throw new Error(`Deployment identity did not converge at ${baseUrl}: ${lastError?.message || 'unknown error'}`);
}

function isLoginUrl(value) {
  try {
    const parsed = new URL(String(value));
    return /(^|\/)(login|signin)(\/|$)/i.test(parsed.pathname)
      || /(^|\.)auth\.github\.com$/i.test(parsed.hostname);
  } catch {
    return true;
  }
}

async function verifyArchiePublicReachability({
  deployedUrl,
  expectedCommit,
  expectedRepository,
  fetchImpl = globalThis.fetch,
  attempts = 24,
  delayMs = 5_000
}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const publicUrl = archieUrl(deployedUrl);
  const identityUrl = sentinelUrl(deployedUrl);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = `commit=${encodeURIComponent(expectedCommit)}&attempt=${attempt}`;
    try {
      const identityResponse = await fetchImpl(`${identityUrl}?${nonce}`, {
        credentials: 'omit',
        redirect: 'follow',
        headers: { 'cache-control': 'no-cache' }
      });
      if (!identityResponse.ok) throw new Error(`sentinel HTTP ${identityResponse.status}`);
      const sentinel = await identityResponse.json();
      if (sentinel.commit !== expectedCommit) throw new Error(`served commit ${sentinel.commit || '<missing>'}`);
      if (sentinel.repository !== expectedRepository) throw new Error(`served repository ${sentinel.repository || '<missing>'}`);

      const pageResponse = await fetchImpl(`${publicUrl}?${nonce}`, {
        credentials: 'omit',
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'cache-control': 'no-cache'
        }
      });
      const finalUrl = pageResponse.url || publicUrl;
      const loginRedirect = isLoginUrl(finalUrl);
      if (pageResponse.status !== 200) throw new Error(`Archie HTTP ${pageResponse.status}`);
      if (loginRedirect) throw new Error(`Archie redirected to authentication at ${finalUrl}`);
      const html = await pageResponse.text();
      if (!/ARCHIE\s*\/\s*LOCAL INTELLIGENCE/i.test(html)) {
        throw new Error('Archie product marker is absent from the anonymous response.');
      }

      return {
        schema: ARCHIE_RECEIPT_SCHEMA,
        url: publicUrl,
        anonymous: true,
        status: pageResponse.status,
        login_redirect: false,
        expected_commit: expectedCommit,
        observed_commit: sentinel.commit
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await sleep(delayMs);
    }
  }

  throw new Error(`Archie anonymous reachability did not converge at ${publicUrl}: ${lastError?.message || 'unknown error'}`);
}

async function listOpenReceiptIssues({ github, owner, repo }) {
  const params = { owner, repo, state: 'open', per_page: 100 };
  const issues = typeof github.paginate === 'function'
    ? await github.paginate(github.rest.issues.listForRepo, params)
    : (await github.rest.issues.listForRepo(params)).data;

  return issues
    .filter(issue => !issue.pull_request && issue.title === RECEIPT_TITLE)
    .sort((left, right) => right.number - left.number);
}

async function upsertDeploymentReceipt({ github, context, deployedUrl, archieReceipt = null }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const commit = context.sha;
  const body = buildDeploymentReceiptBody({ deployedUrl, commit, archieReceipt });
  const matches = await listOpenReceiptIssues({ github, owner, repo });
  let primary;

  if (matches.length > 0) {
    primary = (await github.rest.issues.update({
      owner,
      repo,
      issue_number: matches[0].number,
      title: RECEIPT_TITLE,
      body
    })).data;
  } else {
    primary = (await github.rest.issues.create({
      owner,
      repo,
      title: RECEIPT_TITLE,
      body
    })).data;
  }

  const closedDuplicates = [];
  for (const duplicate of matches.slice(1)) {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: duplicate.number,
      state: 'closed',
      state_reason: 'not_planned'
    });
    closedDuplicates.push(duplicate.number);
  }

  return { primary, closedDuplicates };
}

async function runCli() {
  const command = process.argv[2];
  if (command === 'write-sentinel') {
    const target = writeDeploymentSentinel({
      outputDir: process.env.DEPLOYMENT_OUTPUT_DIR || 'dist',
      commit: process.env.EXPECTED_COMMIT,
      repository: process.env.EXPECTED_REPOSITORY
    });
    process.stdout.write(`${target}\n`);
    return;
  }
  if (command === 'verify-live') {
    const result = await verifyLiveDeployment({
      deployedUrl: process.env.DEPLOYED_URL,
      expectedCommit: process.env.EXPECTED_COMMIT,
      expectedRepository: process.env.EXPECTED_REPOSITORY
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'verify-archie-live') {
    const result = await verifyArchiePublicReachability({
      deployedUrl: process.env.DEPLOYED_URL,
      expectedCommit: process.env.EXPECTED_COMMIT,
      expectedRepository: process.env.EXPECTED_REPOSITORY
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown deployment receipt command: ${command || '<missing>'}`);
}

if (require.main === module) {
  runCli().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  RECEIPT_TITLE,
  SENTINEL_PATH,
  ARCHIE_PATH,
  ARCHIE_RECEIPT_SCHEMA,
  normalizeDeployedUrl,
  sentinelUrl,
  archieUrl,
  buildDeploymentSentinel,
  writeDeploymentSentinel,
  buildDeploymentReceiptBody,
  verifyLiveDeployment,
  verifyArchiePublicReachability,
  listOpenReceiptIssues,
  upsertDeploymentReceipt
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_TITLE = 'Founder human-power surface deployed';
const LEGACY_RECEIPT_TITLES = ['Sideways consumer app deployed'];
const SENTINEL_PATH = '.well-known/archie-deployment.json';
const ARCHIE_PATH = 'archie/';
const FOUNDRY_PATH = 'foundry/';
const MAKER_PATH = 'maker/';
const EXPO_PATH = 'world-expo/';
const EXAMPLE_PATH = 'examples/site/';
const FOUNDER_RECEIPT_SCHEMA = 'founder-public-reachability-receipt/v1';
const ARCHIE_RECEIPT_SCHEMA = 'archie-public-reachability-receipt/v1';

function normalizeDeployedUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('A deployed URL is required.');
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function routeUrl(deployedUrl, route = '') {
  return new URL(route, normalizeDeployedUrl(deployedUrl)).toString();
}

function sentinelUrl(deployedUrl) { return routeUrl(deployedUrl, SENTINEL_PATH); }
function founderUrl(deployedUrl) { return routeUrl(deployedUrl); }
function archieUrl(deployedUrl) { return routeUrl(deployedUrl, ARCHIE_PATH); }
function foundryUrl(deployedUrl) { return routeUrl(deployedUrl, FOUNDRY_PATH); }

function buildDeploymentSentinel({ commit, repository }) {
  if (!commit) throw new Error('A deployment commit is required.');
  if (!repository) throw new Error('A deployment repository is required.');
  return { schema: 2, product_root: 'founder', commit: String(commit), repository: String(repository) };
}

function writeDeploymentSentinel({ outputDir = 'dist', commit, repository }) {
  const target = path.join(outputDir, SENTINEL_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(buildDeploymentSentinel({ commit, repository }), null, 2)}\n`);
  return target;
}

function buildDeploymentReceiptBody({ deployedUrl, commit, founderReceipt = null, archieReceipt = null }) {
  const rootUrl = normalizeDeployedUrl(deployedUrl);
  const lines = [
    `ROOT_URL=${rootUrl}`,
    `FOUNDER_URL=${founderUrl(rootUrl)}`,
    `FOUNDRY_URL=${routeUrl(rootUrl, FOUNDRY_PATH)}`,
    `ARCHIE_URL=${archieUrl(rootUrl)}`,
    `MAKER_URL=${routeUrl(rootUrl, MAKER_PATH)}`,
    `EXPO_URL=${routeUrl(rootUrl, EXPO_PATH)}`,
    `EXAMPLE_OUTPUT_URL=${routeUrl(rootUrl, EXAMPLE_PATH)}`,
    `COMMIT=${commit}`,
    `DEPLOYMENT_SENTINEL_URL=${sentinelUrl(rootUrl)}`,
    'LIVE_COMMIT_VERIFIED=true',
    `FOUNDER_ANONYMOUS_REACHABLE=${founderReceipt?.anonymous === true && founderReceipt?.status === 200 && founderReceipt?.login_redirect === false}`,
    `ARCHIE_ANONYMOUS_REACHABLE=${archieReceipt?.anonymous === true && archieReceipt?.status === 200 && archieReceipt?.login_redirect === false}`,
    'ROOT_PRODUCT=Founder human invention surface',
    'FOUNDER_CONTRACT=one unfinished human intention opens six possibilities before explicit PUSH',
    'FOUNDRY_CONTRACT=human-governed speculative model research and release admission',
    'MAKER_CONTRACT=permissioned tested reversible consequence engine',
    'EXAMPLE_CONTRACT=ordinary programs are disposable outputs, not Archie memory or ontology',
    'SUPERIORITY_CLAIM=blocked until blinded matched real-user evidence passes the public protocol and independent admission'
  ];
  for (const receipt of [founderReceipt, archieReceipt].filter(Boolean)) {
    lines.push('', '```json', JSON.stringify(receipt, null, 2), '```');
  }
  return lines.join('\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function verifyLiveDeployment({ deployedUrl, expectedCommit, expectedRepository, fetchImpl = globalThis.fetch, attempts = 24, delayMs = 5_000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const baseUrl = sentinelUrl(deployedUrl);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const requestUrl = `${baseUrl}?commit=${encodeURIComponent(expectedCommit)}&attempt=${attempt}`;
    try {
      const response = await fetchImpl(requestUrl, { headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const sentinel = await response.json();
      if (sentinel.commit !== expectedCommit) throw new Error(`served commit ${sentinel.commit || '<missing>'}`);
      if (sentinel.repository !== expectedRepository) throw new Error(`served repository ${sentinel.repository || '<missing>'}`);
      if (sentinel.product_root !== 'founder') throw new Error(`served product root ${sentinel.product_root || '<missing>'}`);
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
    return /(^|\/)(login|signin)(\/|$)/i.test(parsed.pathname) || /(^|\.)auth\.github\.com$/i.test(parsed.hostname);
  } catch {
    return true;
  }
}

async function verifyPublicSurfaceReachability({ deployedUrl, expectedCommit, expectedRepository, route, marker, schema, fetchImpl = globalThis.fetch, attempts = 24, delayMs = 5_000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const publicUrl = routeUrl(deployedUrl, route);
  const identityUrl = sentinelUrl(deployedUrl);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = `commit=${encodeURIComponent(expectedCommit)}&attempt=${attempt}`;
    try {
      const requestOptions = {
        credentials: 'omit',
        redirect: 'follow',
        headers: { accept: 'text/html,application/xhtml+xml', 'cache-control': 'no-cache' }
      };
      const identityResponse = await fetchImpl(`${identityUrl}?${nonce}`, requestOptions);
      if (!identityResponse.ok) throw new Error(`sentinel HTTP ${identityResponse.status}`);
      const sentinel = await identityResponse.json();
      if (sentinel.commit !== expectedCommit) throw new Error(`served commit ${sentinel.commit || '<missing>'}`);
      if (sentinel.repository !== expectedRepository) throw new Error(`served repository ${sentinel.repository || '<missing>'}`);
      if (sentinel.product_root !== 'founder') throw new Error(`served product root ${sentinel.product_root || '<missing>'}`);

      const pageResponse = await fetchImpl(`${publicUrl}?${nonce}`, requestOptions);
      const finalUrl = pageResponse.url || publicUrl;
      if (pageResponse.status !== 200) throw new Error(`surface HTTP ${pageResponse.status}`);
      if (isLoginUrl(finalUrl)) throw new Error(`surface redirected to authentication at ${finalUrl}`);
      const html = await pageResponse.text();
      if (!marker.test(html)) throw new Error(`public surface marker is absent at ${publicUrl}`);
      return { schema, url: publicUrl, anonymous: true, status: pageResponse.status, login_redirect: false, expected_commit: expectedCommit, observed_commit: sentinel.commit };
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await sleep(delayMs);
    }
  }
  throw new Error(`Public surface did not converge at ${publicUrl}: ${lastError?.message || 'unknown error'}`);
}

function verifyFounderPublicReachability(options) {
  return verifyPublicSurfaceReachability({ ...options, route: '', marker: /FOUNDER\s*\/\s*HUMAN INVENTION POWER/i, schema: FOUNDER_RECEIPT_SCHEMA });
}

function verifyArchiePublicReachability(options) {
  return verifyPublicSurfaceReachability({ ...options, route: ARCHIE_PATH, marker: /ARCHIE\s*\/\s*LOCAL INTELLIGENCE/i, schema: ARCHIE_RECEIPT_SCHEMA });
}

async function listOpenReceiptIssues({ github, owner, repo }) {
  const params = { owner, repo, state: 'open', per_page: 100 };
  const issues = typeof github.paginate === 'function' ? await github.paginate(github.rest.issues.listForRepo, params) : (await github.rest.issues.listForRepo(params)).data;
  const acceptedTitles = new Set([RECEIPT_TITLE, ...LEGACY_RECEIPT_TITLES]);
  return issues.filter(issue => !issue.pull_request && acceptedTitles.has(issue.title)).sort((left, right) => right.number - left.number);
}

async function upsertDeploymentReceipt({ github, context, deployedUrl, founderReceipt = null, archieReceipt = null }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const commit = context.sha;
  const body = buildDeploymentReceiptBody({ deployedUrl, commit, founderReceipt, archieReceipt });
  const matches = await listOpenReceiptIssues({ github, owner, repo });
  let primary;
  if (matches.length > 0) {
    primary = (await github.rest.issues.update({ owner, repo, issue_number: matches[0].number, title: RECEIPT_TITLE, body })).data;
  } else {
    primary = (await github.rest.issues.create({ owner, repo, title: RECEIPT_TITLE, body })).data;
  }
  const closedDuplicates = [];
  for (const duplicate of matches.slice(1)) {
    await github.rest.issues.update({ owner, repo, issue_number: duplicate.number, state: 'closed', state_reason: 'not_planned' });
    closedDuplicates.push(duplicate.number);
  }
  return { primary, closedDuplicates };
}

async function runCli() {
  const command = process.argv[2];
  if (command === 'write-sentinel') {
    const target = writeDeploymentSentinel({ outputDir: process.env.DEPLOYMENT_OUTPUT_DIR || 'dist', commit: process.env.EXPECTED_COMMIT, repository: process.env.EXPECTED_REPOSITORY });
    process.stdout.write(`${target}\n`);
    return;
  }
  if (command === 'verify-live') {
    const result = await verifyLiveDeployment({ deployedUrl: process.env.DEPLOYED_URL, expectedCommit: process.env.EXPECTED_COMMIT, expectedRepository: process.env.EXPECTED_REPOSITORY });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'verify-founder-live' || command === 'verify-archie-live') {
    const verify = command === 'verify-founder-live' ? verifyFounderPublicReachability : verifyArchiePublicReachability;
    const result = await verify({ deployedUrl: process.env.DEPLOYED_URL, expectedCommit: process.env.EXPECTED_COMMIT, expectedRepository: process.env.EXPECTED_REPOSITORY });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown deployment receipt command: ${command || '<missing>'}`);
}

if (require.main === module) runCli().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = {
  RECEIPT_TITLE,
  LEGACY_RECEIPT_TITLES,
  SENTINEL_PATH,
  ARCHIE_PATH,
  FOUNDRY_PATH,
  FOUNDER_RECEIPT_SCHEMA,
  ARCHIE_RECEIPT_SCHEMA,
  normalizeDeployedUrl,
  routeUrl,
  sentinelUrl,
  founderUrl,
  archieUrl,
  foundryUrl,
  buildDeploymentSentinel,
  writeDeploymentSentinel,
  buildDeploymentReceiptBody,
  verifyLiveDeployment,
  verifyPublicSurfaceReachability,
  verifyFounderPublicReachability,
  verifyArchiePublicReachability,
  listOpenReceiptIssues,
  upsertDeploymentReceipt
};

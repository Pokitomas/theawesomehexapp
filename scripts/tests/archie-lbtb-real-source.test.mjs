import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLbtbRealSourceBenchmark,
  verifyLbtbRealSourceBenchmark
} from '../archie-lbtb-real-source.mjs';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const server = `
function openInterface() {}
function getConfigForInterface() {}
function listIncomingPoEmails() {}
function processSingleEmailWrapper() {}
function extractPdfTextForViewing() {}
function getJsonFileContent() {}
function getLatestLogEntries() {}
function getDriveFolderContents() {}
`;

function call(name) {
  return `<script>google.script.run.withSuccessHandler(()=>{}).${name}();</script>`;
}

async function writeSource(root, { home, process, routing = server } = {}) {
  const source = path.join(root, 'src');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'Admin_WebApp.js'), routing);
  await fs.writeFile(path.join(source, 'appsscript.json'), '{"timeZone":"America/Los_Angeles"}\n');
  await fs.writeFile(path.join(source, 'UI_HomePage.html'), home);
  await fs.writeFile(path.join(source, 'UI_POProcessInterface.html'), process);
  await fs.writeFile(path.join(source, 'PDF_Processor.js'), 'function parsePurchaseOrder() { return true; }\n');
}

function baselineHome() {
  return `<html><body><button id="open">Open PO Process</button>${call('openInterface')}</body></html>`;
}

function baselineProcess() {
  return `<html><body><h2>Step 1</h2><h2>Step 2</h2><p>Processing selected purchase orders.</p><button id="process">Process selected</button>
  ${call('getConfigForInterface')}${call('listIncomingPoEmails')}${call('processSingleEmailWrapper')}${call('extractPdfTextForViewing')}${call('getJsonFileContent')}${call('getLatestLogEntries')}${call('getDriveFolderContents')}</body></html>`;
}

function operatorHome() {
  return `<html><style>@media(max-width:600px){body{display:block}}@media(min-width:601px){body{display:grid}}</style><body><section><h1>Incoming purchase orders</h1><p>Evidence trail</p><button id="open">Open desk</button></section>${call('openInterface')}</body></html>`;
}

function operatorProcess() {
  return `<html><style>@media(max-width:390px){body{display:block}}@media(min-width:391px){body{display:grid}}@media(prefers-reduced-motion:reduce){*{animation:none}}</style><body><section><h1>PO command center</h1><p>Queue progress and audit</p></section><section><h2>Evidence trail</h2></section><section><h2>Recent activity</h2></section><section><button id="run">Run</button></section>
  ${call('getConfigForInterface')}${call('listIncomingPoEmails')}${call('processSingleEmailWrapper')}${call('extractPdfTextForViewing')}${call('getJsonFileContent')}${call('getLatestLogEntries')}${call('getDriveFolderContents')}</body></html>`;
}

function mailHome() {
  return `<html><body><section><button id="mail">Open mailbox</button></section>${call('openInterface')}</body></html>`;
}

function mailProcess() {
  return `<html><style>@media(max-width:390px){article{display:block}}@media(min-width:391px){article{display:grid}}</style><body><section><h1>Incoming purchase orders</h1><p>Needs review</p></section><article><button id="single">Process this PO</button></article>
  ${call('getConfigForInterface')}${call('listIncomingPoEmails')}${call('processSingleEmailWrapper')}${call('extractPdfTextForViewing')}${call('getJsonFileContent')}</body></html>`;
}

test('real-source generator selects the UI-only operator hypothesis and retains the mail counterfactual', async t => {
  const root = await tempRoot(t, 'archie-lbtb-fixture-');
  const baseline = path.join(root, 'baseline');
  const operator = path.join(root, 'operator');
  const mail = path.join(root, 'mail');
  await writeSource(baseline, { home: baselineHome(), process: baselineProcess() });
  await writeSource(operator, { home: operatorHome(), process: operatorProcess() });
  await writeSource(mail, { home: mailHome(), process: mailProcess(), routing: server.replace('function openInterface() {}', 'function openInterface() { return "mail"; }') });

  const receipt = await buildLbtbRealSourceBenchmark({
    baseline: { root: baseline, archiveSha256: '1'.repeat(64), label: 'baseline' },
    operator: { root: operator, archiveSha256: '2'.repeat(64), label: 'operator' },
    mail: { root: mail, archiveSha256: '3'.repeat(64), label: 'mail' }
  });
  assert.equal(verifyLbtbRealSourceBenchmark(receipt).receipt_digest, receipt.receipt_digest);
  assert.equal(receipt.selection.selected, 'operator');
  assert.deepEqual(receipt.comparisons.operator.changed_source_files, ['src/UI_HomePage.html', 'src/UI_POProcessInterface.html']);
  assert.equal(receipt.comparisons.operator.ui_only_change, true);
  assert.equal(receipt.comparisons.operator.backend_tree_preserved, true);
  assert.equal(receipt.comparisons.operator.client_call_set_equal, true);
  assert.equal(receipt.comparisons.mail.routing_preserved, false);
  assert.equal(receipt.comparisons.mail.client_call_set_equal, false);
  assert.deepEqual(receipt.comparisons.mail.removed_client_calls, ['getDriveFolderContents', 'getLatestLogEntries']);
  assert.equal(receipt.claims.customer_value_claim, false);
  assert.equal(receipt.claims.live_gmail_drive_sheets_exercised, false);
});

test('pinned LBTB receipt binds the actual source archives and keeps runtime claims closed', async () => {
  const receipt = JSON.parse(await fs.readFile(new URL('../../maker/evaluations/lbtb-real-source-benchmark.json', import.meta.url), 'utf8'));
  verifyLbtbRealSourceBenchmark(receipt);
  assert.equal(receipt.receipt_digest, 'f39ea68ed75a569a9ad1a6c808f603cc8bc0c548ad4863fa0fe74aaa80699fb6');
  assert.equal(receipt.sources.baseline.archive_sha256, '518a0742579d90b24a4a5a98e13e81b6536a7f7df9ae9a1d88e2e9f1ddb9e029');
  assert.equal(receipt.sources.operator.archive_sha256, '5892dcea3ccc41ee74972af38443547ca4282cf6311bf2c941b71a940c15832c');
  assert.equal(receipt.sources.mail.archive_sha256, '7ff6a12f132d7a49acf351ae5ff716bc08061ef9c317d58b45f6405409af82a1');
  assert.equal(receipt.sources.baseline.source_file_count, 47);
  assert.equal(receipt.sources.operator.backend_tree_digest, receipt.sources.baseline.backend_tree_digest);
  assert.equal(receipt.sources.operator.required_files.routing.sha256, receipt.sources.baseline.required_files.routing.sha256);
  assert.deepEqual(receipt.sources.operator.client_calls, receipt.sources.baseline.client_calls);
  assert.deepEqual(receipt.comparisons.operator.changed_source_files, ['src/UI_HomePage.html', 'src/UI_POProcessInterface.html']);
  assert.deepEqual(receipt.comparisons.mail.changed_source_files, ['src/Admin_WebApp.js', 'src/UI_HomePage.html', 'src/UI_POProcessInterface.html']);
  assert.deepEqual(receipt.comparisons.mail.removed_client_calls, ['getDriveFolderContents', 'getLatestLogEntries']);
  assert.equal(receipt.claims.source_archives_vendored, false);
  assert.equal(receipt.claims.human_timing_study_completed, false);
  assert.equal(receipt.claims.physical_phone_run_completed, false);
  assert.equal(receipt.claims.trained_archie_candidate_used, false);
  assert.doesNotMatch(JSON.stringify(receipt), /\.clasp\.json|scriptId|rootDir|ghp_|ya29\.|AKIA[0-9A-Z]{16}/i);
});

test('pinned receipt fails closed after tampering or claim inflation', async () => {
  const source = JSON.parse(await fs.readFile(new URL('../../maker/evaluations/lbtb-real-source-benchmark.json', import.meta.url), 'utf8'));
  const tampered = structuredClone(source);
  tampered.sources.operator.required_files.process.sha256 = '0'.repeat(64);
  assert.throws(() => verifyLbtbRealSourceBenchmark(tampered), /digest mismatch/);

  const inflated = structuredClone(source);
  inflated.claims.customer_value_claim = true;
  assert.throws(() => verifyLbtbRealSourceBenchmark(inflated), /digest mismatch|cannot claim customer value/);
});

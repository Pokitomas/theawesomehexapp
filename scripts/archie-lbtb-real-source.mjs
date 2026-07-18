#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ARCHIE_LBTB_REAL_SOURCE_SCHEMA = 'archie-lbtb-real-source-benchmark/v1';
const UI_FILES = new Set(['src/UI_HomePage.html', 'src/UI_POProcessInterface.html']);
const SERVER_FUNCTION = /(?:^|\n)\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const METHOD_CALL = /\.([A-Za-z_$][\w$]*)\s*\(/g;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function unsignedReceipt(receipt) {
  const { receipt_digest: _receiptDigest, ...unsigned } = receipt;
  return unsigned;
}

function receiptDigest(receipt) {
  return sha256(stableJSONStringify(unsignedReceipt(receipt)));
}

function normalizeArchiveDigest(value, label) {
  const result = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 hex digest.`);
  return result;
}

function cleanLabel(value, fallback) {
  const result = String(value || fallback).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 160);
  if (!result) throw new Error('Source label cannot be empty.');
  return result;
}

async function walkSourceFiles(root) {
  const sourceRoot = path.join(root, 'src');
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Source contains a symlink: ${entry.name}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = `src/${path.relative(sourceRoot, absolute).split(path.sep).join('/')}`;
      const bytes = await fs.readFile(absolute);
      files.push(Object.freeze({ path: relative, sha256: sha256(bytes), size_bytes: bytes.length }));
    }
  }
  await visit(sourceRoot);
  return files;
}

function treeDigest(files) {
  return sha256(stableJSONStringify(files.map(file => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes }))));
}

function tagCount(source, tag) {
  return (source.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
}

function attributeValues(source, name) {
  return [...source.matchAll(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'gi'))].map(match => match[1]);
}

function visibleText(source) {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function uiMetrics(source) {
  const text = visibleText(source);
  const ids = [...new Set(attributeValues(source, 'id'))].sort();
  const signal = pattern => pattern.test(text);
  return Object.freeze({
    bytes: Buffer.byteLength(source),
    buttons: tagCount(source, 'button'),
    inputs: tagCount(source, 'input'),
    sections: tagCount(source, 'section'),
    articles: tagCount(source, 'article'),
    unique_ids: ids.length,
    media_queries: (source.match(/@media\b/gi) || []).length,
    step_labels: [...new Set(text.match(/\bStep\s+\d+\b/gi) || [])].sort(),
    signals: Object.freeze({
      queue: signal(/\bqueue\b|incoming purchase orders/i),
      evidence_trail: signal(/evidence trail/i),
      recent_activity: signal(/recent activity/i),
      audit: signal(/\baudit\b/i),
      progress: signal(/\bprogress\b|processing/i),
      error_state: signal(/\berror\b|failed/i),
      needs_review: signal(/needs review/i),
      command_center: signal(/command center/i),
      process_selected: signal(/process selected/i),
      process_single: signal(/process this po/i)
    })
  });
}

function extractServerFunctions(jsSources) {
  const result = new Set();
  for (const source of jsSources) for (const match of source.matchAll(SERVER_FUNCTION)) result.add(match[1]);
  return result;
}

function extractClientCalls(htmlSource, serverFunctions) {
  const result = new Set();
  for (const match of htmlSource.matchAll(METHOD_CALL)) if (serverFunctions.has(match[1])) result.add(match[1]);
  return [...result].sort();
}

async function analyzeSource({ id, role, root, archiveSha256, label }) {
  const resolvedRoot = path.resolve(root);
  const files = await walkSourceFiles(resolvedRoot);
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const required of ['src/UI_HomePage.html', 'src/UI_POProcessInterface.html', 'src/Admin_WebApp.js', 'src/appsscript.json']) {
    if (!byPath.has(required)) throw new Error(`${id} is missing required source file ${required}.`);
  }
  const sourceFiles = await Promise.all(files.map(async file => [file.path, await fs.readFile(path.join(resolvedRoot, ...file.path.split('/')), 'utf8')]));
  const jsSources = sourceFiles.filter(([filename]) => filename.endsWith('.js')).map(([, source]) => source);
  const serverFunctions = extractServerFunctions(jsSources);
  const processHtml = sourceFiles.find(([filename]) => filename === 'src/UI_POProcessInterface.html')[1];
  const homeHtml = sourceFiles.find(([filename]) => filename === 'src/UI_HomePage.html')[1];
  const backendFiles = files.filter(file => !UI_FILES.has(file.path));
  return Object.freeze({
    schema: 'archie-lbtb-source-identity/v1',
    id,
    role,
    label: cleanLabel(label, id),
    archive_sha256: normalizeArchiveDigest(archiveSha256, `${id}.archive_sha256`),
    source_tree_digest: treeDigest(files),
    backend_tree_digest: treeDigest(backendFiles),
    source_file_count: files.length,
    source_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    files,
    required_files: Object.freeze({
      home: byPath.get('src/UI_HomePage.html'),
      process: byPath.get('src/UI_POProcessInterface.html'),
      routing: byPath.get('src/Admin_WebApp.js'),
      manifest: byPath.get('src/appsscript.json')
    }),
    client_calls: extractClientCalls(`${homeHtml}\n${processHtml}`, serverFunctions),
    home_ui: uiMetrics(homeHtml),
    process_ui: uiMetrics(processHtml),
    absolute_path_preserved: false,
    raw_source_content_preserved: false
  });
}

function changedFiles(baseline, candidate) {
  const baselineFiles = new Map(baseline.files.map(file => [file.path, file.sha256]));
  const candidateFiles = new Map(candidate.files.map(file => [file.path, file.sha256]));
  return [...new Set([...baselineFiles.keys(), ...candidateFiles.keys()])]
    .filter(filename => baselineFiles.get(filename) !== candidateFiles.get(filename))
    .sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter(value => !rightSet.has(value));
}

function comparison(baseline, candidate, hypothesis) {
  const changes = changedFiles(baseline, candidate);
  const addedCalls = difference(candidate.client_calls, baseline.client_calls);
  const removedCalls = difference(baseline.client_calls, candidate.client_calls);
  return Object.freeze({
    schema: 'archie-lbtb-source-comparison/v1',
    candidate_id: candidate.id,
    hypothesis,
    changed_source_files: changes,
    ui_only_change: changes.every(filename => UI_FILES.has(filename)),
    backend_tree_preserved: baseline.backend_tree_digest === candidate.backend_tree_digest,
    manifest_preserved: baseline.required_files.manifest.sha256 === candidate.required_files.manifest.sha256,
    routing_preserved: baseline.required_files.routing.sha256 === candidate.required_files.routing.sha256,
    client_call_set_equal: addedCalls.length === 0 && removedCalls.length === 0,
    added_client_calls: addedCalls,
    removed_client_calls: removedCalls,
    mechanics: Object.freeze({
      mobile_media_queries_added: Math.max(0, candidate.process_ui.media_queries - baseline.process_ui.media_queries),
      inherited_step_labels_removed: baseline.process_ui.step_labels.filter(label => !candidate.process_ui.step_labels.includes(label)),
      queue_visible: candidate.process_ui.signals.queue,
      evidence_trail_visible: candidate.process_ui.signals.evidence_trail,
      recent_activity_visible: candidate.process_ui.signals.recent_activity,
      audit_visible: candidate.process_ui.signals.audit,
      needs_review_visible: candidate.process_ui.signals.needs_review,
      command_center_visible: candidate.process_ui.signals.command_center,
      process_single_visible: candidate.process_ui.signals.process_single
    }),
    customer_value_claim: false,
    live_service_execution: false
  });
}

export async function buildLbtbRealSourceBenchmark({ baseline, operator, mail } = {}) {
  const baselineSource = await analyzeSource({ id: 'baseline', role: 'inherited_actual_source', ...baseline });
  const operatorSource = await analyzeSource({ id: 'operator', role: 'queue_first_operator_hypothesis', ...operator });
  const mailSource = await analyzeSource({ id: 'mail', role: 'mail_client_hypothesis', ...mail });
  const operatorComparison = comparison(baselineSource, operatorSource, 'Queue-first operations desk with visible progress and evidence payoff.');
  const mailComparison = comparison(baselineSource, mailSource, 'Email-client workflow centered on opening one message, checking its PDF, and processing one PO.');
  const operatorAdmitted = operatorComparison.ui_only_change
    && operatorComparison.backend_tree_preserved
    && operatorComparison.manifest_preserved
    && operatorComparison.routing_preserved
    && operatorComparison.client_call_set_equal
    && operatorComparison.mechanics.mobile_media_queries_added > 0
    && operatorComparison.mechanics.queue_visible
    && operatorComparison.mechanics.evidence_trail_visible
    && operatorComparison.mechanics.recent_activity_visible
    && operatorComparison.mechanics.audit_visible;
  const selection = operatorAdmitted ? Object.freeze({
    schema: 'archie-lbtb-hypothesis-selection/v1',
    selected: 'operator',
    reason_codes: [
      'actual-source-bound',
      'backend-byte-preserved',
      'manifest-and-routing-preserved',
      'full-client-contract-set-preserved',
      'phone-responsive-contract-added',
      'queue-progress-evidence-and-audit-visible'
    ],
    rejected_or_deferred: [{
      candidate_id: 'mail',
      status: 'deferred',
      reason_codes: [
        ...(mailComparison.routing_preserved ? [] : ['routing-default-changed']),
        ...(mailComparison.client_call_set_equal ? [] : ['existing-client-contract-set-narrowed']),
        ...(mailComparison.mechanics.evidence_trail_visible ? [] : ['evidence-trail-not-explicit']),
        'still-materially-different-counterfactual'
      ]
    }],
    conclusion: 'Select the operator hypothesis for the next executable benchmark because it changes only the two UI files while preserving the actual backend and full client contract set. Retain the mail hypothesis as a serious counterfactual, not a cosmetic variant.',
    customer_value_claim: false
  }) : Object.freeze({
    schema: 'archie-lbtb-hypothesis-selection/v1',
    selected: null,
    reason_codes: ['operator-admission-contract-not-satisfied'],
    rejected_or_deferred: [],
    conclusion: 'No hypothesis is admitted from static source evidence.',
    customer_value_claim: false
  });
  const body = {
    schema: ARCHIE_LBTB_REAL_SOURCE_SCHEMA,
    benchmark_kind: 'pinned-real-source-static-mechanics',
    objective: 'Make the actual LBTB purchase-order workflow genuinely good on a phone while reducing work, mistakes, and uncertainty without losing human control or the final audit trail.',
    sources: { baseline: baselineSource, operator: operatorSource, mail: mailSource },
    comparisons: { operator: operatorComparison, mail: mailComparison },
    selection,
    claims: {
      actual_source_packages_analyzed: true,
      materially_different_hypotheses_compared: true,
      customer_value_claim: false,
      live_gmail_drive_sheets_exercised: false,
      human_timing_study_completed: false,
      physical_phone_run_completed: false,
      trained_archie_candidate_used: false,
      source_archives_vendored: false
    },
    claim_boundary: 'This receipt proves exact source identities, changed-file boundaries, client/server contract preservation, and static product-mechanics differences against the actual LBTB Apps Script project. It does not prove live service behavior, customer-value superiority, reduced completion time, fewer errors, trained-model competence, or physical-device performance.'
  };
  return Object.freeze({ ...body, receipt_digest: receiptDigest(body) });
}

export function verifyLbtbRealSourceBenchmark(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('LBTB benchmark receipt must be an object.');
  if (receipt.schema !== ARCHIE_LBTB_REAL_SOURCE_SCHEMA) throw new Error('Unsupported LBTB benchmark schema.');
  if (receipt.receipt_digest !== receiptDigest(receipt)) throw new Error('LBTB benchmark receipt digest mismatch.');
  if (receipt.claims?.customer_value_claim !== false || receipt.selection?.customer_value_claim !== false) throw new Error('LBTB static benchmark cannot claim customer value.');
  if (receipt.claims?.live_gmail_drive_sheets_exercised !== false || receipt.claims?.physical_phone_run_completed !== false) throw new Error('LBTB static benchmark overclaims runtime evidence.');
  if (receipt.selection?.selected !== 'operator') throw new Error('Pinned LBTB benchmark did not admit the operator hypothesis.');
  const operator = receipt.comparisons?.operator;
  if (!operator?.ui_only_change || !operator.backend_tree_preserved || !operator.manifest_preserved || !operator.routing_preserved || !operator.client_call_set_equal) {
    throw new Error('Operator source-preservation contract failed.');
  }
  if (!operator.mechanics?.evidence_trail_visible || !operator.mechanics?.recent_activity_visible || !operator.mechanics?.audit_visible || !operator.mechanics?.queue_visible) {
    throw new Error('Operator mechanics contract failed.');
  }
  const serialized = JSON.stringify(receipt);
  if (/\.clasp\.json|scriptId|rootDir|ghp_|ya29\.|AKIA[0-9A-Z]{16}/i.test(serialized)) throw new Error('LBTB receipt contains forbidden source-host or credential material.');
  return receipt;
}

function argument(argv, name) {
  const index = argv.lastIndexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('archie LBTB real-source benchmark\n\nUsage:\n  node scripts/archie-lbtb-real-source.mjs --baseline <dir> --baseline-archive-sha256 <sha> --operator <dir> --operator-archive-sha256 <sha> --mail <dir> --mail-archive-sha256 <sha> [--output <json>]\n');
    return null;
  }
  const receipt = await buildLbtbRealSourceBenchmark({
    baseline: { root: argument(argv, '--baseline'), archiveSha256: argument(argv, '--baseline-archive-sha256'), label: 'LBTB PO Processing baseline' },
    operator: { root: argument(argv, '--operator'), archiveSha256: argument(argv, '--operator-archive-sha256'), label: 'LBTB Order Desk operator hypothesis' },
    mail: { root: argument(argv, '--mail'), archiveSha256: argument(argv, '--mail-archive-sha256'), label: 'LBTB PO Mail hypothesis' }
  });
  verifyLbtbRealSourceBenchmark(receipt);
  const output = argument(argv, '--output');
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(path.resolve(output), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({
    schema: receipt.schema,
    receipt_digest: receipt.receipt_digest,
    selected: receipt.selection.selected,
    customer_value_claim: receipt.claims.customer_value_claim,
    live_service_execution: receipt.claims.live_gmail_drive_sheets_exercised
  }, null, 2)}\n`);
  return receipt;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-lbtb-real-source: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

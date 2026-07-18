#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyLbtbRealSourceBenchmark } from './archie-lbtb-real-source.mjs';

export async function main() {
  const receiptPath = new URL('../maker/evaluations/lbtb-real-source-benchmark.json', import.meta.url);
  const receipt = verifyLbtbRealSourceBenchmark(JSON.parse(await fs.readFile(receiptPath, 'utf8')));
  const summary = Object.freeze({
    schema: receipt.schema,
    receipt_digest: receipt.receipt_digest,
    selected_hypothesis: receipt.selection.selected,
    baseline_source_tree_digest: receipt.sources.baseline.source_tree_digest,
    selected_source_tree_digest: receipt.sources[receipt.selection.selected].source_tree_digest,
    backend_tree_preserved: receipt.comparisons[receipt.selection.selected].backend_tree_preserved,
    client_call_set_preserved: receipt.comparisons[receipt.selection.selected].client_call_set_equal,
    customer_value_claim: receipt.claims.customer_value_claim,
    live_service_execution: receipt.claims.live_gmail_drive_sheets_exercised,
    claim_boundary: receipt.claim_boundary
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-lbtb-receipt: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

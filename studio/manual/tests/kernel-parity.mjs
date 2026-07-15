// Exact-root/manual ranking guard plus deterministic whole-kernel fixture replay.
import fs from 'node:fs';
import { evaluateRankingFixture, sourceKernelEvidence } from '../../../scripts/ranking-evaluation.mjs';

const CHECKS = [
  { name: 'baseScore weights',       re: /baseScore\s*=\s*\.55\*post\.base\s*\+\s*\.30\*f\.affinity\s*\+\s*\.15\*post\.relevance/ },
  { name: 'lateralValue weights',    re: /\.24\*f\.sameWhyDifferentAxis[\s\S]{0,240}?-\s*\.15\*f\.graphicRepeat/ },
  { name: 'posteriorChoice sigmoid', re: /sigmoid\(\s*4\.2\s*\*\s*delta\s*\+\s*1\.15\s*\*\s*\(maxZ\s*-\s*\.85\)\s*\)/ },
  { name: 'riskFloor clamp',         re: /clamp\(\s*\(maxZ\s*-\s*\.55\)\s*\/\s*2\.8\s*,\s*0\s*,\s*\.43\s*\)/ },
  { name: 'gate target blend',       re: /riskFloor\s*\+\s*\.54\s*\*\s*posteriorChoice/ },
  { name: 'deep_saturation floor',   re: /Math\.max\(target,\s*\.48\)/ }
];

function extract(source) {
  return CHECKS.map(check => ({ name: check.name, present: check.re.test(source) }));
}

function evaluateFixture(rootSource, kernelSource, path = 'audit/ranking-evaluation-fixture.json') {
  if (!fs.existsSync(path)) return null;
  const receipt = evaluateRankingFixture(JSON.parse(fs.readFileSync(path, 'utf8')), { kernelSources: [rootSource, kernelSource] });
  if (receipt.source_binding !== 'root-and-manual') throw new Error('Ranking evaluation was not bound to both shipped sources.');
  if (receipt.source_evidence.some(item => !item.ok)) throw new Error('A shipped source omitted a load-bearing ranking term.');
  if (!receipt.candidate_pool.matched_across_policies) throw new Error('Ranking baseline did not use the exact production candidate pool.');
  if (receipt.deltas.mean_lateral_value <= 0) throw new Error('Fixture no longer exposes the expected lateral-value tradeoff.');
  if (receipt.deltas.mean_base_score >= 0) throw new Error('Fixture no longer exposes the expected base-utility tradeoff.');
  if (!Number.isFinite(receipt.instability.production.max_mean_rank_displacement)) throw new Error('Ranking instability receipt is missing.');
  if (receipt.delayed_feedback.raw_private_content !== false) throw new Error('Delayed feedback crossed the private-content boundary.');
  console.log('\nRanking evaluation receipt:');
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

function run(rootPath, kernelPath) {
  const rootSource = fs.readFileSync(rootPath, 'utf8');
  const root = extract(rootSource);
  const kernelSource = fs.existsSync(kernelPath) ? fs.readFileSync(kernelPath, 'utf8') : null;
  const kernel = kernelSource ? extract(kernelSource) : null;

  console.log(`root  (${rootPath}):`);
  for (const result of root) console.log(`  ${result.present ? 'OK  ' : 'MISS'}  ${result.name}`);

  if (!kernel) {
    console.log(`\nkernel file not found at ${kernelPath} — run after the build step that generates it.`);
    return root.every(result => result.present) ? 0 : 1;
  }

  console.log(`\nkernel (${kernelPath}):`);
  let drift = false;
  for (let index = 0; index < CHECKS.length; index += 1) {
    const left = root[index];
    const right = kernel[index];
    const ok = left.present === right.present && right.present === true;
    if (!ok) drift = true;
    console.log(`  ${ok ? 'MATCH' : '*** DRIFT ***'}  ${CHECKS[index].name}  (root:${left.present} kernel:${right.present})`);
  }
  const rootEvidence = sourceKernelEvidence(rootSource);
  const kernelEvidence = sourceKernelEvidence(kernelSource);
  if (!rootEvidence.ok || !kernelEvidence.ok) drift = true;
  if (drift) {
    console.error('\nKernel parity FAILED — manual-app/kernel.js no longer matches the root ranking contract.');
    return 1;
  }
  console.log('\nKernel parity OK — load-bearing root/manual terms match and are source-bound.');
  evaluateFixture(rootSource, kernelSource);
  return 0;
}

const [,, rootPath, kernelPath] = process.argv;
process.exit(run(rootPath || 'src/app.js', kernelPath || 'manual-app/kernel.js'));

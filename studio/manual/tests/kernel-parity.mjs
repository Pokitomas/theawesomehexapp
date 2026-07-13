// Regression guard: the manual edition claims to reuse the *exact* root saturation
// kernel (see issue #24/#29 — "not a forked recommender"). This statically extracts
// the load-bearing numeric constants from both root src/app.js and the generated
// manual-app/kernel.js and fails loudly if they ever drift apart, even by one digit.
// Catches silent kernel forks that `node --check` (syntax only) cannot.

import fs from 'node:fs';

const CHECKS = [
  { name: 'baseScore weights',       re: /baseScore\s*=\s*\.55\*post\.base\s*\+\s*\.30\*f\.affinity\s*\+\s*\.15\*post\.relevance/ },
  { name: 'lateralValue weights',    re: /\.24\*f\.sameWhyDifferentAxis[\s\S]{0,200}?-\s*\.15\*f\.graphicRepeat/ },
  { name: 'posteriorChoice sigmoid', re: /sigmoid\(\s*4\.2\s*\*\s*delta\s*\+\s*1\.15\s*\*\s*\(maxZ\s*-\s*\.85\)\s*\)/ },
  { name: 'riskFloor clamp',         re: /clamp\(\s*\(maxZ\s*-\s*\.55\)\s*\/\s*2\.8\s*,\s*0\s*,\s*\.43\s*\)/ },
  { name: 'gate target blend',       re: /riskFloor\s*\+\s*\.54\s*\*\s*posteriorChoice/ },
  { name: 'deep_saturation floor',   re: /Math\.max\(target,\s*\.48\)/ },
];

function extract(path) {
  const src = fs.readFileSync(path, 'utf8');
  return CHECKS.map(c => ({ name: c.name, present: c.re.test(src) }));
}

function run(rootPath, kernelPath) {
  const root = extract(rootPath);
  const kernel = fs.existsSync(kernelPath) ? extract(kernelPath) : null;

  console.log(`root  (${rootPath}):`);
  for (const r of root) console.log(`  ${r.present ? 'OK  ' : 'MISS'}  ${r.name}`);

  if (!kernel) {
    console.log(`\nkernel file not found at ${kernelPath} — run after the build step that generates it.`);
    return root.every(r => r.present) ? 0 : 1;
  }

  console.log(`\nkernel (${kernelPath}):`);
  let drift = false;
  for (let i = 0; i < CHECKS.length; i++) {
    const r = root[i], k = kernel[i];
    const ok = r.present === k.present && k.present === true;
    if (!ok) drift = true;
    console.log(`  ${ok ? 'MATCH' : '*** DRIFT ***'}  ${CHECKS[i].name}  (root:${r.present} kernel:${k.present})`);
  }
  if (drift) {
    console.error('\nKernel parity FAILED — manual-app/kernel.js no longer matches root src/app.js exactly.');
    return 1;
  }
  console.log('\nKernel parity OK — all load-bearing constants match root exactly.');
  return 0;
}

const [,, rootPath, kernelPath] = process.argv;
process.exit(run(rootPath || 'src/app.js', kernelPath || 'manual-app/kernel.js'));

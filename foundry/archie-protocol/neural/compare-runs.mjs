#!/usr/bin/env node
// Assemble the authoritative comparison table across every recorded routing
// run: audit-era candidates, mastery-era students, the deterministic
// projection (oracle), the sklearn factorized controller, and the NumPy
// transformer receipts in this directory. Emits markdown + JSON.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

const rows = [];
const pct = (x, digits = 1) => x == null ? '—' : (100 * x).toFixed(digits) + '%';

// Historical fixed points (source receipts cited in notes).
rows.push({ run: 'audit hashed-linear-sgd-v1 (rejected)', s498: 0.5683, s60: 0.5667, s48: 0.4792, s80: 0.7625, blind429: null, kind: 'trained', src: 'runs/linux-register-distill-20260720.json' });
rows.push({ run: 'audit order-context-hashed-sgd-v5 (rejected)', s498: 0.8594, s60: 0.6667, s48: 0.2708, s80: 0.7875, blind429: null, kind: 'trained', src: 'runs/linux-register-distill-20260720.json' });
rows.push({ run: 'base neural router (audit router-v4)', s498: 477 / 498, s60: 56 / 60, s48: 26 / 48, s80: 59 / 80, blind429: null, kind: 'trained', src: 'mastery/20260720/README.md' });
rows.push({ run: 'deterministic register projection (oracle)', s498: 1.0, s60: 1.0, s48: 1.0, s80: 75 / 80, blind429: null, kind: 'oracle', src: 'mastery/20260720 — encodes frozen phrases; excluded from trained comparisons' });
rows.push({ run: 'mastery transformer student (not admitted)', s498: 476 / 498, s60: 56 / 60, s48: 31 / 48, s80: 59 / 80, blind429: null, kind: 'trained', src: 'mastery/20260720/README.md' });
rows.push({ run: 'JS sparse MLP h1024 (branch)', s498: 0.749, s60: 0.6333, s48: 0.3542, s80: 75 / 80, blind429: null, kind: 'trained', src: 'runs/route-model-receipt.json (route-only; suite-80 head-to-head vs Q6)' });
rows.push({ run: 'sklearn factorized controller (upstream)', s498: null, s60: null, s48: null, s80: null, blind429: 0.8997, kind: 'trained+scaffold', src: 'factorized/upstream-evaluation-receipt.json' });

// NumPy transformer receipts.
const runsDir = path.join(here, 'runs');
if (fs.existsSync(runsDir)) {
  for (const f of fs.readdirSync(runsDir).filter(f => f.endsWith('-receipt.json')).sort()) {
    const r = read(path.join(runsDir, f));
    const g = (k, field) => r.results?.[k]?.[field] ?? null;
    rows.push({
      run: `np-transformer ${r.tag} seed${r.config?.seed}`,
      s498: g('router-v2-original-heldout', 'route_accuracy'),
      s60: g('router-real-v2-heldout', 'route_accuracy'),
      s48: g('router-real-v3-final', 'route_accuracy'),
      s80: null,
      blind429: g('blind_429', 'full_accuracy'),
      blind429_route: g('blind_429', 'route_accuracy'),
      conf_ok: r.results?.blind_429?.mean_confidence_correct,
      conf_bad: r.results?.blind_429?.mean_confidence_incorrect,
      params: r.model?.parameters,
      kind: 'trained-neural',
      src: `neural/runs/${f}`
    });
  }
}

let md = '| run | kind | 498 | 60 | 48 | suite-80 | blind-429 (full) | conf ok/bad |\n|---|---|---:|---:|---:|---:|---:|---|\n';
for (const r of rows) {
  md += `| ${r.run} | ${r.kind} | ${pct(r.s498)} | ${pct(r.s60)} | ${pct(r.s48)} | ${pct(r.s80)} | ${pct(r.blind429)} | ${r.conf_ok != null ? `${r.conf_ok}/${r.conf_bad}` : '—'} |\n`;
}
fs.writeFileSync(path.join(here, 'runs', 'comparison.md'), md);
fs.writeFileSync(path.join(here, 'runs', 'comparison.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(md);

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const active = [
  ['README.md', 'markdown'],
  ['00-ARCHIE-MODEL/BENCHMARKS.json', 'text'],
  ['labs/archie-one-surface/index.html', 'html']
];

const rules = [
  { pattern: /\bdie loud\b/gi, replacement: 'fail with an explicit error' },
  { pattern: /\bwar room\b/gi, replacement: 'operations view / incident view' },
  { pattern: /\bghost state(?:s)?\b/gi, replacement: 'near-degenerate numerical state' },
  { pattern: /\bhidden tunnel(?:s)?\b/gi, replacement: 'redundant transform path' },
  { pattern: /\bannihilat(?:e|es|ed|ing|ion)\b/gi, replacement: 'cancel / cancellation' },
  { pattern: /\bweaponiz(?:e|es|ed|ing|ation)\b/gi, replacement: 'apply / use' },
  { pattern: /\bsurveillance\b/gi, replacement: 'monitoring / telemetry' },
  { pattern: /\bkill switch\b/gi, replacement: 'disable control' },
  { pattern: /\battack surface\b/gi, replacement: 'exposed interface (unless literal security analysis)' },
  { pattern: /\bautocourt\b/gi, replacement: 'automated evaluation' },
  { pattern: /\b(?:re)?court(?:s)?\b/gi, replacement: 'evaluation gate / evaluation rerun' },
  { pattern: /\bpromotion\b/gi, replacement: 'admission / admission status' },
  { pattern: /\bhostile\b/gi, replacement: 'invalid / incompatible / robustness, depending on mechanism' }
];

function visible(source, kind) {
  if (kind === 'markdown') return source.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]+`/g, '');
  if (kind === 'html') return source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--([\s\S]*?)-->/g, '').replace(/<[^>]+>/g, ' ');
  return source;
}
function locate(source, index) {
  const before = source.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

const findings = [];
for (const [relative, kind] of active) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`Active surface missing: ${relative}`);
  const source = visible(fs.readFileSync(absolute, 'utf8'), kind);
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(source); match; match = rule.pattern.exec(source)) {
      findings.push({ relative, ...locate(source, match.index), text: match[0], replacement: rule.replacement });
      if (!match[0].length) rule.pattern.lastIndex += 1;
    }
  }
}
if (findings.length) {
  console.error('Engineering-language check failed. Use mechanism-first wording; preserve compatibility identifiers only where required.');
  for (const item of findings) console.error(`${item.relative}:${item.line}:${item.column} ${JSON.stringify(item.text)} -> ${item.replacement}`);
  process.exit(1);
}
console.log(`engineering-language: ok (${active.length} active surfaces checked)`);

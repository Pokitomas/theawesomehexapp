#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const activeProse = [
  'README.md',
  'AGENTS.md',
  'HANDOFF.md',
  'ARCHIE_RUNTIME.md',
  '00-ARCHIE-MODEL/BENCHMARKS.json',
];
const activeUi = ['archie-operator/index.html'];
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
];
const proseRules = [
  { pattern: /\bautocourt\b/gi, replacement: 'automated evaluation' },
  { pattern: /\bcourt(?:s)?\b/gi, replacement: 'evaluation gate' },
  { pattern: /\bpromotion\b/gi, replacement: 'admission / admission status' },
  { pattern: /\bhostile\b/gi, replacement: 'invalid / incompatible / security robustness' },
];
function stripMarkdownCode(input) { return input.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]+`/g, ''); }
function stripHtmlExecutableContent(input) { return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--([\s\S]*?)-->/g, '').replace(/<[^>]+>/g, ' '); }
function locate(source, index) { const before = source.slice(0, index); return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') }; }
function check(relative, source, ruleset) {
  const findings = [];
  for (const rule of ruleset) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(source); match; match = rule.pattern.exec(source)) {
      findings.push({ relative, ...locate(source, match.index), text: match[0], replacement: rule.replacement });
      if (!match[0].length) rule.pattern.lastIndex += 1;
    }
  }
  return findings;
}
const findings = [];
for (const relative of activeProse) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  const raw = fs.readFileSync(absolute, 'utf8');
  findings.push(...check(relative, relative.endsWith('.md') ? stripMarkdownCode(raw) : raw, [...rules, ...proseRules]));
}
for (const relative of activeUi) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  findings.push(...check(relative, stripHtmlExecutableContent(fs.readFileSync(absolute, 'utf8')), rules));
}
if (findings.length) {
  console.error('Engineering-language check failed. Use mechanism-first wording; keep compatibility identifiers inside code/backticks when required.');
  for (const item of findings) console.error(`${item.relative}:${item.line}:${item.column}  ${JSON.stringify(item.text)} -> ${item.replacement}`);
  process.exit(1);
}
console.log(`engineering-language: ok (${activeProse.length + activeUi.length} active surfaces checked)`);

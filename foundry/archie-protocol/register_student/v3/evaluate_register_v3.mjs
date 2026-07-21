#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidateDir, inputPath, outputPath] = process.argv.slice(2);
if (!candidateDir || !inputPath || !outputPath) {
  console.error('usage: evaluate_register_v3.mjs CANDIDATE_DIR INPUT_JSON OUTPUT_JSON');
  process.exit(2);
}

const modelModule = await import(pathToFileURL(path.resolve(candidateDir, 'register-student-model.mjs')));
const coreModule = await import(pathToFileURL(path.resolve(candidateDir, 'register-student-core.mjs')));
const model = modelModule.REGISTER_STUDENT_MODEL;
const controller = coreModule.createRegisterStudentController(model);
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function matches(actual, expected) {
  if (typeof expected === 'string') return actual.route === expected;
  if (actual.route !== expected.route || actual.authority !== expected.authority || actual.context !== expected.context) return false;
  const left = actual.outcomes || [];
  const right = expected.outcomes || [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evaluate(name, rows) {
  let correct = 0;
  const errors = [];
  const perCategory = {};
  for (const row of rows) {
    const actual = controller.predict(row.request, {
      attachments: row.attachments || '',
      memory: row.memory || '',
      thread: row.thread || ''
    });
    const passed = matches(actual, row.expected);
    correct += Number(passed);
    const category = row.category || 'legacy';
    const bucket = perCategory[category] ||= { correct: 0, examples: 0 };
    bucket.examples += 1;
    bucket.correct += Number(passed);
    if (!passed) errors.push({ id: row.id, category, expected: row.expected, actual, request: row.request });
  }
  for (const bucket of Object.values(perCategory)) bucket.accuracy = bucket.correct / bucket.examples;
  return { name, examples: rows.length, correct, accuracy: correct / rows.length, per_category: perCategory, errors };
}

const suites = [evaluate('opened-v2-pack', input.pack)];
for (const [name, rows] of Object.entries(input.legacy)) suites.push(evaluate(name, rows));
const byName = Object.fromEntries(suites.map(suite => [suite.name, suite]));
const passed =
  byName['opened-v2-pack'].correct === byName['opened-v2-pack'].examples &&
  byName['router-real-v2-heldout'].correct === byName['router-real-v2-heldout'].examples &&
  byName['router-real-v3-final'].correct === byName['router-real-v3-final'].examples &&
  byName['router-v2-original-heldout'].accuracy >= 0.98;
const receipt = {
  schema: 'archie-register-v3-development-evaluation/v1',
  passed,
  candidate: {
    model_id: model.model_id,
    controller_schema: 'v3-compositional-repair',
    learned_weights_changed: false
  },
  suites
};
fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n');
if (!passed) process.exit(1);

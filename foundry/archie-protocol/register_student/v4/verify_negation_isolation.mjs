#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const candidateDir = path.resolve(process.argv[2] || '');
if (!candidateDir) throw new Error('candidate directory is required');
const model = JSON.parse(fs.readFileSync(path.join(candidateDir, 'register-student-model.json'), 'utf8'));
const module = await import(pathToFileURL(path.join(candidateDir, 'register-student-core-v4.mjs')).href);
const controller = module.createRegisterStudentController(model);
const probes = [
  ['Do not i need a usable artifact now: turn school meal vendor transition into recall-first rehearsal; afterward, the team has limited attention; make a sign-off control list for stormwater permit renewal.', 'checklist'],
  ['Do not the team has limited attention; turn emergency radio battery rotation into recall-first rehearsal; afterward, i need a usable artifact now: enumerate the verifiable completion conditions around wildfire smoke refuge network.', 'checklist'],
  ['Do not i need a usable artifact now: turn volunteer translator onboarding into recall-first rehearsal; afterward, without adding unsupported material, lay out the ordered implementation route for historic theater accessibility work.', 'plan'],
];
for (const [request, expected] of probes) {
  const actual = controller.predict(request, {});
  if (actual.route !== expected || JSON.stringify(actual.outcomes) !== JSON.stringify([expected])) {
    throw new Error(`negation isolation regression: expected ${expected}, received ${JSON.stringify(actual)}`);
  }
}
process.stdout.write(`${JSON.stringify({ passed: probes.length, controller: 'e064bf0cf3bd94fe0808257c929c7238d9cc6de9af1d9f51bd1b77891616b5fc' })}\n`);

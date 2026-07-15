#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import {
  buildExperimentPortfolio,
  createAssignments,
  createReceipt,
  integrateReports,
  paretoFront,
  stableJSONStringify,
  validateCandidateGenome,
  validateMission
} from './core.mjs';

async function readJSON(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function usage() {
  return [
    'Native model foundry protocol',
    '',
    'node foundry/cli.mjs validate-mission <mission.json>',
    'node foundry/cli.mjs assignments <mission.json>',
    'node foundry/cli.mjs integrate <mission.json> <reports.json>',
    'node foundry/cli.mjs portfolio <integration.json> [budget]',
    'node foundry/cli.mjs validate-genome <genome.json>',
    'node foundry/cli.mjs pareto <candidates.json> <objectives.json>',
    'node foundry/cli.mjs receipt <state.json>'
  ].join('\n');
}

const [command, ...args] = process.argv.slice(2);

try {
  let output;
  switch (command) {
    case 'validate-mission':
      output = validateMission(await readJSON(args[0]));
      break;
    case 'assignments':
      output = createAssignments(await readJSON(args[0]));
      break;
    case 'integrate': {
      const mission = await readJSON(args[0]);
      const reports = await readJSON(args[1]);
      output = integrateReports(reports, createAssignments(mission));
      break;
    }
    case 'portfolio':
      output = buildExperimentPortfolio(await readJSON(args[0]), { budget: args[1] === undefined ? Infinity : Number(args[1]) });
      break;
    case 'validate-genome':
      output = validateCandidateGenome(await readJSON(args[0]));
      break;
    case 'pareto':
      output = paretoFront(await readJSON(args[0]), await readJSON(args[1]));
      break;
    case 'receipt':
      output = createReceipt(await readJSON(args[0]));
      break;
    default:
      console.error(usage());
      process.exit(command ? 2 : 0);
  }
  console.log(stableJSONStringify(output));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exit(1);
}

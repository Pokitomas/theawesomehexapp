import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import {
  buildExperimentPortfolio,
  createAssignments,
  createReceipt,
  integrateReports,
  stableJSONStringify,
  validateMission
} from './core.mjs';

function cleanArg(value, name) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

export function parseArgvJSON(value) {
  let parsed;
  try { parsed = JSON.parse(String(value ?? '')); }
  catch { throw new Error('Agent argv must be valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Agent argv must be a non-empty JSON array.');
  return parsed.map((entry, index) => cleanArg(entry, `agent argv[${index}]`));
}

function runProcess(argv, { cwd, input = '', env = process.env, timeout_ms = 900000 } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('Process argv is required.');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`Process timed out after ${timeout_ms}ms: ${argv.join(' ')}`));
      }
    }, timeout_ms);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) resolve(result);
      else reject(new Error(`Process exited ${code}: ${argv.join(' ')}\n${result.stderr.slice(0, 4000)}`));
    });
    child.stdin.end(input);
  });
}

async function gitStatus(cwd) {
  const result = await runProcess(['git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd, timeout_ms: 30000 });
  return result.stdout.trim().split('\n').filter(Boolean).sort();
}

function parseAgentReport(stdout, assignment) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error(`Agent ${assignment.role} returned no stdout.`);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (!fenced) throw new Error(`Agent ${assignment.role} did not return valid JSON.`);
    parsed = JSON.parse(fenced);
  }
  if (parsed.assignment_id && parsed.assignment_id !== assignment.assignment_id) {
    throw new Error(`Agent ${assignment.role} returned assignment_id ${parsed.assignment_id}, expected ${assignment.assignment_id}.`);
  }
  return {
    ...parsed,
    assignment_id: assignment.assignment_id,
    role: assignment.role
  };
}

export async function runParallelFoundry({
  mission: missionInput,
  agent_argv,
  cwd = process.cwd(),
  out_dir,
  budget,
  timeout_ms = 900000,
  env = process.env
}) {
  const mission = validateMission(missionInput);
  const argv = Array.isArray(agent_argv) ? agent_argv.map((entry, index) => cleanArg(entry, `agent_argv[${index}]`)) : parseArgvJSON(agent_argv);
  const outputDirectory = path.resolve(out_dir || path.join(cwd, '.foundry-runs', mission.id));
  const before = await gitStatus(cwd);
  if (before.length) throw new Error(`Foundry requires a clean worktree before read-only sprawl. Dirty paths: ${before.join(', ')}`);

  const assignments = createAssignments(mission);
  const startedAt = new Date().toISOString();
  const runs = await Promise.all(assignments.map(async assignment => {
    const start = Date.now();
    const result = await runProcess(argv, {
      cwd,
      input: `${stableJSONStringify(assignment)}\n`,
      env: {
        ...env,
        SIDEWAYS_FOUNDRY_ASSIGNMENT_ID: assignment.assignment_id,
        SIDEWAYS_FOUNDRY_ROLE: assignment.role,
        SIDEWAYS_FOUNDRY_READ_ONLY: '1'
      },
      timeout_ms
    });
    return {
      assignment,
      report: parseAgentReport(result.stdout, assignment),
      stderr: result.stderr.slice(0, 10000),
      duration_ms: Date.now() - start
    };
  }));

  const after = await gitStatus(cwd);
  if (stableJSONStringify(before, 0) !== stableJSONStringify(after, 0)) {
    const added = after.filter(item => !before.includes(item));
    throw new Error(`Read-only agent sprawl mutated the worktree: ${added.join(', ') || after.join(', ')}`);
  }

  const reports = runs.map(run => run.report);
  const integration = integrateReports(reports, assignments);
  const portfolio = buildExperimentPortfolio(integration, {
    budget: budget === undefined ? Number(mission.budget?.proxy_compute_units ?? Infinity) : Number(budget)
  });
  const receipt = createReceipt({
    mission,
    assignments,
    integration,
    portfolio,
    commands: [`${argv[0]} ${argv.slice(1).join(' ')}`],
    artifacts: [
      path.join(outputDirectory, 'assignments.json'),
      path.join(outputDirectory, 'reports.json'),
      path.join(outputDirectory, 'integration.json'),
      path.join(outputDirectory, 'portfolio.json'),
      path.join(outputDirectory, 'receipt.json')
    ]
  });

  await fs.mkdir(outputDirectory, { recursive: true });
  const outputs = {
    'mission.json': mission,
    'assignments.json': assignments,
    'reports.json': reports,
    'integration.json': integration,
    'portfolio.json': portfolio,
    'receipt.json': {
      ...receipt,
      runtime: {
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        role_durations_ms: Object.fromEntries(runs.map(run => [run.assignment.role, run.duration_ms])),
        stderr_present_roles: runs.filter(run => run.stderr.trim()).map(run => run.assignment.role)
      }
    }
  };
  await Promise.all(Object.entries(outputs).map(([filename, value]) => fs.writeFile(path.join(outputDirectory, filename), `${stableJSONStringify(value)}\n`)));
  return Object.freeze({ output_dir: outputDirectory, assignments, reports, integration, portfolio, receipt: outputs['receipt.json'] });
}

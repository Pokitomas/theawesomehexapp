#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
if (!args.length) {
  process.stderr.write('run-python: expected a Python script or module argument.\n');
  process.exitCode = 2;
} else {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'python', prefix: [] },
        { command: 'py', prefix: ['-3'] },
        { command: 'python3', prefix: [] }
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] }
      ];

  let selected = null;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true
    });
    if (!probe.error && probe.status === 0) {
      selected = candidate;
      break;
    }
  }

  if (!selected) {
    process.stderr.write('run-python: no usable Python 3 interpreter was found.\n');
    process.exitCode = 127;
  } else {
    const result = spawnSync(selected.command, [...selected.prefix, ...args], {
      stdio: 'inherit',
      shell: false,
      windowsHide: true
    });
    if (result.error) {
      process.stderr.write(`run-python: ${selected.command} failed to launch: ${result.error.message}\n`);
      process.exitCode = 1;
    } else if (result.signal) {
      process.stderr.write(`run-python: ${selected.command} terminated by ${result.signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}

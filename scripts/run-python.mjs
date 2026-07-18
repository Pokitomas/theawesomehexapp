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
        { command: 'py', prefix: ['-3'] },
        { command: 'python', prefix: [] },
        { command: 'python3', prefix: [] }
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] }
      ];

  let launched = false;
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefix, ...args], {
      stdio: 'inherit',
      shell: false,
      windowsHide: true
    });
    if (result.error?.code === 'ENOENT') continue;
    launched = true;
    if (result.error) {
      process.stderr.write(`run-python: ${candidate.command} failed to launch: ${result.error.message}\n`);
      process.exitCode = 1;
    } else if (result.signal) {
      process.stderr.write(`run-python: ${candidate.command} terminated by ${result.signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
    break;
  }

  if (!launched) {
    process.stderr.write('run-python: no Python 3 launcher was found (tried py -3, python, and python3 where applicable).\n');
    process.exitCode = 127;
  }
}

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}

export function publishHumanSurfaces({ root = process.cwd(), output = 'dist' } = {}) {
  const repositoryRoot = path.resolve(root);
  const outputRoot = path.resolve(repositoryRoot, output);
  const founderRoot = path.join(repositoryRoot, 'founder');
  const foundryRoot = path.join(repositoryRoot, 'foundry');
  const exampleRoot = path.join(repositoryRoot, 'examples', 'site');

  for (const required of [
    path.join(founderRoot, 'index.html'),
    path.join(founderRoot, 'founder.css'),
    path.join(founderRoot, 'founder.js'),
    path.join(foundryRoot, 'index.html'),
    path.join(foundryRoot, 'foundry.css'),
    path.join(foundryRoot, 'foundry.js'),
    path.join(exampleRoot, 'index.html'),
    path.join(exampleRoot, 'site.css'),
    path.join(exampleRoot, 'site.js')
  ]) {
    if (!fs.existsSync(required)) throw new Error(`Missing human surface asset: ${path.relative(repositoryRoot, required)}`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });

  const founderHtml = fs.readFileSync(path.join(founderRoot, 'index.html'), 'utf8');
  const rootHtml = founderHtml
    .replaceAll('href="../archie/"', 'href="./archie/"')
    .replaceAll('href="../foundry/"', 'href="./foundry/"')
    .replaceAll('href="../world-expo/"', 'href="./world-expo/"')
    .replaceAll('href="../examples/site/"', 'href="./examples/site/"');

  fs.writeFileSync(path.join(outputRoot, 'index.html'), rootHtml);
  copyFile(path.join(founderRoot, 'founder.css'), path.join(outputRoot, 'founder.css'));
  copyFile(path.join(founderRoot, 'founder.js'), path.join(outputRoot, 'founder.js'));

  const founderDestination = path.join(outputRoot, 'founder');
  fs.rmSync(founderDestination, { recursive: true, force: true });
  copyDirectory(founderRoot, founderDestination);

  const foundryDestination = path.join(outputRoot, 'foundry');
  fs.rmSync(foundryDestination, { recursive: true, force: true });
  copyFile(path.join(foundryRoot, 'index.html'), path.join(foundryDestination, 'index.html'));
  copyFile(path.join(foundryRoot, 'foundry.css'), path.join(foundryDestination, 'foundry.css'));
  copyFile(path.join(foundryRoot, 'foundry.js'), path.join(foundryDestination, 'foundry.js'));

  const exampleDestination = path.join(outputRoot, 'examples', 'site');
  fs.rmSync(exampleDestination, { recursive: true, force: true });
  copyDirectory(exampleRoot, exampleDestination);

  const receipt = {
    schema: 'archie-human-surfaces-publish/v1',
    root_surface: 'founder',
    routes: ['/', '/founder/', '/foundry/', '/examples/site/'],
    legacy_sample_is_product_root: false,
    files: [
      'index.html',
      'founder.css',
      'founder.js',
      'founder/index.html',
      'foundry/index.html',
      'examples/site/index.html'
    ]
  };
  fs.writeFileSync(path.join(outputRoot, 'human-surfaces-publish.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const invokedAsMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  try {
    const receipt = publishHumanSurfaces({ output: process.argv[2] || 'dist' });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

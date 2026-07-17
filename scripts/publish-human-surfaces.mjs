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
  const applicationDirectories = ['desktop', 'archie', 'maker', 'founder', 'foundry', 'world-expo'];
  const exampleRoot = path.join(repositoryRoot, 'examples', 'site');

  for (const application of applicationDirectories) {
    const index = path.join(repositoryRoot, application, 'index.html');
    if (!fs.existsSync(index)) throw new Error(`Missing human surface asset: ${path.relative(repositoryRoot, index)}`);
  }
  for (const required of [
    'desktop/desktop.css',
    'desktop/desktop.js',
    'archie/archie.js',
    'maker/maker.js',
    'maker/runtime-receipt.js',
    'founder/founder.js',
    'foundry/foundry.js',
    'world-expo/expo.js',
    'examples/site/index.html',
    'examples/site/site.css',
    'examples/site/site.js'
  ]) {
    const absolute = path.join(repositoryRoot, required);
    if (!fs.existsSync(absolute)) throw new Error(`Missing human surface asset: ${required}`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });

  const desktopHtml = fs.readFileSync(path.join(repositoryRoot, 'desktop', 'index.html'), 'utf8');
  const rootHtml = desktopHtml
    .replaceAll('href="../desktop/"', 'href="./desktop/"')
    .replaceAll('href="../archie/"', 'href="./archie/"')
    .replaceAll('href="../maker/"', 'href="./maker/"')
    .replaceAll('href="../founder/"', 'href="./founder/"')
    .replaceAll('href="../foundry/"', 'href="./foundry/"')
    .replaceAll('href="../world-expo/"', 'href="./world-expo/"');

  fs.writeFileSync(path.join(outputRoot, 'index.html'), rootHtml);
  copyFile(path.join(repositoryRoot, 'desktop', 'desktop.css'), path.join(outputRoot, 'desktop.css'));
  copyFile(path.join(repositoryRoot, 'desktop', 'desktop.js'), path.join(outputRoot, 'desktop.js'));

  for (const application of applicationDirectories) {
    const destination = path.join(outputRoot, application);
    fs.rmSync(destination, { recursive: true, force: true });
    copyDirectory(path.join(repositoryRoot, application), destination);
  }

  const exampleDestination = path.join(outputRoot, 'examples', 'site');
  fs.rmSync(exampleDestination, { recursive: true, force: true });
  copyDirectory(exampleRoot, exampleDestination);

  const receipt = {
    schema: 'archie-human-surfaces-publish/v2',
    root_surface: 'one-request-router',
    routes: ['/', '/desktop/', '/archie/', '/maker/', '/founder/', '/foundry/', '/world-expo/', '/examples/site/'],
    legacy_sample_is_product_root: false,
    product_model: 'one-task-progressive-views',
    files: [
      'index.html',
      'desktop.css',
      'desktop.js',
      'desktop/index.html',
      'archie/index.html',
      'maker/index.html',
      'maker/runtime-receipt.js',
      'founder/index.html',
      'foundry/index.html',
      'world-expo/index.html',
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

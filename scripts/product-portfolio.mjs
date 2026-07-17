#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORTFOLIO_PATH = path.resolve(moduleDirectory, '../product/product-portfolio.json');

const DECISIONS = new Set([
  'invest',
  'merge-commercially-with-archie',
  'retain-as-instrument',
  'incubate-evidence-lab'
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex')}`;
}

export function loadPortfolio(filePath = DEFAULT_PORTFOLIO_PATH) {
  const resolved = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read product portfolio ${resolved}: ${error.message}`);
  }
  validatePortfolio(parsed);
  return parsed;
}

function assertBand(errors, label, band) {
  if (!Array.isArray(band) || band.length !== 2 || !band.every(value => Number.isFinite(value))) {
    errors.push(`${label} must be a two-number range.`);
    return;
  }
  const [minimum, maximum] = band;
  if (minimum > maximum) errors.push(`${label} minimum cannot exceed maximum.`);
  if (minimum < 0) errors.push(`${label} cannot contain a negative value.`);
}

export function validatePortfolio(portfolio) {
  const errors = [];
  if (!portfolio || typeof portfolio !== 'object' || Array.isArray(portfolio)) {
    throw new Error('Product portfolio must be an object.');
  }
  if (portfolio.schema !== 'sideways-product-portfolio/v1') errors.push('Unsupported product portfolio schema.');
  if (!portfolio.claim_boundary) errors.push('A claim boundary is required.');

  const surfaces = portfolio.surfaces;
  if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces) || !Object.keys(surfaces).length) {
    errors.push('At least one product surface is required.');
  }

  const routes = Array.isArray(portfolio.routes) ? portfolio.routes : [];
  if (!routes.length) errors.push('At least one public route is required.');
  const paths = new Set();
  for (const [index, route] of routes.entries()) {
    const label = `routes[${index}]`;
    if (typeof route?.path !== 'string' || !route.path.startsWith('/') || !route.path.endsWith('/')) {
      errors.push(`${label}.path must start and end with '/'.`);
    } else if (paths.has(route.path)) {
      errors.push(`${label}.path duplicates ${route.path}.`);
    } else {
      paths.add(route.path);
    }
    if (!route?.surface || !surfaces?.[route.surface]) errors.push(`${label}.surface must name a declared surface.`);
    if (!route?.use_when || !route?.primary_action) errors.push(`${label} must explain when and why to use the route.`);
  }

  for (const [id, surface] of Object.entries(surfaces || {})) {
    if (!DECISIONS.has(surface?.decision)) errors.push(`surfaces.${id}.decision is unsupported.`);
    for (const field of ['product_identity', 'job_to_be_done', 'current_truth']) {
      if (!surface?.[field]) errors.push(`surfaces.${id}.${field} is required.`);
    }
    if (!Array.isArray(surface?.buyer) || !surface.buyer.length) errors.push(`surfaces.${id}.buyer must name at least one audience.`);
    if (!Array.isArray(surface?.promotion_gates) || surface.promotion_gates.length < 3) errors.push(`surfaces.${id}.promotion_gates must name at least three gates.`);

    const valueBands = surface?.value_hypothesis_usd;
    if (!valueBands || typeof valueBands !== 'object') {
      errors.push(`surfaces.${id}.value_hypothesis_usd is required.`);
    } else {
      for (const [name, band] of Object.entries(valueBands)) assertBand(errors, `surfaces.${id}.value_hypothesis_usd.${name}`, band);
    }

    if (!routes.some(route => route.surface === id)) errors.push(`surfaces.${id} has no usable route.`);
  }

  const expo = surfaces?.expo;
  if (expo) {
    if (expo.visibility !== 'research-preview') errors.push('Expo must remain a research preview until promotion.');
    if (expo.promotion_state !== 'blocked-pending-evidence') errors.push('Expo promotion must remain blocked pending evidence.');
    if (expo.capability_claim !== 'research-substrate-only') errors.push('Expo may claim only the research substrate before completed evidence.');
    if (!routes.some(route => route.path === '/world-expo/' && route.surface === 'expo')) errors.push('Expo research preview must use /world-expo/.');
  }

  const allocation = portfolio?.portfolio_decision?.capital_allocation_percent;
  if (!allocation || typeof allocation !== 'object') {
    errors.push('Capital allocation is required.');
  } else {
    const values = Object.values(allocation);
    if (!values.every(value => Number.isFinite(value) && value >= 0)) errors.push('Capital allocation values must be non-negative numbers.');
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total !== 100) errors.push(`Capital allocation must total 100, received ${total}.`);
  }

  if (!Array.isArray(portfolio.retirements) || !portfolio.retirements.length) errors.push('At least one retired assumption is required.');
  if (!Array.isArray(portfolio.market_anchors) || portfolio.market_anchors.length < 3) errors.push('At least three market anchors are required.');

  if (errors.length) throw new Error(`Product portfolio rejected:\n- ${errors.join('\n- ')}`);
  return true;
}

export function resolveRoute(portfolio, routePath) {
  validatePortfolio(portfolio);
  return portfolio.routes.find(route => route.path === String(routePath || '').trim()) || null;
}

export function buildAdmissionReceipt(portfolio) {
  validatePortfolio(portfolio);
  const body = {
    schema: 'sideways-product-portfolio-admission/v1',
    portfolio_schema: portfolio.schema,
    portfolio_digest: digest(portfolio),
    routes: portfolio.routes.map(route => route.path).sort(),
    commercial_families: portfolio.portfolio_decision.commercial_families.map(family => family.id).sort(),
    research_surfaces: portfolio.portfolio_decision.research_instruments.slice().sort(),
    allocation_total_percent: Object.values(portfolio.portfolio_decision.capital_allocation_percent).reduce((sum, value) => sum + value, 0),
    expo_promotion_state: portfolio.surfaces.expo.promotion_state,
    false_completion_claimed: false
  };
  return { ...body, receipt_digest: digest(body) };
}

function usd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

export function formatMarketTable(portfolio) {
  validatePortfolio(portfolio);
  const lines = ['SURFACE\tDECISION\tCURRENT ASSET HYPOTHESIS\tPRIMARY AUDIENCE'];
  for (const [id, surface] of Object.entries(portfolio.surfaces)) {
    const current = surface.value_hypothesis_usd.current_code_and_research_asset;
    lines.push(`${id}\t${surface.decision}\t${usd(current[0])}–${usd(current[1])}\t${surface.buyer.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatRoutes(portfolio) {
  validatePortfolio(portfolio);
  return `${portfolio.routes.map(route => `${route.path}\t${route.surface}\t${route.primary_action}\t${route.use_when}`).join('\n')}\n`;
}

function usage() {
  return 'Usage:\n  npm run product:portfolio -- validate\n  npm run product:portfolio -- routes\n  npm run product:portfolio -- market\n  npm run product:portfolio -- route /archie/\n  npm run product:portfolio -- inspect\n';
}

export function runCli(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr) {
  const command = argv[0] || 'inspect';
  const portfolio = loadPortfolio(process.env.PRODUCT_PORTFOLIO_PATH || DEFAULT_PORTFOLIO_PATH);
  if (command === 'validate') {
    output.write(`${JSON.stringify(buildAdmissionReceipt(portfolio), null, 2)}\n`);
    return 0;
  }
  if (command === 'routes') {
    output.write(formatRoutes(portfolio));
    return 0;
  }
  if (command === 'market') {
    output.write(formatMarketTable(portfolio));
    return 0;
  }
  if (command === 'route') {
    const route = resolveRoute(portfolio, argv[1]);
    if (!route) {
      errorOutput.write(`Unknown product route: ${argv[1] || '(missing)'}\n`);
      return 2;
    }
    output.write(`${JSON.stringify({ ...route, product: portfolio.surfaces[route.surface] }, null, 2)}\n`);
    return 0;
  }
  if (command === 'inspect') {
    output.write(`${JSON.stringify({ decision: portfolio.portfolio_decision, routes: portfolio.routes, retirements: portfolio.retirements, admission: buildAdmissionReceipt(portfolio) }, null, 2)}\n`);
    return 0;
  }
  errorOutput.write(`Unknown command: ${command}\n${usage()}`);
  return 2;
}

const invokedAsMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

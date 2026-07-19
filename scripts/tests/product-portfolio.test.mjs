import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORTFOLIO_PATH,
  buildAdmissionReceipt,
  digest,
  formatMarketTable,
  formatRoutes,
  loadPortfolio,
  resolveRoute,
  stableStringify,
  validatePortfolio
} from '../product-portfolio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const portfolio = loadPortfolio(DEFAULT_PORTFOLIO_PATH);

assert.equal(validatePortfolio(portfolio), true);
assert.equal(Object.values(portfolio.portfolio_decision.capital_allocation_percent).reduce((sum, value) => sum + value, 0), 100);
assert.ok(portfolio.portfolio_decision.capital_allocation_percent['foundry-research-subsidy'] >= 25);

const expectedRoutes = {
  '/': 'founder',
  '/founder/': 'founder',
  '/archie/': 'archie',
  '/maker/': 'maker',
  '/foundry/': 'foundry',
  '/world-expo/': 'expo',
  '/examples/site/': 'sample-site'
};
for (const [route, surface] of Object.entries(expectedRoutes)) assert.equal(resolveRoute(portfolio, route)?.surface, surface);
assert.equal(resolveRoute(portfolio, '/manual/'), null);
assert.equal(resolveRoute(portfolio, '/sideways/'), null);

assert.equal(portfolio.surfaces.founder.decision, 'publish-human-surface');
assert.equal(portfolio.surfaces.archie.decision, 'invest');
assert.equal(portfolio.surfaces.maker.decision, 'merge-commercially-with-archie');
assert.equal(portfolio.surfaces.foundry.decision, 'operate-human-research-cockpit');
assert.equal(portfolio.surfaces.expo.decision, 'incubate-evidence-lab');
assert.equal(portfolio.surfaces['sample-site'].decision, 'retain-as-example');
assert.equal(portfolio.surfaces.sideways, undefined);
assert.ok(portfolio.surfaces.founder.not.includes('training dashboard'));
assert.ok(portfolio.surfaces.foundry.not.includes('robot self-administration page'));
assert.ok(portfolio.surfaces['sample-site'].not.includes('training database'));
assert.equal(portfolio.surfaces.expo.visibility, 'research-preview');
assert.equal(portfolio.surfaces.expo.promotion_state, 'blocked-pending-evidence');
assert.equal(portfolio.surfaces.expo.capability_claim, 'research-substrate-only');

assert.equal(portfolio.portfolio_decision.commercial_families.length, 1);
const family = portfolio.portfolio_decision.commercial_families[0];
assert.equal(family.id, 'archie-system');
assert.deepEqual(family.surfaces, ['founder', 'archie', 'maker', 'foundry']);
assert.equal(family.separate_company_for_each_surface, false);
assert.deepEqual(portfolio.portfolio_decision.research_instruments, ['foundry', 'expo']);
assert.deepEqual(portfolio.portfolio_decision.ordinary_outputs, ['sample-site']);

for (const [surfaceId, surface] of Object.entries(portfolio.surfaces)) {
  const [minimum, maximum] = surface.value_hypothesis_usd.current_code_and_research_asset;
  assert.ok(Number.isFinite(minimum) && Number.isFinite(maximum));
  assert.ok(minimum <= maximum, `${surfaceId} current asset range must be ordered`);
  assert.ok(surface.current_truth.length > 40, `${surfaceId} must state current truth, not only a pitch`);
  assert.ok(surface.promotion_gates.length >= 3, `${surfaceId} must have concrete promotion gates`);
}

const receipt = buildAdmissionReceipt(portfolio);
assert.equal(receipt.schema, 'archie-product-portfolio-admission/v2');
assert.equal(receipt.portfolio_digest, digest(portfolio));
assert.equal(receipt.allocation_total_percent, 100);
assert.equal(receipt.foundry_research_subsidy_percent, 35);
assert.equal(receipt.founder_owns_root, true);
assert.equal(receipt.sideways_is_privileged_surface, false);
assert.equal(receipt.expo_promotion_state, 'blocked-pending-evidence');
assert.equal(receipt.false_completion_claimed, false);
const { receipt_digest, ...receiptBody } = receipt;
assert.equal(receipt_digest, digest(receiptBody));
assert.equal(stableStringify(portfolio), stableStringify(JSON.parse(JSON.stringify(portfolio))));

const routeOutput = formatRoutes(portfolio);
for (const route of Object.keys(expectedRoutes)) assert.ok(routeOutput.includes(`${route}\t`));
const marketOutput = formatMarketTable(portfolio);
for (const surface of ['founder', 'archie', 'maker', 'foundry', 'expo', 'sample-site']) assert.ok(marketOutput.includes(`${surface}\t`));
assert.ok(!marketOutput.includes('sideways\t'));

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const portfolioDocument = fs.readFileSync(path.join(root, 'PRODUCT_PORTFOLIO.md'), 'utf8');
const modelPackageReadme = fs.readFileSync(path.join(root, '00-ARCHIE-MODEL', 'README.md'), 'utf8');
const canonicalDocuments = `${readme}\n${portfolioDocument}\n${modelPackageReadme}`;
for (const route of Object.keys(expectedRoutes)) {
  assert.ok(canonicalDocuments.includes(route), `canonical repository documents must route people to ${route}`);
  assert.ok(portfolioDocument.includes(route), `portfolio document must explain ${route}`);
}
for (const phrase of [
  'Founder gives ordinary humans creation power',
  'Foundry gives ordinary humans model-research power',
  'former Sideways implementation',
  'anti-convergence research ground'
]) assert.ok(canonicalDocuments.includes(phrase), `missing product law: ${phrase}`);
assert.match(readme, /begin with \[`00-ARCHIE-MODEL\/`\]/);
assert.match(modelPackageReadme, /canonical model package/);

for (const relative of [
  'founder/index.html',
  'foundry/index.html',
  'foundry/foundry.css',
  'foundry/foundry.js',
  'examples/site/index.html',
  'examples/site/site.css',
  'examples/site/site.js'
]) assert.ok(fs.statSync(path.join(root, relative)).size > 0, `${relative} must exist`);

const invalidAllocation = structuredClone(portfolio);
invalidAllocation.portfolio_decision.capital_allocation_percent['foundry-research-subsidy'] = 24;
invalidAllocation.portfolio_decision.capital_allocation_percent['archie-intelligence'] = 46;
assert.throws(() => validatePortfolio(invalidAllocation), /Foundry research subsidy/);

const duplicateRoute = structuredClone(portfolio);
duplicateRoute.routes.push({ ...duplicateRoute.routes[0] });
assert.throws(() => validatePortfolio(duplicateRoute), /duplicates/);

const restoredSideways = structuredClone(portfolio);
restoredSideways.surfaces.sideways = structuredClone(portfolio.surfaces['sample-site']);
restoredSideways.routes.push({ path: '/sideways/', surface: 'sideways', name: 'Sideways', use_when: 'legacy', primary_action: 'restore' });
assert.throws(() => validatePortfolio(restoredSideways), /may not remain a privileged product surface/);

const falseExpoClaim = structuredClone(portfolio);
falseExpoClaim.surfaces.expo.capability_claim = 'promoted-multimodal-product';
assert.throws(() => validatePortfolio(falseExpoClaim), /research substrate/);

console.log('product portfolio contract ok: the model-first root preserves every human product route through canonical documents, Founder serves humans, Foundry is human-operated research, Sideways is retired, ordinary programs are outputs, and Expo remains evidence-blocked');

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
assert.equal(portfolio.schema, 'sideways-product-portfolio/v1');
assert.equal(Object.values(portfolio.portfolio_decision.capital_allocation_percent).reduce((sum, value) => sum + value, 0), 100);

assert.equal(resolveRoute(portfolio, '/')?.surface, 'sideways');
assert.equal(resolveRoute(portfolio, '/manual/')?.surface, 'sideways');
assert.equal(resolveRoute(portfolio, '/archie/')?.surface, 'archie');
assert.equal(resolveRoute(portfolio, '/maker/')?.surface, 'maker');
assert.equal(resolveRoute(portfolio, '/founder/')?.surface, 'founder');
assert.equal(resolveRoute(portfolio, '/expo/'), null);

assert.equal(portfolio.surfaces.archie.decision, 'invest');
assert.equal(portfolio.surfaces.maker.decision, 'merge-commercially-with-archie');
assert.equal(portfolio.surfaces.sideways.decision, 'invest');
assert.equal(portfolio.surfaces.founder.decision, 'retain-as-instrument');
assert.equal(portfolio.surfaces.expo.decision, 'incubate-withheld');
assert.equal(portfolio.surfaces.expo.visibility, 'withheld-until-evidence');
assert.deepEqual(portfolio.surfaces.founder.value_hypothesis_usd.standalone_company, [0, 0]);
assert.deepEqual(portfolio.surfaces.expo.monetization_hypothesis.consumer_subscription_usd, [0, 0]);

const family = portfolio.portfolio_decision.commercial_families.find(item => item.id === 'archie-maker');
assert.ok(family);
assert.deepEqual(family.surfaces, ['archie', 'maker']);
assert.equal(family.separate_company_for_each_surface, false);

for (const [surfaceId, surface] of Object.entries(portfolio.surfaces)) {
  const [minimum, maximum] = surface.value_hypothesis_usd.current_code_and_research_asset;
  assert.ok(Number.isFinite(minimum) && Number.isFinite(maximum));
  assert.ok(minimum <= maximum, `${surfaceId} current asset range must be ordered`);
  assert.ok(surface.current_truth.length > 40, `${surfaceId} must state the current truth, not only a pitch`);
  assert.ok(surface.promotion_gates.length >= 3, `${surfaceId} must have concrete promotion gates`);
}

const receipt = buildAdmissionReceipt(portfolio);
assert.equal(receipt.schema, 'sideways-product-portfolio-admission/v1');
assert.equal(receipt.portfolio_digest, digest(portfolio));
assert.equal(receipt.allocation_total_percent, 100);
assert.deepEqual(receipt.withheld_surfaces, ['expo']);
assert.equal(receipt.false_completion_claimed, false);
const { receipt_digest, ...receiptBody } = receipt;
assert.equal(receipt_digest, digest(receiptBody));
assert.equal(stableStringify(portfolio), stableStringify(JSON.parse(JSON.stringify(portfolio))));

const routeOutput = formatRoutes(portfolio);
for (const route of ['/', '/manual/', '/archie/', '/maker/', '/founder/']) assert.ok(routeOutput.includes(`${route}\t`));
const marketOutput = formatMarketTable(portfolio);
for (const surface of ['archie', 'maker', 'sideways', 'founder', 'expo']) assert.ok(marketOutput.includes(`${surface}\t`));

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const portfolioDocument = fs.readFileSync(path.join(root, 'PRODUCT_PORTFOLIO.md'), 'utf8');
for (const token of ['/archie/', '/maker/', '/manual/', '/founder/']) {
  assert.ok(readme.includes(token), `README must route people to ${token}`);
  assert.ok(portfolioDocument.includes(token), `portfolio document must explain ${token}`);
}
for (const phrase of ['Archie + Maker', 'Founder is not a standalone product', 'Expo is withheld']) {
  assert.ok(portfolioDocument.includes(phrase));
}

const invalid = structuredClone(portfolio);
invalid.portfolio_decision.capital_allocation_percent.sideways = 31;
assert.throws(() => validatePortfolio(invalid), /must total 100/);

const duplicateRoute = structuredClone(portfolio);
duplicateRoute.routes.push({ ...duplicateRoute.routes[0] });
assert.throws(() => validatePortfolio(duplicateRoute), /duplicates/);

const falseExpoRoute = structuredClone(portfolio);
falseExpoRoute.routes.push({
  path: '/expo/',
  surface: 'expo',
  name: 'false expo',
  use_when: 'never',
  primary_action: 'pretend'
});
assert.throws(() => validatePortfolio(falseExpoRoute), /withheld but still claims a public route/);

console.log('product portfolio contract ok: every live path has one job, two commercial families survive, Founder is internal, and Expo remains withheld until evidence');

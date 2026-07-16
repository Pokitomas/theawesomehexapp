from pathlib import Path

source_path = Path('scripts/build-web-source-snapshot.mjs')
source = source_path.read_text()

old_loop = """  for (const provider of selected) {
    try {
      if (provider.kind === 'search' && provider.publicEndpoint !== true) {
"""
new_loop = """  for (const provider of selected) {
    const providerId = clean(provider?.id || provider?.name || `provider-${receipts.length + 1}`) || `provider-${receipts.length + 1}`;
    try {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('provider configuration must be an object');
      }
      if (provider.kind === 'search' && provider.publicEndpoint !== true) {
"""
if source.count(old_loop) != 1:
    raise SystemExit(f'provider loop insertion drift: {source.count(old_loop)} matches')
source = source.replace(old_loop, new_loop, 1)
source = source.replace("        provider: provider.id,\n        status: 'ready'", "        provider: providerId,\n        status: 'ready'", 1)
source = source.replace("        provider: provider.id,\n        status: 'unavailable'", "        provider: providerId,\n        status: 'unavailable'", 1)

old_defaults = """export function defaultProviders() {
  const configured = process.env.SIDEWAYS_PUBLIC_SOURCES
    ? JSON.parse(process.env.SIDEWAYS_PUBLIC_SOURCES)
    : [];
  if (Array.isArray(configured) && configured.length) return configured;
  return [
    wikinewsProvider('wikinews-a', 'A'),
    wikinewsProvider('wikinews-i', 'I'),
    wikinewsProvider('wikinews-q', 'Q'),
    hackerNewsProvider(0),
    hackerNewsProvider(1),
    hackerNewsProvider(2),
    mastodonProvider('mastodon-social', 'mastodon.social'),
    mastodonProvider('mstdn-social', 'mstdn.social'),
    mastodonProvider('fosstodon', 'fosstodon.org'),
    mastodonProvider('hachyderm', 'hachyderm.io'),
    mastodonProvider('techhub', 'techhub.social')
  ];
}
"""
new_defaults = """function builtinProviders() {
  return [
    wikinewsProvider('wikinews-a', 'A'),
    wikinewsProvider('wikinews-i', 'I'),
    wikinewsProvider('wikinews-q', 'Q'),
    hackerNewsProvider(0),
    hackerNewsProvider(1),
    hackerNewsProvider(2),
    mastodonProvider('mastodon-social', 'mastodon.social'),
    mastodonProvider('mstdn-social', 'mstdn.social'),
    mastodonProvider('fosstodon', 'fosstodon.org'),
    mastodonProvider('hachyderm', 'hachyderm.io'),
    mastodonProvider('techhub', 'techhub.social')
  ];
}

export function resolveProviderConfiguration(raw = process.env.SIDEWAYS_PUBLIC_SOURCES) {
  const configured = clean(raw);
  if (!configured) return Object.freeze({ providers: Object.freeze(builtinProviders()), receipt: null });
  try {
    const parsed = JSON.parse(configured);
    if (!Array.isArray(parsed)) throw new Error('configuration must be a JSON array');
    return Object.freeze({
      providers: Object.freeze(parsed.length ? parsed : builtinProviders()),
      receipt: null
    });
  } catch (error) {
    return Object.freeze({
      providers: Object.freeze(builtinProviders()),
      receipt: Object.freeze({
        provider: 'configured-public-sources',
        status: 'unavailable',
        admitted: 0,
        error: `invalid SIDEWAYS_PUBLIC_SOURCES: ${clean(error.message)}`
      })
    });
  }
}

export function defaultProviders() {
  return resolveProviderConfiguration().providers;
}
"""
if source.count(old_defaults) != 1:
    raise SystemExit(f'default provider replacement drift: {source.count(old_defaults)} matches')
source = source.replace(old_defaults, new_defaults, 1)

old_cli = """  const providers = args.providers
    ? JSON.parse(fs.readFileSync(args.providers, 'utf8'))
    : defaultProviders();
  const snapshot = await buildSnapshot(providers);
  writeSnapshot(snapshot, args.output);
"""
new_cli = """  const resolution = args.providers
    ? { providers: JSON.parse(fs.readFileSync(args.providers, 'utf8')), receipt: null }
    : resolveProviderConfiguration();
  const built = await buildSnapshot(resolution.providers);
  const snapshot = resolution.receipt
    ? Object.freeze({ ...built, receipts: Object.freeze([resolution.receipt, ...built.receipts]) })
    : built;
  writeSnapshot(snapshot, args.output);
"""
if source.count(old_cli) != 1:
    raise SystemExit(f'CLI provider replacement drift: {source.count(old_cli)} matches')
source = source.replace(old_cli, new_cli, 1)
source_path.write_text(source)

test_path = Path('scripts/tests/web-source-snapshot.test.mjs')
tests = test_path.read_text()
import_old = """  requestPublicResource,
  resolvePublicTarget,
  robotsAllows,
"""
import_new = """  requestPublicResource,
  resolveProviderConfiguration,
  resolvePublicTarget,
  robotsAllows,
"""
if tests.count(import_old) != 1:
    raise SystemExit(f'test import insertion drift: {tests.count(import_old)} matches')
tests = tests.replace(import_old, import_new, 1)

marker = "test('snapshot build is bounded, deduplicated, provenance-bearing, and fails providers honestly', async () => {"
addition = """test('invalid configured-source JSON falls back truthfully without aborting the snapshot', () => {
  const malformed = resolveProviderConfiguration('{not-json');
  assert.ok(malformed.providers.length > 0);
  assert.equal(malformed.receipt.provider, 'configured-public-sources');
  assert.equal(malformed.receipt.status, 'unavailable');
  assert.match(malformed.receipt.error, /invalid SIDEWAYS_PUBLIC_SOURCES/);

  const wrongShape = resolveProviderConfiguration('{\"url\":\"https://example.com\"}');
  assert.ok(wrongShape.providers.length > 0);
  assert.match(wrongShape.receipt.error, /JSON array/);

  const configured = resolveProviderConfiguration('[{\"id\":\"custom\",\"url\":\"https://example.com/feed\"}]');
  assert.equal(configured.receipt, null);
  assert.equal(configured.providers[0].id, 'custom');
});

test('malformed provider entries become bounded unavailable receipts instead of aborting the build', async () => {
  const snapshot = await buildSnapshot([null, { id: 'missing-url', name: 'Missing URL' }], {
    now: '2026-07-15T00:00:00.000Z'
  });
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.receipts.length, 2);
  assert.deepEqual(snapshot.receipts.map(receipt => receipt.status), ['unavailable', 'unavailable']);
  assert.equal(snapshot.receipts[0].provider, 'provider-1');
  assert.equal(snapshot.receipts[1].provider, 'missing-url');
});

"""
if tests.count(marker) != 1:
    raise SystemExit(f'test insertion drift: {tests.count(marker)} matches')
tests = tests.replace(marker, addition + marker, 1)
test_path.write_text(tests)

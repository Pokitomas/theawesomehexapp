from pathlib import Path

source_path = Path('scripts/build-web-source-snapshot.mjs')
source = source_path.read_text()
old = "    url: `https://${host}/api/v1/timelines/public?limit=40`\n"
new = "    url: `https://${host}/api/v1/timelines/public?limit=40&local=true`\n"
if source.count(old) != 1:
    raise SystemExit(f'Mastodon local-window replacement drift: {source.count(old)} matches')
source_path.write_text(source.replace(old, new, 1))

test_path = Path('scripts/tests/web-source-providers.test.mjs')
tests = test_path.read_text()
old_assertion = """    assert.equal(provider.robots, 'not-applicable');
    assert.ok(['public-api', 'mediawiki-api'].includes(provider.method));
"""
new_assertion = """    assert.equal(provider.robots, 'not-applicable');
    assert.ok(['public-api', 'mediawiki-api'].includes(provider.method));
    if (provider.kind === 'social') assert.equal(url.searchParams.get('local'), 'true');
"""
if tests.count(old_assertion) != 1:
    raise SystemExit(f'provider local-window assertion drift: {tests.count(old_assertion)} matches')
test_path.write_text(tests.replace(old_assertion, new_assertion, 1))

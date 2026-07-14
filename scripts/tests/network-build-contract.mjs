import fs from 'node:fs';
import assert from 'node:assert/strict';

const installer = fs.readFileSync('studio/manual/imports/apply.py', 'utf8');
const index = fs.readFileSync('studio/manual/product/network/index.js', 'utf8');
const client = fs.readFileSync('studio/manual/product/network/client.js', 'utf8');

assert.match(installer, /copytree\(network_source, network_target\)/, 'network directory is not copied into manual-app');
assert.match(installer, /src="\.\/network\/index\.js" data-sideways-network/, 'network module is not mounted in built HTML');
assert.match(index, /window\.SidewaysNetwork = SidewaysNetwork/, 'global network facade is missing');
assert.match(index, /sideways:networkready/, 'network readiness event is missing');
assert.match(client, /credentials: 'include'/, 'session cookies are not included');

console.log(JSON.stringify({
  copiedDirectory: 'studio/manual/product/network -> manual-app/network',
  mountedModule: './network/index.js',
  global: 'window.SidewaysNetwork',
  kernelTouched: false
}, null, 2));

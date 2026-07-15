import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLinuxMigrationPlan,
  buildRelayPacket,
  detectLinuxRuntime,
  normalizeOwnedPath,
  selectTransport,
  verifyRelayPacket
} from '../maker-linux-relay.mjs';

const base = 'cde52b39d41a2910047f92bfb6f873c912a6e553';

const common = {
  repository: 'Pokitomas/theawesomehexapp',
  base_sha: base,
  branch: 'agent/linux-github-relay',
  issue_number: 312,
  owned_paths: ['scripts/maker-linux-relay.mjs', 'scripts/tests/maker-linux-relay.test.mjs', 'maker/contracts/linux-relay.schema.json']
};

test('detects WSL without confusing it with an ordinary container', () => {
  assert.deepEqual(detectLinuxRuntime({
    platform: 'linux',
    release: '6.6.87.2-microsoft-standard-WSL2',
    procVersion: '',
    env: { WSL_DISTRO_NAME: 'Ubuntu', GITHUB_ACTIONS: 'true' }
  }), { platform: 'linux', supported: true, kind: 'wsl', distro: 'Ubuntu' });
  assert.equal(detectLinuxRuntime({ platform: 'darwin', env: {}, release: '', procVersion: '' }).supported, false);
});

test('selects the strongest truthful GitHub transport', () => {
  assert.equal(selectTransport({ git: true, github_dns: true, github_https: true }), 'native-git');
  assert.equal(selectTransport({ gh: true, gh_authenticated: true, api_dns: true, api_https: true }), 'gh-cli');
  assert.equal(selectTransport({ token: true, git_data_api: true, api_dns: true, api_https: true }), 'rest-git-data');
  assert.equal(selectTransport({ git: true, github_dns: false }), 'relay-packet');
});

test('builds an argv-only exact-base native checkout plan', () => {
  const plan = buildLinuxMigrationPlan({
    ...common,
    capabilities: { git: true, github_dns: true, github_https: true },
    runtime: { platform: 'linux', supported: true, kind: 'container', distro: null }
  });
  assert.equal(plan.mode, 'native-git');
  assert.deepEqual(plan.actions[1].args, ['-C', 'workspace', 'fetch', '--depth=1', 'origin', base]);
  assert.deepEqual(plan.actions.at(-1).args, ['-C', 'workspace', 'switch', '-c', common.branch]);
  assert.match(plan.plan_digest, /^[a-f0-9]{64}$/);
});

test('falls back to Git Data API before requiring an external relay', () => {
  const plan = buildLinuxMigrationPlan({
    ...common,
    capabilities: { token: true, git_data_api: true, api_dns: true, api_https: true }
  });
  assert.equal(plan.mode, 'rest-git-data');
  assert.equal(plan.actions[0].endpoint, `/repos/${common.repository}/git/commits/${base}`);
  assert.equal(plan.actions.at(-1).purpose, 'create the isolated head branch without force');
});

test('relay packets are deterministic, bounded, lease-aware, and tamper-evident', () => {
  const packet = buildRelayPacket({
    ...common,
    reason: 'container cannot resolve github.com',
    mutations: [{
      operation: 'create',
      path: 'scripts/maker-linux-relay.mjs',
      content: 'export const joined = true;\n'
    }]
  });
  assert.match(packet.packet_digest, /^[a-f0-9]{64}$/);
  assert.equal(verifyRelayPacket(packet).packet_digest, packet.packet_digest);
  const tampered = structuredClone(packet);
  tampered.mutations[0].content = 'export const joined = false;\n';
  assert.throws(() => verifyRelayPacket(tampered), /digest mismatch/);
});

test('relay packets reject path escape, lease escape, missing update preconditions, and credentials', () => {
  assert.throws(() => normalizeOwnedPath('../outside'), /escapes/);
  assert.throws(() => normalizeOwnedPath('.env'), /Secret-like/);
  assert.throws(() => buildRelayPacket({
    ...common,
    mutations: [{ operation: 'create', path: 'README.md', content: 'outside lease\n' }]
  }), /outside the owned lease/);
  assert.throws(() => buildRelayPacket({
    ...common,
    mutations: [{ operation: 'update', path: 'scripts/maker-linux-relay.mjs', content: 'x\n' }]
  }), /requires before_sha/);
  assert.throws(() => buildRelayPacket({
    ...common,
    mutations: [{ operation: 'create', path: 'scripts/maker-linux-relay.mjs', content: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890' }]
  }), /credential/);
});

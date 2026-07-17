import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { ArchieTrainerAuthority, verifyArchieBrainPackage } from '../maker-archie-trainer.mjs';

function artifact(role, character) {
  return { role, digest: character.repeat(64), bytes: 100, media_type: 'application/octet-stream' };
}

function trainer(clock = () => Date.UTC(2026, 6, 17, 16, 0, 0)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    authority: new ArchieTrainerAuthority({
      key_id: 'trainer-root-1', private_key: privateKey,
      public_keys: { 'trainer-root-1': publicKey }, supported_runtime_abis: ['archie-core/v1', 'archie-core/v2'], clock
    }),
    publicKey
  };
}

test('only Trainer produces a verifiable durable brain package', () => {
  const { authority, publicKey } = trainer();
  const unsigned = authority.build({
    package_id: 'archie-g1-0001', runtime_abi: 'archie-core/v1', working_state_schema: 'archie-working-state/v1',
    artifacts: [artifact('model', 'a')], sidepus_manifest_digests: ['b'.repeat(64)]
  });
  assert.throws(() => verifyArchieBrainPackage(unsigned, { public_keys: { 'trainer-root-1': publicKey } }), /not Trainer-signed/);
  const signed = authority.sign(unsigned);
  assert.equal(authority.verify(signed).verified, true);
  const tampered = { ...signed, architecture: { width: 999 } };
  assert.throws(() => authority.verify(tampered), /integrity check failed/);
});

test('compatible package promotion hot-swaps and binds an exact rollback parent', () => {
  const { authority } = trainer();
  const current = authority.sign(authority.build({
    package_id: 'archie-g1-0001', runtime_abi: 'archie-core/v1', working_state_schema: 'archie-working-state/v1', artifacts: [artifact('model', 'a')]
  }));
  const candidate = authority.sign(authority.build({
    package_id: 'archie-g1-0002', runtime_abi: 'archie-core/v1', working_state_schema: 'archie-working-state/v1',
    parent_digest: current.package_digest, artifacts: [artifact('model', 'c')]
  }));
  const receipt = authority.promote(candidate, { current, shadow_evaluation: { passed: true, frontier_digest: 'd'.repeat(64) } });
  assert.equal(receipt.mode, 'hot-swap');
  assert.equal(receipt.rollback_package_digest, current.package_digest);
  const rollback = authority.rollback(receipt, { reason: 'post-activation regression' });
  assert.equal(rollback.to_package_digest, current.package_digest);
});

test('runtime ABI changes require controlled Core restart and migration evidence', () => {
  const { authority } = trainer();
  const current = authority.sign(authority.build({
    package_id: 'archie-g1-0001', runtime_abi: 'archie-core/v1', working_state_schema: 'archie-working-state/v1', artifacts: [artifact('model', 'a')]
  }));
  const candidate = authority.sign(authority.build({
    package_id: 'archie-g2-0001', runtime_abi: 'archie-core/v2', working_state_schema: 'archie-working-state/v2',
    parent_digest: current.package_digest, artifacts: [artifact('model', 'e')]
  }));
  assert.throws(() => authority.promote(candidate, { current, shadow_evaluation: { passed: true } }), /migration adapter/);
  const receipt = authority.promote(candidate, {
    current, shadow_evaluation: { passed: true }, migration_adapter: { schema: 'archie-state-migration/v1', from: 'v1', to: 'v2', digest: 'f'.repeat(64) }
  });
  assert.equal(receipt.mode, 'controlled-core-restart');
});

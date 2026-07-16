# Archie local artifact runtime

This repository has an isolated executable artifact lane behind:

```text
npm run archie -- keygen --type recipient --output-dir ./keys/device
npm run archie -- keygen --type signing --output-dir ./keys/publisher
npm run archie -- package ./model.gguf --metadata ./metadata.json --output-dir ./package \
  --recipient-key ./keys/device/archie-device-x25519-public.pem \
  --signing-private ./keys/publisher/archie-publisher-ed25519-private.pem \
  --signing-public ./keys/publisher/archie-publisher-ed25519-public.pem
npm run archie -- pull ./package/manifest.json \
  --trust-key ./keys/publisher/archie-publisher-ed25519-public.pem \
  --device-key ./keys/device/archie-device-x25519-private.pem
npm run archie -- checkpoint <id@version> ./updated-model.gguf \
  --metadata ./updated-metadata.json \
  --lineage ./checkpoint-lineage.json \
  --output-dir ./updated-package \
  --recipient-key ./keys/device/archie-device-x25519-public.pem \
  --signing-private ./keys/publisher/archie-publisher-ed25519-private.pem \
  --signing-public ./keys/publisher/archie-publisher-ed25519-public.pem
npm run archie -- run <id@version> --prompt "..."
npm run archie -- inspect <id@version>
npm run archie -- benchmark <id@version> --suite <suite.json>
npm run archie -- remove <id@version>
npm run archie -- list
```

The operator experience is intentionally small. It is not an Ollama clone and it does not make Ollama the canonical artifact format.

## Signed manifest and nested envelope

`archie-encrypted-model-manifest/v1` binds:

- model ID, version, architecture, quantization, format, context limit, and runtime ABI;
- exact encrypted download bytes and decrypted installed bytes;
- the plaintext artifact filename and SHA-256 digest;
- every encrypted chunk's URL, ciphertext bytes/digest, plaintext bytes/digest, unique nonce, and authenticated-metadata digest;
- one wrapped data key per device or optional recovery recipient;
- required/recommended RAM, disk, and admitted backend claims;
- license, source/training provenance, and code commit;
- immutable-state and mutable-checkpoint digests;
- benchmark suite/report digests and an explicit claim boundary;
- a no-shell local process argument template;
- an Ed25519 outer-manifest signature and trusted publisher fingerprint.

The layers are exactly:

```text
signed outer manifest
  → X25519 + HKDF + AES-256-GCM wrapped random data key
    → independently AES-256-GCM authenticated encrypted chunks
```

Each artifact version receives a random 256-bit data key. Each chunk receives a unique 96-bit nonce and authenticated metadata binding model reference, runtime ABI, artifact digest, chunk index, plaintext size, and plaintext digest. The data key is wrapped independently to every declared X25519 recipient. An optional recovery recipient is simply a second wrapped-key recipient; the model bytes are not encrypted repeatedly.

`pull` verifies the outer publisher signature before transport, unwraps only to a matching device or recovery private key, supports resumable HTTP range or local-file ciphertext chunks, verifies each ciphertext digest, authenticates and decrypts each chunk independently, verifies each plaintext digest, verifies exact assembled bytes and artifact digest, installs by content address, and emits `archie-encrypted-model-pull-receipt/v1`.

The installed directory retains the signed outer manifest, encrypted pull receipt, and a locally signed installation projection used by the existing local run/inspect path. The installation projection never replaces the outer manifest as distribution authority.

The earlier `archie-model-manifest/v1` direct-artifact path remains supported for bounded development fixtures. Production Archie checkpoints should use the encrypted manifest.

## Mutable checkpoint transitions

`checkpoint` packages a candidate artifact only after matching it against an installed parent checkpoint. It emits `archie-checkpoint-transition-receipt/v1` and refuses to continue when any protected architecture surface drifts.

The following must remain exactly unchanged:

- model ID, architecture, runtime ABI, format, quantization, and context limit;
- runtime adapter and process argument template;
- immutable-state digest;
- the complete declared set of mutable regions.

The candidate must declare:

- a new version;
- a changed mutable-state digest;
- a fresh benchmark report digest;
- exact parent model, manifest, artifact, and mutable-state expectations;
- training-data, trajectory, training-config, optimizer, authority, and evaluation receipt digests;
- the training seed, teacher IDs, and rejected checkpoint digests.

The transition metadata is embedded into the signed encrypted manifest as `provenance.checkpoint_lineage`, while the separate transition receipt binds parent and candidate manifests, artifacts, state digests, exact sizes, and every enforced constraint.

This contract does not train weights and cannot independently prove that declared mutable regions correspond to specific tensor ranges inside an opaque model file. The trainer and benchmark pipeline must produce those independently verified inputs. The checkpoint command only admits and packages a transition that satisfies the declared immutable/mutable boundary.

## Local execution and benchmarks

`run` re-verifies the installed artifact, invokes only the configured local executable without a shell, and emits `archie-model-run-receipt/v1` bound to the artifact, manifest, prompt, arguments, output, environment, latency, and generation settings. No frontier API key is read or required.

`benchmark` executes `archie-benchmark-suite/v1` cases through the same local run path and emits a machine-readable report tied to the suite, model, artifact, environment, and individual run receipts.

## Trust and key separation

A manifest's embedded public key proves signature consistency but is not trust by itself. Normal pulls require one or more explicitly trusted publisher public-key files. `--allow-untrusted` is development-only and is recorded in the receipt.

Publisher Ed25519 signing keys, device/recovery X25519 wrapping keys, and random artifact data keys are separate purposes. Private keys are never written into manifests, chunks, receipts, benchmark fixtures, logs, browser storage, or Git.

All model-artifact keys are unrelated to PR #397's short-lived execution HMAC. The runtime never loads that HMAC and never treats it as a model-artifact key.

## Deliberate boundary

This is real encrypted artifact packaging, transport, checkpoint-transition admission, local process execution, inspection, removal, and benchmark receipt plumbing. It does **not** claim that a trained Archie neural checkpoint has been produced or promoted.

The default `npm run maker` path is unchanged by this tranche. Sideways remains deterministic state, Maker remains the only permissioned effect executor, and Archie model artifacts receive no privileged repository modification path.

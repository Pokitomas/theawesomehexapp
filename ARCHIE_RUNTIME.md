# Archie local artifact runtime

This repository now has an isolated executable artifact lane behind:

```text
npm run archie -- pull <manifest> --trust-key <public.pem>
npm run archie -- run <id@version> --prompt "..."
npm run archie -- inspect <id@version>
npm run archie -- benchmark <id@version> --suite <suite.json>
npm run archie -- remove <id@version>
npm run archie -- list
```

The operator experience is intentionally small. It is not an Ollama clone and it does not make Ollama the canonical artifact format.

## What exists

`archie-model-manifest/v1` binds:

- model ID, version, architecture, quantization, format, context limit, and runtime ABI;
- exact compressed/download and installed bytes;
- ordered chunk URLs, byte counts, and SHA-256 digests;
- the assembled artifact digest and filename;
- required/recommended RAM, disk, and admitted backend claims;
- license, source/training provenance, and code commit;
- immutable-state and mutable-checkpoint digests;
- benchmark suite/report digests and an explicit claim boundary;
- a no-shell local process argument template;
- an Ed25519 outer-manifest signature and trusted-key fingerprint.

`pull` verifies the signed manifest before transport, supports resumable HTTP range or local-file chunks, verifies every chunk independently, verifies exact assembled bytes and digest, installs by content address, and emits `archie-model-pull-receipt/v1`.

`run` re-verifies the installed artifact, invokes only the configured local executable without a shell, and emits `archie-model-run-receipt/v1` bound to the artifact, manifest, prompt, arguments, output, environment, latency, and generation settings. No frontier API key is read or required.

`benchmark` executes `archie-benchmark-suite/v1` cases through the same local run path and emits a machine-readable report tied to the suite, model, artifact, environment, and individual run receipts.

## Trust and keys

A manifest's embedded public key proves signature consistency but is not trust by itself. Normal pulls require one or more explicitly trusted public-key files:

```text
npm run archie -- pull ./manifest.json --trust-key ./publisher-ed25519-public.pem
```

`--allow-untrusted` is an explicit development-only mode. It still verifies the self-signature and all byte/digest constraints, but the pull receipt records `self-signed-untrusted`.

The manifest signing key is unrelated to PR #397's short-lived execution HMAC. The runtime never loads that HMAC and never treats it as a model-artifact key.

## Deliberate boundary

This tranche is real artifact transport, local process execution, inspection, removal, and benchmark receipt plumbing. It does **not** claim that a trained Archie neural checkpoint has been produced or promoted.

The v1 direct-artifact contract installs the exact transported bytes. Independently authenticated encrypted chunks and installation-key wrapping remain required before a production Archie checkpoint can satisfy the complete nested-envelope requirement in issue #398. Until that lands, this lane must not be described as the completed encrypted distribution protocol.

The default `npm run maker` path is unchanged by this tranche. Sideways remains deterministic state, Maker remains the only permissioned effect executor, and Archie model artifacts receive no privileged repository modification path.

# Archie router mastery — terminal research state

Starting commit: `2dc828454fe4dc27478d5172f560e645bf0bf249`  
Production: admitted register-aware router, unchanged  
Promotion: `not-admitted`

The branch now preserves a complete causal transformer sequence, a mass-matched authored-diversity test, protected route-head adaptation, and two learned factorized candidates. None replaces production.

## Terminal evidence

The compact, digest-bound terminal receipt is retained at:

- `foundry/archie-protocol/neural/runs/terminal/terminal-router-mastery.json`
- `foundry/archie-protocol/neural/runs/terminal/TERMINAL_ROUTER_MASTERY.md`

Full checkpoints and detailed receipts remain in immutable Actions artifacts referenced by exact run, artifact, model, and receipt digests in those files. Multi-megabyte research checkpoints are not duplicated into the permanent branch.

## Transformer sequence

| Run | Mechanism | Blind full | 498 | 60 | 48 |
|---|---|---:|---:|---:|---:|
| A | Word-token NumPy transformer | 54.8% | 62.2% | 50.0% | 29.2% |
| B | Subword transformer baseline | 54.3% | 63.1% | 41.7% | 39.6% |
| C | Real-dominant mix plus shared-trunk fine-tune | 15.6% | 55.0% | 35.0% | 25.0% |
| D | Exact C main phase, fine-tune removed | 50.6% | 64.7% | 43.3% | 33.3% |
| E | D plus protected route-head adaptation | 50.6% | 64.7% | 43.3% | 33.3% |
| H2 | 925 unique route-only authored rows, mass-matched | 52.9% | 61.4% | 31.7% | 22.9% |

### What is causally established

1. **Vocabulary coverage was not the dominant failure.** Replacing word tokens with subword character trigrams did not improve the frozen blind pack.
2. **The shared-trunk fine-tune caused the catastrophic collapse.** D used C's exact 925-row corpus, seed, vocabulary, architecture, optimizer, ordering digest, and repetition, changing only the removal of post-hoc fine-tuning. Blind full accuracy recovered by 35.0 percentage points relative to C.
3. **Real-dominant weighting alone was insufficient.** D remained 3.7 percentage points below B on blind full accuracy.
4. **Protected adaptation is a valid safety mechanism, not a performance remedy.** E allowed changes only to `Hroute` and `Hbroute`; every shared-trunk and auxiliary array remained bit-exact. Development selection correctly chose epoch 0.
5. **Authored diversity was not sufficient under matched training mass.** H2 expanded from 193 to 925 unique authored rows while approximately holding authored exposure constant. It tied the earlier H blind result and reduced retention on all three exact legacy suites.

The from-scratch NumPy transformer pipeline remains useful infrastructure: finite-difference gradient checking reaches approximately `1.3e-6`, the browser export is parity-tested, and the experiment can be reproduced without a frontier framework. The negative result is architectural and distributional, not an implementation placeholder.

Transformer terminal evidence: Actions run `29791875543`, artifact `8480797657`, artifact digest `sha256:d79ef41a6dbea07949f823987d868d21bc74492007e6a9b648c95174d6e8f1bd`, terminal receipt digest `0d39f19e63bb6bc8b96465190e7373b8dfd65ca6296fd9dd369560f0a058f924`.

## Learned factorized stack

The final architecture-level test uses separate learned experts for character n-grams, word n-grams, compact SVD semantics, audit-route language, and compound detection, with bounded learned fusion. Deterministic logic is restricted to clause composition and fail-closed authority/context behavior.

| Candidate | Blind full | 498 | 60 | 48 | Ordered compound |
|---|---:|---:|---:|---:|---:|
| Route-factorized | 85.3% | 55.8% | 48.3% | 41.7% | n/a |
| Compound-factorized | 89.7% | 62.2% | 46.7% | 52.1% | 53.3% |

The selected compound candidate used structural share `0.30`, audit-route share `0.30`, compound threshold `0.60`, and route temperature `0.85`. It modestly exceeded its internal baseline on blind full accuracy, `89.7%` versus `89.0%`, and improved ordered-compound accuracy from `50.0%` to `53.3%`.

This is the strongest trained research candidate in the branch, but it is not an admission result. The 429-case pack had already become iterative research evidence, exact legacy retention remained uneven, and no new untouched full-runtime pack covered authority, context, memory, thread use, abstention, packaging, runtime parity, and resource gates together.

Factorized terminal evidence: Actions run `29800088006`, artifact `8483432437`, artifact digest `sha256:eec4431e877758acf819748950587bcb03b3513f3b8114eaea37257223771b01`, compound model digest `cc0db4d3beeffbd6c8dd890fea79b4655a47122071e3e4ed91b473715605f0de`, compound receipt digest `31e8531749613f1c88e1582b5c5bd1ee3b9bf2def84fe79a28f29f2341cc14e2`, terminal summary digest `2c4cc925b457817448a801730b96d7b9b71159ba5200c0945652944a2ed567d4`.

## Invalid evidence removed

`npt-E-frozen-backbone-seed424243-pre-finetune.npz` was removed. It was byte-identical to run B and therefore could not represent the real-dominant pre-fine-tune state. No result in the terminal decision relies on that surrogate.

## Admission decision

Promotion remains `not-admitted`. Production remains `archie-operator/register-router.mjs` wrapping the admitted model and deterministic register-aware controls. Irreversible execution and permission boundaries remain deterministic and fail-closed.

The next admissible experiment must be selected without consulting a newly sealed full-runtime pack and then pass, at the exact candidate head:

- route and ordered-compound behavior;
- authority precision and benign-authority retention;
- attachment, memory, and thread reference behavior;
- context sufficiency and abstention state;
- implementation and quantization parity;
- packaging, resource, and production integration gates.

The strongest next architecture direction is a register-local mixture of experts with hard segment namespaces and independently protected authority/context factors, evaluated once against that newly sealed pack. More transformer width, repetition, or unconstrained shared-trunk fine-tuning is not supported by the evidence.

## Reproduction

```bash
cd foundry/archie-protocol/neural
python3 np_transformer.py --gradcheck
python3 test_np_transformer.py

cd ../factorized
python3 audit_factorized_train.py \
  --audit-corpus ../neural/data/route-train-v6.json \
  --frozen-challenge blind-challenge-pack.frozen.json \
  --legacy-dir ../neural/data \
  --out runs/terminal
python3 audit_factorized_compound.py \
  --audit-corpus ../neural/data/route-train-v6.json \
  --frozen-challenge blind-challenge-pack.frozen.json \
  --legacy-dir ../neural/data \
  --out runs/terminal
```

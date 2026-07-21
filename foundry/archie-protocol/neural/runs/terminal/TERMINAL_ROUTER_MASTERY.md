# Terminal router mastery evidence

Production remains on the admitted register-aware router. Every candidate below is `not-admitted`.

## Causal transformer findings

| Run | Mechanism | Blind full | 498 | 60 | 48 |
|---|---|---:|---:|---:|---:|
| B | Subword transformer baseline | 54.3% | 63.1% | 41.7% | 39.6% |
| C | Real-dominant plus shared-trunk fine-tune | 15.6% | 55.0% | 35.0% | 25.0% |
| D | Exact C main phase, fine-tune removed | 50.6% | 64.7% | 43.3% | 33.3% |
| E | D plus protected route-head adaptation | 50.6% | 64.7% | 43.3% | 33.3% |
| H2 | 925 unique route-only authored rows, mass-matched | 52.9% | 61.4% | 31.7% | 22.9% |

D restored 35.0 percentage points of blind full accuracy relative to C, confirming shared-trunk fine-tuning as the destructive phase. E selected epoch 0 while keeping every protected parameter bit-exact, so protected adaptation is a valid safety mechanism but not a performance remedy. H2 falsified authored-row diversity as a sufficient fix under approximately mass-matched supervision.

Transformer evidence: Actions run `29791875543`, artifact `8480797657`, artifact digest `sha256:d79ef41a6dbea07949f823987d868d21bc74492007e6a9b648c95174d6e8f1bd`, terminal receipt digest `0d39f19e63bb6bc8b96465190e7373b8dfd65ca6296fd9dd369560f0a058f924`.

## Learned factorized candidates

| Candidate | Blind full | 498 | 60 | 48 | Ordered compound |
|---|---:|---:|---:|---:|---:|
| Route-factorized | 85.3% | 55.8% | 48.3% | 41.7% | n/a |
| Compound-factorized | 89.7% | 62.2% | 46.7% | 52.1% | 53.3% |

The compound candidate uses learned fusion over character, word, compact-semantic, structural, audit-route, and trained compound experts. It reached 89.7%, slightly above its 89.0% internal baseline, with ordered-compound accuracy moving from 50.0% to 53.3%. The result is strong research evidence but not an admission result because the frozen 429 pack had already become iterative evidence and exact legacy retention remained uneven.

Factorized evidence: Actions run `29800088006`, artifact `8483432437`, artifact digest `sha256:eec4431e877758acf819748950587bcb03b3513f3b8114eaea37257223771b01`, compound model digest `cc0db4d3beeffbd6c8dd890fea79b4655a47122071e3e4ed91b473715605f0de`, compound receipt digest `31e8531749613f1c88e1582b5c5bd1ee3b9bf2def84fe79a28f29f2341cc14e2`, terminal summary digest `2c4cc925b457817448a801730b96d7b9b71159ba5200c0945652944a2ed567d4`.

## Final decision

Promotion remains `not-admitted`; production is unchanged. The next admissible experiment must use a newly sealed, untouched full-runtime pack and satisfy authority, context, abstention, packaging, runtime parity, and resource gates in addition to route accuracy.

Compact evidence digest: `ab4f8b015dbf5e3f362d47487029ab23156841b53b8ae5a0fa68c39d62ba5c9d`.

# Appendix A: exact computational audit

All figures below were recomputed directly from the supplied Python court on 27 July 2026, not copied from the prose theorem.

## A.1 Cost and observation variants

| Court | Reachable states | Canonical classes | Refinement rounds | Behavior rank | Transition monoid | Max witness depth |
|---|---:|---:|---:|---:|---:|---:|
| $c=5$, emit observed | 125 | 69 | 7 | 43 | 622 | 6 |
| $c=4$, emit observed | 125 | 75 | 6 | 46 | 665 | 5 |
| $c=4$, legacy emit omitted | 125 | 69 | 7 | 43 | 622 | 6 |
| $c=6$, emit observed | 125 | 69 | 7 | 43 | 622 | 6 |
| $c=8$, emit observed | 125 | 69 | 7 | 43 | 622 | 6 |

The $c=4$ behavior-complete court separates six additional classes that the legacy observation aliases. At $c\ge5$ in the tested values, the underlying quotient action structure returns to the 69-state, 622-transformation algebra, although observation labels and test-span growth can differ.

## A.2 Controllability audit

| Alphabet | Monoid size | Idempotents | Constant maps | Constant targets | Diameter | Aperiodic |
|---|---:|---:|---:|---:|---:|---:|
| All six events | 622 | 170 | 69 | 69 | 12 | Yes |
| Excluding `receive` | 138 | 45 | 3 | 3 | 6 | Yes |
| `think`, `wait`, `express` only | 12 | 5 | 0 | 0 | 3 | Yes |

## A.3 Reproduction method

The audit:

1. rebuilt the shipped $c=5$ court;
2. restricted it to the 125 states reachable from the declared initial payload;
3. computed the fixed-point future-observation partition;
4. induced each primitive action on quotient classes;
5. closed the generated transformations under composition;
6. tested idempotence, image ranks, powers, constant maps, and shortest generation lengths;
7. performed breadth-first pair search for exact distinction depth;
8. closed the span of one-hot future-observation tests under generator precomposition to obtain behavior rank.

The audit script and JSON receipt were generated alongside this document.

# Appendix B: source-level audit of the neural claim

## B.1 Current forward path

The current model performs, schematically,

\[
E(s)\to T_aE(s)\to F(T_aE(s))\to D_{\mathrm{fields}},D_{\omega},D_{\mathrm{emit}},D_a.
\]

## B.2 Current supervised table

The dataset contains every reachable raw state crossed with all six actions:

\[
125\times6=750\text{ rows}.
\]

The target includes next raw fields, the current observation class, current emission bit, and action identity.

## B.3 Missing checks

The receipt does not currently report:

- latent closure error $\|F(T_aE(s))-E(\delta(s,a))\|$;
- multi-step rollout exactness;
- action-word relation agreement;
- quotient-state decoding rather than raw-field decoding;
- all 622 transformation agreement;
- minimum latent-rank analysis;
- held-out states, operators, or compositions;
- intervention on latent coordinates with causal next-state effects.

The next receipt should contain each item explicitly.

# Appendix C: canonical archive inventory

The manifest declares the following canonical files. Python cache files present after local execution are excluded from the digest-bound release inventory.

### root (9 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `POSTCHAT_THEOREM.md` | 16,899 | `10155e225582c482…` |
| `README.md` | 4,995 | `82566e74cc95267e…` |
| `RUN_POSTCHAT.ps1` | 151 | `286032a33a22b56e…` |
| `UPSTREAM.md` | 1,029 | `5949ce80baa71e16…` |
| `app.py` | 5,135 | `7f83a14b25c006e3…` |
| `demo.py` | 3,155 | `c31c14d76a01fe48…` |
| `requirements-research.txt` | 15 | `99f43573522565d7…` |
| `run_postchat.sh` | 156 | `1199e6b3e9a0f317…` |
| `verify_release.py` | 1,169 | `077d7545c32b7393…` |
### artifacts (2 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `artifacts/certificate-recurrence/certificate_recurrence.pt` | 105,045 | `480bf2e1981c19a0…` |
| `artifacts/certificate-recurrence/receipt.json` | 2,292 | `4db8963fc844337e…` |
### data (4 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `data/audio_tokens/sample.tokens` | 24,000 | `071295cf7f436519…` |
| `data/binary/sample.bin` | 48,000 | `2c277e9ce787134c…` |
| `data/code/sample.py` | 13,920 | `a394d0ff15170489…` |
| `data/prose/sample.txt` | 21,840 | `5887ccdcbffd8ba6…` |
### postchat (10 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `postchat/__init__.py` | 456 | `9777287df3910dfe…` |
| `postchat/__main__.py` | 53 | `39d65d5a4cde6ee6…` |
| `postchat/court.py` | 21,553 | `e4f3142e0e6150d6…` |
| `postchat/engine.py` | 10,893 | `d6c8d71d6248016d…` |
| `postchat/llm.py` | 3,622 | `b05d8b9f8a371c86…` |
| `postchat/metrics.py` | 2,595 | `3219def1e03d3f43…` |
| `postchat/neural.py` | 5,071 | `9f8cd07080efdb6b…` |
| `postchat/store.py` | 2,738 | `72d1ddba8c83af1d…` |
| `postchat/terminal.py` | 6,231 | `7bacd58a694dbe33…` |
| `postchat/urge.py` | 1,798 | `2fbe138e4600d9a6…` |
### receipts (12 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `receipts/v1/postchat-unified-demo.json` | 10,944 | `1917f30780f0907d…` |
| `receipts/v1/test-output.txt` | 713 | `59a337a8ce60156d…` |
| `receipts/v2/amodality-full.json` | 11,245 | `eaf938f814e7525b…` |
| `receipts/v2/decision.json` | 1,372 | `0a11eb8c37dddd43…` |
| `receipts/v2/phase-replication.json` | 163,543 | `a8ce5805cd88ab1e…` |
| `receipts/v2/phase-replication.log` | 57 | `82dc000d6aa53cc4…` |
| `receipts/v2/phase-sweep-full.csv` | 10,351 | `be07ddd1c34ca59a…` |
| `receipts/v2/phase-sweep-full.json` | 59,271 | `276f18c06c5f620c…` |
| `receipts/v2/phase-sweep-full.log` | 4,016 | `b05b2cc486bb3952…` |
| `receipts/v2/postchat-unified-demo-v2.json` | 29,992 | `5953fe915d951028…` |
| `receipts/v2/terminal-smoke.txt` | 961 | `08c74e95d755c41c…` |
| `receipts/v2/test-output-v2.txt` | 1,387 | `780f6cb0991e7f1c…` |
### scripts (5 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `scripts/amodality_probe.py` | 7,876 | `4d3241595231534b…` |
| `scripts/make_probe_corpus.py` | 1,315 | `22e77f3cca7238da…` |
| `scripts/phase_replication.py` | 3,389 | `def44fd0ea987971…` |
| `scripts/phase_sweep.py` | 9,653 | `2a6c7ab9df401e72…` |
| `scripts/train_certificate_recurrence.py` | 8,921 | `5e7770ba4e754459…` |
### static (3 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `static/app.js` | 3,588 | `63a371a997a40046…` |
| `static/index.html` | 2,007 | `50cce30df2d6f727…` |
| `static/style.css` | 3,355 | `04c4ad10496ddac0…` |
### tests (4 files)
| Path | Bytes | SHA-256 (prefix) |
|---|---:|---|
| `tests/test_control_closure.py` | 2,587 | `0cf4d191bdc63f08…` |
| `tests/test_engine.py` | 1,366 | `baf56a69660aba6e…` |
| `tests/test_kernel.py` | 2,259 | `6672da76eb3fabec…` |
| `tests/test_runtime_v2.py` | 1,588 | `d3196df1b28df474…` |


# Appendix D: research frontier and foundations

## D.1 Current frontier checked for this audit

[F1] OpenAI. *GPT-5.6 System Card*. OpenAI Deployment Safety Hub, 9 July 2026.

[F2] OpenAI. *GPT-5.6: Frontier intelligence that scales with your ambition*. 9 July 2026.

[F3] Google DeepMind. *Gemini 3.1 Pro Model Card*. 19 February 2026.

[F4] Google DeepMind. *Model Cards index*, including Gemini 3.6 Flash update, 21 July 2026.

[F5] Anthropic. *Claude Sonnet 5 System Card* and *Introducing Claude Sonnet 5*. June 2026.

[F6] Lahoti, A. et al. *Mamba-3: Improved Sequence Modeling using State Space Principles*. arXiv:2603.15569, 2026.

[F7] Dao, T. and Gu, A. *Transformers are SSMs: Generalized Models and Efficient Algorithms Through Structured State Space Duality*. arXiv:2405.21060, 2024.

[F8] Beck, M. et al. *xLSTM: Extended Long Short-Term Memory*. arXiv:2405.04517; NeurIPS 2024.

[F9] De, S. et al. *Griffin: Mixing Gated Linear Recurrences with Local Attention for Efficient Language Models*. 2024.

[F10] Sun, Y. et al. *Learning to (Learn at Test Time): RNNs with Expressive Hidden States*. arXiv:2407.04620, 2024.

[F11] Behrouz, A., Zhong, P., and Mirrokni, V. *Titans: Learning to Memorize at Test Time*. arXiv:2501.00663, 2025.

[F12] Berges, V.-P. et al. *Memory Layers at Scale*. arXiv:2412.09764, 2024.

[F13] Pagnoni, A. et al. *Byte Latent Transformer: Patches Scale Better Than Tokens*. arXiv:2412.09871, 2024.

[F14] Wang, J. et al. *MambaByte: Token-free Selective State Space Model*. arXiv:2401.13660, 2024.

[F15] Li, B. Z., Guo, Z. C., and Andreas, J. *(How) Do Language Models Track State?* arXiv:2503.02854; ICML 2025.

[F16] Oren, M. et al. *Transformers are Multi-State RNNs*. arXiv:2401.06104; EMNLP 2024.

[F17] Lindner, D. et al. *Tracr: Compiled Transformers as a Laboratory for Interpretability*. NeurIPS 2023.

[F18] Veličković, P. et al. *The CLRS Algorithmic Reasoning Benchmark*. ICML 2022.

[F19] Li, K. et al. *Emergent World Representations: Exploring a Sequence Model Trained on a Synthetic Task*. 2022.

[F20] Hafner, D. et al. *Mastering Diverse Domains through World Models (DreamerV3)*. 2023.

## D.2 Classical machinery doing real work here

[C1] Moore, E. F. “Gedanken-experiments on Sequential Machines.” 1956.

[C2] Myhill, J. “Finite Automata and the Representation of Events.” 1957.

[C3] Nerode, A. “Linear Automaton Transformations.” 1958.

[C4] Rabin, M. O. and Scott, D. “Finite Automata and Their Decision Problems.” 1959.

[C5] Kalman, R. E. “A New Approach to Linear Filtering and Prediction Problems.” 1960.

[C6] Ho, B. L. and Kalman, R. E. “Effective Construction of Linear State-Variable Models from Input/Output Functions.” 1966.

[C7] Schützenberger, M. P. “On Finite Monoids Having Only Trivial Subgroups.” 1965.

[C8] Krohn, K. and Rhodes, J. “Algebraic Theory of Machines.” 1965.

[C9] McNaughton, R. and Papert, S. *Counter-Free Automata*. 1971.

[C10] Hopcroft, J. “An $n\log n$ Algorithm for Minimizing States in a Finite Automaton.” 1971.

[C11] Carlyle, J. W. and Paz, A. “Realizations by Stochastic Finite Automata.” 1971.

[C12] Fliess, M. “Matrices de Hankel.” 1974.

[C13] Eilenberg, S. *Automata, Languages, and Machines, Volume B*. 1976.

[C14] Ramadge, P. J. and Wonham, W. M. “Supervisory Control of a Class of Discrete Event Processes.” 1987.

[C15] Angluin, D. “Learning Regular Sets from Queries and Counterexamples.” 1987.

[C16] Crutchfield, J. P. and Young, K. “Inferring Statistical Complexity.” 1989.

[C17] Jaeger, H. “Observable Operator Models for Discrete Stochastic Time Series.” 2000.

[C18] Littman, M. L., Sutton, R. S., and Singh, S. “Predictive Representations of State.” 2001.

[C19] Shalizi, C. R. and Crutchfield, J. P. “Computational Mechanics: Pattern and Prediction, Structure and Simplicity.” 2001.

[C20] Ferns, N., Panangaden, P., and Precup, D. “Metrics for Finite Markov Decision Processes.” 2004.

# Appendix E: promotion ledger

| Claim | Current status | Required next receipt |
|---|---|---|
| Finite future-observation quotient | Admitted inside declared court | Independent reproduction and symbolic variant |
| Shortest counterexample generation | Admitted inside declared court | Curriculum experiment |
| Endogenous emission bound | Admitted inside finite policy | Recompute under uncontrollable-event supervisor |
| Neural next-state table prediction | Admitted as finite interpolation | Held-out and closure tests |
| Persistent neural machine | Not admitted | Generator semiconjugacy and rollout receipt |
| Rank-43 neural predictive state | Not attempted | 42/43/48 dimension experiment |
| Byte-to-operator compilation | Not implemented | Message-parametric exact court |
| Amodal semantic state | Not admitted | Cross-domain operator transfer, not domain probe |
| Stable phase law | Rejected in v2 | New mechanism or leave dead |
| Arbitrary-English exact quotient | Not available | Bounded jurisdictions or shadow risk only |
| Foundational model architecture | Not admitted | Multi-domain transfer plus total-cost advantage |


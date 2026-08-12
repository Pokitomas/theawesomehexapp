# ARCHIE // FRONTIER MODEL MATHEMATICS

No toy breakthrough claim. No worship of receipts. No architecture survives by sounding clean.

The project is to build a frontier model by attacking the mathematical bottlenecks that current scaling leaves structurally unresolved. Receipts are one candidate representation for exact local transformation. They are not the thesis. The thesis is that a frontier model must reduce semantic error faster than horizon, search, memory, and compute expand.

## 1. THE ACTUAL OBJECTIVE

Let data be drawn from a family of environments `e ~ E`. Let a model with parameters `theta`, inference budget `b`, and external memory `m` induce a policy over internal computations and outputs.

The useful objective is not token loss alone:

`J(theta) = E_e[ U_e(theta, b, m) ] - lambda_C C(theta, b, m) - lambda_F F(theta, b, m)`

where:

- `U_e` is task utility under distribution shift and long-horizon interaction;
- `C` is total training plus inference compute;
- `F` is catastrophic semantic failure, not average local error.

A frontier model must improve the Pareto frontier in all three dimensions. A system that buys exactness with exponential search is not intelligent. A system that buys benchmark score with hidden state corruption is not robust. A system that buys local accuracy while exact trajectory probability collapses is theater.

## 2. HORIZON IS MULTIPLICATIVE

If per-step semantic correctness is `1 - epsilon_t`, exact trajectory probability is

`P_exact(T) = product_{t=1}^T (1 - epsilon_t)`.

For constant error `epsilon`,

`P_exact(T) = (1 - epsilon)^T approximately exp(-epsilon T)`.

This kills almost every comfortable metric. At horizon `T = 10^4`, per-step semantic error `10^-4` still gives only about `e^-1` exact success. Therefore local accuracy near 100% is not impressive unless error shrinks approximately as `o(1/T)` for the target horizon or the architecture supports correction, verification, rollback, or decomposition that prevents one error from poisoning all descendants.

Receipts help only by changing error propagation. They do not remove compiler error. The research question is whether the model can localize, detect, and repair semantic mistakes at lower cost than dense autoregressive regeneration.

## 3. LOSS IS A PROXY AND USUALLY A BAD ONE

Cross-entropy minimizes

`L_CE(theta) = - E_{(x,y)} log p_theta(y | x)`.

This is proper for conditional density estimation. It is not a theorem that lower token loss yields better planning, mechanism induction, exact execution, or reliable self-correction. The hidden stupidity is treating one scalar proxy as if every capability were a smooth monotone function of it.

Required decomposition:

`L_total = L_perception + L_binding + L_program + L_state + L_verification + L_search + L_calibration`.

Not as a decorative multitask sum. Each term must correspond to a distinct failure event with measurable causal contribution to end-task failure. If gradients from one component destroy another component's already-correct structure, the optimization geometry is wrong.

The useful object is the failure Jacobian:

`G_ij = partial F_i / partial theta_j`

where `F_i` is a semantic failure mode and `theta_j` is a parameter block or module. Dense end-to-end training is tolerated only when this coupling is beneficial. Otherwise the model is paying catastrophic interference as an aesthetic tax.

## 4. SCALING LAWS ARE NOT A THEORY OF INTELLIGENCE

Empirical loss scaling is often fit as

`L(N, D, C) = L_inf + a N^-alpha + b D^-beta + c C^-gamma`.

Useful. Also brutally incomplete. It predicts average loss in a regime. It does not identify which capabilities saturate, which errors remain irreducible under the current factorization, or when additional compute merely sharpens the wrong conditional distribution.

Archie must track capability-specific scaling:

`M_k(C) = M_{k,inf} - A_k C^-alpha_k`

for capability `k`, plus phase transitions and regressions. More importantly, it must track semantic failure scaling:

`F_k(C, T, S, B)`

as a function of compute `C`, horizon `T`, shift severity `S`, and inference budget `B`.

A model is not frontier because validation loss obeys a power law. It is frontier when the relevant failure surface moves outward faster than resource cost.

## 5. REPRESENTATION MUST PAY RENT

A representation `z = f_theta(x)` is useful only through the computations it makes shorter, cheaper, or more reliable.

Define a downstream theory class `H` and description cost `K(h)`. Representation quality is

`Q(z) = min_{h in H: h(z) solves task} [ K(h) + lambda R(h,z) ]`

where `R` is execution risk or residual error.

A latent that linearly decodes ten human-named variables but requires a giant brittle transition model is worse than a latent with ugly coordinates and a tiny exact operator algebra. Probe accuracy is not mechanism. Disentanglement pictures are not mechanism. Geometry that does not reduce executable complexity is decoration.

The correct pressure is minimum executable description length:

`MDL = K(schema) + K(parser) + K(operators) + K(memory) + K(residuals) + K(exceptions)`.

Every invented concept must reduce total code length or failure cost across environments. Otherwise it is a private code pretending to be abstraction.

## 6. SEARCH MUST BE ACCOUNTED FOR, NOT HIDDEN

Let the model maintain `B_t` hypotheses and propose `K_t` expansions per hypothesis. Naive cost is

`C_search = sum_t B_t K_t C_eval(t)`.

If ambiguity remains constant, beam width grows exponentially. Any architecture that reports top-k oracle accuracy without charging for branch count is laundering combinatorics through evaluation.

The research target is posterior contraction:

`E[ log B_{t+1} - log B_t ] < 0`

after informative evidence, while preserving the correct hypothesis with high probability.

Measure:

- correct-program survival probability;
- effective hypothesis count `exp(H(q_t))`;
- proposals evaluated per accepted action;
- semantic merge rate;
- search regret against an oracle compiler;
- wall-clock and energy per solved trajectory.

A frontier system requires learned proposal distributions, hard constraints, reusable program structure, and aggressive equivalence detection. "Keep several crisp worlds" is only respectable if several does not become several million.

## 7. MEMORY IS AN INFORMATION ALLOCATION PROBLEM

Generic context is not memory theory. Let history be `h_t` and future-relevant variable be `Y_{>t}`. A sufficient memory `m_t` should preserve information needed for future decisions:

`I(m_t ; Y_{>t})` high,

while minimizing storage and update cost:

`min K(m_t) + lambda C_update(m_t)`

subject to bounded predictive or control regret.

For reversible local transformations, one candidate is destroyed-information memory:

`E_t = minimal code such that (s_{t+1}, E_t, r_t) reconstructs s_t`.

That is mathematically clean for transactional worlds. It is not automatically sufficient for language, strategy, or partially observed environments. Archie must compare:

- inverse payloads;
- predictive-state representations;
- learned recurrent state;
- retrieval memory;
- compressed episodic traces;
- persistent program state.

The winner is whichever minimizes future regret per bit and per joule, not whichever resembles a database.

## 8. CREDIT ASSIGNMENT IS STILL FILTHY

For a trajectory reward `R`, policy-gradient variance and long-range attribution remain ugly. Backpropagation through thousands of soft states does not become causal credit assignment merely because gradients exist.

For internal decisions `a_1, ..., a_T`, define contribution through intervention:

`Delta_i = E[R | do(a_i = a_i^*)] - E[R | do(a_i = a_i')]`.

Exact computation is impossible at scale, but the target matters. Training signals should approximate localized counterfactual responsibility, not smear terminal failure across every parameter.

Receipts and typed modules may create checkable boundaries: parse, bind, guard, transform, verify. Their value is not interpretability theater. Their value is lower-variance credit if failure can be assigned to the smallest wrong semantic choice.

This must be tested by intervention on modules and decisions. If replacing one wrong receipt leaves every other learned component intact, modularity paid rent. If the whole network must relearn, the architecture failed.

## 9. QUANTIZATION IS NOT A DEPLOYMENT FOOTNOTE

A frontier model that only exists in high-precision training arithmetic is structurally weak. Quantization tests whether useful computation has margin.

For quantizer `Q_b` at `b` bits, define capability degradation

`D_k(b) = M_k(theta) - M_k(Q_b(theta))`.

Track not only average degradation but semantic cliff probability. Exact mechanisms should be robust where discrete choices have adequate margins and brittle where the model relies on tiny analog distinctions.

Quantization-aware objectives should penalize decision-margin fragility:

`L_margin = E max(0, tau - (logit_correct - logit_runnerup))`.

But large margins alone can encode confidently wrong garbage. Couple margin to verification and calibration. The goal is computation that survives 8-bit, 4-bit, sparse execution, and hardware noise without silently changing its laws.

Quantization is also a scientific instrument. If a claimed abstraction evaporates under mild precision reduction, it may be a distributed analog coincidence rather than a stable algorithm.

## 10. SPARSITY MUST REDUCE TOTAL COMPUTE

Parameter sparsity that requires dense routing, dense activations, and expensive synchronization is cosplay. Let active compute be

`C_active = C_route + sum_{l in active} C_l + C_memory + C_verify`.

A mixture-of-experts model wins only if quality per total joule improves after routing imbalance, communication, cache misses, and expert undertraining are charged.

The frontier target is conditional computation with high specialization and low routing entropy:

`H(p(expert | token, state))`

must be low enough for efficiency but not collapse so hard that experts become dead or globally redundant. Measure expert mutual information with task structure, not just load balance.

## 11. SELF-IMPROVEMENT REQUIRES AN ACCEPTANCE TEST

A model proposing modifications to itself is easy. A model proving those modifications improve the frontier is hard.

For candidate update `u`, accept only if

`Delta U(u) - lambda_C Delta C(u) - lambda_F Delta F(u) > 0`

under held-out environments, adversarial perturbations, quantized inference, and long-horizon evaluation.

The update must survive correction for multiple hypothesis testing. Otherwise repeated mutation eventually overfits the judge. Use sequential testing, confidence bounds, and locked evaluation distributions. "The model rewrote itself" is meaningless without an anti-self-deception protocol.

## 12. WHAT ARCHIE SHOULD BUILD

Not one sacred architecture. An experimental machine that can compare factorization hypotheses under equal compute.

Candidate families:

1. dense autoregressive baseline;
2. recurrent latent-state model;
3. retrieval-augmented model;
4. neural compiler plus exact executor;
5. verifier-guided generator;
6. program-posterior model with bounded beam;
7. mixture-of-experts with explicit routing cost;
8. hybrid continuous simulator plus discrete transaction shell.

Every candidate receives the same data, training FLOPs, inference budget, memory budget, and wall-clock reporting.

Primary measurements:

- exact trajectory probability versus horizon;
- utility versus total FLOPs and joules;
- semantic error decomposition;
- recovery cost after injected internal error;
- search width and posterior entropy;
- memory bits per unit future regret;
- OOD degradation under renaming, cardinality, and composition shift;
- quantization degradation curves;
- scaling exponents by capability;
- calibration of catastrophic failure probability.

## 13. KILL CONDITIONS

Kill a line of work when any of the following persists after a bounded optimization budget:

- exact trajectory rate still decays at the same exponent as the dense baseline;
- search cost grows superlinearly enough to erase accuracy gains;
- the learned compiler needs hand-coded operator semantics for most performance;
- representation gains disappear under variable renaming or cardinality shift;
- memory grows approximately with raw history despite claims of compression;
- quantization causes semantic cliffs at ordinary deployment precision;
- improvements vanish under equal total compute;
- the method wins only when evaluated with oracle parses, oracle retrieval, or oracle verification;
- a simpler baseline matches it after competent tuning.

No rescue through prose. No benchmark redefinition after failure. No calling a smaller error surface a new ontology.

## 14. CURRENT RECEIPT RESULT

The current executor demonstrates a conditional fact:

`correct receipt => exact deterministic transition and exact local rollback`.

It does not demonstrate learned compilation, mechanism discovery, scalable search, frontier capability, or superiority to transformers. Its purpose is to isolate one variable: whether exact state execution is worth separating from uncertain inference.

Now the project must measure the compiler, the search, the scaling, and the compute. Until then it is a useful backend, not a frontier model.

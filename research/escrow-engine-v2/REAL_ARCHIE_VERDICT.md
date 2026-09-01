# ESCROW × Archie: Real-Checkpoint Falsification Report

## Verdict

**New science is not established.** The toy claim did not transfer intact.

The hard claim—cheap neural execution with a per-context TV certificate and robust total-cost advantage—failed. The narrower surviving object is a **statistical microbatch controller** combining dynamic int8 execution, a conformal residual gate, exact FP32 fallback, and the factor-level affine debt checker.

On five file-disjoint folds covering all 288 real repository contexts exactly once, the conservative controller (`tau=0.10`, requested conformal alpha `0.01`) produced:

- **0 unsafe accepted int8 substitutions**;
- **0 factor-envelope violations**;
- 126 accepted int8 outputs, 119 int8 probes followed by FP32 fallback, and 43 direct FP32 outputs;
- **1.031× aggregate measured microbatch speedup**;
- fold speedups from **0.907× to 1.171×**.

That is a real but weak result: aggregate runtime improved by 3.1%, but one fold slowed down. Paired calibration and compilation require roughly 80–90 seconds per fold in this harness, so one-run total-cost superiority is not established.

The less conservative gate (`alpha=0.05`) reached **1.190× aggregate microbatch speedup** with one unsafe accepted substitution among 159 accepted int8 outputs. It is evidence for a speed–risk frontier, not a hard certificate.

## Test object

- Checkpoint SHA-256: `e2b829c86b1be730b8aef7617edd3b62dd819fe5bad41673e6dd284950378ded`
- Parameters: 114,215,040
- Architecture: 20 layers, width 640
- Inputs: 288 real 96-byte contexts from code, documentation, JSON/data, and GitHub workflows
- Output factor: six next-byte classes
- Validation: five file-disjoint folds; each context is tested exactly once
- Runtime unit: batch 8, because dynamic int8 was fast at batch 8 but did not return inside the batch-1 timing cap

## Mechanisms killed

### Early exit

Depth 4/8/12/16 execution was cheaper but too destructive. Through `tau=0.30`, the scheduler selected the full reference for every held-out step. At `tau=0.40`, the nominal gain was about 0.23% and a prompt-level bound failed.

### bfloat16

Full-graph bfloat16 cost 1.411× FP32 on this CPU. Rejected on economics.

### Exact-tail int8

Restoring the FP32 head and one final block cost 0.945× FP32. Median scheduler speedup was only 1.025×, and prompt-level violations appeared in every evaluated split. Restoring two or four blocks was slower than FP32.

### Ungated int8

Full dynamic int8 cost about 0.309× FP32 at batch 8, and the factor-level affine envelope survived every validation split. Individual prompt error nevertheless reached TV 0.2252. Factor diameter is therefore not a per-prompt readout certificate.

## Surviving integration

For each microbatch:

1. identify factor-admissible int8 positions;
2. execute the int8 batch;
3. compute a calibration-only conformal upper residual from int8 output and cheap context features;
4. accept int8 only when the factor and residual gates pass;
5. execute FP32 on the rejected subset;
6. update debt using the operator actually returned.

The conformal statement is statistical. It does **not** establish a worst-case guarantee or a time-uniform guarantee over an unbounded stream.

## Cost audit

| Executor | Seconds, batch 8 | Relative cost |
|---|---:|---:|
| FP32 | 1.8961 | 1.000 |
| Dynamic int8 | 0.5858 | 0.309 |

Conservative five-fold aggregate:

| Metric | Result |
|---|---:|
| FP32 baseline | 68.7577 s |
| Controller | 66.6676 s |
| Speedup | 1.0314× |
| Unsafe accepted substitutions | 0 / 126 |
| Factor-bound violations | 0 |

The controller is not robustly economical because fallback density varies by file mix. Setup includes quantization plus paired calibration runs and dominates a single deployment.

## Scientific boundary

Established here:

> On one real 114M-parameter checkpoint and file-disjoint repository contexts, a factor-debt controller augmented with a conservative statistical readout gate preserved the tested TV threshold while producing a small aggregate batch-throughput improvement.

Not established:

- a new mathematical primitive;
- worst-case per-context neural certification;
- time-uniform statistical safety;
- total-cost superiority on one deployment;
- transfer to another checkpoint, task, GPU, or model family;
- superiority over a production quantization router.

## Next decisive experiment

Produce a **pre-execution** or fused residual signal so rejected cases do not pay both int8 and FP32. Repeat the same file-disjoint protocol on a second checkpoint and one GPU backend. The candidate survives only if every fold beats FP32 after setup at the declared statistical risk level.

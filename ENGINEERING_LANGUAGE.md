# ARCHIE engineering language

Use mechanism-first language throughout active ARCHIE documentation, dashboards, logs, and new code comments.

This is a terminology normalization only. It does **not** change runtime behavior, permission semantics, schemas, receipt formats, evaluation thresholds, or compatibility identifiers.

## Preferred vocabulary

| Avoid in new prose | Prefer | Meaning preserved |
| --- | --- | --- |
| court / autocourt | evaluation gate / automated evaluation | deterministic evaluation against declared criteria |
| promotion | admission / admission status | whether a candidate is accepted for the next declared use |
| actor / agent, when it only means a process | worker / process | executing software component |
| authority | permission scope | operations the caller or worker is allowed to perform |
| die loud | fail with an explicit error | stop and expose the failure |
| kill / kill switch | stop / disable control | terminate or disable a process or feature |
| ghost state | near-degenerate numerical state | state close to singularity or linear dependence |
| hidden tunnel | redundant transform path | alternate path producing equivalent or near-equivalent state |
| annihilate | cancel | destructive numerical or signal interference |
| attack surface, outside actual security analysis | exposed interface | externally reachable or mutable interface |
| probe, outside measurement terminology | test / check | bounded observation |
| exploit, outside an actual vulnerability | failure mode / use | observed defect or application |
| surveillance | monitoring / telemetry | collection of runtime observations |
| war room | operations view / incident view | operational coordination interface |
| hostile, when describing ordinary malformed input | invalid / incompatible | input that violates a contract |
| mission | task / objective | bounded requested work |
| target, when not a mathematical/ML target | subject / candidate | object under evaluation |
| red team, when no adversarial security exercise exists | robustness evaluation | deliberate stress testing |

## Writing rule

Prefer observable mechanism plus bounded effect:

- `the evaluation gate rejected the backend because max gradient error was 6.1e-4`
- `the controller restarted after the lease expired`
- `the relay cannot connect to the host`
- `the worker lacks permission for this write`
- `the scan recurrence diverges from the sequential reference below the prefix floor`

Avoid descriptions that imply agency beyond the implemented mechanism.

## Compatibility rule

Do **not** casually rename serialized fields, environment variables, database columns, schema identifiers, command names, file paths, or externally consumed API properties merely to match this guide. Examples such as `promotion`, `authority`, or historical `court` identifiers may remain on the wire when changing them would break compatibility.

For those cases:

1. keep the compatibility identifier;
2. describe it in user-facing prose with the preferred vocabulary;
3. introduce a new identifier only through an explicit migration with backward compatibility and tests.

Historical evidence may quote old terms when necessary to preserve exact provenance. New explanatory text around that evidence should use the normalized vocabulary.

## Numerical research language

For quaternion / Heisenberg / HRT-adjacent numerical work, use ordinary numerical-analysis terms:

- near-linear dependence
- singular value
- condition number
- cancellation
- precision sensitivity
- non-commutative transform
- FP64 reference
- FP32 candidate
- TF32 disabled reference lane
- tolerance failure
- reproducibility

Do not infer physical or mathematical claims from suggestive metaphors. A numerical degeneracy is evidence of a numerical degeneracy until separately proved to represent something stronger.

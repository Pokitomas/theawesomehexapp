# Register student v3 terminal candidate

Candidate selection was frozen before the fresh v3 pack was generated.

- Learned weights: unchanged from Actions artifact `8485232165`.
- Model JSON SHA-256: `7a7f4619a9bb300ff5e690970663373d974fb0584a3b6b975cb1858f223a18b0`.
- Model module SHA-256: `828980422423c40a6a858e0f64217db03cc326a5530d24dac5fbff5b8aeeccd4`.
- Source controller SHA-256: `4d0c382fd384b51dd53ce4b04c5b252e8814c45b0012de802b411c4a98b9ec3d`.
- Frozen v3 controller SHA-256: `98c81fd2a83b70686155027d830372ca35852918d81b27b75e411ef423fd1e71`.
- Repair scope: generic correction-boundary and ordered-clause-boundary parsing only.
- Development evidence: opened v2 pack and legacy suites; v3 scored 1800/1800, 60/60, 48/48, and 496/498 before the fresh pack existed.
- Fresh evaluation: 1800/1800 overall, 240/240 ordered compound, 60/60, 48/48, 496/498 legacy, and 2406/2406 Python/JavaScript parity.
- Protected product suites: baseline, completion, and admission all passed.
- Second environment: exact JavaScript package reproduced on macOS 15 ARM64.
- Production status: unchanged.
- Repository-owned judge status: passed.
- Provider-neutral promotion status: `not-admitted`.

The exact package lacked a genuinely independent judge-only-hidden evaluator. Fresh rows were withheld from candidate selection, but evaluator authorship and execution remained under the training branch. This is an explicit terminal blocker, not an approximate pass. See `terminal/terminal-evidence.json`, `terminal/alternate-v3-evidence.json`, and `terminal/README.md`.

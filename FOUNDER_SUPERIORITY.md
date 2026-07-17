# Founder superiority is an empirical claim

The target is the abundant-software thesis expressed by the Reddit question **“We can all vibe code. Why bother?”**: when creation becomes easy enough, an ordinary person should be able to produce a point solution instead of buying software or learning a developer workflow.

Founder does not beat that thesis because its interface looks simpler, because it opens six branches, or because repository tests pass. It wins only when ordinary humans repeatedly produce stronger deployed outcomes than an ordinary vibe-coding workflow while spending less attention and never being forced into Git, tickets, terminals, CI, deployment consoles, specifications, or agent babysitting.

## Public comparison law

`benchmarks/founder-vibe-superiority.v1.json` preregisters the comparison.

A valid study must use a randomized blinded crossover design with at least:

- 12 eligible non-developer participants;
- 6 task families and 72 matched Founder/baseline pairs;
- two independent evaluator organizations;
- objective tests, quality, security, accessibility, recovery, reproducibility, time, intervention, and developer-surface evidence;
- raw archive, evaluator, trace, and artifact digests.

Founder must achieve all gates together. It cannot trade a fragile or insecure output for speed, expose developer machinery, omit fault recovery, or claim victory from unmatched demonstrations.

## Commands

```bash
npm run founder:superiority
npm run founder:superiority -- evaluate --study path/to/real-study.json --out founder-superiority-evaluation.json
npm run test:founder:superiority
```

The evaluator returns only one of two substantive states:

- `superiority-not-proven`
- `superiority-thresholds-met-awaiting-independent-admission`

It deliberately cannot self-issue the final marketing claim. Independent admission remains a separate release boundary.

## Current truth

The comparison protocol and fail-closed evaluator exist. No real matched human study is committed. Founder superiority is therefore **not yet proven**.

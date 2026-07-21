# Archie register V4 post-fix admission receipt

Status: **admitted-register-router**

This receipt covers the exact local register-routing component only. It does not claim provider-neutral maximal Archie student admission, embodiment admission, execution authorization, or launch admission.

## Bound identity

- Pull request: `#694`
- Branch head evaluated through the PR merge ref: `d6515f4defbefc58261823cd1c63529a90dd14e5`
- Evaluated merge commit: `4190661cf1603f056b70b7ec9473a19ca1bb46e0`
- Workflow run: `29810752265`
- Sealed-pack artifact: `8487300628`
- Sealed-pack artifact digest: `sha256:e03f48e505438b95aa70c452fa2b8449ca0c7d536d54ab5a69c95a26e23c4312`
- Admission artifact: `8487332558`
- Admission artifact digest: `sha256:e4369feb884dc4cf5f48bc6d5ff99d0878d362e9b1dc67775a69e4530fdeb390`
- Learned model SHA-256: `7a7f4619a9bb300ff5e690970663373d974fb0584a3b6b975cb1858f223a18b0`
- V3 source controller SHA-256: `98c81fd2a83b70686155027d830372ca35852918d81b27b75e411ef423fd1e71`
- Admitted negation-isolated V4 controller SHA-256: `e064bf0cf3bd94fe0808257c929c7238d9cc6de9af1d9f51bd1b77891616b5fc`
- Training receipt SHA-256: `98aab633c46765fc8e046090478a09bb347c0d58cec73c4ac95cec03919d948a`
- Admission report digest: `b71f93c19bab3a5a768586435f8b6a3365712e232e98a031031eb80b18da296d`

## Fresh post-fix results

- Hidden full runtime: `1800/1800`
- Ordered compounds: `238/238`
- Negation: `101/101`
- Every sealed category: `100%`
- Legacy retention: `60/60`, `48/48`, `498/498`
- Python/JavaScript raw parity: `2406/2406`
- Maximum parity confidence delta: `6.316553458063368e-08`
- Sustained duration: `60000.19388 ms`
- Predictions: `261062`
- Mean latency: `0.22954889739219295 ms`
- P95 latency: `0.453877 ms`
- Peak RSS: `116441088 bytes`
- Packaged model: `1442990 bytes`
- Admission checks: `77/77`
- Blockers: none

The protected repository baseline, completion, and admission commands passed in the same judge job. The learned weights were not retrained or changed. The controller fix prevents a negated clause from being reintroduced by the whole-request compound fallback.

`admission-report.json.gz` is the deterministic compressed copy of the exact report emitted by the successful workflow.

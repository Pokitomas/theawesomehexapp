# Archie fixed evaluation manifests

These nine files are intentionally **unsealed blockers**. They name the complete fixed evaluation surface without inventing corpus offsets that are not present in repository history.

Seal them only from an operator-reviewed `archie-corpus-source-index/v1` file:

```bash
python foundry/archie-distill/archie_fixed_eval.py seal \
  --source-index /exact/path/source-index.json \
  --output-dir eval
```

A usable manifest must bind one exact `.u16` corpus digest, token count, source-separated windows, and a self-digest. `verify` and `evaluate` reject empty, overlapping, out-of-bounds, digest-drifted, or unsealed manifests. No advancing random evaluation window is accepted.

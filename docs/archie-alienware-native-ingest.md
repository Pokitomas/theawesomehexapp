# Alienware training to native Archie evidence

This lane separates CUDA execution from evidence admission.

The Alienware trains with the canonical elastic RSLoRA runner and exports one final rung bundle. A small non-CUDA API receives that tar body, verifies the external receipt and every checkpoint byte, removes provider/runner plumbing, and emits a minimal native envelope containing:

- the verified adapter tensor;
- adapter configuration when present;
- the external rung receipt;
- the canonical training receipt;
- a new connector-reduced native receipt.

The ingest host uses only Python's standard library. It does not load Qwen3-1.7B, initialize CUDA, call Hugging Face, use a cloud SDK, or require a GitHub self-hosted runner.

## Start the ingest API

```bash
python foundry/archie-distill/alienware_rslora_ingest_api.py \
  --bind 127.0.0.1 \
  --port 8787 \
  --output-root /srv/archie/native-ingest
```

Place TLS and authentication in a reverse proxy. The application itself deliberately has one transport contract and no provider connector.

## Export on the Alienware

Run the existing canonical elastic rung workflow locally or through the self-hosted runner. From the final exported rung directory:

```bash
tar -C /path/to/final/export -cf alienware-rung.tar bundle
sha256sum alienware-rung.tar
```

The tar must contain exactly one `elastic-rung-receipt.json` and the receipt-bound checkpoint and training receipt.

## Upload as one body

```bash
REQUEST_ID=pok-721-alienware-001
DIGEST=$(sha256sum alienware-rung.tar | awk '{print $1}')

curl --fail-with-body \
  -X POST http://127.0.0.1:8787/v1/rslora/nativize \
  -H 'Content-Type: application/x-tar' \
  -H "X-Archie-Request-ID: ${REQUEST_ID}" \
  -H "X-Archie-SHA256: ${DIGEST}" \
  --data-binary @alienware-rung.tar
```

Successful output is stored under:

```text
<output-root>/<request-id>/<tar-sha256>/
  native-receipt.json
  payload/
    adapter_model.safetensors | adapter_model.bin
    adapter_config.json       # when present
    external-rung-receipt.json
    training-receipt.json
```

## What “nativized” means

The native receipt preserves model, tokenizer, dataset, profile, shard, rung, optimizer-step, and source-receipt identities. It intentionally does not elevate Alienware provider metadata into native authority. Runner name, labels, cloud credentials, and transport implementation are discarded after verification.

This is normalization, not model admission. The result remains `not-admitted` until the existing frozen evaluation, fusion, quantization-retention, and independent-reproduction gates succeed.

# Archie Local Operator

Archie Local Operator is a static, dependency-free PWA. It does not require Claude, Anthropic, OpenAI, a hosted inference API, a framework runtime, or a build service.

## Run locally

From the repository root:

```bash
python3 -m http.server 4173 --directory archie-operator
```

Open `http://localhost:4173`.

Any ordinary static server works. The browser loads `model.json`, executes the int8 router locally, and caches the shell for offline use.

## Deploy independently

The directory can be published as-is to Netlify, Cloudflare Pages, GitHub Pages, nginx, Caddy, an object store, or a local machine. Set the publish directory to:

```text
archie-operator
```

No build command is required. `netlify.toml` sends the production root to `index-v7.html`, which wraps the existing neural router with the register/order projection and accepts optional attached-file names and remembered context.

## Completed Linux audit run

The real `Archie-Audit.zip` archive was unpacked and processed on Linux CPU. The run produced:

- 1,282 governed base route rows;
- 13,275 diverse synthetic/register rows;
- a frozen reconstructed 80-case suite;
- two trained 8,192-feature neural candidates, both rejected for regression;
- a selected deterministic register/order projection around the existing local neural router.

The digest-bound receipt is:

```text
foundry/archie-protocol/runs/linux-register-distill-20260720.json
```

Observed projection results against the audit reference router were 498/498, 60/60, 48/48, and 75/80 on suite-80. Promotion remains `not-admitted`; the selected product layer is not represented as a newly improved neural checkpoint.

## Reproduce the deterministic path

```bash
mkdir -p .local/archie-audit .local/archie-route
unzip Archie-Audit.zip -d .local/archie-audit

node foundry/archie-protocol/prepare-route-data.mjs \
  --audit .local/archie-audit/files \
  --out .local/archie-route/route-train.json \
  --freeze-suite .local/archie-route/suite-80.json

node foundry/archie-protocol/mega-distill-route-data.mjs \
  --input .local/archie-route/route-train.json \
  --out .local/archie-route/route-train.distilled.json \
  --copies 6
```

## Optional local-teacher megadistillation

Kimi K2's transferable lesson is not its scale. It is increasing token utility through diverse rephrasing, fidelity verification, synthesized trajectories, and verifiable feedback. Archie applies that pattern narrowly to routing.

Start any local OpenAI-compatible teacher. With llama.cpp:

```bash
llama-server \
  -m /models/teacher.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  -c 8192
```

Generate multiple conversational and order-sensitive rewrites, protect every frozen evaluation prompt, and retain only majority-verified faithful examples:

```bash
python3 foundry/archie-protocol/megadistill-route-corpus.py \
  --data .local/archie-route/route-train.json \
  --out .local/archie-route/route-train.megadistilled.json \
  --endpoint http://127.0.0.1:8080 \
  --model local-teacher \
  --samples-per-row 6 \
  --judges 3 \
  --freeze .local/archie-route/suite-80.json \
  --freeze .local/archie-audit/files/artifacts/evals/router-v2-original-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v2-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v3-final.jsonl
```

The teacher-backed distiller emits a corpus plus a digest-bound receipt. It rejects exact suite leakage, wrong-route rewrites, low-confidence examples, and candidates that fail majority fidelity verification.

## Train experimental context candidates

```bash
node foundry/archie-protocol/train-context-route-model.mjs \
  --data .local/archie-route/route-train.distilled.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --model-out .local/archie-route/candidate-model.json \
  --out .local/archie-route/candidate-receipt.json
```

Do not replace `archie-operator/model.json` unless a candidate beats the existing model on every mandatory retention gate. The Linux candidates in the committed receipt did not, so they were rejected rather than shipped.

## Boundary

The included model is a twelve-route classifier. It exposes route probabilities and protocol selection; it is not a general text generator and does not execute tools by itself.

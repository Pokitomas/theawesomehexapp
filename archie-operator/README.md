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

No build command is required.

## Bootstrap from ArchieAudit.zip

Unpack the audit outside the repository, then freeze the suite and prepare governed route rows:

```bash
mkdir -p .local/archie-audit .local/archie-route
unzip ArchieAudit.zip -d .local/archie-audit
node foundry/archie-protocol/prepare-route-data.mjs \
  --audit .local/archie-audit \
  --out .local/archie-route/route-train.json \
  --evals-out .local/archie-route/evals \
  --freeze-suite .local/archie-route/suite-80.json
```

Add the conversational register that is absent from the audit corpus:

```bash
node foundry/archie-protocol/augment-route-register.mjs \
  --input .local/archie-route/route-train.json \
  --out .local/archie-route/route-train.register.json
```

Train the order/context-aware encoder and export the browser model:

```bash
node foundry/archie-protocol/train-context-route-model.mjs \
  --data .local/archie-route/route-train.register.json \
  --evals .local/archie-route/evals \
  --suite .local/archie-route/suite-80.json \
  --model-out archie-operator/model.json \
  --out foundry/archie-protocol/runs/context-route-model-receipt.json
```

The context encoder adds positional buckets, head/tail features, ordered trigrams, skip-bigrams, and explicit attachment, memory, and thread signals. Those metadata signals do not imply file-content understanding or durable memory.

## Width sweeps

For controlled width and seed comparisons on the committed protocol corpus:

```bash
node foundry/archie-protocol/train-protocol-sweep.mjs
```

The sweep writes a receipt under `foundry/archie-protocol/runs/`. It selects a candidate only by held-out performance, uses parameter count as a tie-breaker, and keeps promotion at `not-admitted`.

## Boundary

The included model is a twelve-route classifier. It exposes route probabilities and protocol selection; it is not a general text generator and does not execute tools by itself.

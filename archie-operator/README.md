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

## Replace the model

Generate a compatible model artifact:

```bash
node foundry/archie-protocol/export-model.mjs --preset big --out archie-operator/model.json
```

For scale experiments across widths and seeds:

```bash
node foundry/archie-protocol/train-protocol-sweep.mjs
```

The sweep writes a receipt under `foundry/archie-protocol/runs/`. It selects a candidate only by held-out performance, uses parameter count as a tie-breaker, and keeps promotion at `not-admitted`.

## Boundary

The included model is a twelve-route classifier. It exposes route probabilities and protocol selection; it is not a general text generator and does not execute tools by itself.

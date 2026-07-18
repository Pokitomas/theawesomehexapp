# Install Sideways, Archie, and Maker

This page separates the things you can use immediately from developer tools that require a computer.

## Archie on a phone

Open **[Archie](https://pokitomas.github.io/theawesomehexapp/archie/)**.

### iPhone or iPad

1. Open the link in Safari.
2. Tap Share.
3. Tap **Add to Home Screen**.
4. Tap **Add**.

### Android

1. Open the link in Chrome.
2. Open Chrome's menu.
3. Tap **Install app** or **Add to Home screen**.
4. Confirm.

The phone app is a local-first objective and authority cockpit. It stores drafts on that device, prepares digest-bound objective packets, and hands authorized work to Maker. It does not pretend that model inference, repository mutation, deployment, or completion happened inside the browser.

## Sideways for normal people

### iPhone or iPad

1. Open **[Sideways](https://pokitomas.github.io/theawesomehexapp/manual/)** in Safari.
2. Tap the Share button.
3. Tap **Add to Home Screen**.
4. Tap **Add**.
5. Open the new Sideways icon.

Sideways stores the private archive in the browser on that device. Open **Library**, use **PIN** when available, and regularly use **BACKUP** to download a `.sideways` Ark. Browser storage is not a replacement for that downloaded backup.

### Android

1. Open **[Sideways](https://pokitomas.github.io/theawesomehexapp/manual/)** in Chrome.
2. Open Chrome's menu.
3. Tap **Install app** or **Add to Home screen**.
4. Confirm the install.

### Mac or Windows browser app

1. Open **[Sideways](https://pokitomas.github.io/theawesomehexapp/manual/)** in Chrome or Edge.
2. Click the install icon in the address bar when it appears.
3. Confirm **Install**.

If no install control appears, keep the page as a bookmark. The static app still works in the browser.

### Public reader

Open **[the Sideways root reader](https://pokitomas.github.io/theawesomehexapp/)**. This is the public ranking and discovery surface, not the private personal archive.

## Archie local runtime

Archie installs as a global command on Windows, macOS, and Linux. Install [Node.js 20 or newer](https://nodejs.org/en/download), open PowerShell or a terminal, and run:

```bash
npm install --global https://github.com/Pokitomas/theawesomehexapp/archive/refs/heads/main.tar.gz
archie
```

The first launch reports the exact local runtime, installed artifacts, runner availability, and next commands. No model is bundled, and installation alone does not prove model capability.

To remove it:

```bash
npm uninstall --global archie
```

### Ordinary Linux computer: Archie Lite

On glibc-based x86_64 or arm64 Linux, the installer adds Archie and an official CPU-only llama.cpp runner under `~/.local`, without sudo and without downloading model weights:

```bash
curl -fsSL https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/main/scripts/install-archie-lite-linux.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

It resolves GitHub release metadata, verifies the llama.cpp asset SHA-256, rejects unsafe archive paths, installs an exact Archie commit, verifies both commands, and writes an installation receipt.

A model is still admitted separately through a signed Archie manifest:

```bash
archie pull /path/to/model-manifest.json \
  --trust-key /path/to/publisher-public.pem
archie-lite plan <model-id@version>
archie-lite run <model-id@version> --prompt "Explain the current objective."
```

See [ARCHIE_LITE.md](./ARCHIE_LITE.md) for RAM budgeting, CPU enforcement, installer controls, and truth boundaries.

### Developer checkout

```bash
git clone https://github.com/Pokitomas/theawesomehexapp.git
cd theawesomehexapp
npm install
npm run archie
```

## Archie commands

```bash
archie setup --json
archie list
archie pull <model-manifest-or-source> --trust-key <publisher-public.pem>
archie inspect <model-id@version>
archie run <model-id@version> --prompt "..."
archie benchmark <model-id@version> --suite <suite.json>
archie remove <model-id@version>
archie-lite plan <model-id@version>
archie-lite run <model-id@version> --prompt "..."
```

Only pull artifacts whose signing key and provenance you trust. Use `inspect` and `archie-lite plan` before `run`.

## Maker command

Maker is the permissioned executor. From the repository:

```bash
npm run maker -- "describe the exact end state"
```

Maker may require a configured local coding-agent adapter. It creates bounded work, verifies the exact tree, and preserves explicit merge and deployment authority.

## Verify the checkout

```bash
npm run test:archie
npm run test:archie:evaluation
node --test scripts/tests/archie-phone-product.test.mjs
npm run verify:repository
```

Passing infrastructure tests proves runtime and product contracts. It does not by itself prove that an Archie model is broadly capable.

## Current product boundary

- **Archie phone:** installable objective, authority, continuity, and handoff surface.
- **Archie runtime:** local artifact, planning, research, evaluation, and distillation system.
- **Archie Lite:** digest-verified CPU runner installation plus RAM-capped local GGUF inference.
- **Maker:** permissioned execution layer.
- **Sideways:** independent browser-installed archive and public reader.
- **General intelligence claim:** still blocked until an admitted model and complete launch profile pass independent held-out evidence.

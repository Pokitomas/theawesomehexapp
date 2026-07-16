# Install Sideways, Archie, and Maker

This page separates the things you can use immediately from developer tools that require a computer.

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

## Archie and Maker for developers

There is not yet a signed one-click native Archie installer. Archie and Maker currently run from the repository with Node.js 20 or newer.

### Windows

1. Install [Git for Windows](https://git-scm.com/download/win).
2. Install [Node.js LTS](https://nodejs.org/en/download).
3. Open PowerShell and paste:

```powershell
git clone https://github.com/Pokitomas/theawesomehexapp.git
cd theawesomehexapp
npm install
npm run archie -- list
```

### macOS

1. Install [Node.js LTS](https://nodejs.org/en/download).
2. Open Terminal and paste:

```bash
git clone https://github.com/Pokitomas/theawesomehexapp.git
cd theawesomehexapp
npm install
npm run archie -- list
```

If `git` is missing, macOS will offer to install the command-line developer tools.

### Linux

Install Git and Node.js 20 or newer using your distribution, then run:

```bash
git clone https://github.com/Pokitomas/theawesomehexapp.git
cd theawesomehexapp
npm install
npm run archie -- list
```

## Archie commands

Run commands from inside the cloned repository:

```bash
npm run archie -- list
npm run archie -- pull <model-manifest-or-source>
npm run archie -- inspect <model-id@version>
npm run archie -- run <model-id@version>
npm run archie -- benchmark <model-id@version>
npm run archie -- remove <model-id@version>
```

Only pull artifacts whose signing key and provenance you trust. `inspect` should be used before `run`.

## Maker command

Maker is the permissioned coding executor. From the repository:

```bash
npm run maker -- "describe the exact end state"
```

Maker may require a configured local coding-agent adapter. It creates bounded work, verifies the exact tree, and leaves merge authority with the human operator.

## Verify the checkout

Run the focused Archie tests:

```bash
npm run test:archie
npm run test:archie:evaluation
```

Run the repository gate before trusting a development change:

```bash
npm run verify:repository
```

Passing infrastructure tests proves the runtime contracts work. It does not by itself prove that an Archie model is highly capable. Use a packaged model's independent benchmark receipt for that claim.

## Current product boundary

- **Sideways:** usable today as a browser-installed private archive and public reader.
- **Maker:** usable from a developer checkout as the permissioned execution layer.
- **Archie:** usable as a local artifact/runtime and research system, but not yet presented as an empirically promoted general model without an independent benchmark receipt.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import manifest from '../audit/authority-manifest.mjs';
import {
  discoverAuthoritySurfaces,
  validateManifest
} from './check-authority-manifest.mjs';

function rootPath(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return path.resolve(String(root));
}

export async function auditRepository(root = process.cwd()) {
  const repositoryRoot = rootPath(root);
  const discoveredSurfaces = await discoverAuthoritySurfaces(repositoryRoot);
  const errors = await validateManifest({ root: repositoryRoot, manifest, discoveredSurfaces });
  return {
    manifest,
    discoveredSurfaces,
    errors,
    summary: {
      rows: manifest.rows.length,
      surfaces: discoveredSurfaces.length,
      trackedGaps: manifest.rows.filter(row => row.status === 'tracked-gap').length,
      declarationOnly: manifest.rows.filter(row => row.status === 'declaration-only').length,
      externalUnknowns: manifest.externalUnknowns.length
    }
  };
}

async function main() {
  const root = process.argv[2] || process.cwd();
  const result = await auditRepository(root);
  if (result.errors.length) {
    console.error('Authority manifest drift detected:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const { rows, surfaces, trackedGaps, declarationOnly, externalUnknowns } = result.summary;
  console.log(`authority manifest ok: ${rows} rows, ${surfaces} surfaces, ${trackedGaps} tracked gaps, ${declarationOnly} declaration-only rows, ${externalUnknowns} external unknowns`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}

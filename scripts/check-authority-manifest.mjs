import { pathToFileURL } from 'node:url';
import { auditRepository } from './run-authority-audit.mjs';

export * from './authority-manifest-core.mjs';
export { auditRepository } from './run-authority-audit.mjs';

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

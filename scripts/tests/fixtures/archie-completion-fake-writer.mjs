import fs from 'node:fs/promises';
import path from 'node:path';
const workspace = process.env.ARCHIE_COMPLETION_WORKSPACE;
if (!workspace) throw new Error('ARCHIE_COMPLETION_WORKSPACE missing');
await fs.writeFile(path.join(workspace, 'completion.txt'), 'complete\n', 'utf8');
const output = process.env.ARCHIE_COMPLETION_OUTPUT;
if (output) await fs.writeFile(output, 'Created completion.txt and left verification to Archie.\n', 'utf8');

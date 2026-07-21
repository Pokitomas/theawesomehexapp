import baseManifest from './authority-manifest.base.mjs';
import archie95Rows from './authority-manifest.archie95.mjs';

export default Object.freeze({
  ...baseManifest,
  rows: Object.freeze([...baseManifest.rows, ...archie95Rows])
});

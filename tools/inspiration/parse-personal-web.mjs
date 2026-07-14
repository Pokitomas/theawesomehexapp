#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const manifestPath = path.resolve(root, 'studio/manual/inspiration/personal-web-sources.json');
const outputPath = path.resolve(root, 'studio/manual/inspiration/personal-web-brief.json');
const snapshotsDir = path.resolve(root, 'studio/manual/inspiration/snapshots');

const read = p => fs.readFileSync(p, 'utf8');
const manifest = JSON.parse(read(manifestPath));

const SIGNALS = {
  personal_voice: [/\b(i|me|my|mine|diary|journal|about me|shrines?)\b/gi],
  dense_navigation: [/<a\b/gi, /nav|webring|sitemap|directory/gi],
  animated_texture: [/\.gif\b/gi, /animation\s*:/gi, /@keyframes/gi, /marquee|blink/gi],
  layered_windows: [/position\s*:\s*(absolute|fixed)/gi, /z-index\s*:/gi, /window|panel|dialog/gi],
  handmade_edges: [/border-(style|image)|inset|outset|ridge|groove/gi, /box-shadow\s*:/gi],
  expressive_type: [/font-family\s*:/gi, /text-shadow\s*:/gi, /letter-spacing\s*:/gi],
  saturated_palette: [/#[0-9a-f]{3,8}\b/gi, /rgb\(|hsl\(|linear-gradient|radial-gradient/gi],
  media_collage: [/<(img|video|audio|canvas|iframe)\b/gi, /background-image\s*:/gi],
  community_edges: [/webring|guestbook|button wall|88x31|badge|links out|neighbors/gi],
  anti_template: [/custom cursor|cursor\s*:\s*url|clip-path|mix-blend-mode|filter\s*:/gi],
  low_infrastructure: [/static|html|css|javascript|no build|view source/gi],
};

function occurrences(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length || 0), 0);
}

function sourceText(source) {
  const parts = [source.title || '', source.notes || '', ...(source.tags || [])];
  if (source.snapshot) {
    const snapshot = path.resolve(snapshotsDir, source.snapshot);
    if (fs.existsSync(snapshot)) parts.push(read(snapshot));
  }
  return parts.join('\n');
}

const deduped = [...new Map(manifest.sources.map(source => [source.url, source])).values()];
const rows = deduped.map(source => {
  const text = sourceText(source);
  const signals = Object.fromEntries(
    Object.entries(SIGNALS).map(([name, patterns]) => [name, occurrences(text, patterns)])
  );
  const implementation = source.implementation || {};
  const complexity =
    (implementation.dom_layers || 1) +
    (implementation.interaction_modes || 0) * 2 +
    (implementation.custom_state || 0) * 3 +
    (implementation.network_services || 0) * 5;
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    tags: source.tags || [],
    signals,
    complexity,
    notes: source.notes || '',
  };
});

const totals = Object.fromEntries(Object.keys(SIGNALS).map(key => [key, rows.reduce((n, row) => n + row.signals[key], 0)]));
const rankedSignals = Object.entries(totals).sort((a, b) => b[1] - a[1]);
const medianComplexity = [...rows].sort((a, b) => a.complexity - b.complexity)[Math.floor(rows.length / 2)]?.complexity || 0;

const brief = {
  schema: 'sideways-personal-web-brief-v1',
  generatedAt: new Date().toISOString(),
  sourceCount: rows.length,
  sourceUrls: rows.map(row => row.url),
  rankedSignals: rankedSignals.map(([signal, count]) => ({ signal, count })),
  complexity: {
    median: medianComplexity,
    ceiling: manifest.complexityCeiling,
    rule: 'Prefer visible compositional richness over invisible subsystem count.',
  },
  productCenter: manifest.productCenter,
  requiredTraits: manifest.requiredTraits,
  rejectDrift: manifest.rejectDrift,
  decisionChecks: [
    'Does this surface reveal a person, collection, or obsession rather than a platform template?',
    'Is the weirdness structural and usable, not decorative nostalgia pasted onto SaaS?',
    'Can the effect be achieved with existing corpus, renderer, and action contracts?',
    'Does the visual density remain legible at 390x844?',
    'Did implementation complexity grow slower than visible product character?',
  ],
  sources: rows,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(brief, null, 2)}\n`);
console.log(`wrote ${path.relative(root, outputPath)} from ${rows.length} attributed sources`);

if (args.has('--check')) {
  if (rows.length < 16) throw new Error('inspiration set must contain at least 16 unique sources');
  if (!manifest.requiredTraits?.length || !manifest.rejectDrift?.length) throw new Error('anchor rules missing');
  if (medianComplexity > manifest.complexityCeiling) throw new Error('source-set complexity exceeds product ceiling');
}

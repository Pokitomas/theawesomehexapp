#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkedHead(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function inspect(root, id, files) {
  const evidence = [];
  const missing = [];
  for (const [relativePath, patterns] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      missing.push(`${relativePath}: missing file`);
      continue;
    }
    const content = readFileSync(absolutePath, 'utf8');
    evidence.push(relativePath);
    for (const pattern of patterns) {
      if (!content.includes(pattern)) missing.push(`${relativePath}: ${pattern}`);
    }
  }
  return missing.length
    ? { id, status: 'stale', evidence, reason: `required quality markers missing: ${missing.join('; ')}` }
    : { id, status: 'verified', evidence };
}

export function inspectHumanQuality({ root = defaultRoot, observedAt = new Date().toISOString() } = {}) {
  const repositoryFacts = [
    inspect(root, 'founder_semantic_controls', {
      'founder/index.html': [
        '<html lang="en">',
        'name="viewport"',
        '<main class="shell">',
        'aria-label="Product directions"',
        'role="group"',
        '<label class="note-label" for="founder-note">',
        'role="status" aria-live="polite"'
      ]
    }),
    inspect(root, 'founder_keyboard_and_touch_baseline', {
      'founder/founder.css': [
        'button:focus-visible',
        'textarea:focus-visible',
        'outline: 4px solid var(--blue)',
        'min-height: 48px',
        '@media (max-width: 980px)',
        '@media (max-width: 520px)'
      ]
    }),
    inspect(root, 'maker_semantic_controls', {
      'maker/index.html': [
        '<html lang="en">',
        'name="viewport"',
        '<main class="shell">',
        'role="group" aria-label="Command mode"',
        '<label for="maker-request">',
        '<label for="maker-protect">',
        '<label for="maker-proof">'
      ]
    }),
    inspect(root, 'maker_keyboard_touch_and_reflow_baseline', {
      'maker/maker.css': [
        'button:focus-visible',
        'a:focus-visible',
        'summary:focus-visible',
        'min-height: 48px',
        'min-height: 54px',
        'min-height: 56px',
        'overflow-wrap: anywhere',
        '@media (max-width: 760px)',
        '@media (max-width: 520px)'
      ]
    })
  ];

  const unknown = [
    ['screen_reader_journeys', 'Requires dated VoiceOver, TalkBack, NVDA, or equivalent interaction evidence.'],
    ['cross_browser_behavior', 'Requires dated Chromium, Firefox, and WebKit journeys.'],
    ['text_zoom_and_reflow', 'Static media queries do not prove 200% or 400% browser zoom behavior.'],
    ['computed_contrast', 'Repository color tokens are not a substitute for computed contrast measurement.'],
    ['reduced_motion_behavior', 'Requires a motion inventory and browser-level reduced-motion witness.'],
    ['keyboard_end_to_end', 'Static focus rules do not prove focus order, traps, or complete keyboard operability.'],
    ['touch_target_geometry', 'CSS minimum heights do not prove computed width, spacing, or overlapping hit regions.'],
    ['startup_and_scale_performance', 'Requires measured budgets on representative devices and fixture sizes.'],
    ['offline_and_bad_network', 'Requires service/network failure journeys rather than source inspection.'],
    ['blocked_storage_and_quota', 'Requires browser-level blocked storage and quota pressure fixtures.']
  ].map(([id, reason]) => ({ id, status: 'unknown', source: 'runtime', reason }));

  const verified = repositoryFacts.filter(item => item.status === 'verified');
  const stale = repositoryFacts.filter(item => item.status === 'stale');
  return {
    schema: 'sideways-human-quality/v1',
    repository: process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp',
    checked_head_sha: checkedHead(root),
    observed_at: observedAt,
    status: stale.length ? 'failed' : 'partial',
    verified,
    unknown,
    stale
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectHumanQuality();
  const output = process.env.HUMAN_QUALITY_RECEIPT;
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length) process.exitCode = 1;
}

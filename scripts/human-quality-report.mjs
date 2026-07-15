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

function inspect(root, id, files, kind = 'repository') {
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
    for (const pattern of patterns) if (!content.includes(pattern)) missing.push(`${relativePath}: ${pattern}`);
  }
  return missing.length
    ? { id, status: 'stale', kind, evidence, reason: `required quality markers missing: ${missing.join('; ')}` }
    : { id, status: 'verified', kind, evidence };
}

export function inspectHumanQuality({ root = defaultRoot, observedAt = new Date().toISOString() } = {}) {
  const repositoryFacts = [
    inspect(root, 'founder_semantic_controls', {
      'founder/index.html': ['<html lang="en">', 'name="viewport"', '<main class="shell">', 'aria-label="Product directions"', 'role="group"', '<label class="note-label" for="founder-note">', 'role="status" aria-live="polite"']
    }),
    inspect(root, 'founder_keyboard_and_touch_baseline', {
      'founder/founder.css': ['button:focus-visible', 'textarea:focus-visible', 'outline: 4px solid var(--blue)', 'min-height: 48px', '@media (max-width: 980px)', '@media (max-width: 520px)']
    }),
    inspect(root, 'maker_semantic_controls', {
      'maker/index.html': ['<html lang="en">', 'name="viewport"', '<main class="shell">', 'role="group" aria-label="Command mode"', '<label for="maker-request">', '<label for="maker-protect">', '<label for="maker-proof">']
    }),
    inspect(root, 'maker_keyboard_touch_and_reflow_baseline', {
      'maker/maker.css': ['button:focus-visible', 'a:focus-visible', 'summary:focus-visible', 'min-height: 48px', 'min-height: 54px', 'min-height: 56px', 'overflow-wrap: anywhere', '@media (max-width: 760px)', '@media (max-width: 520px)']
    }),
    inspect(root, 'root_phone_desktop_zoom_contrast_motion_keyboard_network', {
      'scripts/root-product-phone.mjs': [
        'width: 390, height: 844', 'width: 1440, height: 1000', 'for (const zoom of [200, 400])',
        'contrastRatio', 'computed contrast below 4.5', "reducedMotion: 'reduce'", 'context.setOffline(true)',
        "page.route('**/api/**'", "page.keyboard.press('Enter')", 'keyboard focus is trapped', 'horizontal overflow', "page.on('pageerror'"
      ],
      'verify-profile-build.py': ['scripts/root-product-phone.mjs', 'ordinaryExplanation']
    }, 'browser-workflow'),
    inspect(root, 'manual_primary_phone_journey', {
      'studio/manual/tests/frontier-onboarding-clickthrough.mjs': ['width: 390, height: 844', "page.on('pageerror'", 'touch target is physically obstructed', 'profile close is clipped or undersized', 'fileChoosers !== 0', 'errors.length'],
      '.github/workflows/frontier-phone-proof.yml': ['Run the real phone journey', 'frontier-onboarding-clickthrough.mjs']
    }, 'browser-workflow'),
    inspect(root, 'social_phone_authority_and_overflow', {
      'studio/manual/tests/social-spine-clickthrough.mjs': ['width: 390, height: 844', 'pageerror', 'phone overflow', 'session isolation failed'],
      '.github/workflows/social-spine-phone.yml': ['Prove two isolated accounts and profile editing on phone']
    }, 'browser-workflow'),
    inspect(root, 'blocked_storage_quota_and_restore_failure', {
      'scripts/tests/archive-mirror-failure.test.mjs': ['QuotaExceededError', 'promoted', 'survival.mirror.failed'],
      'scripts/tests/archive-revival-contract.test.mjs': ['rollback', 'ARK EXCEEDS BOUNDED MEMORY FALLBACK', 'external_observation_limits'],
      'studio/manual/tests/survival-ledger-clickthrough.mjs': ['width: 390, height: 844', 'mirror generation mismatch', 'horizontal overflow'],
      '.github/workflows/survival-ledger-phone.yml': ['survival-ledger-clickthrough.mjs']
    }, 'hostile-and-browser-workflow')
  ];

  const unknown = [
    ['screen_reader_journeys', 'Requires dated VoiceOver, TalkBack, NVDA, or equivalent interaction evidence; semantic source and keyboard proof are not a screen-reader claim.'],
    ['cross_browser_behavior', 'Current executable browser witnesses use Chromium; Firefox and WebKit remain intentionally unsupported until dated runs exist.'],
    ['startup_and_scale_performance', 'One-million-candidate build integrity is proved, but representative-device startup, memory, and interaction latency budgets remain unmeasured.']
  ].map(([id, reason]) => ({ id, status: 'unknown', source: 'runtime', reason }));

  const verified = repositoryFacts.filter(item => item.status === 'verified');
  const stale = repositoryFacts.filter(item => item.status === 'stale');
  return {
    schema: 'sideways-human-quality/v2',
    repository: process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp',
    checked_head_sha: checkedHead(root),
    observed_at: observedAt,
    status: stale.length ? 'failed' : 'partial',
    verified,
    unknown,
    stale,
    admission_rule: 'Browser-workflow facts become release evidence only when their named exact-head workflows pass. Screen-reader, non-Chromium, and representative-device performance claims remain unsupported.'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectHumanQuality();
  const output = process.env.HUMAN_QUALITY_RECEIPT;
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length) process.exitCode = 1;
}

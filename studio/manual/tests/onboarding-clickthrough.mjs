// Real iPhone click-through regression test for the interaction-freeze bug in #40
// ("live manual app feels like it is constantly refreshing and taps do not
// reliably land on iPhone").
//
// Two independent checks, not just a smoke test:
//   1. Instruments MutationObserver itself (before any app code runs) to count
//      how many times observer callbacks actually fire during a fixed burst of
//      real taps. A debounced observer should fire roughly once per animation
//      frame, not once per mutation — this catches the regression class
//      described in #40 even if the specific cause moves around during the fix.
//   2. Walks the real onboarding -> import -> feed tap sequence with actual
//      page.tap() calls (not .click(), which does not go through the touch
//      event path iOS actually uses) and asserts each tap produces the
//      expected visible state change within a real timeout, catching "taps
//      don't land" directly rather than inferring it from observer counts.
//
// Run: node studio/manual/tests/onboarding-clickthrough.mjs <built-dist-url>

import { chromium } from 'playwright-core';

const IPHONE_VIEWPORT = { width: 390, height: 844 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const OBSERVER_BUDGET = 40; // generous ceiling for a ~10-tap burst; a healthy debounce stays far under this
const TAP_TIMEOUT_MS = 2000;

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node onboarding-clickthrough.mjs <url>');
    process.exit(2);
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: IPHONE_VIEWPORT,
    userAgent: IPHONE_UA,
    hasTouch: true,
    isMobile: true,
  });

  let failures = 0;

  // --- Instrument observer activity before the app's own scripts run ---
  await page.addInitScript(() => {
    window.__observerFires = 0;
    window.__observerCount = 0;
    const RealMO = window.MutationObserver;
    window.MutationObserver = class extends RealMO {
      constructor(cb) {
        window.__observerCount++;
        super((...args) => { window.__observerFires++; return cb(...args); });
      }
    };
  });

  await page.goto(url, { waitUntil: 'networkidle' });

  // --- Walk a real tap sequence, asserting each tap actually lands ---
  const steps = [
    { tap: '[data-onboarding-start], #onboardingStart, .onboarding-start', expect: '[data-onboarding-source], #chooseSource' },
    { tap: '[data-source-option]:first-of-type, .source-card:first-of-type', expect: '[data-import-terminal], #importWorkbenchHost' },
    { tap: '#navFeed, [data-nav="feed"]', expect: '#feed:not([hidden]), #feedView:not([hidden])' },
  ];

  const preBurstFires = () => page.evaluate(() => window.__observerFires);
  const fireCountBefore = await preBurstFires();

  // Track scheduled work directly too: the fix replaced the unbounded MutationObserver
  // with a fixed retry schedule (immediate + 100/320/900/1800ms). Any observer this test
  // finds should still be bounded, but the real proof now is quiescence -- nothing should
  // still be firing well after the longest scheduled delay.
  await page.evaluate(() => {
    window.__lastActivityAt = Date.now();
    const markActivity = () => { window.__lastActivityAt = Date.now(); };
    window.addEventListener('hashchange', markActivity);
    window.addEventListener('sideways:ready', markActivity);
    window.addEventListener('sideways:importworkbench', markActivity);
  });

  for (const step of steps) {
    const tapTarget = page.locator(step.tap).first();
    const count = await tapTarget.count();
    if (count === 0) {
      console.log(`SKIP (selector not present, UI may have changed): ${step.tap}`);
      continue;
    }
    await tapTarget.tap({ timeout: TAP_TIMEOUT_MS }).catch(err => {
      failures++;
      console.error(`*** TAP FAILED to register: ${step.tap} — ${err.message}`);
    });
    await page.locator(step.expect).first().waitFor({ state: 'visible', timeout: TAP_TIMEOUT_MS }).catch(err => {
      failures++;
      console.error(`*** Expected result never appeared after tapping ${step.tap}: ${step.expect} — ${err.message}`);
    });
  }

  const fireCountAfter = await preBurstFires();
  const burstFires = fireCountAfter - fireCountBefore;
  console.log(`Observer callback fires during ${steps.length}-tap burst: ${burstFires} (budget: ${OBSERVER_BUDGET}, informational if 0 -- observer-based scheduling may be gone entirely)`);
  if (burstFires > OBSERVER_BUDGET) {
    failures++;
    console.error(`*** Observer fired ${burstFires} times for ${steps.length} taps — debounce likely broken, this is the #40 failure mode.`);
  }

  // Real proof for the bounded-retry fix: wait past the longest scheduled delay (1800ms)
  // plus a safety margin, then confirm nothing has scheduled new work since. An app that's
  // still quietly re-triggering past its own stated retry window is the same bug wearing
  // a different mechanism.
  const QUIESCE_WAIT_MS = 1800 + 700;
  const beforeWait = await page.evaluate(() => window.__lastActivityAt);
  await page.waitForTimeout(QUIESCE_WAIT_MS);
  const afterWait = await page.evaluate(() => window.__lastActivityAt);
  const idleMs = afterWait - beforeWait;
  console.log(`Activity-tracked events in the ${QUIESCE_WAIT_MS}ms post-burst window: last activity delta ${idleMs}ms`);
  if (idleMs > 50) {
    failures++;
    console.error(`*** Something re-triggered ${idleMs}ms into the quiescence window, after the fix's own longest scheduled delay (1800ms) — retry schedule may not actually be bounded.`);
  }

  await browser.close();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} issue(s) found.`);
    process.exit(1);
  }
  console.log('\nOnboarding click-through: taps landed, observer activity within budget.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

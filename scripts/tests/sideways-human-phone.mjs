import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

function commandPath(name) {
  try { return execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  chromium.executablePath(),
  commandPath('google-chrome'),
  commandPath('google-chrome-stable'),
  commandPath('chromium'),
  commandPath('chromium-browser'),
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));

const baseURL = process.env.SIDEWAYS_MANUAL_URL || 'http://127.0.0.1:4176/manual-app/';
const forbidden = /\b(?:AI|agent|model|prompt|co-engineer|Maker|Foundry|weave|lasso|genome|simulation|command[ -]?center|debug)\b/i;
const proof = {
  executablePath: executablePath || null,
  baseURL,
  phone: null,
  desktop: null,
  errors: []
};
let browser = null;

async function inspect(viewport, name, options = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: Boolean(options.mobile),
    hasTouch: Boolean(options.mobile),
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('html[data-sideways-human="ready"]', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(({ forbiddenSource }) => {
      const forbidden = new RegExp(forbiddenSource, 'i');
      const visibleText = document.body.innerText;
      const shellSelectors = [
        '.topbar',
        '[data-sideways-location]',
        '.workspace-feed-header',
        '.workspace-library-header',
        '.workspace-route-header',
        '.studio-empty-hero',
        '[data-social-spine] > header'
      ];
      const shellText = shellSelectors
        .flatMap(selector => [...document.querySelectorAll(selector)])
        .filter(node => !node.hidden && getComputedStyle(node).display !== 'none')
        .map(node => node.innerText)
        .join('\n');
      const locationBar = document.querySelector('[data-sideways-location]');
      const developerLinks = [...document.querySelectorAll('a[href]')].filter(anchor => {
        try { return /(^|\/)(maker|founder)(\/|$)/i.test(new URL(anchor.href, location.href).pathname) && !anchor.hidden && getComputedStyle(anchor).display !== 'none'; }
        catch { return false; }
      });
      const developerSurfaces = [...document.querySelectorAll('[data-sideways-remote-launch], [data-sideways-remote-terminal], #live-work')]
        .filter(node => node.isConnected && !node.hidden && getComputedStyle(node).display !== 'none');
      const visibleDebug = ['debugPanel', 'debugPolicy', 'debugState']
        .map(id => document.getElementById(id))
        .filter(node => node && !node.hidden && getComputedStyle(node).display !== 'none');
      const normalLink = locationBar?.querySelector('a');
      const structuralCard = document.querySelector('.post, .studio-empty-hero, .import-workbench-card, .profile-card');
      const topbar = document.querySelector('.topbar');
      const navControls = [...document.querySelectorAll('.workspace-commandbar button:not([hidden]), .workspace-commandbar a:not([hidden])')];
      const controlHeights = navControls.map(node => Math.round(node.getBoundingClientRect().height));
      const reducedTarget = document.querySelector('.workspace-nav-button, .post, .studio-empty-hero');
      const linkStyle = normalLink ? getComputedStyle(normalLink) : null;
      const cardStyle = structuralCard ? getComputedStyle(structuralCard) : null;
      const topbarStyle = topbar ? getComputedStyle(topbar) : null;
      const reducedStyle = reducedTarget ? getComputedStyle(reducedTarget) : null;
      return {
        ready: document.documentElement.dataset.sidewaysHuman === 'ready',
        location: locationBar?.innerText || '',
        forbiddenShellText: shellText.match(forbidden)?.[0] || null,
        developerLinks: developerLinks.map(anchor => anchor.href),
        developerSurfaces: developerSurfaces.map(node => node.id || node.getAttribute('data-action-id') || node.tagName),
        visibleDebug: visibleDebug.map(node => node.id),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        linkDecoration: linkStyle?.textDecorationLine || '',
        cardRadius: cardStyle?.borderTopLeftRadius || null,
        cardBackdrop: cardStyle?.backdropFilter || null,
        topbarBackdrop: topbarStyle?.backdropFilter || null,
        controlHeights,
        reducedTransition: reducedStyle?.transitionDuration || null,
        bodyTextLength: visibleText.trim().length,
        shellTextLength: shellText.trim().length
      };
    }, { forbiddenSource: forbidden.source });

    if (!result.ready) throw new Error(`${name}: human layer did not reach ready state`);
    if (!/Sideways/.test(result.location)) throw new Error(`${name}: persistent location context is missing`);
    if (result.forbiddenShellText) throw new Error(`${name}: internal vocabulary leaked into ordinary shell: ${result.forbiddenShellText}`);
    if (result.developerLinks.length) throw new Error(`${name}: developer entrypoint visible: ${result.developerLinks.join(', ')}`);
    if (result.developerSurfaces.length) throw new Error(`${name}: developer surface visible: ${result.developerSurfaces.join(', ')}`);
    if (result.visibleDebug.length) throw new Error(`${name}: debug surface visible: ${result.visibleDebug.join(', ')}`);
    if (result.overflow > 1) throw new Error(`${name}: horizontal overflow ${result.overflow}px`);
    if (!result.linkDecoration.includes('underline')) throw new Error(`${name}: links are not visibly underlined`);
    if (result.cardRadius && parseFloat(result.cardRadius) > 2) throw new Error(`${name}: card radius is not native-web structured: ${result.cardRadius}`);
    if (result.cardBackdrop && result.cardBackdrop !== 'none') throw new Error(`${name}: card uses backdrop filtering: ${result.cardBackdrop}`);
    if (result.topbarBackdrop && result.topbarBackdrop !== 'none') throw new Error(`${name}: topbar uses backdrop filtering: ${result.topbarBackdrop}`);
    if (options.mobile && result.controlHeights.some(height => height < 40)) throw new Error(`${name}: compact navigation has a control below 40px: ${result.controlHeights.join(',')}`);
    if (result.reducedTransition && !/^0s(?:, 0s)*$/.test(result.reducedTransition)) throw new Error(`${name}: reduced motion transition remains ${result.reducedTransition}`);
    if (result.bodyTextLength < 20 || result.shellTextLength < 10) throw new Error(`${name}: ordinary product did not render meaningful text`);
    if (pageErrors.length) throw new Error(`${name}: page errors: ${pageErrors.join(' | ')}`);

    await page.screenshot({ path: `sideways-human-${name}.png`, fullPage: true });
    return result;
  } finally {
    await context.close();
  }
}

try {
  if (!executablePath) throw new Error('no Chromium executable found in environment, Playwright cache, or runner paths');
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  proof.phone = await inspect({ width: 390, height: 844 }, 'phone', { mobile: true });
  proof.desktop = await inspect({ width: 1280, height: 900 }, 'desktop');
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  fs.writeFileSync('sideways-human-proof.json', `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
  if (browser) await browser.close();
}

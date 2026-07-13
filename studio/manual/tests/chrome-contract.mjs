import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node chrome-contract.mjs <manual-url>');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes');
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready');
await page.waitForTimeout(1100);

const result = await page.evaluate(() => {
  const commandbar = document.querySelector('[data-workspace-commandbar]');
  const titlebar = document.querySelector('.topline');
  const titleBrand = document.querySelector('[data-workspace-title-brand]');
  const titleActions = document.querySelector('[data-workspace-title-actions]');
  const newButtons = [...document.querySelectorAll('[data-workspace-new][data-action-id="feed.post"]')];
  const navs = [...document.querySelectorAll('[data-workspace-nav]')];
  const feed = document.getElementById('navFeed');
  const profile = document.getElementById('navProfile');
  const activeTab = document.querySelector('.type-nav button[aria-pressed="true"]');
  return {
    titleBrand: titleBrand?.textContent?.trim() || '',
    titleBrandInTitlebar: Boolean(titlebar && titleBrand && titlebar.contains(titleBrand)),
    profileInTitlebar: Boolean(titleActions && profile && titleActions.contains(profile)),
    newCount: newButtons.length,
    navCount: navs.length,
    newInCommandbar: Boolean(commandbar && newButtons[0] && commandbar.contains(newButtons[0])),
    navInCommandbar: Boolean(commandbar && navs[0] && commandbar.contains(navs[0])),
    feedLabel: feed?.textContent?.trim() || '',
    feedHasBrandClass: Boolean(feed?.classList.contains('brand-lockup') || feed?.classList.contains('brand')),
    newLabelVisible: newButtons[0] ? getComputedStyle(newButtons[0].querySelector('.workspace-button-label')).display !== 'none' : false,
    newRadius: newButtons[0] ? parseFloat(getComputedStyle(newButtons[0]).borderRadius) : 99,
    activeTabRadius: activeTab ? parseFloat(getComputedStyle(activeTab).borderRadius) : 99,
    activeTabInset: activeTab ? getComputedStyle(activeTab).boxShadow : ''
  };
});

if (result.titleBrand !== 'Sideways' || !result.titleBrandInTitlebar) throw new Error(`title identity is not owned by the titlebar: ${JSON.stringify(result)}`);
if (!result.profileInTitlebar) throw new Error(`profile escaped the titlebar: ${JSON.stringify(result)}`);
if (result.newCount !== 1 || result.navCount !== 1) throw new Error(`command chrome duplicated controls: ${JSON.stringify(result)}`);
if (!result.newInCommandbar || !result.navInCommandbar) throw new Error(`commands escaped the commandbar: ${JSON.stringify(result)}`);
if (result.feedLabel !== 'Feed' || result.feedHasBrandClass) throw new Error(`Feed is still impersonating product identity: ${JSON.stringify(result)}`);
if (!result.newLabelVisible) throw new Error(`mobile command labels disappeared: ${JSON.stringify(result)}`);
if (result.newRadius > 5 || result.activeTabRadius > 1) throw new Error(`rounded dashboard styling returned: ${JSON.stringify(result)}`);
if (!result.activeTabInset || result.activeTabInset === 'none') throw new Error(`tab strip lost its selected-state physics: ${JSON.stringify(result)}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-chrome-contract.png', fullPage: true });
console.log(JSON.stringify({ ...result, screenshot: 'manual-chrome-contract.png' }, null, 2));
await context.close();
await browser.close();

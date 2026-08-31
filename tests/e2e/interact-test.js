// Browser end-to-end test. Requires: npm i playwright-core (chromium at /opt/pw-browsers or set CHROMIUM_PATH).
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const REPO_URL = 'file://' + REPO;
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  const checks = [];
  const check = (name, ok, detail) => { checks.push([name, ok, detail]); };

  // --- Mobile menu on a client site ---
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(REPO_URL + '/clients/joes-hvac/index.html');
  await page.waitForTimeout(300);
  check('menu closed initially', !(await page.isVisible('.topnav a[href="#services"]')));
  await page.click('.menu-btn');
  check('menu opens on tap', await page.isVisible('.topnav a[href="#services"]'));
  check('aria-expanded set', (await page.getAttribute('.menu-btn', 'aria-expanded')) === 'true');
  await page.click('.topnav a[href="#services"]');
  await page.waitForTimeout(200);
  check('menu closes after nav', !(await page.isVisible('.topnav a[href="#contact"]')));
  await page.close();

  // --- Agency site: reveals, counters, nav state ---
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(REPO_URL + '/site/index.html');
  await page.waitForTimeout(1600);
  check('hero copy entrance ran', parseFloat(await page.evaluate(() => getComputedStyle(document.querySelector('.hero-copy h1')).opacity)) >= 0.95);
  const counterText = await page.textContent('.stats [data-count="99.9"]');
  await page.waitForTimeout(1600);
  const counterAfter = await page.textContent('.stats [data-count="99.9"]');
  check('stat counter animates to 99.9%', counterAfter.trim() === '99.9%', counterAfter);

  const beforeReveal = await page.evaluate(() => {
    const el = document.querySelector('#plans .plan');
    return getComputedStyle(el).opacity;
  });
  check('below-fold cards hidden pre-scroll', beforeReveal === '0', beforeReveal);
  await page.evaluate(() => document.querySelector('#plans').scrollIntoView());
  await page.waitForTimeout(2000);
  const afterReveal = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#plans .plan')).opacity);
  check('cards reveal on scroll', parseFloat(afterReveal) >= 0.95, afterReveal);
  check('nav highlights active section', (await page.getAttribute('.topnav a[href="#plans"]', 'class') || '').includes('active'));

  // --- FAQ toggle ---
  await page.evaluate(() => document.querySelector('#faq').scrollIntoView());
  await page.waitForTimeout(800);
  await page.click('#faq details:first-of-type summary');
  await page.waitForTimeout(500);
  check('FAQ opens', await page.evaluate(() => document.querySelector('#faq details').open));

  // --- No-JS graceful degradation ---
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  const nojs = await ctx.newPage();
  await nojs.goto(REPO_URL + '/site/index.html');
  const nojsVisible = await nojs.evaluate(() => {
    const h1 = getComputedStyle(document.querySelector('.hero-copy h1')).opacity;
    const plan = getComputedStyle(document.querySelector('#plans .plan')).opacity;
    return h1 === '1' && plan === '1';
  });
  check('everything visible without JS', nojsVisible);
  await ctx.close();

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
    if (!ok) failed++;
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();

// Browser end-to-end test. Requires: npm i playwright-core (chromium at /opt/pw-browsers or set CHROMIUM_PATH).
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const REPO_URL = 'file://' + REPO;
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const target = process.argv[2];
  await page.goto('file://' + target);
  await page.waitForTimeout(400);
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflowers = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        overflowers.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(r.right)} left=${Math.round(r.left)} w=${Math.round(r.width)}`);
      }
    });
    return { vw, scrollW: document.documentElement.scrollWidth, overflowers: overflowers.slice(0, 15) };
  });
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();

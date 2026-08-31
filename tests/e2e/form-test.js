// Browser end-to-end test. Requires: npm i playwright-core (chromium at /opt/pw-browsers or set CHROMIUM_PATH).
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const REPO_URL = 'file://' + REPO;
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(REPO_URL + '/intake/index.html');

  // Simulate the walk-in: fill the form like a real conversation
  await page.fill('#business_name', "Rosie's Bread & Butter");
  await page.fill('#cta_label', 'Order ahead');
  await page.fill('#headline', 'Sourdough worth setting an alarm for');
  await page.fill('#tagline', 'Baked at 4 a.m., gone by noon');
  await page.fill('#about', 'Rosie has been baking since she could reach the counter.');
  await page.fill('#cta_heading', 'The rye sells out first.');
  await page.fill('#meta_description', 'Fresh sourdough and pastries in Muskegon.');
  const svc = await page.$$('.svc');
  await (await svc[0].$$('input'))[0].fill('Sourdough loaves');
  await (await svc[0].$$('input'))[1].fill('Naturally leavened, 36-hour ferment.');
  await (await svc[1].$$('input'))[0].fill('Custom cakes');
  await page.fill('#badge0', 'Baked fresh daily');
  await page.fill('#badge1', 'Family recipe since 1974');
  await page.fill('#why0', 'Everything from scratch, every morning');
  await page.fill('#phone', '(231) 555-0163');
  await page.fill('#email', 'rosie@rosiesbread.com');
  await page.fill('#address', '456 Western Ave, Muskegon, MI 49440');
  await page.fill('#hours', 'Tue-Sat: 7am-2pm');

  // Checks
  const json = JSON.parse(await page.textContent('#preview'));
  const checks = [
    ['auto-slug from name', json.slug === 'rosie-s-bread-and-butter' || json.slug === 'rosies-bread-and-butter', json.slug],
    ['business name preserved', json.business_name === "Rosie's Bread & Butter", json.business_name],
    ['service with desc -> object', typeof json.services[0] === 'object' && json.services[0].desc.includes('36-hour'), JSON.stringify(json.services[0])],
    ['service without desc -> string', json.services[1] === 'Custom cakes', JSON.stringify(json.services[1])],
    ['empty service rows dropped', json.services.length === 2, json.services.length],
    ['partial badges kept (2)', (json.badges || []).length === 2, JSON.stringify(json.badges)],
    ['partial why_us kept (1)', (json.why_us || []).length === 1, JSON.stringify(json.why_us)],
    ['maps_url auto-built', json.maps_url.includes('456%20Western') || json.maps_url.includes('456+Western'), json.maps_url],
    ['cta heading captured', json.cta_heading === 'The rye sells out first.', json.cta_heading],
    ['colors present', /^#[0-9a-f]{6}$/i.test(json.color_primary), json.color_primary],
  ];

  // Download produces a valid file
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('button:has-text("Download file")'),
  ]);
  const path = await download.path();
  const downloaded = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  checks.push(['download works & round-trips', downloaded.business_name === json.business_name, download.suggestedFilename()]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
    if (!ok) failed++;
  }
  // Write the JSON out for the end-to-end lifecycle test
  require('fs').writeFileSync('rosie-intake.json', JSON.stringify(json, null, 2));
  await browser.close();
  process.exit(failed ? 1 : 0);
})();

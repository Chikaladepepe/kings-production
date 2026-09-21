/* Prove the shop reveal fix works in a REAL Chromium (Edge on this PC).
   The embedded preview's IntersectionObserver is unreliable for scrolled
   content, so this drives the actual page: load /#/shop, wait for cards,
   assert opacity, click Free chip, click Tool chip, type a search. */
'use strict';
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => { fail++; console.log('  PAGEERROR ' + e.message); });

  console.log('[1] load /#/shop');
  await page.goto(BASE + '/#/shop', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#shop-grid-our .asset-card', { timeout: 15000 }).catch(() => {});
  await sleep(900); // allow reveal transition to start

  const cardState = () => page.evaluate(() =>
    [...document.querySelectorAll('#shop-grid-our .asset-card, #shop-grid-seller .asset-card')].map(c => ({
      op: getComputedStyle(c).opacity, t: ((c.querySelector('.asset-title') || {}).textContent || '').trim(),
    })));

  let cards = await cardState();
  console.log('  initial cards:', JSON.stringify(cards));
  ok('initial card visible (opacity > 0.9)', cards.length > 0 && Number(cards[0].op) > 0.9, cards);

  console.log('[2] click Free chip');
  const clickedFree = await page.evaluate(() => {
    const chip = document.querySelector('.shop-chips[data-s="our"] .chip[data-cat="free"]');
    if (!chip) return false; chip.click(); return true;
  });
  ok('free chip exists+clicked', clickedFree);
  await sleep(700);
  cards = await cardState();
  console.log('  after free:', JSON.stringify(cards));
  ok('free card visible after chip', cards.length > 0 && Number(cards[0].op) > 0.9, cards);

  console.log('[3] click Tool chip');
  await page.evaluate(() => { const c = document.querySelector('.shop-chips[data-s="our"] .chip[data-cat="tool"]'); if (c) c.click(); });
  await sleep(700);
  cards = await cardState();
  console.log('  after tool:', JSON.stringify(cards));
  ok('tool card visible after chip', cards.length > 0 && Number(cards[0].op) > 0.9, cards);

  console.log('[4] search "hammer"');
  await page.type('#shop-q-our', 'hammer', { delay: 20 });
  await sleep(900);
  cards = await cardState();
  console.log('  after search:', JSON.stringify(cards));
  ok('search result visible', cards.length > 0 && Number(cards[0].op) > 0.9 && /hammer/i.test(cards[0].t), cards);

  console.log('[5] home catalog refresh');
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#cat-grid .asset-card', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { const c = document.querySelector('#cat-chips .chip[data-cat="free"]'); if (c) c.click(); });
  await sleep(800);
  const homeCards = await page.evaluate(() =>
    [...document.querySelectorAll('#cat-grid .asset-card')].map(c => ({ op: getComputedStyle(c).opacity, t: ((c.querySelector('.asset-title') || {}).textContent || '').trim() })));
  console.log('  home after free chip:', JSON.stringify(homeCards));
  ok('home catalog card visible', homeCards.length > 0 && Number(homeCards[0].op) > 0.9, homeCards);

  await browser.close();
  console.log('\nREVEAL-REAL: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });

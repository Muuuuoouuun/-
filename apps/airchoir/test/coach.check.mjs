// First-run coach in a real browser: demo voice + mouse/keyboard only, no devices or network.
// Walks every step, checks persistence/replay/dismiss, and that the card never blocks the stage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, launchOptions } from './browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('invalid path');
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}`;
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];
const stepId = (page) => page.evaluate(() => window.airchoir.coach.step?.id ?? window.airchoir.coach.phase);
const waitStep = (page, id, timeout = 10000) =>
  page.waitForFunction((id) => (window.airchoir.coach.step?.id ?? window.airchoir.coach.phase) === id, id, { timeout });

let browser;
try {
  browser = await chromium.launch(launchOptions);
  if (process.env.SHOTS) await mkdir(process.env.SHOTS, { recursive: true });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(base + '/')) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('no devices in test'), { name: 'NotAllowedError' }));
    });
    const shot = async (state) => {
      if (process.env.SHOTS) await page.screenshot({ path: resolve(process.env.SHOTS, `coach-${viewport.name}-${state}.png`) });
    };
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    assert.equal(await page.locator('#coach').isVisible(), false, 'hidden before a session');
    await page.click('#start-pointer');
    await page.waitForSelector('#coach:not([hidden])');
    assert.equal(await page.textContent('#coach-count'), '1 / 5');
    await shot('1-voice');

    // Layout: inside the stage, clear of the HUD, no horizontal overflow, 44px targets.
    const layout = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const stage = box(document.getElementById('stage'));
      const card = box(document.getElementById('coach'));
      const hud = box(document.querySelector('.hud'));
      const overlap = !(card.bottom <= hud.top || card.top >= hud.bottom || card.right <= hud.left || card.left >= hud.right);
      const buttons = [...document.querySelectorAll('#coach button')].filter((b) => !b.hidden).map((b) => b.getBoundingClientRect().height);
      return { inside: card.left >= stage.left && card.right <= stage.right && card.top >= stage.top && card.bottom <= stage.bottom,
        overlap, overflow: document.documentElement.scrollWidth - innerWidth, buttons };
    });
    assert.ok(layout.inside, `${viewport.name}: coach inside stage`);
    assert.equal(layout.overlap, false, `${viewport.name}: coach clear of HUD`);
    assert.equal(layout.overflow, 0, `${viewport.name}: no horizontal overflow`);
    assert.ok(layout.buttons.every((h) => h >= 44), `${viewport.name}: coach buttons >= 44px ${layout.buttons}`);
    assert.equal(await page.locator('#stage-empty').isVisible(), false, 'empty-stage hint yields to the coach');

    // Step 1: the demo voice sings by itself.
    await waitStep(page, 'harmony');
    // Step 2-3: mouse over the stage (away from the card) and number keys pick the chord.
    const stage = await page.locator('#stage').boundingBox();
    await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.35);
    await page.keyboard.press('1');
    await waitStep(page, 'grow');
    await shot('3-grow');
    await page.keyboard.press('4');
    await waitStep(page, 'stop');
    await page.keyboard.press('0');
    await waitStep(page, 'orb');
    // Step 5: record one bar with the button.
    await page.keyboard.press('2');
    await page.click('#record-toggle');
    await page.waitForFunction(() => window.airchoir.station.mode === 'recording', null, { timeout: 8000 });
    await page.click('#record-toggle');
    await waitStep(page, 'done', 12000);
    assert.equal(await page.textContent('#coach-count'), '완료');
    assert.equal(await page.locator('#coach-skip').isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('airchoir.coach.v1')), 'done');
    const seconds = await page.evaluate(() => window.airchoir.coach.elapsedMs / 1000);
    assert.ok(seconds < 60, `${viewport.name}: finished within a minute (${seconds.toFixed(1)}s)`);
    await shot('5-done');
    await page.click('#coach-close');
    assert.equal(await page.locator('#coach').isVisible(), false);

    // Remembered: a new session does not reopen it; replay from the help does.
    await page.click('#session-end');
    await page.click('#start-pointer');
    await page.waitForFunction(() => window.airchoir.audio.ready);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#coach').isVisible(), false, 'completed guide stays closed');
    await page.click('.help summary');
    await page.click('#coach-replay');
    await page.waitForSelector('#coach:not([hidden])');
    assert.equal(await page.textContent('#coach-count'), '1 / 5');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'coach-skip');

    // Skip never records: pointerdown inside the card stays out of the stage.
    await page.click('#coach-skip');
    assert.equal(await stepId(page), 'harmony');
    assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');
    for (let i = 0; i < 3; i++) await page.click('#coach-skip');
    assert.equal(await stepId(page), 'orb');
    assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');

    // Chord instrument and wheel input pause (hide) the guide; choir with hands resumes it.
    await page.evaluate(() => window.airchoir.performanceController.change('product', 'chord'));
    await page.waitForSelector('#coach', { state: 'hidden' });
    await page.evaluate(() => window.airchoir.performanceController.change('product', 'choir'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#coach').isVisible(), false, 'manual wheel input also pauses the guide');
    await page.evaluate(() => window.airchoir.performanceController.change('input', 'hands'));
    await page.waitForSelector('#coach:not([hidden])');
    assert.equal(await stepId(page), 'orb');

    // Dismiss is remembered separately and survives reload.
    await page.click('#coach-close');
    assert.equal(await page.locator('#coach').isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('airchoir.coach.v1')), 'dismissed');

    // Replay requested before a session starts opens it on the next start.
    await page.click('#session-end');
    await page.click('#coach-replay');
    await page.click('#start-pointer');
    await page.waitForSelector('#coach:not([hidden])');
    assert.equal(await page.textContent('#coach-count'), '1 / 5');

    assert.deepEqual(errors, [], `${viewport.name}: console errors`);
    assert.deepEqual(external, [], `${viewport.name}: external requests`);
    console.log(`${viewport.name} ${viewport.width}x${viewport.height}: coach steps/persistence/replay/dismiss/layout passed (${seconds.toFixed(1)}s guided)`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}

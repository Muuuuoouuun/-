// Offline UI + actual AudioWorklet smoke test. No camera/microphone/model requests.
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
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    // Web fonts are optional; no external HTTP request leaves this test.
    assert.ok(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url), `unexpected external request: ${url}`);
    return route.fulfill({ body: '', contentType: 'text/css' });
  });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Device access forbidden in offline check'); };
  });
  await page.goto(base);
  await page.click('#start-pointer');
  await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('st-cam').textContent === '마우스 모드');
  await page.selectOption('#bpm', '130');
  const box = await page.locator('#stage').boundingBox();
  const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
  await page.mouse.move(...at(0.3, 0.6));
  await page.mouse.down();
  await page.waitForFunction(() => window.airchoir.station.mode === 'countin');
  await page.waitForFunction(() => document.getElementById('bpm').disabled && !document.getElementById('clear-orbs').disabled);
  await page.locator('#clear-orbs').evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');
  await page.mouse.up();
  await page.waitForFunction(() => !window.airchoir.station.prev.pinch);

  await page.mouse.move(...at(0.3, 0.6));
  await page.mouse.down();
  await page.waitForFunction(() => window.airchoir.station.mode === 'recording', null, { timeout: 8000 });
  await page.mouse.up();
  await page.waitForFunction(() => window.airchoir.station.orbs[0]?.ready, null, { timeout: 8000 });
  // Move out of the stage to release the held orb in place.
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => window.airchoir.audio.orbNodes.size === 1);
  const rms = await page.evaluate(() => {
    const samples = window.airchoir.station.orbs[0].buffer.getChannelData(0);
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  });
  assert.ok(rms > 0.01, `captured audio RMS ${rms}`);
  if (process.env.SHOTS) {
    await mkdir(process.env.SHOTS, { recursive: true });
    await page.screenshot({ path: resolve(process.env.SHOTS, 'pointer-desktop.png'), fullPage: true });
  }
  await page.click('#clear-orbs');
  await page.waitForFunction(() => window.airchoir.station.count === 0 && window.airchoir.audio.orbNodes.size === 0);
  await page.setViewportSize({ width: 400, height: 860 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.SHOTS) await page.screenshot({ path: resolve(process.env.SHOTS, 'pointer-mobile.png'), fullPage: true });

  // A page restored from the back/forward cache returns to the start screen.
  const disposed = await page.evaluate(async () => {
    const ctx = window.airchoir.audio.ctx;
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    return { state: ctx.state, ready: window.airchoir.audio.ready, count: window.airchoir.station.count, start: !document.getElementById('start').hidden };
  });
  assert.deepEqual(disposed, { state: 'closed', ready: false, count: 0, start: true });
  await page.click('#start-pointer');
  await page.waitForFunction(() => window.airchoir.audio.ready);
  assert.deepEqual(errors, []);
  console.log(`Offline pointer check passed: record → loop → clear, BPM lock/cancel, page cleanup/restart, mobile layout; RMS ${rms.toFixed(3)}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

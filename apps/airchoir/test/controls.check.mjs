// Accessible studio controls, async cancellation, error recovery and responsive QA.
// Synthetic audio only: any device request is a controlled promise, never an OS request.
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
let browser;
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'compact', width: 1280, height: 800 },
];
function syntheticWav() {
  const sr = 24000, length = sr * 2, buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / sr)), 44 + i * 2);
  return buffer;
}
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
      // The first-run coach has its own check (coach.check.mjs); keep this stage clear.
      localStorage.setItem('airchoir.coach.v1', 'dismissed');
      window.pendingMedia = [];
      window.stoppedFakeTracks = 0;
      navigator.mediaDevices.getUserMedia = (constraints) => new Promise((resolve) => {
        window.pendingMedia.push({ constraints, resolve: () => resolve({ getTracks: () => [{ stop: () => window.stoppedFakeTracks++ }] }) });
      });
    });
    const shot = async (state) => {
      if (!process.env.SHOTS) return;
      if (state !== '06-input') await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.screenshot({ path: resolve(process.env.SHOTS, `${viewport.name}-${state}.png`), fullPage: false });
      await page.screenshot({ path: resolve(process.env.SHOTS, `${viewport.name}-${state}-full.png`), fullPage: true });
    };
    const checkRecordContrast = async () => {
      await page.hover('#record-toggle');
      const ratio = await page.locator('#record-toggle').evaluate((button) => {
        const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map((n) => {
          const channel = +n / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
        const style = getComputedStyle(button);
        const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      });
      assert.ok(ratio >= 4.5, `${viewport.name} record button hover contrast ${ratio.toFixed(2)}`);
    };
    await page.goto(base);
    assert.match(await page.title(), /AirChoir/);
    assert.equal(await page.evaluate(() => document.compatMode), 'CSS1Compat');
    assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
    assert.ok(await page.locator('meta[name="viewport"]').count());
    await shot('01-start');

    if (viewport.name === 'desktop') {
      // Cancel an unresolved mic permission, immediately restart, then grant the old request.
      await page.click('#start-mic');
      await page.waitForFunction(() => window.pendingMedia.length === 1);
      await page.click('#start-cancel');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'start-pointer');
      await page.click('#start-pointer');
      await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
      await page.evaluate(() => window.pendingMedia[0].resolve());
      await page.waitForFunction(() => window.stoppedFakeTracks === 1);
      assert.equal(await page.evaluate(() => window.airchoir.audio.source.kind), 'demo');
      await page.click('#session-end');
      // Repeat for pending camera startup; never resolve far enough to load a model.
      await page.click('#start-demo');
      await page.waitForFunction(() => window.pendingMedia.length === 2);
      await page.keyboard.press('Escape');
      await page.click('#start-pointer');
      await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
      await page.evaluate(() => window.pendingMedia[1].resolve());
      await page.waitForFunction(() => window.stoppedFakeTracks === 2);
      assert.equal(await page.textContent('#st-cam'), '마우스 모드');
    } else {
      await page.click('#start-pointer');
      await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
    }
    assert.equal(await page.evaluate(() => document.activeElement.id), 'record-toggle', 'started session must focus the enabled recording control');
    await page.mouse.move(1, 1);
    await page.waitForFunction(() => !document.getElementById('stage-empty').hidden);
    await shot('02-empty');
    assert.equal(await page.locator('.app-header').count(), 1);
    await checkRecordContrast();
    const visible = await page.evaluate(() => Object.fromEntries(['record-toggle', 'hud-orb', 'bpm', 'src-demo', 'key'].map((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return [id, { top: Math.round(rect.y), visible: rect.top >= 0 && rect.bottom <= innerHeight }];
    })));
    for (const id of ['record-toggle', 'hud-orb', 'bpm']) assert.equal(visible[id].visible, true, `${viewport.name} ${id} must be visible`);
    if (viewport.name !== 'mobile') for (const id of ['src-demo', 'key']) assert.equal(visible[id].visible, true, `${viewport.name} ${id} must be visible`);
    await page.selectOption('#bpm', '130');

    // Form focus must keep instrument shortcuts inactive.
    await page.focus('#dry');
    await page.keyboard.press('q');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.airchoir.audio.params.engine), 'psola');
    assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');
    await page.focus('#stage');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.airchoir.station.mode === 'countin');
    await checkRecordContrast();
    await shot('03-countin');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'record-toggle');

    const makeLoop = async (index, x = 0.5, y = 0.6, hold = false) => {
      await page.evaluate(() => scrollTo(0, 0));
      const box = await page.locator('#stage').boundingBox();
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
      await page.waitForTimeout(200);
      await page.click('#record-toggle');
      await page.waitForFunction(() => window.airchoir.station.mode === 'recording', null, { timeout: 8000 });
      await checkRecordContrast();
      if (!index) await shot('04-recording');
      // Space on the focused button must perform its native click exactly once.
      await page.keyboard.press('Space');
      if (hold) {
        await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
        await page.waitForFunction(() => window.airchoir.station.mode === 'holding' && window.airchoir.station.held?.ready, null, { timeout: 8000 });
        await page.click('#orb-place');
        const focus = await page.evaluate(() => ({ id: document.activeElement.dataset.orbId, visible: document.activeElement.getClientRects().length > 0 }));
        assert.deepEqual(focus, { id: String(index + 1), visible: true }, 'placing a held orb must restore focus to its visible selection control');
      }
      await page.waitForFunction((count) => window.airchoir.station.count === count && window.airchoir.station.orbs.at(-1).ready && window.airchoir.station.orbs.at(-1).state === 'placed', index + 1, { timeout: 8000 });
      await page.waitForFunction(() => document.getElementById('hud-orb-text').textContent.includes('재생 중'));
    };
    await makeLoop(0, viewport.name === 'desktop' ? 0.25 : 0.48, 0.6, viewport.name === 'desktop');
    await page.focus('[data-orb-id="1"]');
    const previousX = await page.evaluate(() => window.airchoir.station.orbs[0].x);
    await page.keyboard.press('ArrowRight');
    assert.ok(await page.evaluate((x) => window.airchoir.station.orbs[0].x > x, previousX));
    await page.click('#orb-mute');
    assert.equal(await page.evaluate(() => window.airchoir.station.orbs[0].muted), true);
    assert.equal(await page.textContent('#orb-mute'), '음소거 해제');
    await page.click('#orb-mute');
    assert.equal(await page.evaluate(() => window.airchoir.station.orbs[0].muted), false);
    await page.click('#record-toggle');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.airchoir.station.count), 1, 'cancel must preserve existing loop');
    if (viewport.name === 'desktop') {
      await makeLoop(1, 0.52, 0.47);
      await makeLoop(2, 0.73, 0.65);
      await page.click('[data-orb-id="2"]');
    }
    await page.evaluate(() => scrollTo(0, 0));
    await shot('05-loop');

    // A failed file selection can be corrected with the same input control.
    await page.locator('#src-file').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
    await page.waitForFunction(() => !document.getElementById('notice').hidden);
    assert.equal(await page.evaluate(() => window.airchoir.audio.source.kind), 'demo');
    assert.equal(await page.inputValue('#src-file'), '');
    const file = { name: 'synthetic-a3.wav', mimeType: 'audio/wav', buffer: syntheticWav() };
    await page.locator('#src-file').setInputFiles(file);
    await page.waitForFunction(() => window.airchoir.audio.source.kind === 'file' && document.getElementById('notice').hidden);
    assert.equal(await page.textContent('#source-name'), file.name);
    await page.locator('#src-file').setInputFiles(file);
    await page.waitForFunction(() => !document.getElementById('src-file').disabled);
    assert.equal(await page.inputValue('#src-file'), '');
    await page.locator('#input-panel').scrollIntoViewIfNeeded();
    await shot('06-input');
    await page.click('#orb-delete');
    const remaining = viewport.name === 'desktop' ? 2 : 0;
    assert.equal(await page.evaluate(() => window.airchoir.station.count), remaining);
    const ended = await page.evaluate(async () => {
      const ctx = window.airchoir.audio.ctx;
      document.getElementById('session-end').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ctx: ctx.state, count: window.airchoir.station.count, ready: window.airchoir.audio.ready, focus: document.activeElement.id };
    });
    assert.deepEqual(ended, { ctx: 'closed', count: 0, ready: false, focus: 'start-pointer' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(`${viewport.name} ${viewport.width}x${viewport.height}: controls/cancel/keyboard/loops/input recovery/session cleanup passed; ${JSON.stringify(visible)}`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

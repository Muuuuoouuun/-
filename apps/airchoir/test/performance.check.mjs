// Actual-browser performance controls regression. Existing Playwright/Chrome only.
// No physical devices, remote models, external requests, or downloaded fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, launchOptions } from './browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 8131;
const base = `http://127.0.0.1:${port}`;
const results = [];
const errors = [], external = [], mediaRequests = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, base).pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('invalid path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': {
      '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
    }[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});

const selectors = {
  product: '#performance-product', hands: '#performance-hands', input: '#performance-input',
  settings: '#wheel-settings', off: '#all-stop', wheels: '#performance-wheels',
  dialog: '#wheel-dialog', group: '#wheel-config-group', list: '#wheel-config-list',
  error: '#wheel-config-error', defaults: '#wheel-defaults', cancel: '#wheel-cancel', apply: '#wheel-apply',
};

async function check(name, action) {
  const began = performance.now();
  try {
    const detail = await action();
    results.push({ name, passed: true, milliseconds: Math.round(performance.now() - began), ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
}

async function screenshot(page, name, { fullPage = true } = {}) {
  if (!process.env.SHOTS) return;
  await mkdir(process.env.SHOTS, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.screenshot({ path: resolve(process.env.SHOTS, `performance-${name}.png`), fullPage });
}

async function performanceState(page) {
  return page.evaluate(() => {
    const { product, hands, input, config, current, armed, status } = window.airchoir.performance;
    return { product, hands, input, config, current, armed, status };
  });
}

async function openSettings(page, group) {
  // Keyboard activation avoids conflating settings-open release with the
  // separate pointer-leave release policy of a sounding manual wheel.
  await page.focus(selectors.settings);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('wheel-dialog').open);
  if (group) await page.selectOption(selectors.group, group);
}

async function closeSettings(page, button) {
  await page.click(button);
  await page.waitForFunction(() => !document.getElementById('wheel-dialog').open);
}

async function accompanimentSignal(page) {
  return page.evaluate(async () => {
    const audio = window.airchoir.audio;
    const accompaniment = audio.accompaniment;
    if (!accompaniment || accompaniment.disposed || audio.ctx?.state !== 'running') return { running: false, peak: 0, rms: 0 };
    const analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 2048;
    accompaniment.output.connect(analyser);
    try {
      await new Promise((done) => setTimeout(done, 80));
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      let peak = 0, square = 0;
      for (const value of data) { peak = Math.max(peak, Math.abs(value)); square += value * value; }
      return { running: true, peak, rms: Math.sqrt(square / data.length) };
    } finally {
      accompaniment.output.disconnect(analyser);
      analyser.disconnect();
    }
  });
}

async function assertStopped(page, { settled = true } = {}) {
  await page.waitForFunction(() => {
    const state = window.airchoir.performance;
    return !state.armed && Object.values(state.current).every((value) => value === null)
      && (window.airchoir.audio.accompaniment?.count ?? 0) === 0;
  });
  if (settled) {
    // Longer than the accompaniment release envelope; later render ticks must
    // not re-arm the last selection after its stop condition has disappeared.
    await page.waitForTimeout(180);
    const state = await performanceState(page);
    assert.equal(state.armed, false);
    assert.ok(Object.values(state.current).every((value) => value === null));
    assert.equal(await page.evaluate(() => window.airchoir.audio.accompaniment?.count ?? 0), 0);
    const signal = await accompanimentSignal(page);
    assert.ok(signal.peak < 0.0001, `released accompaniment must be silent after its tail; peak ${signal.peak}`);
  }
}

async function chooseChord(page) {
  await page.locator('.wheel-choice[data-wheel-type="chord"][data-value="0:maj"]').click();
  await page.waitForFunction(() => window.airchoir.audio.accompaniment?.count === 3);
  const state = await performanceState(page);
  assert.deepEqual(state.current.chord, { root: 0, quality: 'maj' });
  assert.equal(state.armed, true);
  // Independent known C3 major chord, not recomputed with the implementation.
  assert.deepEqual(await page.evaluate(() => window.airchoir.audio.accompaniment.activeVoices), [48, 52, 55]);
  const signal = await accompanimentSignal(page);
  assert.ok(signal.running && signal.rms > 0.001, `selected C chord must generate actual audio; RMS ${signal.rms}`);
}

async function useChordManual(page) {
  await page.selectOption(selectors.product, 'chord');
  await page.selectOption(selectors.hands, 'one');
  await page.selectOption(selectors.input, 'manual');
  await page.waitForFunction(() => window.airchoir.performance.product === 'chord'
    && window.airchoir.performance.input === 'manual');
}

const row = (page, index) => page.locator(`${selectors.list} [data-index="${index}"]`);
const configRows = (page) => page.locator(`${selectors.list} [data-index]`);
const chordKeys = (config) => config.chords.map(({ root, quality }) => `${root}:${quality}`);

async function verifySettings(page) {
  const defaults = (await performanceState(page)).config;
  assert.equal(defaults.version, 1);

  await check('settings cancellation discards draft edits and preserves the committed configuration', async () => {
    await chooseChord(page);
    await openSettings(page, 'chords');
    await assertStopped(page);
    await row(page, 0).locator('[data-action="remove"]').click();
    assert.equal(await configRows(page).count(), defaults.chords.length - 1);
    assert.deepEqual((await performanceState(page)).config, defaults);
    await closeSettings(page, selectors.cancel);
    assert.deepEqual((await performanceState(page)).config, defaults);
    await assertStopped(page);
    await openSettings(page, 'chords');
    assert.equal(await configRows(page).count(), defaults.chords.length);
    await closeSettings(page, selectors.cancel);
  });

  let customized;
  await check('settings apply preserves additions and ordering through reopen and page reload', async () => {
    await openSettings(page, 'chords');
    const labels = await page.locator(`${selectors.list} .wheel-item-label`).allTextContents();
    assert.equal(await row(page, 0).locator('[data-action="up"]').isDisabled(), true);
    await row(page, 0).locator('[data-action="down"]').click();
    const expected = structuredClone(defaults);
    [expected.chords[0], expected.chords[1]] = [expected.chords[1], expected.chords[0]];
    [labels[0], labels[1]] = [labels[1], labels[0]];
    await page.selectOption('#wheel-add-root', '1');
    await page.selectOption('#wheel-add-quality', 'maj7');
    await page.click('#wheel-add');
    expected.chords.push({ root: 1, quality: 'maj7' });
    labels.push('Dbmaj7');
    assert.deepEqual(await page.locator(`${selectors.list} .wheel-item-label`).allTextContents(), labels);
    await page.locator(selectors.list).evaluate((list) => { list.scrollTop = 0; });
    await screenshot(page, 'desktop-settings');
    await closeSettings(page, selectors.apply);
    assert.deepEqual((await performanceState(page)).config, expected);
    await assertStopped(page);
    await openSettings(page, 'chords');
    assert.equal(await configRows(page).count(), expected.chords.length);
    assert.deepEqual(await page.locator(`${selectors.list} .wheel-item-label`).allTextContents(), labels);
    await closeSettings(page, selectors.cancel);
    await page.reload();
    await page.waitForFunction(() => !!window.airchoir?.performance);
    assert.deepEqual((await performanceState(page)).config, expected);
    await assertStopped(page);
    customized = expected;
    await page.click('#start-pointer');
    await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
    await useChordManual(page);
    assert.deepEqual(await page.locator('.wheel-choice[data-wheel-type="chord"]').evaluateAll((buttons) => buttons.map((button) => button.dataset.value)), chordKeys(expected));
    await openSettings(page, 'chords');
    assert.deepEqual(await page.locator(`${selectors.list} .wheel-item-label`).allTextContents(), labels);
    await closeSettings(page, selectors.cancel);
    return { chordOrder: expected.chords };
  });

  await check('duplicate items cannot be added to any wheel', async () => {
    for (const group of ['chords', 'roots', 'qualities', 'choir']) {
      await openSettings(page, group);
      const value = customized[group][0];
      if (group === 'chords' || group === 'roots') await page.selectOption('#wheel-add-root', String(group === 'chords' ? value.root : value));
      if (group === 'chords' || group === 'qualities') await page.selectOption('#wheel-add-quality', group === 'chords' ? value.quality : value);
      if (group === 'choir') await page.selectOption('#wheel-add-choir', String(value));
      const before = await configRows(page).count();
      if (!await page.locator('#wheel-add').isDisabled()) {
        await page.click('#wheel-add');
        assert.ok((await page.locator(selectors.error).innerText()).trim(), `${group} duplicate must explain why it was rejected`);
      }
      assert.equal(await configRows(page).count(), before, `${group} duplicate must not add a row`);
      await closeSettings(page, selectors.cancel);
      assert.deepEqual((await performanceState(page)).config, customized);
    }
  });

  await check('empty configurations cannot be committed for any wheel', async () => {
    for (const group of ['chords', 'roots', 'qualities', 'choir']) {
      await openSettings(page, group);
      while (await configRows(page).count()) {
        const remove = row(page, 0).locator('[data-action="remove"]');
        if (await remove.isDisabled()) break;
        await remove.click();
      }
      const remaining = await configRows(page).count();
      if (remaining === 0) {
        if (!await page.locator(selectors.apply).isDisabled()) await page.click(selectors.apply);
        assert.equal(await page.locator(selectors.dialog).evaluate((dialog) => dialog.open), true);
        assert.ok((await page.locator(selectors.error).innerText()).trim(), `${group} empty draft must explain validation failure`);
      } else {
        assert.equal(remaining, 1, `${group} minimum-item guard must keep exactly its final item`);
        assert.equal(await row(page, 0).locator('[data-action="remove"]').isDisabled(), true);
      }
      assert.deepEqual((await performanceState(page)).config, customized);
      await closeSettings(page, selectors.cancel);
    }
  });

  await check('restoring defaults is a draft action until applied', async () => {
    await openSettings(page, 'chords');
    await page.click(selectors.defaults);
    assert.deepEqual((await performanceState(page)).config, customized);
    await closeSettings(page, selectors.cancel);
    assert.deepEqual((await performanceState(page)).config, customized);
    await openSettings(page, 'chords');
    await page.click(selectors.defaults);
    await closeSettings(page, selectors.apply);
    assert.deepEqual((await performanceState(page)).config, defaults);
    await assertStopped(page);
    await openSettings(page, 'chords');
    assert.equal(await configRows(page).count(), defaults.chords.length);
    await closeSettings(page, selectors.cancel);
  });
}

let browser, page;
let failed;
await new Promise((done, fail) => {
  server.once('error', fail);
  server.listen(port, '127.0.0.1', done);
});
try {
  browser = await chromium.launch(launchOptions);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.exposeFunction('__reportMediaRequest', (constraints) => mediaRequests.push(constraints));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      await window.__reportMediaRequest(constraints);
      throw new Error('Device access forbidden in performance check');
    };
  });
  await page.goto(base);
  await check('page identity and meaningful content', async () => {
    assert.equal(page.url(), base + '/');
    assert.match(await page.title(), /AirChoir/);
    await page.waitForFunction(() => !!window.airchoir?.performance);
    assert.equal(await page.locator(selectors.product).count(), 1);
    assert.equal(await page.locator(selectors.settings).count(), 1);
    assert.equal(await page.locator('body').innerText().then((text) => text.includes('AirChoir')), true);
  });
  await screenshot(page, 'desktop-initial');

  await check('default choir mode is one-hand only and manual chord startup requests no devices', async () => {
    const initial = await performanceState(page);
    assert.equal(initial.product, 'choir');
    assert.equal(initial.hands, 'one');
    assert.equal(initial.input, 'hands');
    assert.equal(await page.locator(`${selectors.hands} option[value="two"]`).evaluate((option) => option.disabled), true);
    await page.click('#start-pointer');
    await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
    await useChordManual(page);
    const state = await performanceState(page);
    assert.equal(state.product, 'chord');
    assert.equal(state.hands, 'one');
    assert.equal(state.input, 'manual');
    assert.equal(await page.locator('.wheel-choice[data-wheel-type="chord"]').count(), state.config.chords.length);
    assert.equal(await page.locator(`${selectors.hands} option[value="two"]`).evaluate((option) => option.disabled), false);
    await assertStopped(page);
    assert.deepEqual(mediaRequests, []);
  });

  await check('one chord wheel plays a real fixed chord and center OFF does not restart on hover', async () => {
    const tonic = await page.evaluate(() => window.airchoir.audio.params.tonic);
    await chooseChord(page);
    await screenshot(page, 'desktop-one-chord');
    await page.locator('.wheel-off').first().click();
    await assertStopped(page);
    await page.locator('.wheel-choice[data-wheel-type="chord"]').first().hover();
    await assertStopped(page);
    assert.equal(await page.evaluate(() => window.airchoir.audio.params.tonic), tonic);
  });

  await check('keyboard chord activation preserves native button behavior without starting a recording', async () => {
    await page.locator('.wheel-choice[data-wheel-type="chord"][data-value="0:maj"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.airchoir.audio.accompaniment?.count === 3);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.airchoir.audio.accompaniment.count), 3);
    assert.equal(await page.evaluate(() => window.airchoir.station.mode), 'idle');
    assert.equal(await page.evaluate(() => window.airchoir.station.count), 0);
    await page.locator('.wheel-off').first().focus();
    await page.keyboard.press('Enter');
    await assertStopped(page);
  });

  await verifySettings(page);
  await screenshot(page, 'desktop-settings-restored');

  await check('one chord to two root/quality to one-hand choir transitions release voices and retain choir key', async () => {
    const tonic = await page.evaluate(() => window.airchoir.audio.params.tonic);
    await chooseChord(page);
    await page.selectOption(selectors.hands, 'two');
    await assertStopped(page);
    assert.equal(await page.locator('.wheel-choice[data-wheel-type="chord"]').count(), 0);
    assert.equal(await page.locator('.wheel-choice[data-wheel-type="root"]').count(), (await performanceState(page)).config.roots.length);
    assert.equal(await page.locator('.wheel-choice[data-wheel-type="quality"]').count(), (await performanceState(page)).config.qualities.length);
    await page.locator('.wheel-choice[data-wheel-type="root"][data-value="5"]').click();
    assert.equal(await page.evaluate(() => window.airchoir.audio.accompaniment.count), 0, 'one half of the root/quality pair must not sound');
    await page.locator('.wheel-choice[data-wheel-type="quality"][data-value="min"]').click();
    await page.waitForFunction(() => window.airchoir.audio.accompaniment?.count === 3);
    const pair = await performanceState(page);
    assert.equal(pair.current.root, 5);
    assert.equal(pair.current.quality, 'min');
    assert.deepEqual(await page.evaluate(() => window.airchoir.audio.accompaniment.activeVoices), [53, 56, 60]);
    await screenshot(page, 'desktop-two-wheels');
    await page.selectOption(selectors.product, 'choir');
    await assertStopped(page);
    const choir = await performanceState(page);
    assert.equal(choir.hands, 'one');
    assert.equal(await page.inputValue(selectors.hands), 'one');
    assert.equal(await page.locator(`${selectors.hands} option[value="two"]`).evaluate((option) => option.disabled), true);
    const choices = await page.locator('.wheel-choice[data-wheel-type="choir"]').evaluateAll((buttons) => buttons.map((button) => +button.dataset.value));
    assert.deepEqual(choices, [1, 2, 3, 4]);
    await page.locator('.wheel-choice[data-wheel-type="choir"][data-value="1"]').click();
    assert.equal((await performanceState(page)).current.choir, 1);
    assert.equal(await page.evaluate(() => window.airchoir.audio.params.tonic), tonic);
    await screenshot(page, 'desktop-choir');
    await page.locator('.wheel-off').first().click();
    await assertStopped(page);
    await useChordManual(page);
  });

  for (const [name, stop] of [
    ['all OFF', async () => { await page.focus(selectors.off); await page.keyboard.press('Enter'); }],
    ['Escape', async () => page.keyboard.press('Escape')],
    ['window blur', async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    }],
    ['hidden document', async () => {
      // Browser DOM handler regression without switching a real user's window.
      await page.evaluate(() => {
        const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
        const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        if (hidden) Object.defineProperty(document, 'hidden', hidden); else delete document.hidden;
        if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }],
  ]) {
    await check(`${name} releases accompaniment and requires an explicit new selection`, async () => {
      await chooseChord(page);
      await stop();
      await assertStopped(page);
      await page.locator('.wheel-choice[data-wheel-type="chord"]').first().hover();
      await assertStopped(page);
      await chooseChord(page);
      await page.locator('.wheel-off').first().click();
      await assertStopped(page);
    });
  }

  await check('synthetic chord recording distinguishes wheel-only OFF from full OFF and preserves loops for explicit resume', async () => {
    await page.selectOption('#bpm', '130');
    await page.click('#record-toggle');
    // Manual wheels intentionally release on pointerleave. Start the count-in
    // first, then select the chord and hold it through actual recording time.
    await chooseChord(page);
    await page.waitForFunction(() => window.airchoir.station.mode === 'recording', null, { timeout: 8000 });
    await page.waitForTimeout(350);
    await page.click('#record-toggle');
    await page.waitForFunction(() => window.airchoir.station.orbs[0]?.ready, null, { timeout: 8000 });
    if (await page.locator('#orb-place').isVisible()) await page.click('#orb-place');
    await page.waitForFunction(() => window.airchoir.audio.orbNodes.size === 1);
    const recorded = await page.evaluate(() => {
      const orb = window.airchoir.station.orbs[0];
      const samples = orb.buffer.getChannelData(0);
      let square = 0, peak = 0;
      for (const value of samples) { square += value * value; peak = Math.max(peak, Math.abs(value)); }
      return { count: window.airchoir.station.count, frames: samples.length, sampleRate: orb.buffer.sampleRate,
        rms: Math.sqrt(square / samples.length), peak, finite: samples.every(Number.isFinite),
        source: window.airchoir.audio.source?.kind ?? null };
    });
    assert.equal(recorded.count, 1);
    assert.ok(recorded.frames > 0);
    assert.equal(recorded.finite, true);
    assert.ok(recorded.rms > 0.001, `recorded chord RMS ${recorded.rms}`);
    assert.ok(recorded.peak <= 1, `recorded chord peak ${recorded.peak}`);
    assert.equal(recorded.source, null, 'chord capture must come from accompaniment, not a demo/microphone source');
    await screenshot(page, 'desktop-recorded-chord');
    await page.evaluate(() => {
      window.__preservedOrbBuffer = window.airchoir.station.orbs[0].buffer;
      window.__preservedOrbSource = window.airchoir.audio.orbNodes.values().next().value.src;
    });
    for (const [label, release] of [
      ['center OFF', async () => page.locator('.wheel-off').first().click()],
      ['pointer leave', async () => page.mouse.move(1, 1)],
    ]) {
      await chooseChord(page);
      await release();
      await assertStopped(page);
      const loop = await page.evaluate(() => ({
        count: window.airchoir.station.count,
        nodes: window.airchoir.audio.orbNodes.size,
        muted: window.airchoir.station.orbs[0].muted,
        outputMuted: window.airchoir.audio.outputMuted,
        masterGain: window.airchoir.audio.master.gain.value,
        sameBuffer: window.airchoir.station.orbs[0].buffer === window.__preservedOrbBuffer,
        sameSource: window.airchoir.audio.orbNodes.values().next().value?.src === window.__preservedOrbSource,
      }));
      assert.deepEqual({ ...loop, masterGain: undefined }, {
        count: 1, nodes: 1, muted: false, outputMuted: false, masterGain: undefined, sameBuffer: true, sameSource: true,
      }, `${label} must leave the existing loop playing through the same source`);
      assert.ok(loop.masterGain > 0.1, `${label} must not mute the master bus`);
    }
    await chooseChord(page);
    await page.focus(selectors.off);
    await page.keyboard.press('Enter');
    await assertStopped(page);
    assert.equal(await page.evaluate(() => window.airchoir.station.count), 1);
    assert.equal(await page.evaluate(() => window.airchoir.audio.orbNodes.size), 0);
    assert.equal(await page.evaluate(() => window.airchoir.station.orbs[0].muted), true);
    await page.click('#orb-mute');
    await page.waitForFunction(() => window.airchoir.audio.orbNodes.size === 1);
    await page.click('#orb-delete');
    await page.waitForFunction(() => window.airchoir.station.count === 0 && window.airchoir.audio.orbNodes.size === 0);
    return recorded;
  });

  await check('mobile controls remain reachable without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator(selectors.settings).scrollIntoViewIfNeeded();
    await openSettings(page, 'choir');
    assert.deepEqual(await page.locator('#wheel-add-choir option').evaluateAll((options) => options.map((option) => +option.value)), [1, 2, 3, 4]);
    await page.locator(selectors.dialog).evaluate((dialog) => { dialog.scrollTop = 0; });
    await screenshot(page, 'mobile-settings', { fullPage: false });
    await page.locator(selectors.apply).scrollIntoViewIfNeeded();
    assert.equal(await page.locator(selectors.apply).evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, 'mobile settings Apply must be reachable within the viewport');
    await screenshot(page, 'mobile-settings-footer', { fullPage: false });
    await closeSettings(page, selectors.cancel);
    await page.locator('.wheel-choice[data-wheel-type="chord"][data-value="0:maj"]').scrollIntoViewIfNeeded();
    await chooseChord(page);
    await page.locator('.wheel-off').first().click();
    await assertStopped(page);
    await screenshot(page, 'mobile-wheel');
  });

  await check('session end disposes accompaniment and a new session never resumes its old notes', async () => {
    await chooseChord(page);
    await page.evaluate(() => {
      window.__endedAudio = window.airchoir.audio;
      window.__endedAccompaniment = window.airchoir.audio.accompaniment;
    });
    await page.focus('#session-end');
    assert.equal(await page.evaluate(() => window.airchoir.audio.accompaniment.count), 3);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__endedAccompaniment.disposed
      && window.__endedAccompaniment.count === 0 && !window.airchoir.audio.ready);
    await assertStopped(page);
    await page.click('#start-pointer');
    await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
    await assertStopped(page);
    await page.click('#session-end');
  });

  await check('no physical devices, external requests, or runtime errors', async () => {
    assert.deepEqual(mediaRequests, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });
} catch (error) {
  failed = error;
  if (page) await screenshot(page, 'failure').catch(() => {});
} finally {
  const version = browser ? browser.version() : null;
  await browser?.close();
  await new Promise((done) => server.close(done));
  console.log(JSON.stringify({
    suite: 'performance', browser: version, base, viewport: { width: 1440, height: 1000 },
    checks: results, mediaRequests: mediaRequests.length, externalRequests: external.length, errors,
    passed: !failed,
  }, null, 2));
}
if (failed) { console.error(failed.stack || failed.message); process.exitCode = 1; }

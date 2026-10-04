// Actual Chrome, fake camera, fixture landmarks, real WebAudio and MediaRecorder.
// No physical camera/microphone, remote models, or downloaded dependencies.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, launchOptions } from './browser.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = process.env.SHOTS ? resolve(process.env.SHOTS) : await mkdtemp(join(tmpdir(), 'airchoir-focus-'));
await mkdir(artifacts, { recursive: true });
const fixtures = JSON.parse(await readFile(join(root, 'test/fixtures/hands.json'), 'utf8'));
const results = [], errors = [], external = [], mocked = [], downloads = [], devices = [];
const observations = {};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': {
      '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json',
    }[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}/`;
const visionUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
const mockVision = `
  export class FilesetResolver { static async forVisionTasks() { return {}; } }
  export class HandLandmarker { static async createFromOptions() { return {
    detectForVideo() { window.__detectorCalls = (window.__detectorCalls || 0) + 1;
      return { landmarks: window.__testLandmarks || [] }; }, close() {} };
  } }
`;

async function check(name, action) {
  const started = performance.now();
  try {
    const detail = await action();
    results.push({ name, passed: true, milliseconds: Math.round(performance.now() - started), ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
}

async function shot(page, name) {
  if (!process.env.SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(artifacts, `focus-${name}.png`) });
}

async function state(page) {
  return page.evaluate(() => {
    const { focus, audio, performance: performanceState } = window.airchoir;
    const s = focus.recorder.state;
    return {
      active: focus.active, bodyFocus: document.body.classList.contains('is-performance-focus'),
      status: s.status, sizeBytes: s.sizeBytes, elapsedMs: s.elapsedMs,
      mime: s.mime, extension: s.extension, filename: s.filename, reason: s.reason, error: s.error,
      blobSize: s.blob?.size || 0, blobType: s.blob?.type || '', url: s.url,
      armed: performanceState.armed, voices: audio.accompaniment?.activeVoices || [],
      input: performanceState.input, handCount: performanceState.hands,
      controller: window.airchoir.performanceController.controller.state(),
      blocked: window.airchoir.performanceController.blocked,
      detectorCalls: window.__detectorCalls || 0, hasFocus: document.hasFocus(), hidden: document.hidden,
      tracks: window.__cameraTracks.map(track => track.readyState),
    };
  });
}

async function activate(page, selector) {
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector);
    return element && !element.disabled && element.getClientRects().length;
  }, selector);
  await page.focus(selector);
  assert.equal(await page.locator(selector).evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Enter');
}

async function recorderStatus(page, status) {
  await page.waitForFunction(status => window.airchoir.focus.recorder.state.status === status, status);
}

// The real video cover/mirror mapping and wheel dwell remain in the application.
// Only the detector's landmarks are replaced by stored, nondegenerate fixtures.
async function setHands(page, specs) {
  await page.evaluate(({ specs, fixtures }) => {
    const video = document.getElementById('video');
    const b = document.getElementById('stage').getBoundingClientRect();
    const geometry = window.airchoir.performanceController.ui.getWheelGeometry();
    const aspect = video.videoWidth / video.videoHeight;
    const scale = Math.max(b.width / video.videoWidth, b.height / video.videoHeight);
    const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
    const ox = (b.width - dw) / 2, oy = (b.height - dh) / 2;
    const f = fixtures.open_two_hands;
    window.__testLandmarks = specs.map(({ wheel = 0, sector = 0, count = 7, hand = 0, ratio = .76 }) => {
      const g = geometry[wheel], angle = sector * Math.PI * 2 / count;
      const point = { x: g.center.x + Math.sin(angle) * g.radius * ratio, y: g.center.y - Math.cos(angle) * g.radius * ratio };
      const target = [((b.width - (point.x - b.left)) - ox) / dw, ((point.y - b.top) - oy) / dh];
      const raw = f.hands[hand].landmarks;
      const center = [0, 1].map(k => [0, 5, 9, 13, 17].reduce((sum, i) => sum + raw[i][k], 0) / 5);
      return raw.map(q => ({ x: target[0] + (q[0] - center[0]) * (f.width / f.height) * .25 / aspect,
        y: target[1] + (q[1] - center[1]) * .25, z: q[2] * (f.width / f.height) * .25 / aspect }));
    });
  }, { specs, fixtures });
}

async function selectChord(page) {
  const calls = await page.evaluate(() => window.__detectorCalls || 0);
  await setHands(page, []);
  await page.waitForFunction(calls => window.__detectorCalls > calls
    && !window.airchoir.performanceController.blocked, calls, { timeout: 4000 });
  await setHands(page, [{ sector: 0 }]);
  await page.waitForFunction(() => window.airchoir.performance.armed, null, { timeout: 4000 });
  assert.deepEqual((await state(page)).voices, [48, 52, 55]);
}

async function enterFocus(page) {
  if (!(await state(page)).active) await activate(page, '#focus-enter');
  await page.waitForFunction(() => window.airchoir.focus.active && document.body.classList.contains('is-performance-focus'));
}

async function beginRecording(page) {
  await enterFocus(page);
  await activate(page, '#focus-record');
  await recorderStatus(page, 'recording');
}

async function discard(page) {
  await activate(page, '#focus-result-discard');
  await recorderStatus(page, 'idle');
  assert.equal((await state(page)).blobSize, 0);
}

async function startCamera(page) {
  await page.selectOption('#performance-product', 'chord');
  await page.selectOption('#performance-input', 'hands');
  await page.click('#start-demo');
  await page.waitForFunction(() => window.airchoir.audio.ready && window.__detectorCalls > 3
    && document.getElementById('start').hidden && window.airchoir.focus.active);
}

async function inspectMedia(path) {
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
    '-show_packets', '-show_entries', 'packet=pts_time,duration_time:stream=codec_type,codec_name,width,height,duration:format=format_name,duration',
    '-of', 'json', path], { maxBuffer: 8 * 1024 * 1024 })).stdout);
  const video = probe.streams.filter(stream => stream.codec_type === 'video');
  const audio = probe.streams.filter(stream => stream.codec_type === 'audio');
  assert.equal(video.length, 1, 'Downloaded recording must contain exactly one video stream');
  assert.equal(audio.length, 1, 'Downloaded recording must contain exactly one audio stream');
  assert.ok(video[0].width > 0 && video[0].height > 0);
  const end = Math.max(...probe.packets.map(packet => (+packet.pts_time || 0) + (+packet.duration_time || 0)));
  const duration = +probe.format.duration || end;
  assert.ok(duration >= 1 && duration < 30, `Invalid recorded duration ${duration}`);
  const decoded = (await exec('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '16000',
    '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout;
  let square = 0, peak = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    const value = decoded.readFloatLE(i);
    assert.ok(Number.isFinite(value), 'Decoded audio must be finite');
    square += value * value; peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(square / (decoded.length / 4));
  assert.ok(rms > .001, `Recorded accompaniment is unexpectedly silent: ${rms}`);
  assert.ok(peak <= 1.01, `Recorded audio clips: ${peak}`);
  return { streams: probe.streams, container: probe.format.format_name, duration, rms, peak };
}

async function captureReference(page) {
  const reference = await page.evaluate(() => {
    const { focus, performanceController } = window.airchoir;
    const canvas = focus.capture.canvas;
    const stage = document.getElementById('stage'), video = document.getElementById('video');
    const box = stage.getBoundingClientRect();
    const rect = { left: box.left + stage.clientLeft, top: box.top + stage.clientTop,
      width: stage.clientWidth, height: stage.clientHeight };
    const W = canvas.width, H = canvas.height, header = W < 620 ? 48 : 34, footer = 28;
    const scale = Math.min(W / rect.width, Math.max(1, H - header - footer) / rect.height);
    const x = (W - rect.width * scale) / 2, y = header + (H - header - footer - rect.height * scale) / 2;
    const baseline = document.createElement('canvas'); baseline.width = W; baseline.height = H;
    const g = baseline.getContext('2d'); g.fillStyle = '#111512'; g.fillRect(0, 0, W, H);
    g.translate(x, y); g.scale(scale, scale); g.translate(rect.width, 0); g.scale(-1, 1);
    const cover = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const sw = rect.width / cover, sh = rect.height / cover;
    g.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, rect.width, rect.height);
    return { width: W, height: H, elapsedMs: focus.recorder.state.elapsedMs,
      reference: canvas.toDataURL('image/png'), camera: baseline.toDataURL('image/png'),
      stage: { x, y, width: rect.width * scale, height: rect.height * scale },
      wheels: performanceController.ui.getWheelGeometry().map(wheel => ({
        x: x + (wheel.center.x - rect.left) * scale,
        y: y + (wheel.center.y - rect.top) * scale, radius: wheel.radius * scale,
      })),
    };
  });
  for (const name of ['reference', 'camera']) {
    await writeFile(join(artifacts, `focus-${name}.png`), Buffer.from(reference[name].split(',')[1], 'base64'));
    delete reference[name];
  }
  return reference;
}

async function inspectPixels(path, reference) {
  const raw = async (input, args = []) => (await exec('ffmpeg', ['-v', 'error', ...args, '-i', input,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout;
  const [frame, expected, camera] = await Promise.all([
    raw(path, ['-ss', String(Math.max(.1, reference.elapsedMs / 1000))]),
    raw(join(artifacts, 'focus-reference.png')), raw(join(artifacts, 'focus-camera.png')),
  ]);
  const { width, height, wheels, stage } = reference;
  assert.equal(frame.length, width * height * 3);
  assert.equal(expected.length, frame.length); assert.equal(camera.length, frame.length);
  const sums = { wheel: { n: 0, encoded: 0, overlay: 0 }, camera: { n: 0, encoded: 0, overlay: 0 } };
  for (let y = Math.ceil(stage.y + 4); y < stage.y + stage.height - 4; y++) {
    for (let x = Math.ceil(stage.x + 4); x < stage.x + stage.width - 4; x++) {
      const inside = wheels.some(w => Math.hypot(x - w.x, y - w.y) < w.radius * .9);
      const nearWheel = wheels.some(w => Math.hypot(x - w.x, y - w.y) < w.radius * 1.2);
      if (!inside && nearWheel) continue;
      const sample = sums[inside ? 'wheel' : 'camera'];
      const offset = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        sample.encoded += Math.abs(frame[offset + c] - expected[offset + c]);
        sample.overlay += Math.abs(expected[offset + c] - camera[offset + c]);
        sample.n++;
      }
    }
  }
  const metrics = Object.fromEntries(Object.entries(sums).map(([key, value]) => [key,
    { pixels: value.n / 3, encodedMeanError: value.encoded / value.n, overlayMeanDifference: value.overlay / value.n }]));
  assert.ok(metrics.wheel.pixels > 1000 && metrics.camera.pixels > 1000);
  assert.ok(metrics.wheel.overlayMeanDifference > 12, 'Compositor must draw widgets over the camera');
  assert.ok(metrics.wheel.encodedMeanError < 20, 'Downloaded video must contain the composited wheel');
  assert.ok(metrics.camera.encodedMeanError < 30, 'Downloaded video must retain the camera image');
  assert.ok(metrics.camera.overlayMeanDifference < 12, 'Independent cover/mirror camera reference must match outside widgets');
  await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(.1, reference.elapsedMs / 1000)), '-i', path,
    '-frames:v', '1', join(artifacts, 'focus-decoded-frame.png')]);
  return metrics;
}

let browser, page;
let failed;
try {
  browser = await chromium.launch({ ...launchOptions, args: [...launchOptions.args,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] });
  observations.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.stack || String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('download', download => downloads.push(download));
  await page.exposeFunction('__reportDeviceRequest', constraints => devices.push(constraints));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url === visionUrl) {
      mocked.push(url);
      return route.fulfill({ body: mockVision, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
    }
    external.push(url); return route.abort();
  });
  await page.addInitScript(() => {
    window.__cameraTracks = []; window.__testLandmarks = [];
    window.__recordingClones = []; window.__canvasTracks = [];
    const clone = MediaStreamTrack.prototype.clone;
    MediaStreamTrack.prototype.clone = function() {
      const track = clone.call(this);
      window.__recordingClones.push({ source: this, clone: track });
      return track;
    };
    const capture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function(...args) {
      const stream = capture.apply(this, args);
      window.__canvasTracks.push(...stream.getTracks());
      return stream;
    };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      await window.__reportDeviceRequest(constraints);
      if (constraints.audio || !constraints.video) throw new Error('Only the Chrome fake video device is allowed');
      const stream = await get(constraints); window.__cameraTracks.push(...stream.getTracks()); return stream;
    };
  });
  await page.goto(base + '#cpu');
  await page.waitForFunction(() => !!window.airchoir?.focus);

  await check('Chrome provides native canvas capture and a supported recording MIME', async () => {
    const capability = await page.evaluate(() => ({
      captureStream: typeof HTMLCanvasElement.prototype.captureStream,
      mediaRecorder: typeof MediaRecorder,
      supported: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        .filter(type => MediaRecorder.isTypeSupported(type)),
    }));
    assert.equal(capability.captureStream, 'function');
    assert.equal(capability.mediaRecorder, 'function');
    assert.ok(capability.supported.length > 0);
    return capability;
  });

  await check('pointer startup keeps the workspace and cannot record without a live camera', async () => {
    await page.selectOption('#performance-product', 'chord');
    await page.click('#start-pointer');
    await page.waitForFunction(() => window.airchoir.audio.ready && document.getElementById('start').hidden);
    assert.equal((await state(page)).active, false);
    await enterFocus(page);
    assert.equal(await page.locator('#focus-record').isDisabled(), true);
    assert.equal(devices.length, 0);
    await activate(page, '#focus-exit');
    await page.click('#session-end');
    await page.waitForFunction(() => !window.airchoir.audio.ready);
  });

  await check('fake camera startup enters focus and preserves the real camera-to-chord pipeline', async () => {
    await startCamera(page);
    await selectChord(page);
    assert.equal((await state(page)).bodyFocus, true);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].audio, false);
    await shot(page, 'desktop-live');
  });

  await check('Space on the focused stage never starts the hidden loop recorder', async () => {
    await page.focus('#stage');
    assert.equal(await page.locator('#stage').evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => ({
      mode: window.airchoir.station.mode, loops: window.airchoir.station.count,
      video: window.airchoir.focus.recorder.state.status,
    })), { mode: 'idle', loops: 0, video: 'idle' });
  });

  await check('native recorder continues through hand loss, then yields an explicit downloadable audiovisual result', async () => {
    await beginRecording(page);
    await selectChord(page);
    await page.waitForTimeout(650);
    await setHands(page, []);
    await page.waitForFunction(() => !window.airchoir.performance.armed);
    assert.equal((await state(page)).status, 'recording', 'Hand loss must not stop the video recording');
    assert.deepEqual((await state(page)).voices, []);
    await selectChord(page);
    await page.waitForTimeout(650);
    const reference = await captureReference(page);
    assert.ok((await state(page)).elapsedMs >= 1000, 'The recorder timer must advance in the real browser');
    assert.ok((await state(page)).sizeBytes > 0, 'The native recorder must deliver data while recording');
    await shot(page, 'desktop-recording');
    await activate(page, '#focus-record');
    await recorderStatus(page, 'ready');
    const recorded = await state(page);
    assert.ok(recorded.blobSize > 1024);
    const tracks = await page.evaluate(() => ({
      clones: window.__recordingClones.map(pair => ({ distinct: pair.source.id !== pair.clone.id,
        source: pair.source.readyState, clone: pair.clone.readyState })),
      canvas: window.__canvasTracks.map(track => track.readyState),
    }));
    assert.ok(tracks.clones.length > 0);
    assert.equal(tracks.clones.every(track => track.distinct && track.source === 'live' && track.clone === 'ended'), true);
    assert.equal(tracks.canvas.every(track => track === 'ended'), true);
    assert.equal(downloads.length, 0, 'Stopping must never auto-download');
    assert.equal(await page.locator('#focus-record').isDisabled(), true, 'A completed result must not be silently overwritten');
    const pending = page.waitForEvent('download');
    await activate(page, '#focus-result-download');
    const download = await pending;
    const filename = download.suggestedFilename();
    assert.ok(filename.endsWith('.' + recorded.extension));
    if (recorded.mime.startsWith('video/webm')) assert.equal(recorded.extension, 'webm');
    if (recorded.mime.startsWith('video/mp4')) assert.equal(recorded.extension, 'mp4');
    const path = join(artifacts, `focus-recording.${recorded.extension}`);
    await download.saveAs(path);
    const media = await inspectMedia(path);
    const pixels = await inspectPixels(path, reference);
    if (recorded.extension === 'webm') assert.match(media.container, /webm/);
    if (recorded.extension === 'mp4') assert.match(media.container, /mp4/);
    observations.recording = { ...recorded, url: '[local blob URL]', path, ...media, pixels };
    await shot(page, 'desktop-result');
    return { filename, bytes: recorded.blobSize, ...media, pixels };
  });

  await check('preview playback stops live sound and global stop, blur and hidden pause the preview without deleting it', async () => {
    const before = await state(page);
    for (const action of [
      () => activate(page, '#focus-all-stop'),
      () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
      () => page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }),
    ]) {
      // Drive the actual HTML media element's explicit play API; no autoplay.
      await page.evaluate(() => document.getElementById('focus-result-video').play());
      await page.waitForFunction(() => !document.getElementById('focus-result-video').paused);
      assert.equal((await state(page)).armed, false);
      await action();
      await page.waitForFunction(() => document.getElementById('focus-result-video').paused);
      assert.equal((await state(page)).blobSize, before.blobSize);
      await page.evaluate(() => {
        delete document.hidden; delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));
      });
    }
  });

  await check('Space on the native video preview toggles playback without recording a loop', async () => {
    await page.evaluate(() => { const video = document.getElementById('focus-result-video'); video.pause(); video.currentTime = 0; });
    await page.focus('#focus-result-video');
    assert.equal(await page.locator('#focus-result-video').evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.getElementById('focus-result-video').paused, null, { timeout: 2000 });
    assert.deepEqual(await page.evaluate(() => ({ mode: window.airchoir.station.mode, count: window.airchoir.station.count })),
      { mode: 'idle', count: 0 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('focus-result-video').paused, null, { timeout: 2000 });
    await discard(page);
  });

  await check('visible quick mode buttons finalize recording, retain the clip, and keep choir one-hand with its demo source named', async () => {
    await beginRecording(page); await selectChord(page); await page.waitForTimeout(650);
    await activate(page, '#focus-mode-chord-two');
    await recorderStatus(page, 'ready');
    const clip = await state(page);
    assert.ok(clip.blobSize > 0);
    assert.equal(clip.reason, 'mode-change');
    assert.equal(clip.handCount, 'two');
    assert.equal(clip.armed, false);
    assert.equal(await page.locator('#focus-mode-chord-two').getAttribute('aria-pressed'), 'true');
    await activate(page, '#focus-mode-choir');
    await page.waitForFunction(() => window.airchoir.audio.source?.kind === 'demo'
      && document.getElementById('focus-source').textContent.includes('목소리 데모'));
    assert.deepEqual(await page.evaluate(() => ({
      product: window.airchoir.performance.product, hands: window.airchoir.performance.hands,
      twoDisabled: document.querySelector('#performance-hands option[value="two"]').disabled,
    })), { product: 'choir', hands: 'one', twoDisabled: true });
    assert.equal(await page.locator('#focus-mode-choir').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#focus-source').isVisible(), true);
    assert.equal((await state(page)).blobSize, clip.blobSize);
    assert.equal((await state(page)).url, clip.url);
    await shot(page, 'desktop-choir-source');
    assert.equal(downloads.length, 1);
    await discard(page);

    // Choir -> two-hand chord performs two ordinary Performance.change calls.
    // Observe the real callback after UI rendering to verify one final result
    // and disabled controls while the native recorder supplies its last chunk.
    await page.evaluate(() => {
      const recorder = window.airchoir.focus.recorder;
      window.__focusTransitions = [];
      window.__originalRecorderOnChange = recorder.onChange;
      recorder.onChange = state => {
        window.__originalRecorderOnChange(state);
        window.__focusTransitions.push({ status: state.status,
          modeDisabled: [...document.querySelectorAll('.focus-mode-switch button')].every(button => button.disabled),
          inputDisabled: document.getElementById('focus-input').disabled });
      };
    });
    await beginRecording(page); await page.waitForTimeout(650);
    await activate(page, '#focus-mode-chord-two');
    await recorderStatus(page, 'ready');
    const transition = await page.evaluate(() => {
      window.airchoir.focus.recorder.onChange = window.__originalRecorderOnChange;
      return window.__focusTransitions;
    });
    assert.equal(transition.filter(item => item.status === 'ready').length, 1);
    assert.ok(transition.some(item => item.status === 'stopping' && item.modeDisabled && item.inputDisabled));
    assert.equal((await state(page)).handCount, 'two');
    assert.ok((await state(page)).blobSize > 0);
    await discard(page);
    await activate(page, '#focus-mode-chord-one');
    await page.selectOption('#focus-input', 'hands');
    assert.equal((await state(page)).handCount, 'one');
  });

  await check('the visible focus input selector finalizes recording and keeps its clip through subsequent input changes', async () => {
    await beginRecording(page); await selectChord(page); await page.waitForTimeout(650);
    await page.selectOption('#focus-input', 'manual');
    await recorderStatus(page, 'ready');
    const clip = await state(page);
    assert.ok(clip.blobSize > 0);
    assert.equal(clip.input, 'manual'); assert.equal(clip.armed, false);
    assert.equal(clip.reason, 'mode-change');
    assert.equal(await page.locator('#focus-input').inputValue(), 'manual');
    await page.selectOption('#focus-input', 'hands');
    assert.equal((await state(page)).input, 'hands');
    assert.equal((await state(page)).blobSize, clip.blobSize);
    assert.equal((await state(page)).url, clip.url);
    assert.equal(downloads.length, 1);
    await discard(page);
  });

  await check('leaving a recording focus session preserves the existing recorded loop buffer', async () => {
    await activate(page, '#focus-exit');
    await page.waitForFunction(() => !window.airchoir.focus.active);
    await page.selectOption('#bpm', '130');
    await page.click('#record-toggle');
    await selectChord(page);
    await page.waitForFunction(() => window.airchoir.station.mode === 'recording', null, { timeout: 8000 });
    await page.waitForTimeout(350);
    await page.click('#record-toggle');
    await page.waitForFunction(() => window.airchoir.station.orbs[0]?.ready, null, { timeout: 8000 });
    if (await page.locator('#orb-place').isVisible()) await page.click('#orb-place');
    await page.waitForFunction(() => window.airchoir.audio.orbNodes.size === 1);
    await page.evaluate(() => {
      window.__focusSavedOrb = window.airchoir.station.orbs[0];
      window.__focusSavedBuffer = window.__focusSavedOrb.buffer;
    });
    await beginRecording(page); await selectChord(page); await page.waitForTimeout(650);
    await activate(page, '#focus-exit');
    await recorderStatus(page, 'ready');
    const preserved = await page.evaluate(() => ({
      count: window.airchoir.station.count,
      sameOrb: window.airchoir.station.orbs[0] === window.__focusSavedOrb,
      sameBuffer: window.airchoir.station.orbs[0].buffer === window.__focusSavedBuffer,
      frames: window.airchoir.station.orbs[0].buffer.length,
      nodes: window.airchoir.audio.orbNodes.size,
      muted: window.airchoir.station.orbs[0].muted,
    }));
    assert.deepEqual({ ...preserved, frames: undefined }, {
      count: 1, sameOrb: true, sameBuffer: true, frames: undefined, nodes: 0, muted: true,
    });
    assert.ok(preserved.frames > 0);
    await discard(page); await page.click('#clear-orbs');
    return preserved;
  });

  const boundaries = [
    ['focus exit', async () => {
      await activate(page, '#focus-exit');
      await page.waitForFunction(() => !window.airchoir.focus.active);
    }],
    ['settings', async () => {
      await activate(page, '#focus-settings');
      await page.waitForFunction(() => document.getElementById('wheel-dialog').open);
    }],
    ['mode change', () => activate(page, '#focus-mode-chord-two')],
    ['window blur', () => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
    ['hidden document', () => page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    })],
  ];
  for (const [label, action] of boundaries) {
    await check(`${label} stops recording, preserves its result and keeps session source tracks alive`, async () => {
      await enterFocus(page);
      await activate(page, '#focus-mode-chord-one');
      await beginRecording(page);
      await selectChord(page);
      await page.waitForTimeout(650);
      const downloadCount = downloads.length;
      await action();
      await recorderStatus(page, 'ready');
      const s = await state(page);
      assert.ok(s.blobSize > 0);
      assert.equal(downloads.length, downloadCount);
      assert.equal(s.tracks.every(track => track === 'live'), true);
      assert.equal(await page.evaluate(() => window.airchoir.audio.getRecordingStream().getAudioTracks()
        .every(track => track.readyState === 'live')), true, 'Recorder must preserve the shared audio source');
      await page.evaluate(() => {
        delete document.hidden; delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));
      });
      if (await page.locator('#wheel-dialog').evaluate(dialog => dialog.open)) await page.click('#wheel-cancel');
      await discard(page);
      return { reason: s.reason, bytes: s.blobSize, tracks: s.tracks };
    });
  }

  await check('camera track loss finalizes the recording without downloading or discarding it', async () => {
    await activate(page, '#focus-mode-chord-one');
    await beginRecording(page); await selectChord(page); await page.waitForTimeout(650);
    await page.evaluate(() => document.getElementById('video').srcObject.getVideoTracks().forEach(track => track.stop()));
    await recorderStatus(page, 'ready');
    assert.ok((await state(page)).blobSize > 0);
    assert.equal(downloads.length, 1);
    await discard(page);
    if ((await state(page)).active) await activate(page, '#focus-exit');
    await page.click('#session-end');
    await page.waitForFunction(() => !window.airchoir.audio.ready);
  });

  await check('session end preserves the final clip while closing its original camera and audio', async () => {
    await startCamera(page); await beginRecording(page); await selectChord(page); await page.waitForTimeout(650);
    await page.evaluate(() => { window.__endingContext = window.airchoir.audio.ctx; });
    // End the actual session while recording; focus hides the workspace button.
    await page.evaluate(() => document.getElementById('session-end').click());
    await recorderStatus(page, 'ready');
    await page.waitForFunction(() => window.__endingContext.state === 'closed'
      && window.__cameraTracks.every(track => track.readyState === 'ended'));
    assert.ok((await state(page)).blobSize > 0);
    assert.equal((await state(page)).active, false);
    assert.equal(downloads.length, 1);
    await shot(page, 'session-ended-preserved');
    await discard(page);
  });

  await check('mobile focus keeps recording controls reachable without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startCamera(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const selector of ['#focus-mode-chord-one', '#focus-mode-chord-two', '#focus-mode-choir', '#focus-input',
      '#focus-settings', '#focus-exit', '#focus-record', '#focus-all-stop']) {
      assert.equal(await page.locator(selector).evaluate(button => {
        const r = button.getBoundingClientRect(); return r.width > 0 && r.height > 0
          && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), true, `${selector} must be visible in the mobile viewport`);
    }
    await shot(page, 'mobile-live');
    await activate(page, '#focus-exit'); await page.click('#session-end');
  });

  await check('all requests stay local or fixture-backed and no microphone is requested', async () => {
    assert.equal(devices.every(constraints => constraints.video && constraints.audio === false), true);
    assert.equal(external.length, 0, external.join('\n'));
    assert.equal(errors.length, 0, errors.join('\n'));
  });
} catch (error) {
  failed = error;
  if (page) observations.failureState = await state(page).catch(() => null);
  if (page) await shot(page, 'failure').catch(() => {});
} finally {
  observations.deviceRequests = devices;
  observations.mockedModelModules = mocked.length;
  observations.downloads = downloads.length;
  const report = { suite: 'focus', boundary: 'Actual Chrome fake camera and real app audio/MediaRecorder; fixture landmark detector; no real devices, model, or external network',
    passed: !failed, checks: results, observations, errors, externalRequests: external };
  await writeFile(join(artifacts, 'focus-results.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise(done => server.close(done));
  console.log(JSON.stringify(report, null, 2));
}
if (failed) { console.error(failed.stack); process.exitCode = 1; }

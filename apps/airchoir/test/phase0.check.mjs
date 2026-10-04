// 헤드리스 Chromium으로 실제 페이지를 띄워 확인한다.
// 실행: node test/phase0.check.mjs  (apps/airchoir 폴더에서, 8123 포트 사용)
import { chromium, launchOptions } from './browser.mjs';
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const server = spawn('python3', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
let browser;
const errors = [];
let failed = false;
try {
  browser = await chromium.launch({
    ...launchOptions,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.route('https://**/*', (route) => route.fulfill({ body: '', contentType: 'text/css' }));
  page.on('console', (m) => m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|fonts\.g|^INFO:/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:8123/phase0/index.html');
  await page.click('#src-demo');
  const seen = { notes: new Set(), chips: new Set() };
  for (const engine of ['granular', 'psola', 'synth']) {
    await page.click(`[data-engine="${engine}"]`);
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      const note = await page.textContent('#note');
      const chips = await page.$$eval('#chips .chip:not(.idle)', (els) => els.map((e) => e.textContent));
      if (note !== '—') seen.notes.add(note);
      chips.forEach((c) => seen.chips.add(c));
    }
  }
  console.log('검출된 음:', [...seen.notes].sort().join(' '));
  console.log('화음 음:', [...seen.chips].sort().join(' '));
  console.log('총 지연:', await page.textContent('#lat-total'), '/', await page.textContent('#lat-pill'));
  await page.screenshot({ path: process.env.SHOT || 'screenshot-demo.png', fullPage: true });

  await page.click('#src-mic');
  await page.waitForTimeout(1500);
  console.log('마이크(가짜 장치) 알림:', (await page.textContent('#notice')).slice(0, 40));

  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('휴대폰 폭 가로 넘침(px):', overflow);
  if (process.env.SHOT_MOBILE) await page.screenshot({ path: process.env.SHOT_MOBILE, fullPage: true });
  if (seen.notes.size < 4 || seen.chips.size < 3 || overflow > 0) failed = true;
} finally {
  await browser?.close();
  server.kill();
}
console.log('콘솔 오류:', errors.length ? errors : '없음');
if (failed || errors.length) process.exit(1);

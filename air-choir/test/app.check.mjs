// Phase 1 앱을 헤드리스 Chromium으로 끝까지 돌려 본다.
// 가짜 카메라에 실제 손 사진(1개 → V → 편 손 → 주먹)을 순서대로 비추고, 화면이 손동작을 따라가는지 확인한다.
// 실행: node test/app.check.mjs  (air-choir 폴더에서. 처음 한 번 MediaPipe 패키지와 모델을 test/.cache에 받는다)
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CACHE = join(ROOT, 'test/.cache');
const MP = join(CACHE, 'package');
const MODEL = join(CACHE, 'hand_landmarker.task');
const VIDEO = join(CACHE, 'hands.y4m');
const IMG = 'https://storage.googleapis.com/mediapipe-assets/';
const SHOTS = process.env.SHOTS || CACHE;

mkdirSync(CACHE, { recursive: true });
if (!existsSync(MP)) execSync('npm pack @mediapipe/tasks-vision@1.0.1 && tar xzf mediapipe-tasks-vision-1.0.1.tgz', { cwd: CACHE, stdio: 'inherit' });
if (!existsSync(MODEL)) execSync(`curl -sS -o ${MODEL} https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`);
const SEQ = ['pointing_up', 'victory', 'right_hands', 'fist'];
if (!existsSync(VIDEO)) {
  for (const n of SEQ) if (!existsSync(join(CACHE, n + '.jpg'))) execSync(`curl -sS -o ${join(CACHE, n + '.jpg')} ${IMG}${n}.jpg`);
  const inputs = SEQ.map((n) => `-loop 1 -t 2.5 -i ${join(CACHE, n + '.jpg')}`).join(' ');
  const scale = SEQ.map((_, i) => `[${i}]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a,setsar=1,fps=15[s${i}]`).join(';');
  const cat = SEQ.map((_, i) => `[s${i}]`).join('') + `concat=n=${SEQ.length}:v=1:a=0,format=yuv420p[out]`;
  execSync(`ffmpeg -loglevel error -y ${inputs} -filter_complex "${scale};${cat}" -map "[out]" ${VIDEO}`);
}

const server = spawn('python3', ['-m', 'http.server', '8125'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO}`, '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
let failed = [];
const mime = (p) => (p.endsWith('.wasm') ? 'application/wasm' : p.endsWith('.task') ? 'application/octet-stream' : 'text/javascript');
async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|fonts\.g|^INFO:/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  // CDN과 모델은 로컬 사본으로 응답 (이 테스트 환경에서는 외부 접속이 막혀 있을 수 있다)
  await page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/**', (route) => {
    const rel = new URL(route.request().url()).pathname.split('@1.0.1/')[1];
    const file = join(MP, rel);
    route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': mime(file), 'access-control-allow-origin': '*' } });
  });
  await page.route('https://storage.googleapis.com/mediapipe-models/**', (route) =>
    route.fulfill({ status: 200, body: readFileSync(MODEL), headers: { 'content-type': mime(MODEL), 'access-control-allow-origin': '*' } }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', headers: { 'content-type': 'text/css' } }));
  return page;
}

try {
  // 1) 카메라 + 데모 노래
  const page = await newPage({ width: 1366, height: 860 });
  await page.goto('http://localhost:8125/index.html#cpu');
  await page.screenshot({ path: join(SHOTS, 'app-start.png') });
  await page.click('#start-demo');
  await page.waitForFunction(() => /fps/.test(document.getElementById('st-cam').textContent), null, { timeout: 60000 });
  const seen = new Set();
  let shot = false;
  const t0 = Date.now();
  const readHud = () => page.evaluate(() => ({
    preset: document.getElementById('hud-preset').textContent,
    note: document.getElementById('hud-note').textContent,
    chips: [...document.querySelectorAll('#hud-chips .chip:not(.idle)')].map((c) => c.textContent),
  }));
  while (Date.now() - t0 < 14000) {
    await page.waitForTimeout(150);
    const hud = await readHud(); // 한 번에 읽어야 칸끼리 시점이 어긋나지 않는다
    seen.add(hud.preset);
    if (process.env.DEBUG) console.log(((Date.now() - t0) / 1000).toFixed(1), hud);
    if (!shot && hud.preset.startsWith('2개') && hud.chips.length === 2) {
      await page.screenshot({ path: join(SHOTS, 'app-victory.png') });
      shot = true;
    }
  }
  console.log('카메라 상태:', await page.textContent('#st-cam'));
  console.log('보인 손동작:', [...seen].join(' | '));
  for (const want of ['1개', '2개', '5개', '주먹']) if (![...seen].some((s) => s.startsWith(want))) failed.push(`손동작 "${want}" 인식 안 됨`);
  if (!shot) failed.push('V 손동작에서 화음 2개가 보이지 않음');

  // 2) 마우스 모드
  const p2 = await newPage({ width: 1280, height: 820 });
  await p2.goto('http://localhost:8125/index.html');
  await p2.click('#start-pointer');
  const box = await p2.locator('#stage').boundingBox();
  await p2.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await p2.keyboard.press('3');
  await p2.waitForTimeout(800);
  const pPreset = await p2.textContent('#hud-preset');
  console.log('마우스 모드 손동작:', pPreset, '/', await p2.textContent('#st-cam'));
  if (!pPreset.startsWith('3개')) failed.push('마우스 모드에서 3개가 반영되지 않음');
  await p2.keyboard.press('0');
  await p2.waitForTimeout(400);
  if (!(await p2.textContent('#hud-preset')).includes('정지')) failed.push('마우스 모드 주먹(0) 정지 안 됨');

  // 3) 휴대폰 폭
  await p2.setViewportSize({ width: 400, height: 860 });
  await p2.keyboard.press('2');
  await p2.waitForTimeout(500);
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('휴대폰 폭 가로 넘침(px):', overflow);
  await p2.screenshot({ path: join(SHOTS, 'app-mobile.png'), fullPage: true });
  if (overflow > 0) failed.push('휴대폰 폭에서 가로로 넘침');
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) failed.push('콘솔 오류: ' + errors.join(' / '));
console.log(failed.length ? '실패:\n- ' + failed.join('\n- ') : '모두 통과');
process.exit(failed.length ? 1 : 0);

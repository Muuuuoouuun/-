// 장치 권한·모델 다운로드 없이 카메라 시작/취소/정리를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HandCamera } from '../src/hands.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setGlobal(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  });
}

function fakeStream() {
  const track = { stopped: 0, stop() { this.stopped++; } };
  return { track, getTracks: () => [track] };
}

function fakeVideo() {
  let next = 1;
  const callbacks = new Map();
  return {
    srcObject: null, readyState: 2, currentTime: 1, videoWidth: 1280, videoHeight: 720,
    async play() {}, pause() {}, callbacks, canceled: [],
    requestVideoFrameCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { this.canceled.push(id); callbacks.delete(id); },
  };
}

test('video.play 실패는 열린 카메라 트랙과 영상 연결을 정리한다', async (t) => {
  const stream = fakeStream();
  setGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream } });
  const video = fakeVideo();
  const error = new Error('playback denied');
  video.play = async () => { throw error; };
  const camera = new HandCamera(video);
  await assert.rejects(camera.startCamera(), error);
  assert.equal(stream.track.stopped, 1);
  assert.equal(camera.stream, null);
  assert.equal(video.srcObject, null);
});

test('권한 응답을 기다리다 중지하면 늦게 도착한 스트림도 즉시 닫는다', async (t) => {
  const request = deferred();
  const stream = fakeStream();
  setGlobal(t, 'navigator', { mediaDevices: { getUserMedia: () => request.promise } });
  const video = fakeVideo();
  let played = 0;
  video.play = async () => { played++; };
  const camera = new HandCamera(video);
  const pending = camera.startCamera();
  camera.stop();
  request.resolve(stream);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stream.track.stopped, 1);
  assert.equal(played, 0);
  assert.equal(camera.stream, null);
  assert.equal(video.srcObject, null);
});

test('새 카메라 시작 뒤 이전 요청이 끝나도 새 스트림을 덮지 않는다', async (t) => {
  const requests = [deferred(), deferred()];
  const first = fakeStream(), second = fakeStream();
  let index = 0;
  setGlobal(t, 'navigator', { mediaDevices: { getUserMedia: () => requests[index++].promise } });
  const video = fakeVideo();
  const camera = new HandCamera(video);
  const old = camera.startCamera();
  const current = camera.startCamera();
  requests[1].resolve(second);
  await current;
  requests[0].resolve(first);
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(first.track.stopped, 1);
  assert.equal(second.track.stopped, 0);
  assert.equal(video.srcObject, second);
  camera.stop();
  assert.equal(second.track.stopped, 1);
});

test('video.play 대기 중 중지해도 완료 시 카메라가 되살아나지 않는다', async (t) => {
  const playback = deferred();
  const stream = fakeStream();
  setGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream } });
  const video = fakeVideo();
  video.play = () => playback.promise;
  const camera = new HandCamera(video);
  const pending = camera.startCamera();
  await Promise.resolve();
  assert.equal(video.srcObject, stream);
  camera.stop();
  playback.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stream.track.stopped, 1);
  assert.equal(video.srcObject, null);
});

test('중지는 예약한 영상 콜백과 모델을 한 번 정리하고 오래된 콜백을 무시한다', () => {
  const video = fakeVideo();
  const camera = new HandCamera(video);
  let closed = 0, detected = 0;
  const model = () => ({ close() { closed++; }, detectForVideo() { detected++; return { landmarks: [] }; } });
  camera.landmarker = model();
  camera.fps = 30;
  camera.run();
  camera.run();
  assert.equal(video.callbacks.size, 1);
  const oldCallback = video.callbacks.get(1);
  camera.stop();
  camera.stop();
  assert.deepEqual(video.canceled, [1]);
  assert.equal(closed, 1);
  assert.equal(camera.landmarker, null);
  assert.equal(camera.fps, 0);
  camera.landmarker = model();
  camera.run();
  oldCallback();
  assert.equal(detected, 0);
  assert.equal(video.callbacks.size, 1);
  camera.stop();
  assert.deepEqual(video.canceled, [1, 2]);
});

test('영상 콜백 미지원 환경은 animation frame 예약을 취소한다', (t) => {
  let callback;
  const canceled = [];
  setGlobal(t, 'requestAnimationFrame', (fn) => { callback = fn; return 7; });
  setGlobal(t, 'cancelAnimationFrame', (id) => canceled.push(id));
  const camera = new HandCamera({ srcObject: null });
  camera.run();
  camera.stop();
  callback();
  assert.deepEqual(canceled, [7]);
  assert.equal(camera.running, false);
});

test('손 인식 결과에서 중지하면 다음 프레임을 예약하지 않는다', () => {
  const video = fakeVideo();
  const camera = new HandCamera(video);
  camera.landmarker = { close() {}, detectForVideo: () => ({ landmarks: [] }) };
  camera.onResult = () => camera.stop();
  camera.run();
  const callback = video.callbacks.get(1);
  video.callbacks.delete(1);
  callback();
  assert.equal(video.callbacks.size, 0);
  assert.equal(camera.running, false);
});

function fakeVision(make) {
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    HandLandmarker: { createFromOptions: (_, options) => make(options.baseOptions.delegate) },
  };
}

test('중지 후 로딩이 끝난 모델은 설치하지 않고 즉시 닫는다', async (t) => {
  setGlobal(t, 'location', { hash: '#cpu' });
  const created = deferred(), started = deferred();
  let closed = 0;
  const camera = new HandCamera(fakeVideo(), { loadVision: async () => fakeVision(() => {
    started.resolve();
    return created.promise;
  }) });
  const pending = camera.loadModel();
  await started.promise;
  camera.stop();
  created.resolve({ close() { closed++; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(camera.landmarker, null);
  assert.equal(closed, 1);
});

test('취소된 GPU 모델 로딩 실패 뒤 CPU 로딩을 새로 시작하지 않는다', async (t) => {
  setGlobal(t, 'location', { hash: '' });
  const created = deferred(), started = deferred();
  const delegates = [];
  const camera = new HandCamera(fakeVideo(), { loadVision: async () => fakeVision((delegate) => {
    delegates.push(delegate);
    started.resolve();
    return created.promise;
  }) });
  const pending = camera.loadModel();
  await started.promise;
  camera.stop();
  created.reject(new Error('GPU unavailable'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(delegates, ['GPU']);
});

test('GPU 실패 시 CPU 모델로 전환하고 중지 때 정리한다', async (t) => {
  setGlobal(t, 'location', { hash: '' });
  const delegates = [];
  let closed = 0;
  const model = { close() { closed++; } };
  const camera = new HandCamera(fakeVideo(), { loadVision: async () => fakeVision(async (delegate) => {
    delegates.push(delegate);
    if (delegate === 'GPU') throw new Error('GPU unavailable');
    return model;
  }) });
  await camera.loadModel();
  assert.deepEqual(delegates, ['GPU', 'CPU']);
  assert.equal(camera.landmarker, model);
  camera.stop();
  assert.equal(closed, 1);
});

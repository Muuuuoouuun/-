// 카메라 + MediaPipe HandLandmarker. 영상은 이 기기 안에서만 처리된다.
export const MP_VERSION = '1.0.1';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandCamera {
  constructor(video, { loadVision = () => import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`) } = {}) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.onResult = null; // (landmarksList, aspect) => void
    this.fps = 0;
    this._loadVision = loadVision;
    this._generation = 0;
    this._runId = 0;
    this._frameHandle = null;
    this._frameKind = null;
  }

  async startCamera() {
    this.stop();
    const generation = this._generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (generation !== this._generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException('Camera startup canceled', 'AbortError');
    }
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (err) {
      if (this.stream === stream) this.stop();
      throw err;
    }
    if (generation !== this._generation) throw new DOMException('Camera startup canceled', 'AbortError');
  }

  async loadModel() {
    const generation = this._generation;
    const checkCurrent = () => {
      if (generation !== this._generation) throw new DOMException('Model loading canceled', 'AbortError');
    };
    const vision = await this._loadVision();
    checkCurrent();
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    checkCurrent();
    const make = (delegate) =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    // 주소 끝에 #cpu를 붙이면 GPU를 건너뛴다 (GPU 가속이 없는 환경·자동 테스트용)
    let landmarker;
    if (location.hash === '#cpu') {
      landmarker = await make('CPU');
    } else {
      try {
        landmarker = await make('GPU');
      } catch {
        checkCurrent();
        landmarker = await make('CPU');
      }
    }
    if (generation !== this._generation) {
      landmarker.close();
      checkCurrent();
    }
    this.landmarker?.close();
    this.landmarker = landmarker;
  }

  run() {
    if (this.running) return;
    this.running = true;
    const runId = ++this._runId;
    const v = this.video;
    let lastTime = -1;
    let frames = 0;
    let fpsStart = performance.now();
    const schedule = () => {
      if (!this.running || runId !== this._runId) return;
      this._frameKind = v.requestVideoFrameCallback ? 'video' : 'animation';
      this._frameHandle = this._frameKind === 'video' ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    };
    const step = () => {
      if (!this.running || runId !== this._runId) return;
      this._frameHandle = null;
      if (v.readyState >= 2 && v.currentTime !== lastTime && this.landmarker) {
        lastTime = v.currentTime;
        const res = this.landmarker.detectForVideo(v, performance.now());
        this.onResult?.(res.landmarks || [], v.videoWidth / v.videoHeight);
        frames++;
        const now = performance.now();
        if (now - fpsStart > 1000) {
          this.fps = (frames * 1000) / (now - fpsStart);
          frames = 0;
          fpsStart = now;
        }
      }
      schedule();
    };
    schedule();
  }

  stop() {
    this._generation++;
    this._runId++;
    this.running = false;
    if (this._frameHandle !== null) {
      if (this._frameKind === 'video') this.video.cancelVideoFrameCallback?.(this._frameHandle);
      else cancelAnimationFrame(this._frameHandle);
      this._frameHandle = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause?.();
    this.video.srcObject = null;
    const landmarker = this.landmarker;
    this.landmarker = null;
    landmarker?.close();
    this.fps = 0;
  }
}

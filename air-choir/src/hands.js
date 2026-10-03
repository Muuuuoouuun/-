// 카메라 + MediaPipe HandLandmarker. 영상은 이 기기 안에서만 처리된다.
export const MP_VERSION = '1.0.1';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.onResult = null; // (landmarksList, aspect) => void
    this.fps = 0;
  }

  async startCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
  }

  async loadModel() {
    const vision = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
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
    if (location.hash === '#cpu') {
      this.landmarker = await make('CPU');
      return;
    }
    try {
      this.landmarker = await make('GPU');
    } catch {
      this.landmarker = await make('CPU');
    }
  }

  run() {
    if (this.running) return;
    this.running = true;
    const v = this.video;
    let lastTime = -1;
    let frames = 0;
    let fpsStart = performance.now();
    const schedule = (fn) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(fn) : requestAnimationFrame(fn));
    const step = () => {
      if (!this.running) return;
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
      schedule(step);
    };
    schedule(step);
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

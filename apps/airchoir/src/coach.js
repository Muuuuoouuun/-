// 첫 진입 안내: 소리 내기 → 화음 → 두꺼운 화음 → 멈추기 → 첫 오브 (PLAN Phase 4)
// 화면·오디오에 의존하지 않는 순수 상태라 Node에서 테스트한다. 매 프레임 관찰값을 받아
// 조건이 잠깐 유지될 때만 다음 단계로 넘어간다(손 떨림·한 프레임 오인식으로 건너뛰지 않게).

export const COACH_KEY = 'airchoir.coach.v1';

// mode: 'camera' | 'pointer', source: 'mic' | 'demo' | 'file'
export const COACH_STEPS = [
  {
    id: 'voice', holdMs: 600,
    done: (o) => o.voiced,
    title: '소리를 들려 주세요',
    text: (o) => o.source === 'mic' ? '이어폰을 끼고 "아~" 하고 길게 불러 보세요. 입력 음에 음 이름이 나오면 다음으로 넘어가요.'
      : '데모 노래가 흘러나와요. 입력 음에 음 이름이 보이면 다음으로 넘어가요.',
  },
  {
    id: 'harmony', holdMs: 800,
    done: (o) => o.handUp && o.voiced && o.voices >= 1,
    title: '화음을 더해 보세요',
    text: (o) => o.mode === 'camera' ? '손가락 하나를 펴서 카메라에 보여 주세요. 내 목소리 위로 3도 화음이 붙어요.'
      : '무대 위로 마우스를 올리고 숫자 1 키를 눌러 보세요. 3도 화음이 붙어요.',
  },
  {
    id: 'grow', holdMs: 800,
    done: (o) => o.handUp && o.voiced && o.voices >= 3,
    title: '합창을 키워 보세요',
    text: (o) => o.mode === 'camera' ? '손가락을 3개 이상 펴 보세요. 베이스와 높은 성부까지 들어와요. 손을 올리면 커지고 내리면 작아져요.'
      : '숫자 3이나 4 키를 눌러 보세요. 베이스와 높은 성부까지 들어와요. 마우스를 위로 올리면 커져요.',
  },
  {
    id: 'stop', holdMs: 300,
    done: (o) => o.fist,
    title: '한 번에 멈춰 보세요',
    text: (o) => o.mode === 'camera' ? '주먹을 쥐면 화음이 바로 멈춰요. 다시 손가락을 펴면 이어서 불러요.'
      : '숫자 0 키를 누르면 주먹처럼 화음이 바로 멈춰요.',
  },
  {
    id: 'orb', holdMs: 0,
    done: (o) => o.orbs >= 1,
    title: '첫 오브를 만들어 보세요',
    text: (o) => o.mode === 'camera' ? '엄지와 검지를 붙인 채 한 마디 불러 보세요. 손을 떼면 마디 끝에서 오브가 생기고, 던지면 반복 재생돼요.'
      : 'Space 또는 녹음 시작을 누르고 한 마디 불러 보세요. 마디 끝에서 오브가 생기고 반복 재생돼요.',
  },
];

export const DONE_VISIBLE_MS = 9000;

function readStorage(storage) {
  try { return storage?.getItem(COACH_KEY) || null; } catch { return null; }
}

function writeStorage(storage, value) {
  try { storage?.setItem(COACH_KEY, value); return true; } catch { return false; }
}

export class Coach {
  constructor({ storage = null, steps = COACH_STEPS } = {}) {
    this.storage = storage;
    this.steps = steps;
    this.reset();
  }

  // 'done' 또는 'dismissed'가 저장돼 있으면 세션 시작 때 저절로 열지 않는다.
  get remembered() { return readStorage(this.storage); }

  reset() {
    this.phase = 'off'; // off | active | done
    this.index = 0;
    this.skipped = [];
    this.since = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.elapsedMs = 0;
    this.lastNow = null;
    this.paused = false;
    this.obs = {};
  }

  // 세션이 시작될 때. force는 '처음 안내 다시 보기'.
  begin(now, { force = false } = {}) {
    if (!force && this.remembered) return false;
    this.reset();
    this.phase = 'active';
    this.startedAt = now;
    this.lastNow = now;
    return true;
  }

  get step() { return this.phase === 'active' ? this.steps[this.index] : null; }

  // 화면에 보여 줄 때만 시간을 센다(코드 악기 모드·설정 중에는 멈춤).
  observe(o, now) {
    if (this.phase === 'done' && now - this.finishedAt > DONE_VISIBLE_MS) this.phase = 'off';
    if (this.phase !== 'active') return this.phase;
    this.obs = o;
    const dt = this.lastNow == null ? 0 : Math.max(0, Math.min(250, now - this.lastNow));
    this.lastNow = now;
    this.paused = !o.eligible;
    if (this.paused) { this.since = null; return this.phase; }
    this.elapsedMs += dt;
    // 이미 해 본 단계(예: 데모가 바로 노래함)는 지나간다. 한 프레임에 여러 단계를 넘지 않는다.
    const step = this.step;
    if (!step.done(o)) { this.since = null; return this.phase; }
    if (this.since == null) this.since = now;
    if (now - this.since >= step.holdMs) this.advance(now);
    return this.phase;
  }

  advance(now, skipped = false) {
    if (this.phase !== 'active') return;
    if (skipped) this.skipped.push(this.step.id);
    this.since = null;
    this.index++;
    if (this.index >= this.steps.length) {
      this.phase = 'done';
      this.finishedAt = now;
      writeStorage(this.storage, 'done');
    }
  }

  skip(now) { this.advance(now, true); }

  // 안내 끄기: 다음 세션부터 저절로 열지 않는다. 다시 보기는 도움말에서.
  dismiss() {
    const wasActive = this.phase === 'active';
    this.phase = 'off';
    if (wasActive) writeStorage(this.storage, 'dismissed');
  }

  view() {
    if (this.phase === 'off' || this.paused) return null;
    if (this.phase === 'done') {
      const seconds = Math.max(1, Math.round(this.elapsedMs / 1000));
      return {
        phase: 'done', index: this.steps.length, total: this.steps.length,
        title: '나만의 합창 완성!',
        text: this.skipped.length
          ? `${seconds}초 동안 둘러봤어요. 건너뛴 단계는 도움말의 '처음 안내 다시 보기'로 언제든 다시 해 볼 수 있어요.`
          : `${seconds}초 만에 화음을 쌓고 첫 오브까지 만들었어요. 오브를 더 쌓아 루프를 완성해 보세요.`,
      };
    }
    const step = this.step;
    return {
      phase: 'active', id: step.id, index: this.index, total: this.steps.length,
      title: step.title, text: step.text(this.obs),
      progress: this.since == null || !step.holdMs ? 0 : Math.min(1, (this.lastNow - this.since) / step.holdMs),
    };
  }
}

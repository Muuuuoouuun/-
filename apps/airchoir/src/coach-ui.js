// 무대 왼쪽 아래의 안내 카드. 집중 연주 화면에서도 무대와 함께 보인다.
// 바뀐 내용만 DOM에 써서 화면 읽기 프로그램이 같은 문장을 되풀이하지 않게 한다.
export class CoachUI {
  constructor({ root, onSkip, onClose }) {
    this.root = root;
    this.shown = '';
    root.innerHTML = `
      <div class="coach-head">
        <span class="coach-count" id="coach-count"></span>
        <span class="coach-dots" aria-hidden="true"></span>
      </div>
      <div class="coach-copy" aria-live="polite">
        <strong id="coach-title"></strong>
        <p id="coach-text"></p>
      </div>
      <div class="coach-hold" aria-hidden="true"><i></i></div>
      <div class="coach-actions">
        <button aria-label="이 단계 건너뛰기" class="quiet" id="coach-skip" type="button">건너뛰기</button>
        <button class="link" id="coach-close" type="button">안내 끄기</button>
      </div>`;
    this.count = root.querySelector('#coach-count');
    this.dots = root.querySelector('.coach-dots');
    this.title = root.querySelector('#coach-title');
    this.text = root.querySelector('#coach-text');
    this.hold = root.querySelector('.coach-hold i');
    this.skip = root.querySelector('#coach-skip');
    this.close = root.querySelector('#coach-close');
    this.skip.onclick = () => onSkip();
    this.close.onclick = () => onClose();
    // 마우스 모드에서 무대를 누르면 핀치(녹음)라서 카드 안의 누름은 무대로 보내지 않는다.
    root.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get visible() { return !this.root.hidden; }

  render(view) {
    this.root.hidden = !view;
    if (!view) { this.shown = ''; return; }
    const key = `${view.phase}:${view.index}:${view.title}:${view.text}`;
    if (key !== this.shown) {
      const wasFocused = this.root.contains(document.activeElement);
      this.shown = key;
      this.root.dataset.phase = view.phase;
      this.count.textContent = view.phase === 'done' ? '완료' : `${view.index + 1} / ${view.total}`;
      this.dots.replaceChildren(...Array.from({ length: view.total }, (_, i) => {
        const dot = document.createElement('i');
        dot.dataset.state = i < view.index ? 'done' : i === view.index ? 'now' : 'next';
        return dot;
      }));
      this.title.textContent = view.title;
      this.text.textContent = view.text;
      this.skip.hidden = view.phase === 'done';
      this.close.textContent = view.phase === 'done' ? '닫기' : '안내 끄기';
      // 건너뛰기로 버튼이 사라져도 키보드 위치를 카드 안에 남긴다.
      if (wasFocused && !this.root.contains(document.activeElement)) this.close.focus({ preventScroll: true });
    }
    this.hold.style.transform = `scaleX(${view.progress || 0})`;
  }
}

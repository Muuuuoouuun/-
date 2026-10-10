// 휠 항목을 키보드로 연주한다. 숫자 줄은 첫째 휠(코드·근음·합창), 아래 줄은 둘째 휠(코드 종류).
// KeyboardEvent.code(자판 위치) 기준이라 한글 입력 상태에서도 같은 자리 키로 동작한다.

export const FIRST_ROW = Object.freeze(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal']);
export const SECOND_ROW = Object.freeze(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
  'Comma', 'Period', 'Slash']);

const SYMBOLS = { Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/' };

/** 화면에 보여 줄 글자: Digit1 → 1, KeyZ → Z, Minus → - */
export function keyLabel(code) {
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Key')) return code.slice(3);
  return SYMBOLS[code] || code;
}

/** 휠 번호(0 = 첫째, 1 = 둘째)와 항목 순서의 키. 키가 모자라는 항목은 null. */
export function keyFor(wheel, index) {
  const row = wheel === 0 ? FIRST_ROW : SECOND_ROW;
  return row[index] ?? null;
}

/** 눌린 키가 몇 번째 휠의 몇 번째 항목인지. 두 손 코드가 아니면 둘째 줄은 쓰지 않는다. */
export function wheelKey(code, { product, hands }) {
  const first = FIRST_ROW.indexOf(code);
  if (first >= 0) return { wheel: 0, index: first };
  const second = SECOND_ROW.indexOf(code);
  if (second >= 0 && product === 'chord' && hands === 'two') return { wheel: 1, index: second };
  return null;
}

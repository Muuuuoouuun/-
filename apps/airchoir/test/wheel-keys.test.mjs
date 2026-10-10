import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_ROW, SECOND_ROW, keyFor, keyLabel, wheelKey } from '../src/wheel-keys.js';

test('휠 키: 숫자 줄은 첫째 휠 12칸, 아래 줄은 두 손 코드 종류 휠', () => {
  assert.equal(FIRST_ROW.length, 12);
  assert.deepEqual(FIRST_ROW.map(keyLabel), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']);
  assert.deepEqual(SECOND_ROW.map(keyLabel), ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/']);
  assert.equal(keyFor(0, 0), 'Digit1');
  assert.equal(keyFor(1, 1), 'KeyX');
  assert.equal(keyFor(0, 12), null, '13번째 항목은 키가 없다');
  assert.deepEqual(wheelKey('Digit0', { product: 'chord', hands: 'one' }), { wheel: 0, index: 9 });
  assert.deepEqual(wheelKey('KeyX', { product: 'chord', hands: 'two' }), { wheel: 1, index: 1 });
  // 둘째 줄은 두 손 코드에서만 (다른 모드의 단축키와 겹치지 않게)
  assert.equal(wheelKey('KeyX', { product: 'chord', hands: 'one' }), null);
  assert.equal(wheelKey('KeyX', { product: 'choir', hands: 'one' }), null);
  for (const code of ['KeyH', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'Space', 'Escape']) {
    assert.equal(wheelKey(code, { product: 'chord', hands: 'two' }), null, `${code}는 다른 단축키`);
  }
});

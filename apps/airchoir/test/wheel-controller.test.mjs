import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelHit, WheelController } from '../src/wheel-controller.js';

const center = { x: 1, y: 1 };
const hand = (x, y, handedness, size = 0.2) => ({ palm: { x, y }, handedness, size, pinch: true });
const pointAt = (c, angle, r = 0.7) => ({ x: c.x + Math.sin(angle) * r, y: c.y - Math.cos(angle) * r });
const handAt = (c, angle, label, r = 0.7) => ({ palm: pointAt(c, angle, r), handedness: label, pinch: true });
const oneConfig = { hands: 'one', counts: [8], centers: [center], radius: 1 };
const twoConfig = { hands: 'two', counts: [8, 4], centers: [{ x: 1, y: 1 }, { x: 4, y: 1 }], radius: 1 };
const make = (config = oneConfig) => { const controller = new WheelController(); controller.configure(config); return controller; };
const pair = (leftAngle = 0, rightAngle = 0, labelled = true) => [
  handAt(twoConfig.centers[0], leftAngle, labelled ? 'Left' : undefined),
  handAt(twoConfig.centers[1], rightAngle, labelled ? 'Right' : undefined),
];
const activate = (controller, hands, start = 0) => {
  assert.equal(controller.update(hands, start).active, false);
  return controller.update(hands, start + 150);
};

test('wheelHit: twelve o’clock centered sector zero, then clockwise, at arbitrary counts', () => {
  assert.deepEqual([0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => wheelHit(pointAt(center, a), center, 1, 4)), [0, 1, 2, 3]);
  for (const count of [1, 2, 5, 12, 24]) {
    for (let i = 0; i < count; i++) assert.equal(wheelHit(pointAt(center, i * Math.PI * 2 / count), center, 1, count), i);
  }
  assert.equal(wheelHit(pointAt(center, -0.01), center, 1, 12), 0);
});

test('wheelHit: OFF disk, outer edge and custom radial bounds', () => {
  assert.equal(wheelHit(center, center, 1, 4), null);
  assert.equal(wheelHit({ x: 25 / 48, y: 0 }, { x: 0, y: 0 }, 1, 4), null);
  assert.equal(wheelHit({ x: 1.06, y: 0 }, { x: 0, y: 0 }, 1, 4), 1);
  assert.equal(wheelHit(pointAt(center, 0, 1.061), center, 1, 4), null);
  assert.equal(wheelHit(pointAt(center, 0, 0.3), center, 1, 4, { innerRatio: 0.4, outerRatio: 1.2 }), null);
  assert.equal(wheelHit(pointAt(center, 0, 1.1), center, 1, 4, { innerRatio: 0.4, outerRatio: 1.2 }), 0);
});

test('wheelHit: visible OFF button and ring gap never select, ring begins at 25% of the wheel box', () => {
  const origin = { x: 0, y: 0 };
  // The wheel box is 100 units wide. Its circle radius is 48, while the OFF
  // button diameter is 39 and the colored ring has an inner radius of 25.
  for (const boxRadius of [0, 11.52, 19.5, 24.99, 25]) {
    assert.equal(wheelHit({ x: boxRadius, y: 0 }, origin, 48, 8), null, `OFF at ${boxRadius}`);
  }
  assert.equal(wheelHit({ x: 25.01, y: 0 }, origin, 48, 8), 2);
});

test('wheelHit: invalid values never produce a selectable index', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, '4']) assert.equal(wheelHit(pointAt(center, 0), center, 1, count), null);
  for (const radius of [0, -1, NaN, Infinity]) assert.equal(wheelHit(pointAt(center, 0), center, radius, 4), null);
  for (const point of [null, {}, { x: NaN, y: 1 }, { x: 1, y: Infinity }]) assert.equal(wheelHit(point, center, 1, 4), null);
  assert.equal(wheelHit(center, null, 1, 4), null);
  assert.equal(wheelHit(pointAt(center, 0), center, 1, 4, { innerRatio: -1 }), null);
  assert.equal(wheelHit(pointAt(center, 0), center, 1, 4, { innerRatio: 1.2, outerRatio: 1.1 }), null);
});

test('one hand: dwell needs observations, and repeat stable frames keep one committed selection', () => {
  const controller = make();
  const h = [handAt(center, 0)];
  assert.deepEqual(controller.update(h, 0).indices, [null]);
  assert.deepEqual(controller.state().candidates, [0]);
  assert.equal(controller.update(h, 149).active, false);
  assert.equal(controller.tick(150).active, false, 'clock ticks alone cannot confirm camera observations');
  assert.deepEqual(controller.update(h, 150).indices, [0]);
  for (const now of [151, 175, 230, 350]) {
    const result = controller.update(h, now);
    assert.equal(result.active, true);
    assert.equal(result.pending, false);
    assert.deepEqual(result.indices, [0]);
  }
});

test('one hand: open, missing or nonboolean pinch input never starts a chord', () => {
  for (const pinch of [false, undefined, null, 0, 1, 'true']) {
    const controller = make();
    const hands = [{ ...handAt(center, 0), pinch }];
    controller.update(hands, 0);
    const result = controller.update(hands, 200);
    assert.equal(result.active, false, `pinch=${String(pinch)}`);
    assert.equal(result.reason, 'released');
    assert.deepEqual(result.indices, [null]);
    assert.deepEqual(result.candidates, [null]);
  }
});

test('one hand: releasing a pinch immediately clears sounding and pending sectors, then requires a fresh dwell', () => {
  const controller = make();
  activate(controller, [handAt(center, 0)]);
  const next = handAt(center, Math.PI / 4);
  const pending = controller.update([next], 180);
  assert.deepEqual(pending.indices, [0]);
  assert.deepEqual(pending.candidates, [1]);
  const release = controller.update([{ ...next, pinch: false }], 181);
  assert.equal(release.active, false);
  assert.equal(release.pending, false);
  assert.deepEqual(release.indices, [null]);
  assert.deepEqual(release.candidates, [null]);
  assert.equal(controller.update([next], 200).active, false);
  assert.equal(controller.update([next], 349).active, false);
  assert.deepEqual(controller.update([next], 350).indices, [1]);
});

test('pinch distance hysteresis prevents threshold jitter without delaying release', () => {
  const controller = make();
  const atDistance = distance => [{ ...handAt(center, 0), pinchDist: distance, pinchShape: true, pinch: distance < .32 }];
  controller.update(atDistance(.32), 0);
  assert.equal(controller.update(atDistance(.32), 200).active, false);
  assert.equal(controller.update(atDistance(.31), 210).active, false);
  assert.equal(controller.update(atDistance(.31), 360).active, true);
  assert.equal(controller.update(atDistance(.33), 380).active, true);
  assert.equal(controller.update(atDistance(.49), 400).active, true);
  assert.equal(controller.update(atDistance(.5), 401).active, false, 'one released frame stops, without 120ms delay');
  assert.equal(controller.update(atDistance(.49), 430).active, false, 'the hold range cannot restart a released pinch');
  assert.equal(controller.update(atDistance(.31), 450).active, false);
  assert.equal(controller.update(atDistance(.31), 600).active, true);
});

test('malformed pinch metrics and a lost pinch shape release rather than falling back to a stale boolean', () => {
  for (const metrics of [
    { pinchShape: false }, { pinchDist: NaN, pinchShape: true }, { pinchDist: Infinity, pinchShape: true },
    { pinchDist: -.1, pinchShape: true }, { pinchDist: null, pinchShape: true },
    { pinchDist: '0.1', pinchShape: true }, { pinchDist: .1 },
  ]) {
    const controller = make();
    activate(controller, [handAt(center, 0)]);
    const result = controller.update([{ ...handAt(center, 0), ...metrics }], 151);
    assert.equal(result.active, false, JSON.stringify(metrics));
    assert.equal(result.reason, 'released');
  }
});

test('one hand: releasing an unassigned second hand cannot mute the selected hand', () => {
  const controller = make();
  const selected = handAt(center, 0, 'Left');
  const other = hand(4, .3, 'Right', 10);
  activate(controller, [selected, other]);
  assert.equal(controller.update([{ ...other, pinch: false }, selected], 180).active, true);
  const result = controller.update([{ ...selected, pinch: false }, other], 200);
  assert.equal(result.active, false, 'the assigned hand owns the gate even if the other hand remains pinched');
  assert.equal(result.reason, 'released');
});

test('boundary jitter keeps the old active sector; a stable new sector commits once', () => {
  const controller = make();
  activate(controller, [handAt(center, 0)]);
  const before = [handAt(center, Math.PI / 8 - 0.02)];
  const after = [handAt(center, Math.PI / 8 + 0.02)];
  assert.deepEqual(controller.update(after, 180).indices, [0]);
  assert.equal(controller.state().pending, true);
  assert.deepEqual(controller.update(before, 230).indices, [0]);
  assert.equal(controller.state().pending, false);
  controller.update(after, 250);
  assert.deepEqual(controller.update(after, 399).indices, [0]);
  assert.deepEqual(controller.update(after, 400).indices, [1]);
});

test('one hand: central OFF and outside release immediately, reentry waits again', () => {
  const controller = make();
  activate(controller, [handAt(center, 0)]);
  let result = controller.update([hand(center.x, center.y)], 180);
  assert.equal(result.active, false);
  assert.equal(result.reason, 'off');
  assert.deepEqual(result.indices, [null]);
  assert.equal(controller.update([handAt(center, 0)], 210).active, false);
  assert.equal(controller.update([handAt(center, 0)], 360).active, true);
  result = controller.update([handAt(center, 0, undefined, 1.07)], 380);
  assert.equal(result.active, false);
  assert.equal(result.reason, 'off');
});

test('one hand: a second hand and changing sizes/order do not steal the tracked hand', () => {
  const controller = make();
  const tracked = handAt(center, 0, 'Left');
  const extra = hand(4, 0.3, 'Right', 100);
  activate(controller, [tracked, extra]);
  const result = controller.update([{ ...extra, size: 1000 }, { ...tracked, size: 0.001 }], 180);
  assert.deepEqual(result.indices, [0]);
  assert.deepEqual(result.points, [tracked.palm]);
});

test('one hand: equally plausible hands and abrupt identity replacement safely stop', () => {
  const controller = make();
  assert.equal(controller.update([handAt(center, 0), handAt(center, Math.PI)], 0).reason, 'ambiguous');
  assert.equal(controller.update([handAt(center, 0)], 160).active, false);
  controller.update([], 180);
  activate(controller, [handAt(center, 0, 'Left')], 200);
  assert.equal(controller.update([handAt(center, 0, 'Right')], 380).reason, 'ambiguous');
});

test('two hands: initial screen positions define roles, independent of anatomical labels', () => {
  const controller = make(twoConfig);
  const hands = [handAt(twoConfig.centers[1], Math.PI / 2, 'Left'), handAt(twoConfig.centers[0], Math.PI / 4, 'Right')];
  const result = activate(controller, hands);
  assert.deepEqual(result.indices, [1, 1]);
  assert.deepEqual(result.points, [hands[1].palm, hands[0].palm]);
});

test('two hands: shuffled frames and size reversals preserve roles with and without labels', () => {
  for (const labelled of [true, false]) {
    const controller = make(twoConfig);
    const hands = pair(Math.PI / 4, Math.PI / 2, labelled);
    activate(controller, hands);
    for (let i = 1; i <= 8; i++) {
      const changed = hands.map((h, k) => ({ ...h, size: (i + k) % 2 ? 100 : 0.001 }));
      const result = controller.update(i % 2 ? changed.reverse() : changed, 150 + i * 25);
      assert.equal(result.active, true);
      assert.deepEqual(result.indices, [1, 1]);
    }
  }
});

test('two hands: vertical wheels assign top/bottom roles, preserve array shuffles and release a crossing', () => {
  const config = { ...twoConfig, centers: [{ x: 1, y: 1 }, { x: 1, y: 4 }] };
  const controller = make(config);
  const hands = [handAt(config.centers[0], Math.PI / 2, 'Left'), handAt(config.centers[1], Math.PI / 2, 'Right')];
  assert.deepEqual(activate(controller, [...hands].reverse()).indices, [2, 1]);
  assert.deepEqual(controller.update(hands, 180).indices, [2, 1]);
  assert.deepEqual(controller.update([...hands].reverse(), 210).indices, [2, 1]);
  const crossed = [{ ...hands[0], palm: hands[1].palm }, { ...hands[1], palm: hands[0].palm }];
  assert.equal(controller.update(crossed, 240).reason, 'ambiguous');
  assert.equal(controller.state().active, false);
});

test('two hands: diagonal or reversed wheel layouts use the first-to-second center axis', () => {
  for (const centers of [[{ x: 1, y: 1 }, { x: 4, y: 4 }], [{ x: 4, y: 1 }, { x: 1, y: 1 }]]) {
    const config = { ...twoConfig, centers };
    const controller = make(config);
    const hands = [handAt(centers[0], 0), handAt(centers[1], 0)];
    const result = activate(controller, [...hands].reverse());
    assert.deepEqual(result.indices, [0, 0]);
    assert.deepEqual(result.points, hands.map(h => h.palm));
  }
});

test('two hands: candidate pairs commit atomically and intermediate combinations never play', () => {
  const controller = make(twoConfig);
  activate(controller, pair());
  assert.deepEqual(controller.update(pair(Math.PI / 4, 0), 180).indices, [0, 0]);
  assert.deepEqual(controller.update(pair(Math.PI / 4, Math.PI / 4 - 0.01), 250).indices, [0, 0]);
  const next = pair(Math.PI / 4, Math.PI / 2);
  assert.deepEqual(controller.update(next, 280).indices, [0, 0]);
  assert.deepEqual(controller.update(next, 429).indices, [0, 0]);
  assert.deepEqual(controller.update(next, 430).indices, [1, 1]);
});

test('two hands: one OFF or outside wheel releases the whole chord', () => {
  for (const inactive of [hand(4, 1, 'Right'), handAt(twoConfig.centers[1], 0, 'Right', 1.07)]) {
    const controller = make(twoConfig);
    activate(controller, pair());
    const result = controller.update([pair()[0], inactive], 180);
    assert.equal(result.active, false);
    assert.deepEqual(result.indices, [null, null]);
  }
});

test('two hands: losing one hand stops immediately and returning needs a fresh pair dwell', () => {
  const controller = make(twoConfig);
  activate(controller, pair());
  const stopped = controller.update([pair()[0]], 170);
  assert.equal(stopped.reason, 'hand-loss');
  assert.equal(stopped.active, false);
  assert.deepEqual(stopped.indices, [null, null]);
  assert.equal(controller.update(pair().reverse(), 200).active, false);
  assert.equal(controller.update(pair(), 350).active, true);
});

test('two hands: both assigned pinches must be held; either release clears the complete pair', () => {
  for (const releasedRole of [0, 1]) {
    const controller = make(twoConfig);
    const held = pair();
    const half = held.map((h, i) => ({ ...h, pinch: i !== releasedRole }));
    controller.update(half, 0);
    assert.equal(controller.update(half, 200).active, false);
    assert.equal(activate(controller, held, 210).active, true);
    const released = controller.update([...half].reverse(), 361);
    assert.equal(released.active, false);
    assert.deepEqual(released.indices, [null, null]);
    assert.deepEqual(released.candidates, [null, null]);
    assert.equal(controller.update(held, 380).active, false);
    assert.equal(controller.update([...held].reverse(), 529).active, false);
    assert.equal(controller.update(held, 530).active, true);
  }
});

test('two hands: occlusion clears old pinch hysteresis and requires a fresh complete pair', () => {
  const controller = make(twoConfig);
  const atDistance = distance => pair().map(h => ({ ...h, pinchDist: distance, pinchShape: true, pinch: distance < .32 }));
  activate(controller, atDistance(.2));
  assert.equal(controller.update(atDistance(.4), 180).active, true);
  assert.equal(controller.update(atDistance(.4).slice(0, 1), 181).active, false);
  assert.equal(controller.update(atDistance(.4).reverse(), 200).active, false);
  assert.equal(controller.update(atDistance(.4), 400).active, false, 'old hold thresholds cannot rearm lost hands');
  assert.equal(controller.update(atDistance(.2), 410).active, false);
  assert.equal(controller.update(atDistance(.2), 559).active, false);
  assert.equal(controller.update(atDistance(.2).reverse(), 560).active, true);
});

test('empty frames and a stalled stream cannot reuse an old pinch hold or selection', () => {
  for (const loss of ['empty', 'stale']) {
    const controller = make();
    const atDistance = distance => [{ ...handAt(center, 0), pinchDist: distance, pinchShape: true, pinch: distance < .32 }];
    activate(controller, atDistance(.2));
    assert.equal(controller.update(atDistance(.4), 180).active, true);
    if (loss === 'empty') controller.update([], 181);
    else controller.tick(431);
    assert.equal(controller.update(atDistance(.4), 450).active, false);
    assert.equal(controller.update(atDistance(.4), 650).active, false);
    assert.equal(controller.update(atDistance(.2), 660).active, false);
    assert.equal(controller.update(atDistance(.2), 810).active, true);
  }
});

test('two hands: crossing labelled hands releases, without silently swapping their roles', () => {
  const controller = make(twoConfig);
  const hands = pair();
  activate(controller, hands);
  const crossed = [
    { ...hands[0], palm: { ...hands[1].palm } },
    { ...hands[1], palm: { ...hands[0].palm } },
  ];
  assert.equal(controller.update(crossed, 180).reason, 'ambiguous');
  assert.equal(controller.update(crossed.reverse(), 350).active, false);
  assert.equal(controller.update(hands, 500).active, false, 'do not automatically rearm after ambiguity');
  controller.update([], 510);
  assert.equal(controller.update(hands, 530).active, false);
  assert.equal(controller.update(hands, 680).active, true);
});

test('two hands: close unlabeled hands and occluded identity substitutions cannot flip roles', () => {
  const controller = make(twoConfig);
  activate(controller, pair(0, 0, false));
  assert.equal(controller.update([hand(2.45, 0.3), hand(2.55, 0.3)], 180).reason, 'ambiguous');
  controller.reset();
  activate(controller, pair(), 200);
  controller.update([pair()[0]], 370);
  assert.equal(controller.update([hand(1, 0.3, 'Right'), hand(4, 0.3, 'Left')], 390).reason, 'ambiguous');
});

test('no callbacks: watchdog releases after 250ms; return cannot reuse old dwell', () => {
  const controller = make();
  const hands = [handAt(center, 0)];
  activate(controller, hands);
  assert.equal(controller.tick(400).active, true);
  const stale = controller.tick(401);
  assert.equal(stale.active, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(controller.update(hands, 500).active, false);
  assert.equal(controller.update(hands, 650).active, true);
  assert.equal(controller.update(hands, 1000).active, false, 'update also detects a stalled callback stream');
  assert.equal(controller.update(hands, 1150).active, true);
});

test('configure: equivalent objects preserve activity, changed layout/count/mode resets it', () => {
  const controller = make();
  const hands = [handAt(center, 0)];
  activate(controller, hands);
  assert.equal(controller.configure(structuredClone(oneConfig)).active, true);
  assert.equal(controller.configure({ ...oneConfig, aspect: 1 }).active, true);
  assert.equal(controller.configure({ ...oneConfig, counts: [4] }).active, false);
  activate(controller, hands, 200);
  assert.equal(controller.configure({ ...oneConfig, centers: [{ x: 1.01, y: 1 }] }).active, false);
  const two = controller.configure(twoConfig);
  assert.deepEqual(two.indices, [null, null]);
  assert.equal(controller.update([hands[0]], 400).active, false);
});

test('configuration and snapshots are copied and cannot corrupt later state', () => {
  const config = structuredClone(oneConfig);
  const controller = make(config);
  config.counts[0] = 0;
  config.centers[0].x = NaN;
  const result = activate(controller, [handAt(center, 0)]);
  result.indices[0] = 7;
  result.points[0].x = 100;
  assert.deepEqual(controller.state().indices, [0]);
  assert.equal(controller.state().points[0].x, 1);
  controller.update([handAt(center, Math.PI / 4)], 180).candidates[0] = 7;
  assert.deepEqual(controller.state().candidates, [1]);
});

test('aspect contract: supplied x and centers are already scaled and are never scaled twice', () => {
  const controller = make({ hands: 'one', counts: [4], centers: [{ x: 2, y: 1 }], radius: 0.2, aspect: 2 });
  assert.deepEqual(activate(controller, [hand(2.15, 1)]).indices, [1]);
});

test('invalid configuration fails closed, including empty one/two hand selections', () => {
  const controller = make();
  for (const invalid of [null, {}, { ...oneConfig, hands: 'three' }, { ...oneConfig, counts: [] },
    { ...oneConfig, counts: [0] }, { ...twoConfig, counts: [8] }, { ...twoConfig, centers: [center] },
    { ...twoConfig, centers: [center, center] }, { ...oneConfig, radius: NaN }, { ...oneConfig, aspect: 0 }]) {
    assert.equal(controller.configure(invalid).active, false);
    assert.equal(controller.update([handAt(center, 0)], 0).reason, 'invalid-config');
  }
  controller.configure(oneConfig);
  assert.equal(activate(controller, [handAt(center, 0)]).active, true);
});

test('malformed input and nonmonotonic time immediately release active state', () => {
  for (const malformed of [null, {}, [null], [{ palm: { x: NaN, y: 1 } }], [{ palm: { x: 1, y: Infinity } }]]) {
    const controller = make();
    activate(controller, [handAt(center, 0)]);
    assert.equal(controller.update(malformed, 180).reason, 'invalid-input');
    assert.equal(controller.state().active, false);
  }
  for (const now of [NaN, Infinity, 149]) {
    const controller = make();
    activate(controller, [handAt(center, 0)]);
    assert.equal(controller.tick(now).reason, 'invalid-time');
    assert.equal(controller.state().active, false);
  }
});

test('reset releases and forgets candidates, roles, ambiguity, and previous clock', () => {
  const controller = make(twoConfig);
  activate(controller, pair());
  controller.update([hand(2.5, 0.3), hand(2.5, 0.4)], 180);
  const result = controller.reset();
  assert.equal(result.active, false);
  assert.equal(result.pending, false);
  assert.deepEqual(result.points, [null, null]);
  assert.equal(activate(controller, pair()).active, true);
});

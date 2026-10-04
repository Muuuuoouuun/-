// Camera-independent wheel selection. The caller supplies mirrored, aspect-correct
// Euclidean coordinates (for example x * stageAspect, y). This module never
// transforms coordinates, opens devices, or starts audio.
const TAU = Math.PI * 2;
const finitePoint = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const copyPoint = (p) => p ? { x: p.x, y: p.y } : null;
const sameIndices = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// Sector zero is centered at twelve o'clock; indices increase clockwise.
// The UI ring starts at 25% of its box and ends at 48%; radius is that outer
// 48% radius. All of the center button and the gap before the ring are OFF.
// The central OFF disk includes its boundary; the outer edge is selectable.
export function wheelHit(point, center, radius, count, { innerRatio = 25 / 48, outerRatio = 1.06 } = {}) {
  if (!finitePoint(point) || !finitePoint(center) || !Number.isFinite(radius) || radius <= 0
    || !Number.isSafeInteger(count) || count < 1
    || !Number.isFinite(innerRatio) || !Number.isFinite(outerRatio)
    || innerRatio < 0 || outerRatio <= innerRatio) return null;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const r = Math.hypot(dx, dy);
  if (r <= radius * innerRatio || r > radius * outerRatio) return null;
  const angle = ((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI / count) % TAU + TAU) % TAU;
  return Math.min(count - 1, Math.floor(angle / TAU * count));
}

function handLabel(hand) {
  let value = hand.handedness;
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === 'object') value = value.categoryName ?? value.label;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * configure({ hands: 'one'|'two', counts: [n, ...], centers: [{x,y}, ...], radius, aspect? })
 * update([{ palm: {x,y}, handedness?: 'Left'|'Right' }, ...], monotonicMilliseconds)
 * tick(monotonicMilliseconds) must run even when the camera stops calling back.
 *
 * Every method returns an independent snapshot:
 * { indices, candidates, points, active, pending, reason }.
 * indices are the last committed selection (all null when stopped). A new pair
 * commits atomically after 150 ms of stable camera observations; valid boundary
 * jitter holds the previous pair. OFF, hand loss and invalid input stop at once.
 * Ambiguous tracking latches OFF until all hands leave or reset() is called.
 * Optional aspect is configuration metadata only; coordinates are already scaled.
 */
export class WheelController {
  constructor({ dwellMs = 150, lostMs = 250 } = {}) {
    this.dwellMs = Number.isFinite(dwellMs) && dwellMs >= 0 ? dwellMs : 150;
    this.lostMs = Number.isFinite(lostMs) && lostMs > 0 ? lostMs : 250;
    this.config = null;
    this._signature = null;
    this._count = 1;
    this.reset();
  }

  configure(input = {}) {
    const n = input?.hands === 'two' ? 2 : 1;
    const valid = (input?.hands === 'one' || input?.hands === 'two')
      && Array.isArray(input.counts) && input.counts.length === n
      && input.counts.every((v) => Number.isSafeInteger(v) && v > 0)
      && Array.isArray(input.centers) && input.centers.length === n && input.centers.every(finitePoint)
      && (n === 1 || distance(input.centers[0], input.centers[1]) > 0)
      && Number.isFinite(input.radius) && input.radius > 0
      && (input.aspect === undefined || (Number.isFinite(input.aspect) && input.aspect > 0));
    if (!valid) {
      this.config = null;
      this._signature = null;
      this._count = n;
      this.reset();
      this._reason = 'invalid-config';
      return this.state();
    }
    const config = {
      hands: input.hands,
      counts: [...input.counts],
      centers: input.centers.map(copyPoint),
      radius: input.radius,
      aspect: input.aspect ?? 1,
    };
    const signature = JSON.stringify(config);
    if (signature !== this._signature) {
      this.config = config;
      this._signature = signature;
      this._count = n;
      this.reset();
      this._reason = 'configured';
    }
    return this.state();
  }

  reset() {
    this._indices = Array(this._count).fill(null);
    this._candidate = null;
    this._candidateSince = null;
    this._points = Array(this._count).fill(null);
    this._roles = null;
    this._blocked = false;
    this._lastFrame = null;
    this._lastTime = null;
    this._reason = 'reset';
    return this.state();
  }

  _stop(reason, { forgetRoles = true, points = null } = {}) {
    this._indices = Array(this._count).fill(null);
    this._candidate = null;
    this._candidateSince = null;
    this._points = points ?? Array(this._count).fill(null);
    if (forgetRoles) this._roles = null;
    this._reason = reason;
    return this.state();
  }

  _ambiguous() {
    this._blocked = true;
    return this._stop('ambiguous');
  }

  _validTime(now) {
    if (!Number.isFinite(now) || (this._lastTime !== null && now < this._lastTime)) {
      this._stop('invalid-time');
      return false;
    }
    this._lastTime = now;
    return true;
  }

  // Match to the preceding frame, never to array order or hand size. Distinct
  // handedness labels aid continuity but do not define the first wheel's role.
  _assign(hands) {
    const radius = this.config.radius;
    if (this._count === 1) {
      if (!this._roles) {
        const ranked = hands.map((hand) => ({ hand, d: distance(hand.palm, this.config.centers[0]) }))
          .sort((a, b) => a.d - b.d);
        if (ranked.length > 1 && ranked[1].d - ranked[0].d < radius * 0.15) return null;
        return [ranked[0].hand];
      }
      const previous = this._roles[0];
      const labelled = previous.label ? hands.filter((hand) => hand.label === previous.label) : [];
      const available = labelled.length === 1 ? labelled : hands;
      const ranked = available.map((hand) => ({ hand, d: distance(hand.palm, previous.palm) }))
        .sort((a, b) => a.d - b.d);
      if (ranked[0].d > radius * 0.9
        || (ranked.length > 1 && ranked[1].d - ranked[0].d < radius * 0.15)
        || (previous.label && ranked[0].hand.label && previous.label !== ranked[0].hand.label)) return null;
      return [ranked[0].hand];
    }

    // The first-to-second wheel axis also supports mobile's vertical layout.
    // Approaching/crossed hands cannot safely exchange root and quality roles.
    const [first, second] = this.config.centers;
    const length = distance(first, second);
    const axis = { x: (second.x - first.x) / length, y: (second.y - first.y) / length };
    const position = (p) => (p.x - first.x) * axis.x + (p.y - first.y) * axis.y;
    if (Math.abs(position(hands[0].palm) - position(hands[1].palm)) < radius * 0.15
      || distance(hands[0].palm, hands[1].palm) < radius * 0.5) return null;
    if (!this._roles) return [...hands].sort((a, b) => position(a.palm) - position(b.palm));

    const [left, right] = this._roles;
    let assigned;
    const canMatchLabels = left.label && right.label && left.label !== right.label
      && hands.some((h) => h.label === left.label) && hands.some((h) => h.label === right.label);
    if (canMatchLabels) {
      assigned = [hands.find((h) => h.label === left.label), hands.find((h) => h.label === right.label)];
    } else {
      const direct = distance(left.palm, hands[0].palm) + distance(right.palm, hands[1].palm);
      const swapped = distance(left.palm, hands[1].palm) + distance(right.palm, hands[0].palm);
      if (Math.abs(direct - swapped) < radius * 0.18) return null;
      assigned = direct < swapped ? [...hands] : [hands[1], hands[0]];
      if (assigned.some((hand, i) => hand.label && this._roles[i].label && hand.label !== this._roles[i].label)) return null;
    }
    if (position(assigned[0].palm) >= position(assigned[1].palm)
      || assigned.some((hand, i) => distance(hand.palm, this._roles[i].palm) > radius * 0.9)) return null;
    return assigned;
  }

  update(hands, now) {
    if (!this._validTime(now)) return this.state();
    if (!this.config) return this._stop('invalid-config');
    if (this._lastFrame !== null && now - this._lastFrame > this.lostMs) this._stop('stale');
    this._lastFrame = now;
    if (!Array.isArray(hands) || hands.some((hand) => !finitePoint(hand?.palm))) return this._stop('invalid-input');
    if (hands.length === 0) {
      this._blocked = false;
      return this._stop('hand-loss');
    }
    if (this._blocked) return this._stop('ambiguous');
    if (hands.length > 2) return this._ambiguous();
    if (this._count === 2 && hands.length !== 2) {
      // Retain the old identities during an occlusion, but never the old sound.
      return this._stop('hand-loss', { forgetRoles: false });
    }
    const analyzed = hands.map((hand) => ({ palm: copyPoint(hand.palm), label: handLabel(hand) }));
    const assigned = this._assign(analyzed);
    if (!assigned) return this._ambiguous();
    this._roles = assigned.map((hand, i) => ({
      palm: copyPoint(hand.palm), label: hand.label ?? this._roles?.[i]?.label ?? null,
    }));
    this._points = assigned.map((hand) => copyPoint(hand.palm));
    const candidate = assigned.map((hand, i) => wheelHit(hand.palm, this.config.centers[i], this.config.radius, this.config.counts[i]));
    if (candidate.some((index) => index === null)) {
      return this._stop('off', { forgetRoles: false, points: this._points });
    }
    if (sameIndices(candidate, this._indices)) {
      this._candidate = null;
      this._candidateSince = null;
      this._reason = 'active';
    } else {
      if (!sameIndices(candidate, this._candidate)) {
        this._candidate = candidate;
        this._candidateSince = now;
      }
      this._reason = 'dwell';
      if (now - this._candidateSince >= this.dwellMs) {
        this._indices = [...candidate];
        this._candidate = null;
        this._candidateSince = null;
        this._reason = 'active';
      }
    }
    return this.state();
  }

  tick(now) {
    if (!this._validTime(now)) return this.state();
    if (!this.config) return this._stop('invalid-config');
    if (this._lastFrame !== null && now - this._lastFrame > this.lostMs) return this._stop('stale');
    return this.state();
  }

  state() {
    return {
      indices: [...this._indices],
      candidates: this._candidate ? [...this._candidate] : Array(this._count).fill(null),
      points: this._points.map(copyPoint),
      active: this._indices.every((index) => index !== null),
      pending: this._candidate !== null,
      reason: this._reason,
    };
  }
}

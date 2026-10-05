// A small, microphone-independent chord instrument. The caller owns the context.
// `output` is the post-volume GainNode: connect it to a monitor and/or a selected
// recording bus. No destination is connected implicitly, and dispose never closes
// or resumes the context. `count` / `activeVoices` describe held notes, not tails.

const ATTACK = 0.025;
const RELEASE = 0.08;
const MAX_SOURCES = 8; // Four held notes plus at most four release tails.
const clampGain = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function chordNotes(notes) {
  if (!Array.isArray(notes) || notes.length < 3 || notes.length > 4) return null;
  if (!notes.every((note) => Number.isInteger(note) && note >= 0 && note <= 127)) return null;
  const unique = [...new Set(notes)].sort((a, b) => a - b);
  return unique.length >= 3 ? unique : null;
}

function levelAt(envelope, now) {
  if (now >= envelope.end) return envelope.to;
  if (now <= envelope.start) return envelope.from;
  return envelope.from + (envelope.to - envelope.from) * (now - envelope.start) / (envelope.end - envelope.start);
}

export class Accompaniment {
  constructor(ctx, { destination, recordDestination = null, gain = 0.22 } = {}) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = clampGain(gain);
    this.disposed = false;
    this._held = new Map();
    this._voices = new Set();
    for (const target of new Set([destination, recordDestination].filter(Boolean))) this.output.connect(target);
    this._stateChange = () => {
      // Frozen audio time cannot finish a scheduled release. Do not leave notes
      // waiting to sound again when the owner resumes a suspended context.
      if (ctx.state !== 'running') this.release({ immediate: true });
    };
    ctx.addEventListener?.('statechange', this._stateChange);
  }

  get activeVoices() {
    return [...this._held.keys()].sort((a, b) => a - b);
  }

  get count() {
    return this._held.size;
  }

  // Returns whether a valid chord is held. Reordered/repeated identical chords
  // do not retrigger; common notes also survive changes between adjacent chords.
  setChord(midiNotes) {
    if (this.disposed) return false;
    const notes = chordNotes(midiNotes);
    if (!notes || this.ctx.state !== 'running') {
      this.release({ immediate: this.ctx.state !== 'running' });
      return false;
    }
    if (notes.length === this.count && notes.every((note) => this._held.has(note))) return true;

    const now = this.ctx.currentTime;
    const wanted = new Set(notes);
    for (const [note, voice] of this._held) {
      if (!wanted.has(note)) this._releaseVoice(voice, now, false);
    }

    const needed = notes.filter((note) => !this._held.has(note)).length;
    // Rapid changes can happen before onended runs. Retire the oldest tails
    // synchronously rather than allowing a backlog of oscillators to build up.
    for (const voice of this._voices) {
      if (this._voices.size + needed <= MAX_SOURCES) break;
      if (voice.releasing) this._releaseVoice(voice, now, true);
    }

    try {
      for (const note of notes) {
        const existing = this._held.get(note);
        if (existing) this._rampVoice(existing, 1 / notes.length, now, ATTACK);
        else this._createVoice(note, 1 / notes.length, now);
      }
    } catch (error) {
      this.release({ immediate: true });
      throw error;
    }
    return true;
  }

  _createVoice(note, level, now) {
    const oscillator = this.ctx.createOscillator();
    let envelope;
    let voice;
    try {
      envelope = this.ctx.createGain();
      voice = {
        note, oscillator, node: envelope, releasing: false, cleaned: false,
        envelope: { from: 0, to: 0, start: now, end: now },
      };
      this._voices.add(voice);
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(440 * 2 ** ((note - 69) / 12), now);
      envelope.gain.value = 0;
      oscillator.connect(envelope).connect(this.output);
      oscillator.onended = () => this._cleanupVoice(voice);
      this._rampVoice(voice, level, now, ATTACK);
      oscillator.start(now);
      this._held.set(note, voice);
    } catch (error) {
      if (voice) this._releaseVoice(voice, now, true);
      else {
        oscillator.disconnect();
        envelope?.disconnect();
      }
      throw error;
    }
  }

  _rampVoice(voice, target, now, duration) {
    const from = levelAt(voice.envelope, now);
    const param = voice.node.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    param.linearRampToValueAtTime(target, now + duration);
    voice.envelope = { from, to: target, start: now, end: now + duration };
  }

  _releaseVoice(voice, now, immediate) {
    if (voice.cleaned) return;
    if (this._held.get(voice.note) === voice) this._held.delete(voice.note);
    if (immediate) {
      // Disconnect even if a closed context or an unstarted node rejects stop.
      try { voice.oscillator.stop(now); } catch {}
      this._cleanupVoice(voice);
    } else if (!voice.releasing) {
      voice.releasing = true;
      this._rampVoice(voice, 0, now, RELEASE);
      voice.oscillator.stop(now + RELEASE + 0.005);
    }
  }

  _cleanupVoice(voice) {
    if (voice.cleaned) return;
    voice.cleaned = true;
    voice.oscillator.onended = null;
    voice.oscillator.disconnect();
    voice.node.disconnect();
    this._voices.delete(voice);
    if (this._held.get(voice.note) === voice) this._held.delete(voice.note);
  }

  release({ immediate = false } = {}) {
    const now = this.ctx.currentTime;
    const stopNow = immediate || this.ctx.state !== 'running';
    for (const voice of this._voices) this._releaseVoice(voice, now, stopNow);
  }

  setGain(value) {
    if (this.disposed) return;
    this.output.gain.setTargetAtTime(clampGain(value), this.ctx.currentTime, 0.015);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ctx.removeEventListener?.('statechange', this._stateChange);
    this.release({ immediate: true });
    this.output.disconnect();
  }
}

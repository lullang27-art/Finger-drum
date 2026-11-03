// player.js
// Plays the backing track (the original song) with adjustable speed, drives a
// synchronized clock for the note roll, fires guide-note "ticks", plays the
// metronome, and synthesizes the user's pad hits.

export class Player {
  constructor() {
    this.ctx = null;
    this.buffer = null;      // decoded AudioBuffer of original song
    this.source = null;      // current BufferSourceNode
    this.backingGain = null;
    this.guideGain = null;
    this.userGain = null;
    this.metroGain = null;

    this.rate = 1;           // playback speed multiplier
    this.playing = false;
    this.startCtxTime = 0;   // ctx.currentTime when playback started
    this.startOffset = 0;    // song position (sec) at start
    this.bpm = 120;
    this.metronomeOn = false;
    this._metroNextBeat = 0;
    this._schedTimer = null;
  }

  async init(audioBuffer) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.buffer = audioBuffer;

    this.backingGain = this.ctx.createGain();
    this.guideGain = this.ctx.createGain();
    this.userGain = this.ctx.createGain();
    this.metroGain = this.ctx.createGain();

    this.backingGain.gain.value = 0.85;
    this.guideGain.gain.value = 0.6;
    this.userGain.gain.value = 0.9;
    this.metroGain.gain.value = 0.0; // off by default

    this.backingGain.connect(this.ctx.destination);
    this.guideGain.connect(this.ctx.destination);
    this.userGain.connect(this.ctx.destination);
    this.metroGain.connect(this.ctx.destination);
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ---- Transport --------------------------------------------------------

  get currentTime() {
    // Song position in seconds, accounting for playback rate.
    if (!this.playing) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  async play(offset = null) {
    if (!this.buffer) return;
    // CRITICAL on mobile: the AudioContext starts suspended and its clock
    // (ctx.currentTime) does not advance until resume() resolves. We MUST
    // await it before capturing startCtxTime / scheduling the source,
    // otherwise playback never progresses and the play head stays frozen.
    await this.resume();
    if (this.playing) this.stopSource();
    const startAt = offset != null ? offset : this.startOffset;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.backingGain);
    src.start(0, Math.max(0, Math.min(startAt, this.duration)));
    src.onended = () => {
      if (this.playing && this.source === src) {
        // reached end
        this.playing = false;
        if (this.onEnded) this.onEnded();
      }
    };
    this.source = src;
    this.startCtxTime = this.ctx.currentTime;
    this.startOffset = startAt;
    this.playing = true;
    this._metroNextBeat = this._nextBeatAfter(startAt);
    this._startScheduler();
  }

  pause() {
    if (!this.playing) return;
    const pos = this.currentTime;
    this.stopSource();
    this.playing = false;
    this.startOffset = Math.max(0, Math.min(pos, this.duration));
    this._stopScheduler();
  }

  toggle() {
    if (this.playing) { this.pause(); return Promise.resolve(); }
    return this.play();
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stopSource();
    this.startOffset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) return this.play(this.startOffset);
    return Promise.resolve();
  }

  stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }
  }

  setRate(rate) {
    const pos = this.currentTime;
    this.rate = rate;
    if (this.playing) {
      // Re-anchor clock and restart source at new rate.
      this.play(pos);
    } else {
      this.startOffset = pos;
    }
  }

  setVolume(which, value) {
    const map = {
      backing: this.backingGain,
      guide: this.guideGain,
      user: this.userGain,
      metro: this.metroGain,
    };
    const g = map[which];
    if (g) g.gain.value = value;
  }

  setMetronome(on, bpm) {
    this.metronomeOn = on;
    if (bpm) this.bpm = bpm;
    this.metroGain.gain.value = on ? 0.5 : 0.0;
  }

  // ---- Scheduling (metronome + guide ticks) -----------------------------

  _nextBeatAfter(t) {
    if (!this.bpm) return Infinity;
    const beat = 60 / this.bpm;
    return Math.ceil(t / beat) * beat;
  }

  _startScheduler() {
    this._stopScheduler();
    const tick = () => {
      if (!this.playing) return;
      const lookahead = 0.2; // sec
      const now = this.currentTime;
      if (this.metronomeOn && this.bpm) {
        const beat = 60 / this.bpm;
        while (this._metroNextBeat < now + lookahead) {
          const when = this.ctx.currentTime + (this._metroNextBeat - now) / this.rate;
          const beatIndex = Math.round(this._metroNextBeat / beat);
          this._clickAt(when, beatIndex % 4 === 0);
          this._metroNextBeat += beat;
        }
      }
      this._schedTimer = setTimeout(tick, 25);
    };
    tick();
  }

  _stopScheduler() {
    if (this._schedTimer) { clearTimeout(this._schedTimer); this._schedTimer = null; }
  }

  _clickAt(when, accent) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(g); g.connect(this.metroGain);
    osc.start(when); osc.stop(when + 0.06);
  }

  // ---- Drum synthesis (for user pad hits & guide preview) ---------------

  playDrum(inst, dest = 'user', when = null) {
    if (!this.ctx) return;
    const t = when != null ? when : this.ctx.currentTime;
    const out = dest === 'guide' ? this.guideGain : this.userGain;
    switch (inst) {
      case 'kick': return this._kick(t, out);
      case 'snare': return this._snare(t, out, 0.9);
      case 'ghostSnare': return this._snare(t, out, 0.35);
      case 'hatClosed': return this._hat(t, out, 0.05);
      case 'hatOpen': return this._hat(t, out, 0.35);
      case 'ride': return this._hat(t, out, 0.4, 7000);
      case 'crash': return this._crash(t, out);
      case 'tom': return this._tom(t, out);
      default: return this._snare(t, out, 0.5);
    }
  }

  _kick(t, out) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + 0.3);
  }

  _snare(t, out, amp) {
    const noise = this._noise(0.2);
    const g = this.ctx.createGain();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1500;
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    noise.connect(hp); hp.connect(g); g.connect(out);
    noise.start(t); noise.stop(t + 0.2);
    // body tone
    const osc = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc.frequency.value = 180;
    g2.gain.setValueAtTime(amp * 0.6, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g2); g2.connect(out);
    osc.start(t); osc.stop(t + 0.12);
  }

  _hat(t, out, decay, freq = 9000) {
    const noise = this._noise(decay + 0.05);
    const g = this.ctx.createGain();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = freq;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    noise.connect(hp); hp.connect(g); g.connect(out);
    noise.start(t); noise.stop(t + decay + 0.05);
  }

  _crash(t, out) {
    const noise = this._noise(1.0);
    const g = this.ctx.createGain();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    noise.connect(hp); hp.connect(g); g.connect(out);
    noise.start(t); noise.stop(t + 1.0);
  }

  _tom(t, out) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.2);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + 0.25);
  }

  _noise(dur) {
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  destroy() {
    this.stopSource();
    this._stopScheduler();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}

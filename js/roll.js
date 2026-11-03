// roll.js
// Renders the scrolling note highway (like the reference screenshot): one lane
// per instrument row, notes flow right-to-left toward a fixed vertical play
// head. Only enabled tracks are highlighted; disabled tracks are dimmed.

import { INSTRUMENT_MAP } from './analyzer.js';

export class NoteRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.cx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.lanes = [];           // ordered list of instrument ids (top->bottom)
    this.notes = [];           // {t, inst, vel}
    this.enabled = new Set();  // enabled instrument ids
    this.secondsVisible = 4;   // time window to the right of the play head
    this.playHeadX = 0.46;     // fraction of width where the head sits
    this.getTime = () => 0;
    this.hitFlash = new Map(); // inst -> flash timestamp (ms)
    this.judgeFlash = [];      // {x, y, color, t} transient hit markers

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  setLanes(laneIds) { this.lanes = laneIds; }
  setNotes(notes) { this.notes = notes.slice().sort((a, b) => a.t - b.t); }
  setEnabled(set) { this.enabled = set; }

  flashLane(inst) { this.hitFlash.set(inst, performance.now()); }
  judge(inst, ok) {
    const laneIndex = this.lanes.indexOf(inst);
    if (laneIndex < 0) return;
    const { width, height } = this._cssSize();
    const laneH = height / this.lanes.length;
    this.judgeFlash.push({
      x: width * this.playHeadX,
      y: laneH * (laneIndex + 0.5),
      color: ok ? '#7ed957' : '#ff6b6b',
      t: performance.now(),
    });
  }

  _cssSize() {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  _resize() {
    const { width, height } = this._cssSize();
    this.canvas.width = Math.max(1, Math.floor(width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(height * this.dpr));
  }

  render() {
    const cx = this.cx;
    const { width, height } = this._cssSize();
    if (this.canvas.width !== Math.floor(width * this.dpr)) this._resize();

    cx.save();
    cx.scale(this.dpr, this.dpr);
    cx.clearRect(0, 0, width, height);

    const now = this.getTime();
    const nLanes = this.lanes.length || 1;
    const laneH = height / nLanes;
    const headX = width * this.playHeadX;
    const pxPerSec = (width - headX) / this.secondsVisible;

    // Lane backgrounds + separators
    for (let i = 0; i < nLanes; i++) {
      const y = i * laneH;
      cx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.0)';
      cx.fillRect(0, y, width, laneH);
      cx.strokeStyle = 'rgba(255,255,255,0.06)';
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(0, y + 0.5);
      cx.lineTo(width, y + 0.5);
      cx.stroke();
    }

    // Beat grid lines (light vertical guides)
    cx.strokeStyle = 'rgba(255,255,255,0.05)';
    const beat = 60 / (this._bpm || 120);
    if (beat > 0.05) {
      const firstBeat = Math.floor(now / beat) * beat;
      for (let b = firstBeat; b < now + this.secondsVisible + beat; b += beat) {
        const x = headX + (b - now) * pxPerSec;
        if (x < 0 || x > width) continue;
        cx.beginPath();
        cx.moveTo(x, 0);
        cx.lineTo(x, height);
        cx.stroke();
      }
    }

    // Notes
    const t0 = now - (headX / pxPerSec);           // left edge time
    const t1 = now + this.secondsVisible + 0.1;     // right edge time
    const size = Math.min(laneH * 0.55, 26);
    for (const note of this.notes) {
      if (note.t < t0 || note.t > t1) continue;
      const laneIndex = this.lanes.indexOf(note.inst);
      if (laneIndex < 0) continue;
      const x = headX + (note.t - now) * pxPerSec;
      const y = laneIndex * laneH + laneH / 2;
      const inst = INSTRUMENT_MAP[note.inst];
      const color = inst ? inst.color : '#ffd93d';
      const on = this.enabled.has(note.inst);

      cx.globalAlpha = on ? 1 : 0.22;
      const s = size * (0.7 + 0.3 * (note.vel || 0.6));
      roundRect(cx, x - s / 2, y - s / 2, s, s, 4);
      cx.fillStyle = color;
      cx.fill();
      cx.globalAlpha = 1;
    }

    // Lane hit flashes (glow when a note crosses / pad pressed)
    const tnow = performance.now();
    for (const [inst, ts] of this.hitFlash) {
      const age = tnow - ts;
      if (age > 350) { this.hitFlash.delete(inst); continue; }
      const laneIndex = this.lanes.indexOf(inst);
      if (laneIndex < 0) continue;
      const y = laneIndex * laneH + laneH / 2;
      const a = 1 - age / 350;
      const grad = cx.createRadialGradient(headX, y, 2, headX, y, laneH * 1.1);
      const inst2 = INSTRUMENT_MAP[inst];
      grad.addColorStop(0, hexA(inst2 ? inst2.color : '#7ed957', 0.5 * a));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      cx.fillStyle = grad;
      cx.fillRect(0, y - laneH, width, laneH * 2);
    }

    // Judge markers (hit/miss rings at the play head)
    this.judgeFlash = this.judgeFlash.filter(j => tnow - j.t < 400);
    for (const j of this.judgeFlash) {
      const age = tnow - j.t;
      const a = 1 - age / 400;
      const r = 10 + age / 400 * 24;
      cx.strokeStyle = hexA(j.color, a);
      cx.lineWidth = 3;
      cx.beginPath();
      cx.arc(j.x, j.y, r, 0, Math.PI * 2);
      cx.stroke();
    }

    // Play head
    cx.strokeStyle = '#ffd22e';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(headX, 0);
    cx.lineTo(headX, height);
    cx.stroke();
    cx.fillStyle = '#ffd22e';
    cx.beginPath();
    cx.arc(headX, 6, 4, 0, Math.PI * 2);
    cx.fill();

    cx.restore();
  }

  setBpm(bpm) { this._bpm = bpm; }
}

function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

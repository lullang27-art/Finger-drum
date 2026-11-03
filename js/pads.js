// pads.js
// 3x3 pad grid. Each cell is mapped to a drum instrument (configurable in
// Settings). Handles touch / mouse / keyboard input, fires the drum sound,
// flashes the lane, and judges timing against the nearest enabled note.

import { INSTRUMENT_MAP } from './analyzer.js';

// Default keyboard mapping for the 3x3 grid (numpad-like / qwe-asd-zxc).
export const DEFAULT_KEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];

export class PadGrid {
  constructor(root) {
    this.root = root;
    this.cells = [];           // 9 DOM elements
    this.mapping = [];         // 9 instrument ids (index = pad position)
    this.keys = DEFAULT_KEYS.slice();
    this.onHit = () => {};      // (inst, index) => void
    this._build();
    this._bindKeyboard();
  }

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('pad-grid');
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button');
      cell.className = 'pad';
      cell.dataset.index = i;
      cell.innerHTML = `<span class="pad-label"></span><span class="pad-key"></span>`;
      const press = (e) => {
        e.preventDefault();
        this.trigger(i, true);
      };
      cell.addEventListener('pointerdown', press);
      this.cells.push(cell);
      this.root.appendChild(cell);
    }
  }

  setMapping(mapping) {
    this.mapping = mapping.slice(0, 9);
    this._refreshLabels();
  }

  setKeys(keys) {
    this.keys = keys.slice(0, 9);
    this._refreshLabels();
  }

  _refreshLabels() {
    for (let i = 0; i < 9; i++) {
      const cell = this.cells[i];
      const inst = this.mapping[i];
      const meta = INSTRUMENT_MAP[inst];
      const label = cell.querySelector('.pad-label');
      const key = cell.querySelector('.pad-key');
      if (inst && meta) {
        label.textContent = meta.label;
        cell.style.setProperty('--pad-color', meta.color);
        cell.classList.remove('empty');
      } else {
        label.textContent = '—';
        cell.style.setProperty('--pad-color', '#555');
        cell.classList.add('empty');
      }
      key.textContent = (this.keys[i] || '').toUpperCase();
    }
  }

  trigger(index, fromUser = true) {
    const inst = this.mapping[index];
    const cell = this.cells[index];
    if (cell) {
      cell.classList.add('active');
      setTimeout(() => cell.classList.remove('active'), 120);
    }
    if (inst) this.onHit(inst, index, fromUser);
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const idx = this.keys.indexOf(e.key.toLowerCase());
      if (idx >= 0) {
        this.trigger(idx, true);
      }
    });
  }
}

// Timing judge: given the chart notes and current time, find the closest
// enabled note of the given instrument within a window and classify accuracy.
export class Judge {
  constructor() {
    this.windowGood = 0.08;   // sec
    this.windowOk = 0.16;     // sec
    this.consumed = new Set();
    this.stats = { hits: 0, perfect: 0, good: 0, miss: 0, streak: 0, bestStreak: 0 };
  }

  reset() {
    this.consumed.clear();
    this.stats = { hits: 0, perfect: 0, good: 0, miss: 0, streak: 0, bestStreak: 0 };
  }

  // notes must be pre-filtered to enabled instruments for efficiency, but we
  // also check inst here. Returns { ok, grade, dt } or null if no candidate.
  judge(notes, inst, now) {
    let best = null, bestAbs = Infinity, bestIdx = -1;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.inst !== inst) continue;
      const dt = n.t - now;
      const abs = Math.abs(dt);
      if (abs > this.windowOk) continue;
      const key = i;
      if (this.consumed.has(key)) continue;
      if (abs < bestAbs) { bestAbs = abs; best = n; bestIdx = i; }
    }
    if (!best) {
      // a hit with no nearby note = extra/wrong
      this.stats.streak = 0;
      return { ok: false, grade: 'extra', dt: null };
    }
    this.consumed.add(bestIdx);
    this.stats.hits++;
    let grade;
    if (bestAbs <= this.windowGood) { grade = 'perfect'; this.stats.perfect++; }
    else { grade = 'good'; this.stats.good++; }
    this.stats.streak++;
    this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);
    return { ok: true, grade, dt: best.t - now };
  }
}

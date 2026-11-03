// settings.js
// Renders the settings panel for mapping each of the 9 pads to a drum
// instrument, and remembers the mapping/key layout per app (localStorage) and
// per song (persisted alongside the song).

import { INSTRUMENTS } from './analyzer.js';
import { DEFAULT_KEYS } from './pads.js';

const LS_KEY = 'drum-trainer:default-mapping';

// A sensible default 3x3 layout (top-left to bottom-right).
// Mirrors common finger-drumming layouts.
export const DEFAULT_MAPPING = [
  'crash',     'hatOpen',   'ride',
  'hatClosed', 'snare',     'tom',
  'kick',      'ghostSnare', 'perc',
];

export function loadDefaultMapping() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.mapping) && parsed.mapping.length === 9) {
        return { mapping: parsed.mapping, keys: parsed.keys || DEFAULT_KEYS.slice() };
      }
    }
  } catch (_) {}
  return { mapping: DEFAULT_MAPPING.slice(), keys: DEFAULT_KEYS.slice() };
}

export function saveDefaultMapping(mapping, keys) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ mapping, keys }));
  } catch (_) {}
}

/**
 * Build the settings UI into `container`.
 * @param {HTMLElement} container
 * @param {{mapping:string[], keys:string[]}} state
 * @param {(mapping:string[], keys:string[])=>void} onChange
 */
export function renderSettings(container, state, onChange) {
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Assign each pad position to a drum. The grid below matches the 3×3 pad layout.';
  container.appendChild(intro);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  const options = [{ id: '', label: '— empty —' }, ...INSTRUMENTS.map(i => ({ id: i.id, label: i.label }))];

  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    cell.className = 'settings-cell';

    const posLabel = document.createElement('div');
    posLabel.className = 'settings-pos';
    posLabel.textContent = `Pad ${i + 1}`;
    cell.appendChild(posLabel);

    const sel = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      if (opt.id === state.mapping[i]) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      state.mapping[i] = sel.value;
      applyColor();
      onChange(state.mapping.slice(), state.keys.slice());
    });
    cell.appendChild(sel);

    const keyWrap = document.createElement('div');
    keyWrap.className = 'settings-key';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = 'Key:';
    const keyInput = document.createElement('input');
    keyInput.maxLength = 1;
    keyInput.value = state.keys[i] || '';
    keyInput.className = 'key-input';
    keyInput.addEventListener('input', () => {
      state.keys[i] = keyInput.value.toLowerCase();
      onChange(state.mapping.slice(), state.keys.slice());
    });
    keyWrap.appendChild(keyLabel);
    keyWrap.appendChild(keyInput);
    cell.appendChild(keyWrap);

    function applyColor() {
      const meta = INSTRUMENTS.find(x => x.id === state.mapping[i]);
      cell.style.borderColor = meta ? meta.color : 'rgba(255,255,255,0.12)';
    }
    applyColor();

    grid.appendChild(cell);
  }
  container.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'settings-actions';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn';
  resetBtn.textContent = 'Reset to default';
  resetBtn.addEventListener('click', () => {
    state.mapping = DEFAULT_MAPPING.slice();
    state.keys = DEFAULT_KEYS.slice();
    renderSettings(container, state, onChange);
    onChange(state.mapping.slice(), state.keys.slice());
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save as default';
  saveBtn.addEventListener('click', () => {
    saveDefaultMapping(state.mapping, state.keys);
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => (saveBtn.textContent = 'Save as default'), 1200);
  });

  actions.appendChild(resetBtn);
  actions.appendChild(saveBtn);
  container.appendChild(actions);
}

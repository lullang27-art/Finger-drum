// app.js — orchestrates the whole app.

import { INSTRUMENTS, INSTRUMENT_MAP, decodeFile, analyze } from './analyzer.js';
import * as store from './storage.js';
import { Player } from './player.js';
import { NoteRoll } from './roll.js';
import { PadGrid, Judge, DEFAULT_KEYS } from './pads.js';
import {
  loadDefaultMapping, renderSettings, DEFAULT_MAPPING,
} from './settings.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  song: null,            // currently loaded full song object
  chart: null,           // { notes, bpm, duration }
  lanes: [],             // instrument ids present in this song (ordered)
  enabled: new Set(),    // enabled instrument ids (practice targets)
  mapping: DEFAULT_MAPPING.slice(),
  keys: DEFAULT_KEYS.slice(),
  rate: 1,
  countIn: true,
};

let player = null;
let roll = null;
let pads = null;
let judge = new Judge();
let rafId = null;

// ---------------------------------------------------------------------------
// Screen navigation
// ---------------------------------------------------------------------------

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function renderLibrary() {
  const list = $('#library-list');
  const songs = await store.listSongs();
  const { usage, quota } = await store.estimateUsage();
  $('#storage-info').textContent = quota
    ? `Stored on device: ${fmtBytes(usage)} / ${fmtBytes(quota)}`
    : '';

  if (!songs.length) {
    list.innerHTML = `<div class="empty-state">
      <p>No songs yet.</p>
      <p class="muted">Upload an MP3 to extract its drum part and start practicing.</p>
    </div>`;
    return;
  }
  list.innerHTML = '';
  for (const s of songs) {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.innerHTML = `
      <div class="song-main">
        <div class="song-name">${escapeHtml(s.name)}</div>
        <div class="song-meta muted">${fmtTime(s.duration)} · ${s.bpm || '?'} BPM · ${s.noteCount} hits</div>
      </div>
      <div class="song-actions">
        <button class="btn btn-primary" data-play="${s.id}">Practice</button>
        <button class="btn btn-ghost" data-del="${s.id}">Delete</button>
      </div>`;
    list.appendChild(card);
  }
  list.querySelectorAll('[data-play]').forEach(b =>
    b.addEventListener('click', () => openSong(b.dataset.play)));
  list.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      if (confirm('Delete this song from your device?')) {
        await store.deleteSong(b.dataset.del);
        renderLibrary();
      }
    }));
}

// ---------------------------------------------------------------------------
// Conversion flow
// ---------------------------------------------------------------------------

async function handleFile(file) {
  if (!file) return;
  showScreen('screen-convert');
  const prog = $('#convert-progress');
  const bar = $('#convert-bar');
  const msg = $('#convert-msg');
  $('#convert-filename').textContent = file.name;
  prog.classList.remove('hidden');
  bar.style.width = '0%';
  msg.textContent = 'Reading file…';

  try {
    const arrayBuffer = await file.arrayBuffer();
    msg.textContent = 'Decoding audio…';
    const audioBuffer = await decodeFile(arrayBuffer);

    const chart = await analyze(audioBuffer, (p, m) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      if (m) msg.textContent = m;
    });

    const defaults = loadDefaultMapping();
    const lanes = buildLanes(chart.notes);
    const song = {
      id: cryptoId(),
      name: file.name.replace(/\.[^.]+$/, ''),
      createdAt: Date.now(),
      duration: chart.duration,
      bpm: chart.bpm,
      audio: arrayBuffer,
      mime: file.type || 'audio/mpeg',
      chart,
      lanes,
      enabled: lanes.slice(),       // all on by default
      mapping: defaults.mapping,
      keys: defaults.keys,
      rate: 1,
    };
    await store.saveSong(song);
    await store.requestPersistence();

    msg.textContent = `Done — found ${chart.notes.length} drum hits.`;
    bar.style.width = '100%';
    setTimeout(() => openSong(song.id, song), 500);
  } catch (err) {
    console.error(err);
    msg.textContent = 'Could not process this file: ' + (err.message || err);
    $('#convert-back').classList.remove('hidden');
  }
}

function buildLanes(notes) {
  // Order lanes by the canonical instrument order, keeping only those present.
  const present = new Set(notes.map(n => n.inst));
  return INSTRUMENTS.map(i => i.id).filter(id => present.has(id));
}

// ---------------------------------------------------------------------------
// Play screen
// ---------------------------------------------------------------------------

async function openSong(id, preloaded = null) {
  const song = preloaded || await store.getSong(id);
  if (!song) return;
  state.song = song;
  state.chart = song.chart;
  state.lanes = song.lanes && song.lanes.length ? song.lanes : buildLanes(song.chart.notes);
  state.enabled = new Set(song.enabled && song.enabled.length ? song.enabled : state.lanes);
  state.mapping = song.mapping || DEFAULT_MAPPING.slice();
  state.keys = song.keys || DEFAULT_KEYS.slice();
  state.rate = song.rate || 1;

  // Decode audio for playback
  const audioBuffer = await decodeFile(song.audio);

  if (player) player.destroy();
  player = new Player();
  await player.init(audioBuffer);
  player.bpm = song.bpm || 120;
  player.setRate(state.rate);
  player.onEnded = () => { stopLoop(); updateTransportUI(); };

  // Build roll
  if (!roll) roll = new NoteRoll($('#roll-canvas'));
  roll.setLanes(state.lanes);
  roll.setNotes(song.chart.notes);
  roll.setEnabled(state.enabled);
  roll.setBpm(song.bpm || 120);
  roll.getTime = () => player.currentTime;

  // Build pads
  if (!pads) {
    pads = new PadGrid($('#pad-grid'));
    pads.onHit = onPadHit;
  }
  pads.setMapping(state.mapping);
  pads.setKeys(state.keys);

  judge.reset();

  renderLaneLabels();
  renderTrackToggles();
  $('#song-title').textContent = song.name;
  $('#speed-range').value = Math.round(state.rate * 100);
  $('#speed-value').textContent = `${Math.round(state.rate * 100)}%`;
  updateStatsUI();
  updateTransportUI();

  showScreen('screen-play');
  startLoop();
}

function renderLaneLabels() {
  const wrap = $('#lane-labels');
  wrap.innerHTML = '';
  for (const id of state.lanes) {
    const meta = INSTRUMENT_MAP[id];
    const el = document.createElement('div');
    el.className = 'lane-label' + (state.enabled.has(id) ? '' : ' off');
    el.innerHTML = `<span class="lane-dot" style="background:${meta.color}"></span>${meta.label}`;
    wrap.appendChild(el);
  }
}

function renderTrackToggles() {
  const wrap = $('#track-toggles');
  wrap.innerHTML = '';
  for (const id of state.lanes) {
    const meta = INSTRUMENT_MAP[id];
    const btn = document.createElement('button');
    btn.className = 'track-toggle' + (state.enabled.has(id) ? ' on' : '');
    btn.innerHTML = `<span class="dot" style="background:${meta.color}"></span>${meta.label}`;
    btn.addEventListener('click', () => {
      if (state.enabled.has(id)) state.enabled.delete(id);
      else state.enabled.add(id);
      btn.classList.toggle('on', state.enabled.has(id));
      roll.setEnabled(state.enabled);
      renderLaneLabels();
      persistSongPrefs();
    });
    wrap.appendChild(btn);
  }
}

function onPadHit(inst, index, fromUser) {
  player && player.resume();
  player && player.playDrum(inst, 'user');
  roll && roll.flashLane(inst);

  if (fromUser && player && player.playing) {
    // Only judge enabled instruments
    if (state.enabled.has(inst)) {
      const res = judge.judge(state.chart.notes, inst, player.currentTime);
      roll.judge(inst, res.ok);
      updateStatsUI();
    }
  }
}

// Guide-note auto-play: when a note of an enabled track crosses the head and
// the user hasn't hit it, optionally preview it (controlled by GUIDE volume).
let lastGuideScan = 0;
function scanGuideNotes() {
  if (!player || !player.playing) return;
  const now = player.currentTime;
  for (const n of state.chart.notes) {
    if (n.t <= now && n.t > lastGuideScan) {
      if (state.enabled.has(n.inst)) {
        roll.flashLane(n.inst);
        if (player.guideGain.gain.value > 0.02) {
          player.playDrum(n.inst, 'guide');
        }
      }
    }
  }
  lastGuideScan = now;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function startLoop() {
  stopLoop();
  const tick = () => {
    scanGuideNotes();
    roll.render();
    updateSeekUI();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ---------------------------------------------------------------------------
// Transport UI
// ---------------------------------------------------------------------------

function updateTransportUI() {
  const btn = $('#play-pause');
  btn.textContent = player && player.playing ? '⏸' : '▶';
  btn.classList.toggle('playing', !!(player && player.playing));
}

function updateSeekUI() {
  if (!player) return;
  const cur = player.currentTime;
  const dur = player.duration || 1;
  $('#seek-range').value = Math.round((cur / dur) * 1000);
  $('#time-current').textContent = fmtTime(cur);
  $('#time-total').textContent = fmtTime(dur);
}

function updateStatsUI() {
  const s = judge.stats;
  $('#stat-streak').textContent = s.streak;
  $('#stat-hits').textContent = s.hits;
  const totalTargets = s.hits + s.miss;
  const acc = s.hits ? Math.round((s.perfect + s.good) / s.hits * 100) : 100;
  $('#stat-acc').textContent = `${acc}%`;
}

// ---------------------------------------------------------------------------
// Persist per-song prefs (enabled tracks, mapping, speed)
// ---------------------------------------------------------------------------

let persistTimer = null;
function persistSongPrefs() {
  if (!state.song) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    store.updateSongSettings(state.song.id, {
      enabled: Array.from(state.enabled),
      mapping: state.mapping,
      keys: state.keys,
      rate: state.rate,
    });
  }, 400);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  // Upload inputs
  const fileInput = $('#file-input');
  $('#upload-btn').addEventListener('click', () => fileInput.click());
  $('#empty-upload')?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

  // Drag & drop
  const drop = $('#drop-zone');
  if (drop) {
    ['dragenter', 'dragover'].forEach(ev =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
    ['dragleave', 'drop'].forEach(ev =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  }

  // Nav
  $('#nav-library').addEventListener('click', () => { leavePlay(); renderLibrary(); showScreen('screen-library'); });
  $('#convert-back').addEventListener('click', () => { renderLibrary(); showScreen('screen-library'); });
  $('#back-to-library').addEventListener('click', () => { leavePlay(); renderLibrary(); showScreen('screen-library'); });

  // Transport
  $('#play-pause').addEventListener('click', () => {
    if (!player) return;
    player.resume();
    player.toggle();
    lastGuideScan = player.currentTime;
    updateTransportUI();
  });
  $('#restart').addEventListener('click', () => {
    if (!player) return;
    player.seek(0);
    judge.reset();
    lastGuideScan = 0;
    updateStatsUI();
  });
  $('#seek-range').addEventListener('input', (e) => {
    if (!player) return;
    const dur = player.duration || 1;
    player.seek((e.target.value / 1000) * dur);
    lastGuideScan = player.currentTime;
    judge.consumed.clear();
  });

  // Speed
  const speed = $('#speed-range');
  speed.addEventListener('input', () => {
    state.rate = speed.value / 100;
    $('#speed-value').textContent = `${speed.value}%`;
    if (player) player.setRate(state.rate);
    persistSongPrefs();
  });
  $$('.speed-preset').forEach(b => b.addEventListener('click', () => {
    const r = parseFloat(b.dataset.rate);
    state.rate = r;
    speed.value = Math.round(r * 100);
    $('#speed-value').textContent = `${Math.round(r * 100)}%`;
    if (player) player.setRate(r);
    persistSongPrefs();
  }));

  // Mixer
  bindMixer('vol-backing', 'backing');
  bindMixer('vol-guide', 'guide');
  bindMixer('vol-user', 'user');

  // Metronome
  const metro = $('#metro-toggle');
  metro.addEventListener('change', () => {
    if (player) player.setMetronome(metro.checked, state.song ? state.song.bpm : 120);
  });

  // Settings
  $('#open-settings').addEventListener('click', () => {
    renderSettings($('#settings-body'), { mapping: state.mapping, keys: state.keys }, (mapping, keys) => {
      state.mapping = mapping;
      state.keys = keys;
      if (pads) { pads.setMapping(mapping); pads.setKeys(keys); }
      persistSongPrefs();
    });
    showScreen('screen-settings');
  });
  $('#settings-back').addEventListener('click', () => showScreen('screen-play'));

  // Keyboard transport (space = play/pause)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && $('#screen-play').classList.contains('active')) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'button') return;
      e.preventDefault();
      if (player) { player.resume(); player.toggle(); updateTransportUI(); }
    }
  });
}

function bindMixer(inputId, channel) {
  const el = $('#' + inputId);
  if (!el) return;
  el.addEventListener('input', () => {
    if (player) player.setVolume(channel, el.value / 100);
  });
}

function leavePlay() {
  stopLoop();
  if (player) { player.pause(); }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cryptoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wire();
  await renderLibrary();
  showScreen('screen-library');

  // Register service worker for offline use
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (_) {}
  }
}

boot();

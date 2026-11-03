// analyzer.js
// Decodes an audio file, detects drum onsets, and classifies each hit into a
// drum instrument using spectral-band energy heuristics. This is a pure
// in-browser "transcription" of the drum part — no server, no ML model.
//
// Output: a "chart" object:
// {
//   duration: <seconds>,
//   bpm: <estimated>,
//   notes: [{ t: <seconds>, inst: <instrumentId>, vel: 0..1 }, ...]
// }

export const INSTRUMENTS = [
  { id: 'kick',       label: 'Kick',          color: '#7ed957' },
  { id: 'snare',      label: 'Snare',         color: '#ffd93d' },
  { id: 'ghostSnare', label: 'Ghost Snare',   color: '#caa94a' },
  { id: 'hatClosed',  label: 'Hat (Closed)',  color: '#ffa63d' },
  { id: 'hatOpen',    label: 'Hat (Open)',    color: '#ff6b6b' },
  { id: 'tom',        label: 'Tom',           color: '#4dabf7' },
  { id: 'crash',      label: 'Crash',         color: '#b197fc' },
  { id: 'ride',       label: 'Ride',          color: '#63e6be' },
  { id: 'perc',       label: 'Perc',          color: '#ff8cc6' },
];

export const INSTRUMENT_MAP = Object.fromEntries(INSTRUMENTS.map(i => [i.id, i]));

// ---- Decoding -------------------------------------------------------------

export async function decodeFile(arrayBuffer) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  // decodeAudioData needs a copy because it detaches the buffer
  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  await ctx.close();
  return buf;
}

// ---- Analysis pipeline ----------------------------------------------------

/**
 * @param {AudioBuffer} audioBuffer
 * @param {(p:number,msg:string)=>void} onProgress
 */
export async function analyze(audioBuffer, onProgress = () => {}) {
  const sr = audioBuffer.sampleRate;
  const channel = toMono(audioBuffer);
  onProgress(0.1, 'Preparing audio…');

  // STFT settings. 2048-pt gives ~21 Hz bin resolution — enough to resolve
  // kick fundamental energy below 120 Hz (critical for kick detection).
  const fftSize = 2048;
  const hop = 512; // ~11.6ms at 44.1k
  const win = hannWindow(fftSize);

  const frames = Math.max(0, Math.floor((channel.length - fftSize) / hop));
  if (frames <= 0) {
    return { duration: audioBuffer.duration, bpm: 0, notes: [] };
  }

  const fft = new FFT(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  // Per-frame band energies + spectral flux for onset detection
  const flux = new Float32Array(frames);
  const bandLow = new Float32Array(frames);   // kick region
  const bandMid = new Float32Array(frames);   // snare/body region
  const bandHigh = new Float32Array(frames);  // cymbals/hats
  const bandAir = new Float32Array(frames);   // very high (open hat/crash shimmer)
  const centroid = new Float32Array(frames);

  let prevMag = new Float32Array(fftSize / 2);
  const nyquist = sr / 2;
  const binHz = nyquist / (fftSize / 2);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = channel[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    let fluxSum = 0, lo = 0, mid = 0, hi = 0, air = 0;
    let cNum = 0, cDen = 0;
    for (let k = 1; k < fftSize / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const diff = mag - prevMag[k];
      if (diff > 0) fluxSum += diff; // half-wave rectified flux
      prevMag[k] = mag;

      const hz = k * binHz;
      if (hz < 120) lo += mag;
      else if (hz < 2000) mid += mag;
      else if (hz < 8000) hi += mag;
      else air += mag;

      cNum += hz * mag;
      cDen += mag;
    }
    flux[f] = fluxSum;
    bandLow[f] = lo;
    bandMid[f] = mid;
    bandHigh[f] = hi;
    bandAir[f] = air;
    centroid[f] = cDen > 0 ? cNum / cDen : 0;

    if ((f & 511) === 0) {
      onProgress(0.1 + 0.6 * (f / frames), 'Analyzing spectrum…');
      await yieldToUI();
    }
  }

  onProgress(0.72, 'Detecting onsets…');
  const onsets = pickOnsets(flux, hop, sr);

  onProgress(0.85, 'Classifying drums…');
  const notes = [];
  for (const o of onsets) {
    const f = o.frame;
    // Average band energy over the attack frame and the one right after for a
    // stable spectral fingerprint, without bleeding into neighboring hits.
    const a = f, b = Math.min(frames - 1, f + 1);
    let lo = 0, mid = 0, hi = 0, air = 0, cen = 0, cnt = 0;
    for (let k = a; k <= b; k++) {
      lo += bandLow[k]; mid += bandMid[k]; hi += bandHigh[k]; air += bandAir[k];
      cen += centroid[k]; cnt++;
    }
    cen /= cnt;
    const inst = classify(
      lo, mid, hi, air, cen,
      tailEnergy(bandHigh, bandAir, f, 18),
      o.strength
    );
    notes.push({ t: o.time, inst, vel: o.strength });
  }

  onProgress(0.95, 'Estimating tempo…');
  const bpm = estimateBpm(onsets.map(o => o.time));

  onProgress(1, 'Done');
  return { duration: audioBuffer.duration, bpm, notes };
}

// ---- Helpers --------------------------------------------------------------

function toMono(buffer) {
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += d[i] / ch;
  }
  return out;
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
}

// Adaptive peak picking on the spectral-flux onset detection function.
function pickOnsets(flux, hop, sr) {
  const n = flux.length;
  // Normalize
  let max = 0;
  for (let i = 0; i < n; i++) if (flux[i] > max) max = flux[i];
  if (max <= 0) return [];
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = flux[i] / max;

  // Moving-average threshold
  const winHalf = 8;
  const thFactor = 1.4;
  const thBias = 0.04;
  const minGapFrames = Math.round((0.045 * sr) / hop); // 45ms refractory

  const onsets = [];
  let lastIdx = -minGapFrames;
  for (let i = 1; i < n - 1; i++) {
    let sum = 0, cnt = 0;
    for (let j = i - winHalf; j <= i + winHalf; j++) {
      if (j >= 0 && j < n) { sum += norm[j]; cnt++; }
    }
    const localMean = sum / cnt;
    const th = localMean * thFactor + thBias;
    if (norm[i] > th && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1]) {
      if (i - lastIdx >= minGapFrames) {
        onsets.push({ frame: i, time: (i * hop) / sr, strength: Math.min(1, norm[i]) });
        lastIdx = i;
      }
    }
  }
  return onsets;
}

// Sum of high/air energy over the next `n` frames — long tail => open hat/cymbal.
function tailEnergy(bandHigh, bandAir, f, n) {
  let s = 0, base = (bandHigh[f] + bandAir[f]) || 1e-6;
  for (let k = f + 2; k < f + 2 + n && k < bandHigh.length; k++) {
    s += (bandHigh[k] + bandAir[k]);
  }
  return s / (base * n);
}

function classify(lo, mid, hi, air, centroid, tail, vel) {
  const total = lo + mid + hi + air + 1e-9;
  const pLo = lo / total;        // kick region (<120 Hz)
  const pMid = mid / total;      // snare/body (120–2000 Hz)
  const pHi = (hi + air) / total; // cymbals/hats (>2000 Hz)

  // Kick: low band clearly dominant and a dark (low-centroid) attack.
  if (pLo > 0.45 && centroid < 600) return 'kick';

  // Cymbal / hat family: high + air dominant, very bright centroid.
  if (pHi > 0.5 && centroid > 4000) {
    if (tail > 0.3) {
      // sustained, shimmering tail
      return centroid > 9000 ? 'crash' : 'hatOpen';
    }
    // short, choked attack
    return centroid > 10500 ? 'ride' : 'hatClosed';
  }

  // Snare: significant mid-band body, moderate centroid, broadband.
  if (pMid > 0.18 && centroid < 6000) {
    return vel < 0.28 ? 'ghostSnare' : 'snare';
  }

  // Dark low-mid body => tom.
  if (pLo + pMid > 0.5 && centroid < 1500) return 'tom';

  // Fallbacks by dominant band.
  if (pLo >= pMid && pLo >= pHi) return 'kick';
  if (pHi >= pMid) return 'hatClosed';
  return 'snare';
}

// Rough tempo estimate via inter-onset-interval histogram.
function estimateBpm(times) {
  if (times.length < 4) return 0;
  const iois = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0.1 && d < 2) iois.push(d);
  }
  if (!iois.length) return 0;
  // Histogram of BPM candidates
  const bins = {};
  for (const d of iois) {
    let bpm = 60 / d;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const key = Math.round(bpm);
    bins[key] = (bins[key] || 0) + 1;
  }
  let best = 0, bestCount = 0;
  for (const k in bins) {
    if (bins[k] > bestCount) { bestCount = bins[k]; best = +k; }
  }
  return best;
}

// ---- Minimal radix-2 FFT (in-place) --------------------------------------

class FFT {
  constructor(size) {
    this.size = size;
    this.levels = Math.log2(size);
    if (this.levels % 1 !== 0) throw new Error('FFT size must be a power of 2');
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  transform(re, im) {
    const n = this.size;
    // Bit reversal
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tpre = re[j + half] * this.cosTable[k] + im[j + half] * this.sinTable[k];
          const tpim = -re[j + half] * this.sinTable[k] + im[j + half] * this.cosTable[k];
          re[j + half] = re[j] - tpre;
          im[j + half] = im[j] - tpim;
          re[j] += tpre;
          im[j] += tpim;
        }
      }
    }
  }
}

# 🥁 Finger Drum Trainer

Upload an MP3 → the app transcribes its **drum part on your device** → practice
finger drumming on a **3×3 pad grid** while the notes scroll toward a play head
(like the reference layout). Converted songs are **saved on your phone** and can
be re-practiced anytime, **fully offline**.

It's a **PWA (web app)** — open it in a mobile browser and tap *Add to Home
Screen* to install it like a native app. No account, no server, no upload of
your audio anywhere; all processing happens locally in the browser.

## Features

- **MP3 → drum notes (on-device):** decodes the audio, detects drum onsets via
  spectral flux, and classifies each hit into kick / snare / ghost snare /
  closed hat / open hat / tom / ride / crash / perc using spectral-band
  analysis. Also estimates the song's BPM.
- **Scrolling note highway** with a fixed play head, one lane per instrument,
  beat grid, lane glows, and hit/miss judgment rings.
- **3×3 pad grid** — tap (touch/mouse) or use keyboard keys. Hits are
  synthesized and timing-judged against the chart (streak / accuracy / hit
  counters).
- **Per-track practice On/Off** — disable lanes you don't want; only enabled
  tracks are judged, so you can isolate e.g. just the kick + snare.
- **Speed control** — 25%–150% with 50/75/100% presets (pitch changes with
  speed, as with a turntable).
- **Guide / backing / your-notes mixer + metronome** — fade the original track,
  turn on an audible "guide" that plays the correct drums, and/or a click.
- **Configurable pad → instrument mapping** (and keyboard keys) in Settings.
  Save your layout as the default for future songs.
- **On-device library** — every converted song (original audio + chart +
  your settings) is stored in IndexedDB. Re-practice offline, delete anytime.

## Run it

Any static file server works (a server is required — ES modules and the service
worker don't run from `file://`).

```bash
cd drum-trainer
npm install        # installs http-server (dev dependency)
npm start          # serves at http://localhost:8080
```

Or with Python: `python3 -m http.server 8080`.

Open the URL on your phone (same Wi-Fi) or deploy the folder to any static host
(GitHub Pages, Netlify, Vercel, Cloudflare Pages). Over HTTPS the service worker
registers and the app becomes installable + offline-capable.

### Keyboard layout (default)

```
Q W E
A S D   ← maps to the 3×3 pads (top-left → bottom-right)
Z X C
Space = play/pause
```

## How the drum extraction works (and its limits)

This app does **on-device drum transcription**, not full audio stem separation.

Pipeline: mono mix → short-time FFT (2048-pt) → half-wave-rectified spectral
flux → adaptive peak-picking for onsets → per-onset band-energy fingerprint
(low / low-mid / high / air) + spectral centroid + decay tail → instrument
classification.

**What it does well:** timing of hits, BPM, and the overall kick/snare/hat
shape of a groove — which is exactly what you practice.

**Honest limitations:**
- When two drums hit at the *exact same instant* (e.g. kick + hi-hat on a
  downbeat), the louder/brighter one can mask the other, so some simultaneous
  kicks may be missed. This is the fundamental reason production apps use heavy
  ML models (e.g. Demucs) for true stem separation.
- Cymbal sub-types (closed hat vs ride, open hat vs crash) are inferred from
  brightness/decay and can be mislabeled. Fix any lane instantly in **Settings**
  by remapping it, and use **track On/Off** to isolate what you practice.

If you later want studio-grade separation, the code is structured so a backend
(Demucs) step could replace the `analyze()` call in `js/analyzer.js` and feed
the same chart format to the rest of the app unchanged.

## Project structure

```
drum-trainer/
├── index.html              # app shell (Library / Convert / Play / Settings)
├── manifest.webmanifest    # PWA install metadata
├── sw.js                   # service worker (offline app shell)
├── css/styles.css          # dark UI
├── icons/                  # app icons
└── js/
    ├── app.js              # orchestration, screens, transport, persistence
    ├── analyzer.js         # decode → onset detection → drum classification
    ├── player.js           # playback, speed, mixer, metronome, drum synth
    ├── roll.js             # scrolling note highway (Canvas)
    ├── pads.js             # 3×3 pad grid + input + timing judge
    ├── settings.js         # pad↔instrument mapping UI
    └── storage.js          # IndexedDB library (save/load/delete songs)
```

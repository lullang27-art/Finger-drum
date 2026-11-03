// storage.js
// Persists converted songs (original audio bytes + drum chart + settings)
// in IndexedDB so they can be re-practiced anytime, fully offline.

const DB_NAME = 'drum-trainer';
const DB_VERSION = 1;
const STORE = 'songs';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

export async function saveSong(song) {
  // song: { id, name, createdAt, duration, bpm, audio:ArrayBuffer, mime,
  //         chart:{notes,...}, mapping, settings }
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(song);
    req.onsuccess = () => resolve(song.id);
    req.onerror = () => reject(req.error);
  });
}

export async function getSong(id) {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listSongs() {
  // Returns metadata only (no audio bytes) for a light library view.
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const v = cur.value;
        out.push({
          id: v.id, name: v.name, createdAt: v.createdAt,
          duration: v.duration, bpm: v.bpm,
          noteCount: v.chart ? v.chart.notes.length : 0,
        });
        cur.continue();
      } else {
        out.sort((a, b) => b.createdAt - a.createdAt);
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSong(id) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function updateSongSettings(id, patch) {
  const song = await getSong(id);
  if (!song) return;
  Object.assign(song, patch);
  return saveSong(song);
}

// Ask the browser to keep our data (prevents eviction on mobile).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch (_) {}
  return false;
}

export async function estimateUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (_) {}
  return { usage: 0, quota: 0 };
}

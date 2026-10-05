// Keeps the user's background photos in IndexedDB. When the browser blocks storage
// (some private modes), it falls back to memory so the app still works for the session.

const DB_NAME = 'backdrop';
const STORE = 'plates';
const memory = new Map();
let dbPromise = null;

function openDb() {
  if (!('indexedDB' in self)) return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise ??= new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
  );
}

export const plateStore = {
  persistent: true,

  async all() {
    try {
      return (await run('readonly', (s) => s.getAll())) || [];
    } catch (err) {
      console.warn('Photo storage unavailable', err);
      this.persistent = false;
      return [...memory.values()];
    }
  },

  async put(rec) {
    memory.set(rec.id, rec);
    if (!this.persistent) return;
    try {
      await run('readwrite', (s) => s.put(rec));
    } catch (err) {
      console.warn('Could not save photo', err);
      this.persistent = false;
    }
  },

  async del(id) {
    memory.delete(id);
    if (!this.persistent) return;
    try {
      await run('readwrite', (s) => s.delete(id));
    } catch (err) {
      console.warn('Could not delete photo', err);
    }
  },
};

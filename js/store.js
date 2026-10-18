// Where the web version keeps things: in this browser, on this computer.
//   Saved packets and the usage log: IndexedDB (the browser's built-in database).
//   The API key: this tab only (sessionStorage), or this browser if the teacher ticks "Remember".

const DB_NAME = "algebro";
const DB_VERSION = 1;
const KEY_NAME = "claude-api-key";

export class StorageError extends Error {}

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      reject(blocked());
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("packets")) db.createObjectStore("packets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("usage")) db.createObjectStore("usage", { autoIncrement: true });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(blocked());
    request.onblocked = () => reject(new StorageError("The app is open in another tab that's out of date. Close the other tabs and reload."));
  });
  dbPromise.catch(() => { dbPromise = null; }); // allow a retry later
  return dbPromise;
}

const blocked = () => new StorageError(
  "This browser isn't letting the app save anything (this can happen in private browsing or with strict privacy settings). "
  + "Use a regular window to save packets.");

async function run(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(new StorageError(`Couldn't save in this browser: ${tx.error?.message || "unknown error"}.`
      + (tx.error?.name === "QuotaExceededError" ? " The browser's storage is full." : "")));
    tx.onabort = tx.onerror;
  });
}

export const db = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  all: (store) => run(store, "readonly", (s) => s.getAll()),
  put: (store, value, key) => run(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  add: (store, value) => run(store, "readwrite", (s) => s.add(value)),
  delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  clear: (store) => run(store, "readwrite", (s) => s.clear()),
};

// ---- The API key ----

function storageGet(storage) {
  try { return storage.getItem(KEY_NAME) || ""; } catch { return ""; }
}

export const keyStore = {
  get: () => storageGet(sessionStorage) || storageGet(localStorage),
  remembered: () => Boolean(storageGet(localStorage)),
  save(key, remember) {
    try {
      if (remember) {
        localStorage.setItem(KEY_NAME, key);
        sessionStorage.removeItem(KEY_NAME);
      } else {
        sessionStorage.setItem(KEY_NAME, key);
        localStorage.removeItem(KEY_NAME);
      }
    } catch {
      throw blocked();
    }
  },
  remove() {
    for (const storage of [sessionStorage, localStorage]) {
      try { storage.removeItem(KEY_NAME); } catch { /* nothing stored */ }
    }
  },
};

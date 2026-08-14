(function () {
  const DB_NAME = "goodsAuditSourceCacheV1";
  const DB_VERSION = 3;
  const STORE = "sources";

  function modeKey(mode) {
    return mode === "text" ? "text" : "file";
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
          return;
        }
        if (e.oldVersion < 3) {
          e.target.transaction.objectStore(STORE).clear();
        }
      };
    });
  }

  async function saveSourceCache(mode, payload) {
    const key = modeKey(mode);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        {
          text: String(payload?.text || ""),
          fileName: String(payload?.fileName || ""),
          fileNames: Array.isArray(payload?.fileNames)
            ? payload.fileNames.map((name) => String(name || "")).filter(Boolean)
            : [],
          sourceExportData: payload?.sourceExportData ?? null,
          updatedAt: Date.now(),
        },
        key
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadSourceCache(mode) {
    const key = modeKey(mode);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearSourceCache(mode) {
    const key = modeKey(mode);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAllSourceCache() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  globalThis.__goodsAuditCache = {
    saveSourceCache,
    loadSourceCache,
    clearSourceCache,
    clearAllSourceCache,
  };
})();

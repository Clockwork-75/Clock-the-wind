// Minimal IndexedDB key/value store (forecasts, routes, settings that are too big for localStorage)
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('clock-the-wind', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
export const kv = {
  get: k => tx('readonly', s => s.get(k)),
  set: (k, v) => tx('readwrite', s => s.put(v, k)),
  del: k => tx('readwrite', s => s.delete(k)),
  keys: () => tx('readonly', s => s.getAllKeys()),
};

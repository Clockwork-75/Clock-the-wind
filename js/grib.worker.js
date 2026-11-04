// GRIB decoding off the main thread: several cores decode in parallel and the map stays smooth while
// large regional files (DWD ICON for all of Europe) are being cut down to the area you look at.
import { decodeGrib, cropMsg } from './grib.js';

self.onmessage = (e) => {
  const { id, buf, bbox, maxPts } = e.data;
  try {
    const out = [];
    for (const m of decodeGrib(buf)) { const c = cropMsg(m, bbox, maxPts); if (c) out.push(c); }
    self.postMessage({ id, msgs: out }, out.map(m => m.vals.buffer));
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};

// Land/sea raster decoded from data/landmask.bin (RLE, built by tools/build_coast.py from OSM coastline).
// 1 = land, 0 = sea. Row 0 is the northern edge.

export function decodeLandmask(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CTWM') throw new Error('bad landmask');
  const NR = dv.getUint32(4, true), NC = dv.getUint32(8, true);
  const lat0 = dv.getFloat64(12, true), lat1 = dv.getFloat64(20, true);
  const lon0 = dv.getFloat64(28, true), lon1 = dv.getFloat64(36, true);
  const bytes = new Uint8Array(buf, 44);
  const data = new Uint8Array(NR * NC);
  let p = 0;
  const varint = () => { let n = 0, s = 0, b; do { b = bytes[p++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return n; };
  for (let r = 0; r < NR; r++) {
    const nruns = varint();
    let c = r * NC, land = 0;
    for (let k = 0; k < nruns; k++) {
      const n = varint();
      if (land) data.fill(1, c, c + n);
      c += n; land ^= 1;
    }
  }
  return { NR, NC, lat0, lat1, lon0, lon1, dlat: (lat1 - lat0) / NR, dlon: (lon1 - lon0) / NC, data };
}

export function isLand(m, lat, lon) {
  if (!m) return false;
  const r = Math.floor((m.lat1 - lat) / m.dlat), c = Math.floor((lon - m.lon0) / m.dlon);
  if (r < 0 || r >= m.NR || c < 0 || c >= m.NC) return false; // outside mask: assume open sea
  return m.data[r * m.NC + c] === 1;
}

// true if straight segment crosses land (sampled at ~0.5 cell)
export function segmentHitsLand(m, lat1, lon1, lat2, lon2) {
  if (!m) return false;
  const n = Math.ceil(Math.max(Math.abs(lat2 - lat1) / m.dlat, Math.abs(lon2 - lon1) / m.dlon) * 2) + 1;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (isLand(m, lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t)) return true;
  }
  return false;
}

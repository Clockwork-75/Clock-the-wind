// EMODnet Bathymetry DTM (land elevation + sea depth) for the Adriatic, ~135 m cells.
// Codes: 0 land | 1..100 depth 0.1..10 m | 101..180 10..50 m (0.5 m) | 181..254 50..1300 m (17 m) | 255 no data

export const DEPTH_LUT = (() => {
  const t = new Float32Array(256);
  t[0] = -1; t[255] = 999;
  for (let c = 1; c <= 100; c++) t[c] = c / 10;
  for (let c = 101; c <= 180; c++) t[c] = 10 + (c - 101) * 0.5 + 0.25;
  for (let c = 181; c <= 254; c++) t[c] = 50 + (c - 181) * 17 + 8;
  return t;
})();

export async function loadBathy(url = 'data/depth.bin.gz') {
  const r = await fetch(url);
  if (!r.ok) throw new Error('depth ' + r.status);
  let buf;
  if ('DecompressionStream' in self) buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  else throw new Error('preglednik nema DecompressionStream');
  const dv = new DataView(buf);
  const NR = dv.getUint32(4, true), NC = dv.getUint32(8, true);
  const lat0 = dv.getFloat64(12, true), lat1 = dv.getFloat64(20, true), lon0 = dv.getFloat64(28, true), lon1 = dv.getFloat64(36, true);
  return { NR, NC, lat0, lat1, lon0, lon1, dlat: (lat1 - lat0) / NR, dlon: (lon1 - lon0) / NC, codes: new Uint8Array(buf, 44) };
}

export function depthAt(b, lat, lon) {
  if (!b) return NaN;
  const r = Math.floor((b.lat1 - lat) / b.dlat), c = Math.floor((lon - b.lon0) / b.dlon);
  if (r < 0 || r >= b.NR || c < 0 || c >= b.NC) return NaN;
  return DEPTH_LUT[b.codes[r * b.NC + c]];
}

// routing mask in landmask.js format: 1 = blocked (land or shallower than minDepth)
export function routingMask(b, minDepth) {
  const data = new Uint8Array(b.NR * b.NC);
  const blocked = new Uint8Array(256);
  for (let c = 0; c < 256; c++) blocked[c] = (c === 0 || (c !== 255 && DEPTH_LUT[c] < minDepth)) ? 1 : 0;
  const src = b.codes;
  for (let i = 0; i < data.length; i++) data[i] = blocked[src[i]];
  return { NR: b.NR, NC: b.NC, lat0: b.lat0, lat1: b.lat1, lon0: b.lon0, lon1: b.lon1, dlat: b.dlat, dlon: b.dlon, data };
}

// marching squares isobaths for a sub-window of the grid -> array of [lat,lon,lat,lon] segments per level
export function isobaths(b, south, north, west, east, levels, stride = 1) {
  const r0 = Math.max(0, Math.floor((b.lat1 - north) / b.dlat)), r1 = Math.min(b.NR - 2, Math.ceil((b.lat1 - south) / b.dlat));
  const c0 = Math.max(0, Math.floor((west - b.lon0) / b.dlon)), c1 = Math.min(b.NC - 2, Math.ceil((east - b.lon0) / b.dlon));
  // no-data cells (code 255, mostly inland outside the survey) have no depth: contours never run through them
  const D = (r, c) => { const k = b.codes[r * b.NC + c]; if (k === 255) return NaN; const v = DEPTH_LUT[k]; return v < 0 ? 0 : v; };
  const out = levels.map(() => []);
  for (let r = r0; r + stride <= b.NR - 1 && r < r1; r += stride) {
    const la = b.lat1 - (r + 0.5) * b.dlat, la2 = la - b.dlat * stride;
    for (let c = c0; c + stride <= b.NC - 1 && c < c1; c += stride) {
      const lo = b.lon0 + (c + 0.5) * b.dlon, lo2 = lo + b.dlon * stride;
      const a = D(r, c), bb = D(r, c + stride), cc = D(r + stride, c + stride), d = D(r + stride, c);
      if (a !== a || bb !== bb || cc !== cc || d !== d) continue;
      levels.forEach((L, k) => {
        const idx = (a > L ? 8 : 0) | (bb > L ? 4 : 0) | (cc > L ? 2 : 0) | (d > L ? 1 : 0);
        if (idx === 0 || idx === 15) return;
        const t = (p, q) => q === p ? 0.5 : Math.max(0, Math.min(1, (L - p) / (q - p)));   // always on the cell edge
        const top = [la, lo + (lo2 - lo) * t(a, bb)], right = [la + (la2 - la) * t(bb, cc), lo2];
        const bottom = [la2, lo + (lo2 - lo) * t(d, cc)], left = [la + (la2 - la) * t(a, d), lo];
        const seg = (p, q) => out[k].push(p[0], p[1], q[0], q[1]);
        switch (idx) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 5: seg(left, top); seg(bottom, right); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, top); break;
          case 10: seg(top, right); seg(left, bottom); break;
        }
      });
    }
  }
  return out;
}

// Regular lat/lon grid with hourly time steps. Rows start at the SOUTH edge.
// field = { lat0, lon0, dlat, dlon, ny, nx, times:[ms...], vars:{ name: Float32Array(T*ny*nx) } }

export function timeIndex(f, t) {
  const T = f.times;
  if (t <= T[0]) return [0, 0, 0];
  if (t >= T[T.length - 1]) return [T.length - 1, T.length - 1, 0];
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  return [lo, hi, (t - T[lo]) / (T[hi] - T[lo])];
}

export function inside(f, lat, lon) {
  const y = (lat - f.lat0) / f.dlat, x = (lon - f.lon0) / f.dlon;
  return y >= 0 && x >= 0 && y <= f.ny - 1 && x <= f.nx - 1;
}

function bil(a, off, f, x0, y0, tx, ty) {
  const nx = f.nx;
  const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, f.ny - 1);
  const v00 = a[off + y0 * nx + x0], v10 = a[off + y0 * nx + x1];
  const v01 = a[off + y1 * nx + x0], v11 = a[off + y1 * nx + x1];
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  let s = 0, w = 0;
  if (v00 === v00) { s += v00 * w00; w += w00; }
  if (v10 === v10) { s += v10 * w10; w += w10; }
  if (v01 === v01) { s += v01 * w01; w += w01; }
  if (v11 === v11) { s += v11 * w11; w += w11; }
  return w > 1e-6 ? s / w : NaN;
}

// sample variables at lat/lon/time. names: array of var names. returns array of values (NaN if missing)
// A field may carry `ext`: the same model further ahead (days 4–15, coarser in time/space). Past the field's own
// last step the extension is used; past the extension's end the last state stays (frozen, like Windy).
export function sample(f, names, lat, lon, t, out = []) {
  if (f.ext && t > f.times[f.times.length - 1]) {
    own(f.ext, names, lat, lon, t, out);
    if (f.fallback) fillFromFallback(f, names, lat, lon, t, out);
    return out;
  }
  own(f, names, lat, lon, t, out);
  if (f.fallback) fillFromFallback(f, names, lat, lon, t, out);
  return out;
}
// last moment a field (with its extension) has data
export const lastTime = f => f.ext ? Math.max(f.ext.validUntil || f.ext.times[f.ext.times.length - 1], f.times[f.times.length - 1]) : (f.validUntil || f.times[f.times.length - 1]);
function own(f, names, lat, lon, t, out) {
  if (f.ext && t > f.times[f.times.length - 1]) return own(f.ext, names, lat, lon, t, out);
  let y = (lat - f.lat0) / f.dlat, x = (lon - f.lon0) / f.dlon;
  if (y < -0.5 || x < -0.5 || y > f.ny - 0.5 || x > f.nx - 0.5) {
    for (let i = 0; i < names.length; i++) out[i] = NaN;
    return out;
  }
  y = Math.max(0, Math.min(f.ny - 1, y)); x = Math.max(0, Math.min(f.nx - 1, x));
  const x0 = Math.min(Math.floor(x), f.nx - 1), y0 = Math.min(Math.floor(y), f.ny - 1);
  const tx = x - x0, ty = y - y0;
  const [i0, i1, tt] = timeIndex(f, t);
  const N = f.nx * f.ny;
  for (let k = 0; k < names.length; k++) {
    const a = f.vars[names[k]];
    if (!a) { out[k] = NaN; continue; }
    const a0 = bil(a, i0 * N, f, x0, y0, tx, ty);
    if (tt === 0) { out[k] = a0; continue; }
    const a1 = bil(a, i1 * N, f, x0, y0, tx, ty);
    out[k] = a0 === a0 && a1 === a1 ? a0 + (a1 - a0) * tt : (a0 === a0 ? a0 : a1);
  }
  return out;
}

// where the chosen model has no data (outside its domain / area), use the next model in line
function fillFromFallback(f, names, lat, lon, t, out) {
  let missing = false;
  for (let k = 0; k < names.length; k++) if (out[k] !== out[k]) { missing = true; break; }
  if (!missing) return;
  const tmp = [];
  for (const fb of f.fallback) {
    if (t < fb.times[0] - 3600000 || t > (fb.validUntil || fb.times[fb.times.length - 1]) + 3600000) continue;   // outside its forecast time
    sample(fb, names, lat, lon, t, tmp);
    let still = false;
    for (let k = 0; k < names.length; k++) { if (out[k] !== out[k]) { out[k] = tmp[k]; if (out[k] !== out[k]) still = true; } }
    if (!still) return;
  }
}

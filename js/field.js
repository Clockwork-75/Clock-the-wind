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
  // ClockW: valid only for its own hours – before its start or after its end there is simply no ClockW
  if (f.strictTime && (t < f.times[0] - 1800000 || t > (f.validUntil || f.times[f.times.length - 1]) + 1800000)) {
    for (let i = 0; i < names.length; i++) out[i] = NaN;
    return out;
  }
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

// 0..1: how far inside its own grid a point lies – the colours fade out over the last stretch of a model's area
// (at least ~0.12° or 1.2 grid cells) instead of ending in a hard rectangle
export function coverage(f, lat, lon, t, holes = true) {
  if (!f) return 0;
  const g = f.ext && t > f.times[f.times.length - 1] ? f.ext : f;
  const x = (lon - g.lon0) / g.dlon, y = (lat - g.lat0) / g.dlat;
  let e = Math.min(x + 0.5, g.nx - 0.5 - x, y + 0.5, g.ny - 0.5 - y);   // grid cells to the outer edge
  if (e <= 0) return 0;
  const fade = Math.max(1.2, 0.12 / Math.min(g.dlat, g.dlon));
  // a model whose own area ends inside its grid (ICON-D2 south of ~43.2°N, ICON-2I…): fade at that edge too
  if (holes) { const d = validDist(g, fade); if (d) { const xi = Math.max(0, Math.min(g.nx - 1, x)), yi = Math.max(0, Math.min(g.ny - 1, y));
    const x0 = Math.min(g.nx - 2, Math.floor(xi)), y0 = Math.min(g.ny - 2, Math.floor(yi)), tx = xi - x0, ty = yi - y0, nx = g.nx;
    if (x0 >= 0 && y0 >= 0) { const v = d[y0 * nx + x0] * (1 - tx) * (1 - ty) + d[y0 * nx + x0 + 1] * tx * (1 - ty) + d[(y0 + 1) * nx + x0] * (1 - tx) * ty + d[(y0 + 1) * nx + x0 + 1] * tx * ty; e = Math.min(e, v + 0.5); } } }
  if (e <= 0) return 0;
  return e >= fade ? 1 : e / fade;
}
// distance (grid cells, capped) from each cell to the nearest cell without data – computed once per grid
function validDist(g, cap) {
  if (g._vd !== undefined) return g._vd;
  const k = g.vars && (g.vars.u ? 'u' : Object.keys(g.vars)[0]); const a = k && g.vars[k];
  const nx = g.nx, ny = g.ny, N = nx * ny;
  if (!a || !nx || !ny || nx < 2 || ny < 2) return (g._vd = null);
  const d = new Float32Array(N); let holes = false;
  for (let i = 0; i < N; i++) { if (a[i] === a[i]) d[i] = cap; else { d[i] = 0; holes = true; } }
  if (!holes) return (g._vd = null);
  const D = Math.SQRT2;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = y * nx + x; let v = d[i]; if (!v) continue;
    if (x > 0) v = Math.min(v, d[i - 1] + 1); if (y > 0) { v = Math.min(v, d[i - nx] + 1); if (x > 0) v = Math.min(v, d[i - nx - 1] + D); if (x < nx - 1) v = Math.min(v, d[i - nx + 1] + D); } d[i] = v; }
  for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) { const i = y * nx + x; let v = d[i]; if (!v) continue;
    if (x < nx - 1) v = Math.min(v, d[i + 1] + 1); if (y < ny - 1) { v = Math.min(v, d[i + nx] + 1); if (x < nx - 1) v = Math.min(v, d[i + nx + 1] + D); if (x > 0) v = Math.min(v, d[i + nx - 1] + D); } d[i] = v; }
  return (g._vd = d);
}

// time steps where a variable has no values at all (e.g. ECMWF gusts at the analysis hour) are filled from the
// neighbouring steps, so a layer does not blink empty or fall back to another source for one hour
export function fillTimeGaps(f) {
  if (!f || !f.vars || !f.times || f._gapsFilled) return;
  const T = f.times.length, N = (f.nx || 1) * (f.ny || 1);
  for (const k in f.vars) {
    const a = f.vars[k]; if (!a || a.length !== T * N) continue;
    const ok = new Uint8Array(T);
    for (let ti = 0; ti < T; ti++) { const o = ti * N; for (let i = 0; i < N; i += Math.max(1, (N / 64) | 0)) if (a[o + i] === a[o + i]) { ok[ti] = 1; break; } }
    if (!ok.some(Boolean) || ok.every(Boolean)) continue;
    for (let ti = 0; ti < T; ti++) {
      if (ok[ti]) continue;
      let p = ti - 1; while (p >= 0 && !ok[p]) p--;
      let n = ti + 1; while (n < T && !ok[n]) n++;
      const o = ti * N;
      if (p >= 0 && n < T) { const w = (f.times[ti] - f.times[p]) / (f.times[n] - f.times[p]); for (let i = 0; i < N; i++) { const A = a[p * N + i], B = a[n * N + i]; a[o + i] = A === A && B === B ? A + (B - A) * w : (A === A ? A : B); } }
      else { const src = (p >= 0 ? p : n) * N; for (let i = 0; i < N; i++) a[o + i] = a[src + i]; }
    }
  }
  f._gapsFilled = true;
  if (f.ext) fillTimeGaps(f.ext);
}

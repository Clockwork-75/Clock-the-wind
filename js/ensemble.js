// ClockW – our own consensus forecast, built on request from the models you choose.
//
// For every grid point and every hour the chosen models "vote":
//  1. Base weight by model resolution and position: near the coast and islands the high-resolution models
//     (ICON-2I, ICON-D2, HARMONIE, Meteomatics 1 km) count more – only they resolve channel acceleration,
//     wind shadows and turning around the islands. Out in open water the global models (ECMWF, GFS…) count fully.
//  2. Robust agreement: models are compared as wind vectors (direction AND speed). A model far from the
//     others loses weight step by step (iteratively re-weighted mean, Cauchy weights), so one outlier cannot
//     drag the result. Where all models agree the result is their mean.
//  3. Speed is the weighted mean of the models' speeds (a plain vector mean would weaken the wind wherever
//     directions differ); direction comes from the weighted vector mean.
//  4. Confidence 0–100 %: how close the models are to the result (vector spread relative to the wind strength;
//     a rejected outlier counts 30 %: it still signals some doubt).
//
// It is a statistical consensus, not a new weather model: it cannot invent an island effect that no model
// resolves – it gives the models that do resolve it more say.
import { sample } from './field.js';
import { modelById } from './forecast.js';

// Several ClockW forecasts can exist side by side (ClockW1, ClockW2 … each from its own choice of models)
export const isClockW = id => /^clockw\d*$/.test(String(id));
export const clockwMeta = n => ({ id: 'clockw' + n, name: 'ClockW' + n, res: 'konsenzus', color: '#18ffff', note: 'Naša prognoza: konsenzus odabranih modela' });
export const isDerived = id => isClockW(id) || String(id).startsWith('grib:');

const H = 3600000;
// model resolution in km (from the model list; otherwise from its grid)
function resKm(id, f) {
  const m = modelById(id), r = parseFloat(String(m.res || '').replace(',', '.'));
  if (r > 0 && /km/.test(m.res)) return r;
  if (/icon_d2|icon_2i|icon-2i/i.test(id)) return 2.2;
  if (/harmonie/i.test(id)) return 5.5;
  if (/^mm:/.test(id)) return 1;
  if (/icon_eu/i.test(id)) return 7;
  return f && f.dlat ? f.dlat * 111 : 25;
}
// how much a model counts at a place with coastal complexity c (0 = open sea, 1 = among islands / along the coast)
function baseWeight(id, km, c) {
  const skill = /ecmwf_ifs|dir_ecmwf|mm:ecmwf/.test(id) ? 1.15 : /gfs/.test(id) ? 0.9 : /aifs/.test(id) ? 0.9 : 1;
  if (km <= 3.5) return skill * (0.9 + 1.6 * c);
  if (km <= 7.5) return skill * (1 + 0.6 * c);
  return skill * Math.max(0.35, 1 - 0.6 * c);
}
// coastal complexity of each grid point from the land mask: land close by (≈4 km) counts most, then ≈10 km
function coastIndex(grid, landAt) {
  const { nx, ny, lat0, lon0, dlat, dlon } = grid, out = new Float32Array(nx * ny);
  if (!landAt) return out;
  const ring = (lat, lon, rDeg) => { let n = 0; const k = 1 / Math.cos(lat * Math.PI / 180);
    for (let a = 0; a < 8; a++) { const t = a * Math.PI / 4; if (landAt(lat + rDeg * Math.cos(t), lon + rDeg * k * Math.sin(t))) n++; } return n / 8; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const lat = lat0 + j * dlat, lon = lon0 + i * dlon;
    if (landAt(lat, lon)) { out[j * nx + i] = 1; continue; }
    out[j * nx + i] = Math.min(1, 1.2 * ring(lat, lon, 0.035) + 0.6 * ring(lat, lon, 0.09) + 0.25 * ring(lat, lon, 0.18));
  }
  return out;
}

// which hours ClockW can cover: from t0 for `hours`, inside what at least two chosen models reach
export function clockwWindow(set, ids, t0, hours) {
  const fs = ids.map(id => set.fields[id]).filter(f => f && f.times);
  const start = Math.ceil(t0 / H) * H;
  const ends = fs.map(f => f.ext ? Math.max(f.validUntil || 0, f.ext.times[f.ext.times.length - 1]) : (f.validUntil || f.times[f.times.length - 1])).sort((a, b) => b - a);
  const reach = ends.length > 1 ? ends[1] : ends[0] || start;   // where at least two models still have data
  const end = Math.min(start + hours * H, reach);
  return { t0: start, t1: end, short: end < start + hours * H };
}

export async function buildClockW({ set, ids, num = 1, t0, hours = 24, landAt, maxPts = 36000, progress = () => {}, signal }) {
  const models = ids.filter(id => set.fields[id] && set.fields[id].times && !isDerived(id));
  if (models.length < 2) throw new Error('Za ClockW odaberi barem dva modela');
  const fs = models.map(id => set.fields[id]);
  const win = clockwWindow(set, models, t0, hours);
  if (win.t1 <= win.t0) throw new Error('Odabrani modeli ne pokrivaju to razdoblje – preuzmi svježu prognozu');
  // grid: the area of the chosen models, at the finest resolution among them (capped in points)
  let s = 90, n = -90, w = 400, e = -400, step = 1;
  for (const f of fs) { s = Math.min(s, f.lat0); n = Math.max(n, f.lat0 + f.dlat * (f.ny - 1)); w = Math.min(w, f.lon0); e = Math.max(e, f.lon0 + f.dlon * (f.nx - 1)); step = Math.min(step, f.dlat); }
  if (set.bbox) { s = Math.max(s, set.bbox.s - 0.3); n = Math.min(n, set.bbox.n + 0.3); w = Math.max(w, set.bbox.w - 0.3); e = Math.min(e, set.bbox.e + 0.3); }
  step = Math.max(0.02, step);
  const dims = st => ({ nx: Math.floor((e - w) / st) + 1, ny: Math.floor((n - s) / st) + 1 });
  let d = dims(step); while (d.nx * d.ny > maxPts) { step *= 1.08; d = dims(step); }
  step = +step.toFixed(4); d = dims(step);
  const grid = { lat0: +s.toFixed(4), lon0: +w.toFixed(4), dlat: step, dlon: step, nx: d.nx, ny: d.ny };
  const N = grid.nx * grid.ny;
  const times = []; for (let t = win.t0; t <= win.t1; t += H) times.push(t);
  const T = times.length;
  const make = () => new Float32Array(T * N).fill(NaN);
  const V = { u: make(), v: make(), gust: make(), precip: make(), cape: make(), conf: make(), spread: make() };
  progress(0, 'ClockW: analiza obale i otoka…');
  await new Promise(r => setTimeout(r, 0));
  const coast = coastIndex(grid, landAt);
  const kms = models.map((id, k) => resKm(id, fs[k]));
  const M = models.length, U = new Float64Array(M), Vv = new Float64Array(M), S = new Float64Array(M), G = new Float64Array(M), P = new Float64Array(M), C = new Float64Array(M), W0 = new Float64Array(M), W = new Float64Array(M);
  const out = [];
  const agree = new Float64Array(M);   // how much each model counted in the end (for the summary)
  for (let ti = 0; ti < T; ti++) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t = times[ti];
    for (let j = 0; j < grid.ny; j++) {
      const lat = grid.lat0 + j * step;
      for (let i = 0; i < grid.nx; i++) {
        const lon = grid.lon0 + i * step, p = j * grid.nx + i, c = coast[p];
        let m = 0;
        for (let k = 0; k < M; k++) {
          sample(fs[k], ['u', 'v', 'gust', 'precip', 'cape'], lat, lon, t, out);
          if (!(out[0] === out[0] && out[1] === out[1])) { W0[k] = 0; continue; }
          U[k] = out[0]; Vv[k] = out[1]; S[k] = Math.hypot(out[0], out[1]); G[k] = out[2]; P[k] = out[3]; C[k] = out[4];
          W0[k] = baseWeight(models[k], kms[k], c); m++;
        }
        if (!m) continue;
        // robust weighted mean of the wind vectors (3 re-weighting passes)
        for (let k = 0; k < M; k++) W[k] = W0[k];
        let um = 0, vm = 0, sm = 0;
        for (let it = 0; it < 4; it++) {
          let sw = 0; um = 0; vm = 0; sm = 0;
          for (let k = 0; k < M; k++) if (W[k] > 0) { sw += W[k]; um += W[k] * U[k]; vm += W[k] * Vv[k]; sm += W[k] * S[k]; }
          um /= sw; vm /= sw; sm /= sw;
          if (it === 3 || m < 3) break;
          const tol = Math.max(2.5, 0.25 * sm);
          for (let k = 0; k < M; k++) if (W0[k] > 0) { const dd = Math.hypot(U[k] - um, Vv[k] - vm) / tol; W[k] = W0[k] / (1 + dd * dd); }
        }
        const vl = Math.hypot(um, vm), o = ti * N + p;
        const f = vl > 0.05 ? sm / vl : 1;
        const ru = um * f, rv = vm * f;
        V.u[o] = ru; V.v[o] = rv;
        // spread: weighted (by base weight) RMS distance of the models from the result, in knots
        let sw0 = 0, ss = 0, gw = 0, gs = 0, pw = 0, ps = 0, cw = 0, cs = 0, swr = 0;
        for (let k = 0; k < M; k++) if (W0[k] > 0) {
          // an outlier still lowers confidence, but only partly once the others agree among themselves
          const dd = Math.hypot(U[k] - ru, Vv[k] - rv), wq = W0[k] * (0.3 + 0.7 * W[k] / W0[k]); sw0 += wq; ss += wq * dd * dd; swr += W[k];
          if (G[k] === G[k]) { gw += W[k]; gs += W[k] * G[k]; }
          if (P[k] === P[k]) { pw += W[k]; ps += W[k] * P[k]; }
          if (C[k] === C[k]) { cw += W[k]; cs += W[k] * C[k]; }
        }
        for (let k = 0; k < M; k++) if (W0[k] > 0) agree[k] += W[k] / swr;
        const spread = Math.sqrt(ss / sw0), spd = Math.hypot(ru, rv);
        V.spread[o] = spread;
        V.conf[o] = m < 2 ? 35 : 100 / (1 + (spread / Math.max(3, 0.3 * spd)) ** 2);
        V.gust[o] = gw ? Math.max(spd, gs / gw) : NaN;
        V.precip[o] = pw ? ps / pw : NaN;
        V.cape[o] = cw ? cs / cw : NaN;
      }
    }
    progress((ti + 1) / T, `ClockW: ${ti + 1}/${T} h`);
    if (ti % 2 === 1) await new Promise(r => setTimeout(r, 0));   // keep the app responsive
  }
  const tot = agree.reduce((a, b) => a + b, 0) || 1;
  const share = Object.fromEntries(models.map((id, k) => [id, agree[k] / tot]));
  // mean confidence over sea points of the first 12 hours (summary for the panel)
  let cs = 0, cn = 0; for (let o = 0; o < Math.min(T, 12) * N; o += 7) { const v = V.conf[o]; if (v === v && coast[o % N] < 1) { cs += v; cn++; } }
  const meta = clockwMeta(num);
  return { ...grid, model: meta.id, times, vars: V, validUntil: times[T - 1], meta,
    run: { runInit: Date.now() }, clockw: { models, hours, built: Date.now(), share, meanConf: cn ? cs / cn : null, short: win.short } };
}

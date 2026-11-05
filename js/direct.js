// Direct, on-demand download of official open-data GRIBs (no API limits). Nothing runs in the background.
// ECMWF and NOAA publish their open data on AWS with CORS + byte ranges, so iPhone/iPad/Safari fetch only the wind
// messages straight from the producer. DWD has no CORS: those models need the Mac app (its local proxy).
import { decodeGrib, cropMsg, gribToField } from './grib.js';
import { registerModel, fetchOpenMeteoMarine, gridFor, MARINE_STEP, downloadForecast } from './forecast.js';

export const DIRECT = [
  { id: 'dir_icon_d2', name: 'ICON-D2', res: '2.2 km · DWD', color: '#ff9100', mac: true, note: 'DWD (Njemačka meteorološka služba) – sjeverni Jadran do ~43.2°N, 48 h, svaki sat' },
  { id: 'dir_icon_eu', name: 'ICON-EU', res: '7 km · DWD', color: '#00e676', mac: true, note: 'DWD – cijeli Jadran, do 120 h' },
  { id: 'dir_ecmwf', name: 'ECMWF', res: '0.25° · ECMWF', color: '#2979ff', note: 'ECMWF IFS (Europski centar) – službeni open data, do 6 dana, svaka 3 h · radi i na iPhoneu' },
  { id: 'dir_gfs', name: 'GFS', res: '0.25° · NOAA', color: '#ffffff', note: 'NOAA GFS (SAD) – službeni open data, do 5 dana · radi i na iPhoneu' },
];
DIRECT.forEach(registerModel);

let nativeChecked = null;
export function nativeAvailable() {
  if (nativeChecked) return nativeChecked;
  nativeChecked = fetch('/proxy/ping').then(r => r.ok ? r.text() : '').then(t => t === 'ok').catch(() => false);
  return nativeChecked;
}
const P = (url, extra = '') => `/proxy?u=${encodeURIComponent(url)}${extra}`;
const H = 3600000;
const pad = (n, l) => String(n).padStart(l, '0');
const ymd = t => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`; };
const hh = t => pad(new Date(t).getUTCHours(), 2);

// every request has a time limit: a server that hangs must never freeze the download
function fetchT(url, opts = {}, ms = 30000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
async function ok(url) { try { const r = await fetchT(P(url, '&head=1'), {}, 20000); return r.ok; } catch { return false; } }
// every piece is retried (weak 4G / satellite links drop requests now and then)
async function bin(url, extra = '') {
  for (let k = 0; ; k++) {
    try { return await bin1(url, extra); }
    catch (e) { if (k >= 1 || /^4\d\d /.test(e.message) || Date.now() > deadline) throw e; await new Promise(r => setTimeout(r, 800)); }
  }
}
async function bin1(url, extra = '') {
  if (extra.startsWith('direct:')) {   // straight from a CORS-enabled producer (AWS open data), optional byte range
    const rg = extra.slice(7); const r = await fetchT(url, rg ? { headers: { Range: 'bytes=' + rg }, cache: 'no-store' } : { cache: 'no-store' }, 20000);
    if (!r.ok) throw new Error(`${r.status} ${url.split('/').pop().split('?')[0]}`); return r.arrayBuffer();
  }
  const r = await fetchT(P(url, extra), {}, 25000); if (!r.ok) throw new Error(`${r.status} ${url.split('/').pop()}`); return r.arrayBuffer();
}
// GET of the first byte (NOAA's bucket allows only GET in CORS, not HEAD)
const okDirect = async url => {
  for (let k = 0; k < 3; k++) {
    try { const r = await fetchT(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' }, 15000); if (r.ok) return true; if (r.status === 404 || r.status === 403) return false; }
    catch { /* throttled (503 has no CORS header) or a short drop: try again */ }
    await new Promise(r => setTimeout(r, 700 * (k + 1)));
  }
  return false;
};

// GRIB decode + crop in a small pool of workers (falls back to the main thread if workers are unavailable)
let gribPool = null, gribSeq = 0;
function decodeCrop(buf, bbox, maxPts) {
  if (gribPool === null) {
    try {
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      gribPool = Array.from({ length: n }, () => { const w = new Worker(new URL('./grib.worker.js', import.meta.url), { type: 'module' }); w.jobs = 0; return w; });
    } catch { gribPool = []; }
  }
  const local = b => { const out = []; for (const m of decodeGrib(b)) { const c = cropMsg(m, bbox, maxPts); if (c) out.push(c); } return out; };
  if (!gribPool.length) return Promise.resolve(local(buf));
  const w = gribPool.reduce((a, b) => (b.jobs < a.jobs ? b : a));
  const id = ++gribSeq; w.jobs++;
  const copy = buf.slice(0);   // kept in case the worker never answers
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); w.removeEventListener('message', on); w.removeEventListener('error', err); w.jobs--; fn(v); };
    const on = e => { if (e.data.id !== id) return; e.data.error ? finish(reject, new Error(e.data.error)) : finish(resolve, e.data.msgs); };
    // a worker that cannot start or hangs: switch to decoding here, never wait forever
    const fallback = () => { gribPool = []; try { finish(resolve, local(copy)); } catch (e) { finish(reject, e); } };
    const err = () => fallback();
    const t = setTimeout(fallback, 30000);
    w.addEventListener('message', on); w.addEventListener('error', err);
    w.postMessage({ id, buf, bbox, maxPts }, [buf]);
  });
}

// run-limited parallel map
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- model recipes ----------
// ECMWF: 3-hourly to 144 h, then 6-hourly to 360 h (00/12 z runs). GFS: 3-hourly to 384 h (we take 6-hourly after 120 h).
export function globalSteps(model, run, t0, t1, every = 3, far = 6) {
  const max = model === 'ecmwf' ? 360 : 384, fine = model === 'ecmwf' ? 144 : 120, s = [];
  for (let h = 0; h <= max; h += h < fine ? every : far) {
    if (h >= fine && h % far) continue;
    const v = run + h * H;
    if (v >= t0 - 3 * H - (every - 3) * H && v <= t1 + Math.max(every, h >= fine ? 6 : 0) * H) s.push(h);
  }
  return s;
}
// last step a download needs from a run (so a run that is not complete that far is skipped)
const needStep = (model, run, win) => { const max = model === 'ecmwf' ? 360 : 384; if (!win) return 0; const h = Math.ceil((win.t1 - run) / H / 6) * 6; return Math.max(0, Math.min(max, h)); };
const dwd = (model, every, maxStep) => ({
  async latestRun(win) {
    let t = Math.floor((Date.now() - 1.5 * H) / (every * H)) * every * H;
    for (let k = 0; k < 5; k++, t -= every * H) {
      // last step this download needs from run t (EU switches to 3-hourly after 78 h)
      let need = Math.min(maxStep, Math.max(0, Math.ceil(((win ? win.t1 : t) - t) / H)));
      if (model === 'eu' && need > 78) need = Math.min(maxStep, Math.ceil(need / 3) * 3);
      const f = model === 'd2' ? d2url : euurl;
      if (await ok(f(t, need, 'u_10m'))) return t;   // complete enough for us – otherwise the previous run
    }
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) {
    const s = [];
    for (let h = 0; h <= maxStep; h += (model === 'eu' && h >= 78) ? 3 : 1) { const v = run + h * H; if (v >= t0 - H && v <= t1 + H && (h % dwdEvery === 0)) s.push(h); }
    return s;
  },
  files(run, h) {
    const f = model === 'd2' ? d2url : euurl;
    return ['u_10m', 'v_10m', 'vmax_10m'].map(v => ({ url: f(run, h, v), extra: '&bz=1' }));
  },
});
const d2url = (run, h, v) => `https://opendata.dwd.de/weather/nwp/icon-d2/grib/${hh(run)}/${v}/icon-d2_germany_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_2d_${v}.grib2.bz2`;
const euurl = (run, h, v) => `https://opendata.dwd.de/weather/nwp/icon-eu/grib/${hh(run)}/${v}/icon-eu_europe_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_${v.toUpperCase()}.grib2.bz2`;

// ECMWF open data: on the Mac from data.ecmwf.int through the local proxy; elsewhere from ECMWF's AWS mirror (CORS).
// If one of them refuses (AWS throttles with 503), the other is tried.
const EC_HOSTS = { ecmwf: 'https://data.ecmwf.int/forecasts', aws: 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com' };
let ecHost = 'aws';
const ecBase = (run, h) => `${EC_HOSTS[ecHost]}/${ymd(run)}/${hh(run)}z/ifs/0p25/oper/${ymd(run)}${hh(run)}0000-${h}h-oper-fc`;
const ecOk = url => ecHost === 'ecmwf' ? ok(url) : okDirect(url);
const ECMWF = {
  async latestRun(win) {
    const order = native ? ['ecmwf', 'aws'] : ['aws'];   // Mac: ECMWF's own server first (through the local proxy), AWS as reserve
    for (const hst of order) {
      ecHost = hst;
      let t = Math.floor((Date.now() - 6 * H) / (12 * H)) * 12 * H;
      // the run must be published as far as this download needs (long range: up to 360 h); otherwise the previous one
      for (let k = 0; k < 3; k++, t -= 12 * H) if (await ecOk(ecBase(t, Math.max(144, needStep('ecmwf', t, win))) + '.index') || (k > 0 && await ecOk(ecBase(t, 0) + '.index'))) return t;
    }
    throw new Error('ECMWF trenutno ne odgovara (nema dostupnog runa)');
  },
  steps(run, t0, t1) { return globalSteps('ecmwf', run, t0, t1, globalEvery, farEvery); },
  async filesAsync(run, h) {
    let viaProxy = ecHost === 'ecmwf';
    const getIdx = async proxy => { const host = proxy ? EC_HOSTS.ecmwf : EC_HOSTS.aws, u = ecBase(run, h).replace(EC_HOSTS[ecHost], host) + '.index';
      const r = await fetchT(proxy ? P(u) : u, { cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status} ECMWF index +${h}h`); return r.text(); };
    let idx;
    try { idx = await getIdx(viaProxy); }
    catch (e) { if (!native) throw e; viaProxy = !viaProxy; idx = await getIdx(viaProxy); }   // the other server has the same file
    const want = new Set(['10u', '10v', '10fg']);
    return idx.trim().split('\n').map(l => JSON.parse(l)).filter(j => want.has(j.param))
      .map(j => {
        const rg = `${j._offset}-${j._offset + j._length - 1}`, path = ecBase(run, h).replace(EC_HOSTS[ecHost], '') + '.grib2';
        return viaProxy ? { url: EC_HOSTS.ecmwf + path, extra: '&r=' + rg, alt: { url: EC_HOSTS.aws + path, extra: 'direct:' + rg } }
          : { url: EC_HOSTS.aws + path, extra: 'direct:' + rg, alt: native ? { url: EC_HOSTS.ecmwf + path, extra: '&r=' + rg } : null };
      });
  },
};
const gfsAws = (run, h) => `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${ymd(run)}/${hh(run)}/atmos/gfs.t${hh(run)}z.pgrb2.0p25.f${pad(h, 3)}`;
const GFS_AWS = {
  async latestRun(win) {
    let t = Math.floor((Date.now() - 5 * H) / (6 * H)) * 6 * H;
    for (let k = 0; k < 4; k++, t -= 6 * H) if (await okDirect(gfsAws(t, Math.max(120, needStep('gfs', t, win))) + '.idx')) return t;
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) { return globalSteps('gfs', run, t0, t1, globalEvery, farEvery); },
  async filesAsync(run, h) {
    const r = await fetch(gfsAws(run, h) + '.idx', { cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status} GFS idx f${h}`);
    const L = (await r.text()).trim().split('\n').map(l => l.split(':'));
    const out = [];
    L.forEach((f, i) => {
      const k = f[3] + ':' + f[4];
      if (k === 'UGRD:10 m above ground' || k === 'VGRD:10 m above ground' || k === 'GUST:surface') {
        const end = i + 1 < L.length ? +L[i + 1][1] - 1 : '';
        out.push({ url: gfsAws(run, h), extra: `direct:${f[1]}-${end}` });
      }
    });
    if (out.length < 2) throw new Error('GFS: nema vjetra u indeksu');
    return out;
  },
};
const GFS = (bbox) => ({
  async latestRun(win) {
    let t = Math.floor((Date.now() - 4.5 * H) / (6 * H)) * 6 * H;
    for (let k = 0; k < 3; k++, t -= 6 * H) { try { const r = await fetchT(P(gfsUrl(t, needStep('gfs', t, win), bbox)), {}, 25000); if (r.ok && (await r.arrayBuffer()).byteLength > 100) return t; } catch { /* next */ } }
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) { return globalSteps('gfs', run, t0, t1, globalEvery, farEvery); },
  files(run, h) { return [{ url: gfsUrl(run, h, bbox), extra: '' }]; },
});
const gfsUrl = (run, h, b) => `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.${ymd(run)}%2F${hh(run)}%2Fatmos&file=gfs.t${hh(run)}z.pgrb2.0p25.f${pad(h, 3)}&var_UGRD=on&var_VGRD=on&var_GUST=on&lev_10_m_above_ground=on&lev_surface=on&subregion=&toplat=${Math.ceil(b.n + 0.5)}&leftlon=${Math.floor(b.w - 0.5)}&rightlon=${Math.ceil(b.e + 0.5)}&bottomlat=${Math.floor(b.s - 0.5)}`;

function recipe(id, bbox) {
  if (id === 'dir_icon_d2') return dwd('d2', 3, 48);
  if (id === 'dir_icon_eu') return dwd('eu', 6, 120);
  if (id === 'dir_ecmwf') return ECMWF;
  if (id === 'dir_gfs') return native ? GFS(bbox) : GFS_AWS;
}
let native = false;
// which direct models work here (DWD needs the Mac app)
export const directUsable = (id, isNative) => { const m = DIRECT.find(x => x.id === id); return !!m && (isNative || !m.mac); };

// Download a forecast set directly from the sources.
let deadline = Infinity, dwdEvery = 1, globalEvery = 3, farEvery = 6;
const emptyMarine = (b, times) => ({ lat0: b.s, lon0: b.w, dlat: 1, dlon: 1, nx: 1, ny: 1, times, vars: Object.fromEntries(['wave', 'waveDir', 'wavePer', 'cu', 'cv'].map(k => [k, new Float32Array(times.length).fill(NaN)])) });
export async function downloadDirect({ bbox, modelIds, window, quality, settings, progress = () => {}, signal, maxSeconds = 150, quick = false, onPartial = null, globalOnly = false, marine = true, maxPts = 90000, far = 6 }) {
  farEvery = far;   // step beyond 5–6 days (12 h for the light long-range reserve)
  dwdEvery = quick ? 3 : 1;
  native = !!(settings && settings._native);
  deadline = Date.now() + maxSeconds * 1000;   // whatever arrived by then is used; the download never hangs
  modelIds = modelIds.filter(id => directUsable(id, native));
  // zoomed far out: only the global models (6-hourly) – regional high-resolution files (DWD) would be hundreds of MB
  // and their detail is invisible at that zoom; they come back automatically when you zoom in again
  let wide = false;
  if (globalOnly && modelIds.some(id => !id.startsWith('dir_icon'))) { modelIds = modelIds.filter(id => !id.startsWith('dir_icon')); wide = true; }
  globalEvery = wide ? 6 : 3;
  if (!modelIds.length) throw new Error('Odaberi ECMWF ili GFS (DWD modeli rade samo u Mac aplikaciji)');
  const fields = {}, errors = [], empty = [];
  let done = 0;
  // grid points per field: full detail for normal areas, thinned only for very large ones (zoomed far out)
  const MAXPTS = maxPts;
  let thinned = false;
  // waves & currents (Open-Meteo) run at the same time as the wind, max 20 s – they never hold the wind back
  const times = []; for (let t = window.t0; t <= window.t1; t += H) times.push(t);
  const mc = new AbortController(); const mtimer = setTimeout(() => mc.abort(), 20000);
  if (signal) signal.addEventListener('abort', () => mc.abort());
  const mtimes = times.filter(t => t <= window.t0 + 8 * 24 * H);   // waves/currents: the marine models reach ~8 days
  const marineP = !marine ? Promise.resolve(null) : fetchOpenMeteoMarine({ grid: gridFor(bbox, MARINE_STEP, 'standard'), times: mtimes, settings, signal: mc.signal, progress: () => {} })
    .catch(e => { errors.push(e.name === 'AbortError' ? 'Valovi/struje preskočeni (Open-Meteo ne odgovara) – pokušaj ponovno kasnije' : 'Valovi/struje: ' + e.message); return null; });
  await Promise.all(modelIds.map(async id => {
    const m = DIRECT.find(x => x.id === id);
    try {
      const r = recipe(id, bbox);
      progress(null, `${m.name}: tražim zadnji run…`);
      const run = await r.latestRun(window);
      const steps = r.steps(run, window.t0, window.t1);
      if (!steps.length) throw new Error('run ne pokriva traženo vrijeme');
      const msgs = [];
      let nf = 0;
      let failed = 0, lastErr = '';
      await pool(steps, 6, async h => {
        if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
        for (let k = 0; k < 2 && Date.now() < deadline; k++) {   // a whole time step gets a second chance (index + pieces)
          try {
            const got = [];
            const files = r.filesAsync ? await r.filesAsync(run, h) : r.files(run, h);
            for (const f of files) {
              if (Date.now() > deadline) throw new Error('isteklo vrijeme');
              let buf;
              try { buf = await bin(f.url, f.extra); }
              catch (e) { if (!f.alt) throw e; buf = await bin(f.alt.url, f.alt.extra); }   // same file from the other server
              for (const c of await decodeCrop(buf, bbox, MAXPTS)) { if (c.grid.di > 0.1 && c.grid.di > 0.26) thinned = true; got.push(c); }
            }
            msgs.push(...got); break;
          } catch (e) { if (e.name === 'AbortError') throw e; if (k === 1 || Date.now() > deadline) { failed++; lastErr = e.message; break; } else await new Promise(r => setTimeout(r, 1000)); }
        }
        nf++; progress((done + nf / steps.length) / (modelIds.length + 1), `${m.name} run ${hh(run)}z: ${nf}/${steps.length} koraka`);
      });
      if (failed > steps.length / 3) throw new Error(`${failed}/${steps.length} koraka nije preuzeto (${lastErr})`);
      if (failed) errors.push(`${m.name}: ${failed} vremenskih koraka nedostaje (${lastErr})`);
      if (id === 'dir_icon_d2' && !msgs.some(x => x.vals.some(v => v === v))) { empty.push(id); return; }
      const f = gribToField(msgs, null, id);
      f.run = { runInit: run };
      fields[id] = f;
      if (onPartial) {
        const ready = modelIds.filter(x => fields[x]);
        try { onPartial({ id: 'fc-' + Date.now(), created: Date.now(), bbox, quality: 'direct', source: 'direct', window, models: ready, empty: [], errors: [], times: f.times, fields: { ...fields, marine: fields.marine || emptyMarine(bbox, f.times) }, partial: true }); } catch (e) { console.warn(e); }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(id, e); errors.push(`${m.name}: ${e.message}`);
    }
    done++;
  }));
  // ECMWF's AWS mirror can refuse a busy address ("503 Slow Down"): on iPhone/iPad take ECMWF through Open-Meteo instead
  if (modelIds.includes('dir_ecmwf') && !fields.dir_ecmwf && !native) {
    try {
      const oc = new AbortController(), ot = setTimeout(() => oc.abort(), 20000);   // a reserve never holds the download
      const om = await downloadForecast({ bbox, modelIds: ['ecmwf_ifs'], window, quality: 'standard', settings, signal: oc.signal }).finally(() => clearTimeout(ot));
      if (om.fields.ecmwf_ifs) { fields.ecmwf_ifs = om.fields.ecmwf_ifs; modelIds = [...modelIds, 'ecmwf_ifs']; errors.push('ECMWF: izravni poslužitelj je zauzet – ECMWF preuzet preko Open-Meteo'); }
    } catch (e) { errors.push('ECMWF rezerva (Open-Meteo): ' + (e.daily ? 'dnevni limit' : e.message)); }
  }
  fields.marine = await marineP; clearTimeout(mtimer);
  if (!fields.marine) { const n = 1; fields.marine = { lat0: bbox.s, lon0: bbox.w, dlat: 1, dlon: 1, nx: 1, ny: 1, times, vars: { wave: new Float32Array(times.length).fill(NaN), waveDir: new Float32Array(times.length).fill(NaN), wavePer: new Float32Array(times.length).fill(NaN), cu: new Float32Array(times.length).fill(NaN), cv: new Float32Array(times.length).fill(NaN) } }; }
  progress(1, 'Gotovo');
  const models = modelIds.filter(id => fields[id]);
  if (!models.length) throw new Error('Nijedan izvor nije vratio podatke. ' + errors.join(' · '));
  return { id: 'fc-' + Date.now(), created: Date.now(), bbox, quality: 'direct', source: 'direct', window, models, empty, errors, times, fields, thinned, globalOnly: wide };
}

// ---------- compact package for the iPhone (AirDrop) ----------
// variables are stored as scaled Int16 (half the size of Float32, gzips far better); NaN = -32768
const Q = { u: 0.01, v: 0.01, gust: 0.01, cu: 0.01, cv: 0.01, precip: 0.01, lpi: 0.01, wave: 0.01, wavePer: 0.01, waveDir: 0.1, cape: 1 };
export async function exportPackage(set) {
  const parts = [], fields = {};
  let off = 0;
  // a model's long-range extension travels as its own entry "<id>~ext" (and "<id>~ext~ext" for a second link)
  const flat = [];
  for (const [id, f] of Object.entries(set.fields)) { let k = id, g = f; while (g) { flat.push([k, g]); g = g.ext; k += '~ext'; } }
  for (const [id, f0] of flat) {
    const { ext: _e, fallback: _fb, ...f } = f0;
    const vars = {};
    for (const [k, a] of Object.entries(f.vars)) {
      const sc = Q[k];
      if (sc) {
        const q = new Int16Array(a.length);
        for (let i = 0; i < a.length; i++) { const x = a[i]; q[i] = x === x ? Math.max(-32767, Math.min(32767, Math.round(x / sc))) : -32768; }
        vars[k] = [off, a.length, 'i16', sc]; parts.push(q); off += q.byteLength;
      } else { vars[k] = [off, a.length]; parts.push(a); off += a.byteLength; }
      if (off % 4) { const padB = new Uint8Array(4 - (off % 4)); parts.push(padB); off += padB.length; }
    }
    const { vars: _v, ...rest } = f; fields[id] = { ...rest, vars };
  }
  const { fields: _f, ...meta } = set;
  const head = new TextEncoder().encode(JSON.stringify({ meta, fields }));
  const padN = (4 - ((8 + head.length) % 4)) % 4;
  const hdr = new Uint8Array(8 + head.length + padN);
  hdr.set([67, 84, 87, 80], 0); new DataView(hdr.buffer).setUint32(4, head.length + padN, true); hdr.set(head, 8);
  for (let i = 0; i < padN; i++) hdr[8 + head.length + i] = 32;
  const blob = new Blob([hdr, ...parts.map(a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength))]);
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
export function isPackage(buf) { const b = new Uint8Array(buf, 0, 4); return b[0] === 67 && b[1] === 84 && b[2] === 87 && b[3] === 80; }
export function importPackage(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(4, true);
  const { meta, fields } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  const base = 8 + hl, set = { ...meta, fields: {} };
  for (const [id, f] of Object.entries(fields)) {
    const vars = {};
    for (const [k, [o, n, enc, sc]] of Object.entries(f.vars)) {
      if (enc === 'i16') {
        const q = new Int16Array(buf.slice(base + o, base + o + n * 2)), a = new Float32Array(n);
        for (let i = 0; i < n; i++) a[i] = q[i] === -32768 ? NaN : q[i] * sc;
        vars[k] = a;
      } else vars[k] = new Float32Array(buf.slice(base + o, base + o + n * 4));
    }
    set.fields[id] = { ...f, vars };
  }
  // re-attach extensions (longest suffix first, so chains rebuild from the end)
  for (const id of Object.keys(set.fields).filter(k => k.includes('~ext')).sort((a, b) => b.length - a.length)) {
    const parent = set.fields[id.slice(0, -4)];
    if (parent) parent.ext = set.fields[id];
    delete set.fields[id];
  }
  return set;
}

export const CLOUD_DEFAULT = 'https://clockwork-75.github.io/Clock-the-wind/data/latest.ctw';
export async function fetchCloudPackage(cloudUrl, native, progress = () => {}) {
  const onPages = /github\.io$/.test(location.hostname);
  const url = onPages ? new URL('data/latest.ctw', location.href.replace(/[^/]*$/, '')).href : (cloudUrl || CLOUD_DEFAULT);
  progress(null, 'Preuzimam paket iz oblaka…');
  let r = null;
  try { r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); } catch { r = null; }
  if ((!r || !r.ok) && !onPages && native) r = await fetch(`/proxy?u=${encodeURIComponent(url)}`, { cache: 'no-store' });
  if (!r) throw new Error('paket iz oblaka nije dostupan');
  if (!r.ok) throw new Error(`paket iz oblaka nije dostupan (${r.status})`);
  let buf = await r.arrayBuffer();
  const h = new Uint8Array(buf, 0, 2);
  if (h[0] === 0x1f && h[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (!isPackage(buf)) throw new Error('neispravan paket');
  return importPackage(buf);
}

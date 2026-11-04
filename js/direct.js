// Direct, on-demand download of open-data GRIBs through the Mac app's local proxy (no API limits).
// Nothing runs in the background: only when the user presses "Preuzmi".
import { decodeGrib, cropMsg, gribToField } from './grib.js';
import { registerModel, fetchOpenMeteoMarine, gridFor, MARINE_STEP } from './forecast.js';

export const DIRECT = [
  { id: 'dir_icon_d2', name: 'ICON-D2', res: '2.2 km · DWD', color: '#ffb300', note: 'DWD izravno – sjeverni Jadran do ~43.2°N, 48 h, svaki sat' },
  { id: 'dir_icon_eu', name: 'ICON-EU', res: '7 km · DWD', color: '#81c784', note: 'DWD izravno – cijeli Jadran, do 120 h' },
  { id: 'dir_ecmwf', name: 'ECMWF', res: '0.25° · ECMWF', color: '#4fc3f7', note: 'ECMWF open data izravno – do 6 dana, svaka 3 h' },
  { id: 'dir_gfs', name: 'GFS', res: '0.25° · NOAA', color: '#e0e0e0', note: 'NOAA izravno (izrez na poslužitelju, vrlo malo podataka)' },
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

async function ok(url) { try { const r = await fetch(P(url, '&head=1')); return r.ok; } catch { return false; } }
async function bin(url, extra = '') { const r = await fetch(P(url, extra)); if (!r.ok) throw new Error(`${r.status} ${url.split('/').pop()}`); return r.arrayBuffer(); }

// run-limited parallel map
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- model recipes ----------
const dwd = (model, every, maxStep) => ({
  async latestRun() {
    let t = Math.floor((Date.now() - 1.5 * H) / (every * H)) * every * H;
    for (let k = 0; k < 4; k++, t -= every * H) {
      const u = model === 'd2' ? d2url(t, 0, 'u_10m') : euurl(t, 0, 'u_10m');
      if (await ok(u)) return t;
    }
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) {
    const s = [];
    for (let h = 0; h <= maxStep; h += (model === 'eu' && h >= 78) ? 3 : 1) { const v = run + h * H; if (v >= t0 - H && v <= t1 + H) s.push(h); }
    return s;
  },
  files(run, h) {
    const f = model === 'd2' ? d2url : euurl;
    return ['u_10m', 'v_10m', 'vmax_10m'].map(v => ({ url: f(run, h, v), extra: '&bz=1' }));
  },
});
const d2url = (run, h, v) => `https://opendata.dwd.de/weather/nwp/icon-d2/grib/${hh(run)}/${v}/icon-d2_germany_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_2d_${v}.grib2.bz2`;
const euurl = (run, h, v) => `https://opendata.dwd.de/weather/nwp/icon-eu/grib/${hh(run)}/${v}/icon-eu_europe_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_${v.toUpperCase()}.grib2.bz2`;

const ecBase = (run, h) => `https://data.ecmwf.int/forecasts/${ymd(run)}/${hh(run)}z/ifs/0p25/oper/${ymd(run)}${hh(run)}0000-${h}h-oper-fc`;
const ECMWF = {
  async latestRun() {
    let t = Math.floor((Date.now() - 7 * H) / (12 * H)) * 12 * H;
    for (let k = 0; k < 3; k++, t -= 12 * H) if (await ok(ecBase(t, 0) + '.index')) return t;
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) { const s = []; for (let h = 0; h <= 144; h += 3) { const v = run + h * H; if (v >= t0 - 3 * H && v <= t1 + 3 * H) s.push(h); } return s; },
  async filesAsync(run, h) {
    const idx = await fetch(P(ecBase(run, h) + '.index')).then(r => r.text());
    const want = new Set(['10u', '10v', '10fg']);
    return idx.trim().split('\n').map(l => JSON.parse(l)).filter(j => want.has(j.param))
      .map(j => ({ url: ecBase(run, h) + '.grib2', extra: `&r=${j._offset}-${j._offset + j._length - 1}` }));
  },
};
const GFS = (bbox) => ({
  async latestRun() {
    let t = Math.floor((Date.now() - 4.5 * H) / (6 * H)) * 6 * H;
    for (let k = 0; k < 3; k++, t -= 6 * H) { try { const r = await fetch(P(gfsUrl(t, 0, bbox))); if (r.ok && (await r.arrayBuffer()).byteLength > 100) return t; } catch { /* next */ } }
    throw new Error('nema dostupnog runa');
  },
  steps(run, t0, t1) { const s = []; for (let h = 0; h <= 120; h += 3) { const v = run + h * H; if (v >= t0 - 3 * H && v <= t1 + 3 * H) s.push(h); } return s; },
  files(run, h) { return [{ url: gfsUrl(run, h, bbox), extra: '' }]; },
});
const gfsUrl = (run, h, b) => `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.${ymd(run)}%2F${hh(run)}%2Fatmos&file=gfs.t${hh(run)}z.pgrb2.0p25.f${pad(h, 3)}&var_UGRD=on&var_VGRD=on&var_GUST=on&lev_10_m_above_ground=on&lev_surface=on&subregion=&toplat=${Math.ceil(b.n + 0.5)}&leftlon=${Math.floor(b.w - 0.5)}&rightlon=${Math.ceil(b.e + 0.5)}&bottomlat=${Math.floor(b.s - 0.5)}`;

function recipe(id, bbox) {
  if (id === 'dir_icon_d2') return dwd('d2', 3, 48);
  if (id === 'dir_icon_eu') return dwd('eu', 6, 120);
  if (id === 'dir_ecmwf') return ECMWF;
  if (id === 'dir_gfs') return GFS(bbox);
}

// Download a forecast set directly from the sources.
export async function downloadDirect({ bbox, modelIds, window, quality, settings, progress = () => {}, signal }) {
  const fields = {}, errors = [], empty = [];
  let done = 0;
  for (const id of modelIds) {
    const m = DIRECT.find(x => x.id === id);
    try {
      const r = recipe(id, bbox);
      progress(null, `${m.name}: tražim zadnji run…`);
      const run = await r.latestRun();
      const steps = r.steps(run, window.t0, window.t1);
      if (!steps.length) throw new Error('run ne pokriva traženo vrijeme');
      const msgs = [];
      let nf = 0;
      await pool(steps, 4, async h => {
        if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
        const files = r.filesAsync ? await r.filesAsync(run, h) : r.files(run, h);
        for (const f of files) {
          const buf = await bin(f.url, f.extra);
          for (const msg of decodeGrib(buf)) { const c = cropMsg(msg, bbox); if (c) msgs.push(c); }
        }
        nf++; progress((done + nf / steps.length) / (modelIds.length + 1), `${m.name} run ${hh(run)}z: ${nf}/${steps.length} koraka`);
      });
      if (id === 'dir_icon_d2' && !msgs.some(x => x.vals.some(v => v === v))) { empty.push(id); continue; }
      const f = gribToField(msgs, null, id);
      f.run = { runInit: run };
      fields[id] = f;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(id, e); errors.push(`${m.name}: ${e.message}`);
    }
    done++;
  }
  // waves & currents: small, still from Open-Meteo marine
  const times = []; for (let t = window.t0; t <= window.t1; t += H) times.push(t);
  // never let waves/currents block the wind download: give Open-Meteo 25 s, otherwise skip
  const mc = new AbortController(); const timer = setTimeout(() => mc.abort(), 25000);
  if (signal) signal.addEventListener('abort', () => mc.abort());
  try { fields.marine = await fetchOpenMeteoMarine({ grid: gridFor(bbox, MARINE_STEP, 'standard'), times, settings, signal: mc.signal, progress: (f, t) => progress(null, 'Valovi i struje: ' + (t || '')) }); }
  catch (e) { errors.push(e.name === 'AbortError' ? 'Valovi/struje preskočeni (Open-Meteo limit) – pokušaj ponovno za minutu' : 'Valovi/struje: ' + e.message); }
  clearTimeout(timer);
  if (!fields.marine) { const n = 1; fields.marine = { lat0: bbox.s, lon0: bbox.w, dlat: 1, dlon: 1, nx: 1, ny: 1, times, vars: { wave: new Float32Array(times.length).fill(NaN), waveDir: new Float32Array(times.length).fill(NaN), wavePer: new Float32Array(times.length).fill(NaN), cu: new Float32Array(times.length).fill(NaN), cv: new Float32Array(times.length).fill(NaN) } }; }
  progress(1, 'Gotovo');
  const models = modelIds.filter(id => fields[id]);
  if (!models.length) throw new Error('Nijedan izvor nije vratio podatke. ' + errors.join(' · '));
  return { id: 'fc-' + Date.now(), created: Date.now(), bbox, quality: 'direct', source: 'direct', window, models, empty, errors, times, fields };
}

// ---------- compact package for the iPhone (AirDrop) ----------
export async function exportPackage(set) {
  const parts = [], fields = {};
  let off = 0;
  for (const [id, f] of Object.entries(set.fields)) {
    const vars = {};
    for (const [k, a] of Object.entries(f.vars)) { vars[k] = [off, a.length]; parts.push(a); off += a.length * 4; }
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
    for (const [k, [o, n]] of Object.entries(f.vars)) vars[k] = new Float32Array(buf.slice(base + o, base + o + n * 4));
    set.fields[id] = { ...f, vars };
  }
  return set;
}

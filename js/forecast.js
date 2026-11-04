// Forecast download. Every model is fetched on its OWN native-resolution grid, over a time window
// synchronised with the race start (start_hour/end_hour), and tagged with its model run time.
// Providers: Open-Meteo (free / commercial key), Meteomatics (paid), GRIB import (see grib.js).
import { uvFromSpeedDir } from './geo.js';
import { kv } from './db.js';

export const MODELS = [
  { id: 'italia_meteo_arpae_icon_2i', meta: 'italia_meteo_arpae_icon_2i', name: 'ICON-2I', res: '2.2 km', step: 0.025, color: '#ff1744', def: true,  note: 'ItaliaMeteo – cijeli Jadran, najviša rezolucija, potencijal munja' },
  { id: 'icon_d2', meta: 'dwd_icon_d2',                    name: 'ICON-D2', res: '2.2 km', step: 0.025, color: '#ff9100', def: false, note: 'DWD – sjeverni Jadran (Istra, Kvarner, do ~Zadra)' },
  { id: 'knmi_harmonie_arome_europe', meta: 'knmi_harmonie_arome_europe', name: 'HARMONIE', res: '5.5 km', step: 0.05, color: '#ffea00', def: false, note: 'KNMI AROME – sjeverni i srednji Jadran' },
  { id: 'ecmwf_ifs', meta: 'ecmwf_ifs',                    name: 'ECMWF',   res: '9 km',   step: 0.1,  color: '#2979ff', def: true,  note: 'ECMWF IFS HRES – referentni globalni model' },
  { id: 'ecmwf_aifs025_single', meta: 'ecmwf_aifs025_single', name: 'AIFS', res: '25 km',  step: 0.25, color: '#00e5ff', def: false, note: 'ECMWF AI model' },
  { id: 'icon_eu', meta: 'dwd_icon_eu',                    name: 'ICON-EU', res: '7 km',   step: 0.0625, color: '#00e676', def: true, note: 'DWD – europski model' },
  { id: 'meteofrance_arpege_europe', meta: 'meteofrance_arpege_europe', name: 'ARPEGE', res: '11 km', step: 0.1, color: '#d500f9', def: false, note: 'Météo-France' },
  { id: 'ukmo_global_deterministic_10km', meta: 'ukmo_global_deterministic_10km', name: 'UKMO', res: '10 km', step: 0.1, color: '#ff80ab', def: false, note: 'UK Met Office' },
  { id: 'gfs_seamless', meta: 'ncep_gfs025',               name: 'GFS',     res: '25 km',  step: 0.25, color: '#ffffff', def: false,  note: 'NOAA GFS' },
];
export const MARINE_STEP = 0.08;
export const ALADIN = { id: 'aladin_hr', name: 'ALADIN-HR', res: '2 km', note: 'DHMZ – javno nema GRIB API. Kad dobijemo pristup, dodaje se kao izvor ili GRIB uvozom.' };
export const QUALITY = {
  standard: { name: 'Standard (preporučeno)', factor: 1.6, cap: 600 },
  hd:       { name: 'HD (nativna rezolucija) – troši puno poziva', factor: 1.0, cap: 1600 },
  ultra:    { name: 'Ultra HD', factor: 0.8, cap: 3200 },
};
// paid / extra models available through Meteomatics (user's own account)
export const MM_MODELS = [
  { id: 'mm:mix', mm: 'mix', name: 'MM mix', res: '1 km', color: '#bcaaa4' },
  { id: 'mm:ecmwf-ifs', mm: 'ecmwf-ifs', name: 'MM ECMWF', res: '9 km', color: '#82b1ff' },
  { id: 'mm:mm-swiss1k', mm: 'mm-swiss1k', name: 'MM 1k', res: '1 km', color: '#ffd180' },
];

const extra = new Map();
export const registerModel = m => extra.set(m.id, m);
export const modelById = id => MODELS.find(m => m.id === id) || MM_MODELS.find(m => m.id === id) || extra.get(id) || { id, name: id, res: '', color: '#bbb' };

const WX_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'cape', 'lightning_potential'];
const MARINE_VARS = ['wave_height', 'wave_direction', 'wave_period', 'ocean_current_velocity', 'ocean_current_direction'];

export function makeGrid(bbox, step) {
  const lat0 = Math.floor(bbox.s / step) * step, lon0 = Math.floor(bbox.w / step) * step;
  const ny = Math.ceil((bbox.n - lat0) / step) + 1, nx = Math.ceil((bbox.e - lon0) / step) + 1;
  return { lat0: +lat0.toFixed(5), lon0: +lon0.toFixed(5), dlat: step, dlon: step, ny, nx };
}
// grid for a model at chosen quality; never finer than the model's native resolution, capped in points
export function gridFor(bbox, nativeStep, quality = 'hd') {
  const q = QUALITY[quality] || QUALITY.hd;
  let step = Math.max(0.02, nativeStep * q.factor);
  let g = makeGrid(bbox, step);
  while (g.nx * g.ny > q.cap) { step *= 1.12; g = makeGrid(bbox, +step.toFixed(4)); }
  return g;
}

// race-synchronised time window [t0,t1] (ms, whole hours UTC)
export function raceWindow(raceStart, courseNm, now = Date.now()) {
  const H = 3600000;
  const estHours = Math.max(4, courseNm / 5.5);            // conservative average speed
  const t0 = Math.floor(Math.min(now, raceStart - 3 * H) / H) * H;
  const t1 = Math.ceil((raceStart + estHours * 2 * H + 6 * H) / H) * H;
  return { t0, t1, estHours };
}
const isoHour = t => new Date(t).toISOString().slice(0, 13) + ':00';

export function estimateCalls(bbox, modelIds, quality) {
  let calls = 0, pts = 0;
  for (const id of modelIds) { const m = modelById(id); if (!m.step) continue; const g = gridFor(bbox, m.step, quality); calls += g.nx * g.ny; pts += g.nx * g.ny; }
  const mg = gridFor(bbox, MARINE_STEP, quality);
  return { calls: calls + mg.nx * mg.ny, minutes: Math.ceil((calls + mg.nx * mg.ny) / 550) };
}

function apiBase(kind, settings) {
  const key = settings.apiKey && settings.apiKey.trim();
  if (kind === 'marine') return key ? 'https://customer-marine-api.open-meteo.com/v1/marine' : 'https://marine-api.open-meteo.com/v1/marine';
  return key ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
}

async function fetchJSON(url, signal, progress, opts = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { signal, ...opts });
    if (r.ok) return r.json();
    let reason = '';
    try { const j = await r.json(); reason = j.reason || j.message || ''; } catch { /* ignore */ }
    if (r.status === 429 && /minut|hour/i.test(reason) && attempt < 5) {
      const wait = /hour/i.test(reason) ? 0 : 62;
      if (!wait) { const e = new Error('DAILY_LIMIT'); e.daily = true; throw e; }
      for (let s = wait; s > 0; s--) {
        if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
        progress && progress(null, `Limit besplatnog API-ja po minuti – nastavljam za ${s}s`); await new Promise(res => setTimeout(res, 1000));
      }
      continue;
    }
    if (r.status === 400 && /api key/i.test(reason)) throw new Error('Open-Meteo API ključ nije ispravan – provjeri ga u Postavke → Izvori.');
    if (r.status === 401 || r.status === 403) throw new Error('Pristup odbijen – provjeri korisničko ime/lozinku ili ključ. ' + reason);
    if (r.status === 429) { const e = new Error('DAILY_LIMIT'); e.daily = /daily|day/i.test(reason) || true; throw e; }
    if (attempt >= 2) throw new Error(`Greška ${r.status}: ${reason}`);
    await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
}

function coords(grid) {
  const lats = [], lons = [];
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
    lats.push((grid.lat0 + j * grid.dlat).toFixed(4));
    lons.push((grid.lon0 + i * grid.dlon).toFixed(4));
  }
  return { lats, lons };
}
const hours = (t0, t1) => { const a = []; for (let t = t0; t <= t1; t += 3600000) a.push(t); return a; };

export async function fetchModelMeta(ids) {
  const out = {};
  await Promise.all(ids.map(async id => {
    const m = modelById(id); if (!m.meta) return;
    try {
      const j = await fetch(`https://api.open-meteo.com/data/${m.meta}/static/meta.json`).then(r => r.json());
      out[id] = { runInit: j.last_run_initialisation_time * 1000, runAvail: j.last_run_availability_time * 1000, interval: j.update_interval_seconds * 1000, dataEnd: j.data_end_time * 1000 };
    } catch { /* offline or unknown */ }
  }));
  return out;
}

// -------- Open-Meteo: one model on its own grid --------
async function fetchOpenMeteoModel({ id, grid, times, settings, signal, progress, label }) {
  const { lats, lons } = coords(grid);
  const N = lats.length, T = times.length, BATCH = 260;
  const make = () => new Float32Array(T * N).fill(NaN);
  const V = { u: make(), v: make(), gust: make(), precip: make(), cape: make(), lpi: make() };
  const key = settings.apiKey ? `&apikey=${encodeURIComponent(settings.apiKey.trim())}` : '';
  for (let s = 0; s < N; s += BATCH) {
    const e = Math.min(N, s + BATCH);
    const url = `${apiBase('wx', settings)}?latitude=${lats.slice(s, e).join(',')}&longitude=${lons.slice(s, e).join(',')}&hourly=${WX_VARS.join(',')}&models=${id}&wind_speed_unit=kn&start_hour=${isoHour(times[0])}&end_hour=${isoHour(times[T - 1])}&timeformat=unixtime&timezone=GMT&cell_selection=sea${key}`;
    let res = await fetchJSON(url, signal, progress); if (!Array.isArray(res)) res = [res];
    res.forEach((loc, k) => {
      const p = s + k, h = loc.hourly, ti = h.time.map(t => Math.round((t * 1000 - times[0]) / 3600000));
      for (let q = 0; q < ti.length; q++) {
        const t = ti[q]; if (t < 0 || t >= T) continue;
        const o = t * N + p;
        const sp = h.wind_speed_10m[q], dir = h.wind_direction_10m[q];
        if (sp != null && dir != null) { const [u, v] = uvFromSpeedDir(sp, dir); V.u[o] = u; V.v[o] = v; }
        if (h.wind_gusts_10m[q] != null) V.gust[o] = h.wind_gusts_10m[q];
        if (h.precipitation[q] != null) V.precip[o] = h.precipitation[q];
        if (h.cape[q] != null) V.cape[o] = h.cape[q];
        if (h.lightning_potential && h.lightning_potential[q] != null) V.lpi[o] = h.lightning_potential[q];
      }
    });
    progress(e / N, `${label}: ${e}/${N} točaka`);
  }
  return { ...grid, model: id, times, vars: V };
}

export async function fetchOpenMeteoMarine({ grid, times, settings, signal, progress }) {
  const { lats, lons } = coords(grid);
  const N = lats.length, T = times.length, BATCH = 300;
  const make = () => new Float32Array(T * N).fill(NaN);
  const M = { wave: make(), waveDir: make(), wavePer: make(), cu: make(), cv: make() };
  const key = settings.apiKey ? `&apikey=${encodeURIComponent(settings.apiKey.trim())}` : '';
  for (let s = 0; s < N; s += BATCH) {
    const e = Math.min(N, s + BATCH);
    const url = `${apiBase('marine', settings)}?latitude=${lats.slice(s, e).join(',')}&longitude=${lons.slice(s, e).join(',')}&hourly=${MARINE_VARS.join(',')}&start_hour=${isoHour(times[0])}&end_hour=${isoHour(times[T - 1])}&timeformat=unixtime&timezone=GMT&cell_selection=sea${key}`;
    let res; try { res = await fetchJSON(url, signal, progress); } catch (err) { console.warn('marine', err); continue; }
    if (!Array.isArray(res)) res = [res];
    res.forEach((loc, k) => {
      const p = s + k, h = loc.hourly;
      h.time.forEach((tt, q) => {
        const t = Math.round((tt * 1000 - times[0]) / 3600000); if (t < 0 || t >= T) return;
        const o = t * N + p;
        if (h.wave_height[q] != null) { M.wave[o] = h.wave_height[q]; M.waveDir[o] = h.wave_direction[q]; M.wavePer[o] = h.wave_period[q]; }
        if (h.ocean_current_velocity[q] != null) {
          const spd = h.ocean_current_velocity[q] / 1.852, d = h.ocean_current_direction[q] * Math.PI / 180; // direction TO
          M.cu[o] = spd * Math.sin(d); M.cv[o] = spd * Math.cos(d);
        }
      });
    });
    progress(e / N, `Valovi i struje: ${e}/${N} točaka`);
  }
  return { ...grid, model: 'marine', times, vars: M };
}

// -------- Meteomatics (paid): regular grid in one request per model --------
async function fetchMeteomatics({ mm, grid, times, settings, signal, progress }) {
  const T = times.length, N = grid.nx * grid.ny;
  const make = () => new Float32Array(T * N).fill(NaN);
  const V = { u: make(), v: make(), gust: make(), precip: make(), cape: make(), lpi: make() };
  const n = (grid.lat0 + (grid.ny - 1) * grid.dlat).toFixed(4), s = grid.lat0.toFixed(4);
  const w = grid.lon0.toFixed(4), e = (grid.lon0 + (grid.nx - 1) * grid.dlon).toFixed(4);
  const params = 'wind_speed_10m:kn,wind_dir_10m:d,wind_gusts_10m_1h:kn,precip_1h:mm,cape:Jkg';
  const url = `https://api.meteomatics.com/${new Date(times[0]).toISOString().slice(0, 19)}Z--${new Date(times[T - 1]).toISOString().slice(0, 19)}Z:PT1H/${params}/${n},${w}_${s},${e}:${grid.dlat},${grid.dlon}/json?model=${mm}`;
  progress(null, `Meteomatics ${mm}…`);
  const auth = btoa(`${settings.mmUser}:${settings.mmPass}`);
  // Meteomatics sends no CORS header, so in the Mac app it goes through the local proxy
  const j = settings._native
    ? await fetchJSON(`/proxy?u=${encodeURIComponent(url)}&auth=${encodeURIComponent(auth)}`, signal, progress)
    : await fetchJSON(url, signal, progress, { headers: { Authorization: 'Basic ' + auth } });
  const by = {}; j.data.forEach(d => { by[d.parameter.split(':')[0]] = d.coordinates; });
  const idx = (lat, lon) => Math.round((lat - grid.lat0) / grid.dlat) * grid.nx + Math.round((lon - grid.lon0) / grid.dlon);
  const tIdx = d => Math.round((Date.parse(d) - times[0]) / 3600000);
  const sp = by.wind_speed_10m || [], dr = by.wind_dir_10m || [];
  sp.forEach((c, k) => {
    const p = idx(c.lat, c.lon);
    c.dates.forEach((d, q) => { const t = tIdx(d.date); const dir = dr[k] && dr[k].dates[q].value; if (t >= 0 && t < T && d.value != null && dir != null) { const [u, v] = uvFromSpeedDir(d.value, dir); V.u[t * N + p] = u; V.v[t * N + p] = v; } });
  });
  const put = (arr, name) => (by[name] || []).forEach(c => { const p = idx(c.lat, c.lon); c.dates.forEach(d => { const t = tIdx(d.date); if (t >= 0 && t < T && d.value != null) arr[t * N + p] = d.value; }); });
  put(V.gust, 'wind_gusts_10m_1h'); put(V.precip, 'precip_1h'); put(V.cape, 'cape');
  return { ...grid, model: 'mm:' + mm, times, vars: V };
}

function validUntil(f) {
  const N = f.nx * f.ny, u = f.vars.u;
  for (let t = f.times.length - 1; t >= 0; t--) for (let p = 0; p < N; p += 3) if (u[t * N + p] === u[t * N + p]) return f.times[t];
  return null;
}

// Download a forecast set synchronised to the race.
export async function downloadForecast({ bbox, modelIds, window, quality, settings, progress = () => {}, signal }) {
  const times = hours(window.t0, window.t1);
  const fields = {}, empty = [], errors = [];
  progress(0, 'Provjeravam zadnje runove modela…');
  const meta = await fetchModelMeta(modelIds);
  const jobs = modelIds.length + 1;
  let done = 0;
  const sub = (f, t) => progress(f == null ? null : (done + f) / jobs, t);
  for (const id of modelIds) {
    const m = modelById(id);
    try {
      let f;
      if (id.startsWith('mm:')) {
        if (!settings.mmUser) throw new Error('nema Meteomatics korisničkog računa (Postavke → Plaćeni izvori)');
        f = await fetchMeteomatics({ mm: m.mm, grid: gridFor(bbox, 0.01, quality), times, settings, signal, progress: sub });
      } else {
        f = await fetchOpenMeteoModel({ id, grid: gridFor(bbox, m.step, quality), times, settings, signal, progress: sub, label: m.name });
      }
      f.validUntil = validUntil(f);
      f.run = meta[id] || null;
      if (f.validUntil == null) empty.push(id); else fields[id] = f;
    } catch (err) {
      if (err.name === 'AbortError' || err.daily) throw err; // no point trying the other models
      console.warn(id, err); errors.push(`${m.name}: ${err.message}`);
    }
    progress(++done / jobs, `${m.name} gotov`);
  }
  fields.marine = await fetchOpenMeteoMarine({ grid: gridFor(bbox, MARINE_STEP, quality), times, settings, signal, progress: sub });
  progress(1, 'Gotovo');
  const models = modelIds.filter(id => fields[id]);
  if (!models.length) throw new Error('Nijedan model nije vratio podatke. ' + errors.join(' · '));
  return { id: 'fc-' + Date.now(), created: Date.now(), bbox, quality, window, models, empty, errors, times, fields };
}

// newer model runs available since the set was downloaded?
export async function checkNewRuns(set) {
  if (!set || !navigator.onLine) return [];
  const meta = await fetchModelMeta(set.models);
  return set.models.filter(id => meta[id] && set.fields[id].run && meta[id].runInit > set.fields[id].run.runInit)
    .map(id => ({ id, runInit: meta[id].runInit }));
}

export async function saveForecast(set) { await kv.set('forecast:latest', set); }
export async function loadForecast() { return kv.get('forecast:latest'); }

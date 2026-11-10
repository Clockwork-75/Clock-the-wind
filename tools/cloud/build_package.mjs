// Clock the Wind – cloud forecast package builder.
// Runs on GitHub Actions (or any machine with Node 20+ and bzip2): downloads open-data GRIBs straight from
// DWD (ICON-D2, ICON-EU), ECMWF (IFS 0.25°) and NOAA (GFS), plus waves/currents and – if possible – ICON-2I
// from Open-Meteo, crops everything to the Adriatic and writes one compact package (data/latest.ctw).
// No API limits apply to the open-data sources.  Usage: node tools/cloud/build_package.mjs data/latest.ctw
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeGrib, cropMsg, gribToField } from '../../js/grib.js';
import { exportPackage, globalSteps } from '../../js/direct.js';
import { downloadForecast, fetchOpenMeteoMarine, gridFor, MARINE_STEP } from '../../js/forecast.js';

const OUT = process.argv[2] || 'data/latest.ctw';
const BBOX = { s: 41.8, n: 45.9, w: 12.2, e: 19.8 };
// ECMWF and GFS (0.25°) also cover the wider Mediterranean, so the wind is there when you zoom out; the regional
// models (ICON-D2/EU/2I) and waves stay on the Adriatic
const WIDE = { s: 30.0, n: 46.5, w: -6.0, e: 36.5 };
const H = 3600000;
const HOURS = +(process.env.CTW_HOURS || 360);   // 15 days: ECMWF to 360 h, GFS to 384 h (6-hourly after 144/120 h); ICON 48/120 h
const t0 = Math.floor(Date.now() / H) * H - H, t1 = t0 + HOURS * H;
const pad = (n, l) => String(n).padStart(l, '0');
const ymd = t => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`; };
const hh = t => pad(new Date(t).getUTCHours(), 2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const UA = { 'User-Agent': 'ClockTheWind-cloud/1.0 (sailing routing; github actions)' };

async function get(url, headers = {}, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...headers } });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 1500 * (k + 1)));
  }
  return null;
}
const exists = async url => { try { const r = await fetch(url, { method: 'HEAD', headers: UA }); return r.ok; } catch { return false; } };
const bunzip = buf => { const r = spawnSync('bzip2', ['-dc'], { input: buf, maxBuffer: 512 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }
const toAB = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function addMsgs(buf, msgs, box = BBOX) { for (const m of decodeGrib(toAB(buf))) { const c = cropMsg(m, box); if (c) msgs.push(c); } }

// ---------------- DWD ICON (D2 / EU) ----------------
async function dwd(kind) {
  const every = kind === 'd2' ? 3 : 6, max = kind === 'd2' ? 48 : 120;
  const url = (run, h, v) => kind === 'd2'
    ? `https://opendata.dwd.de/weather/nwp/icon-d2/grib/${hh(run)}/${v}/icon-d2_germany_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_2d_${v}.grib2.bz2`
    : `https://opendata.dwd.de/weather/nwp/icon-eu/grib/${hh(run)}/${v}/icon-eu_europe_regular-lat-lon_single-level_${ymd(run)}${hh(run)}_${pad(h, 3)}_${v.toUpperCase()}.grib2.bz2`;
  let run = Math.floor((Date.now() - 1.5 * H) / (every * H)) * every * H;
  for (let k = 0; k < 4 && !(await exists(url(run, max, 'u_10m'))); k++) run -= every * H; // whole run must be complete
  const steps = [];
  for (let h = 0; h <= max; h += (kind === 'eu' && h >= 78) ? 3 : 1) { const v = run + h * H; if (v >= t0 && v <= t1) steps.push(h); }
  const msgs = [];
  await pool(steps.flatMap(h => ['u_10m', 'v_10m', 'vmax_10m'].map(v => [h, v])), 8, async ([h, v]) => {
    const b = await get(url(run, h, v)); if (!b) return;
    const raw = bunzip(b); if (raw) addMsgs(raw, msgs);
  });
  log(`ICON-${kind.toUpperCase()} run ${ymd(run)} ${hh(run)}z: ${msgs.length} polja`);
  const f = gribToField(msgs, null, kind === 'd2' ? 'dir_icon_d2' : 'dir_icon_eu'); f.run = { runInit: run }; return f;
}

// ---------------- ECMWF open data (IFS 0.25°) ----------------
async function ecmwf() {
  const base = (run, h) => `https://data.ecmwf.int/forecasts/${ymd(run)}/${hh(run)}z/ifs/0p25/oper/${ymd(run)}${hh(run)}0000-${h}h-oper-fc`;
  const need = r => Math.max(144, Math.min(360, Math.ceil((t1 - r) / H / 6) * 6));   // the run must be published that far
  let run = Math.floor((Date.now() - 7 * H) / (12 * H)) * 12 * H;
  for (let k = 0; k < 3 && !(await exists(base(run, need(run)) + '.index')); k++) run -= 12 * H;
  const steps = globalSteps('ecmwf', run, t0, t1, 3);
  const msgs = [];
  await pool(steps, 6, async h => {
    const idx = await get(base(run, h) + '.index'); if (!idx) return;
    // gusts: '10fg' (max since the previous step) – later steps can carry it under another name ('10fg3', '10fg6');
    // take whichever the step has, otherwise the gusts end early and the map would show stale ones
    const idxs = idx.toString().trim().split('\n').map(l => JSON.parse(l));
    const g = ['10fg', '10fg3', '10fg6', 'i10fg'].find(n => idxs.some(j => j.param === n));
    const want = new Set(['10u', '10v', ...(g ? [g] : [])]);
    for (const j of idxs.filter(j => want.has(j.param))) {
      const b = await get(base(run, h) + '.grib2', { Range: `bytes=${j._offset}-${j._offset + j._length - 1}` });
      if (b) addMsgs(b, msgs, WIDE);
    }
  });
  log(`ECMWF run ${ymd(run)} ${hh(run)}z: ${msgs.length} polja`);
  const f = gribToField(msgs, null, 'dir_ecmwf'); f.run = { runInit: run }; return f;
}

// ---------------- NOAA GFS (server-side subset) ----------------
async function gfs() {
  const b = WIDE;
  const url = (run, h) => `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.${ymd(run)}%2F${hh(run)}%2Fatmos&file=gfs.t${hh(run)}z.pgrb2.0p25.f${pad(h, 3)}&var_UGRD=on&var_VGRD=on&var_GUST=on&lev_10_m_above_ground=on&lev_surface=on&subregion=&toplat=${Math.ceil(b.n + 0.5)}&leftlon=${Math.floor(b.w - 0.5)}&rightlon=${Math.ceil(b.e + 0.5)}&bottomlat=${Math.floor(b.s - 0.5)}`;
  let run = Math.floor((Date.now() - 4.5 * H) / (6 * H)) * 6 * H, ok = false;
  const need = r => Math.max(120, Math.min(384, Math.ceil((t1 - r) / H / 6) * 6));
  for (let k = 0; k < 3 && !ok; k++) { const t = await get(url(run, need(run)), {}, 1); ok = !!(t && t.length > 100); if (!ok) run -= 6 * H; }
  const steps = globalSteps('gfs', run, t0, t1, 3);
  const msgs = [];
  await pool(steps, 2, async h => { const buf = await get(url(run, h)); if (buf) addMsgs(buf, msgs, WIDE); });   // NOMADS asks for gentle use
  log(`GFS run ${ymd(run)} ${hh(run)}z: ${msgs.length} polja`);
  const f = gribToField(msgs, null, 'dir_gfs'); f.run = { runInit: run }; return f;
}

// ---------------- Météo-France ARPEGE Europe 0.1° (open data on data.gouv.fr, no key) ----------------
// files of 12 h each (all hours inside), package SP1 = 10 m wind + gusts; runs 00/06/12/18 UTC, up to 102 h
async function arpege() {
  // since May 2026 Météo-France feeds files.data.gouv.fr (302 to their object storage); a public OVH mirror has the same layout
  const HOSTS = ['https://files.data.gouv.fr/meteofrance-pnt/pnt', 'https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net/pnt', 'https://object.data.gouv.fr/meteofrance-pnt/pnt'];
  const SETS = [['000H012H', '013H024H', '025H036H', '037H048H', '049H060H', '061H072H', '073H084H', '085H096H', '097H102H'],
                ['000H024H', '025H048H', '049H072H', '073H102H']];
  const stamp = r => new Date(r).toISOString().slice(0, 19) + 'Z';   // 2026-11-10T00:00:00Z
  const url = (host, r, rg) => `${host}/${stamp(r)}/arpege/01/SP1/arpege__01__SP1__${rg}__${stamp(r)}.grib2`;
  const probe = async u => { try { const r = await fetch(u, { headers: { ...UA, Range: 'bytes=0-15' } }); const ok = r.ok || r.status === 206; try { await r.arrayBuffer(); } catch { } return ok; } catch { return false; } };
  let run = Math.floor((Date.now() - 3 * H) / (6 * H)) * 6 * H, host = null, RANGES = null;
  for (let k = 0; k < 6 && !host; k++) {
    for (const h of HOSTS) { for (const set of SETS) if (await probe(url(h, run, set[0]))) { host = h; RANGES = set; break; } if (host) break; }
    if (!host) { log(`ARPEGE: run ${stamp(run)} nije nađen`); run -= 6 * H; }
  }
  if (!host) throw new Error('ARPEGE: nijedan run nije dostupan');
  log(`ARPEGE: ${url(host, run, RANGES[0])}`);
  const msgs = [];
  for (const rg of RANGES) {
    if (run + parseInt(rg.slice(5, 8), 10) * H < t0) continue;   // all of it already in the past
    const buf = await get(url(host, run, rg));
    if (!buf) { log(`ARPEGE ${rg}: nema (run završava ranije)`); break; }
    const before = msgs.length;
    for (const m of decodeGrib(toAB(buf))) { if (!['U', 'V', 'gust', 'gu', 'gv'].includes(m.name)) continue; const c = cropMsg(m, BBOX); if (c) msgs.push(c); }
    log(`ARPEGE ${rg}: ${(buf.length / 1048576).toFixed(0)} MB, ${msgs.length - before} polja`);
  }
  log(`ARPEGE run ${ymd(run)} ${hh(run)}z : ${msgs.length} polja`);
  const f = gribToField(msgs.filter(m => m.valid >= t0 - H), null, 'dir_arpege'); f.run = { runInit: run };
  f.meta = { id: 'dir_arpege', name: 'ARPEGE', res: '0.1° · Météo-France', color: '#e040fb', note: 'Météo-France ARPEGE Europe 0.1° (~11 km) – do ~4 dana, svaki sat' };
  return f;
}

// ---------------- DHMZ ALADIN-HR20 (2 km, wind-optimised) – open GRIB data for sailors ----------------
// runs 00 and 12 UTC (ready ~02:50 / 14:50 UTC), 72 h, hourly, domain ADR = whole Adriatic. The login is DHMZ's
// shared open-data account, read from the GitHub secrets ALADIN_USER / ALADIN_PASS (not stored in the repository).
async function aladin() {
  const user = process.env.ALADIN_USER, pass = process.env.ALADIN_PASS;
  if (!user || !pass) throw new Error('ALADIN-HR: nema prijave (GitHub tajne ALADIN_USER / ALADIN_PASS)');
  const BASE = 'https://radar.dhz.hr/~aladinhr/opendata/sailing/';
  const auth = { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
  const list = async u => { const b = await get(u, auth); return b ? [...b.toString().matchAll(/href="([^"?/][^"]*)"/g)].map(m => m[1]) : []; };
  const top = await list(BASE);
  const files = top.filter(n => !n.endsWith('/'));
  for (const d of top.filter(n => n.endsWith('/'))) files.push(...(await list(BASE + d)).filter(n => !n.endsWith('/')).map(n => d + n));
  const adr = files.filter(n => /adr/i.test(n) && !/\.(html?|txt|png|jpe?g|pdf|nc)$/i.test(n)).sort();
  log(`ALADIN-HR: ${files.length} datoteka, ADR: ${adr.slice(-3).join(', ')}`);
  if (!adr.length) throw new Error('ALADIN-HR: nema datoteke za cijeli Jadran (ADR)');
  const f0 = adr[adr.length - 1];
  let buf = await get(BASE + f0, auth); if (!buf) throw new Error('ALADIN-HR: preuzimanje nije uspjelo');
  if (buf[0] === 0x42 && buf[1] === 0x5a) buf = bunzip(buf);
  else if (buf[0] === 0x1f && buf[1] === 0x8b) buf = (await import('node:zlib')).gunzipSync(buf);
  const msgs = []; for (const m of decodeGrib(toAB(buf))) { const c = cropMsg(m, BBOX); if (c) msgs.push(c); }
  log(`ALADIN-HR ${f0}: ${(buf.length / 1048576).toFixed(1)} MB, ${msgs.length} polja`);
  const all = msgs.filter(m => m.valid >= t0 - H);
  const f = gribToField(all.length ? all : msgs, null, 'dir_aladin');
  const ts = msgs.map(m => m.valid).sort((a, b) => a - b);
  f.run = { runInit: Math.floor(ts[0] / (12 * H)) * 12 * H };
  f.meta = { id: 'dir_aladin', name: 'ALADIN-HR', res: '2 km · DHMZ', color: '#ff1744', note: 'DHMZ ALADIN-HR20 – 2 km, optimiziran za vjetar, cijeli Jadran, 72 h, svaki sat' };
  return f;
}

// ---------------- build ----------------
const fields = {}, errors = [];
const times = []; for (let t = t0; t <= t1; t += H) times.push(t);
for (const [name, job] of [['ICON-D2', () => dwd('d2')], ['ICON-EU', () => dwd('eu')], ['ALADIN', aladin], ['ARPEGE', arpege], ['ECMWF', ecmwf], ['GFS', gfs]].filter(([n]) => !process.env.CTW_ONLY || process.env.CTW_ONLY.split(',').includes(n))) {
  try { const f = await job(); fields[f.model] = f; }
  catch (e) { errors.push(`${name}: ${e.message}`); log('!!', name, e.message); }
}
// ICON-2I (best model for the southern Adriatic) and waves/currents via Open-Meteo – optional
const settings = { apiKey: process.env.OPEN_METEO_KEY || '' };
try {
  const om = await downloadForecast({ bbox: BBOX, modelIds: ['italia_meteo_arpae_icon_2i'], window: { t0, t1: Math.min(t1, t0 + 72 * H) }, quality: 'standard', settings, progress: () => {} });
  for (const id of om.models) fields[id] = om.fields[id];
  fields.marine = om.fields.marine;
  log('ICON-2I + valovi/struje: OK');
} catch (e) {
  errors.push('ICON-2I: ' + (e.daily ? 'Open-Meteo dnevni limit (dodaj OPEN_METEO_KEY tajnu za ICON-2I)' : e.message)); log('!! ICON-2I', e.message);
  try { fields.marine = await fetchOpenMeteoMarine({ grid: gridFor(BBOX, MARINE_STEP, 'standard'), times: times.filter(t => t <= t0 + 8 * 24 * H), settings, progress: () => {} }); log('valovi/struje: OK'); }
  catch (e2) { errors.push('valovi/struje: ' + e2.message); }
}
if (!fields.marine) fields.marine = { lat0: BBOX.s, lon0: BBOX.w, dlat: 1, dlon: 1, nx: 1, ny: 1, times, vars: { wave: new Float32Array(times.length).fill(NaN), waveDir: new Float32Array(times.length).fill(NaN), wavePer: new Float32Array(times.length).fill(NaN), cu: new Float32Array(times.length).fill(NaN), cv: new Float32Array(times.length).fill(NaN) } };
const order = ['dir_aladin', 'italia_meteo_arpae_icon_2i', 'dir_icon_d2', 'dir_icon_eu', 'dir_arpege', 'dir_ecmwf', 'dir_gfs'];
const models = order.filter(id => fields[id]);
if (!models.length) { console.error('Nijedan model – paket se ne zapisuje', errors); process.exit(1); }
const set = { id: 'cloud-' + Date.now(), created: Date.now(), bbox: BBOX, quality: 'cloud', source: 'cloud', mode: 'forecast', window: { t0, t1 }, models, empty: [], errors, times, fields };
const blob = await exportPackage(set);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(await blob.arrayBuffer()));
writeFileSync(OUT.replace(/\.ctw$/, '.json'), JSON.stringify({ created: set.created, models: models.map(id => ({ id, run: fields[id].run && fields[id].run.runInit, until: fields[id].validUntil })), errors }, null, 1));
log(`Zapisano ${OUT}: ${(blob.size / 1048576).toFixed(1)} MB, modeli: ${models.join(', ')}`);

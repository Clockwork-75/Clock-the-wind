import { Polar, parsePolarCSV, parsePolarAny } from './polar.js';
import { recommendSail, SAILS } from './sails.js';
import { decodeLandmask, isLand, snapToSea } from './landmask.js';
import { loadBathy, routingMask, depthAt } from './bathy.js';
import { sample } from './field.js';
import { MODELS, MM_MODELS, ALADIN, QUALITY, MARINE_STEP, modelById, registerModel, gridFor, raceWindow, estimateCalls, downloadForecast, checkNewRuns, saveForecast, loadForecast } from './forecast.js';
import { decodeGrib, gribToField } from './grib.js';
import { DIRECT, directUsable, nativeAvailable, downloadDirect, exportPackage, isPackage, importPackage, fetchCloudPackage, CLOUD_DEFAULT } from './direct.js';
import { WeatherLayer, ParticleLayer, ChartLayer, DepthLayer, LAYERS, decodeCoast, colorFor, ISOBATHS } from './layers.js';
import { PRESETS, REGATTAS, PLACES } from './courses.js';
import { speedDirFromUV, distNm, bearing, fmtLatLon, angDiff } from './geo.js';
import { kv } from './db.js';
import { playIntro } from './intro.js';
playIntro();

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const TZ = 'Europe/Zagreb';
const DAYS = ['ned', 'pon', 'uto', 'sri', 'čet', 'pet', 'sub'];

// ---------------- persistent settings ----------------
const DEFAULTS = {
  apiKey: '', efficiency: 100, tackPenaltySec: 25, gybePenaltySec: 20, dtMin: 10, useCurrents: true, wavePenalty: true,
  quality: 'standard', dlModels: MODELS.filter(m => m.def).map(m => m.id), basemap: 'nautical', seamarks: false,
  colorOverLand: false, opacity: 0.85, arrows: 'arrows', particles: true, showNumbers: false, layer: 'wind', particleDensity: 1,
  colors: true, hiRes: true, draft: 2.6, depthMargin: 1.4, avoidShallow: true, boatId: 'melges40', mmUser: '', mmPass: '',
};
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('ctw.settings') || '{}'));
if (settings.basemap === 'offline' && !localStorage.getItem('ctw.v2')) { settings.basemap = 'nautical'; localStorage.setItem('ctw.v2', '1'); }
const saveSettings = () => localStorage.setItem('ctw.settings', JSON.stringify(settings));
// v0.6: lighter defaults for Open-Meteo (free daily quota)
if (!localStorage.getItem('ctw.v6')) {
  settings.quality = 'standard';
  settings.dlModels = settings.dlModels.filter(id => id !== 'gfs_seamless');
  localStorage.setItem('ctw.v6', '1'); localStorage.setItem('ctw.settings', JSON.stringify(settings));
}
let course = JSON.parse(localStorage.getItem('ctw.course') || 'null') || { regattaId: 'viska', stage: 0, name: 'Viška regata', marks: REGATTAS[0].stages[0].marks.map(m => ({ ...m })), start: null };
// v0.10: regattas with stages and official names – migrate older saved courses to the new data
if (!localStorage.getItem('ctw.v10course')) {
  const old = { viski: ['viska', 0], jabuka: ['jabuka', 0], mrdujska: ['mrdujska', 0], susac: ['susac', 0], fiumanka: ['fiumanka', 0], 'rovinj-pula': ['rovinj-pula', 0] }[course.preset];
  if (old) { const r = REGATTAS.find(x => x.id === old[0]); Object.assign(course, { regattaId: r.id, stage: old[1], name: r.name, marks: r.stages[old[1]].marks.map(m => ({ ...m })) }); }
  if (!course.name) course.name = 'Moja regata';
  delete course.preset;
  localStorage.setItem('ctw.course', JSON.stringify(course)); localStorage.setItem('ctw.v10course', '1');
}
const saveCourse = () => { localStorage.setItem('ctw.course', JSON.stringify(course)); markStale(); };
// remove calculated routes (map, replay, saved copy)
// Saved routes are kept per regatta/stage (or per own course): { key: { routes, course, savedAt } }.
// They appear whenever that regatta is open, until you delete them; nothing is saved without "Spremi rute".
const courseKey = c => c.regattaId ? `${c.regattaId}#${c.stage || 0}` : 'own:' + c.marks.map(m => m.lat.toFixed(3) + ',' + m.lon.toFixed(3)).join(';');
async function savedMap() { const m = await kv.get('routes:savedByCourse').catch(() => null); return m && typeof m === 'object' ? m : {}; }
const sameMarks = (a, b) => a && b && a.length === b.length && a.every((m, i) => Math.abs(m.lat - b[i].lat) < 1e-6 && Math.abs(m.lon - b[i].lon) < 1e-6);
async function showSavedRoutes() {
  if (!course.marks.length) return false;
  const e = (await savedMap())[courseKey(course)];
  if (!e || !e.routes) return false;
  state.routes = e.routes; state.routesSaved = true;
  const ok = Object.values(state.routes).filter(r => r.ok); state.selected = ok.length ? ok.sort((a, b) => a.eta - b.eta)[0].model : null;
  if (!sameMarks(e.course && e.course.marks, course.marks)) markStale();   // buoys moved since saving
  drawRoutes(); return true;
}
async function clearRoutes(keepSaved = false) {
  replayPause && replayPause();
  state.routes = {}; state.selected = null;
  if (!keepSaved) {   // "Obriši": this course's routes are gone for good (other regattas keep theirs)
    const m = await savedMap(); delete m[courseKey(course)]; await kv.set('routes:savedByCourse', m).catch(() => {});
  }
  state.routesSaved = false;
  drawRoutes();
  if (!$('#sheet').classList.contains('hidden') && $('.tabs [data-tab=compare].on')) renderCompareTab();
}
// keep the routes after the app closes – only when the user asks for it
async function saveRoutes() {
  const ok = Object.fromEntries(Object.entries(state.routes).filter(([, r]) => r && r.ok));
  if (!Object.keys(ok).length) return toast('Nema izračunatih ruta za spremanje');
  const m = await savedMap();
  m[courseKey(course)] = { routes: ok, course: JSON.parse(JSON.stringify(course)), savedAt: Date.now() };
  await kv.set('routes:savedByCourse', m);
  state.routesSaved = true; toast(`Rute su spremljene za „${course.name}“ – ostaju dok ih ne obrišeš`);
}
// remove the whole course (marks, name, start) and its routes; built-in regattas stay available in the list
async function clearCourse() {
  setEditing(false);
  await clearRoutes();   // this course's routes, saved ones included
  Object.assign(course, { regattaId: '', stage: 0, name: 'Moja regata', start: null });
  course.marks.length = 0;
  saveCourse(); drawCourse(); updateModePill();
}
// two taps: the first arms the button for 4 s, the second deletes (no system dialog needed)
function armDelete(btn, label, action) {
  btn.onclick = async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed'); const t = btn.textContent; btn.textContent = 'Dodirni ponovno za brisanje';
      clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = t; }, 4000);
      return;
    }
    clearTimeout(btn._t); await action(); toast(label);
  };
}

const state = {
  layer: settings.layer, time: Date.now(), wind: null, marine: null, mask: null, bathy: null, coast: null, places: PLACES,
  particles: settings.particles, arrows: settings.arrows, showNumbers: settings.showNumbers, opacity: settings.opacity,
  colorOverLand: settings.colorOverLand, basemap: settings.basemap, theme: 'dark', set: null, modelId: null,
  routes: {}, selected: null, polar: null, boat: null, editing: false, particleDensity: settings.particleDensity,
  colors: settings.colors, hiRes: settings.hiRes, newRuns: [], landAt: null,
};
const minDepth = () => settings.avoidShallow ? settings.draft + settings.depthMargin : 0.05;

// ---------------- map ----------------
const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, minZoom: 5, maxZoom: 17, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 })
  .setView([43.25, 16.1], 9);
const TILE_SETS = {
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO' },
  light: { url: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', labels: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap, © CARTO' },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', attr: 'Esri World Imagery' },
};
const EMODNET = 'https://ows.emodnet-bathymetry.eu/wms';
map.createPane('labels'); map.getPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
map.createPane('routes'); map.getPane('routes').style.zIndex = 460;
let baseLayers = [];
function applyBasemap() {
  baseLayers.forEach(l => map.removeLayer(l)); baseLayers = [];
  const add = l => { baseLayers.push(l.addTo(map)); };
  const t = TILE_SETS[state.basemap];
  if (t) {
    add(L.tileLayer(t.url, { attribution: t.attr, subdomains: 'abcd', maxZoom: 19 }));
    add(L.tileLayer(t.labels, { pane: 'labels', subdomains: 'abcd', maxZoom: 19 }));
  } else if (state.basemap === 'emodnet') {
    add(L.tileLayer.wms(EMODNET, { layers: 'emodnet:mean', styles: 'atlas_land', format: 'image/png', attribution: 'EMODnet Bathymetry', maxZoom: 17 }));
    add(L.tileLayer.wms(EMODNET, { layers: 'emodnet:contours', format: 'image/png', transparent: true, pane: 'labels', maxZoom: 17 }));
    add(L.tileLayer.wms(EMODNET, { layers: 'coastlines', styles: '', format: 'image/png', transparent: true, pane: 'labels', maxZoom: 17 }));
  } else {
    map.attributionControl.addAttribution('Dubine © EMODnet Bathymetry · Obala © GSHHG/OSM');
  }
  if (settings.seamarks) add(L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { pane: 'labels', maxZoom: 18, attribution: '© OpenSeaMap' }));
  document.body.dataset.basemap = state.basemap;
  chartLayer && chartLayer.draw();
  wxLayer && wxLayer.draw();
}
let wxLayer = null, chartLayer = null;
wxLayer = new WeatherLayer(map, state);
chartLayer = new ChartLayer(map, state);
const depthLayer = new DepthLayer(map, state);
const particleLayer = new ParticleLayer(map, state);
applyBasemap();

// ---------------- helpers ----------------
const fmtTime = (t, withDay = true) => {
  const d = new Date(t);
  const p = new Intl.DateTimeFormat('hr-HR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = k => (p.find(x => x.type === k) || {}).value;
  const dayIdx = new Date(d.toLocaleString('en-US', { timeZone: TZ })).getDay();
  return (withDay ? `${DAYS[dayIdx]} ${g('day')}.${g('month')}. ` : '') + `${g('hour')}:${g('minute')}`;
};
const fmtRun = t => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}. ${String(d.getUTCHours()).padStart(2, '0')}z`; };
const raceStart = () => course.start || defaultStart();
// Model colours on the map: each model in the current forecast gets its own slot from a palette chosen to stand out
// against the wind colours (no blues/greens) and against each other. Used everywhere (chips, routes, boats, tables).
// Every model keeps the SAME colour everywhere and always (tabs, routes, boats, tables) – also after a refill or a
// new download. Strong colours that stand out against the wind colours: no blues or greens.
const MODEL_COLORS = {
  italia_meteo_arpae_icon_2i: '#ff1744', icon_d2: '#ff9100', icon_eu: '#ffffff', ecmwf_ifs: '#e040fb', ecmwf: '#e040fb',
  gfs_seamless: '#ffee00', gfs: '#ffee00', knmi_harmonie_arome_europe: '#111111', meteofrance_arpege_europe: '#ff80ab',
  ukmo_global_deterministic_10km: '#8d6e63', ecmwf_aifs025_single: '#9e9e9e',
  'mm:mix': '#ff6e40', 'mm:ecmwf-ifs': '#7c4dff', 'mm:mm-swiss1k': '#f8bbd0',
};
const EXTRA_COLORS = ['#ff6e40', '#7c4dff', '#f8bbd0', '#ffab40', '#b71c1c', '#ce93d8'];   // imported GRIB files
function mcol(id) {
  const k = String(id).replace(/^dir_/, '');
  if (MODEL_COLORS[k]) return MODEL_COLORS[k];
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
}
function markStale() { if (state && state.routes) Object.values(state.routes).forEach(r => { r.stale = true; }); }
const fmtDur = h => { const t = Math.round(h * 60), hh = Math.floor(t / 60), mm = t % 60; return `${hh}h ${String(mm).padStart(2, '0')}m`; };
const toast = (msg, ms = 2600) => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); };
const dirArrow = deg => `<span class="arrowglyph" style="transform:rotate(${deg}deg)">↓</span>`;
const localInputValue = t => { const d = new Date(t); const off = new Date(d.toLocaleString('en-US', { timeZone: TZ })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(t + off).toISOString().slice(0, 16); };
const fromLocalInput = s => { const guess = Date.parse(s + 'Z'); const d = new Date(guess); const off = new Date(d.toLocaleString('en-US', { timeZone: TZ })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })); return guess - off; };

// ---------------- static assets (bathymetry, coast, boats) ----------------
async function loadStatic() {
  try { const cj = await fetch('data/coast.json').then(r => r.ok ? r.json() : null); if (cj) state.coast = decodeCoast(cj); } catch (e) { console.warn('coast', e); }
  try {
    state.bathy = await loadBathy();
    state.landAt = (lat, lon) => { const b = state.bathy, r = Math.floor((b.lat1 - lat) / b.dlat), c = Math.floor((lon - b.lon0) / b.dlon); return r >= 0 && r < b.NR && c >= 0 && c < b.NC && b.codes[r * b.NC + c] === 0; };
    rebuildMask();
  } catch (e) {
    console.warn('bathy unavailable, falling back to GSHHG mask', e);
    const mb = await fetch('data/landmask.bin').then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (mb) { state.mask = decodeLandmask(mb); state.landAt = (lat, lon) => isLand(state.mask, lat, lon); }
  }
  await loadBoats();
  chartLayer.draw();
  depthLayer.draw();
}
function rebuildMask() {
  if (!state.bathy) return;
  state.mask = routingMask(state.bathy, minDepth());
  workers.forEach(w => w.postMessage({ cmd: 'mask', mask: state.mask }));
}

// ---------------- boats (polar library) ----------------
let boats = [];
async function loadBoats() {
  boats = (await kv.get('boats').catch(() => null)) || [];
  if (!boats.find(b => b.id === 'melges40')) {
    const txt = await fetch('data/polar_melges40.csv').then(r => r.text());
    boats.unshift({ id: 'melges40', name: 'Melges 40 Clockwork (ORC 2024)', src: parsePolarCSV(txt), sails: 'melges40', builtin: true });
  }
  selectBoat(settings.boatId);
}
function selectBoat(id) {
  const b = boats.find(x => x.id === id) || boats[0];
  settings.boatId = b.id; saveSettings();
  state.boat = b; state.polar = new Polar(b.src, b.name);
  markStale();
}
async function saveBoats() { await kv.set('boats', boats.filter(b => !b.builtin)); }

// ---------------- forecast set handling ----------------
function useSet(set) {
  state.set = set;
  if (!set) { renderChips(); return; }
  const pref = ['italia_meteo_arpae_icon_2i', 'dir_icon_eu', 'icon_eu', 'ecmwf_ifs', 'dir_ecmwf', 'dir_icon_d2', 'icon_d2', 'knmi_harmonie_arome_europe'];
  if (!state.modelId || !set.fields[state.modelId]) state.modelId = pref.find(id => set.fields[id]) || set.models[0];
  state.wind = withFallback(set, state.modelId);
  drawArea();
  state.marine = set.fields.marine;
  set.models.forEach(id => { if (set.fields[id].meta) registerModel(set.fields[id].meta); });
  const t0 = set.times[0], t1 = set.times[set.times.length - 1];
  const st = raceStart();
  if (state.time < t0 || state.time > t1) state.time = Math.max(t0, Math.min(t1, st >= t0 && st <= t1 ? st : Date.now()));
  setupTimeline();
  renderChips();
  redraw();
}
// display copy of a model that borrows from the next best models wherever it has no data
const FILL_ORDER = ['italia_meteo_arpae_icon_2i', 'dir_icon_d2', 'icon_d2', 'knmi_harmonie_arome_europe', 'dir_icon_eu', 'icon_eu', 'ecmwf_ifs', 'dir_ecmwf', 'meteofrance_arpege_europe', 'ukmo_global_deterministic_10km', 'ecmwf_aifs025_single', 'gfs_seamless', 'dir_gfs'];
function withFallback(set, id) {
  const f = set.fields[id]; if (!f) return f;
  const rank = x => { const i = FILL_ORDER.indexOf(x); return i < 0 ? 99 : i; };
  const others = set.models.filter(m => m !== id && !m.startsWith('grib:')).sort((a, b) => rank(a) - rank(b)).map(m => set.fields[m]);
  const prev = (set.prev || []).map(k => set.fields[k]).filter(Boolean);   // earlier downloads: only where nothing newer exists
  return { ...f, fallback: [...others, ...prev] };
}
// A new download never shrinks what is coloured: the previous forecast stays underneath as a reserve,
// wherever (and whenever) the new one has no data. Old pieces fully covered by the new download are dropped.
// imported GRIB files stay when a new forecast arrives
function keepGribs(set, old) {
  if (!old) return;
  for (const id of old.models.filter(x => x.startsWith('grib:'))) if (!set.fields[id]) { set.fields[id] = old.fields[id]; set.models.push(id); }
}
const extentOf = f => ({ s: f.lat0, n: f.lat0 + f.dlat * (f.ny - 1), w: f.lon0, e: f.lon0 + f.dlon * (f.nx - 1) });
function inheritCoverage(nw, old) {
  if (!nw || !old || nw === old) return;
  const ne = setExtent(nw), t0 = nw.times[0], t1 = nw.times[nw.times.length - 1];
  const inside = (a, b) => b && a.s >= b.s && a.n <= b.n && a.w >= b.w && a.e <= b.e;
  const cand = [...(old.models || []).filter(id => !id.startsWith('grib:')).map(id => [id, old.fields[id]]), ...(old.prev || []).map(k => [k.replace(/^prev\d*:/, ''), old.fields[k]])];
  const keep = [];
  for (const [id, f] of cand) {
    if (!f || !f.nx || !f.times) continue;
    if ((f.validUntil || f.times[f.times.length - 1]) < t0 || f.times[0] > t1) continue;   // no common time
    if (inside(extentOf(f), ne)) continue;                                                   // already covered by the new one
    keep.push([id, f]);
  }
  nw.prev = [];
  keep.slice(0, 8).forEach(([id, f], i) => { const k = `prev${i}:${id}`; nw.fields[k] = f; nw.prev.push(k); });
}
// dashed outline of the downloaded forecast area, so it is always clear where data exists
let areaRect = null;
function drawArea() {
  if (areaRect) { map.removeLayer(areaRect); areaRect = null; }
  const b = state.set && state.set.bbox; if (!b) return;
  areaRect = L.rectangle([[b.s, b.w], [b.n, b.e]], { pane: 'routes', color: '#ffffff', weight: 1.5, opacity: 0.7, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
}
function selectModel(id) {
  state.modelId = id;
  state.wind = withFallback(state.set, id);
  renderChips(); redraw(); updatePointCard();
}
function renderChips() {
  const el = $('#modelChips');
  if (!state.set) { el.innerHTML = `<span class="note" style="margin:0">Nema prognoze – preuzmi (⟳)</span>`; return; }
  el.innerHTML = state.set.models.map(id => {
    const m = modelById(id);
    const run = state.set.fields[id].run, isNew = state.newRuns.some(n => n.id === id);
    return `<button class="chip ${id === state.modelId ? 'on' : ''}" style="--mc:${mcol(id)}" data-model="${id}" title="${run ? 'run ' + fmtRun(run.runInit) : ''}"><i style="background:${mcol(m.id)}"></i>${m.name}<small>${run ? fmtRun(run.runInit) : m.res}</small>${isNew ? '<b class="newdot" title="Dostupan noviji run">●</b>' : ''}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(b => b.onclick = () => selectModel(b.dataset.model));
}

// ---------------- timeline ----------------
const STEP = 15 * 60000;
function setupTimeline() {
  const s = state.set; if (!s) return;
  const sl = $('#tlSlider');
  sl.min = 0; sl.max = Math.round((s.times[s.times.length - 1] - s.times[0]) / STEP); sl.step = 1;
  sl.value = Math.round((state.time - s.times[0]) / STEP);
  drawTimeline();
}
function drawTimeline() {
  const s = state.set; const cv = $('#tlCanvas');
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  if (!s) return;
  const t0 = s.times[0], t1 = s.times[s.times.length - 1], X = t => (t - t0) / (t1 - t0) * (w - 2) + 1;
  // wind strip for the display model at the course start (PredictWind-like day bar)
  const ref = course.marks[0];
  if (state.wind && ref) {
    const out = [];
    for (let t = t0; t < t1; t += 3600000) {
      sample(state.wind, ['u', 'v'], ref.lat, ref.lon, t, out);
      const v = Math.hypot(out[0], out[1]);
      c.fillStyle = v === v ? colorFor('wind', v) : 'rgba(255,255,255,.05)';
      c.fillRect(X(t), 14, X(t + 3600000) - X(t) + 0.5, 8);
    }
  }
  // model validity
  if (state.wind && state.wind.validUntil < t1) { c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(X(state.wind.validUntil), 12, w - X(state.wind.validUntil), 12); }
  // day separators + labels
  c.font = '600 10.5px -apple-system,system-ui'; c.textBaseline = 'top';
  for (let t = t0; t <= t1; t += 3600000) {
    const hh = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(t);
    const x = X(t);
    if (hh === 0) { c.fillStyle = 'rgba(255,255,255,.55)'; c.fillRect(x, 0, 1, h); c.fillStyle = '#cfd8e3'; c.fillText(fmtTime(t).slice(0, 10), x + 4, 0); }
    else if (hh % 6 === 0) { c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(x, 24, 1, 6); c.fillStyle = '#8796a8'; c.fillText(String(hh).padStart(2, '0'), x + 2, 24); }
  }
  // race window: start flag + expected racing period
  const st = raceStart();
  if (!fcMode() && st >= t0 && st <= t1) {
    const etas = Object.values(state.routes).filter(r => r.ok).map(r => r.eta);
    const end = etas.length ? Math.max(...etas) : st + raceWindow(st, courseLength()).estHours * 3600000;
    c.fillStyle = 'rgba(76,209,138,.16)'; c.fillRect(X(st), 0, Math.max(2, X(Math.min(end, t1)) - X(st)), h);
    c.fillStyle = '#4cd18a'; c.fillRect(X(st) - 1, 0, 2, h);
    c.font = '700 10px -apple-system,system-ui'; c.fillText('START', X(st) + 3, 24);
  }
  // route ETAs
  for (const [id, r] of Object.entries(state.routes)) {
    if (!r.ok || settings.mode !== 'race') continue;
    c.fillStyle = mcol(id);
    c.fillRect(X(r.startTime), 10, Math.max(2, X(r.eta) - X(r.startTime)), 2);
    c.beginPath(); c.arc(X(r.eta), 11, 3, 0, 7); c.fill();
  }
  // now marker + cursor
  const now = Date.now();
  if (now > t0 && now < t1) { c.fillStyle = '#ffb547'; c.fillRect(X(now) - 0.5, 10, 1.5, 16); }
  const x = X(state.time);
  c.fillStyle = '#fff'; c.beginPath(); c.moveTo(x - 6, 30); c.lineTo(x + 6, 30); c.lineTo(x, 22); c.fill();
  c.fillRect(x - 1, 10, 2, 14);
}
function setTime(t, fromSlider = false) {
  const s = state.set; if (!s) return;
  state.time = Math.max(s.times[0], Math.min(s.times[s.times.length - 1], t));
  if (!fromSlider) $('#tlSlider').value = Math.round((state.time - s.times[0]) / STEP);
  $('#tlTime').textContent = fmtTime(state.time);
  const m = modelById(state.modelId);
  const run = state.wind && state.wind.run;
  const st = raceStart(), rel = (state.time - st) / 3600000;
  const relNow = (state.time - Date.now()) / 3600000;
  const relTxt = settings.mode === 'forecast' ? (Math.abs(relNow) < 0.5 ? 'sada' : relNow > 0 ? `za ${fmtDur(relNow)}` : `prije ${fmtDur(-relNow)}`)
    : Math.abs(rel) < 0.01 ? 'START' : rel < 0 ? `start za ${fmtDur(-rel)}` : `${fmtDur(rel)} od starta`;
  $('#tlInfo').textContent = `${m ? m.name : ''}${run ? ' run ' + fmtRun(run.runInit) : ''} · ${relTxt}${state.wind && state.time > state.wind.validUntil ? ' · IZVAN dosega modela' : ''}`;
  drawTimeline();
  wxLayer.draw();
  updateBoats();
  updatePointCard();
}
$('#tlSlider').addEventListener('input', e => setTime(state.set.times[0] + e.target.value * STEP, true));
$('#btnPrev').onclick = () => setTime(state.time - 3600000);
$('#btnNext').onclick = () => setTime(state.time + 3600000);
$('#btnNow').onclick = () => setTime(Math.round(Date.now() / STEP) * STEP);
let playing = null;
$('#btnPlay').onclick = () => {
  if (playing) { clearInterval(playing); playing = null; $('#playIcon').setAttribute('d', 'M7 5v14l12-7z'); return; }
  $('#playIcon').setAttribute('d', 'M7 5h4v14H7zM13 5h4v14h-4z');
  playing = setInterval(() => {
    const s = state.set; if (!s) return;
    let t = state.time + STEP;
    if (t > s.times[s.times.length - 1]) t = s.times[0];
    setTime(t);
  }, 160);
};
addEventListener('resize', drawTimeline);

// ---------------- layers ui ----------------
function redraw() { setTime(state.time); renderLegend(); particleLayer.seed(); }
$$('#layerbar [data-layer]').forEach(b => b.onclick = () => {
  state.layer = settings.layer = b.dataset.layer; saveSettings();
  $$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x === b));
  redraw();
});
$$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x.dataset.layer === state.layer));
const syncToggles = () => {
  $('#tglParticles').classList.toggle('on', state.particles);
  $('#tglArrows').classList.toggle('on', state.arrows !== 'none');
  $('#arrowsLbl').textContent = state.arrows === 'barbs' ? 'Perca' : 'Strelice';
  $('#tglNumbers').classList.toggle('on', state.showNumbers);
  $('#ovWaves').classList.toggle('on', !!state.ovWaves);
  $('#ovCurrents').classList.toggle('on', !!state.ovCurrents);
  $('#ovRain').classList.toggle('on', !!state.ovRain);
  $('#ovDepth').classList.toggle('on', !!state.ovDepth);
  $('#tglColors').classList.toggle('on', state.colors !== false);
};
if (settings.ovDepth === undefined) settings.ovDepth = true; // depths visible by default
[['#ovWaves', 'ovWaves'], ['#ovCurrents', 'ovCurrents'], ['#ovRain', 'ovRain'], ['#ovDepth', 'ovDepth']].forEach(([id, k]) => {
  state[k] = !!settings[k];
  $(id).onclick = () => { state[k] = settings[k] = !state[k]; saveSettings(); syncToggles(); wxLayer.draw(); chartLayer.draw(); depthLayer.draw(); };
});
$('#tglColors').onclick = () => { state.colors = settings.colors = state.colors === false; saveSettings(); syncToggles(); wxLayer.draw(); };
syncToggles();
syncToggles();
$('#tglParticles').onclick = () => { state.particles = settings.particles = !state.particles; saveSettings(); syncToggles(); };
$('#tglArrows').onclick = () => { state.arrows = settings.arrows = state.arrows === 'arrows' ? 'barbs' : state.arrows === 'barbs' ? 'none' : 'arrows'; saveSettings(); syncToggles(); wxLayer.draw(); };
$('#tglNumbers').onclick = () => { state.showNumbers = settings.showNumbers = !state.showNumbers; saveSettings(); syncToggles(); wxLayer.draw(); };

function renderLegend() {
  const L = LAYERS[state.layer], s = L.scale;
  const stops = s.stops.map(([v, c]) => `${c} ${((v - s.lo) / (s.hi - s.lo) * 100).toFixed(1)}%`).join(',');
  const extra = state.layer === 'storm' ? ' · CAPE (⚡ ICON-2I)' : '';
  $('#legend').innerHTML = `<div class="ttl"><span>${L.name}${extra}</span><span>${L.unit}</span></div><div class="bar" style="background:linear-gradient(90deg,${stops})"></div>
    <div class="ticks">${L.legend.map(v => `<span>${v}</span>`).join('')}</div>`;
}

// ---------------- course (marks) ----------------
let markLayer = L.layerGroup().addTo(map);
let courseLine = null;
// regatta marks: start/finish flags, orange racing buoys in between. Only shown while a regatta is active.
const BUOY = n => `<svg viewBox="0 0 32 40" width="30" height="38"><ellipse cx="16" cy="36" rx="9" ry="2.6" fill="rgba(0,0,0,.35)"/>
  <path d="M8 34 L10 12 Q16 6 22 12 L24 34 Z" fill="#ff8a1d" stroke="#5a2a00" stroke-width="1.4"/>
  <path d="M9.2 22 L22.8 22" stroke="#fff" stroke-width="3"/><rect x="14.6" y="2" width="2.8" height="8" fill="#5a2a00"/>
  <text x="16" y="31.5" text-anchor="middle" font-size="9" font-weight="800" font-family="-apple-system,system-ui" fill="#3a1600">${n}</text></svg>`;
const FLAG = (kind) => `<svg viewBox="0 0 32 40" width="30" height="38"><ellipse cx="9" cy="37" rx="7" ry="2.2" fill="rgba(0,0,0,.35)"/>
  <rect x="7.6" y="3" width="2.6" height="34" rx="1" fill="#e9edf2" stroke="#222" stroke-width=".8"/>
  ${kind === 's' ? '<path d="M10 4 L29 10 L10 17 Z" fill="#34c76b" stroke="#0d4d26" stroke-width="1.2"/><text x="16" y="13.5" font-size="7" font-weight="900" font-family="-apple-system,system-ui" fill="#06301a">S</text>'
    : '<g stroke="#111" stroke-width="1"><rect x="10" y="4" width="19" height="13" fill="#fff"/><path fill="#111" d="M10 4h4.75v3.25H10zM19.5 4h4.75v3.25H19.5zM14.75 7.25h4.75v3.25h-4.75zM24.25 7.25H29v3.25h-4.75zM10 10.5h4.75v3.25H10zM19.5 10.5h4.75v3.25H19.5zM14.75 13.75h4.75V17h-4.75zM24.25 13.75H29V17h-4.75z"/></g>'}</svg>`;
function drawCourse() {
  markLayer.clearLayers();
  if (settings.mode !== 'race') return;           // no regatta → clean forecast map, no buoys
  const n = course.marks.length;
  courseLine = L.polyline(course.marks.map(m => [m.lat, m.lon]), { color: '#fff', weight: 1.5, dashArray: '5 6', opacity: 0.75, interactive: false }).addTo(markLayer);
  course.marks.forEach((m, i) => {
    const kind = i === 0 ? 's' : i === n - 1 ? 'f' : 'm';
    const html = kind === 'm' ? BUOY(i) : FLAG(kind);
    const icon = L.divIcon({ className: 'mark-ic', html, iconSize: [30, 38], iconAnchor: kind === 'm' ? [15, 36] : [9, 37] });
    const mk = L.marker([m.lat, m.lon], { draggable: true, autoPan: true, icon, title: m.name, zIndexOffset: 1000 }).addTo(markLayer);
    mk.on('drag', e => { const ll = e.target.getLatLng(); m.lat = +ll.lat.toFixed(5); m.lon = +ll.lng.toFixed(5); courseLine.setLatLngs(course.marks.map(q => [q.lat, q.lon])); });
    mk.on('dragend', () => { saveCourse(); drawCourse(); if (!$('#tab-course').classList.contains('hidden')) renderCourseTab(); });
    mk.bindTooltip(`${m.name}<br><small>povuci za pomicanje</small>`, { direction: 'top', offset: [0, -34] });
  });
}
function courseBBox() {
  const la = course.marks.map(m => m.lat), lo = course.marks.map(m => m.lon);
  let s = Math.min(...la), n = Math.max(...la), w = Math.min(...lo), e = Math.max(...lo);
  const mlat = Math.max(0.3, (n - s) * 0.35), mlon = Math.max(0.4, (e - w) * 0.35);
  return { s: s - mlat, n: n + mlat, w: w - mlon, e: e + mlon };
}

// ---------------- sheet / tabs ----------------
// One switch for the whole app: 'race' = regatta (buoys, routes, start sync) · 'forecast' = clean forecast map
function setMode(m) {
  if (settings.mode === m) { updateModePill(); return; }
  settings.mode = m; saveSettings();
  drawCourse();
  if (m === 'race') { routeLayer.addTo(map); updateBoats(); } else { replayPause(); if (boatPopup) map.closePopup(boatPopup); routeLayer.remove(); }
  renderReplayBar();
  drawTimeline(); updateModePill(); updatePointCard();
  const open = $('.tabs [data-tab].on');
  if (open && !$('#sheet').classList.contains('hidden')) {
    if (m === 'forecast' && ['course', 'routing', 'compare'].includes(open.dataset.tab)) { setEditing(false); $('#sheet').classList.add('hidden'); }
    else openSheet(open.dataset.tab);
  }
}
function updateModePill() {
  const el = $('#modePill'); if (!el) return;
  const race = settings.mode === 'race';
  const r = REGATTAS.find(x => x.id === course.regattaId), st = r && r.stages.length > 1 ? r.stages[course.stage || 0] : null;
  el.innerHTML = race ? `⛵ <span>${course.name || 'Regata'}${st ? ' · ' + st.name.split(':')[0] : ''}</span>` : '🌬 <span>Prognoza</span>';
  el.title = race ? 'Regata aktivna – klikni za samo prognozu' : 'Samo prognoza – klikni za regatu (staza, bove, routing)';
  el.classList.toggle('race', race);
}
function openSheet(tab) {
  if (['course', 'routing', 'compare'].includes(tab) && settings.mode !== 'race') setMode('race');
  $('#sheet').classList.remove('hidden');
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tabbody').forEach(b => b.classList.toggle('on', b.id === 'tab-' + tab));
  ({ course: renderCourseTab, routing: renderRoutingTab, compare: renderCompareTab, data: renderDataTab, settings: renderSettingsTab })[tab]();
}
$$('.tabs [data-tab]').forEach(b => b.onclick = () => openSheet(b.dataset.tab));
$('#sheetClose').onclick = () => { $('#sheet').classList.add('hidden'); setEditing(false); };
$('#btnMenu').onclick = () => $('#sheet').classList.contains('hidden') ? openSheet('data') : $('#sheet').classList.add('hidden');
$('#fabCourse').onclick = () => openSheet('course');
$('#modePill').onclick = () => { if (settings.mode === 'race') { setMode('forecast'); toast('Samo prognoza – bove i rute skrivene (staza je sačuvana)'); } else { setMode('race'); zoomCourse(); openSheet('course'); } };
$('#fabRoute').onclick = () => openSheet(Object.keys(state.routes).length ? 'compare' : 'routing');
$('#btnRefresh').onclick = () => openSheet('data');

function setEditing(on) {
  state.editing = on; document.body.classList.toggle('editing', on);
  const b = $('#btnEdit'); if (b) b.textContent = on ? 'Gotovo s dodavanjem' : '＋ Dodaj oznaku tapom na kartu';
}

function renderCourseTab() {
  const el = $('#tab-course');
  const startT = course.start || defaultStart();
  const reg = REGATTAS.find(x => x.id === course.regattaId);
  const stage = reg ? reg.stages[course.stage || 0] : null;
  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  el.innerHTML = `
    <div class="seg"><button data-cmode="race" class="on">⛵ Regata aktivna</button><button data-cmode="forecast">🌬 Bez regate</button></div>
    <h3>Regata</h3>
    <div class="row"><select id="regSel" class="field" style="max-width:100%;flex:1">
      <option value="">— vlastita regata —</option>
      ${REGATTAS.map(r => `<option value="${r.id}" ${course.regattaId === r.id ? 'selected' : ''}>${r.name}${r.org ? ' · ' + r.org : ''}</option>`).join('')}
    </select></div>
    ${reg && reg.stages.length > 1 ? `<div class="row"><label>Etapa</label><select id="stageSel">${reg.stages.map((s, i) => `<option value="${i}" ${(course.stage || 0) === i ? 'selected' : ''}>${s.name}</option>`).join('')}</select></div>` : ''}
    <div class="editrow"><span class="pen">✏️</span><input id="regName" class="editable" value="${esc(course.name)}" placeholder="Naziv regate"></div>
    ${stage && stage.inport ? `<div class="note warn"><b>In-port race</b> – kratka lokalna staza, za nju se ne radi weather routing. Odaberi drugu etapu za routing.</div>` : `
    <p class="note">Pozicije oznaka su približne – povuci bove na službene pozicije iz upute za jedrenje. Imena možeš mijenjati (✏️).</p>
    <h3>Oznake (redom obilaska)</h3>
    ${(() => { const w = course.marks.map((m, i) => ({ m, i, sn: snapToSea(state.mask, m.lat, m.lon) })).filter(x => x.sn.snapped || x.sn.fail);
      return w.length ? `<div class="note">${w.map(x => x.sn.fail ? `⚠️ <b>${esc(x.m.name)}</b> je duboko u kopnu – povuci bovu na more.` : `ℹ️ <b>${esc(x.m.name)}</b> je na kopnu/plićini – ruta je obilazi na ~${x.sn.nm.toFixed(2)} nm.`).join('<br>')}</div>` : ''; })()}
    <ul class="marks">${course.marks.map((m, i) => `
      <li><span class="n ${i === 0 ? 's' : i === course.marks.length - 1 ? 'f' : ''}">${i === 0 ? 'S' : i === course.marks.length - 1 ? 'C' : i}</span>
        <div class="editrow mini"><span class="pen">✏️</span><input value="${esc(m.name)}" data-i="${i}" class="mname editable" title="Promijeni ime oznake"></div>
        <span class="ll">${fmtLatLon(m.lat, m.lon)}</span>
        <button data-up="${i}" title="Gore">↑</button><button data-del="${i}" title="Obriši">✕</button></li>`).join('')}
    </ul>
    <button id="btnEdit" class="btn block">＋ Dodaj oznaku tapom na kartu</button>
    <div class="row" style="margin-top:12px"><label>Dužina staze (ravno)</label><b>${courseLength().toFixed(1)} nm</b></div>
    <h3>Start</h3>
    <div class="row"><label>Vrijeme starta (lokalno)</label><input type="datetime-local" id="startTime" value="${localInputValue(startT)}"></div>
    <button id="btnZoomCourse" class="btn block">Prikaži stazu na karti</button>
    <button id="btnGoRoute" class="btn primary block">Dalje: Routing →</button>`}
    <h3>Brisanje</h3>
    <button id="btnClearCourse" class="btn block danger">🗑 Obriši stazu i rute</button>
    <div class="note">Briše sve oznake, ime, start i izračunate rute. Gotove regate ostaju u popisu gore – možeš ih ponovno odabrati.</div>`;
  const loadStage = () => {
    const r = REGATTAS.find(x => x.id === course.regattaId), st = r && r.stages[course.stage || 0];
    course.marks = st && !st.inport ? st.marks.map(m => ({ ...m })) : [];
    clearRoutes(true).then(showSavedRoutes);   // hide the previous regatta's routes, show this one's saved routes (if any)
    saveCourse(); drawCourse(); renderCourseTab(); if (course.marks.length) zoomCourse(); updateModePill();
  };
  el.querySelector('[data-cmode=forecast]').onclick = () => { setEditing(false); setMode('forecast'); $('#sheet').classList.add('hidden'); toast('Bez regate – bove i rute su skrivene, staza je sačuvana'); };
  el.querySelector('#regSel').onchange = e => {
    const r = REGATTAS.find(x => x.id === e.target.value);
    if (r) { course.regattaId = r.id; course.stage = r.stages.findIndex(s => !s.inport); course.name = r.name; loadStage(); }
    else { course.regattaId = ''; course.stage = 0; course.name = 'Moja regata'; course.marks.length = 0; if (Object.keys(state.routes).length) clearRoutes(true); saveCourse(); drawCourse(); renderCourseTab(); updateModePill(); setEditing(true); toast('Dodiruj kartu: prvi dodir je start, zadnji cilj', 4000); }
  };
  const ss = el.querySelector('#stageSel'); if (ss) ss.onchange = e => { course.stage = +e.target.value; loadStage(); };
  el.querySelector('#regName').onchange = e => { course.name = e.target.value.trim() || 'Regata'; saveCourse(); updateModePill(); };
  armDelete(el.querySelector('#btnClearCourse'), 'Staza i rute su obrisane', async () => { await clearCourse(); renderCourseTab(); });
  if (stage && stage.inport) return;
  el.querySelectorAll('.mname').forEach(i => i.onchange = () => { course.marks[i.dataset.i].name = i.value.trim() || 'Oznaka'; saveCourse(); drawCourse(); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (course.marks.length <= 2) return toast('Staza treba barem start i cilj'); course.marks.splice(+b.dataset.del, 1); saveCourse(); drawCourse(); renderCourseTab(); });
  el.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (!i) return; [course.marks[i - 1], course.marks[i]] = [course.marks[i], course.marks[i - 1]]; saveCourse(); drawCourse(); renderCourseTab(); });
  el.querySelector('#btnEdit').onclick = () => setEditing(!state.editing);
  setEditing(state.editing);
  el.querySelector('#startTime').onchange = e => {
    course.start = fromLocalInput(e.target.value); saveCourse();
    const s = state.set;
    if (s && !s.models.some(id => s.fields[id].times[0] <= course.start && s.fields[id].validUntil > course.start)) toast('Prognoza ne pokriva novi start – preuzmi je ponovno (kartica Prognoza)', 4500);
    else if (s) setTime(course.start);
    drawTimeline();
  };
  el.querySelector('#btnZoomCourse').onclick = zoomCourse;
  el.querySelector('#btnGoRoute').onclick = () => { setEditing(false); openSheet('routing'); };
}
function courseLength() { let d = 0; for (let i = 1; i < course.marks.length; i++) d += distNm(course.marks[i - 1].lat, course.marks[i - 1].lon, course.marks[i].lat, course.marks[i].lon); return d; }
function zoomCourse() { if (!course.marks.length) return; map.fitBounds(L.latLngBounds(course.marks.map(m => [m.lat, m.lon])).pad(0.35)); }
function defaultStart() { return Math.ceil(Date.now() / 3600000) * 3600000 + 3600000; }

// ---------------- pick forecast area: two taps on opposite corners ----------------
let pick = null;
function startAreaPick() {
  if (pendingRect) { map.removeLayer(pendingRect); pendingRect = null; }
  pick = { a: null, rect: null, mk: null };
  $('#sheet').classList.add('hidden');
  document.body.classList.add('editing');
  toast('Dodirni PRVI ugao područja na karti', 4000);
}
function areaPickClick(ll) {
  if (!pick.a) {
    pick.a = ll;
    pick.mk = L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#ffb547', fillOpacity: 1 }).addTo(map);
    toast('Sada dodirni SUPROTNI ugao', 4000);
    map.on('mousemove', pickPreview);
    return;
  }
  const b = { s: Math.min(pick.a.lat, ll.lat), n: Math.max(pick.a.lat, ll.lat), w: Math.min(pick.a.lng, ll.lng), e: Math.max(pick.a.lng, ll.lng) };
  map.off('mousemove', pickPreview);
  [pick.rect, pick.mk].forEach(x => x && map.removeLayer(x));
  pick = null; document.body.classList.remove('editing');
  if (b.n - b.s < 0.05 || b.e - b.w < 0.05) { toast('Područje je premalo – pokušaj ponovno'); return; }
  settings.customBBox = { s: +b.s.toFixed(3), n: +b.n.toFixed(3), w: +b.w.toFixed(3), e: +b.e.toFixed(3) };
  settings.areaSel = 'custom'; saveSettings();
  drawPendingArea();
  openSheet('data');
  const btn = $('#btnDownload');
  if (btn) { btn.scrollIntoView({ block: 'nearest' }); btn.classList.add('pulse'); setTimeout(() => btn.classList.remove('pulse'), 4000); }
  toast('Područje odabrano – stisni ⬇︎ Preuzmi prognozu', 4000);
}
// the rectangle you picked stays on the map (orange) until it is downloaded or you go back to "Cijeli prozor"
let pendingRect = null;
function drawPendingArea() {
  if (pendingRect) { map.removeLayer(pendingRect); pendingRect = null; }
  if (areaSel() !== 'custom') return;
  const b = settings.customBBox;
  pendingRect = L.rectangle([[b.s, b.w], [b.n, b.e]], { pane: 'routes', color: '#ffb547', weight: 2, dashArray: '6 5', fillOpacity: 0.06, interactive: false }).addTo(map);
}
function pickPreview(e) {
  if (!pick || !pick.a) return;
  if (pick.rect) pick.rect.setBounds([pick.a, e.latlng]);
  else pick.rect = L.rectangle([pick.a, e.latlng], { color: '#ffb547', weight: 2, dashArray: '5 5', fillOpacity: 0.08, interactive: false }).addTo(map);
}

map.on('moveend', () => { const n = $('#areaNote'); if (n && $('#tab-data').classList.contains('on')) n.innerHTML = areaNote(); });

// ---------------- map clicks ----------------
map.on('click', e => {
  if (pick) { areaPickClick(e.latlng); return; }
  if (state.editing) {
    const m = { name: `Oznaka ${course.marks.length}`, lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5) };
    if (state.landAt && state.landAt(m.lat, m.lon)) return toast('Ta točka je na kopnu');
    if (course.marks.length < 2) course.marks.push(m); else course.marks.splice(course.marks.length - 1, 0, m); // insert before finish
    if (course.marks.length === 1) m.name = 'Start'; else if (course.marks.length === 2 && !course.regattaId) m.name = 'Cilj';
    saveCourse(); drawCourse(); renderCourseTab();
    return;
  }
  showPoint(e.latlng.lat, e.latlng.lng);
});

// ---------------- point forecast card (multi-model compare) ----------------
let point = null, pointMarker = null;
function showPoint(lat, lon) {
  point = { lat, lon };
  if (pointMarker) map.removeLayer(pointMarker);
  pointMarker = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#3ec7ff', fillOpacity: 1 }).addTo(map);
  updatePointCard();
}
function updatePointCard() {
  const card = $('#pointCard');
  if (!point || !state.set) { card.classList.add('hidden'); return; }
  const s = state.set, out = [];
  const vals = s.models.map(id => ({ id, o: sample(s.fields[id], ['u', 'v', 'gust', 'precip', 'cape', 'lpi'], point.lat, point.lon, state.time, []) }));
  const hasP = vals.some(v => v.o[3] === v.o[3]), hasC = vals.some(v => v.o[4] === v.o[4]);
  const rows = vals.map(({ id, o: out }) => {
    const m = modelById(id);
    const [tws, twd] = speedDirFromUV(out[0], out[1]);
    const valid = tws === tws;
    return `<tr style="${id === state.modelId ? 'background:rgba(255,255,255,.06)' : ''}"><td><span class="dot" style="background:${mcol(m.id)}"></span>${m.name}</td>
      <td>${valid ? `${dirArrow(twd)} ${Math.round(twd)}°` : '–'}</td><td><b>${valid ? tws.toFixed(1) : '–'}</b></td><td>${out[2] === out[2] ? out[2].toFixed(0) : '–'}</td>
      ${hasP ? `<td>${out[3] === out[3] ? out[3].toFixed(1) : '–'}</td>` : ''}${hasC ? `<td>${out[4] === out[4] ? Math.round(out[4]) : '–'}${out[5] > 0.5 ? ' ⚡' : ''}</td>` : ''}</tr>`;
  }).join('');
  const mo = sample(s.fields.marine, ['wave', 'waveDir', 'wavePer', 'cu', 'cv'], point.lat, point.lon, state.time, []);
  const cs = Math.hypot(mo[3], mo[4]), cd = (Math.atan2(mo[3], mo[4]) * 180 / Math.PI + 360) % 360;
  const mini = !!settings.pcMini, chart = settings.pcChart !== false;
  const sel = state.wind ? (() => { const o = sample(state.wind, ['u', 'v'], point.lat, point.lon, state.time, []); const [a, d] = speedDirFromUV(o[0], o[1]); return a === a ? `${dirArrow(d)} ${Math.round(d)}° <b>${a.toFixed(1)} kn</b>` : '–'; })() : '';
  card.classList.toggle('mini', mini);
  card.innerHTML = `<div class="hd" title="Povuci za pomicanje"><span class="grip">⠿</span><b>${fmtLatLon(point.lat, point.lon)}</b>${mini ? `<span class="pcsum">${sel}</span>` : `<span class="note" style="margin:0">${fmtTime(state.time)}</span>`}
      <span class="pcbtns"><button id="pcChartT" title="Graf" class="${chart ? 'on' : ''}">📈</button><button id="pcMin" title="${mini ? 'Proširi' : 'Smanji'}">${mini ? '▢' : '—'}</button><button id="pcClose" title="Zatvori">✕</button></span></div>
    ${mini ? '' : `<table><tr><th>Model</th><th>Smjer</th><th>kn</th><th>Udar</th>${hasP ? '<th>mm/h</th>' : ''}${hasC ? '<th>CAPE</th>' : ''}</tr>${rows}</table>`}
    <div class="note">${(() => { const d = depthAt(state.bathy, point.lat, point.lon); return d === d ? (d < 0 ? '<b>Kopno</b> · ' : `<b>Dubina ~${d < 10 ? d.toFixed(1) : Math.round(d)} m</b> · `) : ''; })()}Val ${mo[0] === mo[0] ? mo[0].toFixed(1) + ' m / ' + (mo[2] || 0).toFixed(0) + ' s iz ' + Math.round(mo[1]) + '°' : '–'} · Struja ${cs === cs ? cs.toFixed(2) + ' kn prema ' + Math.round(cd) + '°' : '–'}</div>
    ${chart ? '<canvas id="pcChart"></canvas>' : ''}`;
  if (mini) { const n = card.querySelector('.note'); if (n) n.remove(); const c = card.querySelector('#pcChart'); if (c) c.remove(); }
  card.classList.remove('hidden');
  placeCard(card);
  $('#pcClose').onclick = () => { point = null; card.classList.add('hidden'); if (pointMarker) map.removeLayer(pointMarker); };
  $('#pcMin').onclick = () => { settings.pcMini = !mini; saveSettings(); updatePointCard(); };
  $('#pcChartT').onclick = () => { settings.pcChart = !chart; saveSettings(); updatePointCard(); };
  if (!mini && chart) drawMeteogram($('#pcChart'), point);
}
// remember where the user dragged the card; keep it on screen
function placeCard(card) {
  const p = settings.pcPos;
  if (!p) { card.style.left = ''; card.style.top = ''; card.style.bottom = ''; card.style.transform = ''; return; }
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.transform = 'none'; card.style.bottom = 'auto';
  card.style.left = Math.max(4, Math.min(innerWidth - w - 4, p.x)) + 'px';
  card.style.top = Math.max(4, Math.min(innerHeight - h - 4, p.y)) + 'px';
}
(() => {
  const card = $('#pointCard'); let drag = null;
  card.addEventListener('pointerdown', e => {
    if (!e.target.closest('.hd') || e.target.closest('button')) return;
    const r = card.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    try { card.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
    card.classList.add('dragging'); e.preventDefault();
  });
  card.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    settings.pcPos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    placeCard(card);
  });
  const end = () => { if (!drag) return; drag = null; card.classList.remove('dragging'); saveSettings(); };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
  addEventListener('resize', () => placeCard(card));
})();
function drawMeteogram(cv, pt) {
  const s = state.set, dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = s.times[0], t1 = s.times[s.times.length - 1], out = [];
  const series = s.models.map(id => ({ id, pts: s.times.map(t => { sample(s.fields[id], ['u', 'v', 'gust'], pt.lat, pt.lon, t, out); return [t, Math.hypot(out[0], out[1]), out[2]]; }) }));
  let max = 10; series.forEach(se => se.pts.forEach(p => { if (p[1] > max) max = p[1]; }));
  max = Math.ceil(max / 5) * 5 + 5;
  const X = t => 26 + (t - t0) / (t1 - t0) * (w - 30), Y = v => h - 14 - v / max * (h - 22);
  // background bands by wind colour
  c.font = '10px -apple-system,system-ui'; c.fillStyle = '#7f8da0';
  for (let v = 0; v <= max; v += 5) { c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(26, Y(v), w - 30, 1); c.fillStyle = '#7f8da0'; c.fillText(v, 4, Y(v) + 3); }
  for (let t = t0; t <= t1; t += 3600000) {
    const hh = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(t);
    if (hh === 0) { c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(X(t), 0, 1, h - 12); c.fillStyle = '#9aa7b8'; c.fillText(fmtTime(t).slice(0, 10), X(t) + 3, h - 2); }
  }
  series.forEach(se => {
    const col = mcol(se.id), sel = se.id === state.modelId;
    c.strokeStyle = col; c.lineWidth = sel ? 2.4 : 1.3; c.globalAlpha = sel ? 1 : 0.8;
    c.beginPath(); let st = false;
    se.pts.forEach(([t, v]) => { if (v !== v) { st = false; return; } st ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v)); st = true; });
    c.stroke();
    if (sel) { c.setLineDash([2, 3]); c.lineWidth = 1; c.beginPath(); st = false; se.pts.forEach(([t, , g]) => { if (g !== g) { st = false; return; } st ? c.lineTo(X(t), Y(g)) : c.moveTo(X(t), Y(g)); st = true; }); c.stroke(); c.setLineDash([]); }
  });
  c.globalAlpha = 1; c.fillStyle = '#fff'; c.fillRect(X(state.time), 0, 1.5, h - 12);
}

// ---------------- data tab (race-synchronised download / paid sources / GRIB / offline) ----------------
let dlAbort = null;
const H1 = 3600000;
const fcMode = () => settings.mode === 'forecast';
// The whole visible map (+5 % so the colours reach the edges when you pan a little) – whatever the window, that is
// what gets downloaded. Open-Meteo keeps its point count in check through the quality setting (coarser grid).
function viewBBox(k = 0.525) {
  const b = map.getBounds(), c = b.getCenter();
  const hlat = (b.getNorth() - b.getSouth()) * k, hlon = (b.getEast() - b.getWest()) * k;   // no cap: always fill the window
  const r = v => Math.round(v * 1000) / 1000;
  return { s: r(Math.max(-85, c.lat - hlat)), n: r(Math.min(85, c.lat + hlat)), w: r(c.lng - hlon), e: r(c.lng + hlon) };
}
const ADRIATIC = { s: 41.8, n: 45.9, w: 12.2, e: 19.8 };
const union = (a, b) => ({ s: Math.min(a.s, b.s), n: Math.max(a.n, b.n), w: Math.min(a.w, b.w), e: Math.max(a.e, b.e) });
const areaSel = () => settings.areaSel === 'custom' && settings.customBBox ? 'custom' : settings.areaSel === 'adriatic' ? 'adriatic' : 'view';
// forecast: what you see (default) / your rectangle / Adriatic. Race: the same, always including the whole course.
function dlArea() {
  const a = areaSel(), base = a === 'custom' ? settings.customBBox : a === 'adriatic' ? ADRIATIC : viewBBox();
  return fcMode() || !course.marks.length ? base : union(base, courseBBox());
}
function dlWindow() {
  if (!fcMode()) return raceWindow(raceStart(), courseLength());
  const t0 = Math.floor(Date.now() / H1) * H1 - H1;
  return { t0, t1: t0 + (settings.fcDays || 3) * 24 * H1, estHours: 0 };
}
function areaNote() {
  const bb = dlArea(), a = areaSel();
  return `${a === 'view' ? '<b>Cijeli prozor karte</b> – preuzima se točno ono što vidiš kad stisneš Preuzmi' : a === 'custom' ? '<b>Tvoje područje</b> (narančasti okvir)' : '<b>Cijeli Jadran</b>'}${fcMode() ? '' : ' + cijela staza'}<br>${bb.s.toFixed(2)}–${bb.n.toFixed(2)}°N · ${bb.w.toFixed(2)}–${bb.e.toFixed(2)}°E`
    + (settings.source === 'cloud' && (bb.s < ADRIATIC.s - 0.3 || bb.n > ADRIATIC.n + 0.3 || bb.w < ADRIATIC.w - 0.3 || bb.e > ADRIATIC.e + 0.3) ? '<div class="note warn">Paket iz oblaka pokriva samo Jadran – za ovo područje odaberi „GRIB izravno“ ili „Open-Meteo“.</div>' : '');
}
const AREA_UI = () => `<div class="row"><label>Područje</label></div>
    <div class="seg"><button data-area="view" class="${areaSel() === 'view' ? 'on' : ''}">⛶ Cijeli prozor</button><button data-area="custom" class="${areaSel() === 'custom' ? 'on' : ''}">✎ Odaberi na karti</button><button data-area="adriatic" class="${areaSel() === 'adriatic' ? 'on' : ''}">Cijeli Jadran</button></div>
    <div class="note" id="areaNote">${areaNote()}</div>`;
function renderDataTab() {
  const el = $('#tab-data');
  const bb = dlArea(), st = raceStart(), win = dlWindow();
  const est = estimateCalls(bb, settings.dlModels.filter(id => !id.startsWith('mm:')), settings.quality);
  const s = state.set;
  const direct = settings.source === 'direct';
  const cloud = settings.source === 'cloud';
  const dirList = DIRECT.map(m => `<label class="check"><input type="checkbox" data-dir="${m.id}" ${directUsable(m.id, state.native) ? ((settings.directModels || []).includes(m.id) ? 'checked' : '') : 'disabled'}>
      <div><div class="t"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} <small style="color:var(--muted)">${m.res}</small></div><div class="d">${m.note}${directUsable(m.id, state.native) ? '' : ' · <b>samo u Mac aplikaciji</b>'}</div></div></label>`).join('');
  const hrs = Math.max(1, Math.round((win.t1 - win.t0) / 3600000));
  const mb = (settings.directModels || []).filter(id => directUsable(id, state.native)).reduce((a, id) => a + (id === 'dir_icon_d2' ? Math.min(hrs, 48) * 3 * 1.1 : id === 'dir_icon_eu' ? Math.min(hrs, 120) * 3 * 1.0 : id === 'dir_ecmwf' ? Math.ceil(hrs / 3) * 2.1 : Math.ceil(hrs / 3) * (state.native ? 0.05 : 2.8)), 0);
  const free = MODELS.map(m => {
    const g = gridFor(bb, m.step, settings.quality);
    return `<label class="check"><input type="checkbox" value="${m.id}" ${settings.dlModels.includes(m.id) ? 'checked' : ''}>
      <div><div class="t"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} <small style="color:var(--muted)">${m.res} · mreža ${(g.dlat * 60).toFixed(1)} nm</small></div><div class="d">${m.note}</div></div></label>`;
  }).join('');
  const paid = MM_MODELS.map(m => `<label class="check"><input type="checkbox" value="${m.id}" ${settings.dlModels.includes(m.id) ? 'checked' : ''} ${settings.mmUser ? '' : 'disabled'}>
      <div><div class="t"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} <small style="color:var(--muted)">${m.res}</small></div><div class="d">Meteomatics${settings.mmUser ? '' : ' – unesi račun ispod'}</div></div></label>`).join('');
  el.innerHTML = `
    <h3>Što preuzimam</h3>
    <div class="seg"><button data-mode="forecast" class="${fcMode() ? 'on' : ''}">🌬 Samo prognoza</button><button data-mode="race" class="${fcMode() ? '' : 'on'}">⛵ Za regatu</button></div>
    ${fcMode() ? `
    <div class="note">Prognoza za <b>područje koje trenutno vidiš na karti</b>, od sada unaprijed, bez staze i routinga. Pomakni ili zumiraj kartu na željeno područje (npr. cijeli srednji Jadran), pa preuzmi.</div>
${AREA_UI()}
    <div class="row"><label>Dana unaprijed</label><select id="fcDays">${[1, 2, 3, 4, 5, 7, 10].map(v => `<option ${+(settings.fcDays || 3) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="note">Visoko-rezolucijski modeli pokrivaju 2–3 dana (ICON-2I, ICON-D2, HARMONIE). ECMWF, ICON-EU i GFS idu dalje.</div>` : `
    <div class="row"><label>Start regate</label><b>${fmtTime(st)}</b><button class="mini" id="dlChgStart">promijeni</button></div>
    ${AREA_UI()}
    <div class="row"><label>Prozor prognoze</label><span>${fmtTime(win.t0)} → ${fmtTime(win.t1)}</span></div>
    <div class="note">Prozor se automatski računa od starta i procijenjenog trajanja (${fmtDur(win.estHours)} za ${courseLength().toFixed(0)} nm) uz rezervu. Svi modeli se preuzimaju za isti, satni vremenski raspon.</div>`}
    ${s ? `<h3>Trenutna prognoza</h3>
      <div class="note">Preuzeto ${fmtTime(s.created)} · kvaliteta ${QUALITY[s.quality] ? QUALITY[s.quality].name : '–'}</div>
      <canvas class="chart" id="covChart" style="height:${28 + s.models.length * 22}px"></canvas>
      <div class="note">Traka = razdoblje koje model pokriva; zelena zona = regata. ● uz ime = dostupan je noviji run.</div>
      ${s.errors && s.errors.length ? `<div class="note warn">${s.errors.join('<br>')}</div>` : ''}
      ${s.empty && s.empty.length ? `<div class="note warn">Model ne pokriva ovo područje: ${s.empty.map(id => modelById(id).name).join(', ')}</div>` : ''}
      <button id="btnCheckRuns" class="btn block">Provjeri nove runove modela</button>
      <button id="btnPackage" class="btn block">📲 Spremi paket za iPhone (AirDrop)</button>
      ${state.newRuns.length ? `<button id="btnRefreshNew" class="btn primary block">Osvježi samo nove runove: ${state.newRuns.map(n => modelById(n.id).name).join(', ')}</button>
      <div class="note">Preuzimaju se samo modeli s novim runom, isto područje i vrijeme. Štedi API pozive.</div>` : ''}` : '<div class="note">Još nema preuzete prognoze.</div>'}
    <h3>Izvor podataka</h3>
    <div class="seg"><button data-src="direct" class="${direct ? 'on' : ''}">📥 GRIB izravno</button><button data-src="cloud" class="${cloud ? 'on' : ''}">☁️ Paket iz oblaka</button><button data-src="openmeteo" class="${!direct && !cloud ? 'on' : ''}">📡 Open-Meteo</button></div>
    <div class="note">${direct ? `Originalne GRIB datoteke izravno od službenih meteoroloških centara (ECMWF, NOAA${state.native ? ', DWD' : ''}), <b>bez API limita</b>, samo kad klikneš Preuzmi.${state.native ? '' : ' DWD modeli (ICON-D2/EU) rade samo u Mac aplikaciji.'}`
      : cloud ? '<b>Bez API limita.</b> Gotov paket za cijeli Jadran (ICON-2I, ICON-D2, ICON-EU, ECMWF, GFS, valovi i struje), 5 dana unaprijed, koji tvoj GitHub sam osvježava 4× dnevno nakon novih runova. Preuzimanje ~10–15 MB.'
      : 'Open-Meteo: 9 modela uključujući ICON-2I i HARMONIE; besplatno s dnevnim limitom po internetskoj vezi. Ako limit istekne, aplikacija se sama prebaci na paket iz oblaka.'}</div>
    <h3>Rezolucija</h3>
    <div class="row"><label>Kvaliteta</label><select id="quality">${Object.entries(QUALITY).map(([k, q]) => `<option value="${k}" ${settings.quality === k ? 'selected' : ''}>${q.name}</option>`).join('')}</select></div>
    ${cloud ? `<h3>Paket iz oblaka</h3><div class="note">Paket sadrži sve modele odjednom za cijeli Jadran. Područje i kvaliteta se ne biraju.</div>` : direct ? `<h3>Modeli (izravno s izvora)</h3>${dirList}
    <div class="note">Procjena: ~${Math.round(mb)} MB preuzimanja za ${hrs} h (izrezuje se samo odabrano područje, na disk ide nekoliko MB). Za ICON-2I i HARMONIE prebaci na Open-Meteo.</div>` : `<h3>Besplatni modeli (Open-Meteo)</h3>${free}`}
    <label class="check"><input type="checkbox" disabled><div><div class="t">${ALADIN.name} <small style="color:var(--muted)">${ALADIN.res}</small></div><div class="d">${ALADIN.note}</div></div></label>
    <h3>Plaćeni izvori</h3>
    <div class="note">Open-Meteo komercijalni ključ (veći limiti, svi modeli): Postavke → Izvori. Meteomatics (1 km downscaling, ECMWF, mix):</div>
    <div class="row"><input type="text" id="mmUser" class="field" style="flex:1" placeholder="Meteomatics korisnik" value="${settings.mmUser}" autocomplete="off"></div>
    <div class="row"><input type="password" id="mmPass" class="field" style="flex:1" placeholder="Meteomatics lozinka" value="${settings.mmPass}" autocomplete="off"></div>
    ${paid}
    <h3>Uvoz GRIB-a</h3>
    <div class="note"><b>Datoteka:</b> GRIB1/GRIB2 iz PredictWinda, Saildocsa, LuckGriba, Expeditiona, qtVlm-a, NOAA-e… ili Clock the Wind paket (.ctw). Na iPhoneu: spremi GRIB u Datoteke (Files), pa ga odaberi ovdje.</div>
    <div class="row"><input type="file" id="gribFile" multiple></div>
    <div class="note"><b>Link:</b> zalijepi poveznicu na GRIB (npr. iz e-maila PredictWinda ili s web stranice izvora).</div>
    <div class="row"><input type="url" id="gribUrl" class="field" style="flex:1" placeholder="https://…/prognoza.grb2" autocomplete="off"><button id="btnGribUrl" class="mini">Preuzmi</button></div>
    <div class="note"><b>Saildocs (besplatno, e-mailom):</b> radi i preko satelitskog e-maila na moru (Iridium GO!, Starlink). Aplikacija složi zahtjev za ovo područje; odgovor s GRIB-om stiže za par minuta – privitak uvezi gore.</div>
    <div class="row"><select id="sdModel"><option value="GFS">GFS (NOAA)</option><option value="ECMWF">ECMWF</option><option value="ICON">ICON (DWD)</option></select><button id="btnSaildocs" class="mini">✉️ Složi zahtjev</button></div>
    <div id="sdText" class="note"></div>
    <div class="note ${direct || cloud ? 'hidden' : ''}">${est.calls} API poziva · ~${est.minutes} min${settings.apiKey ? ' (komercijalni ključ)' : ' na besplatnom limitu (10 000/dan, 600/min)'}.</div>
    <div class="dlbar">
      <button id="btnDownload" class="btn primary block">⬇︎ ${cloud ? 'Preuzmi paket iz oblaka' : fcMode() ? 'Preuzmi prognozu' : 'Preuzmi prognozu za regatu'}</button>
      <button id="btnAbort" class="btn block hidden">Prekini</button>
      <div class="progress"><div id="dlBar"></div></div><div id="dlText" class="note"></div>
    </div>
    <h3>Offline karta</h3>
    <div class="note">Nautička karta (dubine EMODnet ~135 m, izobate, obala) ugrađena je i radi bez interneta. Za online podloge spremi pločice za područje staze:</div>
    <button id="btnTiles" class="btn block">Spremi pločice karte (zoom 6–13)</button>
    <div id="tileText" class="note"></div>`;
  el.querySelectorAll('.check input[value]').forEach(i => i.onchange = () => {
    settings.dlModels = [...el.querySelectorAll('.check input[value]:checked')].map(x => x.value); saveSettings(); renderDataTab();
  });
  el.querySelector('#quality').onchange = e => { settings.quality = e.target.value; saveSettings(); renderDataTab(); };
  const cs = el.querySelector('#dlChgStart'); if (cs) cs.onclick = () => openSheet('course');
  el.querySelectorAll('[data-area]').forEach(b => b.onclick = () => {
    if (b.dataset.area === 'custom') return startAreaPick();
    settings.areaSel = b.dataset.area; saveSettings(); drawPendingArea(); renderDataTab();
  });
  const fd = el.querySelector('#fcDays'); if (fd) fd.onchange = e => { settings.fcDays = +e.target.value; saveSettings(); renderDataTab(); };
  el.querySelectorAll('.seg [data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  el.querySelector('#mmUser').onchange = e => { settings.mmUser = e.target.value.trim(); saveSettings(); renderDataTab(); };
  el.querySelector('#mmPass').onchange = e => { settings.mmPass = e.target.value; saveSettings(); };
  el.querySelector('#gribFile').onchange = e => importGribs([...e.target.files]);
  el.querySelector('#btnGribUrl').onclick = () => importGribUrl(el.querySelector('#gribUrl').value.trim());
  el.querySelector('#btnSaildocs').onclick = () => {
    const r = saildocsRequest(el.querySelector('#sdModel').value);
    el.querySelector('#sdText').innerHTML = `Pošalji na <b>query@saildocs.com</b> (naslov nebitan), tekst:<br><code class="sel">${r}</code><br><a href="mailto:query@saildocs.com?subject=grib&body=${encodeURIComponent(r)}">Otvori e-mail s ovim zahtjevom</a>`;
    if (navigator.clipboard) navigator.clipboard.writeText(r).then(() => toast('Zahtjev kopiran – zalijepi ga u e-mail')).catch(() => {});
  };
  el.querySelector('#btnDownload').onclick = doDownload;
  el.querySelector('#btnAbort').onclick = () => dlAbort && dlAbort.abort();
  el.querySelector('#btnTiles').onclick = cacheTiles;
  const rn = el.querySelector('#btnRefreshNew'); if (rn) rn.onclick = refreshNewRuns;
  el.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { settings.source = b.dataset.src; saveSettings(); renderDataTab(); });
  el.querySelectorAll('[data-dir]').forEach(i => i.onchange = () => { settings.directModels = [...el.querySelectorAll('[data-dir]:checked')].map(x => x.dataset.dir); saveSettings(); renderDataTab(); });
  const pk = el.querySelector('#btnPackage'); if (pk) pk.onclick = async () => {
    const blob = await exportPackage(state.set);
    const d = new Date(), name = `Clock-the-Wind-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.ctw`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    toast(`Paket ${name} (${(blob.size / 1048576).toFixed(1)} MB) spremljen u Preuzimanja – pošalji ga AirDropom na iPhone`, 6000);
  };
  const cr = el.querySelector('#btnCheckRuns');
  if (cr) cr.onclick = async () => { state.newRuns = await checkNewRuns(state.set); renderChips(); toast(state.newRuns.length ? `Noviji run: ${state.newRuns.map(n => modelById(n.id).name + ' ' + fmtRun(n.runInit)).join(', ')}` : 'Imaš najnovije runove svih modela'); renderDataTab(); };
  if (s) drawCoverage($('#covChart'));
}
function drawCoverage(cv) {
  const s = state.set, dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = s.times[0], t1 = s.times[s.times.length - 1], L = 92, X = t => L + (t - t0) / (t1 - t0) * (w - L - 6);
  const st = raceStart(), etas = Object.values(state.routes).filter(r => r.ok).map(r => r.eta);
  const end = etas.length ? Math.max(...etas) : st + raceWindow(st, courseLength()).estHours * 3600000;
  c.fillStyle = 'rgba(76,209,138,.18)'; c.fillRect(X(Math.max(t0, st)), 0, Math.max(2, X(Math.min(end, t1)) - X(Math.max(t0, st))), h - 16);
  c.font = '11px -apple-system,system-ui';
  s.models.forEach((id, i) => {
    const f = s.fields[id], m = modelById(id), y = 6 + i * 22;
    c.fillStyle = '#cfd8e3'; c.fillText(m.name, 4, y + 11);
    c.fillStyle = mcol(m.id); c.globalAlpha = 0.85; c.fillRect(X(f.times[0]), y + 2, X(f.validUntil) - X(f.times[0]), 12); c.globalAlpha = 1;
    if (f.run) { c.fillStyle = '#0b1220'; c.fillText(fmtRun(f.run.runInit), X(f.times[0]) + 4, y + 12); }
    if (state.newRuns.some(n => n.id === id)) { c.fillStyle = '#ffb547'; c.fillText('●', 80, y + 11); }
    if (f.validUntil < end) { c.fillStyle = '#ff6b6b'; c.fillText('kratko', X(f.validUntil) + 4, y + 12); }
  });
  c.fillStyle = '#9aa7b8';
  for (let t = t0; t <= t1; t += 3600000) {
    const hh = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(t);
    if (hh === 0) { c.fillRect(X(t), 0, 1, h - 14); c.fillText(fmtTime(t).slice(0, 10), X(t) + 2, h - 3); }
  }
  c.fillStyle = '#4cd18a'; c.fillRect(X(st), 0, 2, h - 14);
}
let dlBusy = false;
async function doDownload(opts = {}) {
  if (!navigator.onLine) return opts.auto ? null : toast('Nema interneta – koristi se zadnja spremljena prognoza');
  if (!settings.dlModels.length && settings.source === 'openmeteo') return toast('Odaberi barem jedan model');
  if (dlBusy) return;
  dlBusy = true;
  const dummy = { style: {}, classList: { add() {}, remove() {} }, textContent: '', innerHTML: '' };
  const btn = $('#btnDownload') || dummy; btn.disabled = true; ($('#btnAbort') || dummy).classList.remove('hidden');
  const bar = $('#dlBar') || dummy, txt = $('#dlText') || dummy;
  const area = opts.bbox || dlArea();   // the area of THIS download (the panel always shows the current window)
  // every arriving piece builds on what is on the map AT THAT MOMENT (another download may have finished meanwhile)
  const settle = p => {
    const cur = state.set;
    const empty = m => { if (!m || m.nx === 1 || !m.vars || !m.vars.wave) return true; const a = m.vars.wave; for (let i = 0; i < a.length; i += 7) if (a[i] === a[i]) return false; return true; };
    if (cur && empty(p.fields.marine) && !empty(cur.fields.marine)) p.fields.marine = cur.fields.marine;   // never lose waves/currents
    keepGribs(p, cur); inheritCoverage(p, cur);
  };
  try {
    dlAbort = new AbortController();
    const st = fcMode() ? Math.round(Date.now() / H1) * H1 : raceStart();
    const inAdriatic = b => b.s >= ADRIATIC.s - 0.3 && b.n <= ADRIATIC.n + 0.3 && b.w >= ADRIATIC.w - 0.3 && b.e <= ADRIATIC.e + 0.3;
    let src = settings.source;
    if (src === 'cloud' && opts.auto && !inAdriatic(area)) src = 'direct';
    if (src === 'cloud') {
      try { await loadCloud(bar, txt, opts.auto); return; }
      catch (e) { if (!opts.auto) throw e; src = 'direct'; }   // cloud not reachable: official GRIBs instead
    }
    const useDirect = src === 'direct';
    if (useDirect && !(settings.directModels || []).length) throw new Error('Odaberi barem jedan model');
    const dirIds = (settings.directModels || []).filter(id => directUsable(id, state.native));
    let win = dlWindow();
    if (opts.auto && state.set && state.set.times && state.set.times.length) {   // a refill keeps (at least) the time span already on screen
      const T = state.set.times; win = { ...win, t0: Math.min(win.t0, Math.max(T[0], Date.now() - 6 * 3600000)), t1: Math.min(Math.max(win.t1, T[T.length - 1]), Date.now() + 5 * 24 * 3600000) };
    }
    const set = await (useDirect ? downloadDirect : downloadForecast)({ bbox: area, modelIds: useDirect ? (dirIds.length ? dirIds : ['dir_ecmwf', 'dir_gfs']) : settings.dlModels, window: win, quality: settings.quality, settings, signal: dlAbort.signal, maxSeconds: 150,   // the map is coloured as soon as the first model arrives; the rest may take its time (never cut short) quick: !!opts.auto, globalOnly: !!opts.auto && map.getZoom() < 6.5,   // a manual download always takes every model you chose
      onPartial: useDirect ? p => { settle(p); useSet(p, { keepView: true }); } : null,
      progress: (f, t) => { if (f != null) bar.style.width = (f * 100).toFixed(0) + '%'; if (t) txt.textContent = t; } });
    settle(set);
    txt.textContent = 'Spremam za offline…';
    await saveForecast(set);
    if (!opts.auto) { state.routes = {}; drawRoutes(); }
    state.newRuns = [];
    if (pendingRect) { map.removeLayer(pendingRect); pendingRect = null; }
    const keepT = state.time;
    state.time = opts.auto && keepT >= set.times[0] && keepT <= set.times[set.times.length - 1] ? keepT : st;
    useSet(set, { keepView: true });
    set.mode = settings.mode;
    txt.textContent = fcMode() ? `Gotovo: ${set.models.length} modela za odabrano područje.` : `Gotovo: ${set.models.length} modela, sinkronizirano sa startom ${fmtTime(st)}.`;
    toast(opts.auto ? '✓ Prognoza dopunjena za cijeli prozor' : 'Prognoza preuzeta i spremljena za offline');
    if ($('#tab-data').classList.contains('on')) renderDataTab();
  } catch (e) {
    console.error(e);
    if (e.daily) {
      txt.textContent = 'Open-Meteo dnevni limit je potrošen – prebacujem na paket iz oblaka…';
      try { await loadCloud(bar, txt); toast('Open-Meteo limit potrošen – učitan je paket iz oblaka (bez limita)', 6000); }
      catch (e2) { txt.innerHTML = LIMIT_HELP() + `<div class="note warn">Paket iz oblaka: ${e2.message}</div>`; toast('Dnevni limit Open-Meteo je potrošen – vidi upute ispod gumba', 6000); }
    }
    else { txt.textContent = e.name === 'AbortError' ? 'Prekinuto.' : e.message; if (e.name !== 'AbortError') toast(e.message, 5000); }
  }
  finally { btn.disabled = false; const a = $('#btnAbort'); a && a.classList.add('hidden'); dlBusy = false; }
}
// "Fill the window": in forecast mode with area = window, panning/zooming outside the downloaded area downloads
// the new window automatically (with a margin, so small pans do not trigger it). Never in race mode (would reset routes).
let fillTimer = null;
function setExtent(s) {
  let b = null;
  for (const id of [...((s && s.models) || []), ...((s && s.prev) || [])]) {
    const f = s.fields[id]; if (!f || !f.nx) continue;
    const e = { s: f.lat0, n: f.lat0 + f.dlat * (f.ny - 1), w: f.lon0, e: f.lon0 + f.dlon * (f.nx - 1) };
    b = b ? union(b, e) : e;
  }
  return b;
}
// share of the window where the displayed wind has no value (sampled on a 32×24 grid, edges included)
function uncoveredShare() {
  if (!state.set || !state.wind) return 1;
  const v = map.getBounds(), out = [];
  let miss = 0, n = 0;
  for (let j = 0; j <= 23; j++) for (let i = 0; i <= 31; i++) {
    const lat = v.getSouth() + (v.getNorth() - v.getSouth()) * j / 23, lon = v.getWest() + (v.getEast() - v.getWest()) * i / 31;
    sample(state.wind, ['u'], lat, lon, state.time, out); n++; if (out[0] !== out[0]) miss++;
  }
  return miss / n;
}
let lastFill = 0, lastFillFailed = false;
function maybeFillWindow(delay = 1200) {
  clearTimeout(fillTimer);
  if (areaSel() !== 'view' || pick || !navigator.onLine) return;
  if (dlBusy) { fillTimer = setTimeout(() => maybeFillWindow(delay), 3000); return; }   // check again when the current download ends
  // fill when any edge is missing, or when you zoomed back in after a thinned (whole-sea) download
  // zoomed back in after a coarse/global-only download: fetch full detail (incl. DWD) for the new window
  const needDetail = () => { const s = state.set, v = map.getBounds(); if (!s) return false;
    if (s.globalOnly) return map.getZoom() >= 6.5;   // came back from a far-out view: regional detail again
    if (!s.thinned) return false;
    const e = setExtent({ models: s.models.filter(id => !id.startsWith('grib:')), fields: s.fields }); if (!e) return false;
    return (v.getEast() - v.getWest()) * (v.getNorth() - v.getSouth()) < 0.15 * (e.e - e.w) * (e.n - e.s); };
  if (uncoveredShare() < 0.002 && !needDetail()) return;
  const since = Date.now() - lastFill, pause = lastFillFailed ? 45000 : 3000;   // never hammer the servers
  fillTimer = setTimeout(async () => {
    if ((uncoveredShare() < 0.002 && !needDetail()) || dlBusy || pick) return;
    lastFill = Date.now();
    toast('Preuzimam prognozu za cijeli prikaz…', 2500);
    const v = viewBBox(1.0);   // twice the window: the next zoom-out or pan is usually covered already
    const before = state.set;
    await doDownload({ auto: true, bbox: fcMode() || !course.marks.length ? v : union(v, courseBBox()) });
    lastFillFailed = state.set === before;
  }, Math.max(delay, since < pause ? pause - since : 0));
}
map.on('moveend', maybeFillWindow);
// re-download only the models that have a newer run than the one stored; merge into the current set
async function loadCloud(bar, txt, auto = false) {
  const set = await fetchCloudPackage(settings.cloudUrl || CLOUD_DEFAULT, state.native, (f, t) => { if (t && txt) txt.textContent = t; });
  set.mode = 'forecast';
  const hasWaves = m => { if (!m || m.nx === 1 || !m.vars || !m.vars.wave) return false; const a = m.vars.wave; for (let i = 0; i < a.length; i += 7) if (a[i] === a[i]) return true; return false; };
  if (state.set && !hasWaves(set.fields.marine) && hasWaves(state.set.fields.marine)) set.fields.marine = state.set.fields.marine;
  keepGribs(set, state.set); inheritCoverage(set, state.set);
  await saveForecast(set);
  if (!auto) { state.routes = {}; drawRoutes(); }
  state.newRuns = [];
  useSet(set);
  if (bar) bar.style.width = '100%';
  const runs = set.models.map(id => `${modelById(id).name} ${set.fields[id].run ? fmtRun(set.fields[id].run.runInit) : ''}`).join(', ');
  if (txt) txt.textContent = `Paket iz oblaka učitan (izrađen ${fmtTime(set.created)}): ${runs}.`;
  renderDataTab();
}
const LIMIT_HELP = () => `<div class="limitbox"><b>Besplatni dnevni limit Open-Meteo je potrošen za ovu internetsku vezu.</b> Obnavlja se sutra. Do tada:
  <ol><li><b>iPhone/iPad:</b> isključi WiFi i preuzmi preko <b>mobilnih podataka</b> (druga veza = nova kvota).</li>
  <li><b>Mac:</b> aplikacija Clock the Wind → Prognoza → <b>🖥 Izravno preko Maca</b> → Preuzmi (bez limita) → <b>📲 Spremi paket za iPhone</b> → AirDrop → ovdje <b>Uvoz</b>.</li>
  <li>Već preuzeta prognoza ostaje i radi offline.</li>
  <li><b>☁️ Paket iz oblaka</b> (izvor gore) – bez limita, radi i na iPhoneu.</li>
  <li>Trajno bez limita: Open-Meteo API ključ (Postavke → Izvori).</li></ol>
  Savjet: kvaliteta <b>Standard</b> i 2–3 modela troše 3–4× manje poziva od HD-a.</div>`;
async function refreshNewRuns() {
  const s = state.set; if (!s) return;
  const ids = state.newRuns.map(n => n.id).filter(id => !id.startsWith('grib:'));
  if (!ids.length) return toast('Nema novih runova');
  const bar = $('#dlBar'), txt = $('#dlText');
  try {
    dlAbort = new AbortController();
    const win = s.mode === 'forecast' || fcMode() ? dlWindow() : (s.window || dlWindow());
    const fresh = await downloadForecast({ bbox: s.bbox || dlArea(), modelIds: ids, window: win, quality: s.quality || settings.quality, settings, signal: dlAbort.signal,
      progress: (f, t) => { if (f != null && bar) bar.style.width = (f * 100).toFixed(0) + '%'; if (t && txt) txt.textContent = t; } });
    for (const id of fresh.models) s.fields[id] = fresh.fields[id];
    s.fields.marine = fresh.fields.marine;
    if (fresh.times[fresh.times.length - 1] > s.times[s.times.length - 1]) s.times = fresh.times;
    s.created = Date.now();
    await saveForecast(s);
    state.newRuns = []; useSet(s); renderDataTab();
    toast(`Osvježeno: ${fresh.models.map(id => modelById(id).name).join(', ')}`);
  } catch (e) { if (txt) { if (e.daily) txt.innerHTML = LIMIT_HELP(); else txt.textContent = e.message; } toast(e.daily ? 'Dnevni limit Open-Meteo je potrošen' : e.message, 5000); }
}
// Saildocs GRIB request for the current download area and window (format: model:N,S,W,E|dlat,dlon|hours|params)
function saildocsRequest(model) {
  const b = dlArea(), w = dlWindow();
  const N = Math.ceil(b.n), S = Math.floor(b.s), W = Math.floor(b.w), E = Math.ceil(b.e);   // whole degrees: Saildocs standard
  const res = model === 'ICON' ? '0.125,0.125' : model === 'ECMWF' ? '0.25,0.25' : '0.25,0.25';
  const h0 = Math.max(0, Math.floor((w.t0 - Date.now()) / 3600000 / 3) * 3), h1 = Math.min(model === 'ECMWF' ? 144 : 120, Math.ceil((w.t1 - Date.now()) / 3600000 / 3) * 3 + 6);
  const ll = (v, p, n) => `${Math.abs(v)}${v >= 0 ? p : n}`;
  return `send ${model}:${ll(N, 'N', 'S')},${ll(S, 'N', 'S')},${ll(W, 'E', 'W')},${ll(E, 'E', 'W')}|${res}|${h0},3..${Math.max(h1, h0 + 3)}|WIND,GUST,MSLP`;
}
// GRIB from a link: straight if the server allows it (CORS), otherwise through the Mac app
async function importGribUrl(url) {
  const txt = $('#dlText');
  if (!/^https?:\/\//i.test(url)) return toast('Zalijepi cijelu poveznicu (https://…)');
  txt.textContent = 'Preuzimam GRIB s linka…';
  let buf = null, err = '';
  try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) buf = await r.arrayBuffer(); else err = 'HTTP ' + r.status; } catch (e) { err = 'poslužitelj ne dopušta izravno preuzimanje'; }
  if (!buf && state.native) {
    try { const r = await fetch(`/proxy?u=${encodeURIComponent(url)}&user=1`); if (r.ok) buf = await r.arrayBuffer(); else err = 'HTTP ' + r.status; } catch (e) { err = e.message; }
  }
  if (!buf || buf.byteLength < 20) {
    txt.innerHTML = `Nije uspjelo (${err || 'prazno'}). ${state.native ? '' : 'Ovaj poslužitelj ne dopušta preuzimanje iz preglednika – otvori link u Safariju, spremi datoteku u Datoteke (Files) i uvezi je gumbom iznad, ili koristi Mac aplikaciju.'}`;
    return toast('GRIB s linka nije preuzet', 4000);
  }
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'grib').slice(0, 40) || 'grib';
  await importGribs([new File([buf], name)]);
}
async function importGribs(files) {
  const txt = $('#dlText');
  for (const file of files) {
    try {
      txt.textContent = `Čitam ${file.name}…`;
      let buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, 4);
      if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      if (isPackage(buf)) {
        const set = importPackage(buf);
        inheritCoverage(set, state.set);
        await saveForecast(set); state.routes = {}; drawRoutes(); useSet(set);
        if (set.bbox) map.fitBounds([[set.bbox.s, set.bbox.w], [set.bbox.n, set.bbox.e]]);
        toast(`Paket uvezen: ${set.models.length} modela, do ${fmtTime(set.times[set.times.length - 1])}`, 4000);
        txt.textContent = `${file.name}: paket uvezen`;
        continue;
      }
      const msgs = decodeGrib(buf);
      const id = 'grib:' + file.name.replace(/\.\w+$/, '').slice(0, 24);
      // crop to the window (+ course); a GRIB elsewhere is imported whole
      let f; try { f = gribToField(msgs, course.marks.length ? union(dlArea(), courseBBox()) : dlArea(), id); } catch (e) { f = gribToField(msgs, null, id); }
      const meta = { id, name: file.name.replace(/\.\w+$/, '').slice(0, 14), res: `GRIB ${(f.dlat * 60).toFixed(1)}nm`, color: ['#ff7043', '#ab47bc', '#26a69a', '#ffca28'][Math.floor(Math.random() * 4)] };
      f.meta = meta; registerModel(meta);
      let set = state.set;
      if (!set) {
        const marine = { lat0: f.lat0, lon0: f.lon0, dlat: f.dlat, dlon: f.dlon, nx: f.nx, ny: f.ny, times: f.times, vars: { wave: f.vars.wave || new Float32Array(f.times.length * f.nx * f.ny).fill(NaN), waveDir: f.vars.waveDir || new Float32Array(1).fill(NaN), cu: f.vars.cu || new Float32Array(1).fill(NaN), cv: f.vars.cv || new Float32Array(1).fill(NaN) } };
        set = { id: 'fc-' + Date.now(), created: Date.now(), quality: 'grib', models: [], empty: [], errors: [], times: f.times, fields: { marine } };
      }
      set.fields[id] = f; if (!set.models.includes(id)) set.models.push(id);
      await saveForecast(set);
      state.modelId = id; useSet(set);
      toast(`GRIB uvezen: ${msgs.length} poruka, ${f.times.length} vremenskih koraka, do ${fmtTime(f.validUntil)}${msgs.skipped && msgs.skipped.length ? ` (preskočeno ${msgs.skipped.length} nepodržanih poruka)` : ''}`, 4500);
      txt.textContent = `${file.name}: OK (${f.nx}×${f.ny}, ${fmtTime(f.times[0])} → ${fmtTime(f.validUntil)})`;
    } catch (e) { console.error(e); txt.textContent = `${file.name}: ${e.message}`; toast(e.message, 5000); }
  }
  renderDataTab();
}
async function cacheTiles() {
  if (!('caches' in window)) return toast('Preglednik ne podržava offline spremanje');
  const bb = dlArea(), urls = [];
  const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
  const t = TILE_SETS[TILE_SETS[state.basemap] ? state.basemap : 'dark'];
  for (let z = 6; z <= 13; z++) {
    for (let x = lon2x(bb.w, z); x <= lon2x(bb.e, z); x++) for (let y = lat2y(bb.n, z); y <= lat2y(bb.s, z); y++) {
      const fill = u => u.replace('{s}', 'abcd'[(x + y) % 4]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
      urls.push(fill(t.url), fill(t.labels));
      if (settings.seamarks) urls.push(fill('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'));
    }
  }
  const cache = await caches.open('ctw-tiles-v1');
  const tt = $('#tileText');
  for (let i = 0; i < urls.length; i += 8) {
    await Promise.all(urls.slice(i, i + 8).map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && cache.put(u, r)).catch(() => {})));
    tt.textContent = `Spremljeno ${Math.min(urls.length, i + 8)}/${urls.length} pločica`;
  }
  toast('Karta spremljena za offline');
}

// ---------------- routing tab ----------------
let workers = [];
function getWorkers() {
  if (workers.length) return workers;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker('js/router.worker.js', { type: 'module' });
    if (state.mask) w.postMessage({ cmd: 'mask', mask: state.mask });
    workers.push(w);
  }
  return workers;
}
function renderRoutingTab() {
  const el = $('#tab-routing'); const s = state.set;
  const start = raceStart();
  const routable = s ? s.models.filter(id => s.fields[id].validUntil > start && s.fields[id].times[0] <= start) : [];
  if (!state.routeModels) state.routeModels = routable.slice();
  const stale = Object.values(state.routes).some(r => r.stale);
  el.innerHTML = `
    <h3>Brod</h3>
    <div class="row"><select id="boatSel" class="field" style="flex:1;max-width:100%">${boats.map(b => `<option value="${b.id}" ${b.id === state.boat.id ? 'selected' : ''}>${b.name}</option>`).join('')}</select></div>
    <div class="row"><label>Učinkovitost (% polara)</label><input type="number" id="eff" min="60" max="110" value="${settings.efficiency}"></div>
    <div class="row"><label>Gaz broda (m)</label><input type="number" id="draft" step="0.1" value="${settings.draft}"></div>
    <div class="row"><label>Sigurnosna rezerva dubine (m)</label><input type="number" id="dmargin" step="0.1" value="${settings.depthMargin}"></div>
    <div class="row"><label>Izbjegavaj plićine &lt; ${minDepth().toFixed(1)} m</label><input type="checkbox" id="avoidSh" ${settings.avoidShallow ? 'checked' : ''}></div>
    <h3>Staza i start</h3>
    <div class="row"><label>${course.marks.map(m => m.name).join(' → ')}</label></div>
    <div class="row"><label>Start</label><b>${fmtTime(start)}</b><button class="mini" id="chgStart">promijeni</button></div>
    ${stale ? '<div class="note warn">Staza, start ili brod su promijenjeni nakon zadnjeg izračuna – ponovi routing.</div>' : ''}
    <h3>Modeli za routing</h3>
    ${s ? s.models.map(id => { const m = modelById(id), f = s.fields[id], ok = routable.includes(id); return `<label class="check"><input type="checkbox" value="${id}" ${ok && state.routeModels.includes(id) ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <div><div class="t"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name}${f.run ? ` <small style="color:var(--muted)">run ${fmtRun(f.run.runInit)}</small>` : ''}</div><div class="d">${ok ? 'pokriva start, vrijedi do ' + fmtTime(f.validUntil) : 'ne pokriva vrijeme starta – preuzmi prognozu za ovaj start'}</div></div></label>`; }).join('') : '<div class="note warn">Prvo preuzmi prognozu (kartica Prognoza).</div>'}
    <h3>Opcije</h3>
    <div class="row"><label>Penal za okret kroz vjetar (s)</label><input type="number" id="tackP" value="${settings.tackPenaltySec}"></div>
    <div class="row"><label>Penal za kroz-krmu (s)</label><input type="number" id="gybeP" value="${settings.gybePenaltySec}"></div>
    <div class="row"><label>Vremenski korak (min)</label><select id="dtMin">${[5, 10, 15, 20, 30].map(v => `<option ${+settings.dtMin === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label>Uključi morske struje</label><input type="checkbox" id="useCur" ${settings.useCurrents ? 'checked' : ''}></div>
    <div class="row"><label>Gubitak brzine u valovima</label><input type="checkbox" id="wavP" ${settings.wavePenalty ? 'checked' : ''}></div>
    <button id="btnRun" class="btn primary block" ${s ? '' : 'disabled'}>Izračunaj rute od starta (${state.routeModels.filter(x => routable.includes(x)).length} modela)</button>
    <h3>Tijekom regate</h3>
    <div class="row"><label>Sljedeća oznaka</label><select id="nextMark">${course.marks.slice(1).map((m, i) => `<option value="${i + 1}">${m.name}</option>`).join('')}</select></div>
    <button id="btnGps" class="btn block" ${s ? '' : 'disabled'}>📍 Ruta od moje pozicije, sada</button>
    <div id="runStatus"></div>
    ${Object.keys(state.routes).length ? '<button id="btnClearRoutes" class="btn block danger">🗑 Obriši rute (zauvijek)</button>' : ''}
    <p class="note">Ruta izbjegava kopno, otoke i plićine (EMODnet batimetrija ~135 m). Uvijek provjeri hridi, zabranjene zone i upute za jedrenje na službenoj karti.</p>`;
  const num = (id, key, after) => el.querySelector(id).onchange = e => { settings[key] = +e.target.value; saveSettings(); after && after(); };
  num('#eff', 'efficiency', markStale); num('#tackP', 'tackPenaltySec'); num('#gybeP', 'gybePenaltySec'); num('#dtMin', 'dtMin');
  num('#draft', 'draft', () => { rebuildMask(); renderRoutingTab(); }); num('#dmargin', 'depthMargin', () => { rebuildMask(); renderRoutingTab(); });
  el.querySelector('#avoidSh').onchange = e => { settings.avoidShallow = e.target.checked; saveSettings(); rebuildMask(); renderRoutingTab(); };
  el.querySelector('#boatSel').onchange = e => { selectBoat(e.target.value); renderRoutingTab(); };
  el.querySelector('#useCur').onchange = e => { settings.useCurrents = e.target.checked; saveSettings(); };
  el.querySelector('#wavP').onchange = e => { settings.wavePenalty = e.target.checked; saveSettings(); };
  el.querySelector('#chgStart').onclick = () => openSheet('course');
  el.querySelectorAll('.check input').forEach(i => i.onchange = () => { state.routeModels = [...el.querySelectorAll('.check input:checked')].map(x => x.value); renderRoutingTab(); });
  el.querySelector('#btnRun').onclick = () => runRouting(state.routeModels.filter(x => routable.includes(x)));
  const cr1 = el.querySelector('#btnClearRoutes'); if (cr1) armDelete(cr1, 'Rute su obrisane (staza je ostala)', async () => { await clearRoutes(); renderRoutingTab(); });
  el.querySelector('#btnGps').onclick = () => {
    if (!navigator.geolocation) return toast('GPS nije dostupan');
    toast('Tražim GPS poziciju…');
    navigator.geolocation.getCurrentPosition(pos => {
      const now = Math.floor(Date.now() / 60000) * 60000;
      const from = { name: 'Moja pozicija', lat: pos.coords.latitude, lon: pos.coords.longitude };
      const marks = [from, ...course.marks.slice(+$('#nextMark').value)];
      const ids = state.set.models.filter(id => state.set.fields[id].validUntil > now && state.set.fields[id].times[0] <= now);
      runRouting(ids, { marks, startTime: now });
    }, err => toast('GPS greška: ' + err.message, 4000), { enableHighAccuracy: true, timeout: 15000 });
  };
}
async function runRouting(ids, override = {}) {
  if (!ids.length) return toast('Odaberi barem jedan model');
  if ((override.marks || course.marks).length < 2) return toast('Staza nema start i cilj (in-port etapa?) – odaberi etapu sa stazom', 4000);
  if (!state.mask) toast('Upozorenje: maska kopna nije učitana');
  const startTime = override.startTime || raceStart();
  const marks = override.marks || course.marks;
  if (!$('#runStatus')) openSheet('routing');   // progress lives in the routing tab – make sure it exists
  const st = $('#runStatus');
  st.innerHTML = ids.map(id => `<div class="note"><span class="dot" style="background:${mcol(id)}"></span>${modelById(id).name}: <span id="rs-${id.replace(/[^\w-]/g, '_')}">čeka…</span><div class="progress"><div id="rp-${id.replace(/[^\w-]/g, '_')}"></div></div></div>`).join('');
  const key = id => id.replace(/[^\w-]/g, '_');
  const ws = getWorkers();
  const opts = { efficiency: settings.efficiency / 100, tackPenaltySec: settings.tackPenaltySec, gybePenaltySec: settings.gybePenaltySec, dtMin: settings.dtMin, useCurrents: settings.useCurrents, wavePenalty: settings.wavePenalty, sails: state.boat.sails === 'melges40' };
  state.routes = {};
  let next = 0;
  const t0 = performance.now();
  await Promise.all(ws.map(w => (async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const rsEl = () => $('#rs-' + key(id));
      if (rsEl()) rsEl().textContent = 'računam…';
      const res = await new Promise(resolve => {
        const msgId = Math.random();
        const onMsg = e => {
          if (e.data.id !== msgId) return;
          if (e.data.progress != null) { const b = $('#rp-' + key(id)); if (b) b.style.width = (e.data.progress * 100) + '%'; return; }
          w.removeEventListener('message', onMsg); resolve(e.data.result);
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ cmd: 'route', id: msgId, wind: state.set.fields[id], marine: state.set.fields.marine, polar: state.polar.serialize(), marks, startTime, opts });
      });
      res.model = id; res.boat = state.boat.name; res.live = !!override.marks;
      state.routes[id] = res;
      const b = $('#rp-' + key(id)); if (b) b.style.width = '100%';
      if (rsEl()) rsEl().textContent = res.ok ? `ETA ${fmtTime(res.eta)} (${fmtDur(res.stats.hours)})` : '✕ ' + res.error;
      drawRoutes();
    }
  })()));
  console.log('routing took', Math.round(performance.now() - t0), 'ms');
  state.routesSaved = false;   // calculated routes live only until the app closes – saved only on "Spremi rute"
  const okIds = ids.filter(id => state.routes[id].ok);
  if (okIds.length) {
    state.selected = okIds.sort((a, b) => state.routes[a].eta - state.routes[b].eta)[0];
    setTime(startTime);
    drawRoutes();
    openSheet('compare');
  }
}

// ---------------- routes on the map ----------------
const routeLayer = L.layerGroup().addTo(map);
let boatMarkers = {};
const okRoutes = () => Object.values(state.routes).filter(r => r && r.ok).sort((a, b) => a.eta - b.eta);
const idealId = () => { const o = okRoutes(); return o.length ? o[0].model : null; };   // fastest route of all models = theoretical ideal
// tack / gybe points (twa changes side); same rule as router stats()
function manoeuvres(r) {
  if (r._man) return r._man;
  const out = [], tr = r.track;
  for (let i = 1; i < tr.length - 1; i++) {
    const a = tr[i - 1], b = tr[i];
    if (Math.sign(a.twa) !== Math.sign(b.twa) && a.twa && b.twa) out.push({ ...b, kind: Math.abs(b.twa) < 90 ? 'tack' : 'gybe' });
  }
  return (r._man = out);
}
// how far a route strays from the ideal one: max and mean cross-track distance (nm)
function deviation(r, ideal) {
  if (!ideal || r === ideal) return { max: 0, mean: 0 };
  if (r._dev && r._dev.id === ideal.model && r._dev.eta === ideal.eta) return r._dev;
  const it = ideal.track, k = Math.cos(it[0].lat * Math.PI / 180);
  const xy = p => [p.lon * 60 * k, p.lat * 60];
  const I = it.map(xy);
  let max = 0, sum = 0;
  for (const p of r.track) {
    const [px, py] = xy(p); let best = Infinity;
    for (let j = 1; j < I.length; j++) {
      const [ax, ay] = I[j - 1], [bx, by] = I[j], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy); if (d < best) best = d;
    }
    max = Math.max(max, best); sum += best;
  }
  return (r._dev = { id: ideal.model, eta: ideal.eta, max, mean: sum / r.track.length });
}
const boatHtml = (col, ideal) => `<svg viewBox="-14 -14 28 28"><circle r="11.5" fill="none" stroke="${col}" stroke-width="2.6"/><path d="M0-10 5.5 7 0 3.6-5.5 7z" fill="#000" stroke="#fff" stroke-width="0.9"/></svg><div class="boatlbl" style="border-color:${col}"></div>${ideal ? '<div class="boatstar">★</div>' : ''}`;
// time on route r closest to a map position (projected onto the track in screen pixels)
function nearestOnRoute(r, latlng) {
  const P = map.latLngToLayerPoint(latlng), tr = r.track;
  let best = Infinity, bt = tr[0].t;
  let A = map.latLngToLayerPoint([tr[0].lat, tr[0].lon]);
  for (let i = 1; i < tr.length; i++) {
    const B = map.latLngToLayerPoint([tr[i].lat, tr[i].lon]);
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1e-9;
    const f = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2));
    const d = Math.hypot(P.x - A.x - f * dx, P.y - A.y - f * dy);
    if (d < best) { best = d; bt = tr[i - 1].t + f * (tr[i].t - tr[i - 1].t); }
    A = B;
  }
  return bt;
}
function routePointHtml(id, t) {
  const r = state.routes[id], p = routeAt(r, t), m = modelById(id), rel = (t - r.startTime) / 3600000;
  return `<div class="rt"><b><span class="dot" style="background:${mcol(id)}"></span>${id === idealId() ? '★ ' : ''}${m.name} · ${fmtTime(t, false)}</b> <small>${fmtDur(rel)} od starta</small><br>
    Vjetar <b>${Math.round(p.twd)}° ${p.tws.toFixed(1)} kn</b> · Kurs <b>${Math.round(p.hdg)}°</b> · <b>${p.bsp.toFixed(1)} kn</b><br>
    TWA <b>${Math.round(Math.abs(p.twa))}° ${p.twa < 0 ? 'L' : 'D'}</b> · ${p.sail} · <span class="muted">dodir = svi brodići na ovaj trenutak</span></div>`;
}
function drawRoutes() {
  routeLayer.clearLayers(); boatMarkers = {};
  const ideal = idealId();
  let entries = Object.entries(state.routes).filter(([, r]) => r && r.ok);
  if (settings.routeView === 'one' && state.selected) entries = entries.filter(([id]) => id === state.selected);
  // ideal and selected last so they are on top
  const rank = id => (id === state.selected ? 2 : 0) + (id === ideal ? 1 : 0);
  entries.sort(([a], [b]) => rank(a) - rank(b));
  for (const [id, r] of entries) {
    const col = mcol(id), sel = id === state.selected, best = id === ideal;
    const ll = r.track.map(p => [p.lat, p.lon]);
    if (sel && state.showIso !== false) r.isochrones.forEach(iso => L.polyline(iso, { pane: 'routes', color: col, weight: 0.8, opacity: 0.35, interactive: false }).addTo(routeLayer));
    const w = best ? 5.5 : sel ? 4.5 : 3;
    if (best) L.polyline(ll, { pane: 'routes', color: '#ffd400', weight: w + 14, opacity: 0.38, interactive: false }).addTo(routeLayer);   // golden glow = fastest
    // dark casing keeps every model colour readable over any wind colour
    L.polyline(ll, { pane: 'routes', color: col === '#111111' ? '#fff' : '#000', weight: w + 3.5, opacity: sel ? 0.85 : 0.7, interactive: false }).addTo(routeLayer);
    const pl = L.polyline(ll, { pane: 'routes', color: col, weight: w, opacity: 1 }).addTo(routeLayer);
    // a wide invisible line on top makes the route easy to hit with a finger or the mouse
    const hit = L.polyline(ll, { pane: 'routes', color: '#000', weight: 18, opacity: 0.001 }).addTo(routeLayer);
    hit.bindTooltip('', { sticky: true, className: 'rtip', direction: 'top', offset: [0, -10] });
    hit.on('mousemove', e => hit.setTooltipContent(routePointHtml(id, nearestOnRoute(r, e.latlng))));
    hit.on('mouseover', e => hit.setTooltipContent(routePointHtml(id, nearestOnRoute(r, e.latlng))));
    // click / tap: every boat jumps to that moment – you see where each model's boat is at the same time
    hit.on('click', e => { L.DomEvent.stopPropagation(e); replayPause(); const t = nearestOnRoute(r, e.latlng); state.selected = id; drawRoutes(); setTime(t); showBoatInfo(id); });
    if (sel) {
      // hourly ticks with sail colour
      let lastH = -1;
      r.track.forEach(p => {
        const h = Math.floor(p.t / 3600000);
        if (h !== lastH) { lastH = h; L.circleMarker([p.lat, p.lon], { pane: 'routes', radius: 3, color: '#fff', weight: 1, fillColor: p.sailColor, fillOpacity: 1 })
          .bindTooltip(`${fmtTime(p.t)} · ${p.tws.toFixed(1)} kn ${Math.round(p.twd)}° · TWA ${Math.round(p.twa)}° · ${p.bsp.toFixed(1)} kn · ${p.sail}`).addTo(routeLayer); }
      });
    }
    // tack (T) and gybe (G) points
    if (sel || best) manoeuvres(r).forEach(p => L.marker([p.lat, p.lon], { pane: 'routes',
      icon: L.divIcon({ className: 'man ' + p.kind, html: `<span style="border-color:${col}">${p.kind === 'tack' ? 'T' : 'G'}</span>`, iconSize: [0, 0] }) })
      .bindTooltip(`${p.kind === 'tack' ? 'Okret kroz vjetar (tack)' : 'Kroz krmu (gybe)'} · ${modelById(id).name} · ${fmtTime(p.t, false)} · TWS ${p.tws.toFixed(0)} kn`).addTo(routeLayer));
    const mk = L.marker(ll[0], { pane: 'routes', zIndexOffset: 1000, icon: L.divIcon({ className: 'boat', html: boatHtml(col, best), iconSize: [0, 0] }) })
      .on('click', e => { L.DomEvent.stopPropagation(e); replayPause(); showBoatInfo(id); }).addTo(routeLayer);
    boatMarkers[id] = mk;
    if (best && entries.length > 1) {
      const p = r.track[Math.floor(r.track.length * 0.42)];
      L.marker([p.lat, p.lon], { pane: 'routes', interactive: false, icon: L.divIcon({ className: 'idealtag', iconSize: [0, 0],
        html: `<div><span class="dot" style="background:${col}"></span>★ NAJBRŽA · ${modelById(id).name} <span class="w">· cilj</span> ${fmtTime(r.eta, false)}</div>` }) }).addTo(routeLayer);
    }
  }
  updateBoats();
  drawTimeline();
  renderReplayBar();
}
function routeAt(r, t) {
  const tr = r.track;
  if (t <= tr[0].t) return tr[0];
  if (t >= tr[tr.length - 1].t) return tr[tr.length - 1];
  let i = 1; while (tr[i].t < t) i++;
  const a = tr[i - 1], b = tr[i], f = (t - a.t) / (b.t - a.t);
  return { ...a, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}
function updateBoats() {
  const n = Object.keys(boatMarkers).length;
  for (const [id, mk] of Object.entries(boatMarkers)) {
    const r = state.routes[id]; const p = routeAt(r, state.time);
    mk.setLatLng([p.lat, p.lon]);
    const el = mk.getElement(); if (!el) continue;
    el.querySelector('svg').style.transform = `translate(-14px,-14px) rotate(${p.hdg || 0}deg)`;
    const done = state.time >= r.eta;
    const lbl = el.querySelector('.boatlbl');
    lbl.textContent = done ? `${modelById(id).name} 🏁 ${fmtTime(r.eta, false)}` : `${modelById(id).name} ${p.bsp ? p.bsp.toFixed(1) + ' kn' : ''}`;
    lbl.style.display = id === state.selected || (n <= 4 && innerWidth > 700) ? '' : 'none';   // phone: only the selected boat is labelled
  }
  if (boatPopup && boatPopup.isOpen()) showBoatInfo(boatPopup._ctwId, true);
  updateReplayRank();
}
// small, unobtrusive info box for a boat
let boatPopup = null;
function showBoatInfo(id, refresh = false) {
  const r = state.routes[id]; if (!r || !r.ok) return;
  const p = routeAt(r, state.time), m = modelById(id), done = state.time >= r.eta;
  const html = `<div class="bi"><div class="bih"><span class="dot" style="background:${mcol(m.id)}"></span><b>${m.name}</b>${id === idealId() ? ' ★' : ''}<span class="bit">${fmtTime(state.time, false)}</span></div>
    ${done ? `<div>🏁 U cilju ${fmtTime(r.eta, false)}</div>` : `<div class="big"><span>Vjetar <b>${Math.round(p.twd)}° · ${p.tws.toFixed(1)} kn</b></span><span>Kurs <b>${Math.round(p.hdg)}°</b></span>
    <span>Brzina <b>${p.bsp.toFixed(1)} kn</b></span><span>TWA <b>${Math.round(Math.abs(p.twa))}° ${p.twa < 0 ? 'L' : 'D'}</b></span></div><div class="bis"><span class="dot" style="background:${p.sailColor}"></span>${p.sail}</div>`}</div>`;
  if (refresh) { boatPopup.setLatLng([p.lat, p.lon]).setContent(html); return; }
  if (boatPopup) map.closePopup(boatPopup);
  boatPopup = L.popup({ className: 'boatpop', closeButton: true, autoPan: false, offset: [0, -12], maxWidth: 220 }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
  boatPopup._ctwId = id;
}

// ---------------- race replay (PredictWind-style) ----------------
const REPLAY_SPEEDS = [60, 120, 300, 600, 1200];   // × real time (1–20 min of race per second)
const replaySpeed = () => REPLAY_SPEEDS.includes(settings.replaySpeed) ? settings.replaySpeed : 300;
const rp = { on: false, raf: 0, last: 0, lastFull: 0 };
function replayRange() {
  const o = okRoutes(); if (!o.length) return null;
  return { t0: Math.min(...o.map(r => r.startTime || r.track[0].t)), t1: Math.max(...o.map(r => r.eta)) };
}
function replayPause() { if (!rp.on) return; rp.on = false; clearInterval(rp.raf); setTime(state.time); renderReplayBar(); }
function replayPlay() {
  const R = replayRange(); if (!R) return;
  if (boatPopup) map.closePopup(boatPopup);
  if (state.time >= R.t1 || state.time < R.t0) setTime(R.t0);
  rp.on = true; rp.last = performance.now(); rp.lastFull = 0;
  clearInterval(rp.raf);
  const tick = () => {
    const now = performance.now();
    if (!rp.on) return clearInterval(rp.raf);
    const dt = Math.min(100, now - rp.last); rp.last = now;
    const t = Math.min(R.t1, state.time + dt * replaySpeed());
    if (now - rp.lastFull > 250 || t >= R.t1) { rp.lastFull = now; setTime(t); }   // full redraw (wind field) ~4×/s
    else { state.time = t; updateBoats(); }                                       // boats every frame
    if (t >= R.t1) { rp.on = false; clearInterval(rp.raf); renderReplayBar(); }
  };
  rp.raf = setInterval(tick, 33);   // timer (not rAF) so the race keeps running in a background window too
  renderReplayBar();
}
function renderReplayBar() {
  const el = $('#replayBar'); if (!el) return;
  const o = okRoutes();
  if (settings.mode !== 'race' || !o.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const sp = replaySpeed();
  el.innerHTML = `<button id="rpPlay" class="rpbtn" title="${rp.on ? 'Pauza' : 'Pokreni utrku'}">${rp.on ? '⏸' : '▶'}</button>
    <select id="rpSpeed" title="Brzina replaya">${REPLAY_SPEEDS.map(v => `<option value="${v}" ${v === sp ? 'selected' : ''}>${v / 60} min/s</option>`).join('')}</select>
    <div id="rpRank" class="rprank"></div>
    ${o.length > 1 ? `<button id="rpView" class="rpbtn small" title="Prikaz ruta">${settings.routeView === 'one' ? '1 ruta' : 'Sve'}</button>` : ''}`;
  el.querySelector('#rpPlay').onclick = () => rp.on ? replayPause() : replayPlay();
  el.querySelector('#rpSpeed').onchange = e => { settings.replaySpeed = +e.target.value; saveSettings(); };
  const v = el.querySelector('#rpView'); if (v) v.onclick = () => setRouteView(settings.routeView === 'one' ? 'all' : 'one');
  updateReplayRank();
}
function setRouteView(v) {
  settings.routeView = v; saveSettings(); drawRoutes();
  if (!$('#sheet').classList.contains('hidden') && $('.tabs [data-tab=compare].on')) renderCompareTab();
  toast(v === 'one' ? 'Prikazana samo odabrana ruta' : 'Prikazane sve rute');
}
// live order: boats already finished by arrival, the rest by predicted arrival (= who is ahead on time)
function updateReplayRank() {
  const el = $('#rpRank'); if (!el) return;
  const vis = Object.keys(boatMarkers);
  const o = okRoutes().filter(r => vis.includes(r.model));
  const best = okRoutes()[0];
  el.innerHTML = o.slice(0, 4).map((r, i) => `<span class="rk ${r === best ? 'best' : ''} ${state.time >= r.eta ? 'done' : ''}" data-id="${r.model}"><i style="background:${mcol(r.model)}"></i>${r === best ? '★ ' : (i + 1) + '. '}${modelById(r.model).name} <em>${r === best ? '<span class="w">cilj </span>' + fmtTime(r.eta, false) : '+' + fmtDur((r.eta - best.eta) / 3600000)}</em>${state.time >= r.eta ? ' 🏁' : ''}</span>`).join('')
    + (o.length > 4 ? `<span class="rk">+${o.length - 4}</span>` : '');
  el.querySelectorAll('.rk[data-id]').forEach(s => s.onclick = () => { state.selected = s.dataset.id; drawRoutes(); showBoatInfo(s.dataset.id); });
}

// ---------------- compare tab ----------------
function renderCompareTab() {
  const el = $('#tab-compare');
  const rs = Object.values(state.routes);
  if (!rs.length) { el.innerHTML = '<div class="note">Još nema izračunatih ruta. Otvori karticu Routing.</div>'; return; }
  const ok = okRoutes();
  const ideal = ok[0], bestEta = ideal ? ideal.eta : 0;
  const spread = ok.length > 1 ? (ok[ok.length - 1].eta - ok[0].eta) / 3600000 : 0;
  el.innerHTML = `
    ${ideal ? `<div class="ideal"><span class="dot" style="background:${mcol(ideal.model)}"></span><div><b>★ Idealna ruta: ${modelById(ideal.model).name}</b><br><small>najbrža od svih modela · ${fmtDur(ideal.stats.hours)} · cilj ${fmtTime(ideal.eta, false)}</small></div></div>` : ''}
    ${ok.length > 1 ? `<div class="seg"><button data-rv="all" class="${settings.routeView !== 'one' ? 'on' : ''}">Sve rute</button><button data-rv="one" class="${settings.routeView === 'one' ? 'on' : ''}">Samo odabrana</button></div>` : ''}
    <table class="cmp"><tr><th>Model</th><th>Cilj</th><th>Zaostatak</th><th>Odstup.</th><th>nm</th><th>Ø kn</th><th>T/G</th></tr>
    ${ok.map(r => { const m = modelById(r.model), s = r.stats, d = deviation(r, ideal); return `<tr data-id="${r.model}" class="${r.model === state.selected ? 'sel' : ''}">
      <td><span class="dot" style="background:${mcol(m.id)}"></span>${r === ideal ? '★ ' : ''}${m.name}</td><td class="${r === ideal ? 'best' : ''}">${fmtTime(r.eta, false)}</td>
      <td>${r === ideal ? '<b>idealna</b>' : '+' + fmtDur((r.eta - bestEta) / 3600000)}</td>
      <td>${r === ideal ? '–' : `do ${d.max.toFixed(1)} nm<br><small style="color:var(--muted)">Ø ${d.mean.toFixed(1)}</small>`}</td>
      <td>${s.dist.toFixed(1)}</td><td>${s.avgSog.toFixed(1)}</td><td>${s.tacks}/${s.gybes}</td></tr>`; }).join('')}
    ${rs.filter(r => !r.ok).map(r => `<tr><td><span class="dot" style="background:${mcol(r.model)}"></span>${modelById(r.model).name}</td><td colspan="6" style="text-align:left;color:var(--bad);white-space:normal">${r.error}</td></tr>`).join('')}
    </table>
    <p class="note">Dodirni red za odabir rute. <b>Odstupanje</b> = koliko daleko ruta ide od idealne (najveće / prosječno). <b>T/G</b> = broj okreta kroz vjetar / kroz krmu. ▶ na karti pokreće utrku brodića.</p>
    ${ok.length > 1 ? `<p class="note">Raspon dolaska između modela: <b>${fmtDur(spread)}</b>. ${spread > 2 ? 'Modeli se znatno razilaze – prati razvoj i plan B.' : 'Modeli se dobro slažu.'}</p>` : ''}
    <div class="row"><label>Prikaži izokrone odabrane rute</label><input type="checkbox" id="isoT" ${state.showIso !== false ? 'checked' : ''}></div>
    <div id="routeDetail"></div>
    <h3>Spremanje</h3>
    <div class="note">${state.routesSaved ? '✓ <b>Rute su spremljene</b> – ostaju i nakon zatvaranja aplikacije, dok ih ne obrišeš.' : '<b>Rute nisu spremljene</b> – nestat će kad zatvoriš aplikaciju. Spremi ih ako ih trebaš kasnije (npr. na moru).'}</div>
    <button id="btnSaveRoutes" class="btn block" ${state.routesSaved ? 'disabled' : ''}>💾 Spremi rute</button>
    <button id="btnClearRoutes2" class="btn block danger">🗑 Obriši rute (zauvijek)</button>`;
  el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { state.selected = tr.dataset.id; drawRoutes(); renderCompareTab(); });
  el.querySelectorAll('[data-rv]').forEach(b => b.onclick = () => setRouteView(b.dataset.rv));
  armDelete(el.querySelector('#btnClearRoutes2'), 'Rute su obrisane (staza je ostala)', async () => { await clearRoutes(); renderCompareTab(); });
  el.querySelector('#btnSaveRoutes').onclick = async () => { await saveRoutes(); renderCompareTab(); };
  el.querySelector('#isoT').onchange = e => { state.showIso = e.target.checked; drawRoutes(); };
  renderRouteDetail();
}
function renderRouteDetail() {
  const r = state.routes[state.selected]; const el = $('#routeDetail');
  if (!r || !r.ok) { el.innerHTML = ''; return; }
  const s = r.stats, m = modelById(r.model);
  const sails = Object.entries(s.sails).sort((a, b) => b[1] - a[1]).map(([k, h]) => `<span class="dot" style="background:${(SAILS[k] || {}).color || '#888'}"></span>${k} ${fmtDur(h)}`).join(' &nbsp; ');
  el.innerHTML = `
    <h3><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} – detalji</h3>
    <div class="kv">
      <div><b>${fmtDur(s.hours)}</b><span>trajanje</span></div><div><b>${s.dist.toFixed(1)} nm</b><span>prijeđeno</span></div><div><b>${s.avgSog.toFixed(1)} kn</b><span>prosj. SOG</span></div>
      <div><b>${s.tacks}</b><span>okreta kroz vjetar</span></div><div><b>${s.gybes}</b><span>kroz krmu</span></div><div><b>${s.sailChanges}</b><span>promjena jedara</span></div>
    </div>
    <div class="note" style="margin-top:10px">Jedra: ${sails}</div>
    <canvas class="chart" id="routeChart"></canvas>
    <div class="note">Graf: TWS (puna), udari (točkasta), BSP (bijela), TWA (siva, desna skala), ispod traka jedara.</div>
    <h3>Točke rute</h3>
    <table class="cmp legs"><tr><th>Vrijeme</th><th>TWD</th><th>TWS</th><th>TWA</th><th>HDG</th><th>BSP</th><th>Jedro</th></tr>
    ${r.track.filter((p, i, a) => i === 0 || p.mark || i === a.length - 1 || Math.floor(p.t / 3600000) !== Math.floor(a[i - 1].t / 3600000)).map(p => `
      <tr data-t="${p.t}"><td>${fmtTime(p.t, false)}${p.mark ? ' 🚩' : ''}</td><td>${Math.round(p.twd)}°</td><td>${p.tws.toFixed(1)}</td><td>${Math.round(Math.abs(p.twa))}° ${p.twa < 0 ? 'L' : 'D'}</td><td>${Math.round(p.hdg)}°</td><td>${p.bsp.toFixed(1)}</td><td><span class="dot" style="background:${p.sailColor}"></span>${p.sail}</td></tr>`).join('')}
    </table>
    <button id="btnExportGpx" class="btn block">Izvezi rutu (GPX)</button>`;
  el.querySelectorAll('tr[data-t]').forEach(tr => tr.onclick = () => { const t = +tr.dataset.t; setTime(t); const p = routeAt(r, t); map.panTo([p.lat, p.lon]); });
  el.querySelector('#btnExportGpx').onclick = () => exportGpx(r);
  drawRouteChart($('#routeChart'), r);
}
function drawRouteChart(cv, r) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tr = r.track, t0 = tr[0].t, t1 = tr[tr.length - 1].t;
  let max = 10; tr.forEach(p => { max = Math.max(max, p.tws, p.gust || 0, p.bsp); }); max = Math.ceil(max / 5) * 5;
  const X = t => 28 + (t - t0) / (t1 - t0) * (w - 60), Y = v => 8 + (1 - v / max) * (h - 40), YA = a => 8 + (a / 180) * (h - 40);
  c.font = '10px -apple-system,system-ui';
  for (let v = 0; v <= max; v += 5) { c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(28, Y(v), w - 60, 1); c.fillStyle = '#7f8da0'; c.fillText(v, 6, Y(v) + 3); }
  [0, 45, 90, 135, 180].forEach(a => { c.fillStyle = '#5f6b7a'; c.fillText(a + '°', w - 28, YA(a) + 3); });
  // sail band
  for (let i = 0; i < tr.length - 1; i++) { c.fillStyle = tr[i].sailColor; c.fillRect(X(tr[i].t), h - 26, X(tr[i + 1].t) - X(tr[i].t) + 0.5, 8); }
  const line = (get, col, wd, dash = [], yf = Y) => { c.strokeStyle = col; c.lineWidth = wd; c.setLineDash(dash); c.beginPath(); tr.forEach((p, i) => { const v = get(p); i ? c.lineTo(X(p.t), yf(v)) : c.moveTo(X(p.t), yf(v)); }); c.stroke(); c.setLineDash([]); };
  line(p => Math.abs(p.twa), 'rgba(160,170,185,.55)', 1, [], YA);
  line(p => p.gust || p.tws, colorFor('wind', 18), 1, [2, 3]);
  // tws coloured segments
  for (let i = 0; i < tr.length - 1; i++) { c.strokeStyle = colorFor('wind', tr[i].tws); c.lineWidth = 2.6; c.beginPath(); c.moveTo(X(tr[i].t), Y(tr[i].tws)); c.lineTo(X(tr[i + 1].t), Y(tr[i + 1].tws)); c.stroke(); }
  line(p => p.bsp, '#ffffff', 1.6);
  // labels: hours
  c.fillStyle = '#9aa7b8';
  const span = (t1 - t0) / 3600000, every = span > 30 ? 6 : span > 12 ? 3 : 1;
  for (let t = Math.ceil(t0 / 3600000) * 3600000; t <= t1; t += 3600000) {
    const hh = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(t);
    if (hh % every === 0) c.fillText(String(hh).padStart(2, '0'), X(t) - 6, h - 4);
  }
  // cursor
  if (state.time >= t0 && state.time <= t1) { c.fillStyle = '#ffb547'; c.fillRect(X(state.time), 4, 1.5, h - 30); }
}
function exportGpx(r) {
  const pts = r.track.map(p => `<rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time><name>${fmtTime(p.t, false)} ${p.sail}</name></rtept>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Clock the Wind" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>${modelById(r.model).name} ${fmtTime(r.startTime)}</name>\n${pts}\n</rte></gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = `clock-the-wind-${r.model}.gpx`; a.click();
}

// ---------------- settings tab ----------------
function renderSettingsTab() {
  const el = $('#tab-settings');
  const p = state.polar;
  const opt = (v, t) => `<option value="${v}" ${state.basemap === v ? 'selected' : ''}>${t}</option>`;
  el.innerHTML = `
    <h3>Karta</h3>
    <div class="row"><label>Podloga</label><select id="basemap">
      ${opt('nautical', 'Nautička – dubine i izobate (offline)')}${opt('offline', 'Tamna obala (offline)')}
      ${opt('emodnet', 'EMODnet batimetrija + OSM obala (online)')}${opt('dark', 'Tamna (online)')}${opt('light', 'Svijetla (online)')}${opt('sat', 'Satelit (online)')}</select></div>
    <div class="row"><label>OpenSeaMap oznake (svjetionici, plutače)</label><input type="checkbox" id="seam" ${settings.seamarks ? 'checked' : ''}></div>
    <div class="row"><label>Boje vjetra/valova na karti</label><input type="checkbox" id="colors" ${state.colors !== false ? 'checked' : ''}></div>
    <div class="row"><label>Najviša oštrina iscrtavanja (HD)</label><input type="checkbox" id="hires" ${state.hiRes ? 'checked' : ''}></div>
    <div class="row"><label>Boje i preko kopna</label><input type="checkbox" id="ovl" ${state.colorOverLand ? 'checked' : ''}></div>
    <div class="row"><label>Prozirnost boja</label><input type="range" id="opac" min="0.2" max="1" step="0.05" value="${state.opacity}"></div>
    <div class="row"><label>Gustoća čestica</label><input type="range" id="pden" min="0.3" max="2" step="0.1" value="${settings.particleDensity}"></div>
    <div class="note">Izobate: ${ISOBATHS.join(', ')} m. Dubine: EMODnet Bathymetry DTM. Navionics karte su licencirane i ne mogu se ugraditi; za službenu navigaciju koristi plotter / Navionics.</div>
    <h3>Brodovi (polari)</h3>
    ${boats.map(b => `<div class="row"><label><input type="radio" name="boat" value="${b.id}" ${b.id === state.boat.id ? 'checked' : ''}> ${b.name}${b.sails === 'melges40' ? ' · crossover' : ''}</label>${b.builtin ? '' : `<button class="mini" data-delboat="${b.id}">obriši</button>`}</div>`).join('')}
    <canvas class="chart" id="polarChart" style="height:240px"></canvas>
    <div class="row"><label>Dodaj brod – polar datoteka</label></div>
    <div class="row"><input type="file" id="polarFile" accept=".csv,.txt,.pol,.json,text/plain"></div>
    <div class="note">Podržano: ORC CSV (kao Clockwork), Expedition/B&G/OpenCPN/Adrena TWA×TWS mreže (tab, zarez, točka-zarez ili razmak), transponirane mreže i PredictWind format „TWS TWA BSP TWA BSP…".</div>
    ${state.boat.sails === 'melges40' ? `<h3>Crossover jedara</h3>
    <div class="note">Digitalizirano iz North Sails charta (J1–J4, FRO, A1.5/A2/A4/A5, jib strut, 1. kratež). Za druge brodove ruta prikazuje kurs (kroz/bočni/krma).</div>
    <canvas class="chart" id="xoverChart" style="height:240px"></canvas>` : ''}
    <h3>Izvori podataka</h3>
    <div class="row"><label>Open-Meteo komercijalni API ključ</label></div>
    <div class="row"><input type="password" id="apikey" class="field" style="flex:1" placeholder="prazno = besplatni limit" value="${settings.apiKey}" autocomplete="off"></div>
    <div class="row"><label>Adresa paketa iz oblaka</label></div>
    <div class="row"><input type="text" id="cloudUrl" class="field" style="flex:1" value="${settings.cloudUrl || CLOUD_DEFAULT}"></div>
    <div class="note">Meteomatics račun i GRIB uvoz su u kartici Prognoza. ALADIN-HR: čim DHMZ odobri pristup, dodaje se kao izvor.</div>
    <h3>Aplikacija</h3>
    <div class="row"><label>Animirani Clockwork logo pri pokretanju</label><input type="checkbox" id="introT" ${(() => { try { return localStorage.getItem('ctw.intro') !== 'off'; } catch { return true; } })() ? 'checked' : ''}></div>
    <button id="introPlay" class="btn block">Pokaži animaciju</button>
    <div class="note">Verzija 2.1 · Instaliraj: Safari → Dijeli → „Dodaj na početni zaslon" (iPhone/iPad) ili Safari → Datoteka → „Dodaj u Dock" (Mac).</div>
    <button id="clearData" class="btn warn block">Obriši spremljene prognoze i rute</button>`;
  el.querySelector('#basemap').onchange = e => { state.basemap = settings.basemap = e.target.value; saveSettings(); applyBasemap(); };
  el.querySelector('#seam').onchange = e => { settings.seamarks = e.target.checked; saveSettings(); applyBasemap(); };
  el.querySelector('#colors').onchange = e => { state.colors = settings.colors = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#hires').onchange = e => { state.hiRes = settings.hiRes = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#ovl').onchange = e => { state.colorOverLand = settings.colorOverLand = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#opac').oninput = e => { state.opacity = settings.opacity = +e.target.value; saveSettings(); wxLayer.draw(); };
  el.querySelector('#pden').onchange = e => { settings.particleDensity = state.particleDensity = +e.target.value; saveSettings(); particleLayer.seed(); };
  el.querySelector('#apikey').onchange = e => { settings.apiKey = e.target.value.trim(); saveSettings(); };
  el.querySelector('#cloudUrl').onchange = e => { settings.cloudUrl = e.target.value.trim(); saveSettings(); };
  el.querySelectorAll('input[name=boat]').forEach(r => r.onchange = () => { selectBoat(r.value); renderSettingsTab(); });
  el.querySelectorAll('[data-delboat]').forEach(b => b.onclick = async () => { boats = boats.filter(x => x.id !== b.dataset.delboat); await saveBoats(); selectBoat('melges40'); renderSettingsTab(); });
  el.querySelector('#polarFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const src = parsePolarAny(await f.text());
      const test = new Polar(src, 'test'); if (!(test.speed(90, 12) > 0.5)) throw new Error('brzine izgledaju neispravno');
      const name = prompt('Ime broda:', f.name.replace(/\.\w+$/, '')) || f.name;
      const b = { id: 'boat-' + Date.now(), name, src, sails: 'none' };
      boats.push(b); await saveBoats(); selectBoat(b.id);
      toast(`Polar učitan: ${src.tws.length} brzina vjetra × ${src.table.length} kutova`); renderSettingsTab();
    } catch (err) { toast('Neispravan polar: ' + err.message, 4000); }
  };
  el.querySelector('#introT').onchange = e => { try { localStorage.setItem('ctw.intro', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ } };
  el.querySelector('#introPlay').onclick = () => playIntro({ force: true });
  el.querySelector('#clearData').onclick = async () => { if (!confirm('Obrisati spremljene prognoze i rute?')) return; await kv.del('forecast:latest'); await kv.del('routes:savedByCourse'); await kv.del('routes:saved'); await kv.del('routes:latest'); state.routes = {}; state.routesSaved = false; drawRoutes(); useSet(null); toast('Obrisano'); };
  drawPolarChart($('#polarChart'));
  if ($('#xoverChart')) drawXover($('#xoverChart'));
}
function drawPolarChart(cv) {
  const p = state.polar; if (!p) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = 20, cy = h / 2, R = Math.min(w - 40, h / 2 - 10), max = 20;
  c.strokeStyle = 'rgba(255,255,255,.08)';
  for (let v = 5; v <= max; v += 5) { c.beginPath(); c.arc(cx, cy, v / max * R, -Math.PI / 2, Math.PI / 2); c.stroke(); c.fillStyle = '#6f7d8f'; c.font = '10px system-ui'; c.fillText(v, cx + 2, cy - v / max * R + 10); }
  for (let a = 0; a <= 180; a += 30) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.sin(a * Math.PI / 180) * R, cy - Math.cos(a * Math.PI / 180) * R); c.stroke(); }
  [6, 8, 10, 12, 14, 16, 20, 24].forEach(tws => {
    c.strokeStyle = colorFor('wind', tws); c.lineWidth = 1.6; c.beginPath();
    for (let a = 25; a <= 180; a += 2) { const v = p.speed(a, tws) / max * R, x = cx + Math.sin(a * Math.PI / 180) * v, y = cy - Math.cos(a * Math.PI / 180) * v; a === 25 ? c.moveTo(x, y) : c.lineTo(x, y); }
    c.stroke();
    const o = p.optimal(tws); c.fillStyle = colorFor('wind', tws);
    [o.beat, o.gybe].forEach(a => { const v = p.speed(a, tws) / max * R; c.beginPath(); c.arc(cx + Math.sin(a * Math.PI / 180) * v, cy - Math.cos(a * Math.PI / 180) * v, 2.5, 0, 7); c.fill(); });
  });
  c.fillStyle = '#9aa7b8'; c.font = '10px system-ui';
  [6, 8, 10, 12, 14, 16, 20, 24].forEach((t, i) => { c.fillStyle = colorFor('wind', t); c.fillRect(w - 70, 10 + i * 13, 10, 3); c.fillStyle = '#9aa7b8'; c.fillText(t + ' kn', w - 55, 14 + i * 13); });
}
function drawXover(cv) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const X = a => 24 + (a - 30) / 150 * (w - 30), Y = v => h - 16 - v / 35 * (h - 24);
  // recommended sail per cell
  for (let a = 30; a < 180; a += 2) for (let v = 2; v < 35; v += 0.5) { const r = recommendSail(a, v); c.fillStyle = r.color; c.globalAlpha = r.reef ? 0.55 : 0.85; c.fillRect(X(a), Y(v + 0.5), X(a + 2) - X(a) + 0.5, Y(v) - Y(v + 0.5) + 0.5); }
  c.globalAlpha = 1; c.fillStyle = '#cfd8e3'; c.font = '10px system-ui';
  for (let a = 30; a <= 180; a += 30) c.fillText(a + '°', X(a) - 8, h - 3);
  for (let v = 5; v <= 35; v += 5) c.fillText(v, 4, Y(v) + 3);
  c.font = '700 11px system-ui'; c.fillStyle = '#111';
  Object.entries(SAILS).forEach(([n, s]) => { const cxs = s.poly.reduce((q, p) => q + p[0], 0) / s.poly.length, cys = s.poly.reduce((q, p) => q + p[1], 0) / s.poly.length; c.fillText(n, X(cxs) - 8, Y(cys)); });
}

// ---------------- network status ----------------
function netStatus() { const on = navigator.onLine; $('#netPill').textContent = on ? 'online' : 'offline'; $('#netPill').classList.toggle('off', !on); }
addEventListener('online', netStatus); addEventListener('offline', netStatus); netStatus();

// ---------------- boot ----------------
(async function boot() {
  drawCourse();
  renderLegend();
  state.native = await nativeAvailable();
  settings._native = state.native;
  // v1.5: the forecast area follows the map window by default (an old 'Cijeli Jadran' choice is reset once)
  if (!localStorage.getItem('ctw.v15area')) { if (settings.areaSel !== 'custom') settings.areaSel = 'view'; localStorage.setItem('ctw.v15area', '1'); }
  if (!settings.source) settings.source = state.native ? 'direct' : 'cloud';
  if (state.native) {
    if (!settings.source) settings.source = 'direct';
    if (!settings.directModels) settings.directModels = DIRECT.map(m => m.id);
  }
  if (!settings.directModels) settings.directModels = ['dir_ecmwf', 'dir_gfs'];   // iPhone/Safari: the two official sources with CORS
  saveSettings();
  await loadStatic();
  workers.forEach(w => w.postMessage({ cmd: 'mask', mask: state.mask }));
  const set = await loadForecast().catch(() => null);
  await kv.del('routes:latest').catch(() => {});   // earlier versions saved every calculation automatically – gone for good
  const one = await kv.get('routes:saved').catch(() => null);
  if (one && one.course && one.routes) { const m = await savedMap(); m[courseKey(one.course)] = one; await kv.set('routes:savedByCourse', m); }
  await kv.del('routes:saved').catch(() => {});
  if (set) useSet(set); else renderChips();
  if (set) await showSavedRoutes();   // routes come back only if you saved them for this regatta
  particleLayer.start();
  map.invalidateSize();
  if (settings.mode !== 'race') routeLayer.remove();
  updateModePill();
  const home = () => { const b = state.set && state.set.bbox; if (settings.mode === 'forecast' && b) map.fitBounds([[b.s, b.w], [b.n, b.e]]); else zoomCourse(); };
  home();
  wxLayer.draw();
  setTimeout(() => { map.invalidateSize(); if (map.getZoom() < 7) home(); maybeFillWindow(200); }, 600);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  // model-run watcher: tells you when a newer run is available than the one you raced with
  const watch = async () => { if (state.set && navigator.onLine) { state.newRuns = await checkNewRuns(state.set).catch(() => []); renderChips(); $('#btnRefresh').classList.toggle('badge', state.newRuns.length > 0); } };
  watch(); setInterval(watch, 20 * 60000);
  setInterval(() => state.set && setTime(state.time), 60000); // keep countdown fresh
})();
window.ctw = { state, settings, course, map,
  fn: { courseKey, savedMap, showSavedRoutes, saveRoutes, clearCourse, clearRoutes, busy: () => dlBusy, uncovered: () => uncoveredShare(), setExtent, dlArea, replayPlay, replayPause, showBoatInfo, setRouteView, deviation, manoeuvres, okRoutes, runRouting, loadCloud, drawCourse, setTime, openSheet, selectModel, renderDataTab, startAreaPick, exportPackage, importPackage, routeAt,
    markLayer: () => markLayer, routeLayer: () => routeLayer, wx: () => wxLayer, particles: () => particleLayer } };

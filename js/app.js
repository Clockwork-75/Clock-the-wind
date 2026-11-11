import { Polar, parsePolarCSV, parsePolarAny } from './polar.js';
import { recommendSail, SAILS, SAIL_SETS, sailColor } from './sails.js';
import { M40_VPP, MAT1180_VPP, MAT1180_ORC, FIRST30_VPP } from './boatdata.js';
import { decodeLandmask, isLand, snapToSea } from './landmask.js';
import { loadBathy, routingMask, depthAt } from './bathy.js';
import { sample, lastTime, fillTimeGaps } from './field.js';
import { MODELS, MM_MODELS, ALADIN, QUALITY, MARINE_STEP, modelById, registerModel, gridFor, raceWindow, estimateCalls, downloadForecast, checkNewRuns, saveForecast, loadForecast } from './forecast.js';
import { decodeGrib, gribToField } from './grib.js';
import { DIRECT, directUsable, nativeAvailable, downloadDirect, exportPackage, isPackage, importPackage, fetchCloudPackage, fetchCloudModels, CLOUD_MODELS, CLOUD_DEFAULT } from './direct.js';
import { WeatherLayer, ParticleLayer, ChartLayer, DepthLayer, LAYERS, decodeCoast, decodeWorld, colorFor, ISOBATHS } from './layers.js';
import { PRESETS, REGATTAS, PLACES } from './courses.js';
import { speedDirFromUV, distNm, bearing, fmtLatLon, angDiff } from './geo.js';
import { kv } from './db.js';
import { playIntro } from './intro.js';
import { buildClockW, clockwWindow, isClockW, clockwMeta, isDerived } from './ensemble.js';
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
  colors: true, hiRes: true, fcDays: 15, draft: 2.6, depthMargin: 1.4, avoidShallow: true, boatId: 'melges40', mmUser: '', mmPass: '',
};
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('ctw.settings') || '{}'));
if (settings.basemap === 'offline' && !localStorage.getItem('ctw.v2')) { settings.basemap = 'nautical'; localStorage.setItem('ctw.v2', '1'); }
if (!localStorage.getItem('ctw.v22days')) { if (!settings.fcDays || settings.fcDays <= 3) settings.fcDays = 15; localStorage.setItem('ctw.v22days', '1'); localStorage.setItem('ctw.settings', JSON.stringify(settings)); }
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
  modelName: id => (modelById(id) || {}).name || id,
};
const minDepth = () => settings.avoidShallow ? settings.draft + settings.depthMargin : 0.05;

// ---------------- map ----------------
const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, minZoom: 5, maxZoom: 17, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 })
  .setView([43.25, 16.1], 9);
const TILE_SETS = {
  dark: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', attr: '© Esri, HERE, Garmin, © OpenStreetMap', maxNative: 16 },
  light: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', attr: '© Esri, HERE, Garmin, © OpenStreetMap', maxNative: 16 },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', attr: 'Esri World Imagery' },
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
    add(L.tileLayer(t.url, { attribution: t.attr, maxZoom: 19, maxNativeZoom: t.maxNative || 19 }));
    add(L.tileLayer(t.labels, { pane: 'labels', maxZoom: 19, maxNativeZoom: t.maxNative || 19 }));
  } else if (state.basemap === 'emodnet') {
    add(L.tileLayer.wms(EMODNET, { layers: 'emodnet:mean', styles: 'atlas_land', format: 'image/png', attribution: 'EMODnet Bathymetry', maxZoom: 17 }));
    add(L.tileLayer.wms(EMODNET, { layers: 'emodnet:contours', format: 'image/png', transparent: true, pane: 'labels', maxZoom: 17 }));
    add(L.tileLayer.wms(EMODNET, { layers: 'coastlines', styles: '', format: 'image/png', transparent: true, pane: 'labels', maxZoom: 17 }));
  } else {
    map.attributionControl.addAttribution('Dubine © EMODnet Bathymetry · Obala © GSHHG/OSM');
  }
  if (settings.seamarks) add(L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { pane: 'labels', maxZoom: 18, attribution: '© OpenSeaMap' }));
  document.body.dataset.basemap = state.basemap;
  detailKey = '__'; updateLandDetail();
  chartLayer && chartLayer.draw();
  wxLayer && wxLayer.draw();
}
// ---- detailed land when zoomed in (like Windy): towns, roads, relief on land; the sea stays our chart + wind ----
// Only over the offline basemaps (nautical / dark coast), only online, from zoom LAND_DETAIL_Z. Off: Postavke → Karta.
const LAND_DETAIL_Z = 10;
const DETAIL_TILES = {
  nautical: { base: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', labels: null, hill: 0 },   // towns, roads and relief in one layer
  offline: { base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', hill: 0.22, maxNative: 16 },
};
const HILLSHADE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
let detailLayers = [], detailKey = '';
function updateLandDetail() {
  const d = DETAIL_TILES[state.basemap];
  const on = !!d && settings.landDetail !== false && navigator.onLine && map.getZoom() >= LAND_DETAIL_Z - 0.01;
  const key = on ? state.basemap : '';
  if (key !== detailKey) {
    detailLayers.forEach(l => map.removeLayer(l)); detailLayers = [];
    if (on) {
      const attr = '© Esri, HERE, Garmin, © OpenStreetMap';
      detailLayers.push(L.tileLayer(d.base, { maxZoom: 19, maxNativeZoom: d.maxNative || 19, attribution: attr }).addTo(map));
      if (d.hill) detailLayers.push(L.tileLayer(HILLSHADE, { maxZoom: 19, maxNativeZoom: 15, opacity: d.hill, className: 'ctw-hill' }).addTo(map));
      if (d.labels) detailLayers.push(L.tileLayer(d.labels, { pane: 'labels', maxZoom: 19, maxNativeZoom: d.maxNative || 19 }).addTo(map));
    }
    detailKey = key;
  }
  const changed = state.landDetail !== on;
  state.landDetail = on;
  document.body.classList.toggle('land-detail', on);
  if (changed && chartLayer) chartLayer.draw();
}
map.on('zoomend', updateLandDetail);
addEventListener('online', () => updateLandDetail()); addEventListener('offline', () => updateLandDetail());
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
// a date that may be long ago ("ne javlja se od 24.06. 08:00"; the year only when it is not this year)
const fmtDate = t => { const p = new Intl.DateTimeFormat('hr-HR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t)); const g = k => (p.find(x => x.type === k) || {}).value; return `${g('day')}.${g('month')}.${g('year') !== String(new Date().getFullYear()) ? g('year') + '.' : ''} ${g('hour')}:${g('minute')}`; };
// model run time, shown in local (Croatian) time like every other time in the app – e.g. the 00z run is "09.11. 01h"
const fmtRun = t => { const p = new Intl.DateTimeFormat('hr-HR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(t)); const g = k => (p.find(x => x.type === k) || {}).value; return `${g('day')}.${g('month')}. ${g('hour')}h`; };
const raceStart = () => course.start || defaultStart();
// Model colours on the map: each model in the current forecast gets its own slot from a palette chosen to stand out
// against the wind colours (no blues/greens) and against each other. Used everywhere (chips, routes, boats, tables).
// Every model keeps the SAME colour everywhere and always (tabs, routes, boats, tables) – also after a refill or a
// new download. Strong colours that stand out against the wind colours: no blues or greens.
const MODEL_COLORS = {
  italia_meteo_arpae_icon_2i: '#ff1744', icon_d2: '#ff9100', icon_eu: '#ffffff', ecmwf_ifs: '#e040fb', ecmwf: '#e040fb',
  gfs_seamless: '#ffee00', gfs: '#ffee00', knmi_harmonie_arome_europe: '#111111', meteofrance_arpege_europe: '#ff80ab',
  ukmo_global_deterministic_10km: '#8d6e63', ecmwf_aifs025_single: '#9e9e9e',
  aladin: '#ff3d00', arpege: '#ff80ab', moja: '#b388ff',
  'mm:mix': '#ff6e40', 'mm:ecmwf-ifs': '#7c4dff', 'mm:mm-swiss1k': '#f8bbd0',
};
const CLOCKW_COLORS = ['#18ffff', '#64ffda', '#00b8d4', '#b2ff59', '#40c4ff', '#a7ffeb'];   // ClockW1, ClockW2, … (turquoise family)
const EXTRA_COLORS = ['#ff6e40', '#7c4dff', '#f8bbd0', '#ffab40', '#b71c1c', '#ce93d8'];   // imported GRIB files
function mcol(id) {
  const k = String(id).replace(/^dir_/, '');
  if (MODEL_COLORS[k]) return MODEL_COLORS[k];
  const cw = /^clockw(\d*)$/.exec(k); if (cw) return CLOCKW_COLORS[((+cw[1] || 1) - 1) % CLOCKW_COLORS.length];
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
  try { const wj = await fetch('data/world.json').then(r => r.ok ? r.json() : null); if (wj) state.world = decodeWorld(wj); } catch (e) { console.warn('world', e); }
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
// Two boats of our own, each with two polars: the designer VPP (default, the most detailed) and the ORC certificate.
// Imported polars (Postavke → Brodovi) are added below them.
const BOAT_GROUPS = [
  { id: 'clockwork', name: 'Clockwork', type: 'Melges 40', draft: 2.6 },
  { id: 'leeloo', name: 'LeeLoo', type: 'Mat 11.80', draft: 2.6 },
  { id: 'fugu', name: 'Fugu', type: 'First 30 JK', draft: 1.9 },
];
let boats = [];
async function loadBoats() {
  const user = ((await kv.get('boats').catch(() => null)) || []).filter(b => !b.builtin);
  const csv = await fetch('data/polar_melges40.csv').then(r => r.ok ? r.text() : null).catch(() => null);
  boats = [
    { id: 'melges40', group: 'clockwork', kind: 'vpp', name: 'Clockwork · Melges 40 – VPP (Botin)', src: M40_VPP, sails: 'melges40', builtin: true },
    ...(csv ? [{ id: 'melges40-orc', group: 'clockwork', kind: 'orc', name: 'Clockwork · Melges 40 – ORC', src: parsePolarCSV(csv), sails: 'melges40', builtin: true }] : []),
    { id: 'leeloo', group: 'leeloo', kind: 'vpp', name: 'LeeLoo · Mat 11.80 – VPP (North Sails)', src: MAT1180_VPP, sails: 'mat1180', builtin: true },
    { id: 'leeloo-orc', group: 'leeloo', kind: 'orc', name: 'LeeLoo · Mat 11.80 – ORC 2025', src: MAT1180_ORC, sails: 'mat1180', builtin: true },
    { id: 'fugu', group: 'fugu', kind: 'vpp', name: 'Fugu · First 30 JK – polar (Bénéteau/JK)', src: FIRST30_VPP, sails: 'none', builtin: true },
    ...user,
  ];
  selectBoat(settings.boatId, true);
}
const boatGroup = b => BOAT_GROUPS.find(g => g.id === (b && b.group));
function selectBoat(id, boot = false) {
  const prev = state.boat;
  const b = boats.find(x => x.id === id) || boats[0];
  settings.boatId = b.id;
  // each boat keeps its own draft (Clockwork / LeeLoo); the land/shallow mask follows the chosen boat
  const key = b.group || b.id;
  settings.boatDrafts = settings.boatDrafts || {};
  if (settings.boatDrafts[key] == null) settings.boatDrafts[key] = (boatGroup(b) || {}).draft || settings.draft;   // a boat's own draft (Fugu 1.9 m), changeable in Routing
  const draftChanged = Math.abs(settings.boatDrafts[key] - settings.draft) > 1e-6;
  settings.draft = settings.boatDrafts[key];
  saveSettings();
  state.boat = b; state.polar = new Polar(b.src, b.name);
  if (draftChanged && !boot) rebuildMask();
  if (prev && prev.id !== b.id) markStale();
}
async function saveBoats() { await kv.set('boats', boats.filter(b => !b.builtin)); }
const sailSetOf = b => b && SAIL_SETS[b.sails] ? b.sails : null;

// ---------------- forecast set handling ----------------
function useSet(set) {
  state.set = set;
  if (!set) { renderChips(); return; }
  if (set.fields.clockw) {   // 2.3: one 'clockw' → ClockW1 (own tab at the end)
    const f = set.fields.clockw; delete set.fields.clockw; f.meta = clockwMeta(1); f.model = 'clockw1';
    set.fields.clockw1 = f; set.models = [...set.models.filter(x => x !== 'clockw' && x !== 'clockw1'), 'clockw1'];
    if (state.modelId === 'clockw') state.modelId = 'clockw1';
  }
  pruneClockW(set);
  for (const id of cwIds(set)) set.fields[id].strictTime = true;
  for (const id of set.models) fillTimeGaps(set.fields[id]);
  const pref = ['dir_aladin', 'italia_meteo_arpae_icon_2i', 'dir_icon_eu', 'icon_eu', 'ecmwf_ifs', 'dir_ecmwf', 'dir_icon_d2', 'icon_d2', 'knmi_harmonie_arome_europe'];
  if (!state.modelId || !set.fields[state.modelId]) state.modelId = pref.find(id => set.fields[id]) || set.models[0];
  state.wind = withFallback(set, state.modelId);
  if (state.layer === 'conf' && !cwIds(set).length) { state.layer = settings.layer = 'wind'; saveSettings(); $$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x.dataset.layer === 'wind')); renderLegend(); }
  drawArea();
  state.marine = set.fields.marine;
  set.models.forEach(id => { if (set.fields[id].meta) registerModel(set.fields[id].meta); });
  const t0 = set.times[0], t1 = set.times[set.times.length - 1];
  const st = raceStart();
  if (state.time < t0 || state.time > t1) state.time = Math.max(t0, Math.min(t1, st >= t0 && st <= t1 ? st : Date.now()));
  setupTimeline();
  renderChips();
  redraw();
  if (state.ovObs && state.obs && typeof autoMoja === 'function') setTimeout(() => autoMoja(), 50);   // a new forecast: MOJA again
}
// the map shows only the chosen model's own data (and its own days 4–15): never pieces of other models or of older
// downloads – that mosaic made hard rectangular seams. Where the model has no data the colours fade out softly.
function withFallback(set, id) { return set.fields[id]; }
// A new download never shrinks what is coloured: the previous forecast stays underneath as a reserve,
// wherever (and whenever) the new one has no data. Old pieces fully covered by the new download are dropped.
// imported GRIB files stay when a new forecast arrives
function keepGribs(set, old) {
  if (!old) return;
  keepClockW(set, old);
  for (const id of old.models.filter(x => x.startsWith('grib:'))) if (!set.fields[id]) { set.fields[id] = old.fields[id]; set.models.push(id); }
}
const extentOf = f => ({ s: f.lat0, n: f.lat0 + f.dlat * (f.ny - 1), w: f.lon0, e: f.lon0 + f.dlon * (f.nx - 1) });
function inheritCoverage(nw, old) {
  if (!nw || !old || nw === old) return;
  const ne = setExtent(nw), t0 = nw.times[0], t1 = nw.times[nw.times.length - 1];
  const inside = (a, b) => b && a.s >= b.s && a.n <= b.n && a.w >= b.w && a.e <= b.e;
  const cand = [...(old.models || []).filter(id => !isDerived(id)).map(id => [id, old.fields[id]]), ...(old.prev || []).map(k => [k.replace(/^prev\d*:/, ''), old.fields[k]])];
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
  const b = state.set && state.set.bbox; if (!b || !state.showArea) return;   // only while the area is being chosen
  areaRect = L.rectangle([[b.s, b.w], [b.n, b.e]], { pane: 'routes', color: '#ffffff', weight: 1.5, opacity: 0.7, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
}
function selectModel(id) {
  state.modelId = id;
  state.wind = withFallback(state.set, id);
  renderChips(); redraw(); updatePointCard();
  if (state.ovObs) drawObs();
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
  el.querySelectorAll('.chip[data-model^="clockw"]').forEach(b => {
    const x = document.createElement('span'); x.className = 'chipx'; x.textContent = '✕'; x.title = 'Obriši ' + modelById(b.dataset.model).name;
    x.onclick = async e => {
      e.stopPropagation();
      if (!b.classList.contains('armed')) { b.classList.add('armed'); x.textContent = 'obriši?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); x.textContent = '✕'; } }, 4000); return; }
      const name = modelById(b.dataset.model).name; await removeClockW(b.dataset.model); toast(`${name} je obrisana`);
      if ($('#tab-data').classList.contains('on')) renderDataTab();
    };
    b.appendChild(x);
  });
}

// ---------------- timeline ----------------
const STEP = 15 * 60000, PLAY_STEP = 30 * 60000;   // slider resolution · play: 30 min every 0.16 s
function setupTimeline() {
  const s = state.set; if (!s) return;
  const sl = $('#tlSlider');
  sl.min = 0; sl.max = Math.round((s.times[s.times.length - 1] - s.times[0]) / STEP); sl.step = 1;
  sl.value = Math.round((state.time - s.times[0]) / STEP);
  drawTimeline();
}
// timeline rows (44 px): day labels 0–10 · one thin bar per model 11–21 (how far each model reaches) ·
// wind strip 23–31 · hour ticks 33–43. Past ~5 days the forecast is a trend: that part is hatched.
const TL_FULL = { bars: 10, barsH: 8, strip: 19, stripH: 7, ticks: 28 }, TL_PHONE = { bars: 9, barsH: 7, strip: 17, stripH: 7, ticks: 25 };
let TL = TL_FULL;
const isPhone = () => innerWidth <= 700;
const DOW = ['ned', 'pon', 'uto', 'sri', 'čet', 'pet', 'sub'];
const tzHour = t => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(t) % 24;
const tzDay = t => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' }).formatToParts(t); const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.find(x => x.type === 'weekday').value]; return { dow: DOW[wd], d: p.find(x => x.type === 'day').value }; };
function drawTimeline() {
  TL = isPhone() ? TL_PHONE : TL_FULL;
  const s = state.set; const cv = $('#tlCanvas');
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  const W = Math.round(w * dpr), Hh = Math.round(h * dpr); if (cv.width !== W) cv.width = W; if (cv.height !== Hh) cv.height = Hh;   // no new bitmap on every replay frame (iOS canvas memory)
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  if (!s) return;
  const t0 = s.times[0], t1 = s.times[s.times.length - 1], X = t => (t - t0) / (t1 - t0) * (w - 2) + 1;
  const pxDay = (w - 2) / Math.max(1 / 24, (t1 - t0) / 86400000);
  // one bar per model in its colour: solid = detailed part, lighter = long-range extension (days 4–15)
  const ids = s.models.filter(id => s.fields[id] && s.fields[id].times);
  const bh = Math.max(1.2, Math.min(3, TL.barsH / Math.max(1, ids.length) - 0.6)), gap = ids.length ? TL.barsH / ids.length : 0;
  ids.forEach((id, i) => {
    const f = s.fields[id], y = TL.bars + i * gap, own = Math.min(f.times[f.times.length - 1], f.validUntil || 1e15), end = lastTime(f);
    c.fillStyle = mcol(id); c.globalAlpha = id === state.modelId ? 1 : 0.8;
    c.fillRect(X(Math.max(t0, f.times[0])), y, Math.max(1, X(Math.min(own, t1)) - X(Math.max(t0, f.times[0]))), bh);
    if (end > own) { c.globalAlpha = 0.45; c.fillRect(X(own), y, Math.max(1, X(Math.min(end, t1)) - X(own)), bh); }
    c.globalAlpha = 1;
  });
  // wind strip for the display model at the course start (PredictWind-like day bar)
  const ref = course.marks[0];
  if (state.wind && ref) {
    const out = [], dt = (t1 - t0) > 6 * 86400000 ? 3 * 3600000 : 3600000;
    for (let t = t0; t < t1; t += dt) {
      sample(state.wind, ['u', 'v'], ref.lat, ref.lon, t, out);
      const v = Math.hypot(out[0], out[1]);
      c.fillStyle = v === v ? colorFor('wind', v) : 'rgba(255,255,255,.05)';
      c.fillRect(X(t), TL.strip, X(t + dt) - X(t) + 0.5, TL.stripH);
    }
  }
  // the display model has no data any more: dark (its last state stays frozen on the map)
  if (state.wind && state.wind.validUntil < t1) { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(X(state.wind.validUntil), TL.strip - 1, w - X(state.wind.validUntil), TL.stripH + 2); }
  // trend zone (more than 5 days ahead): hatched, labelled once
  const tr = Date.now() + 5 * 86400000;
  if (tr < t1) {
    c.save(); c.beginPath(); c.rect(X(tr), TL.strip, w - X(tr), TL.stripH); c.clip();
    c.strokeStyle = 'rgba(11,18,32,.55)'; c.lineWidth = 1.5;
    for (let x = X(tr) - TL.stripH; x < w; x += 5) { c.beginPath(); c.moveTo(x, TL.strip + TL.stripH); c.lineTo(x + TL.stripH, TL.strip); c.stroke(); }
    c.restore();
    if (w - X(tr) > 40) { c.font = '600 9.5px -apple-system,system-ui'; c.textBaseline = 'top'; c.fillStyle = '#9aa7b8'; c.fillText('trend', X(tr) + 3, TL.ticks + 1); }
  }
  // day separators + labels – as much text as the width allows
  c.font = '600 10.5px -apple-system,system-ui'; c.textBaseline = 'top';
  const every = pxDay < 18 ? 2 : 1; let k = 0;
  for (let t = Math.floor(t0 / 3600000) * 3600000; t <= t1; t += 3600000) {
    if (t < t0) continue;
    const hh = tzHour(t), x = X(t);
    if (hh === 0) {
      c.fillStyle = 'rgba(255,255,255,.5)'; c.fillRect(x, 0, 1, h);
      if (k++ % every === 0 && x < w - 12) { const d = tzDay(t); c.fillStyle = '#cfd8e3'; c.fillText(pxDay >= 70 ? fmtTime(t).slice(0, 10) : pxDay >= 36 ? `${d.dow} ${d.d}.` : `${d.d}.`, x + 3, 0); }
    }
    else if (pxDay >= 90 && hh % 6 === 0) { c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(x, TL.ticks, 1, 6); c.fillStyle = '#8796a8'; c.fillText(String(hh).padStart(2, '0'), x + 2, TL.ticks); }
    else if (pxDay >= 40 && pxDay < 90 && hh === 12) { c.fillStyle = 'rgba(255,255,255,.2)'; c.fillRect(x, TL.ticks, 1, 4); }
  }
  // race window: start flag + expected racing period
  const st = raceStart();
  if (!fcMode() && st >= t0 && st <= t1) {
    const etas = Object.values(state.routes).filter(r => r.ok).map(r => r.eta);
    const end = etas.length ? Math.max(...etas) : st + raceWindow(st, courseLength()).estHours * 3600000;
    c.fillStyle = 'rgba(76,209,138,.16)'; c.fillRect(X(st), 0, Math.max(2, X(Math.min(end, t1)) - X(st)), h);
    c.fillStyle = '#4cd18a'; c.fillRect(X(st) - 1, 0, 2, h);
    c.font = '700 10px -apple-system,system-ui'; c.fillText('START', X(st) + 3, TL.ticks);
  }
  // route ETAs
  for (const [id, r] of Object.entries(state.routes)) {
    if (!r.ok || settings.mode !== 'race') continue;
    c.fillStyle = mcol(id);
    c.fillRect(X(r.startTime), TL.strip - 2, Math.max(2, X(r.eta) - X(r.startTime)), 2);
    c.beginPath(); c.arc(X(r.eta), TL.strip - 1, 3, 0, 7); c.fill();
  }
  // now marker + cursor
  const now = Date.now();
  if (now > t0 && now < t1) { c.fillStyle = '#ffb547'; c.fillRect(X(now) - 0.5, TL.bars, 1.5, TL.strip + TL.stripH - TL.bars + 2); }
  const x = X(state.time);
  c.fillStyle = '#fff'; c.beginPath(); c.moveTo(x - 6, h - 2); c.lineTo(x + 6, h - 2); c.lineTo(x, TL.strip + TL.stripH); c.fill();
  c.fillRect(x - 1, TL.bars, 2, TL.strip + TL.stripH - TL.bars);
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
  const ended = !!(state.wind && state.time > state.wind.validUntil + 30 * 60000);
  const notYet = !!(state.wind && state.wind.strictTime && state.time < state.wind.times[0] - 30 * 60000);
  $('#tlInfo').textContent = `${m ? m.name : ''}${run ? ' run ' + fmtRun(run.runInit) : ''} · ${relTxt}${ended ? ' · IZVAN dosega modela' : ''}`;
  // the wind picture first and on its own: whatever else fails below, the map shows the wind of this moment
  try { wxLayer.draw(); } catch (e) { noteErr(e); }
  showEnded(ended, m, notYet);
  drawTimeline();
  updateBoats();
  updatePointCard();
}
// past the end of the chosen model: its last state stays on the map, dimmed, with a clear note (never mistaken for a forecast)
function showEnded(ended, m, notYet = false) {
  const cw = state.wind && state.wind.strictTime, off = ended || notYet;
  document.body.classList.toggle('wx-ended', off);
  const n = $('#endNote');
  if (n) { n.classList.toggle('hidden', !off);
    if (off) n.innerHTML = cw ? `⏸ <b>${m ? m.name : 'ClockW'}</b> vrijedi ${fmtTime(state.wind.times[0])} → ${fmtTime(state.wind.validUntil)} – za ovo vrijeme nema ClockW (odaberi drugi model ili pomakni vrijeme)`
      : `⏸ <b>${m ? m.name : 'Model'}</b>: prognoza završava ${fmtTime(state.wind.validUntil)} – prikazano zadnje stanje`; }
  const s = state.set; if (!s) return;
  $$('#modelChips .chip').forEach(b => { const f = s.fields[b.dataset.model]; b.classList.toggle('ended', !!f && state.time > (f.validUntil || 0) + 30 * 60000); });
}
$('#tlSlider').addEventListener('input', e => setTime(state.set.times[0] + e.target.value * STEP, true));
$('#btnPrev').onclick = () => setTime(state.time - 3600000);
$('#btnNext').onclick = () => setTime(state.time + 3600000);
$('#btnNow').onclick = () => setTime(Math.round(Date.now() / STEP) * STEP);
let playing = null;
const setPlayIcon = on => $('#playIcon').setAttribute('d', on ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M7 5v14l12-7z');
$('#btnPlay').onclick = () => {
  // with calculated routes on screen the big ▶ plays the RACE at the chosen replay speed (s/s) – never the fast
  // forecast animation, which would make the boats fly through the course in seconds
  if (settings.mode === 'race' && okRoutes().length) {
    if (playing) { clearInterval(playing); playing = null; }
    rp.on ? replayPause() : replayPlay(); return;
  }
  if (playing) { clearInterval(playing); playing = null; setPlayIcon(false); return; }
  $('#playIcon').setAttribute('d', 'M7 5h4v14H7zM13 5h4v14h-4z');
  playing = setInterval(() => {
    const s = state.set; if (!s) return;
    let t = state.time + PLAY_STEP;   // always the same speed, however long the forecast is (like Windy)
    if (t > s.times[s.times.length - 1]) t = s.times[0];
    setTime(t);
  }, 160);
};
addEventListener('resize', drawTimeline);

// ---------------- layers ui ----------------
function redraw() { setTime(state.time); renderLegend(); particleLayer.seed(); }
$$('#layerbar [data-layer]').forEach(b => b.onclick = () => {
  if (b.dataset.layer === 'conf') {   // confidence exists only for our ClockW forecast
    const cws = cwIds(state.set);
    if (!cws.length) { toast('Pouzdanost postoji za ClockW prognozu – izradi je u kartici Prognoza (✦ ClockW)', 4500); return; }
    if (!isClockW(state.modelId)) { const id = cws[cws.length - 1]; state.modelId = id; state.wind = withFallback(state.set, id); renderChips(); }
  }
  state.layer = settings.layer = b.dataset.layer; saveSettings();
  $$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x === b));
  redraw();
});
$$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x.dataset.layer === state.layer));
// iPhone: layer bar out of the way until called (handle at the right edge); the layout follows the timeline height
$('#lbHandle').onclick = e => { e.stopPropagation(); document.body.classList.toggle('lb-open'); };
const syncPhoneLayout = () => { const t = $('#timeline'); if (t) document.documentElement.style.setProperty('--tlh', Math.round(t.getBoundingClientRect().height) + 'px'); };
addEventListener('resize', syncPhoneLayout); setTimeout(syncPhoneLayout, 0); setTimeout(syncPhoneLayout, 800);
const syncToggles = () => {
  $('#tglParticles').classList.toggle('on', state.particles);
  $('#tglArrows').classList.toggle('on', state.arrows !== 'none');
  $('#arrowsLbl').textContent = state.arrows === 'barbs' ? 'Perca' : 'Strelice';
  $('#tglNumbers').classList.toggle('on', state.showNumbers);
  $('#ovWaves').classList.toggle('on', !!state.ovWaves);
  $('#ovCurrents').classList.toggle('on', !!state.ovCurrents);
  $('#ovRain').classList.toggle('on', !!state.ovRain);
  $('#ovDepth').classList.toggle('on', !!state.ovDepth);
  $('#ovIsobars').classList.toggle('on', !!state.ovIsobars);
  $('#ovObs').classList.toggle('on', !!state.ovObs);
  $('#tglColors').classList.toggle('on', state.colors !== false);
};
if (settings.ovDepth === undefined) settings.ovDepth = true; // depths visible by default
[['#ovWaves', 'ovWaves'], ['#ovCurrents', 'ovCurrents'], ['#ovRain', 'ovRain'], ['#ovDepth', 'ovDepth'], ['#ovIsobars', 'ovIsobars']].forEach(([id, k]) => {
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
    const html = kind === 'm' ? BUOY(i + 1) + (m.side ? `<div class="sidetag ${m.side}">${m.side === 'S' ? 'D' : 'L'}</div>` : '') : FLAG(kind);
    const icon = L.divIcon({ className: 'mark-ic', html, iconSize: [30, 38], iconAnchor: kind === 'm' ? [15, 36] : [9, 37] });
    const mk = L.marker([m.lat, m.lon], { draggable: true, autoPan: true, icon, title: m.name, zIndexOffset: 1000 }).addTo(markLayer);
    mk.on('drag', e => { const ll = e.target.getLatLng(); m.lat = +ll.lat.toFixed(5); m.lon = +ll.lng.toFixed(5); courseLine.setLatLngs(course.marks.map(q => [q.lat, q.lon])); });
    mk.on('dragend', () => { saveCourse(); drawCourse(); if (!$('#tab-course').classList.contains('hidden')) renderCourseTab(); });
    mk.bindTooltip(`<b>${i + 1}.</b> ${m.name}${m.side ? ` · ${m.side === 'S' ? 'desnim' : 'lijevim'} bokom` : ''}<br><small>povuci za pomicanje</small>`, { direction: 'top', offset: [0, -34] });
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
  if (m === 'race') { routeLayer.addTo(map); updateBoats(); setTimeout(() => maybeFillWindow(300), 500); } else { replayPause(); if (boatPopup) map.closePopup(boatPopup); routeLayer.remove(); }
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
  cancelAreaPick();   // never leave a half-done "Odaberi na karti" waiting for the second corner
  if (['course', 'routing', 'compare'].includes(tab) && settings.mode !== 'race') setMode('race');
  $('#sheet').classList.remove('hidden');
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tabbody').forEach(b => b.classList.toggle('on', b.id === 'tab-' + tab));
  ({ course: renderCourseTab, routing: renderRoutingTab, compare: renderCompareTab, analysis: renderAnalysisTab, data: renderDataTab, settings: renderSettingsTab })[tab]();
}
$$('.tabs [data-tab]').forEach(b => b.onclick = () => openSheet(b.dataset.tab));
$('#sheetClose').onclick = () => { $('#sheet').classList.add('hidden'); setEditing(false); };
$('#btnMenu').onclick = () => $('#sheet').classList.contains('hidden') ? openSheet('data') : $('#sheet').classList.add('hidden');
$('#fabCourse').onclick = () => openSheet('course');
$('#modePill').onclick = () => { if (settings.mode === 'race') { setMode('forecast'); toast('Samo prognoza – bove i rute skrivene (staza je sačuvana)'); } else { setMode('race'); zoomCourse(); openSheet('course'); } };
$('#fabRoute').onclick = () => openSheet(Object.keys(state.routes).length ? 'compare' : 'routing');
$('#btnRefresh').onclick = () => openSheet('data');

function cancelAreaPick() {
  if (!pick) return;
  map.off('mousemove', pickPreview); [pick.rect, pick.mk].forEach(x => x && map.removeLayer(x)); pick = null;
}
function setEditing(on) {
  if (on) cancelAreaPick();   // a half-done "Odaberi na karti" must never swallow the taps meant for new marks
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
    <ul class="marks">${course.marks.map((m, i) => { const n = course.marks.length, mid = i > 0 && i < n - 1; return `
      <li><span class="n ${i === 0 ? 's' : i === n - 1 ? 'f' : ''}" title="${i === 0 ? 'Start' : i === n - 1 ? 'Cilj' : 'Redni broj obilaska'}">${i + 1}</span>
        <div class="editrow mini"><span class="pen">✏️</span><input value="${esc(m.name)}" data-i="${i}" class="mname editable" title="Promijeni ime oznake"></div>
        ${mid ? `<select data-ord="${i}" title="Redni broj – ostale oznake se prenumeriraju">${Array.from({ length: n - 2 }, (_, k) => `<option value="${k + 1}" ${k + 1 === i ? 'selected' : ''}>${k + 2}.</option>`).join('')}</select>
        <select data-side="${i}" title="Kojim bokom se oznaka obilazi"><option value="">bilo kojim</option><option value="S" ${m.side === 'S' ? 'selected' : ''}>desnim bokom</option><option value="P" ${m.side === 'P' ? 'selected' : ''}>lijevim bokom</option></select>` : `<span class="ll">${i === 0 ? 'start' : 'cilj'} · ${fmtLatLon(m.lat, m.lon)}</span>`}
        ${mid ? `<button data-del="${i}" title="Obriši">✕</button>` : ''}</li>`; }).join('')}
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
  // new order number: the mark moves there, the others are renumbered (start stays 1, the finish stays last)
  el.querySelectorAll('[data-ord]').forEach(sel => sel.onchange = () => { const from = +sel.dataset.ord, to = +sel.value; const [mk] = course.marks.splice(from, 1); course.marks.splice(to, 0, mk); saveCourse(); drawCourse(); renderCourseTab(); toast(`${mk.name} je sada ${to + 1}. oznaka`); });
  el.querySelectorAll('[data-side]').forEach(sel => sel.onchange = () => { const m = course.marks[+sel.dataset.side]; if (sel.value) m.side = sel.value; else delete m.side; saveCourse(); drawCourse(); });
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
  if (isPhone() && document.body.classList.contains('lb-open')) { document.body.classList.remove('lb-open'); return; }   // a tap on the map closes the layer bar
  if (pick) { areaPickClick(e.latlng); return; }
  if (state.editing) {
    const m = { name: `Oznaka ${course.marks.length}`, lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5) };
    if (course.marks.length < 2) {   // own course: first tap = start, second = finish
      course.marks.push(m);
      if (course.marks.length === 1) m.name = 'Start'; else if (!course.regattaId) m.name = 'Cilj';
      saveCourse(); drawCourse(); renderCourseTab(); return;
    }
    openMarkDialog(m);
    return;
  }
  showPoint(e.latlng.lat, e.latlng.lng);
});

// new mark between start and finish: name, order number (2 … before the finish) and rounding side
function openMarkDialog(m) {
  const n = course.marks.length, box = $('#markDlg') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'markDlg', className: 'glass' }));
  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const tmp = L.circleMarker([m.lat, m.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#ff8a1d', fillOpacity: 1 }).addTo(map);
  box.innerHTML = `<b>Nova oznaka</b> <small>${fmtLatLon(m.lat, m.lon)}</small>${state.landAt && state.landAt(m.lat, m.lon) ? '<div class="note warn" style="margin:6px 0 0">Točka je na kopnu/hridi – ruta će je obići na sigurnoj udaljenosti.</div>' : ''}
    <div class="row"><label>Ime</label><input id="mdName" class="field" value="${esc(m.name)}"></div>
    <div class="row"><label>Redni broj</label><select id="mdOrd">${Array.from({ length: n - 1 }, (_, k) => `<option value="${k + 1}" ${k + 1 === n - 1 ? 'selected' : ''}>${k + 2}.${k + 2 === n ? ' (prije cilja)' : ''}</option>`).join('')}</select></div>
    <div class="row"><label>Obilazak</label><select id="mdSide"><option value="">bilo kojim bokom</option><option value="S">desnim bokom</option><option value="P">lijevim bokom</option></select></div>
    <div class="note" style="margin:4px 0 8px">Start je 1. Oznake od odabranog broja nadalje pomaknu se za jedan; cilj ostaje zadnji.</div>
    <div class="row" style="gap:8px"><button id="mdCancel" class="btn" style="flex:1">Odustani</button><button id="mdOk" class="btn primary" style="flex:1">Dodaj</button></div>`;
  box.classList.remove('hidden');
  const close = () => { box.classList.add('hidden'); map.removeLayer(tmp); };
  box.querySelector('#mdCancel').onclick = close;
  box.querySelector('#mdOk').onclick = () => {
    m.name = box.querySelector('#mdName').value.trim() || m.name;
    const side = box.querySelector('#mdSide').value; if (side) m.side = side;
    const at = +box.querySelector('#mdOrd').value;
    course.marks.splice(at, 0, m);
    close(); saveCourse(); drawCourse(); renderCourseTab();
    toast(`${m.name} dodana kao ${at + 1}. oznaka`);
  };
  setTimeout(() => box.querySelector('#mdName').select(), 50);
}

// rounding side for routing: the target is moved ~0.2 nm off the mark, so the route leaves the mark on the chosen side
function marksForRouting(marks) {
  return marks.map((m, i) => {
    if (!m.side || i === 0 || i === marks.length - 1) return m;
    const a = marks[i - 1], b = marks[i + 1], D = Math.PI / 180;
    const bin = bearing(a.lat, a.lon, m.lat, m.lon), bout = bearing(m.lat, m.lon, b.lat, b.lon);
    const side = m.side === 'S' ? -90 : 90;   // mark to starboard → the boat passes on its port (left) side
    let x = Math.sin((bin + side) * D) + Math.sin((bout + side) * D), y = Math.cos((bin + side) * D) + Math.cos((bout + side) * D);
    if (Math.hypot(x, y) < 0.5) { x = Math.sin(bin * D); y = Math.cos(bin * D); }   // a full turn around the mark: go past it
    const dir = Math.atan2(x, y) / D, nm = 0.2, k = Math.cos(m.lat * D);
    return { ...m, lat: m.lat + nm * Math.cos(dir * D) / 60, lon: m.lon + nm * Math.sin(dir * D) / (60 * k) };
  });
}

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
    const cf = isClockW(id) ? sample(s.fields[id], ['conf'], point.lat, point.lon, state.time, [])[0] : NaN;
    return `<tr style="${id === state.modelId ? 'background:rgba(255,255,255,.06)' : ''}"><td><span class="dot" style="background:${mcol(m.id)}"></span>${isClockW(id) ? '✦ ' : ''}${m.name}${cf === cf ? ` <small class="cfb" style="color:${cf >= 70 ? '#4cd18a' : cf >= 45 ? '#f2cf35' : '#ff6b6b'}">${Math.round(cf)}%</small>` : ''}</td>
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
  return { t0, t1: t0 + fcDays() * 24 * H1, estHours: 0 };
}
// ---- long range (days 4–15) ----
// Forecast mode downloads in two parts: the first 3 days in full detail (every model), then – while you already
// look at the map – days 4–15 for the models that reach that far, light (3-hourly, coarse grid, from Open-Meteo:
// a few MB instead of ~100 MB of global ECMWF files). Each model's long part is attached to it as `ext`.
const fcDays = () => settings.fcDays || 15;
const SHORT_DAYS = 3;
const LONG_OM = { dir_ecmwf: 'ecmwf_ifs', dir_gfs: 'gfs_seamless', dir_icon_eu: 'icon_eu', ecmwf_ifs: 'ecmwf_ifs', gfs_seamless: 'gfs_seamless',
  ecmwf_aifs025_single: 'ecmwf_aifs025_single', ukmo_global_deterministic_10km: 'ukmo_global_deterministic_10km', icon_eu: 'icon_eu' };
const LONG_PTS = 120;   // grid points per model for days 4–15 (Open-Meteo counts every point; ~0.5° is plenty that far ahead)
const ownEnd = f => f.times[f.times.length - 1];
const noExt = g => { if (!g || !g.ext) return g; const { ext: _e, ...r } = g; return r; };
// continue model field f with g (only if g really reaches further); at most two links, so chains never grow
function attachExt(f, g) {
  if (!f || !g || !g.times || !g.times.length) return false;
  const end = lastTime(g);
  if (end <= ownEnd(f) + 3 * H1) return false;
  f.ext = g.ext ? { ...g, ext: noExt(g.ext) } : g;
  f.validUntil = Math.max(end, Math.min(f.validUntil || 0, ownEnd(f)));
  return true;
}
// a new (shorter) field of a model keeps what the previous one had further ahead
function carryLong(nf, of) {
  if (!nf || !of || nf.ext) return false;
  const c = ownEnd(of) > ownEnd(nf) + 3 * H1 ? of : of.ext;
  return attachExt(nf, c);
}
// the set's timeline reaches as far as its longest model
function extendTimes(set) {
  if (!set || !set.times || !set.times.length) return;
  let end = set.times[set.times.length - 1];
  for (const id of set.models) { const f = set.fields[id]; if (f && f.times) end = Math.max(end, lastTime(f)); }
  if (end <= set.times[set.times.length - 1]) return;
  const T = set.times.slice(); for (let t = T[T.length - 1] + H1; t <= end; t += H1) T.push(t);
  set.times = T;
}
// does the window already have long-range data (5 days ahead) everywhere?
function longCovered(set) {
  if (!set || !set.models) return false;
  const t = Date.now() + 5 * 24 * H1;
  const ids = set.models.filter(id => !isDerived(id) && set.fields[id] && set.fields[id].times && lastTime(set.fields[id]) > t);
  if (!ids.length) return false;
  const w = withFallback(set, ids[0]), v = map.getBounds(), out = [];
  for (let j = 0; j <= 6; j++) for (let i = 0; i <= 8; i++) {
    sample(w, ['u'], v.getSouth() + (v.getNorth() - v.getSouth()) * j / 6, v.getWest() + (v.getEast() - v.getWest()) * i / 8, t, out);
    if (out[0] !== out[0]) return false;
  }
  return true;
}
let lastGribFail = 0, longBusy = false, pendingLong = null;
function runLong(set, area, t0, t1, manual, bar, txt) {
  longBusy = true;
  const shell = { models: set.models.slice(), errors: [], fields: Object.fromEntries(set.models.filter(id => set.fields[id] && set.fields[id].times).map(id => [id, { times: set.fields[id].times, validUntil: set.fields[id].validUntil }])) };
  shell.models = Object.keys(shell.fields);
  if (manual) txt.textContent = `Dugoročna prognoza (do ${fcDays()} dana)…`;
  (async () => {
    try {
      const n = await fetchLong(shell, area, t0, t1, manual, (f, t) => { if (!manual) return; if (f != null) bar.style.width = (f * 100).toFixed(0) + '%'; if (t) txt.textContent = 'Dugoročno · ' + t; });
      const cur = state.set; if (!cur) return;
      let k = 0;
      for (const id of shell.models) { const e = shell.fields[id].ext, f = cur.fields[id]; if (e && f && (!f.ext || lastTime(e) >= lastTime(f) - H1) && attachExt(f, e)) k++; }
      if (k) { cur.longTried = Date.now(); extendTimes(cur); await saveForecast(cur); const kt = state.time; useSet(cur, { keepView: true }); setTime(kt); if (manual) txt.textContent = `Gotovo: prognoza do ${fcDays()} dana.`; }
      else { cur.errors = [...(cur.errors || []), ...shell.errors]; if (manual) toast('Dugoročna prognoza (dani 4–15) trenutno nije dostupna – prva 3 dana su preuzeta', 5000); }
    } catch (e) { console.warn('long', e); }
    finally {
      longBusy = false;
      const p = pendingLong; pendingLong = null;
      if (p && state.set && (p[3] || !longCovered(state.set))) runLong(state.set, ...p);
    }
  })();
}
async function fetchLong(set, area, t0, t1, allowGrib, progress) {
  const pairs = set.models.filter(id => LONG_OM[id]).map(id => [id, LONG_OM[id]]);
  if (!pairs.length) return 0;
  const tS = Math.floor((t0 + SHORT_DAYS * 24 * H1 - 6 * H1) / (3 * H1)) * 3 * H1;   // overlaps the detailed part a little
  let n = 0, err = null;
  try {
    const res = await downloadForecast({ bbox: area, modelIds: [...new Set(pairs.map(p => p[1]))], window: { t0: tS, t1 }, quality: 'standard', settings,
      signal: dlAbort && dlAbort.signal, hourStep: 3, gridCap: LONG_PTS, marine: false, progress });
    for (const [id, om] of pairs) if (res.fields[om] && attachExt(set.fields[id], noExt(res.fields[om]))) n++;
  } catch (e) { if (e.name === 'AbortError') throw e; err = e; }
  // Mac: the official GRIB files as reserve when Open-Meteo cannot deliver (e.g. its daily limit)
  const dir = pairs.map(p => p[0]).filter(id => /^dir_(ecmwf|gfs|icon_eu)$/.test(id) && !set.fields[id].ext && directUsable(id, state.native));   // each one Open-Meteo did not deliver
  // Mac: when Open-Meteo cannot deliver (its daily limit, outage), the official GRIBs – automatically too, but at most every
  // 30 min and for a wide area (ECMWF 12-hourly past day 6, ~50 MB; GFS cut to the area on NOAA's side), so pans stay covered
  if (state.native && dir.length && allowGrib) {   // ~50 MB: only when you press Preuzmi – never competes with filling the map
    const wide = { s: Math.max(-80, Math.min(area.s, ADRIATIC.s) - 3), n: Math.min(80, Math.max(area.n, ADRIATIC.n) + 3), w: Math.min(area.w, ADRIATIC.w) - 4, e: Math.max(area.e, ADRIATIC.e) + 4 };
    try {
      const d = await downloadDirect({ bbox: wide, modelIds: dir, window: { t0: tS, t1 }, settings, signal: dlAbort && dlAbort.signal, maxSeconds: 240, quick: true, globalOnly: !dir.includes('dir_icon_eu'), marine: false, maxPts: 40000, far: 12, progress });
      for (const id of dir) if (d.fields[id] && attachExt(set.fields[id], d.fields[id])) n++;
      if (!dir.some(id => set.fields[id].ext)) lastGribFail = Date.now();
    } catch (e) { if (e.name === 'AbortError') throw e; err = err || e; lastGribFail = Date.now(); }
  }
  if (n) extendTimes(set);
  else set.errors = [...(set.errors || []), 'Dugoročna prognoza (dani 4–15) trenutno nije dostupna' + (err ? ': ' + (err.daily ? 'Open-Meteo dnevni limit' : err.message) : '')];
  return n;
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
  const hrs = Math.max(1, Math.round((Math.min(win.t1, fcMode() ? win.t0 + SHORT_DAYS * 24 * H1 : win.t1) - win.t0) / 3600000));   // detailed part (days 4–15 come light, from Open-Meteo)
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
    <div class="row"><label>Dana unaprijed</label><select id="fcDays">${[[15, '15 – do kraja prognoze'], [10, '10'], [7, '7'], [5, '5'], [3, '3 – štedi mobilne podatke']].map(([v, l]) => `<option value="${v}" ${fcDays() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="note">Prva 3 dana stižu u punoj rezoluciji za sve modele. Zatim se u pozadini dopuni ostatak (do 15 dana) za modele koji idu toliko daleko – ECMWF i GFS 15 dana, UKMO ~6, ICON-EU 5, ARPEGE 4 – svakih 3 h, svega nekoliko MB. Visoko-rezolucijski modeli (ICON-2I, ICON-D2, HARMONIE) pokrivaju 2–3 dana. Iza 5 dana prognoza je <b>trend</b> (na vremenskoj crti iscrtkano).</div>` : `
    <div class="row"><label>Start regate</label><b>${fmtTime(st)}</b><button class="mini" id="dlChgStart">promijeni</button></div>
    ${AREA_UI()}
    <div class="row"><label>Prozor prognoze</label><span>${fmtTime(win.t0)} → ${fmtTime(win.t1)}</span></div>
    <div class="note">Prozor se automatski računa od starta i procijenjenog trajanja (${fmtDur(win.estHours)} za ${courseLength().toFixed(0)} nm) uz rezervu. Svi modeli se preuzimaju za isti, satni vremenski raspon.</div>`}
    ${s ? `<h3>Trenutna prognoza</h3>
      <div class="note">Preuzeto ${fmtTime(s.created)} · kvaliteta ${QUALITY[s.quality] ? QUALITY[s.quality].name : '–'}</div>
      <canvas class="chart" id="covChart" style="height:${28 + s.models.length * 22}px"></canvas>
      <div class="note">Traka = razdoblje koje model pokriva (svjetliji dio = dugoročno, svakih 3–6 h); zelena zona = regata. ● uz ime = dostupan je noviji run.</div>
      ${s.errors && s.errors.length ? `<div class="note warn">${s.errors.join('<br>')}</div>` : ''}
      ${state.cloudError && settings.source === 'cloud' ? `<div class="note warn">Zadnji pokušaj paketa iz oblaka nije uspio: ${state.cloudError}. Stisni ⬇︎ Preuzmi paket iz oblaka za ponovni pokušaj.</div>` : ''}
      ${s.empty && s.empty.length ? `<div class="note warn">Model ne pokriva ovo područje: ${s.empty.map(id => modelById(id).name).join(', ')}</div>` : ''}
      <button id="btnCheckRuns" class="btn block">Provjeri nove runove modela</button>
      <button id="btnPackage" class="btn block">📲 Spremi paket za iPhone (AirDrop)</button>
      ${state.newRuns.length ? `<button id="btnRefreshNew" class="btn primary block">Osvježi samo nove runove: ${state.newRuns.map(n => modelById(n.id).name).join(', ')}</button>
      <div class="note">Preuzimaju se samo modeli s novim runom, isto područje i vrijeme. Štedi API pozive.</div>` : ''}` : '<div class="note">Još nema preuzete prognoze.</div>'}
    ${s ? clockwHtml() : ''}
    <h3>Izvor podataka</h3>
    <div class="seg"><button data-src="direct" class="${direct ? 'on' : ''}">📥 GRIB izravno</button><button data-src="cloud" class="${cloud ? 'on' : ''}">☁️ Paket iz oblaka</button><button data-src="openmeteo" class="${!direct && !cloud ? 'on' : ''}">📡 Open-Meteo</button></div>
    <div class="note">${direct ? `Originalne GRIB datoteke izravno od službenih meteoroloških centara (ECMWF, NOAA${state.native ? ', DWD' : ''}), <b>bez API limita</b>, samo kad klikneš Preuzmi.${state.native ? '' : ' DWD modeli (ICON-D2/EU) rade samo u Mac aplikaciji.'}`
      : cloud ? '<b>Bez API limita.</b> Gotov paket za cijeli Jadran (ALADIN-HR, ICON-2I, ICON-D2, ICON-EU, ARPEGE, ECMWF, GFS, valovi i struje) – ECMWF i GFS do 15 dana unaprijed – koji se sam osvježava svaka 3 sata s najnovijim runom svakog modela. Biraš koje modele preuzimaš.'
      : 'Open-Meteo: 9 modela uključujući ICON-2I i HARMONIE; besplatno s dnevnim limitom po internetskoj vezi. Ako limit istekne, aplikacija se sama prebaci na paket iz oblaka.'}</div>
    <h3>Rezolucija</h3>
    <div class="row"><label>Kvaliteta</label><select id="quality">${Object.entries(QUALITY).map(([k, q]) => `<option value="${k}" ${settings.quality === k ? 'selected' : ''}>${q.name}</option>`).join('')}</select></div>
    ${cloud ? `<h3>Modeli iz oblaka</h3>${CLOUD_MODELS.map(m => `<label class="check"><input type="checkbox" data-cm="${m.id}" ${!settings.cloudModels || settings.cloudModels.includes(m.id) ? 'checked' : ''}>
      <div><div class="t"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} <small style="color:var(--muted)">${m.res}</small></div><div class="d">${m.note}</div></div></label>`).join('')}
    <div class="note">Preuzimaju se samo označeni modeli (valovi i struje uvijek). Područje je cijeli Jadran; ECMWF i GFS pokrivaju i Mediteran. Promjena vrijedi od sljedećeg preuzimanja.</div>` : direct ? `<h3>Modeli (izravno s izvora)</h3>${dirList}
    <div class="note">Procjena: ~${Math.round(mb)} MB preuzimanja za prvih ${hrs} h (izrezuje se samo odabrano područje, na disk ide nekoliko MB)${fcMode() && fcDays() > SHORT_DAYS ? ` + dani 4–${fcDays()} preko Open-Meteo, ~1–3 MB` : ''}. Za ICON-2I i HARMONIE prebaci na Open-Meteo.</div>` : `<h3>Besplatni modeli (Open-Meteo)</h3>${free}`}
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
  el.querySelectorAll('[data-cm]').forEach(i => i.onchange = () => { const on = [...el.querySelectorAll('[data-cm]:checked')].map(x => x.dataset.cm); if (!on.length) { i.checked = true; return toast('Barem jedan model mora ostati odabran'); } settings.cloudModels = on.length === CLOUD_MODELS.length ? null : on; saveSettings(); });
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
  bindClockW(el);
}
// ---------------- ClockW: our consensus forecast (built on request) ----------------
const cwCandidates = () => state.set ? state.set.models.filter(id => !isDerived(id) && state.set.fields[id] && state.set.fields[id].times) : [];
const cwHours = () => settings.cwHours === 48 ? 48 : 24;
const cwSelected = () => { const c = cwCandidates(); return (Array.isArray(settings.cwModels) ? settings.cwModels.filter(id => c.includes(id)) : c); };
// forecast: from now · regatta: from an hour before the start (if it is still ahead)
// ClockW always covers the next 24 or 48 hours FROM NOW – the hours in which the models are most accurate (also in race mode)
function cwStart() { return Math.floor(Date.now() / H1) * H1; }
let cwBusy = false;
// all ClockW forecasts of a set, in creation order (ClockW1, ClockW2, …)
function cwIds(set) { return set && set.models ? set.models.filter(id => isClockW(id) && set.fields[id]) : []; }
// lowest free number, so names stay short (ClockW1 deleted → the next one is ClockW1 again)
function cwNextNumber(set) { const used = new Set(cwIds(set).map(id => +id.replace('clockw', '') || 1)); let n = 1; while (used.has(n)) n++; return n; }
function clockwHtml() {
  const s = state.set, cand = cwCandidates(), sel = cwSelected(), list = cwIds(s);
  const win = cand.length ? clockwWindow(s, sel.length ? sel : cand, cwStart(), cwHours()) : null;
  const cards = list.map(id => {
    const f = s.fields[id], info = f.clockw || {}, m = modelById(id);
    const share = info.share ? Object.entries(info.share).sort((a, b) => b[1] - a[1]) : [];
    return `<div class="cwinfo" style="border-color:${mcol(id)}88"><b><span class="dot" style="background:${mcol(id)}"></span>✦ ${m.name}</b> · izrađena ${fmtTime(info.built || f.run.runInit)} · vrijedi ${fmtTime(f.times[0])} → ${fmtTime(f.validUntil)}${info.meanConf != null ? ` · pouzdanost <b>${Math.round(info.meanConf)} %</b>` : ''}
      <div class="note" style="margin:4px 0 2px">Modeli: <b>${(info.models || []).map(x => modelById(x).name).join(', ')}</b></div>
      <div class="cwshare">${share.map(([mid, v]) => `<div><span><span class="dot" style="background:${mcol(mid)}"></span>${modelById(mid).name}</span><i style="width:${Math.max(2, v * 100).toFixed(0)}%;background:${mcol(mid)}"></i><em>${Math.round(v * 100)} %</em></div>`).join('')}</div>
      <div class="row" style="gap:6px;margin-top:8px"><button class="btn" data-cwshow="${id}" style="flex:1">Prikaži</button><button class="btn" data-cwconf="${id}" style="flex:1">★ Pouzdanost</button><button class="btn danger" data-cwdel="${id}" style="flex:1">Obriši</button></div></div>`;
  }).join('');
  return `<h3>✦ ClockW – naša prognoza</h3>
    <div class="note">Na zahtjev, od modela koje odabereš, aplikacija izrađuje <b>najvjerojatniju prognozu</b>: gdje se modeli slažu po smjeru i jačini, modeli koji odskaču gube težinu, a <b>uz obalu i otoke prednost imaju modeli visoke rezolucije</b> (ICON-2I, ICON-D2, HARMONIE). Svaka izrada dodaje novi tab gore (<b>ClockW1, ClockW2…</b>) uz ostale modele; ostaje dok joj ne istekne vrijeme ili je ne obrišeš. U Routingu je biraš kao i svaki drugi model.</div>
    ${cards ? `<div class="row"><label>Izrađene ClockW prognoze</label></div>${cards}` : ''}
    ${cand.length < 2 ? '<div class="note warn">Za ClockW trebaju barem dva modela u prognozi – preuzmi prognozu s više modela.</div>' : `
    <div class="row"><label>Nova ClockW – modeli</label></div>
    ${cand.map(id => { const m = modelById(id); return `<label class="check"><input type="checkbox" data-cw="${id}" ${sel.includes(id) ? 'checked' : ''}><div><div class="t"><span class="dot" style="background:${mcol(id)}"></span>${m.name} <small style="color:var(--muted)">${m.res || ''}</small></div></div></label>`; }).join('')}
    <div class="row"><label>Razdoblje</label></div>
    <div class="seg"><button data-cwh="24" class="${cwHours() === 24 ? 'on' : ''}">24 sata</button><button data-cwh="48" class="${cwHours() === 48 ? 'on' : ''}">48 sati</button></div>
    ${win ? `<div class="note">${fmtTime(win.t0)} → ${fmtTime(win.t1)} (od sada)${win.short ? ` · <b>odabrani modeli ne sežu punih ${cwHours()} h</b> – ClockW ide dokle sežu barem dva modela` : ''}</div>` : ''}
    <button id="btnClockW" class="btn primary block" ${sel.length < 2 || cwBusy ? 'disabled' : ''}>✦ Izradi ClockW${cwNextNumber(s)} (${sel.length} modela · ${cwHours()} h)</button>
    <div class="progress"><div id="cwBar"></div></div><div id="cwText" class="note"></div>`}`;
}
function bindClockW(el) {
  el.querySelectorAll('[data-cw]').forEach(i => i.onchange = () => { settings.cwModels = [...el.querySelectorAll('[data-cw]:checked')].map(x => x.dataset.cw); saveSettings(); renderDataTab(); });
  el.querySelectorAll('[data-cwh]').forEach(b => b.onclick = () => { settings.cwHours = +b.dataset.cwh; saveSettings(); renderDataTab(); });
  const go = el.querySelector('#btnClockW'); if (go) go.onclick = doClockW;
  el.querySelectorAll('[data-cwshow]').forEach(b => b.onclick = () => { if (state.layer === 'conf') { state.layer = settings.layer = 'wind'; saveSettings(); $$('#layerbar [data-layer]').forEach(x => x.classList.toggle('on', x.dataset.layer === 'wind')); } selectModel(b.dataset.cwshow); renderLegend(); toast(`Prikazana ${modelById(b.dataset.cwshow).name}`); });
  el.querySelectorAll('[data-cwconf]').forEach(b => b.onclick = () => { selectModel(b.dataset.cwconf); $('#layerbar [data-layer=conf]').click(); });
  el.querySelectorAll('[data-cwdel]').forEach(b => armDelete(b, `${modelById(b.dataset.cwdel).name} je obrisana`, async () => { await removeClockW(b.dataset.cwdel); renderDataTab(); }));
}
async function removeClockW(id, save = true) {
  const s = state.set; if (!s || !s.fields[id]) return;
  delete s.fields[id]; s.models = s.models.filter(x => x !== id);
  if (state.routes[id]) { delete state.routes[id]; drawRoutes(); }
  if (state.routeModels) state.routeModels = state.routeModels.filter(x => x !== id);
  if (state.modelId === id) state.modelId = null;
  if (save) await saveForecast(s);
  useSet(s);
}
// a ClockW whose last hour has passed is removed by itself
function pruneClockW(set) {
  if (!set) return false; let k = 0;
  for (const id of cwIds(set)) if ((set.fields[id].validUntil || 0) < Date.now() - H1) { delete set.fields[id]; set.models = set.models.filter(x => x !== id); if (state.modelId === id) state.modelId = null; k++; }
  return k > 0;
}
// ClockW forecasts survive a new forecast download (manual or automatic) – they stay until expiry or deletion
function keepClockW(nw, old) {
  if (!nw || !old || nw === old) return;
  for (const id of cwIds(old)) if (!nw.fields[id] && (old.fields[id].validUntil || 0) >= Date.now() - H1) { nw.fields[id] = old.fields[id]; nw.models.push(id); }
}
async function doClockW() {
  const s = state.set; if (!s || cwBusy) return;
  const ids = cwSelected(); if (ids.length < 2) return toast('Odaberi barem dva modela za ClockW');
  cwBusy = true;
  const btn = $('#btnClockW'); if (btn) btn.disabled = true;
  const prog = (f, t) => { const b = $('#cwBar'), x = $('#cwText'); if (b && f != null) b.style.width = (f * 100).toFixed(0) + '%'; if (x && t) x.textContent = t; };
  try {
    const t0 = performance.now(), n = cwNextNumber(s);
    const f = await buildClockW({ set: s, ids, num: n, t0: cwStart(), hours: cwHours(), landAt: state.landAt, progress: prog });
    const cur = state.set; if (!cur) return;
    keepClockW(cur, s);                                   // a refill during the build: keep the others
    const id = f.meta.id;
    cur.fields[id] = f; cur.models = [...cur.models.filter(x => x !== id), id];   // its own tab, after all the others
    registerModel(f.meta);
    await saveForecast(cur);
    useSet(cur);                                          // the model you were looking at stays on screen
    console.log(id, Math.round(performance.now() - t0), 'ms', f.nx + '×' + f.ny, f.times.length + ' h');
    toast(`✦ ${f.meta.name} izrađena (${ids.length} modela, ${f.times.length - 1} h${f.clockw.meanConf != null ? `, pouzdanost ~${Math.round(f.clockw.meanConf)} %` : ''}) – tab gore`, 5000);
  } catch (e) { console.error(e); prog(null, e.message); toast(e.message, 4500); }
  finally { cwBusy = false; if ($('#tab-data').classList.contains('on')) renderDataTab(); }
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
    const own = Math.min(ownEnd(f), f.validUntil || 1e15), end = lastTime(f);
    c.fillStyle = mcol(m.id); c.globalAlpha = 0.85; c.fillRect(X(f.times[0]), y + 2, X(own) - X(f.times[0]), 12);
    if (end > own) { c.globalAlpha = 0.4; c.fillRect(X(own), y + 2, X(end) - X(own), 12); }
    c.globalAlpha = 1;
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
let dlBusy = false, curDl = null, dlAborted = false;
async function doDownload(opts = {}) {
  if (!navigator.onLine) return opts.auto ? null : toast('Nema interneta – koristi se zadnja spremljena prognoza');
  if (!settings.dlModels.length && settings.source === 'openmeteo') return toast('Odaberi barem jedan model');
  if (dlBusy) return;
  dlBusy = true; dlAborted = false; curDl = { auto: !!opts.auto, area: opts.bbox || null, zoom: map.getZoom() };
  const dummy = { style: {}, classList: { add() {}, remove() {} }, textContent: '', innerHTML: '' };
  const btn = $('#btnDownload') || dummy; btn.disabled = true; ($('#btnAbort') || dummy).classList.remove('hidden');
  const bar = $('#dlBar') || dummy, txt = $('#dlText') || dummy;
  const area = opts.bbox || dlArea();   // the area of THIS download (the panel always shows the current window)
  // every arriving piece builds on what is on the map AT THAT MOMENT (another download may have finished meanwhile)
  const settle = p => {
    const cur = state.set;
    const empty = m => { if (!m || m.nx === 1 || !m.vars || !m.vars.wave) return true; const a = m.vars.wave; for (let i = 0; i < a.length; i += 7) if (a[i] === a[i]) return false; return true; };
    if (cur && empty(p.fields.marine) && !empty(cur.fields.marine)) p.fields.marine = cur.fields.marine;   // never lose waves/currents
    if (cur) for (const id of p.models) carryLong(p.fields[id], cur.fields[id]);   // never lose days 4–15 either
    // a model that did not arrive this time (server busy) stays from the previous forecast instead of vanishing
    if (cur && opts.auto && !p.partial) for (const id of cur.models) { const f = cur.fields[id];   // (automatic refills only: a manual download takes exactly the models you chose)
      if (!id.startsWith('grib:') && !p.fields[id] && f && f.times && lastTime(f) > Date.now()) { p.fields[id] = f; p.models.push(id); } }
    keepGribs(p, cur); inheritCoverage(p, cur); extendTimes(p);
  };
  try {
    dlAbort = new AbortController();
    const st = fcMode() ? Math.round(Date.now() / H1) * H1 : raceStart();
    const inAdriatic = b => b.s >= ADRIATIC.s - 0.3 && b.n <= ADRIATIC.n + 0.3 && b.w >= ADRIATIC.w - 0.3 && b.e <= ADRIATIC.e + 0.3;
    let src = settings.source;
    if (src === 'cloud' && opts.auto && !inAdriatic(area)) return null;   // outside the cloud package: keep it (the map shows the land there)
    if (src === 'cloud') {
      try { await loadCloud(bar, txt, opts.auto); return; }
      catch (e) {   // cloud not reachable (e.g. the package was never built on GitHub): official GRIBs instead, never a dead end
        if (e.name === 'AbortError') throw e;
        src = 'direct';
        // say it every time (also on automatic refills): otherwise only ECMWF + GFS appear and nobody knows why
        state.cloudError = `${e.message} (${fmtTime(Date.now())})`;
        toast(`Paket iz oblaka nije dostupan (${e.message}) – privremeno samo ECMWF i GFS`, 6000); txt.textContent = 'Paket iz oblaka nije dostupan – preuzimam izravno…';
      }
    }
    const useDirect = src === 'direct';
    if (useDirect && !(settings.directModels || []).length) throw new Error('Odaberi barem jedan model');
    const dirIds = (settings.directModels || []).filter(id => directUsable(id, state.native));
    let win = dlWindow();
    // forecast mode: first the detailed 3 days, the rest (up to 15 days) as a light second part below
    const now0 = Math.floor(Date.now() / H1) * H1 - H1;
    const longT1 = fcMode() ? (win.t1 - win.t0 > (SHORT_DAYS * 24 + 2) * H1 ? win.t1 : 0) : (fcDays() > SHORT_DAYS ? now0 + fcDays() * 24 * H1 : 0);
    const longT0 = fcMode() ? win.t0 : now0;
    if (longT1 && fcMode()) win = { ...win, t1: win.t0 + SHORT_DAYS * 24 * H1 };
    else if (opts.auto && state.set && state.set.times && state.set.times.length) {   // race mode: a refill keeps (at least) the time span already on screen
      // only the DETAILED span counts (days 4–15 of the models stay attached anyway) – otherwise a refill would fetch 15 days of everything
      const T = state.set.times, own = Math.max(...state.set.models.filter(id => !isDerived(id) && state.set.fields[id] && state.set.fields[id].times).map(id => ownEnd(state.set.fields[id])), win.t1);
      win = { ...win, t0: Math.min(win.t0, Math.max(T[0], Date.now() - 6 * 3600000)), t1: Math.min(own, Math.max(win.t1, Date.now() + SHORT_DAYS * 24 * 3600000)) };   // detail for the race (+3 days); the rest stays attached
    }
    const set = await (useDirect ? downloadDirect : downloadForecast)({ bbox: area, modelIds: useDirect ? (dirIds.length ? dirIds : ['dir_ecmwf', 'dir_gfs']) : settings.dlModels, window: win, quality: settings.quality, settings, signal: dlAbort.signal, maxSeconds: 150,
      // the map is coloured as soon as the first model arrives (onPartial). An automatic refill is quick (DWD 3-hourly);
      // zoomed far out it takes only the global models. A manual download always takes every model you chose.
      quick: !!opts.auto, globalOnly: !!opts.auto && map.getZoom() < 6.5,
      onPartial: useDirect ? p => { settle(p); useSet(p, { keepView: true }); } : null,
      progress: (f, t) => { if (f != null) bar.style.width = (f * 100).toFixed(0) + '%'; if (t) txt.textContent = t; } });
    settle(set);
    set.longTried = longT1 ? Date.now() : 0;   // days 4–15 are attempted below (both modes); retried after 30 min if they failed
    txt.textContent = 'Spremam za offline…';
    await saveForecast(set);
    if (!opts.auto) { state.routes = {}; drawRoutes(); }
    state.newRuns = [];
    if (pendingRect) { map.removeLayer(pendingRect); pendingRect = null; }
    const keepT = state.time;
    state.time = opts.auto && keepT >= set.times[0] && keepT <= set.times[set.times.length - 1] ? keepT : st;
    useSet(set, { keepView: true });
    set.mode = settings.mode;
    // second part: days 4–15 (the map is already usable meanwhile)
    // runs on its own: it never holds up the map filling; the result is attached to whatever forecast is on screen then
    if (longT1 && !(opts.auto && longCovered(set))) {
      if (longBusy) pendingLong = [area, longT0, longT1, !opts.auto, bar, txt];   // runs right after the one in progress
      else runLong(set, area, longT0, longT1, !opts.auto, bar, txt);
    }
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
    else { if (e.name === 'AbortError') dlAborted = true; txt.textContent = e.name === 'AbortError' ? 'Prekinuto.' : e.message; if (e.name !== 'AbortError') toast(e.message, 5000); }
  }
  finally { btn.disabled = false; const a = $('#btnAbort'); a && a.classList.add('hidden'); dlBusy = false; curDl = null; }
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
  if (pick || !navigator.onLine) return;
  if (settings.source === 'cloud') return;   // the cloud package is complete (Adriatic, 15 days): nothing to fill around it
  const wantLong = () => fcDays() > SHORT_DAYS && state.set && Date.now() - (+state.set.longTried || 0) > 30 * 60000 && !longCovered(state.set);
  if (areaSel() !== 'view') {   // fixed area (Adriatic / own rectangle): no window filling, but days 4–15 once
    if (dlBusy) { fillTimer = setTimeout(() => maybeFillWindow(delay), 3000); return; }   // try again when the current download ends
    if (!wantLong()) return;
    fillTimer = setTimeout(() => { if (dlBusy) return maybeFillWindow(delay); if (wantLong()) doDownload({ auto: true, bbox: dlArea() }); }, Math.max(delay, 1500));
    return;
  }
  // an automatic refill for a view you have already left is cancelled, so the one for what you see now starts at once
  if (dlBusy && curDl && curDl.auto && curDl.area && dlAbort && uncoveredShare() >= 0.002) {
    const v = viewBBox(0.5), r = curDl.area;
    if (!(v.s >= r.s && v.n <= r.n && v.w >= r.w && v.e <= r.e)) dlAbort.abort();
  }
  if (dlBusy) { fillTimer = setTimeout(() => maybeFillWindow(delay), 3000); return; }   // check again when the current download ends
  // fill when any edge is missing, or when you zoomed back in after a thinned (whole-sea) download
  // zoomed back in after a coarse/global-only download: fetch full detail (incl. DWD) for the new window
  const needDetail = () => { const s = state.set, v = map.getBounds(); if (!s) return false;
    if (s.globalOnly) return map.getZoom() >= 6.5;   // came back from a far-out view: regional detail again
    if (!s.thinned) return false;
    const e = setExtent({ models: s.models.filter(id => !isDerived(id)), fields: s.fields }); if (!e) return false;
    return (v.getEast() - v.getWest()) * (v.getNorth() - v.getSouth()) < 0.15 * (e.e - e.w) * (e.n - e.s); };
  // days 4–15 missing (e.g. a forecast from an older version): fetched once per forecast, never in a loop
  const courseOut = () => { const s = state.set; if (fcMode() || !s || course.marks.length < 2) return false; const cb = courseBBox();
    const g = s.models.filter(id => /ecmwf|gfs/.test(id) && s.fields[id] && s.fields[id].nx); if (!g.length) return false;
    return !g.some(id => { const e = extentOf(s.fields[id]); return cb.s >= e.s && cb.n <= e.n && cb.w >= e.w && cb.e <= e.e; }); };
  const farWait = () => { const s = state.set; if (!s) return false;   // only past the DETAILED part of every model
    const own = Math.max(0, ...s.models.filter(id => s.fields[id] && s.fields[id].times && !isDerived(id)).map(id => ownEnd(s.fields[id])));
    return state.time > own + H1 && Date.now() - (+s.longTried || 0) < 30 * 60000 && !longCovered(s); };
  const uncov = () => !farWait() && uncoveredShare() >= 0.002;
  if (!uncov() && !needDetail() && !wantLong() && !courseOut()) return;
  const since = Date.now() - lastFill, pause = lastFillFailed ? 45000 : 3000;   // never hammer the servers
  fillTimer = setTimeout(async () => {
    if ((!uncov() && !needDetail() && !wantLong() && !courseOut()) || dlBusy || pick) return;
    lastFill = Date.now();
    toast('Preuzimam prognozu za cijeli prikaz…', 2500);
    const v = viewBBox(1.0);   // twice the window: the next zoom-out or pan is usually covered already
    const before = state.set;
    await doDownload({ auto: true, bbox: fcMode() || !course.marks.length ? v : union(v, courseBBox()) });
    lastFillFailed = state.set === before && !dlAborted;   // cancelled for a newer view is not a failure
  }, Math.max(delay, since < pause ? pause - since : 0));
}
map.on('moveend', maybeFillWindow);
// re-download only the models that have a newer run than the one stored; merge into the current set
async function loadCloud(bar, txt, auto = false) {
  const set = await fetchCloudModels(settings.cloudUrl || CLOUD_DEFAULT, settings.cloudModels || null, state.native, (f, t) => { if (f != null && bar) bar.style.width = (f * 100).toFixed(0) + '%'; if (t && txt) txt.textContent = t; });
  state.cloudError = null;
  set.mode = 'forecast'; set.longTried = Date.now();   // the package carries its own range (up to 15 days)
  const hasWaves = m => { if (!m || m.nx === 1 || !m.vars || !m.vars.wave) return false; const a = m.vars.wave; for (let i = 0; i < a.length; i += 7) if (a[i] === a[i]) return true; return false; };
  if (state.set && !hasWaves(set.fields.marine) && hasWaves(state.set.fields.marine)) set.fields.marine = state.set.fields.marine;
  keepGribs(set, state.set); inheritCoverage(set, state.set);
  if (!(await saveForecast(set)) && !auto) toast('Prognoza je učitana, ali memorija uređaja je puna – nije spremljena za rad bez interneta', 6000);
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
    let win = s.mode === 'forecast' || fcMode() ? dlWindow() : (s.window || dlWindow());
    if (s.mode === 'forecast' || fcMode()) win = { ...win, t1: Math.min(win.t1, win.t0 + SHORT_DAYS * 24 * H1) };   // new run: detail again, days 4–15 stay
    const fresh = await downloadForecast({ bbox: s.bbox || dlArea(), modelIds: ids, window: win, quality: s.quality || settings.quality, settings, signal: dlAbort.signal,
      progress: (f, t) => { if (f != null && bar) bar.style.width = (f * 100).toFixed(0) + '%'; if (t && txt) txt.textContent = t; } });
    for (const id of fresh.models) { carryLong(fresh.fields[id], s.fields[id]); s.fields[id] = fresh.fields[id]; }
    s.fields.marine = fresh.fields.marine;
    if (fresh.times[fresh.times.length - 1] > s.times[s.times.length - 1]) s.times = fresh.times;
    extendTimes(s);
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
let lastImportMsg = '';   // the import result stays visible after the Prognoza tab re-renders
async function importGribs(files) {
  const txt = new Proxy({}, { set: (o, k, v) => { if (k === 'textContent') { lastImportMsg = v; const el = $('#dlText'); if (el) el.textContent = v; } return true; } });
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
  const el = $('#dlText'); if (el && lastImportMsg) el.textContent = lastImportMsg;
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
  const cache = await caches.open('ctw-tiles-v2');
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
// boat picker: Clockwork / LeeLoo (+ imported boats), then which polar of that boat (designer VPP or ORC certificate)
function boatPickerHtml() {
  const b = state.boat, g = boatGroup(b);
  const others = boats.filter(x => !x.group);
  const variants = g ? boats.filter(x => x.group === g.id) : [];
  return `<div class="seg boatseg">${BOAT_GROUPS.filter(gr => boats.some(x => x.group === gr.id)).map(gr => `<button data-bgroup="${gr.id}" class="${g && g.id === gr.id ? 'on' : ''}">⛵ ${gr.name} <small>${gr.type}</small></button>`).join('')}
      ${others.map(x => `<button data-boat="${x.id}" class="${x.id === b.id ? 'on' : ''}">${x.name}</button>`).join('')}</div>
    ${variants.length > 1 ? `<div class="seg small">${variants.map(x => `<button data-boat="${x.id}" class="${x.id === b.id ? 'on' : ''}">${x.kind === 'vpp' ? 'VPP (dizajnerski)' : 'ORC certifikat'}</button>`).join('')}</div>` : ''}
    <div class="note">${b.kind === 'vpp' ? '<b>VPP</b>: puna tablica brzina i target kutova od dizajnera – najdetaljnije. Teoretski maksimum: za stvarnu formu posade spusti učinkovitost (npr. 92–96 %).' : b.kind === 'orc' ? '<b>ORC</b>: polar iz ORC certifikata – konzervativniji, manje točaka.' : 'Uvezeni polar.'}${sailSetOf(b) ? ` Jedra: ${SAIL_SETS[sailSetOf(b)].name}.` : ''}</div>`;
}
function bindBoatPicker(el, rerender) {
  el.querySelectorAll('[data-bgroup]').forEach(btn => btn.onclick = () => {
    const cur = state.boat, kind = cur.kind || 'vpp';
    const pick = boats.find(x => x.group === btn.dataset.bgroup && x.kind === kind) || boats.find(x => x.group === btn.dataset.bgroup);
    if (pick && pick.id !== cur.id) { selectBoat(pick.id); toast(`Brod: ${pick.name}`); }
    rerender();
  });
  el.querySelectorAll('[data-boat]').forEach(btn => btn.onclick = () => { if (btn.dataset.boat !== state.boat.id) selectBoat(btn.dataset.boat); rerender(); });
}
function renderRoutingTab() {
  const el = $('#tab-routing'); const s = state.set;
  const start = raceStart();
  const routable = s ? s.models.filter(id => s.fields[id].validUntil > start && s.fields[id].times[0] <= start) : [];
  if (!state.routeModels) state.routeModels = routable.filter(id => !isClockW(id));   // ClockW: only when you tick it
  const stale = Object.values(state.routes).some(r => r.stale);
  el.innerHTML = `
    <h3>Brod</h3>
    ${boatPickerHtml()}
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
  num('#draft', 'draft', () => { settings.boatDrafts = settings.boatDrafts || {}; settings.boatDrafts[state.boat.group || state.boat.id] = settings.draft; saveSettings(); rebuildMask(); renderRoutingTab(); }); num('#dmargin', 'depthMargin', () => { rebuildMask(); renderRoutingTab(); });
  el.querySelector('#avoidSh').onchange = e => { settings.avoidShallow = e.target.checked; saveSettings(); rebuildMask(); renderRoutingTab(); };
  bindBoatPicker(el, renderRoutingTab);
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
  // the forecast must cover the whole course: wait for a download in progress, then fill the course once if needed
  if (!override.marks && navigator.onLine && state.set) {
    for (let i = 0; i < 360 && dlBusy; i++) await new Promise(r => setTimeout(r, 500));
    const cb = courseBBox(), REGIONAL = ['dir_icon_d2', 'icon_d2', 'knmi_harmonie_arome_europe'];
    const short = id => { const f = state.set.fields[id]; if (!f || !f.nx || isDerived(id) || REGIONAL.includes(id)) return false; const e = extentOf(f); return !(cb.s >= e.s && cb.n <= e.n && cb.w >= e.w && cb.e <= e.e); };
    const need = fcMode() ? 0 : dlWindow().t1;   // start + estimated race time + reserve, for THIS course
    const early = id => { const f = state.set.fields[id]; return !!f && !isDerived(id) && !REGIONAL.includes(id) && need && (f.validUntil || 0) < need - H1 && f.times[0] <= (override.startTime || raceStart()); };
    if (ids.some(short) || ids.some(early)) { toast('Dopunjavam prognozu za cijelu stazu…', 3000); await doDownload({ auto: true, bbox: union(viewBBox(1.0), cb) }); ids = ids.filter(id => state.set && state.set.fields[id]); if (!ids.length) return toast('Prognoza za stazu nije dostupna – preuzmi je u kartici Prognoza', 5000); }
  }
  const startTime = override.startTime || raceStart();
  const marks = marksForRouting(override.marks || course.marks);
  const rs = state.set;   // the forecast as it is now – a refill during routing must not pull fields from under it
  if (!rs) return toast('Prvo preuzmi prognozu', 4000);
  ids = ids.filter(id => rs.fields[id]); if (!ids.length) return toast('Odabrani modeli nisu u prognozi – preuzmi je ponovno', 4000);
  if (!$('#runStatus')) openSheet('routing');   // progress lives in the routing tab – make sure it exists
  const st = $('#runStatus');
  st.innerHTML = ids.map(id => `<div class="note"><span class="dot" style="background:${mcol(id)}"></span>${modelById(id).name}: <span id="rs-${id.replace(/[^\w-]/g, '_')}">čeka…</span><div class="progress"><div id="rp-${id.replace(/[^\w-]/g, '_')}"></div></div></div>`).join('');
  const key = id => id.replace(/[^\w-]/g, '_');
  const ws = getWorkers();
  const opts = { efficiency: settings.efficiency / 100, tackPenaltySec: settings.tackPenaltySec, gybePenaltySec: settings.gybePenaltySec, dtMin: settings.dtMin, useCurrents: settings.useCurrents, wavePenalty: settings.wavePenalty, sails: sailSetOf(state.boat) || false };
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
        w.postMessage({ cmd: 'route', id: msgId, wind: rs.fields[id], marine: rs.fields.marine, polar: state.polar.serialize(), marks, startTime, opts });
      });
      res.model = id; res.boat = state.boat.name; res.sailSet = sailSetOf(state.boat); res.live = !!override.marks;
      state.routes[id] = res;
      const b = $('#rp-' + key(id)); if (b) b.style.width = '100%';
      if (rsEl()) rsEl().textContent = res.ok ? `ETA ${fmtTime(res.eta)} (${fmtDur(res.stats.hours)})${res.overPolar ? ` · ⚠ vjetar do ${Math.round(res.overPolar.maxTws)} kn, polar do ${res.overPolar.top} kn` : ''}` : '✕ ' + res.error;
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

// ---------------- live measurements ("Sada"): DHMZ buoys, lighthouses and coastal stations ----------------
// collected every 30 min by GitHub (tools/obs/collect.py → branch obs); buoys are read from DHMZ's graphs (wind at 3 m)
const OBS_URL = 'https://raw.githubusercontent.com/Clockwork-75/Clock-the-wind/obs/obs.json';
const obsLayer = L.layerGroup();
let obsTimer = null;
const U3_10 = 1.12;   // wind at 10 m ≈ 1.12 × wind at 3 m over the open sea (log profile)
async function loadObs(force = false) {
  if (!force && state.obs && Date.now() - state.obs._got < 8 * 60000) return state.obs;
  try {
    const r = await fetch(OBS_URL + '?t=' + Math.floor(Date.now() / 300000), { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const o = await r.json(); o._got = Date.now(); state.obs = o;
    // a place whose sources do not answer stays on the map (grey) but is never used for scoring, MOJA or signals
    for (const p of o.places || []) if (p.off) p.stale = true;
    try { localStorage.setItem('ctw.obs', JSON.stringify(o)); } catch { }
  } catch (e) {
    if (!state.obs) { try { state.obs = JSON.parse(localStorage.getItem('ctw.obs')); } catch { } }
    if (!state.obs) toast('Mjerenja trenutno nisu dostupna (' + e.message + ')', 4000);
  }
  return state.obs;
}
// a model against what is measured now – the WHOLE wind: vector error (kn) = length of the difference between the
// forecast and the measured wind arrows, so a wrong direction counts as much as a wrong speed; plus the speed error
// (+ too strong / − too weak) and the direction error (°, only when both blow at least 5 kn)
function measVec(p) {
  if (p.wspd == null) return null;
  const sp = p.h === 3 ? p.wspd * U3_10 : p.wspd;
  if (sp < 0.5) return { u: 0, v: 0, sp: 0 };
  if (p.wdir == null) return null;
  const a = p.wdir * Math.PI / 180;
  return { u: -sp * Math.sin(a), v: -sp * Math.cos(a), sp, dir: p.wdir };
}
function obsModelErr(p, f) {
  if (!f || p.stale) return null;
  const m = measVec(p); if (!m) return null;
  const o = sample(f, ['u', 'v'], p.lat, p.lon, p.t * 1000, []);
  if (o[0] !== o[0]) return null;
  const fs = Math.hypot(o[0], o[1]), fdir = (Math.atan2(-o[0], -o[1]) * 180 / Math.PI + 360) % 360;
  const dd = m.sp >= 5 && fs >= 5 ? Math.abs(((fdir - m.dir) % 360 + 540) % 360 - 180) : null;
  return { vec: Math.hypot(o[0] - m.u, o[1] - m.v), spd: fs - m.sp, dir: dd, fs, fdir };
}
function obsRank() {
  const o = state.obs, s = state.set; if (!o || !s) return [];
  const pl = o.places.filter(p => !p.stale && p.wspd != null && Date.now() / 1000 - p.t < 3 * 3600);
  const res = [];
  for (const id of s.models) {
    if (id === 'moja') continue;   // MOJA is pulled towards these very measurements – not a fair competitor here
    const f = s.fields[id]; let n = 0, ve = 0, b = 0, sd = 0, nd = 0;
    for (const p of pl) { const e = obsModelErr(p, f); if (!e) continue; n++; ve += e.vec; b += e.spd; if (e.dir != null) { sd += e.dir; nd++; } }
    if (n >= 4) res.push({ id, mae: ve / n, bias: b / n, dir: nd >= 3 ? sd / nd : null, n });
  }
  return res.sort((a, b) => a.mae - b.mae);
}
const arrowSvg = (deg, col) => `<svg viewBox="-10 -10 20 20" style="transform:rotate(${(deg + 180) % 360}deg)"><path d="M0 -8 L4 4 L0 1.5 L-4 4Z" fill="${col}" stroke="#0a1426" stroke-width="1"/></svg>`;
function drawObs() {
  obsLayer.clearLayers();
  const card = $('#obsCard');
  if (!state.ovObs || !state.obs) { card.classList.add('hidden'); if (map.hasLayer(obsLayer)) map.removeLayer(obsLayer); return; }
  if (!map.hasLayer(obsLayer)) obsLayer.addTo(map);
  const o = state.obs, f = state.wind;
  for (const p of o.places) {
    if (p.off) {   // the source does not answer: grey, "ne javlja se od …" in the popup
      L.marker([p.lat, p.lon], { pane: 'routes', icon: L.divIcon({ className: 'obsicon', html: `<div class="obsm ${p.kind} off"><i class="calm"></i><b>–</b></div>`, iconSize: [0, 0] }) })
        .on('click', () => showObs(p)).addTo(obsLayer);
      continue;
    }
    const col = p.stale ? '#8a96a8' : speedColor(p.wspd || 0);
    const err = obsModelErr(p, f);
    const lab = `${p.wspd != null ? Math.round(p.wspd) : '–'}${p.wgust != null ? '/' + Math.round(p.wgust) : ''}`;
    const showErr = err && err.vec >= 5 && (p.kind !== 'station' || map.getZoom() >= 9);   // the open sea always, coastal stations only zoomed in
    const html = `<div class="obsm ${p.kind}${p.stale ? ' stale' : ''}">${p.wdir != null ? arrowSvg(p.wdir, col) : '<i class="calm"></i>'}<b>${lab}</b>${p.hs != null ? `<em>${p.hs.toFixed(1)} m</em>` : ''}${showErr ? `<u class="${err.dir != null && err.dir >= 45 ? 'dir' : err.spd > 0 ? 'hi' : 'lo'}">${err.dir != null && err.dir >= 45 ? '↻' + Math.round(err.dir) + '°' : (err.spd > 0 ? '+' : '') + Math.round(err.spd)}</u>` : ''}</div>`;
    L.marker([p.lat, p.lon], { pane: 'routes', icon: L.divIcon({ className: 'obsicon', html, iconSize: [0, 0] }) })
      .on('click', () => showObs(p)).addTo(obsLayer);
  }
  const age = Math.round((Date.now() / 1000 - o.created) / 60);
  const rank = obsRank().slice(0, 4);
  const sig = (o.signals || []).slice(0, 5);
  card.innerHTML = `<div class="oh"><b>Sada</b> · izmjereno ${fmtTime(o.created * 1000, false)} <small>(prije ${age} min)</small><button class="x" aria-label="Zatvori">×</button></div>
    <div class="or"><small>Mjesta: ${o.places.filter(p => !p.off).length} se javlja${o.places.some(p => p.off) ? ` · ${o.places.filter(p => p.off).length} ne javlja se (siva)` : ''}</small></div>
    ${rank.length ? `<div class="or"><small>Najbliže mjerenjima sada (cijeli vjetar: snaga + smjer):</small> ${rank.map((r, i) => `<span class="${i ? '' : 'best'}"><i style="background:${mcol(r.id)}"></i>${modelById(r.id).name} ±${r.mae.toFixed(1)} kn${r.dir != null ? ` · ${Math.round(r.dir)}°` : ''}</span>`).join('')}</div>` : ''}
    ${[['24h', 'Zadnja 24 h'], ['7d', 'Zadnjih 7 dana']].map(([k, l]) => { const r = ((o.skill || {})[k] || []).filter(x => modelById(x.id)); return r.length ? `<div class="or"><small>${l}:</small> ${r.slice(0, 4).map((x, i) => `<span class="${i ? '' : 'best'}"><i style="background:${mcol(x.id)}"></i>${modelById(x.id).name} ±${x.mae.toFixed(1)}${x.dir != null ? ` · ${x.dir}°` : ''}</span>`).join('')}</div>` : ''; }).join('')}
    ${sig.map(x => `<div class="os ${x.level}">⚠ <b>${x.title}</b><br><small>${x.text}</small></div>`).join('') || '<div class="os none"><small>Nema posebnih signala u mreži mjerenja.</small></div>'}`;
  card.classList.remove('hidden');
  card.querySelector('.x').onclick = () => card.classList.add('hidden');
}
map.on('zoomend', () => { if (state.ovObs) drawObs(); });
const speedColor = kn => { const L = LAYERS.wind.scale, i = L.idx(kn) * 4, c = L.lut; return `rgb(${c[i]},${c[i + 1]},${c[i + 2]})`; };
function sparkline(series, keys, opts = {}) {
  const ts = Object.keys(series).map(Number).sort((a, b) => a - b); if (ts.length < 2) return '';
  const W = 280, Hh = 70, t0 = ts[0], t1 = ts[ts.length - 1];
  const vals = keys.flatMap(k => ts.map(t => series[t][k]).filter(v => v != null));
  if (!vals.length) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals); if (opts.zero) lo = 0; if (hi - lo < (opts.min || 1)) hi = lo + (opts.min || 1);
  const X = t => 4 + (t - t0) / (t1 - t0) * (W - 8), Y = v => Hh - 12 - (v - lo) / (hi - lo) * (Hh - 20);
  const cols = opts.colors || ['#5ab0ff', '#ff5a5a'];
  const paths = keys.map((k, j) => { let d = '', pen = false; for (const t of ts) { const v = series[t][k]; if (v == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; } return `<path d="${d}" fill="none" stroke="${cols[j]}" stroke-width="1.6"/>`; }).join('');
  // day boundaries (local midnight)
  let grid = ''; for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) { if (tzHour(t * 1000) === 0) grid += `<line x1="${X(t)}" x2="${X(t)}" y1="0" y2="${Hh - 10}" stroke="#ffffff22"/>`; }
  return `<div class="spark"><small>${opts.title || ''}</small><svg viewBox="0 0 ${W} ${Hh}">${grid}${paths}<text x="2" y="9" class="sl">${hi.toFixed(opts.dec ?? 0)}</text><text x="2" y="${Hh - 12}" class="sl">${lo.toFixed(opts.dec ?? 0)}</text></svg></div>`;
}
function showObs(p) {
  const o = state.obs, sr = (o.series && o.series[p.id]) || {};
  const dirTxt = d => d == null ? '–' : `${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8]} ${Math.round(d)}°`;
  const err = obsModelErr(p, state.wind), mname = modelById(state.modelId).name;
  const row = (l, v) => v == null || v === '' ? '' : `<tr><td>${l}</td><td><b>${v}</b></td></tr>`;
  const SRC = { amp: 'DHMZ automatska postaja (10 min)', xml: 'DHMZ (satno)', buoy: 'DHMZ plutača', metar: 'METAR (aerodrom)', arso: 'ARSO', izor: 'IZOR (Institut za oceanografiju)' };
  const srcs = [...new Set((p.src || []).map(x => SRC[x.split(':')[0]] || x))].join(' · ');
  const kindTxt = p.kind === 'buoy' ? 'plutača DHMZ' : p.kind === 'lighthouse' ? 'svjetionik' : 'postaja';
  if (p.off) {
    const recent = p.seen && Date.now() / 1000 - p.seen < 3 * 3600;
    const html = `<div class="obspop"><b>${p.name}</b> <small>${kindTxt}</small>
      <p class="warn">${recent ? 'Javlja se, ali trenutno bez podataka o vjetru.' : p.seen ? `Ne javlja se od ${fmtDate(p.seen * 1000)}.` : 'Ne javlja se.'}</p>
      ${p.wspd != null && p.t ? `<small class="muted">Zadnji vjetar: ${Math.round(p.wspd)} kn ${dirTxt(p.wdir)} (${fmtDate(p.t * 1000)})</small><br>` : ''}
      <small class="muted">Izvori: ${srcs}. Aplikacija ih pita pri svakom osvježavanju – čim se jave, mjesto se vraća samo.</small></div>`;
    L.popup({ maxWidth: 320, className: 'obspopup' }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
    return;
  }
  const html = `<div class="obspop"><b>${p.name}</b> <small>${kindTxt} · ${fmtTime(p.t * 1000, false)}${p.stale ? ' · <span class="warn">staro mjerenje</span>' : ''}</small>
    <table>${row('Vjetar', p.wspd != null ? `${p.wspd.toFixed(0)} kn ${dirTxt(p.wdir)}${p.h === 3 ? ' <small>(3 m)</small>' : ''}` : null)}${row('Udari', p.wgust != null ? p.wgust.toFixed(0) + ' kn' : null)}
    ${row(mname, err ? `${err.fs.toFixed(0)} kn ${dirTxt(err.fdir)} <small>(greška ${err.vec.toFixed(0)} kn${err.dir != null ? `, smjer ${Math.round(err.dir)}°` : ''}${p.h === 3 ? '; usporedba na 10 m' : ''})</small>` : null)}
    ${row('Tlak', p.pres != null ? `${p.pres.toFixed(1)} hPa${p.dp3 != null ? ` <small>(${p.dp3 > 0 ? '+' : ''}${p.dp3.toFixed(1)} u 3 h)</small>` : ''}` : null)}
    ${row('Temperatura', p.tair != null ? `${p.tair.toFixed(1)} °C${p.dT1 != null && Math.abs(p.dT1) >= 1 ? ` <small>(${p.dT1 > 0 ? '+' : ''}${p.dT1.toFixed(1)} u 1 h)</small>` : ''}` : null)}
    ${row('Vlaga', p.rh != null ? `${Math.round(p.rh)} %${p.drh3 != null && Math.abs(p.drh3) >= 5 ? ` <small>(${p.drh3 > 0 ? '+' : ''}${p.drh3} u 3 h)</small>` : ''}` : null)}
    ${row('Valovi', p.hs != null ? `${p.hs.toFixed(1)} m${p.hmax != null ? ` · max ${p.hmax.toFixed(1)} m` : ''}${p.tp != null ? ` · ${p.tp.toFixed(1)} s` : ''}${p.vdir != null ? ` · iz ${dirTxt(p.vdir)}` : ''}` : null)}
    ${row('More', p.sst != null ? p.sst.toFixed(1) + ' °C' : null)}</table>
    ${sparkline(sr, ['wspd', 'wgust'], { title: 'Vjetar i udari (kn), 72 h', zero: true, min: 10 })}
    ${sparkline(sr, ['pres'], { title: 'Tlak (hPa)', colors: ['#c9a2ff'], dec: 0, min: 4 })}
    ${p.kind === 'buoy' ? sparkline(sr, ['hs', 'hmax'], { title: 'Valovi (m)', colors: ['#5ab0ff', '#ff5a8a'], zero: true, dec: 1, min: 1 }) : ''}
    ${sparkline(sr, ['tair'], { title: 'Temperatura zraka (°C)', colors: ['#ff8a5a'], dec: 0, min: 2 })}
    <small class="muted">Izvori: ${srcs}${p.by && (p.src || []).length > 1 ? ` – vjetar sada iz: ${SRC[p.by] || p.by}` : ''}. Izvorni nekontrolirani podaci${p.kind === 'buoy' ? '; plutača očitana s grafa' : (p.src || []).some(x => x.startsWith('amp:')) ? '; automatska postaja očitana s grafa' : ''}.</small></div>`;
  L.popup({ maxWidth: 320, className: 'obspopup' }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
}
$('#ovObs').onclick = async () => {
  state.ovObs = settings.ovObs = !state.ovObs; saveSettings(); syncToggles();
  clearInterval(obsTimer); obsTimer = null;
  if (state.ovObs) { await loadObs(); autoMoja(); obsTimer = setInterval(async () => { await loadObs(true); autoMoja(); drawObs(); }, 10 * 60000); }
  drawObs();
};
setTimeout(async () => { state.ovObs = !!settings.ovObs; syncToggles(); if (state.ovObs) { await loadObs(); autoMoja(); drawObs(); obsTimer = setInterval(async () => { await loadObs(true); autoMoja(); drawObs(); }, 10 * 60000); } }, 1500);

// ---------------- "MOJA" – our own forecast from the models and the live measurements ----------------
// 1) every model's speed is corrected by its measured error (ratio measured/model over the places, last hours);
// 2) the models are blended with weights ∝ 1/error² (the ones that hit the measurements count more);
// 3) the first hours are pulled towards the measurements: the remaining error at each buoy/station is spread to the
//    sea around it (inverse distance, ~60 km) and fades out over ~6 h.
const MOJA_META = { id: 'moja', name: 'MOJA', res: 'modeli + mjerenja', color: '#b388ff', note: 'Naša prognoza: modeli ispravljeni i ponderirani prema mjerenjima, prvih sati povučena prema stvarnom stanju' };
registerModel(MOJA_META);
function mojaStats() {
  const o = state.obs, s = state.set; if (!o || !s) return null;
  const now = Date.now() / 1000;
  const pl = o.places.filter(p => !p.stale && p.wspd != null && now - p.t < 3 * 3600);
  const ids = s.models.filter(id => !isDerived(id) && s.fields[id] && s.fields[id].vars && s.fields[id].vars.u);
  const st = [];
  for (const id of ids) {
    const f = s.fields[id]; let n = 0, ve = 0, sm = 0, sx = 0, ds = 0, dc = 0, nd = 0;
    for (const p of pl) {
      const e = obsModelErr(p, f); if (!e) continue; const m = measVec(p); n++; ve += e.vec; sm += e.fs; sx += m.sp;
      if (e.dir != null) { const sd = ((e.fdir - m.dir) % 360 + 540) % 360 - 180; ds += Math.sin(sd * Math.PI / 180); dc += Math.cos(sd * Math.PI / 180); nd++; }
    }
    if (n < 4) continue;
    // a systematic turn of the model's wind (°, + = the model is turned clockwise of the measured); only when it is clear
    const dirBias = nd >= 4 && Math.hypot(ds, dc) / nd > 0.6 ? Math.max(-40, Math.min(40, Math.atan2(ds, dc) * 180 / Math.PI)) : 0;
    // the longer record (24 h, else 3 days) of the measurements workflow steadies the weights once there is one
    const long = ((o.skill || {})['24h'] || []).find(r => r.id === id && r.n >= 40) || ((o.skill || {})['72h'] || []).find(r => r.id === id && r.n >= 40);
    const mae = long ? 0.5 * (ve / n) + 0.5 * long.mae : ve / n;
    const sk = k => (((o.skill || {})[k]) || []).find(r => r.id === id && r.n >= 40);
    st.push({ id, f, n, mae, dirBias, ratio: Math.max(0.6, Math.min(1.6, sx / Math.max(1, sm))),
      maeShort: sk('7d_0-12') ? 0.5 * mae + 0.5 * sk('7d_0-12').mae : mae, maeLong: sk('7d_24-48') ? sk('7d_24-48').mae : mae });
  }
  if (!st.length) return null;
  const wsum = st.reduce((a, r) => a + 1 / Math.max(1, r.mae) ** 2, 0);
  st.forEach(r => { r.w = 1 / Math.max(1, r.mae) ** 2 / wsum; });
  return { st: st.sort((a, b) => b.w - a.w), pl };
}
// pressure: the measured bura / jugo gradients against the same gradients in each model (mean sea level pressure).
// The wind of bura and jugo grows with the gradient: a model with a weaker gradient than measured is too weak.
function pressureCheck() {
  const o = state.obs, s = state.set; if (!o || !s || !o.grads) return [];
  const out = [], q = [];
  const mean = (f, pts, t) => { let a = 0, n = 0; for (const [la, lo] of pts) { sample(f, ['mslp'], la, lo, t, q); if (q[0] === q[0]) { a += q[0]; n++; } } return n === pts.length ? a / n : NaN; };
  for (const g of o.grads) {
    const row = { ...g, models: {} };
    for (const id of s.models) {
      const f = s.fields[id]; if (!f || isDerived(id) || !f.vars || !f.vars.mslp) continue;
      const t = o.created * 1000, mg = mean(f, g.a, t) - mean(f, g.b, t);
      if (mg === mg) row.models[id] = mg;
    }
    out.push(row);
  }
  return out;
}
function mojaPressure(ms) {
  // the strongest active gradient (|measured| ≥ 3 hPa) sets a speed factor per model: halfway towards measured/model
  const pc = pressureCheck().filter(g => Math.abs(g.obs) >= 3).sort((a, b) => Math.abs(b.obs) - Math.abs(a.obs))[0];
  const k = {};
  if (!pc) return k;
  for (const r of ms.st) {
    const mg = pc.models[r.id];
    if (mg == null || Math.sign(mg) !== Math.sign(pc.obs) || Math.abs(mg) < 1) continue;
    k[r.id] = 1 + 0.5 * (Math.max(0.7, Math.min(1.4, pc.obs / mg)) - 1);
  }
  return k;
}
function buildMoja() {
  const s = state.set, ms = mojaStats(); if (!ms) return null;
  const B = { s: 41.8, n: 45.9, w: 12.2, e: 19.8 }, d = 0.05;
  const nx = Math.round((B.e - B.w) / d) + 1, ny = Math.round((B.n - B.s) / d) + 1, N = nx * ny;
  const H1 = 3600000, t0 = Math.floor(Date.now() / H1) * H1 - H1, T = 49;
  const times = Array.from({ length: T }, (_, i) => t0 + i * H1);
  const u = new Float32Array(T * N).fill(NaN), v = new Float32Array(T * N).fill(NaN), g = new Float32Array(T * N).fill(NaN);
  const q = [];
  const pg = mojaPressure(ms);   // the measured pressure pattern against the models' (bura / jugo strength)
  // weights by lead time: the next 12 h trust the models that are best in the short range, beyond 24 h those best 1–2 days ahead
  const wAt = lead => { const ws = ms.st.map(r => { const m = lead < 12 ? r.maeShort : lead < 24 ? 0.5 * (r.maeShort + r.maeLong) : r.maeLong; return 1 / Math.max(1, m) ** 2; }); const sum = ws.reduce((a, x) => a + x, 0); return ws.map(x => x / sum); };
  let W = ms.st.map(r => r.w), rot = 1;
  const blend = (lat, lon, t, out) => {
    let su = 0, sv = 0, ss = 0, sg = 0, w = 0, wg = 0;
    ms.st.forEach((r, ri) => {
      sample(r.f, ['u', 'v', 'gust'], lat, lon, t, q); if (q[0] !== q[0]) return;
      const k = r.ratio * (pg[r.id] || 1), sp = Math.hypot(q[0], q[1]), wr = W[ri];
      // turn the model's wind back by its measured systematic turn (fully now, half of it a day ahead)
      const a = -r.dirBias * rot * Math.PI / 180, cu = q[0] * Math.cos(a) + q[1] * Math.sin(a), cv = -q[0] * Math.sin(a) + q[1] * Math.cos(a);
      su += wr * cu; sv += wr * cv; ss += wr * sp * k; w += wr;
      if (q[2] === q[2]) { sg += wr * q[2] * k; wg += wr; }
    });
    if (!w) { out[0] = out[1] = out[2] = NaN; return out; }
    const mu = su / w, mv = sv / w, mag = Math.hypot(mu, mv), sp = ss / w;   // direction from the vector mean, speed from the corrected speeds
    out[0] = mag > 0.01 ? mu / mag * sp : 0; out[1] = mag > 0.01 ? mv / mag * sp : 0; out[2] = wg ? sg / wg : NaN;
    return out;
  };
  // what is left between the blend and the measured wind at each place, as a VECTOR (speed and direction)
  const res = [], b = [];
  W = wAt(0); rot = 1;
  for (const p of ms.pl) { const m = measVec(p); if (!m) continue; blend(p.lat, p.lon, p.t * 1000, b); if (b[0] !== b[0]) continue; res.push({ lat: p.lat, lon: p.lon, du: m.u - b[0], dv: m.v - b[1], g: p.wgust != null ? (p.h === 3 ? U3_10 : 1) * p.wgust - (b[2] === b[2] ? b[2] : 0) : null }); }
  for (let ti = 0; ti < T; ti++) {
    const t = times[ti], lead = (t - Date.now()) / H1, fade = lead <= 0 ? 1 : Math.exp(-lead / 4);
    W = wAt(Math.max(0, lead)); rot = lead <= 0 ? 1 : Math.max(0.5, 1 - lead / 48);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const lat = B.s + j * d, lon = B.w + i * d, o = ti * N + j * nx + i;
      blend(lat, lon, t, b); if (b[0] !== b[0]) continue;
      let du = 0, dv = 0, dg = 0;
      if (fade > 0.02 && res.length) {   // inverse-distance spread of the vector correction, within ~60 km
        let sw = 0, su = 0, sv = 0, swg = 0, sgg = 0;
        for (const r of res) { const dk = Math.hypot((r.lat - lat) * 111, (r.lon - lon) * 111 * Math.cos(lat * Math.PI / 180)); if (dk > 60) continue; const w = 1 / (dk * dk + 25); sw += w; su += w * r.du; sv += w * r.dv; if (r.g != null) { swg += w; sgg += w * r.g; } }
        if (sw) { const wl = Math.min(1, sw * 400) * fade; du = su / sw * wl; dv = sv / sw * wl; if (swg) dg = sgg / swg * Math.min(1, swg * 400) * fade; }
      }
      u[o] = b[0] + du; v[o] = b[1] + dv;
      const sp = Math.hypot(u[o], v[o]);
      g[o] = b[2] === b[2] ? Math.max(sp, b[2] + dg) : NaN;
    }
  }
  const f = { lat0: B.s, lon0: B.w, dlat: d, dlon: d, nx, ny, times, vars: { u, v, gust: g }, validUntil: times[T - 1], model: 'moja', meta: MOJA_META, run: { runInit: Date.now() },
    weights: ms.st.map(r => ({ id: r.id, w: r.w, mae: r.mae, ratio: r.ratio * (pg[r.id] || 1), dirBias: r.dirBias })) };
  fillTimeGaps(f);
  s.fields.moja = f; if (!s.models.includes('moja')) s.models.push('moja');   // ALADIN stays first; MOJA at the end of the bar
  renderChips();
  return f;
}
// built by itself whenever fresh measurements arrive (and after a new forecast), so MOJA is always current
function autoMoja() { if (!state.obs || !state.set) return; try { const keep = state.modelId; buildMoja(); if (keep === 'moja') { state.wind = state.set.fields.moja; wxLayer.draw(); } } catch (e) { console.warn('MOJA', e); } }
function pressureHtml() {
  const o = state.obs, s = state.set; if (!o || !s) return '';
  const pc = pressureCheck(), ids = s.models.filter(id => !isDerived(id) && s.fields[id] && s.fields[id].vars && s.fields[id].vars.mslp);
  if (!ids.length) return '';
  // pressure level error at the places (hPa) and the measured 3 h tendency against the model's over the same 3 h
  const q = [], lv = {}, td = {};
  for (const p of o.places.filter(p => p.pres != null && !p.stale)) for (const id of ids) {
    const f = s.fields[id]; sample(f, ['mslp'], p.lat, p.lon, p.t * 1000, q); const now_ = q[0]; if (now_ !== now_) continue;
    (lv[id] = lv[id] || []).push(now_ - p.pres);
    if (p.dp3 != null && p.t * 1000 - 3 * 3600000 >= f.times[0]) { sample(f, ['mslp'], p.lat, p.lon, p.t * 1000 - 3 * 3600000, q); if (q[0] === q[0]) (td[id] = td[id] || []).push((now_ - q[0]) - p.dp3); }
  }
  const avg = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const gcell = (g, id) => { const m = g.models[id]; if (m == null) return '<td class="na">–</td>'; const r = Math.abs(m) >= 1 ? g.obs / m : null; const bad = r != null && Math.abs(g.obs) >= 3 && (r > 1.25 || r < 0.8); return `<td class="${bad ? 'mid' : 'ok'}">${m > 0 ? '+' : ''}${m.toFixed(1)}${bad ? `<small>${r > 1 ? 'preslab' : 'prejak'}</small>` : ''}</td>`; };
  return `<h3>Tlak <small>(hPa · gradijent = razlika tlaka koja tjera buru ili jugo)</small></h3>
    <div class="tblwrap"><table class="obst"><tr><th></th><th>Izmj.</th>${ids.map(id => `<th style="color:${mcol(id)}">${modelById(id).name}</th>`).join('')}</tr>
    ${pc.map(g => `<tr><td>${g.name}</td><td><b>${g.obs > 0 ? '+' : ''}${g.obs.toFixed(1)}</b></td>${ids.map(id => gcell(g, id)).join('')}</tr>`).join('')}
    <tr><td>Greška razine tlaka (prosjek)</td><td></td>${ids.map(id => { const a = avg(lv[id]); return a == null ? '<td class="na">–</td>' : `<td class="${Math.abs(a) >= 2 ? 'mid' : 'ok'}">${a > 0 ? '+' : ''}${a.toFixed(1)}</td>`; }).join('')}</tr>
    <tr><td>Promjena u 3 h: model − izmjereno</td><td></td>${ids.map(id => { const a = avg(td[id]); return a == null ? '<td class="na">–</td>' : `<td class="${Math.abs(a) >= 1 ? 'mid' : 'ok'}">${a > 0 ? '+' : ''}${a.toFixed(1)}</td>`; }).join('')}</tr></table></div>
    <div class="note">„Preslab” = model ima manju razliku tlaka od izmjerene → vjerojatno podcjenjuje buru/jugo (MOJA mu podiže brzine). Promjena u 3 h: ako tlak stvarno pada brže od modela (negativan broj), promjena vremena dolazi ranije ili jača nego što model kaže. Vlaga i temperatura zasad ulaze kroz signale (dolazak juga, prodor bure).</div>`;
}
// humidity and temperature: each model against the measured, now and over the last 3 h (does the model see the
// moist jugo air or the cold bura air arriving?)
function humidityHtml() {
  const o = state.obs, s = state.set; if (!o || !s) return '';
  const ids = s.models.filter(id => !isDerived(id) && s.fields[id] && s.fields[id].vars && (s.fields[id].vars.rh || s.fields[id].vars.t2));
  if (!ids.length) return '';
  const q = [], acc = {};
  const add = (id, k, v) => { const a = (acc[id] = acc[id] || {}); (a[k] = a[k] || []).push(v); };
  for (const p of o.places.filter(p => !p.stale && (p.rh != null || p.tair != null))) for (const id of ids) {
    const f = s.fields[id], t = p.t * 1000, t3 = t - 3 * 3600000, has3 = t3 >= f.times[0];
    if (p.rh != null && f.vars.rh) { sample(f, ['rh'], p.lat, p.lon, t, q); const r = q[0]; if (r === r) { add(id, 'rh', r - p.rh); if (has3 && p.drh3 != null) { sample(f, ['rh'], p.lat, p.lon, t3, q); if (q[0] === q[0]) add(id, 'drh', (r - q[0]) - p.drh3); } } }
    if (p.tair != null && f.vars.t2) { sample(f, ['t2'], p.lat, p.lon, t, q); const x = q[0]; if (x === x) { add(id, 't', x - p.tair); if (p.dT1 != null && t - 3600000 >= f.times[0]) { sample(f, ['t2'], p.lat, p.lon, t - 3600000, q); if (q[0] === q[0]) add(id, 'dt', (x - q[0]) - p.dT1); } } }
  }
  const avg = a => a && a.length >= 3 ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const row = (label, k, unit, warn) => `<tr><td>${label}</td>${ids.map(id => { const a = avg((acc[id] || {})[k]); return a == null ? '<td class="na">–</td>' : `<td class="${Math.abs(a) >= warn ? 'mid' : 'ok'}">${a > 0 ? '+' : ''}${a.toFixed(1)}${unit}</td>`; }).join('')}</tr>`;
  return `<h3>Vlaga i temperatura <small>(model − izmjereno, prosjek po plutačama i postajama)</small></h3>
    <div class="tblwrap"><table class="obst"><tr><th></th>${ids.map(id => `<th style="color:${mcol(id)}">${modelById(id).name}</th>`).join('')}</tr>
    ${row('Vlaga sada', 'rh', ' %', 10)}${row('Promjena vlage u 3 h', 'drh', ' %', 8)}${row('Temperatura sada', 't', ' °C', 1.5)}${row('Promjena temperature u 1 h', 'dt', ' °C', 1)}</table></div>
    <div class="note">Vlažan zrak juga i hladan zrak bure dolaze s vjetrom. Model koji kasni s porastom vlage (negativna promjena vlage) ili s padom temperature (pozitivna promjena) vjerojatno kasni i s promjenom vjetra. Model koji ovdje dobro prati mjerenja bolje „vidi” zračnu masu koja stiže.</div>`;
}
// ---------------- the Analysis tab ----------------
function renderAnalysisTab() {
  const el = $('#tab-analysis'), o = state.obs, s = state.set;
  if (!o) { el.innerHTML = '<div class="note">Uključi <b>+ Sada</b> (bočna traka) – mjerenja se učitaju i ovdje se pojavi analiza.</div>'; loadObs().then(() => { if (state.obs) renderAnalysisTab(); }); return; }
  if (!s) { el.innerHTML = '<div class="note">Prvo preuzmi prognozu (kartica Prognoza).</div>'; return; }
  const ms = mojaStats(), mf = s.fields.moja;
  const ids = s.models.filter(id => !isDerived(id) || id === 'moja');
  const now = Date.now() / 1000;
  const pl = o.places.filter(p => !p.stale && p.wspd != null && now - p.t < 3 * 3600).sort((a, b) => (a.kind === 'buoy' ? 0 : 1) - (b.kind === 'buoy' ? 0 : 1) || b.lat - a.lat);
  // cell: vector error (kn, colour by size) and below it the speed error and the direction error
  const cell = e => !e ? '<td class="na">–</td>' : `<td class="${e.vec >= 8 ? 'bad' : e.vec >= 4 ? 'mid' : 'ok'}"><b>${e.vec.toFixed(0)}</b><small>${e.spd > 0 ? '+' : ''}${e.spd.toFixed(0)}${e.dir != null ? ' · ' + Math.round(e.dir) + '°' : ''}</small></td>`;
  const sk = k => ((o.skill || {})[k] || []).filter(r => modelById(r.id));
  const rankRow = (label, rows) => rows.length ? `<tr><td>${label}</td>${rows.slice(0, 5).map((r, i) => `<td class="${i ? '' : 'best'}"><i style="background:${mcol(r.id)}"></i>${modelById(r.id).name} ±${r.mae.toFixed(1)}<small>${r.dir != null ? ' · ' + Math.round(r.dir) + '°' : ''}${Math.abs(r.bias) >= 1.5 ? ` · ${r.bias > 0 ? '+' : ''}${r.bias.toFixed(0)} kn` : ''}</small></td>`).join('')}</tr>` : `<tr><td>${label}</td><td colspan="5" class="muted">skuplja se – arhiva prognoza počela 10.11.</td></tr>`;
  const nowRank = obsRank().map(r => ({ ...r }));
  el.innerHTML = `
    <h3>Rang modela prema mjerenjima <small>(greška cijelog vjetra – snaga i smjer zajedno, kn · prosječna greška smjera ° · snaga + jača / − slabija)</small></h3>
    <table class="rank">${rankRow('Sada', nowRank)}${rankRow('Zadnja 24 h', sk('24h'))}${rankRow('Zadnja 3 dana', sk('72h'))}${rankRow('7 dana', sk('7d'))}${rankRow('7 dana · prvih 12 h', sk('7d_0-12'))}${rankRow('7 dana · 24–48 h unaprijed', sk('7d_24-48'))}</table>
    <h3>MOJA prognoza</h3>
    ${ms ? `<div class="note">Težine prema tome koliko modeli sada pogađaju mjerenja: ${ms.st.map(r => `<b style="color:${mcol(r.id)}">${modelById(r.id).name}</b> ${(r.w * 100).toFixed(0)} %${Math.abs(r.ratio - 1) >= 0.08 ? ` <small>(snaga ×${r.ratio.toFixed(2)})</small>` : ''}${Math.abs(r.dirBias) >= 5 ? ` <small>(smjer ${r.dirBias > 0 ? '−' : '+'}${Math.abs(Math.round(r.dirBias))}°)</small>` : ''}`).join(' · ')}.</div>
      <div class="note"><b>Kako nastaje:</b> 1) svaki model ispravi se za svoje izmjereno odstupanje – snagu (×) i smjer (°); 2) modeli se miješaju s težinama prema grešci cijelog vjetra (za sljedećih 12 h prema kratkoročnoj točnosti, za 1–2 dana prema točnosti na tom roku, kad se skupi arhiva); 3) ako izmjereni gradijent tlaka bure/juga odstupa od modela, brzine se dodatno podignu/spuste; 4) prvih ~6 h prognoza se povlači prema izmjerenoj strelici vjetra (snaga i smjer) i udarima na svakoj plutači i postaji, utjecaj slabi s udaljenošću (~60 km) i vremenom.</div>
      <button id="btnMoja" class="btn primary block">${mf ? '↻ Ponovno izračunaj MOJU prognozu' : 'Izračunaj MOJU prognozu'}</button>
      ${mf ? '<div class="note">MOJA je na kraju trake modela (ljubičasta) – za kartu, replay i routing. ALADIN-HR ostaje prvi.</div>' : ''}` : '<div class="note">Za MOJU prognozu treba bar 4 svježa mjerenja koja modeli pokrivaju.</div>'}
    <h3>Sada: izmjereno i greška modela <small>(veliki broj = greška cijelog vjetra u kn; ispod: snaga ± kn · smjer °; plutače preračunate na 10 m)</small></h3>
    <div class="tblwrap"><table class="obst"><tr><th>Mjesto</th><th>Izmj.</th>${ids.map(id => `<th style="color:${mcol(id)}">${modelById(id).name}${id === 'moja' ? '<small>*</small>' : ''}</th>`).join('')}</tr>
    ${pl.map(p => { const x = p.h === 3 ? p.wspd * U3_10 : p.wspd; return `<tr><td>${p.kind === 'buoy' ? '◆ ' : p.kind === 'lighthouse' ? '○ ' : ''}${p.name}</td><td><b>${x.toFixed(0)}</b>${p.wgust != null ? `<small>/${(p.wgust * (p.h === 3 ? U3_10 : 1)).toFixed(0)}</small>` : ''}<small>${p.wdir != null ? ' ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(p.wdir / 45) % 8] : ''}</small></td>${ids.map(id => cell(obsModelErr(p, s.fields[id]))).join('')}</tr>`; }).join('')}</table></div>
    ${pressureHtml()}
    ${humidityHtml()}
    <h3>Signali iz mreže mjerenja</h3>
    ${(o.signals || []).map(x => `<div class="os ${x.level}">⚠ <b>${x.title}</b><br><small>${x.text}</small></div>`).join('') || '<div class="note">Nema posebnih signala.</div>'}
    <div class="note">Mjerenja: DHMZ (plutače očitane s grafova, obalne postaje), zadnje ${fmtTime(o.created * 1000, false)}. Zeleno = model pogađa (greška < 4 kn), žuto = 4–8 kn, crveno = 8+ kn (kriva snaga ili krivi smjer). *MOJA je za sadašnji trenutak povučena prema ovim mjerenjima, pa ovdje nije u rangu – njezina vrijednost je u satima koji dolaze.</div>`;
  const bm = el.querySelector('#btnMoja');
  if (bm) bm.onclick = () => { bm.disabled = true; bm.textContent = 'Računam…'; setTimeout(() => { const f = buildMoja(); if (f) { selectModel('moja'); toast('MOJA prognoza izračunata – prikazana na karti'); } renderAnalysisTab(); }, 30); };
}
const routeLayer = L.layerGroup().addTo(map);
let boatMarkers = {};
const okRoutes = () => Object.values(state.routes).filter(r => r && r.ok).sort((a, b) => a.eta - b.eta);
const idealId = () => { const o = okRoutes(); return o.length ? o[0].model : null; };   // fastest route of all models = theoretical ideal
// which side the wind blows over: twa = heading − wind direction, so a positive twa means the wind comes over the
// port (left) side = port tack (P, red like the port light); negative = starboard tack (S, green)
const tackTag = twa => twa > 0 ? '<span class="tk tk-p" title="lijeve uzde – vjetar s lijeve strane (port)">P</span>' : twa < 0 ? '<span class="tk tk-s" title="desne uzde – vjetar s desne strane (starboard)">S</span>' : '';
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
    TWA <b>${Math.round(Math.abs(p.twa))}° ${tackTag(p.twa)}</b> · ${p.sail} · <span class="muted">dodir = svi brodići na ovaj trenutak</span></div>`;
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
    // v2.3.11: every route 25 % thinner than 2.3.8 (3 px → 2.25 px); the fastest (★) only ~10 % thicker than the others
    const RW = 0.75;
    const w = best ? 2.5 : 3 * RW;
    if (best) L.polyline(ll, { pane: 'routes', color: '#ffd400', weight: w + 7, opacity: 0.38, interactive: false }).addTo(routeLayer);   // golden glow = fastest
    // dark casing keeps every model colour readable over any wind colour
    L.polyline(ll, { pane: 'routes', color: col === '#111111' ? '#fff' : '#000', weight: w + 3.5 * RW, opacity: sel ? 0.85 : 0.7, interactive: false }).addTo(routeLayer);
    const pl = L.polyline(ll, { pane: 'routes', color: col, weight: w, opacity: 1 }).addTo(routeLayer);
    // a wide invisible line on top makes the route easy to hit with a finger or the mouse
    const hit = L.polyline(ll, { pane: 'routes', color: '#000', weight: 18, opacity: 0.001 }).addTo(routeLayer);
    hit.bindTooltip('', { sticky: true, className: 'rtip', direction: 'top', offset: [0, -10] });
    hit.on('mousemove', e => hit.setTooltipContent(routePointHtml(id, nearestOnRoute(r, e.latlng))));
    hit.on('mouseover', e => hit.setTooltipContent(routePointHtml(id, nearestOnRoute(r, e.latlng))));
    // click / tap: every boat jumps to that moment – you see where each model's boat is at the same time
    hit.on('click', e => { L.DomEvent.stopPropagation(e); replayPause(); const t = nearestOnRoute(r, e.latlng); state.selected = id; drawRoutes.followWind = true; drawRoutes(); setTime(t); showBoatInfo(id); });
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
      .on('click', e => { L.DomEvent.stopPropagation(e); replayPause(); if (state.selected !== id) { state.selected = id; drawRoutes.followWind = true; drawRoutes(); } else { drawRoutes.followWind = true; windOfRoute(); } showBoatInfo(id); }).addTo(routeLayer);
    boatMarkers[id] = mk;
    if (best && entries.length > 1) {
      const p = r.track[Math.floor(r.track.length * 0.42)];
      L.marker([p.lat, p.lon], { pane: 'routes', interactive: false, icon: L.divIcon({ className: 'idealtag', iconSize: [0, 0],
        html: `<div><span class="dot" style="background:${col}"></span>★ NAJBRŽA · ${modelById(id).name} <span class="w">· cilj</span> ${fmtTime(r.eta, false)}</div>` }) }).addTo(routeLayer);
    }
  }
  if (rp.on || drawRoutes.followWind) { drawRoutes.followWind = false; windOfRoute(); }
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
  // wind and speed between two route points change smoothly (as the wind on the map does), not in 10-minute steps
  const lin = k => (a[k] === a[k] && b[k] === b[k] && a[k] != null && b[k] != null) ? a[k] + (b[k] - a[k]) * f : a[k];
  const twd = (a.twd === a.twd && b.twd === b.twd) ? (a.twd + ((((b.twd - a.twd) % 360) + 540) % 360 - 180) * f + 360) % 360 : a.twd;
  return { ...a, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, tws: lin('tws'), gust: lin('gust'), bsp: lin('bsp'), twd };
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
    <span>Brzina <b>${p.bsp.toFixed(1)} kn</b></span><span>TWA <b>${Math.round(Math.abs(p.twa))}° ${tackTag(p.twa)}</b></span></div><div class="bis"><span class="dot" style="background:${p.sailColor}"></span>${p.sail}</div>`}</div>`;
  if (refresh) { boatPopup.setLatLng([p.lat, p.lon]).setContent(html); return; }
  if (boatPopup) map.closePopup(boatPopup);
  boatPopup = L.popup({ className: 'boatpop', closeButton: true, autoPan: false, offset: [0, -12], maxWidth: 220 }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
  boatPopup._ctwId = id;
}

// ---------------- race replay (PredictWind-style) ----------------
// × real time = seconds of race per second of watching. Default 10 s/s: slow enough to follow every manoeuvre and
// sail change without pausing (v2.3.3; was 90 s/s in 2.3 and 300 s/s in 2.2). Changeable while the race runs.
const REPLAY_SPEEDS = [3, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800];   // race seconds per second; the fast ones show the wind developing over hours
if (!localStorage.getItem('ctw.v233replay')) { settings.replaySpeed = 10; localStorage.setItem('ctw.v233replay', '1'); saveSettings(); }
const replaySpeed = () => REPLAY_SPEEDS.includes(settings.replaySpeed) ? settings.replaySpeed : 10;
const speedLabel = v => v >= 300 ? `${v / 60} min/s` : `${v} s/s`;
// how long the whole replay takes at speed v (from the first start to the last finish)
const replayDur = v => { const R = replayRange(); if (!R) return ''; const m = (R.t1 - R.t0) / v / 60000; return m < 1 ? `${Math.round(m * 60)} s` : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`; };
const rp = { on: false, raf: 0, last: 0, lastFull: 0, every: 250, full: 0, pend: false, pendAt: 0, same: 0, heal: 0 };
// the last errors on this device (shown by Postavke → Provjera prikaza)
const errLog = [];
function noteErr(e) { const m = (e && (e.message || e.reason && e.reason.message || e.reason)) || String(e); errLog.push(`${fmtTime(Date.now(), false)} ${String(m).slice(0, 120)}`); if (errLog.length > 6) errLog.shift(); console.error(e); }
addEventListener('error', e => noteErr(e.error || e.message));
addEventListener('unhandledrejection', e => noteErr(e.reason));
function replayRange() {
  const o = okRoutes(); if (!o.length) return null;
  return { t0: Math.min(...o.map(r => r.startTime || r.track[0].t)), t1: Math.max(...o.map(r => r.eta)) };
}
function replayPause() { if (!rp.on) return; rp.on = false; clearInterval(rp.raf); setTime(state.time); renderReplayBar(); }
// the wind on the map must be valid at race time: if the model on screen has no data then (e.g. ICON-2I ending before a
// regatta days ahead – its last state would stay frozen), show the model of the route being followed instead
const coversTime = (id, t) => { const f = state.set && state.set.fields[id]; return !!f && f.times && t >= f.times[0] - 1800000 && t <= lastTime(f) + 1800000; };
function windOfRoute() {
  if (settings.mode !== 'race' || !state.set) return;
  const ok = okRoutes(); if (!ok.length) return;
  const sel = ok.find(r => r.model === state.selected) || ok[0];
  const id = sel.model;
  if (id === state.modelId || !state.set.fields[id]) return;
  state.modelId = id; state.wind = withFallback(state.set, id); renderChips(); wxLayer.draw();
}
// Postavke → Provjera prikaza: on the device itself – is the wind on the map changing with time? (data AND pixels)
function viewCheck() {
  const st = state, s = st.set, H = 3600000, L = [];
  L.push(`Verzija 4.5 · izvor ${s ? s.source || s.quality : '–'} · paket izrađen ${s && s.created ? fmtTime(+s.created) : '–'}`);
  if (!s || !st.wind) { L.push('Nema prognoze na karti'); return L; }
  const f = st.wind, ft = f.times, step = ft.length > 1 ? (ft[1] - ft[0]) / H : 0;
  L.push(`Karta: ${modelById(st.modelId).name} (${st.modelId}) · sloj ${st.layer} · polje je model iz paketa: ${s.fields[st.modelId] === f ? 'da' : 'NE'}`);
  L.push(`Podaci: ${fmtTime(ft[0])} → ${fmtTime(ft[ft.length - 1])} (${ft.length} koraka, ${step} h)${f.ext ? ` + dani 4–15 do ${fmtTime(f.ext.times[f.ext.times.length - 1])}` : ''} · vrijedi do ${fmtTime(lastTime(f))}`);
  const t = st.time, k = ft.findIndex(x => x >= t);
  L.push(`Vrijeme na karti: ${fmtTime(t)} · start ${fmtTime(raceStart())} · koraci oko njega: ${k < 0 ? 'iza kraja modela' : ft.slice(Math.max(0, k - 1), k + 2).map(x => fmtTime(x, false)).join(', ')}`);
  const b = map.getBounds(), pts = [[0.3, 0.3], [0.5, 0.5], [0.7, 0.4], [0.4, 0.7]].map(([a, d]) => [b.getSouth() + (b.getNorth() - b.getSouth()) * a, b.getWest() + (b.getEast() - b.getWest()) * d]);
  const at = tt => pts.map(([la, lo]) => { const o = sample(f, ['u', 'v'], la, lo, tt, []); return o[0] === o[0] ? Math.hypot(o[0], o[1]).toFixed(1) + '/' + Math.round((Math.atan2(-o[0], -o[1]) * 180 / Math.PI + 360) % 360) + '°' : '–'; });
  const a = at(t), z = at(t + 2 * H);
  L.push(`Vjetar (kn/smjer) sada: ${a.join(' ')} · za 2 h: ${z.join(' ')} → podaci se ${a.join() === z.join() ? 'NE mijenjaju' : 'mijenjaju'}`);
  // pixels: draw now and +2 h, compare the wind canvas, put the time back
  const cv = document.querySelector('.leaflet-wx-pane > canvas');
  const hash = () => { try { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let h = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 53) { h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1000000007; if (d[i + 3]) n++; } return [h, n]; } catch (e) { return [String(e.message), 0]; } };
  const wasOn = rp.on; if (wasOn) replayPause();
  wxLayer.draw(); const h0 = hash();
  const t0 = st.time; setTime(t0 + 2 * H); const h1 = hash(); setTime(t0);
  L.push(`Slika vjetra: platno ${cv ? cv.width + '×' + cv.height : 'nema'}, obojenih uzoraka ${h0[1]} · nacrtano za +2 h ${h0[0] === h1[0] ? 'ISTO' : 'drugačije'}`);
  L.push(`Replay: ${rp.on ? 'radi' : 'stoji'} · iscrtavanja ${rp.full} · obnova platna ${rp.heal} · svakih ${Math.round(rp.every)} ms · brzina ${replaySpeed()} s/s`);
  L.push(errLog.length ? 'Greške: ' + errLog.join(' | ') : 'Greške: nema');
  return L;
}
function followRouteWind(t) {
  if (!state.set || coversTime(state.modelId, t)) return;
  const cand = [state.selected, ...okRoutes().map(r => r.model)].filter(Boolean);
  const id = cand.find(x => coversTime(x, t)) || state.set.models.find(x => !isClockW(x) && coversTime(x, t));
  if (!id || id === state.modelId) return;
  state.modelId = id; state.wind = withFallback(state.set, id); renderChips();
  toast(`Prikaz vjetra: ${modelById(id).name} – prati rutu (prethodni model nema prognozu za vrijeme regate)`, 4000);
}
function replayPlay() {
  const R = replayRange(); if (!R) return;
  windOfRoute();                               // replay: the wind of the route being followed (★ fastest by default)
  followRouteWind(Math.max(state.time, R.t0));
  if (playing) { clearInterval(playing); playing = null; }
  if (boatPopup) map.closePopup(boatPopup);
  if (state.time >= R.t1 || state.time < R.t0) setTime(R.t0);
  rp.on = true; rp.last = performance.now(); rp.lastFull = 0; rp.pend = false; rp.same = 0; rp.dh = rp.ph = null; rp.heal = 0;
  clearInterval(rp.raf);
  // full redraw (wind colours, arrows, timeline). Made inside the browser's own drawing turn (requestAnimationFrame) so the
  // screen takes it over; then checked: if the wind DATA under the view changed but the canvas pixels did not, the canvas
  // has stopped accepting drawing (real Safari, long replays) – it is replaced by a fresh one and drawn again
  const full = () => {
    if (!rp.pend) return; rp.pend = false;
    if (!rp.on && state.time < R.t1) return;
    const a = performance.now(); rp.lastFull = a;
    try { followRouteWind(state.time); } catch (e) { noteErr(e); }
    try { setTime(state.time); rp.full++; } catch (e) { noteErr(e); }
    try {
      if (state.colors !== false || state.arrows !== 'none') {
        const dh = wxLayer.dataHash(), ph = wxLayer.pixelHash();
        rp.same = rp.dh != null && dh !== rp.dh && ph === rp.ph ? rp.same + 1 : 0;
        rp.dh = dh; rp.ph = ph;
        if (rp.same >= 2 && rp.heal < 5) { rp.heal++; rp.same = 0; noteErr(new Error('slika vjetra se nije mijenjala – platno obnovljeno')); wxLayer.renew(); wxLayer.draw(); rp.ph = wxLayer.pixelHash(); }
      }
      wxLayer.present();
    } catch (e) { noteErr(e); }
    const cost = performance.now() - a; rp.every = Math.max(250, Math.min(1500, cost * 2.5));   // leave time for the boats
  };
  const tick = () => {
    const now = performance.now();
    if (!rp.on) return clearInterval(rp.raf);
    // race time follows the real clock at the chosen speed, also when a redraw of the wind field takes long (iPad, big
    // screen): earlier each step was capped at 0.1 s, so slow redraws made the whole race crawl
    const dt = Math.min(1000, now - rp.last); rp.last = now;
    const t = Math.min(R.t1, state.time + dt * replaySpeed());
    state.time = t;
    if (t >= R.t1) { rp.on = false; clearInterval(rp.raf); rp.pend = true; full(); renderReplayBar(); return; }
    if (rp.pend) { if (now - rp.pendAt > 400) full(); else updateBoats(); }      // no drawing turn came (background window): draw now
    else if (now - rp.lastFull > rp.every) { rp.pend = true; rp.pendAt = now; requestAnimationFrame(full); updateBoats(); }
    else updateBoats();                                                           // boats every frame
  };
  rp.raf = setInterval(tick, 33);   // timer (not rAF) so the race keeps running in a background window too
  renderReplayBar();
}
function renderReplayBar() {
  const el = $('#replayBar'); if (!el) return;
  if (!playing) setPlayIcon(rp.on);
  const o = okRoutes();
  if (settings.mode !== 'race' || !o.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const sp = replaySpeed();
  el.innerHTML = `<button id="rpPlay" class="rpbtn" title="${rp.on ? 'Pauza' : 'Pokreni utrku'}" aria-label="${rp.on ? 'Pauza' : 'Pokreni utrku'}"><svg viewBox="0 0 24 24" aria-hidden="true">${rp.on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'}</svg></button>
    <span class="rplbl">Brzina</span><select id="rpSpeed" title="Brzina replaya: sekunde utrke u jednoj sekundi · u zagradi trajanje cijelog replaya">${REPLAY_SPEEDS.map(v => `<option value="${v}" ${v === sp ? 'selected' : ''}>${speedLabel(v)} · ${replayDur(v)}</option>`).join('')}</select>
    <div id="rpRank" class="rprank"></div>
    ${o.length > 1 ? `<button id="rpView" class="rpbtn small" title="Prikaz ruta">${settings.routeView === 'one' ? '1 ruta' : 'Sve'}</button>` : ''}`;
  // reacts on touch-down anywhere on the (enlarged) button – no need to hit its centre or hold still until release
  const pb = el.querySelector('#rpPlay');
  pb.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); e.stopPropagation(); rp.on ? replayPause() : replayPlay(); });
  pb.onclick = e => { if (e.detail === 0) rp.on ? replayPause() : replayPlay(); };   // keyboard (Enter/Space) still works
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
  const html = o.slice(0, 4).map((r, i) => `<span class="rk ${r === best ? 'best' : ''} ${state.time >= r.eta ? 'done' : ''}" data-id="${r.model}"><i style="background:${mcol(r.model)}"></i>${r === best ? '★ ' : (i + 1) + '. '}${modelById(r.model).name} <em>${r === best ? '<span class="w">cilj </span>' + fmtTime(r.eta, false) : '+' + fmtDur((r.eta - best.eta) / 3600000)}</em>${state.time >= r.eta ? ' 🏁' : ''}</span>`).join('')
    + (o.length > 4 ? `<span class="rk">+${o.length - 4}</span>` : '');
  if (el._html === html) return;   // unchanged: keep the same chips, so a tap during the replay always hits them
  el._html = html; el.innerHTML = html;
  el.querySelectorAll('.rk[data-id]').forEach(s => s.onclick = () => { state.selected = s.dataset.id; drawRoutes.followWind = true; drawRoutes(); showBoatInfo(s.dataset.id); });
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
      <td><span class="dot" style="background:${mcol(m.id)}"></span>${r === ideal ? '★ ' : ''}${m.name}${r.overPolar ? ' <span title="Vjetar iznad granice polara" style="color:var(--warn,#f2a03d)">⚠</span>' : ''}</td><td class="${r === ideal ? 'best' : ''}">${fmtTime(r.eta, false)}</td>
      <td>${r === ideal ? '<b>idealna</b>' : '+' + fmtDur((r.eta - bestEta) / 3600000)}</td>
      <td>${r === ideal ? '–' : `do ${d.max.toFixed(1)} nm<br><small style="color:var(--muted)">Ø ${d.mean.toFixed(1)}</small>`}</td>
      <td>${s.dist.toFixed(1)}</td><td>${s.avgSog.toFixed(1)}</td><td>${s.tacks}/${s.gybes}</td></tr>`; }).join('')}
    ${rs.filter(r => !r.ok).map(r => `<tr><td><span class="dot" style="background:${mcol(r.model)}"></span>${modelById(r.model).name}</td><td colspan="6" style="text-align:left;color:var(--bad);white-space:normal">${r.error}</td></tr>`).join('')}
    </table>
    <p class="note">Dodirni red za odabir rute. ${ok.some(r => r.overPolar) ? '<b>⚠</b> = na ruti je vjetar jači od granice polara broda. ' : ''}<b>Odstupanje</b> = koliko daleko ruta ide od idealne (najveće / prosječno). <b>T/G</b> = broj okreta kroz vjetar / kroz krmu. ▶ na karti pokreće utrku brodića.</p>
    ${ok.length > 1 ? `<p class="note">Raspon dolaska između modela: <b>${fmtDur(spread)}</b>. ${spread > 2 ? 'Modeli se znatno razilaze – prati razvoj i plan B.' : 'Modeli se dobro slažu.'}</p>` : ''}
    <div class="row"><label>Prikaži izokrone odabrane rute</label><input type="checkbox" id="isoT" ${state.showIso !== false ? 'checked' : ''}></div>
    <div id="routeDetail"></div>
    <h3>Spremanje</h3>
    <div class="note">${state.routesSaved ? '✓ <b>Rute su spremljene</b> – ostaju i nakon zatvaranja aplikacije, dok ih ne obrišeš.' : '<b>Rute nisu spremljene</b> – nestat će kad zatvoriš aplikaciju. Spremi ih ako ih trebaš kasnije (npr. na moru).'}</div>
    <button id="btnSaveRoutes" class="btn block" ${state.routesSaved ? 'disabled' : ''}>💾 Spremi rute</button>
    <button id="btnClearRoutes2" class="btn block danger">🗑 Obriši rute (zauvijek)</button>`;
  el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { state.selected = tr.dataset.id; drawRoutes.followWind = true; drawRoutes(); renderCompareTab(); });
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
  const sails = Object.entries(s.sails).sort((a, b) => b[1] - a[1]).map(([k, h]) => `<span class="dot" style="background:${sailColor(k, r.sailSet || 'melges40')}"></span>${k} ${fmtDur(h)}`).join(' &nbsp; ');
  el.innerHTML = `
    <h3><span class="dot" style="background:${mcol(m.id)}"></span>${m.name} – detalji</h3>
    <div class="kv">
      <div><b>${fmtDur(s.hours)}</b><span>trajanje</span></div><div><b>${s.dist.toFixed(1)} nm</b><span>prijeđeno</span></div><div><b>${s.avgSog.toFixed(1)} kn</b><span>prosj. SOG</span></div>
      <div><b>${s.tacks}</b><span>okreta kroz vjetar</span></div><div><b>${s.gybes}</b><span>kroz krmu</span></div><div><b>${s.sailChanges}</b><span>promjena jedara</span></div>
    </div>
    <div class="note" style="margin-top:10px">Jedra: ${sails}</div>
    ${r.overPolar ? `<div class="note" style="border-left:3px solid #f2a03d;padding-left:8px"><b>⚠ Vjetar iznad granice polara.</b> Na ruti ima vjetra do <b>${r.overPolar.maxTws.toFixed(0)} kn</b> (oko ${fmtDur(r.overPolar.hours)}), a polar broda ide samo do <b>${r.overPolar.top} kn</b>. Iznad toga brzina se računa kao pri ${r.overPolar.top} kn – stvarna brzina (surfanje) može biti veća, a sigurnost i izbor jedara treba procijeniti sam.</div>` : ''}
    <canvas class="chart" id="routeChart"></canvas>
    <div class="note">Graf: TWS (puna), udari (točkasta), BSP (bijela), TWA (siva, desna skala), ispod traka jedara.</div>
    <h3>Točke rute</h3>
    <table class="cmp legs"><tr><th>Vrijeme</th><th>TWD</th><th>TWS</th><th>TWA</th><th>HDG</th><th>BSP</th><th>Jedro</th></tr>
    ${r.track.filter((p, i, a) => i === 0 || p.mark || i === a.length - 1 || Math.floor(p.t / 3600000) !== Math.floor(a[i - 1].t / 3600000)).map(p => `
      <tr data-t="${p.t}"><td>${fmtTime(p.t, false)}${p.mark ? ' 🚩' : ''}</td><td>${Math.round(p.twd)}°</td><td>${p.tws.toFixed(1)}</td><td>${Math.round(Math.abs(p.twa))}° ${tackTag(p.twa)}</td><td>${Math.round(p.hdg)}°</td><td>${p.bsp.toFixed(1)}</td><td><span class="dot" style="background:${p.sailColor}"></span>${p.sail}</td></tr>`).join('')}
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
// Postavke → Obriši ClockW modele: tick the ones to delete (all other forecasts, models and routes stay)
function cwDeleteHtml() {
  const ids = cwIds(state.set);
  if (!ids.length) return '<div class="note">Nema izrađenih ClockW modela.</div>';
  return `${ids.map(id => { const f = state.set.fields[id], info = f.clockw || {};
      return `<label class="check"><input type="checkbox" data-cwsel="${id}"><div><div class="t"><span class="dot" style="background:${mcol(id)}"></span>${modelById(id).name}</div>
        <div class="d">${(info.models || []).map(x => modelById(x).name).join(', ')} · vrijedi do ${fmtTime(f.validUntil)}</div></div></label>`; }).join('')}
    <div class="row" style="gap:6px"><button class="btn" id="cwSelAll" style="flex:1">Odaberi sve</button><button class="btn" id="cwSelNone" style="flex:1">Poništi odabir</button></div>
    <button id="cwDelSel" class="btn block danger" disabled>Obriši odabrane ClockW</button>
    <div class="note">Briše samo označene ClockW modele – ostale prognoze, modeli i rute ostaju.</div>`;
}
function bindCwDelete(el) {
  const box = el.querySelector('#cwDelBox'); if (!box) return;
  const btn = box.querySelector('#cwDelSel'); if (!btn) return;
  const sel = () => [...box.querySelectorAll('[data-cwsel]:checked')].map(x => x.dataset.cwsel);
  const upd = () => { const n = sel().length; btn.disabled = !n; btn.classList.remove('armed'); btn.textContent = n ? `Obriši odabrane ClockW (${n})` : 'Obriši odabrane ClockW'; };
  box.querySelectorAll('[data-cwsel]').forEach(i => i.onchange = upd);
  box.querySelector('#cwSelAll').onclick = () => { box.querySelectorAll('[data-cwsel]').forEach(i => { i.checked = true; }); upd(); };
  box.querySelector('#cwSelNone').onclick = () => { box.querySelectorAll('[data-cwsel]').forEach(i => { i.checked = false; }); upd(); };
  armDelete(btn, 'Odabrani ClockW modeli su obrisani', async () => {
    const ids = sel(); for (const id of ids) await removeClockW(id, false);
    if (state.set) await saveForecast(state.set);
    useSet(state.set);
    box.innerHTML = cwDeleteHtml(); bindCwDelete(el);
  });
}
function renderSettingsTab() {
  const el = $('#tab-settings');
  const p = state.polar;
  const opt = (v, t) => `<option value="${v}" ${state.basemap === v ? 'selected' : ''}>${t}</option>`;
  el.innerHTML = `
    <h3>Karta</h3>
    <div class="row"><label>Podloga</label><select id="basemap">
      ${opt('nautical', 'Nautička – dubine i izobate (offline)')}${opt('offline', 'Tamna obala (offline)')}
      ${opt('emodnet', 'EMODnet batimetrija + OSM obala (online)')}${opt('dark', 'Tamna (online)')}${opt('light', 'Svijetla (online)')}${opt('sat', 'Satelit (online)')}</select></div>
    <div class="row"><label>Detaljno kopno pri zumiranju (mjesta, ceste, reljef – online)</label><input type="checkbox" id="landDet" ${settings.landDetail !== false ? 'checked' : ''}></div>
    <div class="row"><label>OpenSeaMap oznake (svjetionici, plutače)</label><input type="checkbox" id="seam" ${settings.seamarks ? 'checked' : ''}></div>
    <div class="row"><label>Boje vjetra/valova na karti</label><input type="checkbox" id="colors" ${state.colors !== false ? 'checked' : ''}></div>
    <div class="row"><label>Najviša oštrina iscrtavanja (HD)</label><input type="checkbox" id="hires" ${state.hiRes ? 'checked' : ''}></div>
    <div class="row"><label>Boje i preko kopna</label><input type="checkbox" id="ovl" ${state.colorOverLand ? 'checked' : ''}></div>
    <div class="row"><label>Prozirnost boja</label><input type="range" id="opac" min="0.2" max="1" step="0.05" value="${state.opacity}"></div>
    <div class="row"><label>Gustoća čestica</label><input type="range" id="pden" min="0.3" max="2" step="0.1" value="${settings.particleDensity}"></div>
    <div class="note">Izobate: ${ISOBATHS.join(', ')} m. Dubine: EMODnet Bathymetry DTM. Navionics karte su licencirane i ne mogu se ugraditi; za službenu navigaciju koristi plotter / Navionics.</div>
    <h3>Brodovi (polari)</h3>
    ${boats.map(b => `<div class="row"><label><input type="radio" name="boat" value="${b.id}" ${b.id === state.boat.id ? 'checked' : ''}> ${b.name}${sailSetOf(b) ? ' · crossover' : ''}</label>${b.builtin ? '' : `<button class="mini" data-delboat="${b.id}">obriši</button>`}</div>`).join('')}
    <canvas class="chart" id="polarChart" style="height:240px"></canvas>
    <div class="row"><label>Dodaj brod – polar datoteka</label></div>
    <div class="row"><input type="file" id="polarFile" accept=".csv,.txt,.pol,.json,text/plain"></div>
    <div class="note">Podržano: ORC CSV (kao Clockwork), Expedition/B&G/OpenCPN/Adrena TWA×TWS mreže (tab, zarez, točka-zarez ili razmak), transponirane mreže i PredictWind format „TWS TWA BSP TWA BSP…".</div>
    ${sailSetOf(state.boat) ? `<h3>Crossover jedara – ${state.boat.group === 'leeloo' ? 'LeeLoo' : 'Clockwork'}</h3>
    <div class="note">${sailSetOf(state.boat) === 'mat1180' ? 'Iz North Sails MAT1180 crossover charta V1d (J1–J4, A0/MH, A1.5, A2, A4, A5, 1. kratež) – jedro za svaku ćeliju TWA × TWS.' : 'Digitalizirano iz North Sails charta (J1–J4, FRO, A1.5/A2/A4/A5, jib strut, 1. kratež).'} Za uvezene brodove ruta prikazuje kurs (kroz/bočni/krma).</div>
    <canvas class="chart" id="xoverChart" style="height:240px"></canvas>` : ''}
    <h3>Izvori podataka</h3>
    <div class="row"><label>Open-Meteo komercijalni API ključ</label></div>
    <div class="row"><input type="password" id="apikey" class="field" style="flex:1" placeholder="prazno = besplatni limit" value="${settings.apiKey}" autocomplete="off"></div>
    <div class="row"><label>Adresa paketa iz oblaka</label></div>
    <div class="row"><input type="text" id="cloudUrl" class="field" style="flex:1" value="${settings.cloudUrl || CLOUD_DEFAULT}"></div>
    <div class="note">Meteomatics račun i GRIB uvoz su u kartici Prognoza. ALADIN-HR (DHMZ) je u paketu iz oblaka.</div>
    <h3>Aplikacija</h3>
    <div class="row"><label>Animirani Clockwork logo pri pokretanju</label><input type="checkbox" id="introT" ${(() => { try { return localStorage.getItem('ctw.intro') !== 'off'; } catch { return true; } })() ? 'checked' : ''}></div>
    <button id="introPlay" class="btn block">Pokaži animaciju</button>
    <button id="viewCheck" class="btn block">Provjera prikaza</button>
    <div id="viewCheckOut" class="note" style="white-space:pre-line;user-select:text;-webkit-user-select:text"></div>
    <div class="note">Verzija 4.5 · Instaliraj: Safari → Dijeli → „Dodaj na početni zaslon" (iPhone/iPad) ili Safari → Datoteka → „Dodaj u Dock" (Mac).</div>
    <h3>Obriši ClockW modele</h3>
    <div id="cwDelBox">${cwDeleteHtml()}</div>
    <h3>Obriši sve</h3>
    <button id="clearData" class="btn warn block">Obriši spremljene prognoze i rute</button>`;
  el.querySelector('#basemap').onchange = e => { state.basemap = settings.basemap = e.target.value; saveSettings(); applyBasemap(); };
  el.querySelector('#seam').onchange = e => { settings.seamarks = e.target.checked; saveSettings(); applyBasemap(); };
  el.querySelector('#landDet').onchange = e => { settings.landDetail = e.target.checked; saveSettings(); updateLandDetail(); toast(e.target.checked ? `Detaljno kopno od zuma ${LAND_DETAIL_Z} (uz internet)` : 'Detaljno kopno isključeno'); };
  el.querySelector('#colors').onchange = e => { state.colors = settings.colors = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#viewCheck').onclick = () => { const o = el.querySelector('#viewCheckOut'); try { o.textContent = viewCheck().join('\n'); } catch (e) { o.textContent = 'Provjera nije uspjela: ' + e.message; } };
  el.querySelector('#hires').onchange = e => { state.hiRes = settings.hiRes = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#ovl').onchange = e => { state.colorOverLand = settings.colorOverLand = e.target.checked; saveSettings(); wxLayer.draw(); };
  el.querySelector('#opac').oninput = e => { state.opacity = settings.opacity = +e.target.value; saveSettings(); wxLayer.draw(); };
  el.querySelector('#pden').onchange = e => { settings.particleDensity = state.particleDensity = +e.target.value; saveSettings(); particleLayer.seed(); };
  el.querySelector('#apikey').onchange = e => { settings.apiKey = e.target.value.trim(); saveSettings(); };
  el.querySelector('#cloudUrl').onchange = e => { settings.cloudUrl = e.target.value.trim(); saveSettings(); };
  el.querySelectorAll('input[name=boat]').forEach(r => r.onchange = () => { selectBoat(r.value); renderSettingsTab(); });
  el.querySelectorAll('[data-delboat]').forEach(b => b.onclick = async () => { boats = boats.filter(x => x.id !== b.dataset.delboat); await saveBoats(); selectBoat(boats.some(x => x.id === settings.boatId) ? settings.boatId : 'melges40'); renderSettingsTab(); });
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
  bindCwDelete(el);
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
  const set = sailSetOf(state.boat) || 'melges40', labels = {};
  for (let a = 30; a < 180; a += 2) for (let v = 2; v < 35; v += 0.5) { const r = recommendSail(a, v, set); const L = labels[r.sail] || (labels[r.sail] = [0, 0, 0]); L[0] += a; L[1] += v; L[2]++; c.fillStyle = r.color; c.globalAlpha = r.reef ? 0.55 : 0.85; c.fillRect(X(a), Y(v + 0.5), X(a + 2) - X(a) + 0.5, Y(v) - Y(v + 0.5) + 0.5); }
  c.globalAlpha = 1; c.fillStyle = '#cfd8e3'; c.font = '10px system-ui';
  for (let a = 30; a <= 180; a += 30) c.fillText(a + '°', X(a) - 8, h - 3);
  for (let v = 5; v <= 35; v += 5) c.fillText(v, 4, Y(v) + 3);
  c.font = '700 11px system-ui'; c.fillStyle = '#111';
  Object.entries(labels).forEach(([n, [sa, sv, k]]) => c.fillText(n, X(sa / k) - 8, Y(sv / k)));   // label at the centre of each sail's area
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
  // v2.3.2: the cloud package (ICON-2I, ICON-D2, ICON-EU, ECMWF, GFS · up to 15 days · no limits) is the source for everyone
  if (!localStorage.getItem('ctw.v232src')) { settings.source = 'cloud'; localStorage.setItem('ctw.v232src', '1'); }
  // remove copies of earlier cloud packages that older versions left in the browser cache (they filled the storage)
  if ('caches' in window) caches.keys().then(ks => ks.forEach(k => caches.open(k).then(c => c.keys().then(rs => rs.forEach(r => { if (/\.ctw(\?|$)|[?&]t=\d/.test(r.url)) c.delete(r); }))))).catch(() => {});
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
  // the map must always fill the screen: after turning the iPad, Split View or a toolbar change iOS sometimes reports the
  // new size late – the map then kept the old width and the right part of the screen stayed white
  const refit = () => { const el = map.getContainer(), sz = map.getSize(); if (Math.abs(el.clientWidth - sz.x) > 1 || Math.abs(el.clientHeight - sz.y) > 1) { map.invalidateSize({ pan: false }); chartLayer.draw(); depthLayer.draw(); wxLayer.draw(); } };
  if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(refit)).observe(map.getContainer());
  for (const ev of ['orientationchange', 'resize', 'pageshow']) addEventListener(ev, () => [50, 300, 800, 1600].forEach(d => setTimeout(refit, d)));
  if (window.visualViewport) visualViewport.addEventListener('resize', () => setTimeout(refit, 100));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(refit, 100); });
  if (settings.mode !== 'race') routeLayer.remove();
  updateModePill();
  const home = () => { const b = state.set && state.set.bbox; if (settings.mode === 'forecast' && b) map.fitBounds([[b.s, b.w], [b.n, b.e]]); else zoomCourse(); };
  home();
  wxLayer.draw();
  setTimeout(() => { map.invalidateSize(); if (map.getZoom() < 7) home(); maybeFillWindow(200); }, 600);
  if (settings.source === 'cloud' && navigator.onLine && (!state.set || state.set.source !== 'cloud')) setTimeout(() => doDownload().catch(() => {}), 1200);
  // a saved cloud forecast older than 3 h: fetch the newer package quietly (routes and view stay)
  else if (settings.source === 'cloud' && navigator.onLine && state.set && Date.now() - (+state.set.created || 0) > 3 * 3600000)
    setTimeout(() => loadCloud(null, null, true).then(() => toast('Prognoza osvježena iz oblaka', 2500)).catch(() => {}), 1500);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // a new version takes over by itself: when the new service worker is active the app reloads once (no double restart)
    const hadCtl = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtl && !reloaded && !rp.on && !dlBusy) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update().catch(() => {}); document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }); }).catch(e => console.warn('sw', e));
  }
  // model-run watcher: tells you when a newer run is available than the one you raced with
  const watch = async () => { if (state.set && navigator.onLine) { state.newRuns = await checkNewRuns(state.set).catch(() => []); renderChips(); $('#btnRefresh').classList.toggle('badge', state.newRuns.length > 0); } };
  watch(); setInterval(watch, 20 * 60000);
  setInterval(() => { if (!state.set) return; if (pruneClockW(state.set)) { saveForecast(state.set); useSet(state.set); } setTime(state.time); }, 60000); // keep countdown fresh · expired ClockW go
})();
window.ctw = { state, settings, course, map,
  fn: { viewCheck, courseKey, savedMap, showSavedRoutes, saveRoutes, clearCourse, clearRoutes, busy: () => dlBusy || longBusy, uncovered: () => uncoveredShare(), setExtent, dlArea, replayPlay, replayPause, showBoatInfo, setRouteView, deviation, manoeuvres, okRoutes, runRouting, loadCloud, drawCourse, setTime, openSheet, selectModel, renderDataTab, startAreaPick, exportPackage, importPackage, routeAt, longCovered: () => longCovered(state.set), fcDays, doDownload, useSet, dbg: () => { const s = state.set; return { dl: dlBusy, long: longBusy, pend: !!pendingLong, fill: !!fillTimer, unc: +(uncoveredShare() * 100).toFixed(1), t: new Date(state.time).toISOString().slice(5, 16), mode: settings.mode, area: areaSel(), src: settings.source, z: map.getZoom(), lt: s && s.longTried ? Math.round((Date.now() - s.longTried) / 1000) : null, models: s ? s.models.map(id => id.replace('dir_', '') + ':' + (s.fields[id].times ? new Date(ownEnd(s.fields[id])).toISOString().slice(5, 13) : '?')).join(' ') : '', txt: (($('#dlText') || {}).textContent || '').slice(0, 60), toast: (($('#toast') || {}).textContent || '').slice(0, 50) }; },
    showObs: p => showObs(p), viewCheckLite: () => ({ full: rp.full, every: Math.round(rp.every), on: rp.on, heal: rp.heal, err: errLog.slice(-2) }), wx: () => wxLayer, markLayer: () => markLayer, routeLayer: () => routeLayer, wx: () => wxLayer, particles: () => particleLayer, chart: () => chartLayer } };

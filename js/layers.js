// Map rendering: weather colour field, arrows/barbs, Windy-style particles, offline land + coastline.
import { sample, coverage } from './field.js';
import { isLand } from './landmask.js';
import { DEPTH_LUT, isobaths } from './bathy.js';
import { speedDirFromUV } from './geo.js';

// ---------- colour scales ----------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function scale(stops) {
  const s = stops.map(([v, c, a = 1]) => [v, hex(c), a]);
  const lut = new Uint8ClampedArray(1024 * 4);
  const lo = s[0][0], hi = s[s.length - 1][0];
  for (let i = 0; i < 1024; i++) {
    const v = lo + (hi - lo) * i / 1023;
    let k = 0; while (k < s.length - 2 && s[k + 1][0] < v) k++;
    const [v0, c0, a0] = s[k], [v1, c1, a1] = s[k + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    lut[i * 4] = c0[0] + (c1[0] - c0[0]) * t;
    lut[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * t;
    lut[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * t;
    lut[i * 4 + 3] = 255 * (a0 + (a1 - a0) * t);
  }
  return { stops, lo, hi, lut, idx: v => Math.max(0, Math.min(1023, Math.round((v - lo) / (hi - lo) * 1023))) };
}

// Sailing (PredictWind-style) knots scale. Edit the stops here or in Postavke → Boje vjetra.
export const WIND_STOPS = [[0, '#8f8fdc'], [3, '#6b7fe0'], [6, '#4a9be6'], [9, '#38c1e0'], [12, '#3ad39a'], [15, '#5fd848'], [18, '#c4e43c'],
  [21, '#ffe23a'], [24, '#ffb22e'], [27, '#ff7a26'], [30, '#f2382c'], [35, '#d8256f'], [40, '#b12eb7'], [50, '#6b2394']];
const WIND = WIND_STOPS;
export const LAYERS = {
  wind:    { name: 'Vjetar', unit: 'kn', vars: ['u', 'v'], src: 'wx', scale: scale(WIND), value: (a) => Math.hypot(a[0], a[1]), legend: [0, 5, 10, 15, 20, 25, 30, 35, 40] },
  gust:    { name: 'Udari', unit: 'kn', vars: ['gust'], src: 'wx', scale: scale(WIND), value: a => a[0], legend: [0, 5, 10, 15, 20, 25, 30, 35, 40] },
  waves:   { name: 'Valovi', unit: 'm', vars: ['wave', 'waveDir'], src: 'marine', scale: scale([[0, '#24508f'], [0.25, '#2b78b8'], [0.5, '#2fa3c0'], [1, '#3bbb8e'], [1.5, '#a6d145'], [2, '#f2cf35'], [3, '#f0832a'], [4, '#d63a3a'], [6, '#8f2a8f']]), value: a => a[0], legend: [0, 0.5, 1, 1.5, 2, 3, 4] },
  current: { name: 'Struje', unit: 'kn', vars: ['cu', 'cv'], src: 'marine', scale: scale([[0, '#1d3557'], [0.15, '#245d8f'], [0.3, '#2a86b8'], [0.5, '#39b39c'], [0.75, '#c9d64a'], [1, '#f2c037'], [1.5, '#f08a2a'], [2.5, '#e03a3a']]), value: a => Math.hypot(a[0], a[1]), legend: [0, 0.25, 0.5, 1, 1.5, 2] },
  rain:    { name: 'Kiša', unit: 'mm/h', vars: ['precip'], src: 'wx', scale: scale([[0, '#000000', 0], [0.1, '#9fd8ff', 0], [0.2, '#9fd8ff', 0.75], [0.5, '#4fb0ff', 0.85], [1, '#2f6fe0', 0.9], [3, '#2fb24c', 0.9], [6, '#f2d43a', 0.95], [10, '#f08a24', 0.95], [20, '#d7263d', 1], [40, '#a020a0', 1]]), value: a => a[0], legend: [0.2, 1, 3, 6, 10, 20] },
  conf:    { name: 'Pouzdanost ClockW', unit: '%', vars: ['conf'], src: 'wx', scale: scale([[0, '#c62828'], [30, '#ef6c00'], [50, '#f9a825'], [70, '#c0ca33'], [85, '#43a047'], [100, '#1b7f3b']]), value: a => a[0], legend: [0, 25, 50, 75, 100] },
  storm:   { name: 'Grmljavina', unit: 'J/kg', vars: ['cape', 'lpi'], src: 'wx', scale: scale([[0, '#000000', 0], [150, '#fff3b0', 0], [300, '#fff3b0', 0.55], [700, '#f7c948', 0.75], [1200, '#f08c2e', 0.85], [2000, '#e03a3a', 0.9], [3000, '#9b2c9b', 0.95]]), value: a => a[0], legend: [300, 700, 1200, 2000, 3000] },
};
export const windScale = LAYERS.wind.scale;
export function colorFor(layer, v) {
  const s = LAYERS[layer].scale, i = s.idx(v) * 4;
  return `rgba(${s.lut[i]},${s.lut[i + 1]},${s.lut[i + 2]},${s.lut[i + 3] / 255})`;
}

// ---------- helper: custom canvas pane that tracks the viewport ----------
// resize an offscreen canvas only when its size changes (a new bitmap otherwise); the caller overwrites or clears it
const sizeTo = (cv, W, H) => { if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H; };
function makeCanvasPane(map, name, z) {
  const pane = map.createPane(name);
  pane.style.zIndex = z;
  pane.style.pointerEvents = 'none';
  const canvas = L.DomUtil.create('canvas', 'ctw-canvas', pane);
  const ctx = canvas.getContext('2d');
  // the backing store is (re)allocated only when the size really changes: assigning canvas.width – even the same value –
  // allocates a new full-screen bitmap, and iOS Safari, with its hard canvas-memory limit, stops drawing into the canvas
  // when the replay redraws several times a second (the last picture stayed frozen on the map)
  const fit = () => {
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.x * dpr), H = Math.round(size.y * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      canvas.style.width = size.x + 'px'; canvas.style.height = size.y + 'px';
    }
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  return { pane, canvas, ctx, fit };
}

// latitude for each screen row (mercator) + linear longitude
function viewGeometry(map, step) {
  const size = map.getSize();
  const W = Math.ceil(size.x / step) + 1, H = Math.ceil(size.y / step) + 1;
  const lats = new Float64Array(H), lons = new Float64Array(W);
  for (let y = 0; y < H; y++) lats[y] = map.containerPointToLatLng([0, y * step]).lat;
  const w = map.containerPointToLatLng([0, 0]).lng, e = map.containerPointToLatLng([size.x, 0]).lng;
  for (let x = 0; x < W; x++) lons[x] = w + (e - w) * (x * step) / size.x;
  return { W, H, lats, lons, size };
}

// ---------- weather field layer ----------
export class WeatherLayer {
  constructor(map, state) {
    this.map = map; this.state = state;
    this.p = makeCanvasPane(map, 'wx', 250);
    this.off = document.createElement('canvas');
    const redraw = () => this.draw();
    map.on('moveend zoomend resize viewreset', redraw);
    map.on('move', () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); });
    map.on('zoomstart', () => { this.p.canvas.style.opacity = 0; });
    map.on('zoomend', () => { this.p.canvas.style.opacity = 1; });
  }
  draw() {
    const { map, state } = this; const { ctx } = this.p;
    this.p.fit();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    const layer = LAYERS[state.layer];
    const f = layer.src === 'marine' ? state.marine : state.wind;
    if (!f) return;
    if (state.colors !== false) {
      const step = state.hiRes ? 1.5 : 2;   // CSS px per sample; the image is smoothed when scaled up
      const g = viewGeometry(map, step);
      sizeTo(this.off, g.W, g.H);
      const octx = this.off.getContext('2d');
      const img = octx.createImageData(g.W, g.H);
      const d = img.data, lut = layer.scale.lut, out = [];
      const t = state.time, op = state.opacity;
      for (let y = 0; y < g.H; y++) {
        const lat = g.lats[y];
        for (let x = 0; x < g.W; x++) {
          const cov = coverage(f, lat, g.lons[x], t, layer.src !== 'marine');
          if (cov <= 0) continue;
          sample(f, layer.vars, lat, g.lons[x], t, out);
          const v = layer.value(out);
          if (v !== v) continue;
          const i = layer.scale.idx(v) * 4, o = (y * g.W + x) * 4;
          d[o] = lut[i]; d[o + 1] = lut[i + 1]; d[o + 2] = lut[i + 2]; d[o + 3] = lut[i + 3] * op * cov;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.off, -step / 2, -step / 2, g.W * step, g.H * step);
      // crisp cut along the vector coastline (colours only over the sea)
      if (!state.colorOverLand && hasLand(state)) {
        ctx.save(); ctx.globalCompositeOperation = 'destination-out';
        fillLand(ctx, map, state, '#000');
        ctx.restore();
      }
    }
    if (state.arrows !== 'none') this.drawArrows(ctx, layer, f, size);
    this.drawOverlays(ctx, size);
  }
  // stackable overlays, independent of the main colour layer (and of any race/routing)
  drawOverlays(ctx, size) {
    const { map, state } = this, out = [];
    if (state.ovIsobars) drawIsobars(ctx, map, state, state.modelName);
    // rain: semi-transparent colour only where it actually rains
    if (state.ovRain && state.layer !== 'rain' && state.wind) {
      const step = 4, g = viewGeometry(map, step), L = LAYERS.rain;
      const off = this.offRain || (this.offRain = document.createElement('canvas')); sizeTo(off, g.W, g.H);
      const octx = off.getContext('2d'), img = octx.createImageData(g.W, g.H), d = img.data, lut = L.scale.lut;
      for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
        sample(state.wind, ['precip'], g.lats[y], g.lons[x], state.time, out);
        if (!(out[0] >= 0.2)) continue;
        const i = L.scale.idx(out[0]) * 4, o = (y * g.W + x) * 4;
        d[o] = lut[i]; d[o + 1] = lut[i + 1]; d[o + 2] = lut[i + 2]; d[o + 3] = lut[i + 3] * 0.8;
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, g.W * step, g.H * step);
    }
    const m = state.marine; if (!m) return;
    const gap = (state.arrowGap || 46) * 1.5;
    const grid = (offX, offY, fn) => {
      for (let y = gap / 2 + offY; y < size.y; y += gap) for (let x = gap / 2 + offX; x < size.x; x += gap) {
        const ll = map.containerPointToLatLng([x, y]);
        if (state.landAt && state.landAt(ll.lat, ll.lng)) continue;
        fn(x, y, ll);
      }
    };
    ctx.font = '700 10px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center';
    if (state.ovWaves && state.layer !== 'waves') grid(gap * 0.25, gap * 0.3, (x, y, ll) => {
      sample(m, ['wave', 'waveDir'], ll.lat, ll.lng, state.time, out);
      if (!(out[0] > 0.05)) return;
      drawArrow(ctx, x, y, (out[1] + 180) % 360, 12 + Math.min(18, out[0] * 7), '#ffffff', 'rgba(10,30,60,.95)');
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,30,60,.85)'; ctx.strokeText(out[0].toFixed(1) + ' m', x, y + 20);
      ctx.fillStyle = '#ffffff'; ctx.fillText(out[0].toFixed(1) + ' m', x, y + 20);
    });
    if (state.ovCurrents && state.layer !== 'current') grid(-gap * 0.25, -gap * 0.3, (x, y, ll) => {
      sample(m, ['cu', 'cv'], ll.lat, ll.lng, state.time, out);
      const spd = Math.hypot(out[0], out[1]);
      if (!(spd > 0.05)) return;
      const dirTo = (Math.atan2(out[0], out[1]) * 180 / Math.PI + 360) % 360;
      drawArrow(ctx, x, y, dirTo, 10 + Math.min(20, spd * 20), '#00e5ff', 'rgba(0,25,40,.95)');
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,25,40,.85)'; ctx.strokeText(spd.toFixed(1) + ' kn', x, y + 20);
      ctx.fillStyle = '#7ff3ff'; ctx.fillText(spd.toFixed(1) + ' kn', x, y + 20);
    });
  }
  drawArrows(ctx, layer, f, size) {
    const { map, state } = this;
    const kind = state.layer;
    if (!['wind', 'gust', 'waves', 'current', 'conf'].includes(kind)) return;
    const gap = state.arrowGap || 46;
    const out = [];
    for (let y = gap / 2; y < size.y; y += gap) {
      for (let x = gap / 2; x < size.x; x += gap) {
        const ll = map.containerPointToLatLng([x, y]);
        if (onLand(map, state, x, y, ll)) continue;
        if (coverage(f, ll.lat, ll.lng, state.time) < 0.5) continue;   // no arrows in the faded edge of the model's area
        let spd, dirTo;
        if (kind === 'waves') {
          sample(f, ['wave', 'waveDir'], ll.lat, ll.lng, state.time, out);
          if (out[0] !== out[0]) continue; spd = out[0]; dirTo = (out[1] + 180) % 360;
          drawArrow(ctx, x, y, dirTo, 10 + Math.min(16, spd * 6), 'rgba(10,20,40,.85)', 'rgba(255,255,255,.9)');
          continue;
        }
        if (kind === 'current') {
          sample(f, ['cu', 'cv'], ll.lat, ll.lng, state.time, out);
          if (out[0] !== out[0]) continue; spd = Math.hypot(out[0], out[1]); dirTo = (Math.atan2(out[0], out[1]) * 180 / Math.PI + 360) % 360;
          if (spd < 0.05) continue;
          drawArrow(ctx, x, y, dirTo, 8 + Math.min(20, spd * 18), 'rgba(10,20,40,.85)', 'rgba(255,255,255,.9)');
          continue;
        }
        sample(f, ['u', 'v', 'gust'], ll.lat, ll.lng, state.time, out);
        if (out[0] !== out[0]) continue;
        const [tws, twd] = speedDirFromUV(out[0], out[1]);
        const s = kind === 'gust' && out[2] === out[2] ? out[2] : tws;
        // v2.3: wind arrows 10 % smaller and a touch lighter (were almost black)
        if (state.arrows === 'barbs') drawBarb(ctx, x, y, twd, s, WIND_ARROW.scale);
        else drawArrow(ctx, x, y, (twd + 180) % 360, (10 + Math.min(22, s * 0.7)) * WIND_ARROW.scale, WIND_ARROW.fill, 'rgba(255,255,255,.95)', WIND_ARROW.scale);
        if (state.showNumbers) {
          ctx.font = '600 11px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.strokeText(Math.round(s), x, y + 21);
          ctx.fillStyle = '#fff'; ctx.fillText(Math.round(s), x, y + 21);
        }
      }
    }
  }
}

export const WIND_ARROW = { scale: 0.9, fill: 'rgba(20,30,50,.88)' };   // was 1.0 / rgba(12,18,30,.9)
function drawArrow(ctx, x, y, dirTo, len, fill, halo, k = 1) {
  const a = dirTo * Math.PI / 180;
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  const L = len, h = Math.max(5 * k, L * 0.38);
  ctx.beginPath();
  ctx.moveTo(0, L / 2); ctx.lineTo(0, -L / 2 + h * 0.6);
  ctx.lineWidth = 3.6 * k; ctx.strokeStyle = halo; ctx.lineCap = 'round'; ctx.stroke();
  ctx.lineWidth = 1.6 * k; ctx.strokeStyle = fill; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -L / 2); ctx.lineTo(h * 0.45, -L / 2 + h); ctx.lineTo(-h * 0.45, -L / 2 + h); ctx.closePath();
  ctx.lineWidth = 2 * k; ctx.strokeStyle = halo; ctx.stroke(); ctx.fillStyle = fill; ctx.fill();
  ctx.restore();
}

function drawBarb(ctx, x, y, dirFrom, kn, k = 1) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(dirFrom * Math.PI / 180); ctx.scale(k, k);
  const L = 24;
  const draw = (color, w) => {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -L); ctx.stroke();
    let k = Math.round(kn / 5) * 5, pos = -L;
    while (k >= 50) { ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(10, pos + 3); ctx.lineTo(0, pos + 6); ctx.fill(); pos += 8; k -= 50; }
    while (k >= 10) { ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(10, pos - 4); ctx.stroke(); pos += 5; k -= 10; }
    if (k >= 5) { if (pos === -L) pos += 4; ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(5, pos - 2); ctx.stroke(); }
  };
  draw('rgba(255,255,255,.9)', 3.4); draw(k < 1 ? WIND_ARROW.fill : 'rgba(12,18,30,.95)', 1.4);
  ctx.beginPath(); ctx.arc(0, 0, 2, 0, 7); ctx.fill();
  ctx.restore();
}


// ---------- isobars (mean sea level pressure), on demand ----------
// from the model on the map; a model without pressure (ALADIN-HR sailing files) borrows it from the next best one
const ISO_PREF = ['dir_arpege', 'dir_icon_eu', 'dir_icon_d2', 'italia_meteo_arpae_icon_2i', 'dir_ecmwf', 'dir_gfs'];
function isoSource(state) {
  const t = state.time, out = [], ok = f => { if (!f || !f.vars) return false; const g = f.ext && t > f.times[f.times.length - 1] ? f.ext : f; if (!g.vars || !g.vars.mslp) return false; const c = g.lat0 + g.dlat * (g.ny >> 1), d = g.lon0 + g.dlon * (g.nx >> 1); sample(f, ['mslp'], c, d, t, out); return out[0] === out[0]; };
  if (ok(state.wind)) return { f: state.wind, id: state.modelId };
  const s = state.set; if (!s) return null;
  for (const id of [...ISO_PREF, ...s.models]) if (s.fields[id] && ok(s.fields[id])) return { f: s.fields[id], id };
  return null;
}
export function drawIsobars(ctx, map, state, nameOf = id => id) {
  const src = isoSource(state); if (!src) return;
  const size = map.getSize(), step = 14, W = Math.ceil(size.x / step) + 1, Hh = Math.ceil(size.y / step) + 1;
  const P = new Float32Array(W * Hh), out = [];
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
    const ll = map.containerPointToLatLng([i * step, j * step]);
    sample(src.f, ['mslp'], ll.lat, ll.lng, state.time, out);
    const v = out[0]; P[j * W + i] = v;
    if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!(hi > lo)) return;
  ctx.save(); ctx.lineJoin = 'round';
  const labels = [];
  for (let L = Math.ceil(lo / 2) * 2; L <= hi; L += 2) {
    const major = L % 10 === 0, segs = [];
    for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
      const a = P[j * W + i], b = P[j * W + i + 1], c = P[(j + 1) * W + i + 1], d = P[(j + 1) * W + i];
      if (!(a === a && b === b && c === c && d === d)) continue;
      const x = i * step, y = j * step, pts = [];
      const cut = (p, q, x1, y1, x2, y2) => { if ((p < L) !== (q < L)) { const k = (L - p) / (q - p); pts.push([x1 + (x2 - x1) * k, y1 + (y2 - y1) * k]); } };
      cut(a, b, x, y, x + step, y); cut(b, c, x + step, y, x + step, y + step); cut(c, d, x + step, y + step, x, y + step); cut(d, a, x, y + step, x, y);
      if (pts.length >= 2) segs.push([pts[0], pts[1]]);
      if (pts.length === 4) segs.push([pts[2], pts[3]]);
    }
    if (!segs.length) continue;
    ctx.beginPath(); for (const [p, q] of segs) { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); }
    ctx.lineWidth = major ? 3.6 : 2.6; ctx.strokeStyle = 'rgba(10,20,40,.45)'; ctx.stroke();
    ctx.lineWidth = major ? 1.8 : 1; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
    // a label now and then along the line, never two close together
    for (let k = 0; k < segs.length; k += 7) {
      const [p] = segs[k];
      if (p[0] < 24 || p[1] < 16 || p[0] > size.x - 24 || p[1] > size.y - 16) continue;
      if (labels.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 170)) continue;
      labels.push([p[0], p[1], L]);
    }
  }
  // centres of high (V) and low (N) pressure: the extreme within ~100 px that stands out from its surroundings
  const R = 7, marks = [];
  for (let j = 2; j < Hh - 2; j++) for (let i = 2; i < W - 2; i++) {
    const v = P[j * W + i]; if (v !== v) continue;
    let isMax = true, isMin = true, sum = 0, n = 0;
    for (let dj = -R; dj <= R && (isMax || isMin); dj++) for (let di = -R; di <= R; di++) { const jj = j + dj, ii = i + di; if (jj < 0 || ii < 0 || jj >= Hh || ii >= W) continue; const w = P[jj * W + ii]; if (w !== w) continue; if (w > v) isMax = false; if (w < v) isMin = false; sum += w; n++; }
    if (!n) continue; const m = sum / n;
    const near = q => Math.hypot(q[0] - i * step, q[1] - j * step) < 120;
    if (isMax && v - m > 0.8 && !marks.some(near)) marks.push([i * step, j * step, 'V', v]);
    else if (isMin && m - v > 0.8 && !marks.some(near)) marks.push([i * step, j * step, 'N', v]);
  }
  ctx.font = '700 10px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, y, L] of labels) { if (marks.some(q => Math.hypot(q[0] - x, q[1] - y) < 40)) continue; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,20,40,.9)'; ctx.strokeText(String(L), x, y); ctx.fillStyle = '#fff'; ctx.fillText(String(L), x, y); }
  for (const [x, y, k, v] of marks.slice(0, 8)) {
    ctx.font = '800 20px -apple-system,system-ui,sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,20,40,.9)';
    ctx.strokeText(k, x, y); ctx.fillStyle = k === 'V' ? '#7fb2ff' : '#ff6b6b'; ctx.fillText(k, x, y);
    ctx.font = '700 10px -apple-system,system-ui,sans-serif'; ctx.lineWidth = 3; ctx.strokeText(v.toFixed(0), x, y + 15); ctx.fillStyle = '#fff'; ctx.fillText(v.toFixed(0), x, y + 15);
  }
  // source of the pressure field, when it is not the model on the map
  if (src.id !== state.modelId) {
    ctx.font = '600 11px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,20,40,.9)';
    const t = `Izobare: ${nameOf(src.id)}`; ctx.strokeText(t, 12, 84); ctx.fillStyle = '#fff'; ctx.fillText(t, 12, 84);
  }
  ctx.restore();
}

// ---------- particles (animated flow) ----------
export class ParticleLayer {
  constructor(map, state) {
    this.map = map; this.state = state;
    this.p = makeCanvasPane(map, 'particles', 320);
    this.parts = [];
    this.running = false;
    map.on('movestart zoomstart', () => { this.p.ctx.clearRect(0, 0, 1e5, 1e5); this.pause = true; });
    map.on('moveend zoomend resize', () => { this.p.fit(); this.p.ctx.clearRect(0, 0, 1e5, 1e5); this.seed(); this.pause = false; });
    this.p.fit();
  }
  seed() {
    const size = this.map.getSize();
    const n = Math.round(Math.min(4000, size.x * size.y / 260) * (this.state.particleDensity || 1));
    this.parts = Array.from({ length: n }, () => this.rand(size));
  }
  rand(size) { return { x: Math.random() * size.x, y: Math.random() * size.y, age: Math.floor(Math.random() * 140) }; }
  start() {
    if (this.running) return; this.running = true; this.seed();
    const out = [];
    let last = performance.now();
    const tick = (now = performance.now()) => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0.005, (now - last) / 1000)); last = now;
      const st = this.state;
      const { ctx } = this.p, size = this.map.getSize();
      if (this.pause || !st.particles) { ctx.clearRect(0, 0, size.x, size.y); return; }
      const src = st.layer === 'current' ? st.marine : st.wind;
      if (!src) return;
      const vars = st.layer === 'current' ? ['cu', 'cv'] : ['u', 'v'];
      // px per second per knot: 2 kn ≈ barely moving, 5 kn slow, 10 kn clearly moving, 20+ kn fast
      const PX_PER_KN = st.layer === 'current' ? 60 : 3.4;
      const k = PX_PER_KN * dt;
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0,0,0,0.93)'; ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1.15; ctx.strokeStyle = st.layer === 'current' ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      const zoomK = 1, lo = this.map.containerPointToLayerPoint([0, 0]);
      for (const p of this.parts) {
        if (p.age++ > 160) { Object.assign(p, this.rand(size), { age: 0 }); continue; }
        const ll = this.map.containerPointToLatLng([p.x, p.y]);
        if (onLand(this.map, st, p.x, p.y, ll, lo)) { Object.assign(p, this.rand(size), { age: 0 }); continue; }
        sample(src, vars, ll.lat, ll.lng, st.time, out);
        if (out[0] !== out[0]) { p.age = 999; continue; }
        const nx = p.x + out[0] * k * zoomK, ny = p.y - out[1] * k * zoomK;
        ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
        p.x = nx; p.y = ny;
        if (nx < 0 || ny < 0 || nx > size.x || ny > size.y) p.age = 999;
      }
      ctx.stroke();
    };
    requestAnimationFrame(tick);
  }
}

// ---------- vector land (cached per view) ----------
// Three sources, each used where it is best and clipped so that they never overlap:
//   HR  – detailed Adriatic coast (OpenStreetMap + GSHHG, data/coast.json), inside its own box
//   EU  – Natural Earth 1:10m, Europe + Mediterranean (data/world.json), outside the Adriatic box
//   W   – Natural Earth 1:50m, the whole world, outside the Europe box (or everywhere when zoomed far out)
// Rings cut by a data box have straight edges along it: they are filled but never stroked (no false coastlines).
const _lp = {};
function ringsPath(map, set, id) {
  const b = map.getBounds(), z = map.getZoom(), c = map.getCenter(), sz = map.getSize();
  const key = `${z}|${c.lat.toFixed(6)}|${c.lng.toFixed(6)}|${sz.x}x${sz.y}|${set.lines.length}`;
  if (_lp[id] && _lp[id].key === key) return _lp[id];
  const pb = b.pad(0.1), fill = new Path2D(), stroke = new Path2D();
  const N = pb.getNorth(), S = pb.getSouth(), E = pb.getEast(), W = pb.getWest();
  const o = map.latLngToContainerPoint([c.lat, c.lng]);
  const scale = 256 * Math.pow(2, z) / 360, cx = o.x - c.lng * scale;
  const merc = lat => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360));
  const mc = merc(c.lat), ys = 256 * Math.pow(2, z) / (2 * Math.PI);
  const cb = set.clip, eps = 1e-5;
  const onEdge = (x1, y1, x2, y2) => cb && ((Math.abs(x1 - cb[0]) < eps && Math.abs(x2 - cb[0]) < eps) || (Math.abs(x1 - cb[2]) < eps && Math.abs(x2 - cb[2]) < eps) ||
    (Math.abs(y1 - cb[1]) < eps && Math.abs(y2 - cb[1]) < eps) || (Math.abs(y1 - cb[3]) < eps && Math.abs(y2 - cb[3]) < eps));
  const onBox = (x, y) => cb && (Math.abs(x - cb[0]) < eps || Math.abs(x - cb[2]) < eps || Math.abs(y - cb[1]) < eps || Math.abs(y - cb[3]) < eps);
  for (const ln of set.lines) {
    if (ln.bb[0] > N || ln.bb[1] < S || ln.bb[2] > E || ln.bb[3] < W) continue;
    if ((ln.bb[3] - ln.bb[2]) * scale < 0.6 && (ln.bb[1] - ln.bb[0]) * scale < 0.6) continue;   // smaller than a pixel
    const P = ln.pts, n = P.length / 2;
    let px = -1e9, py = -1e9, plon = 0, plat = 0, first = true, pen = false;
    for (let k = 0; k <= n; k++) {
      const i = (k % n) * 2, lon = P[i], lat = P[i + 1];
      const x = cx + lon * scale, y = o.y - (merc(lat) - mc) * ys;
      if (!first && k < n && k > 0 && Math.abs(x - px) < 0.35 && Math.abs(y - py) < 0.35 && !onBox(lon, lat)) continue;   // points on the data box are always kept
      if (first) { fill.moveTo(x, y); first = false; }
      else {
        fill.lineTo(x, y);
        if (onEdge(plon, plat, lon, lat)) pen = false;
        else { if (!pen) stroke.moveTo(px, py); stroke.lineTo(x, y); pen = true; }
      }
      px = x; py = y; plon = lon; plat = lat;
    }
    fill.closePath();
  }
  return (_lp[id] = { key, fill, stroke });
}
// screen rectangle of a lon/lat box
function boxRect(map, bx) {   // whole pixels: neighbouring pieces meet without an anti-aliased seam
  const a = map.latLngToContainerPoint([bx[3], bx[0]]), b = map.latLngToContainerPoint([bx[1], bx[2]]);
  // 1 px inside the data box: the anti-aliased outer edge of the inner data is cut off and the outer data fills up to it
  const x0 = Math.round(a.x) + 1, y0 = Math.round(a.y) + 1;
  return [x0, y0, Math.round(b.x) - 1 - x0, Math.round(b.y) - 1 - y0];
}
// the land pieces for this view: [{path, clip: [inside rect] | null, outside: [rects]}]
function landPieces(map, state) {
  const out = [], z = map.getZoom(), world = state.world, hr = state.coast;
  const far = z < 4.5 || !world || !world.eu;
  if (world && world.w) out.push({ id: 'w', set: world.w, outside: far ? [] : [world.eu.clip] });
  if (!far) out.push({ id: 'eu', set: world.eu, inside: world.eu.clip, outside: hr ? [hr.clip] : [] });
  if (hr && (!far || !world)) out.push({ id: 'hr', set: hr, inside: hr.clip, outside: [] });
  return out.map(p => ({ ...p, path: ringsPath(map, p.set, p.id) }));
}
function withPiece(ctx, map, size, pc, fn) {
  ctx.save();
  if (pc.inside || (pc.outside && pc.outside.length)) {
    const r = new Path2D();
    if (pc.inside) r.rect(...boxRect(map, pc.inside)); else r.rect(-10, -10, size.x + 20, size.y + 20);
    for (const bx of pc.outside || []) r.rect(...boxRect(map, bx));
    ctx.clip(r, 'evenodd');
  }
  fn(pc.path);
  ctx.restore();
}
// fill all land (colour, or with 'destination-out' a cut-out); stroke only real coastlines
export function fillLand(ctx, map, state, style) {
  const size = map.getSize();
  for (const pc of landPieces(map, state)) withPiece(ctx, map, size, pc, p => { if (style) ctx.fillStyle = style; ctx.fill(p.fill, 'nonzero'); });
}
export function strokeLand(ctx, map, state, color, w) {
  const size = map.getSize();
  ctx.lineWidth = w; ctx.strokeStyle = color; ctx.lineJoin = 'round';
  for (const pc of landPieces(map, state)) withPiece(ctx, map, size, pc, p => ctx.stroke(p.stroke));
}
export const hasLand = state => !!(state.coast || state.world);
// land mask of the current view (¼ resolution) from the same vector land as the chart: arrows and particles stay at sea
// everywhere (also outside the Adriatic, where there is no depth grid)
const LM = { data: null };
export function buildLandMask(map, state) {
  if (!hasLand(state)) { LM.data = null; return; }
  const sz = map.getSize(), q = 4, W = Math.ceil(sz.x / q), H = Math.ceil(sz.y / q);
  const cv = LM.cv || (LM.cv = document.createElement('canvas')); sizeTo(cv, W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1 / q, 0, 0, 1 / q, 0, 0); ctx.clearRect(0, 0, sz.x, sz.y);
  fillLand(ctx, map, state, '#000');
  const px = ctx.getImageData(0, 0, W, H).data, data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 140 ? 1 : 0;
  const o = map.containerPointToLayerPoint([0, 0]);
  Object.assign(LM, { data, W, H, q, ox: o.x, oy: o.y, z: map.getZoom() });
}
export function onLand(map, state, x, y, ll, o) {
  if (LM.data && LM.z === map.getZoom()) {
    o = o || map.containerPointToLayerPoint([0, 0]); const X = Math.floor((x + o.x - LM.ox) / LM.q), Y = Math.floor((y + o.y - LM.oy) / LM.q);
    if (X >= 0 && Y >= 0 && X < LM.W && Y < LM.H) return LM.data[Y * LM.W + X] === 1;
  }
  return !!(state.landAt && ll && state.landAt(ll.lat, ll.lng));
}

// ---------- chart layer: offline nautical chart (depth shading, isobaths) or plain land ----------
const DEPTH_STYLE = [ // [maxDepth m, rgb] Navionics-like: shallow = blue, deep = white
  [2, [126, 190, 230]], [5, [150, 204, 238]], [10, [178, 219, 243]], [20, [204, 232, 248]], [50, [226, 242, 251]], [1e9, [246, 251, 255]],
];
export const ISOBATHS = [2, 5, 10, 20, 50, 100, 200];
// depth contours, optionally labelled; used under the weather (chart) or on top of everything (overlay)
export function drawIsobaths(ctx, map, b, onTop) {
  const z = map.getZoom();
  if (z < 6.5) return;
  const bb = map.getBounds();
  const levels = z >= 12 ? ISOBATHS : z >= 10.5 ? [5, 10, 20, 50, 100] : z >= 9.5 ? [10, 20, 50, 100] : z >= 8.5 ? [20, 50, 100, 200] : [50, 100, 200];
  const stride = z >= 11 ? 1 : z >= 10 ? 2 : z >= 9 ? 3 : z >= 8 ? 5 : 8;
  const segs = isobaths(b, bb.getSouth(), bb.getNorth(), bb.getWest(), bb.getEast(), levels, stride);
  const labels = [];
  segs.forEach((arr, k) => {
    const L = levels[k];
    const col = L <= 5 ? '#1f6fd1' : L <= 20 ? '#3c8fd8' : L <= 50 ? '#6aa9de' : '#9cc3e6';
    const draw = (w, c) => {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath();
      for (let i = 0; i < arr.length; i += 4) {
        const p = map.latLngToContainerPoint([arr[i], arr[i + 1]]), q = map.latLngToContainerPoint([arr[i + 2], arr[i + 3]]);
        ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    };
    if (onTop) { draw(L <= 5 ? 3.2 : 2.6, 'rgba(255,255,255,.55)'); draw(L <= 5 ? 1.5 : 1.1, col); }
    else { ctx.globalAlpha = .75; draw(L <= 5 ? 1.1 : 0.8, col); ctx.globalAlpha = 1; }
    // sparse depth labels along each contour
    // sparse depth numbers: more of them only when zoomed in
    if (z < 9) return;
    const gx = z >= 11 ? 90 : z >= 10 ? 140 : 200, gy = z >= 11 ? 40 : z >= 10 ? 70 : 100;
    for (let i = 0; i < arr.length; i += 4 * 9) {
      const p = map.latLngToContainerPoint([arr[i], arr[i + 1]]);
      if (labels.some(l => Math.abs(l.x - p.x) < gx && Math.abs(l.y - p.y) < gy)) continue;
      labels.push({ x: p.x, y: p.y, t: String(L), col });
    }
  });
  ctx.font = '700 10.5px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const l of labels) {
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(l.t, l.x, l.y);
    ctx.fillStyle = '#134a8a'; ctx.fillText(l.t, l.x, l.y);
  }
  ctx.textBaseline = 'alphabetic';
}

// on-top depth overlay (visible above wind colours, any basemap)
export class DepthLayer {
  constructor(map, state) {
    this.map = map; this.state = state;
    this.p = makeCanvasPane(map, 'depth', 330);
    map.on('moveend zoomend resize viewreset', () => this.draw());
    map.on('zoomstart', () => { this.p.canvas.style.opacity = 0; });
    map.on('zoomend', () => { this.p.canvas.style.opacity = 1; });
  }
  draw() {
    const { map, state } = this; const { ctx } = this.p;
    this.p.fit();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    if (state.ovDepth && state.bathy) drawIsobaths(ctx, map, state.bathy, true);
  }
}

export class ChartLayer {
  constructor(map, state) {
    this.map = map; this.state = state;
    this.p = makeCanvasPane(map, 'chart', 240);
    this.off = document.createElement('canvas');
    this.lut = new Uint8ClampedArray(256 * 4);
    for (let c = 0; c < 256; c++) {
      const dep = DEPTH_LUT[c];
      const rgb = c === 0 ? [242, 230, 194] : DEPTH_STYLE.find(s => dep <= s[0])[1];
      this.lut.set([...rgb, 255], c * 4);
    }
    // when a precise vector coastline exists, raster 'land' cells are drawn as shallow water;
    // the vector polygons alone decide where land is (no 135 m staircase)
    this.lutVec = this.lut.slice(); this.lutVec.set([...DEPTH_STYLE[0][1], 255], 0);
    map.on('moveend zoomend resize viewreset', () => this.draw());
    map.on('zoomstart', () => { this.p.canvas.style.opacity = 0; });
    map.on('zoomend', () => { this.p.canvas.style.opacity = 1; });
  }
  draw() {
    const { map, state } = this; const { ctx } = this.p;
    this.p.fit();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    const mode = state.basemap;
    const nautical = mode === 'nautical', plain = mode === 'offline';
    if (!nautical && !plain) { this.drawCoastStroke(ctx, '#ffffff55', 0.8); buildLandMask(map, state); return; }
    const landColor = nautical ? '#f2e6c2' : '#3a3e44';
    const detail = !!state.landDetail && !!state.coast;   // zoomed in + online: land comes from the detailed map tiles below
    if (detail && plain) { ctx.fillStyle = '#12314f'; ctx.fillRect(0, 0, size.x, size.y); }   // dark sea, so the tiles show only on land
    if (nautical && state.bathy) {
      const b = state.bathy, step = 2, g = viewGeometry(map, step);
      sizeTo(this.off, g.W, g.H);
      const octx = this.off.getContext('2d'), img = octx.createImageData(g.W, g.H), d = img.data, lut = state.coast ? this.lutVec : this.lut;
      for (let y = 0; y < g.H; y++) {
        const r = Math.floor((b.lat1 - g.lats[y]) / b.dlat);
        if (r < 0 || r >= b.NR) continue;
        for (let x = 0; x < g.W; x++) {
          const c = Math.floor((g.lons[x] - b.lon0) / b.dlon);
          if (c < 0 || c >= b.NC) continue;
          const code = b.codes[r * b.NC + c], o = (y * g.W + x) * 4, i = code * 4;
          // the depth shading fades out over the last ~0.15° of the survey grid (the open sea outside is plain)
          const edge = Math.min(g.lats[y] - b.lat0, b.lat1 - g.lats[y], g.lons[x] - b.lon0, b.lon1 - g.lons[x]);
          d[o] = lut[i]; d[o + 1] = lut[i + 1]; d[o + 2] = lut[i + 2]; d[o + 3] = edge >= 0.15 ? 255 : Math.max(0, edge / 0.15) * 255;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.off, -step / 2, -step / 2, g.W * step, g.H * step);
      // isobaths (only here when the on-top depth overlay is off)
      if (!state.ovDepth) drawIsobaths(ctx, map, b, false);
    }
    // crisp vector land on top
    if (hasLand(state)) {
      if (detail) { ctx.save(); ctx.globalCompositeOperation = 'destination-out'; fillLand(ctx, map, state, '#000'); ctx.restore(); }   // a window onto the detailed land
      else fillLand(ctx, map, state, landColor);
      strokeLand(ctx, map, state, nautical ? '#6b5b3a' : '#9aa3ad', nautical ? 1 : 0.9);
    }
    buildLandMask(map, state);
    // place labels
    if (state.places && map.getZoom() >= 8 && !detail) {
      ctx.font = '600 11px -apple-system,system-ui,sans-serif'; ctx.textAlign = 'center';
      for (const p of state.places) {
        if (p.z > map.getZoom()) continue;
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = nautical ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.6)'; ctx.strokeText(p.name, pt.x, pt.y);
        ctx.fillStyle = nautical ? '#3b3020' : '#eef2f6'; ctx.fillText(p.name, pt.x, pt.y);
      }
    }
  }
  drawCoastStroke(ctx, color, w) {
    if (!hasLand(this.state)) return;
    strokeLand(ctx, this.map, this.state, color, w);
  }
}

export function decodeCoast(json) {
  const lines = decodeLines(json.lines, json.scale);
  const ext = [180, 90, -180, -90];   // the HR coast was cut to its box: that box is its clip
  for (const l of lines) { ext[0] = Math.min(ext[0], l.bb[2]); ext[1] = Math.min(ext[1], l.bb[0]); ext[2] = Math.max(ext[2], l.bb[3]); ext[3] = Math.max(ext[3], l.bb[1]); }
  return { lines, clip: ext };
}
export function decodeWorld(json) {
  const o = {};
  for (const st of json.sets) o[st.id] = { lines: decodeLines(st.lines, json.scale), clip: st.clip || null };
  return o;
}
function decodeLines(arr, sc) {
  return arr.map(l => {
    const pts = new Float64Array(l.p.length);
    let lon = 0, lat = 0, bb = [-90, 90, -180, 180]; // n,s,e,w
    let n = -90, s = 90, e = -180, w = 180;
    for (let i = 0; i < l.p.length; i += 2) {
      lon += l.p[i]; lat += l.p[i + 1];
      pts[i] = lon / sc; pts[i + 1] = lat / sc;
      n = Math.max(n, pts[i + 1]); s = Math.min(s, pts[i + 1]); e = Math.max(e, pts[i]); w = Math.min(w, pts[i]);
    }
    bb = [s, n, w, e];
    // bb stored as [south, north, west, east] -> test uses: bb[0]>N, bb[1]<S, bb[2]>E, bb[3]<W
    return { pts, closed: !!l.c, bb };
  });
}

// Polar model built from an ORC-style CSV (semicolon separated):
// WindVelocity;6;8;...   BeatAngles;...   BeatVMG;...   <TWA>;speeds...   GybeAngles;...   RunVMG;...
// Produces a dense lookup table speed[twa 0..180][tws 0..40] for fast routing.

const D2R = Math.PI / 180;

export function parsePolarCSV(text) {
  const rows = text.trim().split(/\r?\n/).map(l => l.split(/[;,\t]/).map(s => s.trim()));
  const get = key => rows.find(r => r[0].toLowerCase() === key.toLowerCase());
  const tws = get('WindVelocity').slice(1).map(Number);
  const beatAngle = get('BeatAngles').slice(1).map(Number);
  const beatVMG = get('BeatVMG').slice(1).map(Number);
  const gybeAngle = get('GybeAngles').slice(1).map(Number);
  const runVMG = get('RunVMG').slice(1).map(Number);
  const table = rows.filter(r => /^\d+(\.\d+)?$/.test(r[0]))
    .map(r => ({ twa: Number(r[0]), bsp: r.slice(1).map(Number) }));
  return { tws, beatAngle, beatVMG, gybeAngle, runVMG, table };
}

// Accepts: ORC CSV (WindVelocity/BeatAngles…), TWA×TWS grids (Expedition, OpenCPN .pol, B&G, MaxSea, Adrena),
// TWS×TWA (transposed) grids, and line-per-TWS "pairs" format (tws twa1 bsp1 twa2 bsp2 …, PredictWind-style).
export function parsePolarAny(text) {
  if (/windvelocity/i.test(text)) return parsePolarCSV(text);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[#!]/.test(l));
  const rows = lines.map(l => l.split(/[;,\t ]+/).filter(Boolean));
  const num = x => x !== undefined && /^-?\d+(\.\d+)?$/.test(x);
  // pairs format: every row numeric with odd length >= 3 and first value < 60
  const allNum = rows.every(r => r.every(num));
  if (allNum && rows.every(r => r.length >= 3 && r.length % 2 === 1) && !rows.every(r => r.length === rows[0].length && +r[0] === 0)) {
    const twsList = rows.map(r => +r[0]);
    const angles = [...new Set(rows.flatMap(r => r.slice(1).filter((_, i) => i % 2 === 0).map(Number)))].sort((a, b) => a - b);
    const table = angles.map(a => ({ twa: a, bsp: rows.map(r => { const pr = []; for (let i = 1; i < r.length; i += 2) pr.push([+r[i], +r[i + 1]]); return interpPairs(pr, a); }) }));
    return { tws: twsList, table };
  }
  // grid: header row (first cell may be text or 0) + data rows
  let head = rows[0], body = rows.slice(1);
  if (head.length === body[0].length) head = head.slice(1); // drop corner cell ("TWA\\TWS", 0, …)
  const hv = head.map(Number), firstCol = body.map(r => +r[0]);
  const grid = body.map(r => r.slice(1).map(Number));
  const headLooksAngles = Math.max(...hv) > 60, colLooksAngles = Math.max(...firstCol) > 60;
  let tws, table;
  if (colLooksAngles || !headLooksAngles) { // rows = TWA, cols = TWS
    tws = hv; table = firstCol.map((a, i) => ({ twa: a, bsp: grid[i] }));
  } else {                                   // rows = TWS, cols = TWA
    tws = firstCol; table = hv.map((a, j) => ({ twa: a, bsp: grid.map(r => r[j]) }));
  }
  table = table.filter(r => r.twa > 0 || r.bsp.some(v => v > 0)).sort((a, b) => a.twa - b.twa);
  if (!tws.length || !table.length) throw new Error('nepoznat format polara');
  return { tws, table };
}
function interpPairs(pr, a) {
  pr.sort((x, y) => x[0] - y[0]);
  if (a <= pr[0][0]) return a < pr[0][0] * 0.7 ? 0 : pr[0][1];
  for (let i = 0; i < pr.length - 1; i++) if (a <= pr[i + 1][0]) { const t = (a - pr[i][0]) / (pr[i + 1][0] - pr[i][0]); return pr[i][1] + (pr[i + 1][1] - pr[i][1]) * t; }
  return pr[pr.length - 1][1];
}

export class Polar {
  constructor(src, name = 'Polar') {
    this.name = name;
    this.src = src;
    this.maxTws = 40;
    this.build();
  }

  // speed curve for a single TWS column
  curveFor(col) {
    const s = this.src;
    if (!s.beatAngle) return this.curveFromGrid(col);
    const ba = s.beatAngle[col], bs = s.beatVMG[col] / Math.cos(ba * D2R);
    const ga = s.gybeAngle[col], gs = s.runVMG[col] / -Math.cos(ga * D2R);
    const pts = [[0, 0], [ba * 0.62, 0], [ba * 0.85, bs * 0.72], [ba, bs]];
    for (const r of s.table) if (r.twa > ba && r.twa < ga) pts.push([r.twa, r.bsp[col]]);
    pts.push([ga, gs]);
    // beyond gybe angle VMG drops towards dead downwind
    if (ga < 180) pts.push([180, gs * 0.74]);
    pts.sort((a, b) => a[0] - b[0]);
    const out = new Float32Array(181);
    for (let a = 0; a <= 180; a++) {
      let i = 0;
      while (i < pts.length - 2 && pts[i + 1][0] < a) i++;
      const [a0, v0] = pts[i], [a1, v1] = pts[i + 1];
      const t = a1 === a0 ? 0 : Math.min(1, Math.max(0, (a - a0) / (a1 - a0)));
      out[a] = v0 + (v1 - v0) * t;
    }
    return out;
  }

  // generic grid polar: linear in TWA, zero speed in the no-go zone below the first tabulated angle
  curveFromGrid(col) {
    const pts = this.src.table.map(r => [r.twa, r.bsp[col] || 0]).filter(p => p[0] > 0);
    if (pts[0][0] > 20) pts.unshift([pts[0][0] * 0.7, 0]);
    pts.unshift([0, 0]);
    if (pts[pts.length - 1][0] < 180) pts.push([180, pts[pts.length - 1][1] * 0.9]);
    const out = new Float32Array(181);
    for (let a = 0; a <= 180; a++) {
      let i = 0; while (i < pts.length - 2 && pts[i + 1][0] < a) i++;
      const [a0, v0] = pts[i], [a1, v1] = pts[i + 1];
      out[a] = v0 + (v1 - v0) * Math.min(1, Math.max(0, (a - a0) / ((a1 - a0) || 1)));
    }
    return out;
  }

  build() {
    const s = this.src;
    const cols = s.tws.map((_, i) => this.curveFor(i));
    // dense table [tws 0..40][twa 0..180]
    this.lut = new Float32Array(41 * 181);
    for (let w = 0; w <= 40; w++) {
      for (let a = 0; a <= 180; a++) {
        let v;
        if (w <= s.tws[0]) v = cols[0][a] * (w / s.tws[0]) ** 1.15;          // light air scaling
        else if (w >= s.tws[s.tws.length - 1]) v = cols[cols.length - 1][a]; // clamp heavy air
        else {
          let i = 0;
          while (s.tws[i + 1] < w) i++;
          const t = (w - s.tws[i]) / (s.tws[i + 1] - s.tws[i]);
          v = cols[i][a] + (cols[i + 1][a] - cols[i][a]) * t;
        }
        this.lut[w * 181 + a] = v;
      }
    }
  }

  // boat speed (kn) for |twa| deg and tws kn, bilinear on LUT
  speed(twa, tws) {
    twa = Math.abs(twa); if (twa > 180) twa = 360 - twa;
    if (tws <= 0) return 0;
    if (tws > 40) tws = 40;
    const w0 = Math.floor(tws), w1 = Math.min(40, w0 + 1), tw = tws - w0;
    const a0 = Math.floor(twa), a1 = Math.min(180, a0 + 1), ta = twa - a0;
    const L = this.lut;
    const v00 = L[w0 * 181 + a0], v01 = L[w0 * 181 + a1];
    const v10 = L[w1 * 181 + a0], v11 = L[w1 * 181 + a1];
    return (v00 + (v01 - v00) * ta) * (1 - tw) + (v10 + (v11 - v10) * ta) * tw;
  }

  optimal(tws) {
    const s = this.src;
    if (!s.beatAngle) {
      let bu = 0, ba = 45, bd = 0, ga = 150;
      for (let a = 20; a <= 180; a += 0.5) {
        const v = this.speed(a, tws), c = Math.cos(a * D2R);
        if (v * c > bu) { bu = v * c; ba = a; }
        if (-v * c > bd) { bd = -v * c; ga = a; }
      }
      return { beat: ba, gybe: ga, beatVMG: bu, runVMG: bd };
    }
    const lerp = arr => {
      if (tws <= s.tws[0]) return arr[0];
      if (tws >= s.tws[s.tws.length - 1]) return arr[arr.length - 1];
      let i = 0; while (s.tws[i + 1] < tws) i++;
      const t = (tws - s.tws[i]) / (s.tws[i + 1] - s.tws[i]);
      return arr[i] + (arr[i + 1] - arr[i]) * t;
    };
    return { beat: lerp(s.beatAngle), gybe: lerp(s.gybeAngle), beatVMG: lerp(s.beatVMG), runVMG: lerp(s.runVMG) };
  }

  serialize() { return { name: this.name, src: this.src }; }
  static from(o) { return new Polar(o.src, o.name); }
}

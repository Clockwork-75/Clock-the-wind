// GRIB1 + GRIB2 decoder for regular lat/lon grids (PredictWind, Saildocs, LuckGrib/Expedition exports, NOAA, DWD…).
// Supported packing: GRIB1 simple; GRIB2 5.0 simple, 5.2 complex, 5.3 complex + spatial differencing.
// Output: Clock the Wind field { lat0, lon0, dlat, dlon, ny, nx, times, vars:{u,v,gust,precip,cape,wave,waveDir,wavePer,cu,cv} }

const MS2KN = 1.943844;

class Bits {
  constructor(bytes, pos) { this.b = bytes; this.p = pos * 8; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3];
      v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v;
  }
  align() { this.p = Math.ceil(this.p / 8) * 8; }
}
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const s16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const s24 = (b, o) => { const v = u24(b, o); return v & 0x800000 ? -(v & 0x7fffff) : v; };
const s32 = (b, o) => { const v = u32(b, o); return v >= 0x80000000 ? -(v - 0x80000000) : v; };
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
const ibm = (b, o) => { const s = b[o] & 0x80 ? -1 : 1, e = (b[o] & 0x7f) - 64, m = u24(b, o + 1); return s * m * Math.pow(16, e - 6); };

// map (discipline/category/number) or GRIB1 table-2 code -> our variable
function varGrib2(d, c, n) {
  if (d === 0 && c === 2 && n === 2) return 'U';
  if (d === 0 && c === 2 && n === 3) return 'V';
  if (d === 0 && c === 2 && n === 22) return 'gust';
  if (d === 0 && c === 2 && n === 21) return 'gust';   // maximum wind speed (DHMZ ALADIN-HR: hourly max at 10 m)
  if (d === 0 && c === 2 && n === 23) return 'gu';   // gust as u/v components (Météo-France ARPEGE/AROME)
  if (d === 0 && c === 2 && n === 24) return 'gv';
  if (d === 0 && c === 1 && (n === 8 || n === 52 || n === 7)) return 'precip';
  if (d === 0 && c === 7 && n === 6) return 'cape';
  if (d === 10 && c === 0 && n === 3) return 'wave';
  if (d === 10 && c === 0 && (n === 4 || n === 14)) return 'waveDir';
  if (d === 10 && c === 0 && (n === 34 || n === 15 || n === 11)) return 'wavePer';
  if (d === 10 && c === 1 && n === 2) return 'cu';
  if (d === 10 && c === 1 && n === 3) return 'cv';
  return null;
}
const GRIB1 = { 33: 'U', 34: 'V', 180: 'gust', 61: 'precip', 157: 'cape', 100: 'wave', 101: 'waveDir', 103: 'wavePer', 49: 'cu', 50: 'cv' };

function grid2(b, s) { // section 3 template 3.0
  const tmpl = u16(b, s + 12);
  if (tmpl !== 0) throw new Error(`GRIB2 mreža tipa ${tmpl} nije podržana (samo lat/lon)`);
  const ni = u32(b, s + 30), nj = u32(b, s + 34);
  const la1 = s32(b, s + 46) / 1e6, lo1 = s32(b, s + 50) / 1e6, la2 = s32(b, s + 55) / 1e6, lo2 = s32(b, s + 59) / 1e6;
  const di = u32(b, s + 63) / 1e6, dj = u32(b, s + 67) / 1e6, scan = b[s + 71];
  return { ni, nj, la1, lo1, la2, lo2, di, dj, scan, npts: u32(b, s + 6) };
}

function unpackSimple(b, start, n, nbits, R, E, D) {
  const out = new Float32Array(n);
  const bs = new Bits(b, start), e2 = Math.pow(2, E), d10 = Math.pow(10, -D);
  for (let i = 0; i < n; i++) out[i] = (R + (nbits ? bs.read(nbits) : 0) * e2) * d10;
  return out;
}

function unpackComplex(b, s5, s7, n, tmpl) {
  const R = f32(b, s5 + 11), E = s16(b, s5 + 15), D = s16(b, s5 + 17), nbits = b[s5 + 19];
  const missMgmt = b[s5 + 22];
  const NG = u32(b, s5 + 31), refW = b[s5 + 35], bitsW = b[s5 + 36];
  const refL = u32(b, s5 + 37), incL = b[s5 + 41], lastL = u32(b, s5 + 42), bitsL = b[s5 + 46];
  let order = 0, extra = 0;
  if (tmpl === 3) { order = b[s5 + 47]; extra = b[s5 + 48]; }
  let p = s7 + 5;
  const first = [];
  const readS = () => { let v = 0; for (let k = 0; k < extra; k++) v = v * 256 + b[p + k]; const sign = b[p] & 0x80; p += extra; if (sign) v = -(v - Math.pow(2, 8 * extra - 1)); return v; };
  for (let k = 0; k < order; k++) first.push(readS());
  const minSD = order ? readS() : 0;
  const bs = new Bits(b, p);
  const refs = new Array(NG); for (let g = 0; g < NG; g++) refs[g] = bs.read(nbits); bs.align();
  const widths = new Array(NG); for (let g = 0; g < NG; g++) widths[g] = refW + bs.read(bitsW); bs.align();
  const lens = new Array(NG); for (let g = 0; g < NG; g++) lens[g] = refL + incL * bs.read(bitsL); bs.align();
  lens[NG - 1] = lastL;
  const X = new Float64Array(n); const miss = new Uint8Array(n);
  let i = 0;
  for (let g = 0; g < NG; g++) {
    const w = widths[g], L = lens[g], ref = refs[g];
    const allOnes = Math.pow(2, w) - 1;
    for (let k = 0; k < L && i < n; k++, i++) {
      if (w === 0) { X[i] = ref; if (missMgmt && ref === Math.pow(2, nbits) - 1) miss[i] = 1; continue; }
      const v = bs.read(w);
      if (missMgmt && v === allOnes) miss[i] = 1; else X[i] = ref + v;
    }
  }
  if (order) {
    // undo spatial differencing over non-missing values
    const idx = []; for (let k = 0; k < n; k++) if (!miss[k]) idx.push(k);
    for (let k = 0; k < order && k < idx.length; k++) X[idx[k]] = first[k];
    for (let k = order; k < idx.length; k++) X[idx[k]] += minSD;
    if (order === 1) for (let k = 1; k < idx.length; k++) X[idx[k]] += X[idx[k - 1]];
    else if (order === 2) for (let k = 2; k < idx.length; k++) X[idx[k]] += 2 * X[idx[k - 1]] - X[idx[k - 2]];
  }
  const out = new Float32Array(n), e2 = Math.pow(2, E), d10 = Math.pow(10, -D);
  for (let k = 0; k < n; k++) out[k] = miss[k] ? NaN : (R + X[k] * e2) * d10;
  return out;
}

// ---- CCSDS 121.0-B / libaec decoder (GRIB2 data representation template 5.42, used by ECMWF & DWD ICON-EU) ----
class BR {
  constructor(b, pos) { this.b = b; this.p = pos; this.acc = 0; this.n = 0; }
  fill() { while (this.n <= 24) { this.acc = ((this.acc << 8) | (this.b[this.p++] || 0)) >>> 0; this.n += 8; } }
  get(k) {
    if (k === 0) return 0;
    if (k > 24) return this.get(k - 16) * 65536 + this.get(16);
    if (this.n < k) this.fill();
    this.n -= k;
    return (this.acc >>> this.n) & ((1 << k) - 1);
  }
  fs() { let c = 0; for (;;) { if (this.n === 0) this.fill(); this.n--; if ((this.acc >>> this.n) & 1) return c; c++; } }
  align() { this.n -= this.n % 8; }
}
function aecDecode(b, start, n, bps, blockSize, rsi, flags) {
  const out = new Float64Array(n);
  if (bps === 0) return out;
  const br = new BR(b, start);
  const idLen = bps > 16 ? 5 : bps > 8 ? 4 : 3;
  const idUncomp = (1 << idLen) - 1;
  const pre = (flags & 8) !== 0, pad = (flags & 32) !== 0;
  const xmax = Math.pow(2, bps) - 1, med = Math.floor(xmax / 2) + 1;
  let o = 0, data = 0;
  const put = d => {
    if (o >= n) return;
    if (!pre) { out[o++] = d; return; }
    const half = Math.floor(d / 2) + (d % 2);
    const mask = (data & med) ? xmax : 0;
    if (half <= (mask ^ data)) data += (d % 2) ? -(Math.floor(d / 2) + 1) : d / 2;
    else data = mask ^ d;
    out[o++] = data;
  };
  const putRef = r => { if (o < n) { out[o++] = r; data = r; } };
  while (o < n) {
    for (let blk = 0; blk < rsi && o < n; blk++) {
      const ref = pre && blk === 0;
      const id = br.get(idLen);
      if (id === 0) {
        const se = br.get(1);
        if (ref) putRef(br.get(bps));
        if (se === 1) { // second extension
          let i = ref ? 1 : 0;
          while (i < blockSize) {
            const m = br.fs();
            let k = Math.floor((Math.sqrt(8 * m + 1) - 1) / 2); while ((k + 1) * (k + 2) / 2 <= m) k++; while (k * (k + 1) / 2 > m) k--;
            const d1 = m - k * (k + 1) / 2;
            if ((i & 1) === 0) { put(k - d1); i++; }
            put(d1); i++;
          }
        } else { // zero block(s)
          let zb = br.fs() + 1;
          if (zb === 5) zb = Math.min(rsi - blk, 64 - (blk % 64));
          else if (zb > 5) zb--;
          const cnt = zb * blockSize - (ref ? 1 : 0);
          for (let i = 0; i < cnt; i++) put(0);
          blk += zb - 1;
        }
      } else if (id === idUncomp) {
        if (ref) putRef(br.get(bps));
        for (let i = ref ? 1 : 0; i < blockSize; i++) put(br.get(bps));
      } else {
        const k = id - 1;
        if (ref) putRef(br.get(bps));
        const cnt = blockSize - (ref ? 1 : 0);
        const f = new Array(cnt);
        for (let i = 0; i < cnt; i++) f[i] = br.fs();
        for (let i = 0; i < cnt; i++) put(f[i] * Math.pow(2, k) + br.get(k));
      }
    }
    if (pad) br.align();
  }
  return out;
}
function unpackAEC(b, s5, s7, n) {
  const R = f32(b, s5 + 11), E = s16(b, s5 + 15), D = s16(b, s5 + 17), bps = b[s5 + 19];
  const flags = b[s5 + 21], blockSize = b[s5 + 22], rsi = u16(b, s5 + 23);
  const X = aecDecode(b, s7 + 5, n, bps, blockSize, rsi, flags);
  const out = new Float32Array(n), e2 = Math.pow(2, E), d10 = Math.pow(10, -D);
  for (let i = 0; i < n; i++) out[i] = (R + X[i] * e2) * d10;
  return out;
}

function parseGrib2(b, o, msgs) {
  const disc = b[o + 6], len = Number(new DataView(b.buffer, b.byteOffset + o + 8, 8).getBigUint64(0, false));
  const end = o + len;
  let p = o + 16, ref = 0, grid = null, prod = null, rep = null, bitmap = null;
  while (p < end - 4) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break; // '7777'
    const sl = u32(b, p), sn = b[p + 4];
    if (sn === 1) ref = Date.UTC(u16(b, p + 12), b[p + 14] - 1, b[p + 15], b[p + 16], b[p + 17], b[p + 18]);
    else if (sn === 3) grid = grid2(b, p);
    else if (sn === 4) {
      const t = u16(b, p + 7), cat = b[p + 9], num = b[p + 10], unit = b[p + 17], ft = s32(b, p + 18);
      const sf = b[p + 22], lev = u32(b, p + 24), sfac = b[p + 23];
      const hrs = unit === 1 ? ft : unit === 0 ? ft / 60 : unit === 2 ? ft * 24 : unit === 10 ? ft * 3 : unit === 11 ? ft * 6 : unit === 12 ? ft * 12 : ft;
      let valid = ref + hrs * 3600000;
      if (t === 8) valid = Date.UTC(u16(b, p + 34), b[p + 36] - 1, b[p + 37], b[p + 38], b[p + 39], b[p + 40]);
      prod = { cat, num, valid, surf: sf, level: lev / Math.pow(10, sfac || 0), tmpl: t };
    } else if (sn === 5) rep = { s: p, tmpl: u16(b, p + 9), n: u32(b, p + 5) };
    else if (sn === 6) {
      if (b[p + 5] === 0) { const bm = new Uint8Array(grid.npts); const bs = new Bits(b, p + 6); for (let k = 0; k < grid.npts; k++) bm[k] = bs.read(1); bitmap = bm; }
      else if (b[p + 5] === 255) bitmap = null;
    } else if (sn === 7) {
      const name = varGrib2(disc, prod.cat, prod.num);
      const isWind10 = (name === 'U' || name === 'V' || name === 'gu' || name === 'gv') ? (prod.surf === 103 && Math.abs(prod.level - 10) < 0.5) || prod.surf === 1 : true;
      if (name && isWind10) {
        let vals;
        if (rep.tmpl === 0) vals = unpackSimple(b, p + 5, rep.n, b[rep.s + 19], f32(b, rep.s + 11), s16(b, rep.s + 15), s16(b, rep.s + 17));
        else if (rep.tmpl === 2 || rep.tmpl === 3) vals = unpackComplex(b, rep.s, p, rep.n, rep.tmpl);
        else if (rep.tmpl === 42) vals = unpackAEC(b, rep.s, p, rep.n);
        else throw new Error(`GRIB2 pakiranje ${rep.tmpl} nije podržano (npr. JPEG2000/CCSDS) – izvezi GRIB s jednostavnim pakiranjem`);
        msgs.push({ name, valid: prod.valid, grid, vals: expand(vals, bitmap, grid.npts) });
      }
    }
    p += sl;
  }
  return end;
}

function expand(vals, bitmap, npts) {
  if (!bitmap) return vals;
  const out = new Float32Array(npts).fill(NaN);
  let k = 0; for (let i = 0; i < npts; i++) if (bitmap[i]) out[i] = vals[k++];
  return out;
}

function parseGrib1(b, o, msgs) {
  const len = u24(b, o + 4), end = o + len;
  const pds = o + 8, pl = u24(b, pds);
  const flag = b[pds + 7], param = b[pds + 8], ltype = b[pds + 9], lev = u16(b, pds + 10);
  const yy = b[pds + 12], cent = b[pds + 24] || 21;
  const ref = Date.UTC((cent - 1) * 100 + yy, b[pds + 13] - 1, b[pds + 14], b[pds + 15], b[pds + 16]);
  const unit = b[pds + 17], P1 = b[pds + 18], P2 = b[pds + 19], tri = b[pds + 20];
  const D = s16(b, pds + 26);
  const mul = unit === 1 ? 1 : unit === 0 ? 1 / 60 : unit === 2 ? 24 : unit === 10 ? 3 : unit === 11 ? 6 : unit === 12 ? 12 : 1;
  const ft = (tri === 10 ? u16(b, pds + 18) : (tri === 4 || tri === 2 || tri === 3 || tri === 5) ? P2 : P1) * mul;
  let p = pds + pl, grid = null, bitmap = null;
  if (flag & 0x80) {
    const g = p, gl = u24(b, g);
    if (b[g + 5] !== 0) throw new Error('GRIB1 mreža nije lat/lon');
    const ni = u16(b, g + 6), nj = u16(b, g + 8);
    grid = { ni, nj, la1: s24(b, g + 10) / 1000, lo1: s24(b, g + 13) / 1000, la2: s24(b, g + 17) / 1000, lo2: s24(b, g + 20) / 1000,
      di: u16(b, g + 23) / 1000, dj: u16(b, g + 25) / 1000, scan: b[g + 27], npts: ni * nj };
    p += gl;
  } else throw new Error('GRIB1 bez opisa mreže nije podržan');
  if (flag & 0x40) {
    const bl = u24(b, p); const bm = new Uint8Array(grid.npts); const bs = new Bits(b, p + 6);
    for (let k = 0; k < grid.npts; k++) bm[k] = bs.read(1); bitmap = bm; p += bl;
  }
  const bds = p, bl = u24(b, bds), bflag = b[bds + 3];
  const E = s16(b, bds + 4), R = ibm(b, bds + 6), nbits = b[bds + 10];
  const unused = bflag & 0x0f;
  // 0 bits = every point has the reference value (a constant field): one value per grid point, nothing to read
  const n = bitmap ? bitmap.reduce((a, c) => a + c, 0) : nbits === 0 ? grid.npts : Math.floor(((bl - 11) * 8 - unused) / nbits);
  const name = (EXTRA1 && EXTRA1[param]) || GRIB1[param];
  if (name && (bflag & 0x40)) throw new Error('GRIB1 kompleksno pakiranje nije podržano – izvezi GRIB s jednostavnim pakiranjem');
  const okLevel = (name === 'U' || name === 'V') ? ANY_LEVEL || (ltype === 105 && lev === 10) || ltype === 1 : true;
  if (name && okLevel) {
    const vals = unpackSimple(b, bds + 11, Math.min(n, grid.npts), nbits, R, E, D);
    msgs.push({ name, valid: ref + ft * 3600000, grid, vals: expand(vals, bitmap, grid.npts) });
  }
  return end;
}

// Files from paid services often mix variables, levels and packings: a message we cannot read is skipped
// (and remembered), so the wind in the same file is still imported. Only if nothing usable is left do we fail.
let ANY_LEVEL = false;   // tests only: accept U/V on any level
let EXTRA1 = null;       // a producer's local GRIB1 parameters, e.g. DHMZ ALADIN-HR: 196/197 = u/v of the hourly maximum wind
export function decodeGrib(buffer, opts = {}) {
  const b = new Uint8Array(buffer), msgs = [], skipped = [];
  ANY_LEVEL = !!opts.anyLevel; EXTRA1 = opts.grib1 || null;
  let o = 0;
  while (o < b.length - 8) {
    if (b[o] === 0x47 && b[o + 1] === 0x52 && b[o + 2] === 0x49 && b[o + 3] === 0x42) {
      const ed = b[o + 7];
      const len = ed === 2 ? Number(new DataView(b.buffer, b.byteOffset + o + 8, 8).getBigUint64(0, false)) : u24(b, o + 4);
      try { ed === 2 ? parseGrib2(b, o, msgs) : parseGrib1(b, o, msgs); }
      catch (e) { skipped.push(e.message); }
      o += len > 8 ? len : 1;
    } else o++;
  }
  ANY_LEVEL = false; EXTRA1 = null;
  msgs.skipped = skipped;
  if (!msgs.length && skipped.length) throw new Error(skipped[0]);
  return msgs;
}

// Convert decoded messages into a Clock the Wind field, cropped to bbox (optional)
export function gribToField(msgs, bbox, id) {
  if (!msgs.length) throw new Error('GRIB ne sadrži podržane varijable (vjetar 10 m, udari, kiša, CAPE, valovi, struje)');
  const g = (msgs.find(m => m.name === 'U') || msgs[0]).grid;
  const lonN = x => (x >= 180 ? x - 360 : x);
  const south = Math.min(g.la1, g.la2), north = Math.max(g.la1, g.la2);
  const west = lonN(g.lo1), dlon = g.di, dlat = g.dj;
  let i0 = 0, i1 = g.ni - 1, j0 = 0, j1 = g.nj - 1; // j counted from south
  if (bbox) {
    i0 = Math.max(0, Math.floor((bbox.w - west) / dlon) - 1); i1 = Math.min(g.ni - 1, Math.ceil((bbox.e - west) / dlon) + 1);
    j0 = Math.max(0, Math.floor((bbox.s - south) / dlat) - 1); j1 = Math.min(g.nj - 1, Math.ceil((bbox.n - south) / dlat) + 1);
    if (i1 <= i0 || j1 <= j0) throw new Error('GRIB ne pokriva područje staze');
  }
  const nx = i1 - i0 + 1, ny = j1 - j0 + 1, N = nx * ny;
  const times = [...new Set(msgs.map(m => m.valid))].sort((a, b) => a - b);
  const T = times.length;
  const vars = {};
  const arr = name => vars[name] || (vars[name] = new Float32Array(T * N).fill(NaN));
  const southFirst = (g.scan & 0x40) !== 0, westFirst = (g.scan & 0x80) === 0;
  for (const m of msgs) {
    if (m.grid.ni !== g.ni || m.grid.nj !== g.nj) continue;
    const t = times.indexOf(m.valid);
    const name = m.name === 'U' ? 'u' : m.name === 'V' ? 'v' : m.name;
    const a = arr(name);
    const conv = (name === 'u' || name === 'v' || name === 'gust' || name === 'gu' || name === 'gv' || name === 'cu' || name === 'cv') ? MS2KN : 1;
    for (let j = 0; j < ny; j++) {
      const jj = j0 + j, row = southFirst ? jj : g.nj - 1 - jj;
      for (let i = 0; i < nx; i++) {
        const ii = i0 + i, col = westFirst ? ii : g.ni - 1 - ii;
        const v = m.vals[row * g.ni + col];
        a[t * N + j * nx + i] = v === v ? v * conv : NaN;
      }
    }
  }
  if (!vars.u || !vars.v) throw new Error('GRIB nema vjetar na 10 m (U/V)');
  // gusts given as u/v components: their strength is what the app shows
  if (vars.gu && vars.gv) { if (!vars.gust) { const g = vars.gust = new Float32Array(T * N); for (let i = 0; i < g.length; i++) g[i] = Math.hypot(vars.gu[i], vars.gv[i]); } delete vars.gu; delete vars.gv; }
  else { delete vars.gu; delete vars.gv; }
  return { lat0: south + j0 * dlat, lon0: west + i0 * dlon, dlat, dlon, nx, ny, model: id, times, vars, validUntil: times[T - 1], run: { runInit: times[0] } };
}

// crop one decoded message to a bbox right away (keeps memory small when reading many global files)
// maxPts: for very large areas (zoomed far out) every k-th grid point is kept, so a whole-Mediterranean view stays
// a few MB instead of hundreds – the detail is not visible at that zoom anyway.
export function cropMsg(m, bbox, maxPts = Infinity) {
  const g = m.grid;
  const lonN = x => (x >= 180 ? x - 360 : x);
  const south = Math.min(g.la1, g.la2), west = lonN(g.lo1), dlon = g.di, dlat = g.dj;
  const i0 = Math.max(0, Math.floor((bbox.w - west) / dlon) - 1), i1 = Math.min(g.ni - 1, Math.ceil((bbox.e - west) / dlon) + 1);
  const j0 = Math.max(0, Math.floor((bbox.s - south) / dlat) - 1), j1 = Math.min(g.nj - 1, Math.ceil((bbox.n - south) / dlat) + 1);
  if (i1 <= i0 || j1 <= j0) return null;
  const k = Math.max(1, Math.ceil(Math.sqrt((i1 - i0 + 1) * (j1 - j0 + 1) / maxPts)));
  const nx = Math.floor((i1 - i0) / k) + 1, ny = Math.floor((j1 - j0) / k) + 1, vals = new Float32Array(nx * ny);
  const southFirst = (g.scan & 0x40) !== 0, westFirst = (g.scan & 0x80) === 0;
  for (let j = 0; j < ny; j++) {
    const row = southFirst ? j0 + j * k : g.nj - 1 - (j0 + j * k);
    for (let i = 0; i < nx; i++) {
      const col = westFirst ? i0 + i * k : g.ni - 1 - (i0 + i * k);
      vals[j * nx + i] = m.vals[row * g.ni + col];
    }
  }
  const la1 = south + j0 * dlat, lo1 = west + i0 * dlon;
  return { name: m.name, valid: m.valid, vals, grid: { ni: nx, nj: ny, la1, lo1, la2: la1 + (ny - 1) * dlat * k, lo2: lo1 + (nx - 1) * dlon * k, di: dlon * k, dj: dlat * k, scan: 0x40, npts: nx * ny } };
}

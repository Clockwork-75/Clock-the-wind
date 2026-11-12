// Clock the Wind – live position of the boat from the device (Geolocation API).
//
// What this module guards against (a wrong position is worse than no position):
//   · coarse fixes (Wi-Fi / IP guesses on a Mac or a Wi-Fi iPad) – every fix carries its accuracy radius and is graded;
//     only 'good' and 'ok' fixes feed speed, course, the track and routing
//   · stale fixes (a cached position handed out after the app wakes up) – a fix older than 15 s on arrival is ignored
//   · jumps (a single fix hundreds of metres away) – rejected unless three in a row agree on the new place
//   · noise at rest – below ~0.7 kn the course over ground is meaningless and is not shown
//   · a watch that silently stops after the phone was locked – it is restarted when the app is visible again
// The GPS runs only while the app is on screen (a web app gets no position in the background anyway), so it costs
// battery only while you are looking at it.
import { distNm, bearing } from './geo.js';

export const GPS = {
  good: 25,            // m  accuracy radius (≈68 %) – full trust
  usable: 100,         // m  still fine for routing (the router works on a ~135 m grid)
  show: 3000,          // m  worse than this is not even drawn
  arriveMaxAgeMs: 15000,
  staleMs: 12000,      // no new fix for this long → "stale"
  lostMs: 60000,       // → "lost"
  routeMaxAgeMs: 20000,
  maxKn: 45,           // faster than this between two fixes = a jump, not sailing
  minMoveKn: 0.7,      // below this the course over ground is noise
  smoothMs: 10000,     // SOG/COG shown = mean over the last 10 s
  trackMinM: 15, trackMaxGapMs: 180000, trackMax: 6000, trackKeepMs: 48 * 3600000,
};
const KN = 1.943844;   // m/s → knots
const NM_M = 1852;

export const gpsGrade = acc => !(acc > 0) ? 'poor' : acc <= GPS.good ? 'good' : acc <= GPS.usable ? 'ok' : 'poor';

export class Gps {
  constructor({ onUpdate = () => {}, geo = (typeof navigator !== 'undefined' ? navigator.geolocation : null), now = () => Date.now() } = {}) {
    this.onUpdate = onUpdate; this.geo = geo; this.now = now;
    this.on = false; this.watchId = null; this.err = null;   // err: 'denied' | 'unsupported' | 'insecure' | null
    this.fix = null;        // latest fix worth showing (any grade up to GPS.show)
    this.best = null;       // latest 'good'/'ok' fix – the only kind used for speed, track and routing
    this.win = [];          // recent trusted fixes with a velocity sample (for smoothing)
    this.long = [];         // one sample every ~5 s for the last 15 min (for the performance average)
    this.track = [];        // [{lat, lon, t, g}]  g = 1 → starts a new segment (gap or jump)
    this.jump = [];         // candidate fixes rejected as jumps
    this.lastCb = 0; this.rejected = 0; this.count = 0;
    this._timer = null;
    this._vis = () => { if (!this.on) return; if (document.hidden) this._unwatch(); else this._watch(); };
  }
  supported() { return !!(this.geo && this.geo.watchPosition); }

  start() {
    if (this.on) return true;
    if (!this.supported()) { this.err = (typeof isSecureContext !== 'undefined' && !isSecureContext) ? 'insecure' : 'unsupported'; this.onUpdate(this); return false; }
    this.on = true; this.err = null;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._vis);
    this._watch();
    // health check: state changes with the age of the last fix; a watch that went quiet is restarted
    this._timer = setInterval(() => {
      if (!this.on) return;
      if (this.watchId != null && this.now() - this.lastCb > 45000) { this._unwatch(); this._watch(); }
      this.onUpdate(this);
    }, 2000);
    this.onUpdate(this);
    return true;
  }
  stop() {
    this.on = false; this._unwatch(); clearInterval(this._timer); this._timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._vis);
    this.fix = null; this.best = null; this.win = []; this.long = []; this.jump = [];
    this.onUpdate(this);
  }
  _watch() {
    if (this.watchId != null || !this.on) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.lastCb = this.now();
    try {
      this.watchId = this.geo.watchPosition(p => this._pos(p), e => this._error(e), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    } catch (e) { this.err = 'unsupported'; this.on = false; }
  }
  _unwatch() { if (this.watchId != null) { try { this.geo.clearWatch(this.watchId); } catch { /* ignore */ } this.watchId = null; } }
  _error(e) {
    this.lastCb = this.now();
    if (e && e.code === 1) { this.err = 'denied'; this.on = false; this._unwatch(); clearInterval(this._timer); this._timer = null; this.fix = null; this.best = null; this.win = []; this.long = []; }
    // code 2 (no position) and 3 (timeout): keep watching – the state shows "searching"/"stale" by itself
    this.onUpdate(this);
  }

  // one raw position from the device → validated, graded, filtered
  _pos(p) {
    const now = this.now(); this.lastCb = now; this.count++;
    const c = p && p.coords; if (!c) return;
    const lat = +c.latitude, lon = +c.longitude;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) { this.rejected++; return; }
    let t = +p.timestamp;
    if (!(t > 0) || t > now + 5000 || now - t > 24 * 3600000) t = now;      // a broken device clock stamp: trust arrival time
    if (now - t > GPS.arriveMaxAgeMs) { this.rejected++; return; }          // cached fix from before the app woke up
    if (this.fix && t <= this.fix.t) return;                                // duplicate / out of order
    const acc = c.accuracy > 0 ? +c.accuracy : NaN;
    if (!(acc <= GPS.show)) { this.rejected++; this.coarse = acc; this.onUpdate(this); return; }   // "Precise location" off, or an IP guess
    this.coarse = 0;
    const grade = gpsGrade(acc);
    const f = { lat, lon, t, acc, grade, sog: NaN, cog: NaN, src: '' };
    if (grade === 'poor') { this.fix = f; this.onUpdate(this); return; }    // shown (grey, big circle), never used

    // jump filter against the last trusted fix
    const b = this.best; let newSeg = !b;
    if (b && t - b.t < 5 * 60000) {
      const dt = Math.max(0.5, (t - b.t) / 1000);
      const dM = Math.max(0, distNm(b.lat, b.lon, lat, lon) * NM_M - acc - b.acc);
      if (dM / dt * KN > GPS.maxKn) {
        this.jump = this.jump.filter(j => t - j.t < 20000 && distNm(j.lat, j.lon, lat, lon) * NM_M < 150);
        this.jump.push(f);
        if (this.jump.length < 3) { this.rejected++; this.onUpdate(this); return; }
        this.win = []; this.long = []; newSeg = true;                       // three fixes agree: the old place was wrong
      }
    } else if (b) { this.win = []; newSeg = true; }                         // long pause: speed starts fresh
    this.jump = [];

    // velocity sample: the device's own Doppler speed/course when it gives them, else from the last fixes
    let vx = NaN, vy = NaN;
    const ds = +c.speed, dh = +c.heading;
    if (c.speed != null && ds >= 0 && ds < 40) {
      if (c.heading != null && dh >= 0 && dh <= 360 && ds * KN >= GPS.minMoveKn) { vx = ds * KN * Math.sin(dh * Math.PI / 180); vy = ds * KN * Math.cos(dh * Math.PI / 180); f.src = 'gps'; }
      else if (ds * KN < GPS.minMoveKn) { vx = 0; vy = 0; f.src = 'gps'; }
    }
    if (vx !== vx) {
      // from positions: the fix 5–20 s back, and only when the move is clearly larger than the position noise
      const back = [...this.win].reverse().find(w => t - w.t >= 5000 && t - w.t <= 20000);
      if (back) {
        const dNm = distNm(back.lat, back.lon, lat, lon), dtH = (t - back.t) / 3600000;
        if (dNm * NM_M > Math.max(12, acc + back.acc)) { const s = dNm / dtH, br = bearing(back.lat, back.lon, lat, lon) * Math.PI / 180; vx = s * Math.sin(br); vy = s * Math.cos(br); }
        else { vx = 0; vy = 0; }
        f.src = 'calc';
      }
    }
    f.vx = vx; f.vy = vy;
    this.win.push(f); while (this.win.length && t - this.win[0].t > 30000) this.win.shift();
    const m = this.mean(GPS.smoothMs);
    if (m) { f.sog = m.sog; f.cog = m.cog; }
    if (vx === vx && (!this.long.length || t - this.long[this.long.length - 1].t >= 5000)) {
      this.long.push({ t, vx, vy }); while (this.long.length && t - this.long[0].t > 15 * 60000) this.long.shift();
    }
    this.fix = f; this.best = f;
    this._trackAdd(f, newSeg);
    this.onUpdate(this);
  }

  // mean speed/course over the last `ms` (vector mean, so a wobbling course does not inflate the speed)
  mean(ms, src = this.win) {
    const t1 = src.length ? src[src.length - 1].t : 0, s = src.filter(w => w.vx === w.vx && t1 - w.t <= ms);
    if (!s.length) return null;
    let x = 0, y = 0, sp = 0; for (const w of s) { x += w.vx; y += w.vy; sp += Math.hypot(w.vx, w.vy); }
    x /= s.length; y /= s.length; sp /= s.length;
    return { sog: sp, cog: sp >= GPS.minMoveKn && Math.hypot(x, y) > 0.3 ? (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 : NaN, n: s.length, span: t1 - s[0].t };
  }
  // steady average for comparing with the polar: needs at least 60 % of the window really covered
  steady(ms = 120000) {
    const m = this.mean(ms, this.long);
    // one sample per 5 s: at least half of them must be there (a pause in the middle does not count as sailing)
    return m && m.span >= ms * 0.6 && m.n >= ms / 5000 * 0.5 && this.now() - this.long[this.long.length - 1].t < 15000 ? m : null;
  }

  _trackAdd(f, newSeg) {
    const tr = this.track, l = tr[tr.length - 1];
    if (l && !newSeg) {
      const dM = distNm(l.lat, l.lon, f.lat, f.lon) * NM_M, dt = f.t - l.t;
      if (dt > GPS.trackMaxGapMs) newSeg = true;
      else if (dM < GPS.trackMinM && dt < 120000) return;
      else if (dM < Math.max(f.acc, 8) && dt < 120000) return;              // still inside the noise
    }
    tr.push({ lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), t: f.t, ...(newSeg && tr.length ? { g: 1 } : {}) });
    if (tr.length > GPS.trackMax) tr.splice(0, tr.length - GPS.trackMax + 500);
    this.trackDirty = true;
  }
  loadTrack(arr) {
    const min = this.now() - GPS.trackKeepMs;
    const ok = Array.isArray(arr) ? arr.filter(p => p && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && p.t > min) : [];
    if (ok.length) { ok[0] = { ...ok[0] }; delete ok[0].g; this.track = ok.concat(this.track.map((p, i) => i ? p : { ...p, g: 1 })); }
  }
  clearTrack() { this.track = []; this.trackDirty = true; this.onUpdate(this); }
  segments() { const out = []; for (const p of this.track) { if (p.g || !out.length) out.push([]); out[out.length - 1].push([p.lat, p.lon]); } return out; }

  // 'off' | 'denied' | 'unsupported' | 'insecure' | 'searching' | 'good' | 'ok' | 'poor' | 'stale' | 'lost'
  status() {
    if (this.err) return this.err;
    if (!this.on) return 'off';
    if (!this.fix) return 'searching';
    const age = this.now() - this.fix.t;
    if (age > GPS.lostMs) return 'lost';
    if (age > GPS.staleMs) return 'stale';
    return this.fix.grade;
  }
  // a fix you may start a route from: fresh and accurate enough – or null
  routable() { const b = this.best; return this.on && b && this.now() - b.t <= GPS.routeMaxAgeMs ? b : null; }

  // wait for a routable fix (the first fixes after switching on are often coarse); rejects with a reason
  waitRoutable(timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const had = this.on;
      if (!had && !this.start()) return reject(new Error(this.err || 'unsupported'));
      const t0 = this.now();
      const tick = () => {
        const r = this.routable();
        // settle for 'ok' only after a few seconds – a 'good' fix usually follows right behind
        if (r && (r.grade === 'good' || this.now() - t0 > 6000)) { clearInterval(iv); return resolve(r); }
        if (this.err) { clearInterval(iv); return reject(new Error(this.err)); }
        if (this.now() - t0 > timeoutMs) { clearInterval(iv); return reject(new Error(this.fix ? 'poor:' + Math.round(this.fix.acc) : 'nofix')); }
      };
      const iv = setInterval(tick, 300); tick();
    });
  }
}

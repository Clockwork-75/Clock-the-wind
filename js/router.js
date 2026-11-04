// Isochrone weather routing.
// Inputs: wind field (u,v kn, gust), optional marine field (cu,cv kn, wave m), polar, land mask, course marks.
import { distNm, bearing, move, angDiff, speedDirFromUV, D2R } from './geo.js';
import { sample } from './field.js';
import { segmentHitsLand, isLand } from './landmask.js';
import { recommendSail } from './sails.js';

const W = ['u', 'v', 'gust'];
const C = ['cu', 'cv', 'wave'];

export function route({ wind, marine, polar, mask, marks, startTime, opts = {}, onProgress }) {
  const o = {
    dtMin: 10, headingStep: 3, efficiency: 1.0, tackPenaltySec: 25, gybePenaltySec: 20,
    useCurrents: true, wavePenalty: true, maxHours: 96, sectorDeg: 1.5, arriveNm: 0.12,
    ...opts,
  };
  const tEnd = wind.validUntil || wind.times[wind.times.length - 1];
  let t = startTime;
  let cur = { lat: marks[0].lat, lon: marks[0].lon };
  const track = [];
  const isochrones = [];
  const legs = [];
  let lastSign = 0;
  const wv = [], cv = [];

  for (let leg = 1; leg < marks.length; leg++) {
    const tgt = marks[leg];
    const res = runLeg(cur, tgt, t, lastSign);
    if (!res.ok) return { ok: false, error: res.error, track, isochrones, legs };
    // stitch
    for (const p of res.path) if (!track.length || track[track.length - 1].t !== p.t) track.push(p);
    legs.push({ to: tgt.name || `Oznaka ${leg}`, eta: res.eta });
    t = res.eta; cur = { lat: tgt.lat, lon: tgt.lon }; lastSign = res.lastSign;
    track[track.length - 1].mark = tgt.name || `Oznaka ${leg}`;
  }
  const full = smoothSails(enrich(track));
  return { ok: true, track: full, isochrones, legs, startTime, eta: t, stats: stats(full, startTime, t) };

  function windAt(lat, lon, time) {
    sample(wind, W, lat, lon, time, wv);
    if (wv[0] !== wv[0]) return null;
    const [tws, twd] = speedDirFromUV(wv[0], wv[1]);
    return { tws, twd, gust: wv[2] };
  }
  function currentAt(lat, lon, time) {
    if (!marine || !o.useCurrents) return [0, 0, 0];
    sample(marine, C, lat, lon, time, cv);
    return [cv[0] === cv[0] ? cv[0] : 0, cv[1] === cv[1] ? cv[1] : 0, cv[2] === cv[2] ? cv[2] : 0];
  }
  function waveFactor(hs, twa) {
    if (!o.wavePenalty || !hs) return 1;
    // simple empirical loss: up to ~12% upwind in 2.5 m sea for a 12 m sportboat
    const up = Math.max(0, Math.cos(twa * D2R));
    return 1 - Math.min(0.2, 0.05 * hs * (0.4 + up));
  }

  function runLeg(from, tgt, t0, sign0) {
    const dt = o.dtMin * 60000;
    const distTotal = distNm(from.lat, from.lon, tgt.lat, tgt.lon);
    let front = [{ lat: from.lat, lon: from.lon, t: t0, parent: null, sign: sign0, hdg: null }];
    const maxSteps = Math.ceil(o.maxHours * 60 / o.dtMin);
    let best = null;
    const nb = Math.round(360 / o.sectorDeg);
    for (let step = 0; step < maxSteps; step++) {
      const tn = t0 + (step + 1) * dt;
      if (tn > tEnd) return { ok: false, error: 'Prognoza završava prije dolaska na cilj – produži prognozu ili pomakni start.' };
      const buckets = new Array(nb);
      for (const p of front) {
        const w = windAt(p.lat, p.lon, p.t);
        if (!w) continue;
        const [cu, cvv, hs] = currentAt(p.lat, p.lon, p.t);
        const toT = bearing(p.lat, p.lon, tgt.lat, tgt.lon);
        const dT = distNm(p.lat, p.lon, tgt.lat, tgt.lon);
        // try direct arrival
        {
          const twa = angDiff(toT, w.twd);
          const bsp = polar.speed(Math.abs(twa), w.tws) * o.efficiency * waveFactor(hs, Math.abs(twa));
          const vx = bsp * Math.sin(toT * D2R) + cu, vy = bsp * Math.cos(toT * D2R) + cvv;
          const sog = Math.hypot(vx, vy);
          if (bsp > 0.3 && sog * o.dtMin / 60 >= dT && !segmentHitsLand(mask, p.lat, p.lon, tgt.lat, tgt.lon)) {
            const eta = p.t + dT / sog * 3600000;
            if (!best || eta < best.eta) best = { eta, node: { lat: tgt.lat, lon: tgt.lon, t: eta, parent: p, hdg: toT, sign: Math.sign(twa) || p.sign } };
          }
        }
        for (let h = 0; h < 360; h += o.headingStep) {
          const twa = angDiff(h, w.twd);
          const atwa = Math.abs(twa);
          let bsp = polar.speed(atwa, w.tws) * o.efficiency * waveFactor(hs, atwa);
          if (bsp < 0.3) continue;
          const sign = Math.sign(twa) || 1;
          let lost = 0;
          if (p.sign && sign !== p.sign) lost = (atwa < 90 ? o.tackPenaltySec : o.gybePenaltySec);
          const frac = Math.max(0, 1 - lost / (o.dtMin * 60));
          const vx = bsp * Math.sin(h * D2R) + cu, vy = bsp * Math.cos(h * D2R) + cvv;
          const sog = Math.hypot(vx, vy), cog = (Math.atan2(vx, vy) / D2R + 360) % 360;
          const nm = sog * o.dtMin / 60 * frac;
          const [lat, lon] = move(p.lat, p.lon, cog, nm);
          // passing close to the target during this step counts as arrival
          const brgS = bearing(from.lat, from.lon, lat, lon);
          const dS = distNm(from.lat, from.lon, lat, lon);
          const b = Math.floor(brgS / o.sectorDeg) % nb;
          const cand = { lat, lon, t: tn, parent: p, sign, hdg: h, dS, twa };
          // score: distance from leg start, slightly favour progress to target
          cand.score = dS - 0.15 * distNm(lat, lon, tgt.lat, tgt.lon);
          const arr = buckets[b] || (buckets[b] = []);
          arr.push(cand);
          // closest approach to target along the segment
          const along = closestApproach(p, cand, tgt);
          if (along.d < o.arriveNm && !segmentHitsLand(mask, p.lat, p.lon, lat, lon)) {
            const eta = p.t + along.f * (tn - p.t);
            if (!best || eta < best.eta) best = { eta, node: { lat: tgt.lat, lon: tgt.lon, t: eta, parent: p, hdg: h, sign } };
          }
        }
      }
      if (best && best.eta <= tn) return finish(best);
      // prune: per sector keep the best candidate that does not cross land
      const next = [];
      for (let b = 0; b < nb; b++) {
        const arr = buckets[b];
        if (!arr) continue;
        arr.sort((x, y) => y.score - x.score);
        for (let k = 0; k < Math.min(arr.length, 6); k++) {
          const c = arr[k];
          if (!segmentHitsLand(mask, c.parent.lat, c.parent.lon, c.lat, c.lon) && !isLand(mask, c.lat, c.lon)) { next.push(c); break; }
        }
      }
      if (!next.length) return { ok: false, error: 'Nema prolaza – sve opcije udaraju u kopno ili nema vjetra.' };
      // drop points that are clearly going backwards (much farther from target than start)
      front = next.filter(c => distNm(c.lat, c.lon, tgt.lat, tgt.lon) < distTotal * 1.6 + 3);
      if ((step + 1) % Math.max(1, Math.round(60 / o.dtMin)) === 0) {
        // isochrone as polyline pieces: break where neighbours are far apart (islands, pruned sectors)
        const pts = front.slice().sort((a, b) => bearing(from.lat, from.lon, a.lat, a.lon) - bearing(from.lat, from.lon, b.lat, b.lon));
        const avgR = pts.reduce((a, c) => a + (c.dS || 0), 0) / Math.max(1, pts.length);
        const gap = Math.max(0.8, avgR * 0.12);
        let piece = [];
        for (let k = 0; k < pts.length; k++) {
          if (k && distNm(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon) > gap) { if (piece.length > 1) isochrones.push(piece); piece = []; }
          piece.push([pts[k].lat, pts[k].lon]);
        }
        if (piece.length > 1) isochrones.push(piece);
      }
      if (onProgress && step % 6 === 0) onProgress(Math.min(0.99, 1 - Math.min(...front.map(c => distNm(c.lat, c.lon, tgt.lat, tgt.lon))) / distTotal));
    }
    return best ? finish(best) : { ok: false, error: 'Ruta nije pronađena unutar maksimalnog vremena.' };
  }

  function finish(best) {
    const path = [];
    let n = best.node;
    while (n) { path.push({ lat: n.lat, lon: n.lon, t: n.t, hdg: n.hdg }); n = n.parent; }
    path.reverse();
    // heading of each point = heading used to leave it
    for (let i = 0; i < path.length - 1; i++) path[i].hdg = path[i + 1].hdg;
    return { ok: true, eta: best.eta, path, lastSign: best.node.sign };
  }

  function enrich(tr) {
    return tr.map((p, i) => {
      const w = windAt(p.lat, p.lon, p.t) || { tws: NaN, twd: NaN, gust: NaN };
      const [cu, cvv, hs] = currentAt(p.lat, p.lon, p.t);
      const hdg = p.hdg != null ? p.hdg : (i > 0 ? tr[i - 1].hdg : 0);
      const twa = angDiff(hdg, w.twd);
      const bsp = polar.speed(Math.abs(twa), w.tws) * o.efficiency * waveFactor(hs, Math.abs(twa));
      const s = o.sails === false ? { label: atwaLabel(twa), color: atwaColor(twa) } : recommendSail(twa, w.tws);
      return { ...p, hdg, tws: w.tws, twd: w.twd, gust: w.gust, twa, bsp, cur: Math.hypot(cu, cvv), hs, sail: s.label, sailColor: s.color };
    });
  }
}

// sail hysteresis: ignore sail changes that would last less than 30 min
function smoothSails(tr, minMs = 30 * 60000) {
  let changed = true, guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    let i = 0;
    while (i < tr.length) {
      let j = i; while (j + 1 < tr.length && tr[j + 1].sail === tr[i].sail) j++;
      const dur = (tr[Math.min(j + 1, tr.length - 1)].t - tr[i].t);
      if (i > 0 && dur < minMs && j < tr.length - 1) {
        for (let k = i; k <= j; k++) { tr[k].sail = tr[i - 1].sail; tr[k].sailColor = tr[i - 1].sailColor; }
        changed = true;
      }
      i = j + 1;
    }
  }
  return tr;
}

const atwaLabel = twa => { const a = Math.abs(twa); return a < 70 ? 'Kroz' : a < 120 ? 'Bočni' : 'Krma'; };
const atwaColor = twa => { const a = Math.abs(twa); return a < 70 ? '#ef6a24' : a < 120 ? '#f2d930' : '#3ec7ff'; };

function closestApproach(a, b, p) {
  const k = Math.cos(a.lat * D2R);
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12;
  const f = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  const cx = ax + dx * f, cy = ay + dy * f;
  return { f, d: Math.hypot(px - cx, py - cy) * 60 };
}

export function stats(track, t0, t1) {
  let dist = 0, up = 0, reach = 0, down = 0, tacks = 0, gybes = 0, sailChanges = 0, maxTws = 0, maxGust = 0;
  const sails = {};
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    const d = distNm(a.lat, a.lon, b.lat, b.lon); dist += d;
    const dur = (b.t - a.t) / 3600000;
    const atwa = Math.abs(a.twa);
    if (atwa < 70) up += dur; else if (atwa < 120) reach += dur; else down += dur;
    if (Math.sign(a.twa) !== Math.sign(b.twa) && i < track.length - 1) { if (Math.abs(b.twa) < 90) tacks++; else gybes++; }
    if (a.sail !== b.sail) sailChanges++;
    sails[a.sail.split(' ')[0]] = (sails[a.sail.split(' ')[0]] || 0) + dur;
    if (a.tws > maxTws) maxTws = a.tws;
    if (a.gust > maxGust) maxGust = a.gust;
  }
  const hours = (t1 - t0) / 3600000;
  const tot = up + reach + down || 1;
  return { hours, dist, avgSog: dist / hours, pctUp: up / tot, pctReach: reach / tot, pctDown: down / tot, tacks, gybes, sailChanges, maxTws, maxGust, sails };
}

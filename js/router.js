// Isochrone weather routing.
// Inputs: wind field (u,v kn, gust), optional marine field (cu,cv kn, wave m), polar, land mask, course marks.
import { distNm, bearing, move, angDiff, speedDirFromUV, D2R } from './geo.js';
import { sample } from './field.js';
import { segmentHitsLand, isLand, snapToSea } from './landmask.js';
import { recommendSail } from './sails.js';

const W = ['u', 'v', 'gust'];
const C = ['cu', 'cv', 'wave'];

export function route({ wind, marine, polar, mask, marks, startTime, opts = {}, onProgress }) {
  const o = {
    dtMin: 10, headingStep: 3, efficiency: 1.0, tackPenaltySec: 25, gybePenaltySec: 20,
    useCurrents: true, wavePenalty: true, maxHours: 96, sectorDeg: 1.5, arriveNm: 0.15,
    // isochrone pruning per sector: 'sea' = point closest to the mark by water (around islands),
    // 'classic' = point farthest from the leg start (Expedition / LuckGrib / SailGrib), 'hybrid' = both points per sector,
    // 'both' = every leg routed with 'sea' and with 'classic' separately, the earlier arrival is kept
    prune: 'both',
    ...opts,
  };
  const tEnd = wind.validUntil || wind.times[wind.times.length - 1];
  // marks on islets / in harbours: route to the nearest navigable point next to them
  const snaps = [];
  marks = marks.map((mk, i) => {
    const sn = snapToSea(mask, mk.lat, mk.lon);
    if (sn.fail) snaps.push({ i, name: mk.name, fail: true });
    else if (sn.snapped) snaps.push({ i, name: mk.name, nm: sn.nm });
    return sn.snapped ? { ...mk, lat: sn.lat, lon: sn.lon, orig: { lat: mk.lat, lon: mk.lon } } : mk;
  });
  const bad = snaps.find(x => x.fail);
  if (bad) return { ok: false, error: `Oznaka "${bad.name}" je duboko u kopnu – pomakni je na more.`, track: [], isochrones: [], legs: [] };
  let t = startTime;
  let cur = { lat: marks[0].lat, lon: marks[0].lon };
  const track = [];
  const isochrones = [];
  const legs = [];
  let lastSign = 0;
  const wv = [], cv = [];

  for (let leg = 1; leg < marks.length; leg++) {
    const tgt = marks[leg];
    let res;
    if (o.prune === 'both') {
      const a = runLeg(cur, tgt, t, lastSign, 'sea', [0, 0.5]), c = runLeg(cur, tgt, t, lastSign, 'classic', [0.5, 0.5]);
      res = !a.ok ? c : !c.ok ? a : (c.eta < a.eta ? c : a);
    } else res = runLeg(cur, tgt, t, lastSign, o.prune);
    if (res.iso) isochrones.push(...res.iso);
    if (!res.ok) return { ok: false, error: res.error, track, isochrones, legs };
    // stitch
    for (const p of res.path) if (!track.length || track[track.length - 1].t !== p.t) track.push(p);
    legs.push({ to: tgt.name || `Oznaka ${leg}`, eta: res.eta });
    t = res.eta; cur = { lat: tgt.lat, lon: tgt.lon }; lastSign = res.lastSign;
    track[track.length - 1].mark = tgt.name || `Oznaka ${leg}`;
  }
  const full = smoothSails(enrich(track));
  // wind above the polar's last TWS column: the polar can only repeat that column there (speed held, not extrapolated)
  const polarTop = polar.src && polar.src.tws ? polar.src.tws[polar.src.tws.length - 1] : 40;
  let overH = 0, overMax = 0;
  for (let i = 0; i < full.length - 1; i++) if (full[i].tws > polarTop + 0.5) { overH += (full[i + 1].t - full[i].t) / 3600000; overMax = Math.max(overMax, full[i].tws); }
  const overPolar = overH > 0 ? { top: polarTop, maxTws: overMax, hours: overH } : null;
  return { ok: true, track: full, isochrones, legs, snaps, startTime, eta: t, stats: stats(full, startTime, t), overPolar };

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

  function runLeg(from, tgt, t0, sign0, prune, pg = [0, 1]) {
    const iso = [];
    const dt = o.dtMin * 60000;
    const distTotal = distNm(from.lat, from.lon, tgt.lat, tgt.lon);
    const sea = seaField(mask, from, tgt);            // shortest distance to the mark *by water* (around islands)
    const seaOrigin = sea.at(from.lat, from.lon);
    let front = [{ lat: from.lat, lon: from.lon, t: t0, parent: null, sign: sign0, hdg: null }];
    const maxSteps = Math.ceil(o.maxHours * 60 / o.dtMin);
    let best = null;
    for (let step = 0; step < maxSteps; step++) {
      const tn = t0 + (step + 1) * dt;
      if (tn > tEnd) return { ok: false, error: 'Prognoza završava prije dolaska na cilj – produži prognozu ili pomakni start.' };
      // sector width adapts to the frontier radius so neighbouring kept points stay ~0.35 nm apart
      const avgR = front.reduce((a, c) => a + (c.dS || 0), 0) / Math.max(1, front.length);
      const secDeg = Math.min(o.sectorDeg, Math.max(0.3, (0.35 / Math.max(0.3, avgR)) / D2R));
      const nb = Math.ceil(360 / secDeg);
      const buckets = new Array(nb);
      const all = [];
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
          const b = Math.floor(brgS / secDeg) % nb;
          const cand = { lat, lon, t: tn, parent: p, sign, hdg: h, dS, twa };
          // score: distance from leg start, slightly favour progress to target
          cand.sea = sea.at(lat, lon);
          cand.score = -cand.sea + 0.02 * dS;            // keep, per sector, the point closest to the mark by water
          const arr = buckets[b] || (buckets[b] = []);
          arr.push(cand); all.push(cand);
          // closest approach to target along the segment
          const along = closestApproach(p, cand, tgt);
          if (along.d < o.arriveNm && !segmentHitsLand(mask, p.lat, p.lon, lat, lon) && !segmentHitsLand(mask, p.lat, p.lon, tgt.lat, tgt.lon)) {
            const eta = p.t + along.f * (tn - p.t);
            if (!best || eta < best.eta) best = { eta, node: { lat: tgt.lat, lon: tgt.lon, t: eta, parent: p, hdg: h, sign } };
          }
        }
      }
      if (best && best.eta <= tn) return finish(best, iso);
      // prune: per sector keep the best candidate that does not cross land
      const next = [];
      for (let b = 0; b < nb; b++) {
        const arr = buckets[b];
        if (!arr) continue;
        let seaPick = null;
        if (prune !== 'classic') {
          arr.sort((x, y) => y.score - x.score);
          for (let k = 0; k < Math.min(arr.length, 6); k++) {
            const c = arr[k];
            if (!segmentHitsLand(mask, c.parent.lat, c.parent.lon, c.lat, c.lon) && !isLand(mask, c.lat, c.lon)) { next.push(c); seaPick = c; break; }
          }
        }
        if (prune !== 'sea') {
          // classic isochrone: the point that got farthest from the leg start in this direction
          arr.sort((x, y) => y.dS - x.dS);
          for (let k = 0; k < Math.min(arr.length, 6); k++) {
            const c = arr[k];
            if (c === seaPick) break;   // same point as the sea pick: nothing to add
            if (!segmentHitsLand(mask, c.parent.lat, c.parent.lon, c.lat, c.lon) && !isLand(mask, c.lat, c.lon)) { next.push(c); break; }
          }
        }
      }
      // always also keep the points closest to the mark by water (harbour entrances, narrow channels)
      const kept = new Set(next);
      all.sort((x, y) => x.sea - y.sea);
      for (let k = 0, added = 0; k < all.length && added < 30; k++) {
        const c = all[k]; if (kept.has(c)) continue;
        if (!segmentHitsLand(mask, c.parent.lat, c.parent.lon, c.lat, c.lon) && !isLand(mask, c.lat, c.lon)) { next.push(c); kept.add(c); added++; k += 3; }
      }
      if (!next.length) return { ok: false, error: 'Nema prolaza – sve opcije udaraju u kopno ili nema vjetra.' };
      // drop points that are clearly going backwards (much farther from target than start)
      front = next.filter(c => c.sea < seaOrigin * 1.25 + 12);
      if ((step + 1) % Math.max(1, Math.round(60 / o.dtMin)) === 0) {
        // isochrone as polyline pieces: break where neighbours are far apart (islands, pruned sectors)
        const pts = front.slice().sort((a, b) => bearing(from.lat, from.lon, a.lat, a.lon) - bearing(from.lat, from.lon, b.lat, b.lon));
        const avgR = pts.reduce((a, c) => a + (c.dS || 0), 0) / Math.max(1, pts.length);
        const gap = Math.max(0.8, avgR * 0.12);
        let piece = [];
        for (let k = 0; k < pts.length; k++) {
          if (k && distNm(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon) > gap) { if (piece.length > 1) iso.push(piece); piece = []; }
          piece.push([pts[k].lat, pts[k].lon]);
        }
        if (piece.length > 1) iso.push(piece);
      }
      if (!front.length) return { ok: false, error: 'Nema prolaza – ruta je odsječena kopnom ili plićinama.' };
      if (onProgress && step % 6 === 0) onProgress(pg[0] + pg[1] * Math.min(0.99, 1 - Math.min(...front.map(c => c.sea)) / Math.max(0.1, seaOrigin)));
    }
    return best ? finish(best, iso) : { ok: false, error: 'Ruta nije pronađena unutar maksimalnog vremena.' };
  }

  function finish(best, iso) {
    const path = [];
    let n = best.node;
    while (n) { path.push({ lat: n.lat, lon: n.lon, t: n.t, hdg: n.hdg }); n = n.parent; }
    path.reverse();
    // heading of each point = heading used to leave it
    for (let i = 0; i < path.length - 1; i++) path[i].hdg = path[i + 1].hdg;
    return { ok: true, eta: best.eta, path, lastSign: best.node.sign, iso };
  }

  function enrich(tr) {
    return tr.map((p, i) => {
      const w = windAt(p.lat, p.lon, p.t) || { tws: NaN, twd: NaN, gust: NaN };
      const [cu, cvv, hs] = currentAt(p.lat, p.lon, p.t);
      const hdg = p.hdg != null ? p.hdg : (i > 0 ? tr[i - 1].hdg : 0);
      const twa = angDiff(hdg, w.twd);
      const bsp = polar.speed(Math.abs(twa), w.tws) * o.efficiency * waveFactor(hs, Math.abs(twa));
      const s = !o.sails ? { label: atwaLabel(twa), color: atwaColor(twa) } : recommendSail(twa, w.tws, o.sails === true ? 'melges40' : o.sails);
      return { ...p, hdg, tws: w.tws, twd: w.twd, gust: w.gust, twa, bsp, cur: Math.hypot(cu, cvv), hs, sail: s.label, sailColor: s.color };
    });
  }
}

// Distance-to-mark through navigable water on a coarse grid (Dijkstra, 8 neighbours), so the isochrone
// pruning prefers points that are truly closer to the mark around islands, not ones stuck in dead-end bays.
function seaField(mask, a, b) {
  const straight = { at: (lat, lon) => distNm(lat, lon, b.lat, b.lon) };
  if (!mask) return straight;
  const K = 4, margin = 0.8;
  const latN = Math.min(mask.lat1, Math.max(a.lat, b.lat) + margin), latS = Math.max(mask.lat0, Math.min(a.lat, b.lat) - margin);
  const lonW = Math.max(mask.lon0, Math.min(a.lon, b.lon) - margin), lonE = Math.min(mask.lon1, Math.max(a.lon, b.lon) + margin);
  const r0 = Math.max(0, Math.floor((mask.lat1 - latN) / mask.dlat)), r1 = Math.min(mask.NR, Math.ceil((mask.lat1 - latS) / mask.dlat));
  const c0 = Math.max(0, Math.floor((lonW - mask.lon0) / mask.dlon)), c1 = Math.min(mask.NC, Math.ceil((lonE - mask.lon0) / mask.dlon));
  const R = Math.ceil((r1 - r0) / K), C = Math.ceil((c1 - c0) / K), N = R * C;
  const pass = new Uint8Array(N);
  for (let r = r0; r < r1; r++) {
    const rr = ((r - r0) / K) | 0, row = r * mask.NC;
    for (let c = c0; c < c1; c++) if (!mask.data[row + c]) pass[rr * C + (((c - c0) / K) | 0)] = 1;
  }
  const idx = (lat, lon) => {
    const rr = Math.floor(((mask.lat1 - lat) / mask.dlat - r0) / K), cc = Math.floor(((lon - mask.lon0) / mask.dlon - c0) / K);
    return rr < 0 || cc < 0 || rr >= R || cc >= C ? -1 : rr * C + cc;
  };
  const kLat = K * mask.dlat * 60, kLon = K * mask.dlon * 60 * Math.cos((latN + latS) / 2 * D2R), kDia = Math.hypot(kLat, kLon);
  const dist = new Float32Array(N).fill(Infinity);
  // binary heap (growable) of [key, cell]; stale entries are skipped via `done`
  let hk = new Float64Array(1024), hi = new Int32Array(1024), hn = 0;
  const push = (key, i) => {
    if (hn === hk.length) { const k2 = new Float64Array(hn * 2), i2 = new Int32Array(hn * 2); k2.set(hk); i2.set(hi); hk = k2; hi = i2; }
    let k = hn++; while (k > 0) { const p = (k - 1) >> 1; if (hk[p] <= key) break; hk[k] = hk[p]; hi[k] = hi[p]; k = p; } hk[k] = key; hi[k] = i;
  };
  const pop = () => {
    const top = hi[0], lk = hk[--hn], li = hi[hn]; let k = 0;
    for (;;) { let l = 2 * k + 1; if (l >= hn) break; if (l + 1 < hn && hk[l + 1] < hk[l]) l++; if (hk[l] >= lk) break; hk[k] = hk[l]; hi[k] = hi[l]; k = l; }
    hk[k] = lk; hi[k] = li; return top;
  };
  const done = new Uint8Array(N);
  const t = idx(b.lat, b.lon);
  if (t < 0) return straight;
  pass[t] = 1; dist[t] = 0; push(0, t);
  const DR = [-1, 1, 0, 0, -1, -1, 1, 1], DC = [0, 0, -1, 1, -1, 1, -1, 1], W = [kLat, kLat, kLon, kLon, kDia, kDia, kDia, kDia];
  while (hn > 0) {
    const i = pop(); if (done[i]) continue; done[i] = 1;
    const r = (i / C) | 0, c = i - r * C, d = dist[i];
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k], cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= R || cc >= C) continue;
      const j = rr * C + cc; if (!pass[j] || done[j]) continue;
      const nd = d + W[k]; if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
    }
  }
  return {
    at(lat, lon) {
      const i = idx(lat, lon);
      if (i < 0) return distNm(lat, lon, b.lat, b.lon) * 1.5 + 10;      // outside the search window
      const d = dist[i];
      return d === Infinity ? 1e6 : d;
    },
  };
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

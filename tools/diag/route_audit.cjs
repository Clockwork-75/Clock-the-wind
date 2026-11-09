// Diagnostic (no app changes): real cloud package, real course (Jabuka), real polar – route every model and audit
// every step of every route, then re-route with finer settings to see how sensitive the result (and the model order) is.
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  p.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
  await p.goto(base + 'index.html');
  await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.models.length >= 3, null, { timeout: 120000 });
  await p.evaluate(() => window.ctw.fn.openSheet('course'));
  await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(800);
  const res = await p.evaluate(async () => {
    const c = window.ctw, s = c.state.set, H = 3600000;
    const { route } = await import('/js/router.js');
    const { sample } = await import('/js/field.js');
    const { speedDirFromUV, distNm, angDiff } = await import('/js/geo.js');
    const { recommendSail } = await import('/js/sails.js');
    const start = Math.ceil(Date.now() / H) * H + 2 * H;
    const marks = c.course.marks.map(m => ({ name: m.name, lat: m.lat, lon: m.lon }));
    const ids = s.models.filter(id => s.fields[id] && s.fields[id].times && s.fields[id].times[0] <= start && (s.fields[id].validUntil || 0) > start + 12 * H);
    const out = { start: new Date(start).toISOString(), marks: marks.map(m => m.name + ' ' + m.lat.toFixed(3) + ',' + m.lon.toFixed(3)), boat: c.state.boat.name, models: ids, variants: {}, audit: {} };
    const polar = c.state.polar, mask = c.state.mask, marine = s.fields.marine;
    const V = { 'osnovno (dt10, 3°, sektor 1.5°)': { dtMin: 10, headingStep: 3, sectorDeg: 1.5 }, 'fino (dt5, 2°, 1°)': { dtMin: 5, headingStep: 2, sectorDeg: 1.0 }, 'najfinije (dt5, 1°, 0.5°)': { dtMin: 5, headingStep: 1, sectorDeg: 0.5 } };
    const common = { efficiency: 1, tackPenaltySec: 25, gybePenaltySec: 20, useCurrents: true, wavePenalty: true, sails: 'melges40' };
    for (const [vn, vo] of Object.entries(V)) {
      out.variants[vn] = {};
      for (const id of ids) {
        const t0 = performance.now();
        const r = route({ wind: s.fields[id], marine, polar, mask, marks, startTime: start, opts: { ...common, ...vo } });
        out.variants[vn][id] = r.ok ? { h: +((r.eta - start) / H).toFixed(2), dist: +r.stats.dist.toFixed(1), tacks: r.stats.tacks, gybes: r.stats.gybes, ms: Math.round(performance.now() - t0) } : { err: r.error };
        if (vn.startsWith('osnovno') && r.ok) {
          // step-by-step audit
          const a = { steps: 0, bspVsPolar: 0, sogVsBsp: 0, worst: [], sails: {}, strong: [] };
          for (let i = 0; i < r.track.length - 1; i++) {
            const q = r.track[i], n = r.track[i + 1], dtH = (n.t - q.t) / H; if (dtH <= 0) continue;
            const o = sample(s.fields[id], ['u', 'v'], q.lat, q.lon, q.t, []); const [tws, twd] = speedDirFromUV(o[0], o[1]);
            const twa = Math.abs(angDiff(q.hdg, twd)), pol = polar.speed(twa, tws);
            const sogObs = distNm(q.lat, q.lon, n.lat, n.lon) / dtH;
            a.steps++;
            if (Math.abs(q.bsp - pol) > Math.max(0.3, pol * 0.22)) a.bspVsPolar++;   // >22 % = more than wave loss can explain
            const mo = sample(marine, ['cu', 'cv'], q.lat, q.lon, q.t, []), cur = mo[0] === mo[0] ? Math.hypot(mo[0], mo[1]) : 0;
            const tacked = Math.sign(q.twa) !== Math.sign(n.twa);
            if (!tacked && Math.abs(sogObs - q.bsp) > cur + Math.max(0.4, q.bsp * 0.08)) { a.sogVsBsp++; if (a.worst.length < 4) a.worst.push(`${new Date(q.t).toISOString().slice(11, 16)} TWS ${tws.toFixed(1)} TWA ${twa.toFixed(0)} bsp ${q.bsp.toFixed(1)} polar ${pol.toFixed(1)} SOG ${sogObs.toFixed(1)} struja ${cur.toFixed(1)}`); }
            const sail = q.sail.split(' ')[0]; a.sails[sail] = a.sails[sail] || { n: 0, twsMin: 99, twsMax: 0, bsp: 0 };
            const S = a.sails[sail]; S.n++; S.twsMin = Math.min(S.twsMin, tws); S.twsMax = Math.max(S.twsMax, tws); S.bsp += q.bsp;
            const rec = recommendSail(twa, tws, 'melges40').sail;
            if (tws >= 18 && a.strong.length < 5) a.strong.push(`TWS ${tws.toFixed(1)} TWA ${twa.toFixed(0)} jedro ${q.sail} (preporuka ${rec}) bsp ${q.bsp.toFixed(1)} polar ${pol.toFixed(1)} val ${(q.hs || 0).toFixed(1)} m`);
          }
          for (const k in a.sails) { const S = a.sails[k]; S.bsp = +(S.bsp / S.n).toFixed(1); S.twsMin = +S.twsMin.toFixed(1); S.twsMax = +S.twsMax.toFixed(1); }
          // the wind each model has along the straight course line, hourly
          a.windOnCourse = [];
          for (let h = 0; h <= 12; h += 2) { const t = start + h * H, m = marks[1]; const o = sample(s.fields[id], ['u', 'v'], (marks[0].lat + m.lat) / 2, (marks[0].lon + m.lon) / 2, t, []); const [w, d] = speedDirFromUV(o[0], o[1]); a.windOnCourse.push(`+${h}h ${w.toFixed(0)}kn/${d.toFixed(0)}°`); }
          out.audit[id] = a;
        }
      }
    }
    return out;
  });
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})();

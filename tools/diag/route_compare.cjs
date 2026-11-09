// Diagnostic (no app changes): compare the isochrone pruning methods on the real cloud package.
//   sea     = per sector the point closest to the mark by water (Clock the Wind ≤ 3.0)
//   classic = per sector the point farthest from the leg start (Expedition / LuckGrib / SailGrib)
//   hybrid  = both points per sector
// Every route is the same physics (same polar, wind, currents, penalties), so a shorter ETA means the method found a
// faster route that really exists. Each route is also checked: no segment over land, every step's boat speed equal
// to the polar, marks reached in order. Then the same courses with the wind made 2.2× stronger (heavy-air test, and
// the "wind above the polar" warning).
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
  p.on('pageerror', e => console.log('PAGE ERROR', e.message));
  p.on('console', m => { if (m.text().startsWith('##')) console.log(m.text().slice(2)); });
  await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
  await p.goto(base + 'index.html');
  await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.models.length >= 3 && window.ctw.state.mask, null, { timeout: 180000 });
  const res = await p.evaluate(async () => {
    const c = window.ctw, s = c.state.set, H = 3600000;
    const { route } = await import('/js/router.js');
    const { sample } = await import('/js/field.js');
    const { speedDirFromUV, angDiff } = await import('/js/geo.js');
    const { segmentHitsLand } = await import('/js/landmask.js');
    const { PRESETS } = await import('/js/courses.js');
    const polar = c.state.polar, mask = c.state.mask, marine = s.fields.marine;
    const scale = (f, k) => {
      if (!f) return f;
      const vars = { ...f.vars };
      for (const n of ['u', 'v', 'gust']) if (vars[n]) vars[n] = vars[n].map(x => x * k);
      return { ...f, vars, ext: scale(f.ext, k) };
    };
    const common = { efficiency: 1, tackPenaltySec: 25, gybePenaltySec: 20, useCurrents: true, wavePenalty: true, sails: 'melges40', dtMin: 10 };
    const now = Math.ceil(Date.now() / H) * H;
    const scen = [{ k: 1, start: now + 2 * H }, { k: 1, start: now + 14 * H }, { k: 2.2, start: now + 2 * H }];
    const rows = [];
    const check = (r, wind, marks) => {
      let land = 0, bad = 0;
      for (let i = 0; i < r.track.length - 1; i++) {
        const q = r.track[i], n = r.track[i + 1];
        if (segmentHitsLand(mask, q.lat, q.lon, n.lat, n.lon)) land++;
        const o = sample(wind, ['u', 'v'], q.lat, q.lon, q.t, []); const [tws, twd] = speedDirFromUV(o[0], o[1]);
        const pol = polar.speed(Math.abs(angDiff(q.hdg, twd)), tws);
        if (Math.abs(q.bsp - pol) > Math.max(0.3, pol * 0.22)) bad++;
      }
      const seen = r.track.filter(q => q.mark).length;
      return { land, bad, marksOk: seen === marks.length - 1 };
    };
    for (const sc of scen) for (const pr of PRESETS) {
      const marks = pr.marks.map(m => ({ name: m.name, lat: m.lat, lon: m.lon }));
      for (const id of s.models) {
        const f0 = s.fields[id]; if (!f0 || !f0.times) continue;
        const wind = sc.k === 1 ? f0 : scale(f0, sc.k);
        const row = { course: pr.id, model: id.replace('dir_', '').replace('italia_meteo_arpae_', ''), k: sc.k, start: new Date(sc.start).toISOString().slice(5, 13) };
        for (const m of ['sea', 'classic', 'hybrid', 'both']) {
          const t0 = performance.now();
          const r = route({ wind, marine, polar, mask, marks, startTime: sc.start, opts: { ...common, prune: m } });
          const ms = Math.round(performance.now() - t0);
          row[m] = r.ok ? { h: +((r.eta - sc.start) / H).toFixed(3), ms, ...check(r, wind, marks), over: r.overPolar ? `${r.overPolar.maxTws.toFixed(0)}kn/${r.overPolar.hours.toFixed(1)}h` : '' } : { err: r.error.slice(0, 40), ms };
        }
        rows.push(row);
        const f = x => x.err ? 'ERR ' + x.err : `${x.h.toFixed(2)}h ${x.ms}ms${x.land ? ' LAND' + x.land : ''}${x.bad ? ' POLAR' + x.bad : ''}${x.marksOk ? '' : ' MARKS!'}${x.over ? ' over ' + x.over : ''}`;
        console.log(`## ${row.course.padEnd(12)} ${row.model.padEnd(10)} ×${sc.k} ${row.start} | sea ${f(row.sea)} | classic ${f(row.classic)} | hybrid ${f(row.hybrid)} | both ${f(row.both)}`);
      }
    }
    // summary: per method, how often it is best / how much slower than the best found
    const sum = {};
    for (const m of ['sea', 'classic', 'hybrid', 'both']) sum[m] = { ok: 0, err: 0, best: 0, worseMin: [], land: 0, polarBad: 0, marksBad: 0, ms: 0 };
    for (const r of rows) {
      const ok = ['sea', 'classic', 'hybrid', 'both'].filter(m => !r[m].err);
      const best = Math.min(...ok.map(m => r[m].h));
      for (const m of ['sea', 'classic', 'hybrid', 'both']) {
        const x = r[m], S = sum[m]; S.ms += x.ms;
        if (x.err) { S.err++; continue; }
        S.ok++; if (x.h <= best + 1e-3) S.best++; S.worseMin.push((x.h - best) * 60);
        S.land += x.land; S.polarBad += x.bad; S.marksBad += x.marksOk ? 0 : 1;
      }
    }
    for (const m in sum) { const w = sum[m].worseMin.sort((a, b) => a - b); sum[m].worseMin = { mean: +(w.reduce((a, b) => a + b, 0) / (w.length || 1)).toFixed(1), median: +(w[w.length >> 1] || 0).toFixed(1), max: +(w[w.length - 1] || 0).toFixed(1) }; sum[m].ms = Math.round(sum[m].ms / rows.length); }
    // does the method change which model is fastest?
    const orderChanges = [];
    for (const sc of scen) for (const pr of PRESETS) {
      const rr = rows.filter(r => r.course === pr.id && r.k === sc.k && r.start === new Date(sc.start).toISOString().slice(5, 13));
      const order = m => rr.filter(r => !r[m].err).sort((a, b) => a[m].h - b[m].h).map(r => r.model).join('>');
      if (order('sea') !== order('both')) orderChanges.push(`${pr.id} ×${sc.k} ${rr[0] && rr[0].start}: sea ${order('sea')} | both ${order('both')}`);
    }
    return { routes: rows.length, summary: sum, orderChanges };
  });
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})();

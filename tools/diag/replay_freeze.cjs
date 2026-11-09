// Diagnostic: does the wind picture on the map keep changing during a race replay? Real cloud package, Jabuka,
// routing for all models, then the replay is played; every second we record the race time, the model on the map,
// whether the wind canvas changed (particles off) and the wind on the map at the followed boat. Any stretch where the
// race time moves on but the wind picture stays the same is reported as a freeze.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [days, speed] of [[0, 10], [0, 120], [1, 120], [3, 120]]) {
    const p = await b.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
    await p.goto(base + 'index.html');
    await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 180000 });
    await p.evaluate(() => window.ctw.fn.openSheet('course'));
    await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(500);
    const info = await p.evaluate(async ([days, speed]) => {
      const c = window.ctw, H = 3600000;
      c.course.start = Math.ceil(Date.now() / H) * H + 2 * H + days * 24 * H;
      await c.fn.runRouting(c.state.set.models.filter(id => !id.startsWith('clockw')));
      c.settings.replaySpeed = speed;
      document.querySelector('#sheet').classList.add('hidden');
      c.state.particles = false;
      return { routes: c.fn.okRoutes().map(r => `${r.model.replace('dir_', '')} ${((r.eta - r.startTime) / H).toFixed(1)}h`), selected: c.state.selected, map: c.state.modelId };
    }, [days, speed]);
    // the user's typical choice: follow the ECMWF boat
    await p.evaluate(() => { const c = window.ctw; if (c.state.routes.dir_ecmwf && c.state.routes.dir_ecmwf.ok) { c.state.selected = 'dir_ecmwf'; } c.fn.replayPlay(); });
    let last = null, frozen = 0, worst = 0, run = 0; const rows = [];
    for (let k = 0; k < 40; k++) {
      await p.waitForTimeout(1000);
      const s = await p.evaluate(async () => {
        const c = window.ctw, st = c.state; const { sample } = await import('/js/field.js');
        const cv = document.querySelector('.leaflet-wx-pane > canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) % 1000000007;
        const r = st.routes[st.selected], q = c.fn.routeAt(r, st.time), o = sample(st.wind, ['u', 'v'], q.lat, q.lon, st.time, []);
        return { t: st.time, h, m: st.modelId, w: Math.hypot(o[0], o[1]), bw: q.tws, on: document.querySelector('#rpPlay') ? 1 : 0, ended: document.body.classList.contains('wx-ended') };
      });
      if (last) {
        const dt = (s.t - last.t) / 60000;
        if (dt > 0 && s.h === last.h) { frozen++; run++; worst = Math.max(worst, run); } else run = 0;
        rows.push(`${new Date(s.t + 3600000).toISOString().slice(11, 16)} +${dt.toFixed(0)}min ${s.h === last.h ? 'ISTA SLIKA' : 'promjena'} karta=${s.m.replace('dir_', '')} vjetar karta ${s.w.toFixed(1)} brod ${s.bw.toFixed(1)}${s.ended ? ' (model završio)' : ''}`);
      }
      last = s;
    }
    console.log(`\n=== start +${days} d, ${speed} s/s:`, JSON.stringify(info), `| sekundi bez promjene slike: ${frozen}/39, najdulje zaredom ${worst}`);
    rows.forEach((r, i) => { if (i % 3 === 0 || r.includes('ISTA')) console.log('  ' + r); });
    await p.close();
  }
  await b.close();
})();

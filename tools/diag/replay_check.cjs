// Diagnostic (no app changes): real cloud package, real course (Jabuka), routing through the app itself, then the race
// replay. While the replay runs, record what the MAP shows (model, time, wind sampled from the map's field at the
// followed boat, a checksum of the colour canvas, number of redraws) next to what the BOAT shows (route wind at that time).
// If the map is frozen, the map wind / checksum stay put while the boat's wind changes.
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://localhost:8080/';
const dayOffset = +(process.argv[3] || 0);   // start N days ahead (regatta later in the week)
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const [label, vp, slow] of [['Mac', { width: 1440, height: 900 }, 1], ['iPad (CPU 4x sporiji)', { width: 1180, height: 820, deviceScaleFactor: 2 }, 4]]) {
    const p = await b.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor || 1 });
    if (slow > 1) { const cdp = await p.context().newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: slow }); }
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    p.on('console', m => { if (m.type() === 'error' || m.text().startsWith('routing took')) console.log('console:', m.text().slice(0, 200)); });
    await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud', replaySpeed: 120 })); });
    await p.goto(base + 'index.html');
    await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.models.length >= 3 && window.ctw.state.mask, null, { timeout: 180000 });
    await p.evaluate(() => window.ctw.fn.openSheet('course'));
    await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(800);
    const info = await p.evaluate(async (dayOffset) => {
      const c = window.ctw, H = 3600000;
      c.course.start = Math.ceil(Date.now() / H) * H + 2 * H + dayOffset * 24 * H;
      const ids = c.state.set.models.filter(id => !id.startsWith('clockw'));
      await c.fn.runRouting(ids);
      const ok = c.fn.okRoutes();
      return { start: new Date(c.course.start).toISOString(), setTimes: [new Date(c.state.set.times[0]).toISOString(), new Date(c.state.set.times[c.state.set.times.length - 1]).toISOString(), c.state.set.times.length],
        routes: ok.map(r => `${r.model} ${((r.eta - r.startTime) / H).toFixed(2)}h`), selected: c.state.selected, modelOnMap: c.state.modelId };
    }, dayOffset);
    console.log(label, JSON.stringify(info));
    // count redraws of the colour layer
    await p.evaluate(() => { const w = window.ctw.fn.wx(); window.__draws = 0; const d = w.draw.bind(w); w.draw = () => { window.__draws++; d(); }; });
    await p.evaluate(() => { window.__t0 = window.ctw.state.time; window.__w0 = performance.now(); window.ctw.fn.replayPlay(); });
    const rows = [];
    for (let k = 0; k < 12; k++) {
      await p.waitForTimeout(1500);
      rows.push(await p.evaluate(async () => {
        const c = window.ctw, s = c.state;
        const { sample } = await import('/js/field.js');
        const { speedDirFromUV } = await import('/js/geo.js');
        const r = s.routes[s.selected], q = c.fn.routeAt(r, s.time);
        const o = sample(s.wind, ['u', 'v'], q.lat, q.lon, s.time, []); const [mw, md] = speedDirFromUV(o[0], o[1]);
        const cv = document.querySelector('.leaflet-pane canvas') ;
        let sum = 0; try { const all = [...document.querySelectorAll('canvas')]; const big = all.sort((a, b) => b.width * b.height - a.width * a.height)[0]; const d = big.getContext('2d').getImageData(0, 0, big.width, big.height).data; for (let i = 0; i < d.length; i += 997) sum = (sum + d[i] * (i % 13 + 1)) % 1e9; } catch (e) { sum = 'x' + e.message; }
        const rate = ((s.time - window.__t0) / 1000) / ((performance.now() - window.__w0) / 1000);
        return `${new Date(s.time).toISOString().slice(5, 16)} brzina ${rate.toFixed(0)} s/s · karta=${s.modelId.replace('dir_', '')} vjetar karte na brodu ${mw.toFixed(1)}kn/${md.toFixed(0)}° | brod(${s.selected.replace('dir_', '')}) ${q.tws.toFixed(1)}kn/${q.twd.toFixed(0)}° | crtanja ${window.__draws} | canvas ${sum} | replay ${s && document.querySelector('#rpPlay') ? 'on' : '?'}`;
      }));
    }
    rows.forEach(r => console.log('  ' + r));
    
    await p.close();
  }
  await b.close();
})();

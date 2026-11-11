// Diagnostic of the user's exact case (iPad, Safari engine): layer "Udari", start Saturday ~3 days ahead, routing
// ICON-EU / ARPEGE / ECMWF / GFS, follow ICON-EU, replay 120 s/s. At several moments the replay is caught: screenshot of
// the map DURING the replay, then pause + set the same time by hand (what the user does by tapping the route) and a
// second screenshot. Both must be identical. Also the data under the view and the app's internal state are logged.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const fs = require('fs'), crypto = require('crypto');
const base = process.argv[2] || 'http://localhost:8080/';
const md5 = b => crypto.createHash('md5').update(b).digest('hex').slice(0, 8);
(async () => {
  fs.mkdirSync('shots/ru', { recursive: true });
  const b = await pw.webkit.launch();
  const dev = pw.devices['iPad Pro 11 landscape'] || { viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  for (const layer of ['gust', 'wind']) {
    const ctx = await b.newContext({ ...dev });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
    await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
    await p.goto(base + 'index.html');
    await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 180000 });
    await p.evaluate(() => window.ctw.fn.openSheet('course'));
    await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(500);
    const info = await p.evaluate(async layer => {
      const c = window.ctw, H = 3600000, st = c.state;
      // Saturday 07:00 local of this week (3 days ahead in the user's case)
      const d = new Date(); d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7)); d.setUTCHours(6, 0, 0, 0);
      c.course.start = d.getTime();
      const want = ['dir_icon_eu', 'dir_arpege', 'dir_ecmwf', 'dir_gfs'].filter(id => st.set.fields[id]);
      await c.fn.runRouting(want);
      c.settings.replaySpeed = 120;
      document.querySelector('#sheet').classList.add('hidden');
      const lb = document.querySelector(`#layerbar [data-layer="${layer}"]`); if (lb) lb.click();
      if (st.routes.dir_icon_eu && st.routes.dir_icon_eu.ok) st.selected = 'dir_icon_eu';
      const f = st.set.fields.dir_icon_eu;
      return { start: new Date(c.course.start).toISOString(), layer: st.layer, routes: c.fn.okRoutes().map(r => `${r.model} ${((r.eta - r.startTime) / H).toFixed(1)}h`),
        iconEu: f ? { t0: new Date(f.times[0]).toISOString(), t1: new Date(f.times[f.times.length - 1]).toISOString(), n: f.times.length, vars: Object.keys(f.vars), ext: !!f.ext } : null, particles: st.particles };
    }, layer);
    console.log(`\n===== sloj ${layer}:`, JSON.stringify(info));
    await p.evaluate(() => window.ctw.fn.replayPlay());
    const clip = { x: 150, y: 250, width: 500, height: 350 };
    let prev = null;
    for (let k = 0; k < 6; k++) {
      await p.waitForTimeout(k ? 4000 : 2500);
      // DURING the replay
      let a; try { a = await p.screenshot({ clip, timeout: 8000 }); } catch (e) { a = Buffer.from('NEMA SLIKE ' + k); console.log('  !! u replayu preglednik 8 s nije iscrtao nijednu sliku'); }
      const sa = await p.evaluate(() => { const c = window.ctw, st = c.state, wx = c.fn.wx(); return { t: st.time, m: st.modelId, sel: st.selected, layer: st.layer, data: wx.dataHash(), px: wx.pixelHash(), lite: c.fn.viewCheckLite() }; });
      // pause + the same time set by hand
      await p.evaluate(t => { const c = window.ctw; c.fn.replayPause(); c.fn.setTime(t); }, sa.t);
      await p.waitForTimeout(700);
      const bb = await p.screenshot({ clip });
      const sb = await p.evaluate(() => { const c = window.ctw, st = c.state, wx = c.fn.wx(); return { t: st.time, m: st.modelId, data: wx.dataHash(), px: wx.pixelHash() }; });
      if (a.length > 100) fs.writeFileSync(`shots/ru/${layer}-${k}-replay.png`, a); fs.writeFileSync(`shots/ru/${layer}-${k}-pauza.png`, bb);
      console.log(`${new Date(sa.t + 3600000).toISOString().slice(5, 16)} karta=${sa.m} sloj=${sa.layer} | replay ${md5(a)} pauza ${md5(bb)} ${md5(a) === md5(bb) ? 'ISTO' : 'RAZLIČITO'} | podaci replay=pauza ${sa.data === sb.data} | platno replay=pauza ${sa.px === sb.px} | promjena od prošlog ${prev ? (prev !== md5(a)) : '-'} | ${JSON.stringify(sa.lite)}`);
      prev = md5(a);
      await p.evaluate(() => window.ctw.fn.replayPlay());
    }
    await ctx.close();
  }
  await b.close();
})();

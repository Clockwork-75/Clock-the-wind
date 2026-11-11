// Diagnostic: the user's exact case – routing for ARPEGE only, particles on (default), replay. Every second: race time,
// model on the map, number of full redraws, errors caught by the app, and whether the picture ON SCREEN (screenshot of a
// map area, not the canvas memory) changed. A stretch where the time moves and the screen does not is a freeze.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const crypto = require('crypto');
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  for (const eng of (process.env.ENGINES || 'webkit').split(',')) {
    const b = await pw[eng].launch(eng === 'chromium' && process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    for (const [vw, vh, dpr, speed, only] of [[1180, 820, 2, 600, ['dir_arpege']], [390, 844, 3, 1800, ['dir_arpege']]]) {
      const p = await b.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
      p.on('pageerror', e => console.log('PAGE ERROR', e.message));
      await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
      await p.goto(base + 'index.html');
      await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 180000 });
      await p.evaluate(() => window.ctw.fn.openSheet('course'));
      await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(500);
      const info = await p.evaluate(async ([speed, only]) => {
        const c = window.ctw, H = 3600000;
        c.course.start = Math.ceil(Date.now() / H) * H + 2 * H;
        await c.fn.runRouting(only || c.state.set.models.filter(id => !id.startsWith('clockw') && id !== 'moja'));
        c.settings.replaySpeed = speed;
        document.querySelector('#sheet').classList.add('hidden');
        return { models: c.state.set.models, routes: c.fn.okRoutes().map(r => `${r.model} ${((r.eta - r.startTime) / H).toFixed(1)}h`), selected: c.state.selected, map: c.state.modelId, particles: c.state.particles, layer: c.state.layer };
      }, [speed, only]);
      await p.evaluate(() => window.ctw.fn.replayPlay());
      // a patch of open sea west of Vis: wind colours + arrows, no boats most of the time; particles hidden for the screenshot hash
      await p.addStyleTag({ content: '.leaflet-particles-pane{visibility:hidden!important}' });
      const clip = { x: Math.round(vw * 0.08), y: Math.round(vh * 0.55), width: Math.round(vw * 0.18), height: Math.round(vh * 0.14) };
      let last = null, frozen = 0, run = 0, worst = 0; const rows = [];
      for (let k = 0; k < 30; k++) {
        await p.waitForTimeout(1000);
        const s = await p.evaluate(() => { const c = window.ctw, st = c.state; return { t: st.time, m: st.modelId, sel: st.selected, v: c.fn.viewCheckLite ? c.fn.viewCheckLite() : null, ended: document.body.classList.contains('wx-ended') }; });
        const shot = crypto.createHash('md5').update(await p.screenshot({ clip })).digest('hex').slice(0, 8);
        if (last) {
          const dt = (s.t - last.t) / 60000, same = shot === last.shot;
          if (dt > 1 && same) { frozen++; run++; worst = Math.max(worst, run); } else run = 0;
          rows.push(`${new Date(s.t + 3600000).toISOString().slice(11, 16)} +${dt.toFixed(0)}min ${same ? 'ISTA SLIKA' : 'promjena'} karta=${s.m} ${s.v ? JSON.stringify(s.v) : ''}${s.ended ? ' (model završio)' : ''}`);
        }
        last = { ...s, shot };
      }
      console.log(`\n=== ${eng} ${vw}x${vh}@${dpr} ${speed} s/s ${only ? 'samo ARPEGE' : 'svi modeli'}:`, JSON.stringify(info), `| sekundi bez promjene slike na ekranu: ${frozen}/29, najdulje zaredom ${worst}`);
      rows.forEach((r, i) => { if (i % 4 === 0 || r.includes('ISTA')) console.log('  ' + r); });
      await p.close();
    }
    await b.close();
  }
})();

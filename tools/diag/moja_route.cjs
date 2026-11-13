// Diagnostic: why does MOJA not route? Real cloud package + live measurements, MOJA built, routing Jabuka (start Saturday)
// with ALADIN, ICON-EU, ARPEGE, ClockW-like set and MOJA; prints each model's result / error and MOJA's time coverage.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await pw.webkit.launch();
  const p = await b.newPage({ viewport: { width: 1180, height: 820 } });
  p.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud', ovObs: true })); });
  await p.goto(base + 'index.html');
  await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 180000 });
  await p.waitForFunction(() => window.ctw.state.obs, null, { timeout: 60000 }).catch(() => console.log('obs nije učitan'));
  await p.waitForTimeout(3000);
  await p.evaluate(() => window.ctw.fn.openSheet('course'));
  await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(500);
  const out = await p.evaluate(async () => {
    const c = window.ctw, st = c.state, H = 3600000, f = d => new Date(d + 3600000).toISOString().slice(5, 16).replace('T', ' ');
    const d = new Date(); d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7)); d.setUTCHours(6, 0, 0, 0);
    c.course.start = d.getTime();
    const bm = c.fn.buildMoja ? c.fn.buildMoja() : null;
    const m = st.set.fields.moja;
    const info = { start: f(c.course.start), now: f(Date.now()), moja: m ? `${f(m.times[0])} → ${f(m.validUntil)} (${m.times.length} h)` : 'NEMA', models: st.set.models.join(','), buildMoja: bm };
    const want = ['dir_aladin', 'dir_icon_eu', 'dir_arpege', 'moja'].filter(id => st.set.fields[id]);
    // the routing tab's own filter (which models are offered at all)
    c.fn.openSheet('routing');
    const offered = [...document.querySelectorAll('#sheet input[type=checkbox][value]')].map(x => `${x.value}${x.disabled ? '(SIVO)' : ''}`).join(' ');
    await c.fn.runRouting(want);
    info.offered = offered;
    info.results = want.map(id => { const r = st.routes[id]; return `${id}: ${r ? (r.ok ? 'OK cilj ' + f(r.eta) : 'GREŠKA ' + r.error) : 'nije računato'}`; });
    return info;
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})();

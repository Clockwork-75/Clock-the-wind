// Diagnostic: import real GRIB files into the app in a real browser – as files and as links – and report the result.
// Usage: node tools/diag/grib_test.cjs <dir with test files> <base url of the local app>
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const dir = process.argv[2], base = process.argv[3] || 'http://localhost:8080/';
(async () => {
  const b = await chromium.launch();
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).size > 0).sort();
  const results = [];
  const run = async (label, fn) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'forecast', source: 'openmeteo', dlModels: [] })); });
    await p.goto(base + 'index.html'); await p.waitForTimeout(3000);
    await p.evaluate(() => window.ctw.fn.openSheet('data')); await p.waitForTimeout(400);
    await fn(p);
    await p.waitForTimeout(6000);
    const r = await p.evaluate(() => { const s = window.ctw.state.set; const g = s ? s.models.filter(id => id.startsWith('grib:')) : [];
      const info = g.map(id => { const f = s.fields[id]; const out = []; const lat = f.lat0 + f.dlat * f.ny / 2, lon = f.lon0 + f.dlon * f.nx / 2;
        const t = f.times[Math.min(2, f.times.length - 1)]; let u = NaN, v = NaN; const N = f.nx * f.ny, k = Math.floor(f.ny / 2) * f.nx + Math.floor(f.nx / 2), ti = f.times.indexOf(t);
        u = f.vars.u[ti * N + k]; v = f.vars.v[ti * N + k];
        return `${id} ${f.nx}x${f.ny} ${(f.dlat * 60).toFixed(1)}nm, ${f.times.length} koraka, vars=[${Object.keys(f.vars).join(',')}], vjetar u sredini ${Math.hypot(u, v).toFixed(1)} kn iz ${Math.round((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360)}°`; });
      return { text: (document.querySelector('#dlText') || {}).textContent || '', toast: (document.querySelector('#toast') || {}).textContent || '', gribs: info, shown: window.ctw.state.modelId }; });
    results.push({ label, ...r, errs });
    await ctx.close();
  };
  for (const f of files) await run('DATOTEKA ' + f, async p => { await p.setInputFiles('#gribFile', path.join(dir, f)); });
  // links: same server (always allowed) and the original public servers (depends on their CORS)
  const links = [[base + 'grib/' + files.find(f => /gfs/.test(f) && !/\.gz$/.test(f)), 'LINK (isti poslužitelj)']]
    .concat((process.env.REMOTE_LINKS || '').split(' ').filter(Boolean).map(u => [u, 'LINK (javni poslužitelj)']));
  for (const [u, l] of links) await run(`${l} ${u.slice(0, 90)}`, async p => { await p.fill('#gribUrl', u); await p.click('#btnGribUrl'); });
  for (const r of results) {
    console.log('\n=== ' + r.label);
    console.log('  poruka: ' + r.text.slice(0, 220));
    if (r.gribs.length) r.gribs.forEach(x => console.log('  OK  ' + x)); else console.log('  NIJE UVEZENO');
    if (r.errs.length) console.log('  GREŠKA STRANICE: ' + r.errs.join(' | '));
  }
  await b.close();
})();

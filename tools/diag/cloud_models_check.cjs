// Diagnostic: the app with a locally built cloud package split by model – only the chosen models arrive, ALADIN-HR on the map.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  for (const pick of [null, ['dir_aladin', 'dir_ecmwf']]) {
    const p = await b.newPage({ viewport: { width: 1180, height: 820 } });
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    await p.addInitScript(([u, pick]) => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'forecast', source: 'cloud', cloudUrl: u, cloudModels: pick })); }, [base + 'data/latest.ctw', pick]);
    await p.goto(base + 'index.html');
    await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 120000 });
    const r = await p.evaluate(async () => {
      const c = window.ctw, s = c.state.set, { sample } = await import('/js/field.js');
      const f = s.fields.dir_aladin, H = 3600000;
      const PTS = [['Savudrija', 45.50, 13.45], ['Rovinj', 45.08, 13.55], ['Kvarner', 44.90, 14.30], ['Zadar', 44.10, 15.10], ['Šibenik', 43.70, 15.75], ['Split', 43.45, 16.30], ['Jabuka', 43.10, 15.45], ['Vis', 42.95, 16.05], ['Lastovo', 42.70, 16.85], ['Dubrovnik', 42.60, 18.00]];
      const at = f ? PTS.map(([n, la, lo]) => { const o = sample(f, ['u', 'v', 'gust'], la, lo, f.times[0] + 12 * H, []); return n + ' ' + Math.hypot(o[0], o[1]).toFixed(1) + '/' + (o[2] === o[2] ? o[2].toFixed(1) : '–') + (o[2] < Math.hypot(o[0], o[1]) - 0.5 ? ' (UDAR<VJETAR!)' : ''); }) : null;
      return { models: s.models.join(','), map: c.state.modelId, marine: !!s.fields.marine, aladin: f ? `${f.nx}x${f.ny} ${f.times.length} h od ${new Date(f.times[0]).toISOString().slice(0, 13)} · +12h vjetar/udar (kn): ${at.join(' · ')}` : 'NEMA' };
    });
    console.log('odabir', JSON.stringify(pick), '→', JSON.stringify(r));
    await p.close();
  }
  await b.close();
})();

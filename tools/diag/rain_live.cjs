// Diagnostic: the PUBLISHED cloud package (github.io), forecast mode – rain / thunderstorm data per model, the Kiša and Grmljavina layers, live radar and lightning.
// lightning overlays. Prints per model: which variables arrived, the wettest hour over the Adriatic and the max CAPE / LPI;
// screenshots of the Kiša and Grmljavina layers at that hour and of the live overlays go to diag-shots.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const base = process.argv[2] || 'http://localhost:8080/';
(async () => {
  const b = await pw.webkit.launch();
  const p = await b.newPage({ viewport: { width: 1180, height: 820 } });
  p.on('pageerror', e => console.log('PAGE ERROR', e.message));
  p.on('console', m => { if (/error|greš|fail/i.test(m.text())) console.log('KONZOLA', m.text().slice(0, 200)); });
  p.on('requestfailed', r => { if (/rainviewer|eumetsat/.test(r.url())) console.log('ZAHTJEV PAO', r.url().slice(0, 120), r.failure() && r.failure().errorText); });
  await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'forecast', source: 'cloud' })); });
  await p.goto(base + 'index.html');
  for (let k = 0; k < 20; k++) {   // progress every 10 s instead of a blind wait
    const st = await p.evaluate(() => { const c = window.ctw; if (!c) return { ready: false, msg: 'nema ctw' }; const d = c.fn.dbg ? c.fn.dbg() : {}; return { ready: !!(c.state.set && c.state.set.source === 'cloud'), src: c.state.set && c.state.set.source, msg: d.txt, toast: d.toast, dl: d.dl, models: d.models }; }).catch(e => ({ err: e.message }));
    console.log('učitavanje', k * 10, 's', JSON.stringify(st));
    if (st.ready) break;
    if (k === 19) { require('fs').mkdirSync('shots', { recursive: true }); await p.screenshot({ path: 'shots/zapelo.png' }); throw new Error('paket se nije učitao'); }
    await p.waitForTimeout(10000);
  }
  const r = await p.evaluate(async () => {
    const c = window.ctw, s = c.state.set, { sample } = await import('/js/field.js'), H = 3600000;
    const out = {};
    for (const id of s.models) {
      const f = s.fields[id]; const v = Object.keys(f.vars);
      let best = { t: 0, sum: -1 }, cmax = 0, lmax = 0, rmax = 0;
      for (let ti = 0; ti < f.times.length; ti++) {
        let sum = 0;
        for (let la = 41.8; la <= 45.8; la += 0.25) for (let lo = 13; lo <= 19.5; lo += 0.25) {
          const o = sample(f, ['precip', 'cape', 'lpi'], la, lo, f.times[ti], []);
          if (o[0] === o[0]) { sum += o[0]; rmax = Math.max(rmax, o[0]); } if (o[1] === o[1]) cmax = Math.max(cmax, o[1]); if (o[2] === o[2]) lmax = Math.max(lmax, o[2]);
        }
        if (sum > best.sum) best = { t: f.times[ti], sum };
      }
      out[id] = `područje ${f.lat0.toFixed(2)}–${(f.lat0 + f.dlat * (f.ny - 1)).toFixed(2)} N, ${f.lon0.toFixed(2)}–${(f.lon0 + f.dlon * (f.nx - 1)).toFixed(2)} E | varijable ${v.join(',')} | najkišniji sat ${new Date(best.t + H).toISOString().slice(5, 16)} (zbroj ${best.sum.toFixed(1)}), najviše ${rmax.toFixed(1)} mm/h | CAPE max ${Math.round(cmax)} | LPI max ${lmax.toFixed(1)}`;
      if (!c.wettest || best.sum > c.wettest.sum) c.wettest = { ...best, id };
    }
    return { out, wettest: c.wettest };
  });
  console.log(JSON.stringify(r, null, 1));
  require('fs').mkdirSync('shots', { recursive: true });
  for (const layer of ['rain', 'storm']) {
    await p.evaluate(([w, layer]) => { const c = window.ctw; c.fn.selectModel(w.id); document.querySelector(`#layerbar [data-layer="${layer}"]`).click(); c.fn.setTime(w.t); c.map.setView([43.5, 16], 7); }, [r.wettest, layer]);
    await p.waitForTimeout(2500); await p.screenshot({ path: `shots/sloj-${layer}.png` });
  }
  await p.evaluate(() => { document.querySelector('#layerbar [data-layer="wind"]').click(); document.querySelector('#ovRadar').click(); document.querySelector('#ovLight').click(); window.ctw.map.setView([45, 12], 5); });
  await p.waitForTimeout(8000);
  const tiles = await p.evaluate(() => [...document.querySelectorAll('.leaflet-live-pane img')].map(i => `${i.complete && i.naturalWidth ? 'OK' : 'NE'} ${i.src.slice(0, 70)}`));
  console.log('live pločice:', tiles.length, tiles.filter(t => t.startsWith('OK')).length, 'učitano;', tiles.slice(0, 3).join(' | '));
  await p.screenshot({ path: 'shots/radar-munje.png' });
  await b.close();
})();

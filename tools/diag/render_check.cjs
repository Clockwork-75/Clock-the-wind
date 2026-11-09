// Diagnostic: does the RENDERED wind picture change with time? (not the data – the pixels the user sees)
// Real cloud package, ECMWF, whole Adriatic, particles off. Compares the wind canvas at T and T+2 h:
//  A) set by hand (setTime), B) during a race replay (2 h of race time), C) the same through the timeline slider.
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const useWebkit = process.env.ENGINE === 'webkit';
const fs = require('fs');
const base = process.argv[2] || 'http://localhost:8080/';
fs.mkdirSync('shots', { recursive: true });
(async () => {
  const b = useWebkit ? await pw.webkit.launch() : await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  console.log('ENGINE', useWebkit ? 'WebKit (Safari)' : 'Chromium');
  const p = await b.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.log('PAGE ERROR', e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load/.test(m.text())) console.log('console', m.text().slice(0, 200)); });
  await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'race', source: 'cloud' })); });
  await p.goto(base + 'index.html');
  await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud', null, { timeout: 180000 });
  const grab = async name => {
    await p.waitForTimeout(700);
    await p.screenshot({ path: `shots/${name}.png` });
    return p.evaluate(() => { const cv = document.querySelector('.leaflet-wx-pane > canvas'); return Array.from(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data); });
  };
  const diff = (a, b) => { let n = 0, tot = 0; for (let i = 0; i < a.length; i += 4) { if (a[i + 3] === 0 && b[i + 3] === 0) continue; tot++; if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++; } return `${(100 * n / Math.max(1, tot)).toFixed(1)} % piksela vjetra promijenjeno (${tot} obojenih)`; };
  const info = () => p.evaluate(async () => { const c = window.ctw, s = c.state, { sample } = await import('/js/field.js');
    const pts = [[45.0, 13.3], [44.0, 14.5], [43.3, 16.0], [42.5, 17.5]].map(([la, lo]) => { const o = sample(s.wind, ['u', 'v'], la, lo, s.time, []); return Math.hypot(o[0], o[1]).toFixed(1); });
    return `${new Date(s.time + 3600000).toISOString().slice(5, 16)} model=${s.modelId} layer=${s.layer} wind.times=${s.wind && s.wind.times.length} točke ${pts.join('/')}`; });
  await p.evaluate(() => { const c = window.ctw; c.state.particles = false; c.fn.selectModel('dir_ecmwf'); c.map.setView([43.6, 15.8], 6, { animate: false }); });
  await p.waitForTimeout(1500);
  // A) by hand
  // like on the user's device: start again, the forecast now comes from the device storage (IndexedDB)
  await p.reload(); await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.models.length >= 3, null, { timeout: 180000 });
  console.log('nakon ponovnog pokretanja: source=' + await p.evaluate(() => window.ctw.state.set.source + ' modeli ' + window.ctw.state.set.models.join(',')));
  await p.evaluate(() => { const c = window.ctw; c.state.particles = false; c.fn.selectModel('dir_ecmwf'); c.map.setView([43.6, 15.8], 6, { animate: false }); });
  await p.waitForTimeout(1500);
  const H = 3600000, T0 = Date.UTC(2026, 10, 14, 8, 0);   // Saturday 14.11. 09:00 local
  console.log('ECMWF vremena oko subote:', await p.evaluate(T => { const f = window.ctw.state.set.fields.dir_ecmwf; const k = f.times.findIndex(t => t >= T); return f.times.slice(Math.max(0, k - 2), k + 4).map(t => new Date(t).toISOString().slice(5, 13)).join(' ') + (f.ext ? ' | ext ' + f.ext.times.length : ' | bez ext') + ' | ukupno ' + f.times.length + ' do ' + new Date(f.times[f.times.length - 1]).toISOString().slice(5, 13); }, T0));
  await p.evaluate(t => window.ctw.fn.setTime(t), T0); console.log('A0', await info()); const a0 = await grab('A0');
  await p.evaluate(t => window.ctw.fn.setTime(t), T0 + 2 * H); console.log('A1', await info()); const a1 = await grab('A1');
  console.log('A) setTime T → T+2h:', diff(a0, a1));
  // B) race replay
  await p.evaluate(() => window.ctw.fn.openSheet('course'));
  await p.selectOption('#regSel', 'jabuka'); await p.waitForTimeout(500);
  await p.evaluate(async t => { const c = window.ctw; c.course.start = t; await c.fn.runRouting(c.state.set.models.filter(id => !id.startsWith('clockw'))); document.querySelector('#sheet').classList.add('hidden');
    c.state.selected = 'dir_ecmwf'; c.state.particles = false; c.map.setView([43.6, 15.8], 6, { animate: false }); c.settings.replaySpeed = 120; }, T0);
  await p.waitForTimeout(1200);
  await p.evaluate(() => window.ctw.fn.replayPlay());
  await p.waitForTimeout(1500); console.log('B0', await info()); const b0 = await grab('B0');
  await p.waitForTimeout(60000); console.log('B1', await info()); const b1 = await grab('B1');
  console.log('B) replay 60 s @120 s/s (≈2 h):', diff(b0, b1));
  console.log('PROVJERA PRIKAZA (tijekom replaya):\n' + await p.evaluate(() => window.ctw.fn.viewCheck().join('\n')));
  await p.evaluate(() => window.ctw.fn.replayPause());
  await b.close();
})();

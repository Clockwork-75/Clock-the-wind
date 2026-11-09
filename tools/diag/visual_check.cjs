// Diagnostic (on demand): the app with the real cloud package, screenshots for iPhone / iPad / Mac at several zoom
// levels and layers, plus checks: map canvases fill the screen after rotation, the cloud models stay after zooming out.
// Screenshots go to ./shots (the workflow pushes them to the branch diag-shots for review).
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const fs = require('fs');
const base = process.argv[2] || 'http://localhost:8080/';
fs.mkdirSync('shots', { recursive: true });
const DEV = [
  ['iphone', { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['ipad', { width: 1180, height: 820, deviceScaleFactor: 2, hasTouch: true }],
  ['mac', { width: 1440, height: 900, deviceScaleFactor: 1 }],
];
const VIEWS = [
  ['z4-europa', 44, 15, 4, 'wind'], ['z6-jadran', 43.2, 16.2, 6, 'wind'], ['z7-srednji', 43.3, 16.0, 7, 'wind'],
  ['z7-udari', 43.3, 16.0, 7, 'gust'], ['z9-sibenik', 43.65, 15.85, 9, 'wind'], ['z11-otoci', 43.72, 15.75, 11, 'wind'],
];
(async () => {
  const b = await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const report = {};
  for (const [dev, vp] of DEV) {
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { localStorage.setItem('ctw.intro', 'off'); localStorage.setItem('ctw.settings', JSON.stringify({ mode: 'forecast', source: 'cloud' })); });
    await p.goto(base + 'index.html');
    await p.waitForFunction(() => window.ctw && window.ctw.state.set && window.ctw.state.set.source === 'cloud' && window.ctw.state.set.models.length >= 3, null, { timeout: 180000 });
    const R = report[dev] = { errs };
    for (const model of ['dir_ecmwf', 'dir_icon_d2']) {
      for (const [name, lat, lon, z, layer] of VIEWS) {
        if (model === 'dir_icon_d2' && !['z6-jadran', 'z7-udari'].includes(name)) continue;
        await p.evaluate(([model, lat, lon, z, layer]) => {
          const c = window.ctw, H = 3600000;
          if (c.state.set.fields[model]) c.fn.selectModel(model);
          const btn = document.querySelector(`#layerbar [data-layer="${layer}"]`); if (btn && c.state.layer !== layer) btn.click();
          c.map.setView([lat, lon], z, { animate: false });
          c.fn.setTime(Math.round((Date.now() + 26 * H) / H) * H);
        }, [model, lat, lon, z, layer]);
        await p.waitForTimeout(1800);
        await p.screenshot({ path: `shots/${dev}-${model.replace('dir_', '')}-${name}.png` });
      }
    }
    // zoomed far out for a while: the cloud models must stay (no automatic download replacing them)
    await p.evaluate(() => window.ctw.map.setView([44, 15], 3, { animate: false }));
    await p.waitForTimeout(8000);
    R.modelsAfterZoomOut = await p.evaluate(() => window.ctw.state.set.models.join(','));
    R.sourceAfterZoomOut = await p.evaluate(() => window.ctw.state.set.source);
    await p.screenshot({ path: `shots/${dev}-z3-svijet.png` });
    // rotation (iPad / iPhone): canvases must cover the whole map afterwards
    if (dev !== 'mac') {
      await p.setViewportSize({ width: vp.height, height: vp.width });
      await p.waitForTimeout(1500);
      await p.evaluate(() => window.ctw.map.setView([43.3, 16.0], 7, { animate: false }));
      await p.waitForTimeout(1500);
      R.afterRotate = await p.evaluate(() => { const m = window.ctw.map, s = m.getSize(), el = m.getContainer(); const cv = [...document.querySelectorAll('.leaflet-pane > canvas')].map(c => c.style.width + 'x' + c.style.height); return { map: s.x + 'x' + s.y, el: el.clientWidth + 'x' + el.clientHeight, canvases: cv }; });
      await p.screenshot({ path: `shots/${dev}-okrenut.png` });
    }
    await ctx.close();
  }
  console.log(JSON.stringify(report, null, 1));
  await b.close();
})();

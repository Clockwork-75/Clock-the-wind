import { route } from './router.js';
import { Polar } from './polar.js';

let mask = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'mask') { mask = m.mask; return; }
  if (m.cmd === 'route') {
    try {
      const polar = Polar.from(m.polar);
      const res = route({
        wind: m.wind, marine: m.marine, polar, mask, marks: m.marks, startTime: m.startTime, opts: m.opts,
        onProgress: f => self.postMessage({ id: m.id, progress: f }),
      });
      self.postMessage({ id: m.id, result: res });
    } catch (err) {
      self.postMessage({ id: m.id, result: { ok: false, error: String(err && err.message || err) } });
    }
  }
};

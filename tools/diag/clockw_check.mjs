// Diagnostic: build ClockW from the real cloud package and compare it with its models, point by point.
// Prints, for points along the Adriatic and several hours, each model's wind (dir/kn) and ClockW's,
// and flags every place where ClockW points more than 60° away from the models' own average direction.
import { readFileSync } from 'node:fs';
import { importPackage } from '../../js/direct.js';
import { buildClockW } from '../../js/ensemble.js';
import { sample } from '../../js/field.js';

const file = process.argv[2] || 'data/latest.ctw';
const buf = readFileSync(file); const set = importPackage(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ids = set.models.filter(id => set.fields[id] && set.fields[id].times);
console.log('models', ids.join(', '));
for (const id of ids) { const f = set.fields[id]; console.log(id, 'grid', f.lat0, f.lon0, f.dlat, f.dlon, f.nx + 'x' + f.ny, 'times', f.times.length, new Date(f.times[0]).toISOString(), '→', new Date(f.validUntil || f.times[f.times.length - 1]).toISOString(), f.ext ? 'ext' : ''); }
const H = 3600000, t0 = Math.floor(Date.now() / H) * H;
const cw = await buildClockW({ set, ids, num: 1, t0, hours: 24, landAt: null, progress: () => {} });
console.log('clockw grid', cw.lat0, cw.lon0, cw.dlat, cw.nx + 'x' + cw.ny, 'times', cw.times.length);
const dirOf = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
const pts = [[45.3, 13.5, 'Istra'], [44.9, 14.2, 'Kvarner'], [44.1, 15.1, 'Zadar'], [43.75, 15.75, 'Vodice'], [43.5, 16.2, 'Split'], [43.1, 16.1, 'Vis'], [43.1, 15.2, 'Jabuka'], [42.7, 17.3, 'Lastovo'], [42.6, 18.0, 'Dubrovnik']];
let bad = 0, tot = 0;
for (const h of [0, 3, 6, 9, 12, 18, 24]) {
  const t = t0 + h * H;
  for (const [lat, lon, name] of pts) {
    const o = [], row = [];
    let su = 0, sv = 0, n = 0;
    for (const id of ids) { sample(set.fields[id], ['u', 'v'], lat, lon, t, o); if (o[0] === o[0]) { const s = Math.hypot(o[0], o[1]); su += o[0] / (s || 1); sv += o[1] / (s || 1); n++; row.push(`${id.replace('dir_', '').replace('italia_meteo_arpae_', '')}:${Math.round(dirOf(o[0], o[1]))}°/${s.toFixed(0)}`); } }
    sample(cw, ['u', 'v', 'conf'], lat, lon, t, o);
    if (!n || o[0] !== o[0]) continue;
    const md = dirOf(su, sv), cd = dirOf(o[0], o[1]), diff = Math.abs(((cd - md + 540) % 360) - 180);
    tot++; if (diff > 60) bad++;
    console.log(`${diff > 60 ? '!!' : '  '} +${String(h).padStart(2)}h ${name.padEnd(9)} models[${row.join(' ')}] mean ${Math.round(md)}° | ClockW ${Math.round(cd)}°/${Math.hypot(o[0], o[1]).toFixed(0)} conf ${Math.round(o[2])}% diff ${Math.round(diff)}°`);
  }
}
console.log(`RESULT: ${bad} of ${tot} points differ by more than 60°`);

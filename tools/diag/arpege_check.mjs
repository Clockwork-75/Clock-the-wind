// Diagnostic: the ARPEGE field in a freshly built package – range, steps, wind and gusts at a few Adriatic points.
import { readFileSync } from 'node:fs';
import { importPackage } from '../../js/direct.js';
import { sample, fillTimeGaps } from '../../js/field.js';
const b = readFileSync(process.argv[2]);
const set = importPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const H = 3600000, iso = t => new Date(t + H).toISOString().slice(5, 16).replace('T', ' ');
console.log('modeli', set.models.join(','), 'greške', JSON.stringify(set.errors));
const f = set.fields.dir_arpege; if (!f) { console.log('NEMA ARPEGE'); process.exit(1); }
fillTimeGaps(f);
console.log(`ARPEGE ${f.nx}x${f.ny} ${f.lat0.toFixed(2)}N ${f.lon0.toFixed(2)}E d=${f.dlat.toFixed(3)} · ${iso(f.times[0])} → ${iso(f.times[f.times.length - 1])} (${f.times.length} koraka) · vars ${Object.keys(f.vars).join(',')} · meta ${f.meta && f.meta.name}`);
for (const [n, la, lo] of [['Split', 43.45, 16.3], ['Jabuka', 43.1, 15.45], ['Kvarner', 44.9, 14.3], ['Palagruža', 42.4, 16.25]]) {
  const r = []; for (let h = 3; h <= 75; h += 12) { const t = f.times[0] + h * H, o = sample(f, ['u', 'v', 'gust'], la, lo, t, []); r.push(`+${h}h ${Math.hypot(o[0], o[1]).toFixed(1)}/${o[2] === o[2] ? o[2].toFixed(1) : '–'}`); }
  console.log(`  ${n}: ${r.join(' · ')}`);
}

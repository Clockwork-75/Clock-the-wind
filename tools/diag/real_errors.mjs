// Diagnostic: the REAL errors of the models against the live measurements (DHMZ buoys + stations), now.
// Uses a locally built package split by model (data/models/*.ctw) and obs.json of the branch obs.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { importPackage } from '../../js/direct.js';
import { sample, fillTimeGaps } from '../../js/field.js';
const obs = await (await fetch('https://raw.githubusercontent.com/Clockwork-75/Clock-the-wind/obs/obs.json?t=' + Date.now())).json();
const idx = JSON.parse(readFileSync('data/models/index.json'));
const now = Date.now() / 1000, U3 = 1.12;
const pl = obs.places.filter(p => !p.stale && p.wspd != null && now - p.t < 3 * 3600);
console.log(`Mjerenja ${new Date(obs.created * 1000).toISOString()} – ${pl.length} svježih mjesta`);
const rows = [];
for (const m of idx.models) {
  if (m.id === 'marine') continue;
  let b = readFileSync(`data/models/${m.id}.ctw`); if (b[0] === 0x1f) b = gunzipSync(b);
  const f = importPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).fields[m.id]; fillTimeGaps(f);
  let n = 0, ve = 0, se = 0, sa = 0, sd = 0, nd = 0, rh = [], t2 = [];
  const per = [];
  for (const p of pl) {
    const sp = p.h === 3 ? p.wspd * U3 : p.wspd; if (p.wdir == null && sp > 0.5) continue;
    const a = (p.wdir || 0) * Math.PI / 180, mu = -sp * Math.sin(a), mv = -sp * Math.cos(a);
    const o = sample(f, ['u', 'v', 'rh', 't2'], p.lat, p.lon, p.t * 1000, []); if (o[0] !== o[0]) continue;
    const fs = Math.hypot(o[0], o[1]), fd = (Math.atan2(-o[0], -o[1]) * 180 / Math.PI + 360) % 360;
    const e = Math.hypot(o[0] - mu, o[1] - mv); n++; ve += e; se += fs - sp; sa += Math.abs(fs - sp);
    if (sp >= 5 && fs >= 5) { sd += Math.abs(((fd - p.wdir) % 360 + 540) % 360 - 180); nd++; }
    if (o[2] === o[2] && p.rh != null) rh.push(o[2] - p.rh);
    if (o[3] === o[3] && p.tair != null) t2.push(o[3] - p.tair);
    if (p.kind === 'buoy') per.push(`${p.name} ${e.toFixed(0)}`);
  }
  const av = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '–';
  if (n) rows.push([ve / n, `${m.id.padEnd(28)} cijeli vjetar ±${(ve / n).toFixed(1)} kn | snaga ±${(sa / n).toFixed(1)} (${se / n > 0 ? '+' : ''}${(se / n).toFixed(1)}) | smjer ±${nd ? Math.round(sd / nd) : '–'}° | vlaga ${av(rh)} % | temp ${av(t2)} °C | n=${n} | plutače: ${per.join(', ')}`]);
}
rows.sort((a, b) => a[0] - b[0]).forEach(r => console.log(r[1]));

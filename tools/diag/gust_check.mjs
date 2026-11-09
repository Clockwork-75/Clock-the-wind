// Diagnostic: gusts vs mean wind in the real cloud package. Gusts can never be weaker than the mean wind.
// Prints the user's point hour by hour and, for every model, how often (and where/when) gust < wind.
import { gunzipSync } from 'node:zlib';
import { importPackage } from '../../js/direct.js';
import { sample, fillTimeGaps } from '../../js/field.js';

const url = process.argv[2] || 'https://clockwork-75.github.io/Clock-the-wind/data/latest.ctw';
let buf = Buffer.from(await (await fetch(url + '?t=' + Date.now())).arrayBuffer());
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
const set = importPackage(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const H = 3600000, lat = 43 + 37.84 / 60, lon = 15 + 46.91 / 60;
const T = Date.UTC(2026, 10, 14, 3, 45);   // Sat 14.11. 04:45 Croatian time
const iso = t => new Date(t + H).toISOString().slice(5, 16).replace('T', ' ');   // local (CET)
for (const id of set.models) {
  const f = set.fields[id]; if (!f.vars.gust) { console.log(id, 'nema udara'); continue; }
  // raw: steps where the whole gust field is empty, before the gap filling
  const N = f.nx * f.ny, empty = [];
  for (let ti = 0; ti < f.times.length; ti++) { let ok = false; for (let i = 0; i < N; i += 7) if (f.vars.gust[ti * N + i] === f.vars.gust[ti * N + i]) { ok = true; break; } if (!ok) empty.push(iso(f.times[ti])); }
  fillTimeGaps(f);
  // gust < wind over the whole grid, per time step
  let bad = 0, tot = 0; const worst = [];
  for (let ti = 0; ti < f.times.length; ti++) for (let i = 0; i < N; i++) {
    const u = f.vars.u[ti * N + i], v = f.vars.v[ti * N + i], g = f.vars.gust[ti * N + i]; if (u !== u || g !== g) continue;
    const w = Math.hypot(u, v); tot++;
    if (g < w - 0.5) { bad++; if (worst.length < 6 || w - g > worst[worst.length - 1].d) { worst.push({ d: w - g, t: iso(f.times[ti]), w: w.toFixed(1), g: g.toFixed(1), lat: (f.lat0 + Math.floor(i / f.nx) * f.dlat).toFixed(2), lon: (f.lon0 + (i % f.nx) * f.dlon).toFixed(2) }); worst.sort((a, b) => b.d - a.d); worst.length = Math.min(worst.length, 6); } }
  }
  console.log(`\n== ${id}: korak ${(f.times[1] - f.times[0]) / H} h…, udari prazni u koracima: ${empty.slice(0, 8).join(', ') || 'nijedan'}${empty.length > 8 ? ' (+' + (empty.length - 8) + ')' : ''}`);
  console.log(`   udar < vjetar u ${(100 * bad / Math.max(1, tot)).toFixed(1)} % točaka·sati; najgore:`, worst.map(x => `${x.t} ${x.lat},${x.lon} vjetar ${x.w} udar ${x.g}`).join(' | '));
  const rows = [];
  for (let h = -6; h <= 6; h += 1) { const t = T + h * H, o = sample(f, ['u', 'v', 'gust'], lat, lon, t, []); rows.push(`${iso(t).slice(6)} v ${Math.hypot(o[0], o[1]).toFixed(1)} u ${o[2].toFixed(1)}`); }
  console.log('   točka 43°37.84 15°46.91:', rows.join(' · '));
  // the grid steps around the time
  const k = f.times.findIndex(t => t >= T);
  console.log('   koraci oko tog vremena:', f.times.slice(Math.max(0, k - 2), k + 2).map(iso).join(', '));
}

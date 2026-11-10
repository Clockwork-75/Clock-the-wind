// Diagnostic: DHMZ ALADIN-HR open data for sailors (GRIB) – directory listing, one file decoded.
// The DHMZ open-data login comes from the GitHub secrets ALADIN_USER / ALADIN_PASS (never stored in the repository).
import { decodeGrib } from '../../js/grib.js';
const BASE = 'https://radar.dhz.hr/~aladinhr/opendata/sailing/';
const auth = 'Basic ' + Buffer.from(`${process.env.ALADIN_USER || ''}:${process.env.ALADIN_PASS || ''}`).toString('base64');
const get = async u => { const r = await fetch(u, { headers: { Authorization: auth } }); console.log(r.status, u); return r; };
const list = async u => { const r = await get(u); const t = await r.text(); const names = [...t.matchAll(/href="([^"?/][^"]*)"/g)].map(m => m[1]); console.log(names.join('  ')); return names; };
const top = await list(BASE);
const files = top.filter(n => /grb|grib|bin/i.test(n));
for (const d of top.filter(n => n.endsWith('/')).slice(0, 6)) { const sub = await list(BASE + d); files.push(...sub.filter(n => /grb|grib|bin/i.test(n)).map(n => d + n)); }
console.log('GRIB datoteke:', files.join('  '));
const f = files.find(n => /adr/i.test(n)) || files[0];
if (f) {
  const r = await get(BASE + f); const buf = Buffer.from(await r.arrayBuffer());
  console.log('veličina', buf.length, 'početak', buf.slice(0, 8).toString('latin1'), 'GRIB izdanje', buf[7]);
  // raw parameter codes of every message (also those the app does not read yet)
  const b = new Uint8Array(buf), codes = {};
  for (let o = 0; o < b.length - 8;) {
    if (b[o] === 0x47 && b[o + 1] === 0x52 && b[o + 2] === 0x49 && b[o + 3] === 0x42) {
      const ed = b[o + 7];
      if (ed === 1) { const len = (b[o + 4] << 16) | (b[o + 5] << 8) | b[o + 6], p = o + 8; const k = `g1 p${b[p + 8]} lt${b[p + 9]} lv${(b[p + 10] << 8) | b[p + 11]}`; codes[k] = (codes[k] || 0) + 1; o += Math.max(len, 1); }
      else { const len = Number(new DataView(b.buffer, b.byteOffset + o + 8, 8).getBigUint64(0, false)); const disc = b[o + 6]; let p = o + 16; while (p < o + len - 4) { const sl = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3], sn = b[p + 4]; if (sn === 4) { const k = `g2 d${disc} c${b[p + 9]} n${b[p + 10]} sf${b[p + 22]} t${(b[p + 7] << 8) | b[p + 8]}`; codes[k] = (codes[k] || 0) + 1; } if (!sl) break; p += sl; } o += Math.max(len, 1); }
    } else o++;
  }
  console.log('parametri', JSON.stringify(codes));
  const msgs = decodeGrib(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { anyLevel: true });
  const names = {}; msgs.forEach(m => { names[m.name] = (names[m.name] || 0) + 1; });
  const g = msgs[0] && msgs[0].grid;
  console.log('poruke', msgs.length, JSON.stringify(names), 'preskočeno', (msgs.skipped || []).slice(0, 3).join(' | '));
  if (g) console.log('mreža', JSON.stringify({ ni: g.ni, nj: g.nj, la1: g.la1, lo1: g.lo1, la2: g.la2, lo2: g.lo2, di: g.di, dj: g.dj, scan: g.scan }));
  const times = [...new Set(msgs.map(m => m.valid))].sort((a, b) => a - b);
  if (times.length) console.log('vremena', times.length, new Date(times[0]).toISOString(), '→', new Date(times[times.length - 1]).toISOString());
}

// Diagnostic: DHMZ real-time measurements (buoys + coastal stations) – what is published, in which format, how fresh.
// Saves the raw pages to shots/obs/ for inspection.
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('shots/obs', { recursive: true });
const U = [
  ['plutace.html', 'https://meteo.hr/podaci.php?section=podaci_vrijeme&param=mop'],
  ['more_n.html', 'https://meteo.hr/podaci.php?section=podaci_vrijeme&param=more_n'],
  ['hrvatska_n.html', 'https://meteo.hr/podaci.php?section=podaci_vrijeme&param=hrvatska1_n'],
  ['hrvatska_n.xml', 'https://vrijeme.hr/hrvatska_n.xml'],
  ['hrvatska1_n.xml', 'https://vrijeme.hr/hrvatska1_n.xml'],
  ['more_n.xml', 'https://vrijeme.hr/more_n.xml'],
  ['jadran_n.xml', 'https://vrijeme.hr/jadran_n.xml'],
  ['plutace.xml', 'https://vrijeme.hr/plutace.xml'],
  ['mop.xml', 'https://vrijeme.hr/mop.xml'],
  ['amp.html', 'https://meteo.hr/podaci.php?section=podaci_vrijeme&param=amp'],
  ...['Blitvenica', 'Kvarner', 'Molunat', 'Palagruza', 'Viski_kanal'].map(n => [`plutaca-${n}.png`, `https://vrijeme.hr/plutace/plutaca-${n}.png`]),
];
for (const [name, url] of U) {
  try {
    const c = new AbortController(); const tm = setTimeout(() => c.abort(), 30000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ClockTheWind)' }, signal: c.signal }); clearTimeout(tm);
    if (name.endsWith('.png')) { const b = Buffer.from(await r.arrayBuffer()); writeFileSync('shots/obs/' + name, b); console.log(r.status, name, b.length, 'B', r.headers.get('last-modified')); continue; }
    const t = await r.text();
    writeFileSync('shots/obs/' + name, t);
    console.log(r.status, name, t.length, 'B', r.headers.get('content-type'), '|', t.replace(/\s+/g, ' ').slice(0, 160));
  } catch (e) { console.log('ERR', name, e.message); }
}

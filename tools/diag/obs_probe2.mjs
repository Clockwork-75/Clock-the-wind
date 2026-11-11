// Diagnostic: inventory of every real-time measurement source on the Adriatic – what answers, how fresh, what format.
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('shots/p2', { recursive: true });
const UA = { 'User-Agent': 'Mozilla/5.0 (ClockTheWind sailing app)' };
const get = async (u, t = 30000) => { const c = new AbortController(); const tm = setTimeout(() => c.abort(), t); try { const r = await fetch(u, { headers: UA, signal: c.signal }); const b = Buffer.from(await r.arrayBuffer()); return { s: r.status, b, lm: r.headers.get('last-modified'), ct: r.headers.get('content-type') }; } catch (e) { return { s: 'ERR ' + e.message }; } finally { clearTimeout(tm); } };
// 1) DHMZ automatic stations (10-min graphs) – the list on meteo.hr plus codes known from DHMZ's station list
const AMP = ['bakarac','bukovo','crikveni','mostciov','deltaner','dubrovni','mostdub1','mostdub2','gruda','hreljin','hvar','jasenice','kamenjak','komarna','mostkrk','mostkrk2','lastovo','makarska','malinska','mlosinj','montekop','opatija1','ploce','porer','povile','prevlaka','prizna','rab','ravnikot','rijeka','senj','split','svivanpu','sibenik','visnjan','zadar','zavizan','gospic','ogulin','knin','pazin','lokvine','srednjao','golivrh',
  'palagruz','velirat','svjure','prijeboj','vstraza','hum','zarkovic','zarkovica','komiza','vis','korcula','pula','krk','cres','silba','zirje','biokovo','sucuraj','stari','bol'];
const rows = [];
for (const c of AMP) { const r = await get(`https://vrijeme.hr/amp/${c}.png`); if (r.s === 200 && r.b.length > 2000) { writeFileSync(`shots/p2/amp-${c}.png`, r.b); rows.push(`${c} OK ${r.b.length} B lm ${r.lm}`); } else rows.push(`${c} ${r.s}`); }
console.log('AMP:\n' + rows.join('\n'));
// 2) EMODnet Physics ERDDAP – datasets with IZOR / Croatian / Adriatic platforms
for (const q of ['IZOR', 'Adriatic', 'Croatia', 'Piran', 'VIDA', 'Venezia', 'Trieste']) {
  const r = await get(`https://er1webapps.emodnet-physics.eu/erddap/search/index.csv?page=1&itemsPerPage=60&searchFor=${encodeURIComponent(q)}`, 40000);
  const t = r.b ? r.b.toString() : ''; writeFileSync(`shots/p2/erddap-${q}.csv`, t);
  console.log(`ERDDAP ${q}: ${r.s} ${t.split('\n').length} lines | ` + t.split('\n').slice(1, 12).map(l => l.split(',').slice(-2).join('|').slice(0, 90)).join(' || '));
}
// 3) METAR (aviationweather.gov)
{ const r = await get('https://aviationweather.gov/api/data/metar?ids=LDRI,LDZD,LDSP,LDDU,LDPL,LDLO,LDSB,LDRG,LJPZ&format=json&hours=3'); const t = r.b ? r.b.toString() : ''; writeFileSync('shots/p2/metar.json', t); try { const j = JSON.parse(t); console.log('METAR', j.length, j.slice(0, 12).map(m => `${m.icaoId} ${m.reportTime} ${m.wdir}/${m.wspd}${m.wgst ? 'G' + m.wgst : ''}`).join(' | ')); } catch { console.log('METAR', r.s, t.slice(0, 200)); } }
// 4) ARSO observations
for (const st of ['KOPER_KAPET-IJA', 'PORTOROZ_SECOVLJE', 'PIRAN_BOJA']) for (const kind of ['observationAms', 'observation']) {
  const u = `https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/${kind}_${st}_latest.xml`; const r = await get(u); const t = r.b ? r.b.toString() : '';
  console.log('ARSO', kind, st, r.s, t.length, t.replace(/\s+/g, ' ').slice(0, 260));
  if (r.s === 200) writeFileSync(`shots/p2/arso-${kind}-${st}.xml`, t);
}
{ const r = await get('https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/recent/observationAms_si_latest.xml'); const t = r.b ? r.b.toString() : ''; console.log('ARSO si_latest', r.s, t.length, (t.match(/<domain_title>[^<]*/g) || []).slice(0, 40).join(' ')); if (r.s === 200) writeFileSync('shots/p2/arso-si_latest.xml', t); }
// 5) IZOR home page: links to meteo / json
{ const r = await get('https://www.izor.hr/'); const t = r.b ? r.b.toString() : ''; console.log('IZOR home', r.s, (t.match(/href="[^"]*(meteo|json|postaj|mjeren|vrijeme)[^"]*"/gi) || []).slice(0, 30).join(' ')); }
for (const u of ['https://www.izor.hr/meteo/', 'https://meteo.izor.hr/', 'https://www.izor.hr/web/guest/meteo', 'http://jadran.izor.hr/', 'https://vrijeme.izor.hr/']) { const r = await get(u, 15000); console.log('IZOR try', u, r.s, r.b ? r.b.length : 0, r.b ? r.b.toString().replace(/\s+/g, ' ').slice(0, 160) : ''); }

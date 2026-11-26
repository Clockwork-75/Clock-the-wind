// Diagnostic: which rain / thunderstorm data the cloud package could take, and live radar / lightning sources.
const UA = { 'User-Agent': 'ClockTheWind-cloud/1.0 (sailing routing; github actions)' };
const get = async (u, opt = {}) => { try { const r = await fetch(u, { headers: { ...UA, ...(opt.headers || {}) }, method: opt.method || 'GET' }); const t = opt.method === 'HEAD' ? '' : await r.text(); return { s: r.status, t }; } catch (e) { return { s: 'ERR ' + e.message, t: '' }; } };
const H = 3600000, pad = (n, l) => String(n).padStart(l, '0');
const ymd = t => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`; }, hh = t => pad(new Date(t).getUTCHours(), 2);
// DWD: variable directories of the latest run
for (const [k, base] of [['ICON-EU', 'https://opendata.dwd.de/weather/nwp/icon-eu/grib/'], ['ICON-D2', 'https://opendata.dwd.de/weather/nwp/icon-d2/grib/']]) {
  const run = Math.floor((Date.now() - 4 * H) / (6 * H)) * 6 * H;
  const r = await get(base + hh(run) + '/');
  const names = [...r.t.matchAll(/href="([^"/]+)\//g)].map(m => m[1]);
  console.log(k, r.s, 'varijable:', names.filter(n => /prec|rain|cape|lpi|light|dbz|snow|cin|tch|ww/i.test(n)).join(' '));
  for (const v of ['tot_prec', 'cape_ml', 'lpi', 'lpi_max', 'ww', 'dbz_cmax']) {
    const d = await get(base + hh(run) + '/' + v + '/'); const f = [...d.t.matchAll(/href="([^"]+bz2)"/g)].map(m => m[1]);
    if (d.s === 200) console.log('  ', v, f.length, 'datoteka, npr.', f[0], f[f.length - 1]);
  }
}
// ECMWF open data: every parameter of one step
{ const run = Math.floor((Date.now() - 9 * H) / (12 * H)) * 12 * H;
  const r = await get(`https://data.ecmwf.int/forecasts/${ymd(run)}/${hh(run)}z/ifs/0p25/oper/${ymd(run)}${hh(run)}0000-24h-oper-fc.index`);
  const p = [...new Set(r.t.trim().split('\n').filter(Boolean).map(l => { try { const j = JSON.parse(l); return j.param + (j.levtype === 'sfc' ? '' : '@' + j.levtype); } catch { return '?'; } }))];
  console.log('ECMWF', r.s, 'sfc parametri:', p.filter(x => !x.includes('@')).join(' ')); }
// GFS: does the filter know PRATE / APCP / CAPE
{ const run = Math.floor((Date.now() - 5 * H) / (6 * H)) * 6 * H;
  const u = `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.${ymd(run)}%2F${hh(run)}%2Fatmos&file=gfs.t${hh(run)}z.pgrb2.0p25.f024&var_PRATE=on&var_APCP=on&var_CAPE=on&lev_surface=on&subregion=&toplat=46&leftlon=12&rightlon=20&bottomlat=41`;
  const r = await get(u); console.log('GFS PRATE/APCP/CAPE', r.s, r.t.length, 'B', r.t.slice(0, 4)); }
// ARPEGE / ALADIN: listed elsewhere (aladin_probe) – here: ARPEGE packages of a run
{ const r = await get('https://www.data.gouv.fr/api/1/datasets/paquets-arpege-resolution-0-1/'); console.log('ARPEGE dataset', r.s, (r.t.match(/SP[0-9]|HP[0-9]|IP[0-9]/g) || []).filter((x, i, a) => a.indexOf(x) === i).join(' ')); }
// live radar: RainViewer public API
{ const r = await get('https://api.rainviewer.com/public/weather-maps.json'); console.log('RainViewer', r.s, r.t.slice(0, 400)); }
// live lightning: EUMETSAT EUMETView WMS (MTG Lightning Imager)
{ const r = await get('https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetCapabilities&version=1.3.0');
  const L = [...r.t.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]).filter(n => /li_|lightning|LI/i.test(n));
  console.log('EUMETView', r.s, r.t.length, 'B; munje slojevi:', L.slice(0, 30).join(' '));
  for (const n of L.slice(0, 4)) { const i = r.t.indexOf('<Name>' + n + '</Name>'); console.log('  ', n, r.t.slice(i, i + 900).replace(/\s+/g, ' ').match(/<Title>[^<]*<\/Title>|<Dimension[^>]*>[^<]{0,120}/g)); } }
// DHMZ radar composite
{ for (const u of ['https://vrijeme.hr/radari/kompozit.gif', 'https://vrijeme.hr/kompozit-stat.png', 'https://meteo.hr/podaci.php?section=podaci_radari']) { const r = await get(u, { method: 'HEAD' }); console.log('DHMZ', u, r.s); } }

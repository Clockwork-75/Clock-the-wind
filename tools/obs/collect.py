"""Clock the Wind – live measurements on the Adriatic, every 30 minutes (GitHub Actions → branch `obs`).

 · 5 DHMZ meteo-oceanographic buoys (Kvarner, Blitvenica, Viški kanal, Palagruža, Molunat): read back from the
   graphs DHMZ publishes (buoy_read.py) – wind and gusts every 10 min, waves, pressure, air/sea temperature, humidity
 · DHMZ coastal stations, lighthouses and islands (hourly XML): wind, pressure + 3 h tendency, temperature, humidity
 · signals that often announce the wind before the models do: pressure falls/rises, the bura and jugo pressure
   gradients, sudden temperature drops, humidity rises, a wind spreading along the coast

Output: obs.json (now + last 72 h, for the app) and history.json (7 days, for scoring the models).
"""
import sys, os, json, math, time, urllib.request, email.utils, datetime as dt, xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(__file__))
import buoy_read as BR

ZG = ZoneInfo('Europe/Zagreb')
KN = 1.943844
H = 3600
OUT = sys.argv[1] if len(sys.argv) > 1 else 'obsdata'
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (ClockTheWind sailing app; github actions)'}

BUOYS = [  # id, name, lat, lon (from the graph titles)
    ('Kvarner', 'Kvarner', 44 + 41 / 60, 14 + 9 / 60),
    ('Blitvenica', 'Blitvenica', 43 + 36 / 60, 15 + 34 / 60),
    ('Viski_kanal', 'Viški kanal', 43 + 8 / 60, 16 + 7 / 60),
    ('Palagruza', 'Palagruža', 42 + 29 / 60, 16 + 24 / 60),
    ('Molunat', 'Molunat', 42 + 24 / 60, 18 + 22 / 60),
]
# coastal / island / lighthouse stations of the hourly DHMZ XML (inland ones are only used for the bura gradient)
COAST = ['Sv. Ivan na pučini - svjetionik', 'Porer - svjetionik', 'Rovinj', 'Pula-aerodrom', 'Opatija', 'Rijeka', 'Rijeka-aerodrom',
         'Crikvenica', 'Malinska', 'Senj', 'Rab', 'Mali Lošinj', 'Mali Lošinj - Ćunski', 'Monte Kope', 'Zadar', 'Zadar-aerodrom',
         'Šibenik', 'Split-Marjan', 'Split-aerodrom', 'Hvar', 'Komiža', 'Makarska', 'Živogošće', 'Ploče', 'Lastovo',
         'Dubrovnik', 'Dubrovnik-aerodrom', 'Prevlaka']
INLAND = ['Gospić', 'Ogulin', 'Karlovac', 'Knin', 'Zavižan', 'Plaški', 'Bosiljevo']
COMPASS = {'N': 0, 'NNE': 22.5, 'NE': 45, 'ENE': 67.5, 'E': 90, 'ESE': 112.5, 'SE': 135, 'SSE': 157.5, 'S': 180, 'SSW': 202.5,
           'SW': 225, 'WSW': 247.5, 'W': 270, 'WNW': 292.5, 'NW': 315, 'NNW': 337.5}

# ---------------- the fixed list of places ("always ask everyone") ----------------
# Every run asks every source below. A place that does not answer stays on the map, grey, with "ne javlja se od …",
# and comes back by itself when its source answers again. One place can have several sources (DHMZ 10-min graph,
# hourly DHMZ XML, METAR, ARSO): they are merged – the freshest wind wins, the rest fills in what it lacks.
# feeds: ('buoy', id) DHMZ buoy graph · ('amp', code) DHMZ automatic station graph · ('xml', name) hourly DHMZ XML ·
#        ('metar', ICAO) airport · ('arso', id) Slovenian coastal station
# coordinates of amp-only places are approximate (from the station's location); XML places use DHMZ's own
REGISTRY = [
    # id, name, kind, lat, lon, feeds
    *[('b:' + b, n, 'buoy', round(la, 4), round(lo, 4), [('buoy', b)]) for b, n, la, lo in BUOYS],
    ('r:koper', 'Koper', 'station', 45.548, 13.725, [('arso', 'koper')]),
    ('r:portoroz', 'Portorož-aerodrom', 'station', 45.474, 13.616, [('arso', 'portoroz'), ('metar', 'LJPZ')]),
    ('s:Sv. Ivan na pučini - svjetionik', 'Sv. Ivan na pučini - svjetionik', 'lighthouse', 45.043, 13.614, [('amp', 'svivanpu'), ('xml', 'Sv. Ivan na pučini - svjetionik')]),
    ('s:Rovinj', 'Rovinj', 'station', 45.081, 13.640, [('xml', 'Rovinj')]),
    ('s:Pula-aerodrom', 'Pula-aerodrom', 'station', 44.896, 13.932, [('xml', 'Pula-aerodrom'), ('metar', 'LDPL')]),
    ('s:Monte Kope', 'Monte Kope', 'station', 44.812, 13.873, [('amp', 'montekop'), ('xml', 'Monte Kope')]),
    ('a:kamenjak', 'Kamenjak', 'station', 44.770, 13.910, [('amp', 'kamenjak')]),
    ('s:Porer - svjetionik', 'Porer - svjetionik', 'lighthouse', 44.758, 13.890, [('amp', 'porer'), ('xml', 'Porer - svjetionik')]),
    ('s:Opatija', 'Opatija', 'station', 45.337, 14.307, [('amp', 'opatija1'), ('xml', 'Opatija')]),
    ('s:Rijeka', 'Rijeka', 'station', 45.337, 14.443, [('amp', 'rijeka'), ('xml', 'Rijeka')]),
    ('a:bakarac', 'Bakarac', 'station', 45.283, 14.611, [('amp', 'bakarac')]),
    ('a:hreljin', 'Hreljin vijadukt', 'station', 45.290, 14.585, [('amp', 'hreljin')]),
    ('a:mostkrk', 'Most Krk', 'station', 45.252, 14.567, [('amp', 'mostkrk'), ('amp', 'mostkrk2')]),
    ('s:Rijeka-aerodrom', 'Rijeka-aerodrom', 'station', 45.224, 14.582, [('xml', 'Rijeka-aerodrom'), ('metar', 'LDRI')]),
    ('s:Crikvenica', 'Crikvenica', 'station', 45.173, 14.689, [('amp', 'crikveni'), ('xml', 'Crikvenica')]),
    ('s:Malinska', 'Malinska', 'station', 45.126, 14.527, [('amp', 'malinska'), ('xml', 'Malinska')]),
    ('a:povile', 'Povile', 'station', 45.112, 14.818, [('amp', 'povile')]),
    ('s:Senj', 'Senj', 'station', 44.993, 14.903, [('amp', 'senj'), ('xml', 'Senj')]),
    ('a:zavizan', 'Zavižan (Velebit)', 'station', 44.815, 14.976, [('amp', 'zavizan'), ('xml', 'Zavižan')]),
    ('s:Rab', 'Rab', 'station', 44.756, 14.769, [('amp', 'rab'), ('xml', 'Rab')]),
    ('a:prizna', 'Prizna', 'station', 44.618, 14.973, [('amp', 'prizna')]),
    ('s:Mali Lošinj', 'Mali Lošinj', 'station', 44.533, 14.472, [('amp', 'mlosinj'), ('xml', 'Mali Lošinj')]),
    ('s:Mali Lošinj - Ćunski', 'Mali Lošinj - Ćunski', 'station', 44.565, 14.437, [('xml', 'Mali Lošinj - Ćunski'), ('metar', 'LDLO')]),
    ('a:velirat', 'Veli Rat - svjetionik', 'lighthouse', 44.152, 14.823, [('amp', 'velirat')]),
    ('a:jasenice', 'Jasenice (Maslenica)', 'station', 44.225, 15.530, [('amp', 'jasenice')]),
    ('s:Zadar', 'Zadar', 'station', 44.130, 15.206, [('amp', 'zadar'), ('xml', 'Zadar')]),
    ('s:Zadar-aerodrom', 'Zadar-aerodrom', 'station', 44.097, 15.363, [('xml', 'Zadar-aerodrom'), ('metar', 'LDZD')]),
    ('s:Šibenik', 'Šibenik', 'station', 43.728, 15.906, [('amp', 'sibenik'), ('xml', 'Šibenik')]),
    ('a:mostciov', 'Most Čiovo', 'station', 43.516, 16.252, [('amp', 'mostciov')]),
    ('s:Split-aerodrom', 'Split-aerodrom', 'station', 43.539, 16.301, [('xml', 'Split-aerodrom'), ('metar', 'LDSP')]),
    ('s:Split-Marjan', 'Split-Marjan', 'station', 43.508, 16.426, [('amp', 'split'), ('xml', 'Split-Marjan')]),
    ('m:LDSB', 'Brač-aerodrom', 'station', 43.286, 16.680, [('metar', 'LDSB')]),
    ('s:Hvar', 'Hvar', 'station', 43.171, 16.437, [('amp', 'hvar'), ('xml', 'Hvar')]),
    ('s:Komiža', 'Komiža', 'station', 43.048, 16.085, [('xml', 'Komiža')]),
    ('s:Makarska', 'Makarska', 'station', 43.288, 17.020, [('amp', 'makarska'), ('xml', 'Makarska')]),
    ('a:svjure', 'Sv. Jure (Biokovo)', 'station', 43.343, 17.054, [('amp', 'svjure')]),
    ('s:Živogošće', 'Živogošće', 'station', 43.170, 17.179, [('xml', 'Živogošće')]),
    ('s:Ploče', 'Ploče', 'station', 43.048, 17.443, [('amp', 'ploce'), ('xml', 'Ploče')]),
    ('a:deltaner', 'Delta Neretve', 'station', 43.030, 17.470, [('amp', 'deltaner')]),
    ('a:komarna', 'Komarna', 'station', 42.928, 17.535, [('amp', 'komarna')]),
    ('a:palagruz', 'Palagruža - svjetionik', 'lighthouse', 42.393, 16.255, [('amp', 'palagruz')]),
    ('s:Lastovo', 'Lastovo', 'station', 42.768, 16.900, [('amp', 'lastovo'), ('xml', 'Lastovo')]),
    ('a:mostdub', 'Most Dubrovnik', 'station', 42.664, 18.070, [('amp', 'mostdub1'), ('amp', 'mostdub2')]),
    ('s:Dubrovnik', 'Dubrovnik', 'station', 42.645, 18.085, [('amp', 'dubrovni'), ('xml', 'Dubrovnik')]),
    ('s:Dubrovnik-aerodrom', 'Dubrovnik-aerodrom', 'station', 42.563, 18.270, [('xml', 'Dubrovnik-aerodrom'), ('metar', 'LDDU')]),
    ('a:gruda', 'Gruda (Konavle)', 'station', 42.517, 18.376, [('amp', 'gruda')]),
    ('s:Prevlaka', 'Prevlaka', 'station', 42.393, 18.531, [('amp', 'prevlaka'), ('xml', 'Prevlaka')]),
]
AMP_CODES = sorted({k for r in REGISTRY for s, k in r[5] if s == 'amp'})
METARS = sorted({k for r in REGISTRY for s, k in r[5] if s == 'metar'})
ARSO = {'koper': 'observationAms_KOPER_KAPET-IJA', 'portoroz': 'observationAms_PORTOROZ_SECOVLJE'}
# how often each source measures and after how long without news a place turns grey
STEP = {'buoy': 600, 'amp': 600, 'xml': 3600, 'metar': 1800, 'arso': 1800}
LIVE = {'buoy': 3 * H, 'amp': 2 * H, 'xml': 3 * H, 'metar': 2 * H, 'arso': 2 * H}
STORE = {'buoy': 'buoys', 'amp': 'amp', 'xml': 'stations', 'metar': 'metar', 'arso': 'arso'}

LOCAL = os.environ.get('CTW_OBS_LOCAL')    # tests only: answer from saved files instead of the network
def get(url, timeout=40):
    if LOCAL:
        f = os.path.join(LOCAL, url.split('?')[0].rstrip('/').rsplit('/', 1)[-1])
        if not os.path.exists(f): raise IOError('lokalno nema ' + f)
        return open(f, 'rb').read(), os.path.getmtime(f)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        lm = r.headers.get('Last-Modified')
        return r.read(), (email.utils.parsedate_to_datetime(lm).timestamp() if lm else None)

def num(s):
    try: return float(str(s).replace('*', 'X').strip())
    except (TypeError, ValueError): return None

def load(name, default):
    try:
        with open(os.path.join(OUT, name)) as f: return json.load(f)
    except Exception: return default

now = time.time()
hist = load('history.json', {'buoys': {}, 'stations': {}})
errors = []

# ---------------- buoys ----------------
def buoy_series(png_path, lm):
    r = BR.read(png_path)
    top, bot, left, right = r['frames']['wind']
    ncol = right - left - 1
    # last column with wind = the newest measurement; the time axis spans 3 local days from 00:00
    xs = [i for i, v in enumerate(r['series'].get('wspd', [])) if v is not None]
    if not xs: raise ValueError('nema vjetra na grafu')
    xlast = xs[-1]
    ref = lm or now
    best = None
    for back in (2, 3, 1):
        d0 = dt.datetime.fromtimestamp(ref, ZG).replace(hour=0, minute=0, second=0, microsecond=0) - dt.timedelta(days=back)
        t0 = d0.timestamp()
        span = (d0 + dt.timedelta(days=3)).timestamp() - t0      # 72 h (or 71/73 h across a clock change)
        tl = t0 + (xlast + 1.5) / (ncol + 1) * span
        if tl <= ref + 900 and (best is None or tl > best[2]): best = (t0, span, tl)
    if not best: raise ValueError('vremenska os nije prepoznata')
    t0, span, _ = best
    out = {}
    for x in range(ncol):
        t = t0 + (x + 1.5) / (ncol + 1) * span
        slot = int(round(t / 600) * 600)                         # 10-minute steps
        rec = out.setdefault(slot, {})
        for k, arr in r['series'].items():
            if x < len(arr) and arr[x] is not None: rec.setdefault(k, []).append(arr[x])
    clean = {}
    for slot, rec in out.items():
        v = {}
        for k, vals in rec.items():
            if k in ('wdir', 'vdir'):   # circular mean
                s = sum(math.sin(math.radians(a)) for a in vals); c = sum(math.cos(math.radians(a)) for a in vals)
                v[k] = round((math.degrees(math.atan2(s, c)) + 360) % 360)
            else: v[k] = sum(vals) / len(vals)
        if 'wspd' in v: v['wspd'] = round(v['wspd'] * KN, 1)
        if 'wgust' in v: v['wgust'] = round(v['wgust'] * KN, 1)
        for k in ('hs', 'hmax'):
            if k in v: v[k] = round(v[k], 2)
        for k in ('tp', 'tair', 'sst', 'pres', 'rh'):
            if k in v: v[k] = round(v[k], 2 if k == 'sst' else 1)
        # plausibility: a wrong value is dropped, never shown
        rules = {'wspd': (0, 90), 'wgust': (0, 120), 'hs': (0, 12), 'hmax': (0, 20), 'tp': (1, 20), 'tair': (-20, 45),
                 'sst': (2, 35), 'pres': (950, 1060), 'rh': (0, 101)}
        for k, (lo, hi) in rules.items():
            if k in v and not (lo <= v[k] <= hi): del v[k]
        if 'wgust' in v and 'wspd' in v and v['wgust'] < v['wspd'] - 1: del v['wgust']
        clean[str(slot)] = v
    return clean, best[2]

for bid, name, lat, lon in BUOYS:
    try:
        raw, lm = get(f'https://vrijeme.hr/plutace/plutaca-{bid}.png')
        p = os.path.join('/tmp', f'buoy-{bid}.png'); open(p, 'wb').write(raw)
        series, tlast = buoy_series(p, lm)
        h = hist['buoys'].setdefault(bid, {})
        h.update(series)
        print(f'{name}: {len(series)} mjerenja, zadnje {dt.datetime.fromtimestamp(tlast, ZG):%d.%m. %H:%M}')
    except SystemExit as e: errors.append(f'{name}: {e}'); print('!!', name, e)
    except Exception as e: errors.append(f'{name}: {e}'); print('!!', name, e)

# ---------------- coastal stations (hourly XML) ----------------
try:
    raw, _ = get('https://vrijeme.hr/hrvatska_n.xml')
    root = ET.fromstring(raw)
    d, hh = root.findtext('DatumTermin/Datum'), int(root.findtext('DatumTermin/Termin'))
    day = dt.datetime.strptime(d.strip(), '%d.%m.%Y').replace(tzinfo=ZG)
    t = int((day + dt.timedelta(hours=hh)).timestamp())
    n = 0
    for g in root.findall('Grad'):
        nm = (g.findtext('GradIme') or '').strip()
        if nm not in COAST and nm not in INLAND: continue
        P = g.find('Podatci')
        if P is None: continue
        rec = {'lat': num(g.findtext('Lat')), 'lon': num(g.findtext('Lon'))}
        sp = num(P.findtext('VjetarBrzina')); dr = (P.findtext('VjetarSmjer') or '').strip()
        if sp is not None: rec['wspd'] = round(sp * KN, 1)
        if dr in COMPASS: rec['wdir'] = COMPASS[dr]
        elif dr == 'C': rec['wdir'] = None; rec['wspd'] = 0
        pr = (P.findtext('Tlak') or '').strip()
        if pr and '*' not in pr and num(pr): rec['pres'] = num(pr)
        tt = num(P.findtext('TlakTend'))
        if tt is not None: rec['ptend'] = tt
        for k, tag in (('tair', 'Temp'), ('rh', 'Vlaga')):
            v = num(P.findtext(tag))
            if v is not None and not (k == 'rh' and v <= 0): rec[k] = v
        hist['stations'].setdefault(nm, {})[str(t)] = rec; n += 1
    print(f'Stanice: {n}, termin {d} {hh} h')
except Exception as e: errors.append(f'stanice: {e}'); print('!! stanice', e)

# ---------------- DHMZ automatic stations (10-min graphs vrijeme.hr/amp/<code>.png: wind + gusts, T, RH, station pressure) ----------------
def amp_series(png_path, lm):
    r = BR.read_amp(png_path)
    top, bot, left, right = r['frames']['wind']
    n = max(len(v) for v in r['series'].values()) if r['series'] else 0
    if not n: raise ValueError('prazan graf')
    xs = [i for i in range(n) if any(i < len(v) and v[i] is not None for v in r['series'].values())]
    if not xs: raise ValueError('prazan graf')
    ref = lm or now
    best = None
    for back in (1, 2):   # the graph shows yesterday and today (local), 00:00 at the left spine, 00:00 at the right one
        d0 = dt.datetime.fromtimestamp(ref, ZG).replace(hour=0, minute=0, second=0, microsecond=0) - dt.timedelta(days=back)
        t0 = d0.timestamp(); span = (d0 + dt.timedelta(days=2)).timestamp() - t0
        tl = t0 + (xs[-1] + 1) / (right - left) * span
        if tl <= ref + 900: best = (t0, span, tl); break
    if not best: raise ValueError('vremenska os nije prepoznata')
    t0, span, tlast = best
    slots = {}
    for i in xs:
        t = t0 + (i + 1) / (right - left) * span
        rec = slots.setdefault(int(round(t / 600) * 600), {})
        for k, arr in r['series'].items():
            if i < len(arr) and arr[i] is not None: rec.setdefault(k, []).append(float(arr[i]))
    clean = {}
    for slot, rec in slots.items():
        v = {}
        for k, vals in rec.items():
            if k == 'wdir':
                s = sum(math.sin(math.radians(a)) for a in vals); c = sum(math.cos(math.radians(a)) for a in vals)
                v[k] = round((math.degrees(math.atan2(s, c)) + 360) % 360)
            else: v[k] = sum(vals) / len(vals)
        if 'wspd' in v: v['wspd'] = round(max(0, v['wspd']) * KN, 1)
        if 'wgust' in v: v['wgust'] = round(max(0, v['wgust']) * KN, 1)
        if 'pres' in v: v['pst'] = round(v.pop('pres'), 1)      # pressure AT the station (not reduced to sea level)
        for k in ('tair', 'rh'):
            if k in v: v[k] = round(v[k], 1)
        for k, (lo, hi) in {'wspd': (0, 120), 'wgust': (0, 160), 'tair': (-30, 45), 'pst': (750, 1060), 'rh': (0, 101)}.items():
            if k in v and not (lo <= v[k] <= hi): del v[k]
        if 'wgust' in v and 'wspd' in v and v['wgust'] < v['wspd'] - 1: del v['wgust']
        if 'wdir' in v and 'wspd' not in v and 'wgust' not in v: del v['wdir']
        if v: clean[str(slot)] = v
    return clean, tlast

hist.setdefault('amp', {})
for code in AMP_CODES:
    try:
        raw, lm = get(f'https://vrijeme.hr/amp/{code}.png')
        p = os.path.join('/tmp', f'amp-{code}.png'); open(p, 'wb').write(raw)
        series, tlast = amp_series(p, lm)
        hist['amp'].setdefault(code, {}).update(series)
        print(f'amp {code}: {len(series)} mjerenja, zadnje {dt.datetime.fromtimestamp(tlast, ZG):%d.%m. %H:%M}')
    except SystemExit as e: errors.append(f'amp {code}: {e}'); print('!! amp', code, e)
    except Exception as e: errors.append(f'amp {code}: {e}'); print('!! amp', code, e)

def magnus_rh(t, td):
    if t is None or td is None: return None
    a, b = 17.625, 243.04
    return round(100 * math.exp(a * td / (b + td) - a * t / (b + t)))

# ---------------- METAR (airports, every 30 min: wind, gusts, QNH, T/Td) ----------------
hist.setdefault('metar', {})
try:
    raw, _ = get('https://aviationweather.gov/api/data/metar?ids=' + ','.join(METARS) + '&format=json&hours=6')
    n = 0
    for m in json.loads(raw):
        icao, t = m.get('icaoId'), m.get('obsTime')
        if icao not in METARS or not t: continue
        rec = {}
        if m.get('wspd') is not None: rec['wspd'] = round(float(m['wspd']), 1)
        if isinstance(m.get('wdir'), (int, float)): rec['wdir'] = int(m['wdir'])
        if m.get('wgst'): rec['wgust'] = round(float(m['wgst']), 1)
        if m.get('altim'): rec['pres'] = round(float(m['altim']), 1)
        if m.get('temp') is not None: rec['tair'] = float(m['temp'])
        rh = magnus_rh(m.get('temp'), m.get('dewp'))
        if rh is not None: rec['rh'] = rh
        hist['metar'].setdefault(icao, {})[str(int(t))] = rec; n += 1
    print(f'METAR: {n} izvješća')
except Exception as e: errors.append(f'METAR: {e}'); print('!! METAR', e)

# ---------------- ARSO (Slovenian coast, every 30 min) ----------------
hist.setdefault('arso', {})
for aid, fname in ARSO.items():
    try:
        raw, _ = get(f'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/{fname}_latest.xml')
        md = ET.fromstring(raw).find('metData')
        tx = md.findtext('tsValid_issued_RFC822')
        t = int(email.utils.parsedate_to_datetime(tx).timestamp())
        rec = {}
        sp, gu, dr = num(md.findtext('ffavg_val')), num(md.findtext('ffmax_val')), num(md.findtext('ddavg_val'))
        if sp is not None: rec['wspd'] = round(sp * KN, 1)
        if gu is not None: rec['wgust'] = round(gu * KN, 1)
        if dr is not None: rec['wdir'] = int(dr)
        for k, tag in (('pres', 'msl'), ('tair', 't'), ('rh', 'rh')):
            v = num(md.findtext(tag))
            if v is not None: rec[k] = v
        hist['arso'].setdefault(aid, {})[str(t)] = rec
        print(f'ARSO {aid}: {dt.datetime.fromtimestamp(t, ZG):%d.%m. %H:%M}', rec)
    except Exception as e: errors.append(f'ARSO {aid}: {e}'); print('!! ARSO', aid, e)

# keep 7 days
cut = now - 7 * 24 * H
for grp in ('buoys', 'stations', 'amp', 'metar', 'arso'):
    for k in list(hist.get(grp, {})):
        # 10-minute values: all of the last 24 h, older ones every 30 min (enough for scoring and the 72 h graphs)
        hist[grp][k] = {t: v for t, v in hist[grp][k].items() if int(t) >= cut and (grp != 'amp' or int(t) >= now - 24 * H or int(t) % 1800 == 0)}

# ---------------- now + signals ----------------
def last(series, maxage=3 * H):
    ts = sorted((int(t) for t in series), reverse=True)
    for t in ts:
        if now - t <= maxage and series[str(t)].get('wspd') is not None: return t, series[str(t)]
    return None, None

def at(series, t, tol=1800, key=None):
    best = None
    for s, v in series.items():
        s = int(s)
        if abs(s - t) <= tol and (key is None or v.get(key) is not None) and (best is None or abs(s - t) < abs(best[0] - t)): best = (s, v)
    return best[1] if best else None

def latest_each(series, t, back=90 * 60):
    """newest value of every quantity within the last 90 min before t (waves come every 30 min, wind every 10)"""
    v = {}
    for s in sorted((int(x) for x in series), reverse=True):
        if s > t or t - s > back: continue
        for k, x in series[str(s)].items():
            if x is not None and k not in v: v[k] = x
    return v

def feed_series(src, key):
    return hist.get(STORE[src], {}).get(key, {})

def newest(s, need=None):
    for t in sorted((int(x) for x in s), reverse=True):
        r = s[str(t)]
        if need is None or any(r.get(k) is not None for k in need): return t, r
    return None, None

seen = hist.setdefault('seen', {})          # place → last time anything was measured there (kept beyond the 7 days)
places = []
for pid, name, kind, lat, lon, feeds in REGISTRY:
    cand = []                                # (t, src, key, record) – newest record with wind of every source
    for src, key in feeds:
        t, r = newest(feed_series(src, key), ('wspd', 'wgust', 'wdir'))
        if t: cand.append((t, src, key, r))
    anyt = [newest(feed_series(s, k))[0] for s, k in feeds]
    anyt = [t for t in anyt if t]
    if anyt: seen[pid] = max(seen.get(pid, 0), max(anyt))
    pl = {'id': pid, 'name': name, 'kind': kind, 'lat': lat, 'lon': lon, 'h': 3 if kind == 'buoy' else 10,
          'src': [s + ':' + k for s, k in feeds]}
    live = [c for c in cand if now - c[0] <= LIVE[c[1]]]
    if not live:
        # nobody answers: the place stays on the map, grey, with the last time it was heard from
        pl['off'] = True; pl['seen'] = seen.get(pid)
        if cand:
            t, src, key, r = max(cand, key=lambda c: c[0])
            pl['t'] = t; pl.update({k: r[k] for k in ('wspd', 'wgust', 'wdir') if r.get(k) is not None})
        places.append(pl); continue
    # the freshest wind wins; at equal age the 10-minute graph (it has gusts) before the hourly XML
    order = {'amp': 0, 'buoy': 1, 'arso': 2, 'metar': 3, 'xml': 4}
    t, src, key, _ = max(live, key=lambda c: (c[0] // 600, -order[c[1]]))
    s = feed_series(src, key)
    v = latest_each(s, t) if src in ('buoy', 'amp') else dict(s[str(t)])
    pl.update({'t': t, 'by': src, 'stale': now - t > 2 * STEP[src] + 1800})
    for k, x in v.items():
        if x is not None and k not in ('lat', 'lon', 'ptend'): pl[k] = x
    # what the winning source lacks, the others fill in (sea-level pressure from XML/METAR/ARSO, humidity, …)
    for src2, key2 in feeds:
        if (src2, key2) == (src, key): continue
        t2, r2 = newest(feed_series(src2, key2))
        if not t2 or now - t2 > LIVE[src2]: continue
        for k in ('pres', 'tair', 'rh', 'wgust', 'sst'):
            if pl.get(k) is None and r2.get(k) is not None and (k != 'wgust' or abs(t2 - t) <= 1800): pl[k] = r2[k]
        if 'ptend' in r2 and 'dp3' not in pl: pl['dp3'] = r2['ptend']
    # tendencies from the winning source's own history (10-minute graphs: pressure at the station is fine for a change)
    pk = 'pres' if any(r.get('pres') is not None for r in s.values()) else 'pst'
    old3 = at(s, t - 3 * H, key=pk); old1 = at(s, t - H, key='tair'); old3h = at(s, t - 3 * H, key='rh')
    if old3 and v.get(pk) is not None and src != 'xml': pl['dp3'] = round(v[pk] - old3[pk], 1)
    if src == 'xml' and v.get('ptend') is not None: pl['dp3'] = v['ptend']
    if old1 and v.get('tair') is not None: pl['dT1'] = round(v['tair'] - old1['tair'], 1)
    if old3h and v.get('rh') is not None: pl['drh3'] = round(v['rh'] - old3h['rh'])
    pl.pop('pst', None)
    places.append(pl)
live_places = [p for p in places if not p.get('off')]
print(f'Mjesta: {len(live_places)} javlja se, {len(places) - len(live_places)} ne javlja se:',
      ', '.join(f"{p['name']} (od {dt.datetime.fromtimestamp(p['seen'], ZG):%d.%m. %H:%M})" if p.get('seen') else p['name'] for p in places if p.get('off')))

P = {p['name']: p for p in live_places}
def pres(names):
    vals = [P[n]['pres'] for n in names if n in P and P[n].get('pres')]
    return sum(vals) / len(vals) if vals else None
inland = [hist['stations'][n] for n in INLAND if n in hist['stations']]
inl = [last(s, 3 * H)[1] for s in inland]; inl = [v['pres'] for v in inl if v and v.get('pres')]
pin = sum(inl) / len(inl) if inl else None
signals = []
def sig(level, title, text, where=None): signals.append({'level': level, 'title': title, 'text': text, **({'where': where} if where else {})})

# bura: high pressure behind the Velebit/Dinarides against the coast
for zone, coast in (('Kvarner', ['Senj', 'Rijeka', 'Rab', 'Crikvenica']), ('srednji Jadran', ['Zadar', 'Šibenik', 'Split-Marjan'])):
    pc = pres(coast)
    if pin and pc:
        dpb = pin - pc
        if dpb >= 4: sig('jako' if dpb >= 8 else 'umjereno', f'Gradijent za buru – {zone}', f'Tlak u unutrašnjosti {dpb:.1f} hPa viši nego na obali: uvjeti za buru ({"jaku" if dpb >= 8 else "umjerenu"}).', zone)
# jugo: low pressure in the north against the south
pn, ps = pres(['Kvarner', 'Rijeka', 'Senj', 'Pula-aerodrom']), pres(['Molunat', 'Dubrovnik', 'Lastovo', 'Palagruža'])
if pn and ps:
    dj = ps - pn
    if dj >= 4: sig('jako' if dj >= 8 else 'umjereno', 'Gradijent za jugo', f'Tlak na jugu {dj:.1f} hPa viši nego na sjeveru Jadrana: uvjeti za jugo ({"jako" if dj >= 8 else "umjereno"}).')
for p in live_places:
    if p.get('dp3') is not None and p['dp3'] <= -3: sig('jako' if p['dp3'] <= -5 else 'umjereno', f'Pad tlaka – {p["name"]}', f'{p["dp3"]:+.1f} hPa u 3 h: vjetar jača ili dolazi fronta.', p['name'])
    if p.get('dp3') is not None and p['dp3'] >= 3: sig('umjereno', f'Skok tlaka – {p["name"]}', f'{p["dp3"]:+.1f} hPa u 3 h: moguć okret i bura iza fronte.', p['name'])
    if p.get('dT1') is not None and p['dT1'] <= -3: sig('jako', f'Nagli pad temperature – {p["name"]}', f'{p["dT1"]:+.1f} °C u 1 h' + (' uz sjeverni vjetar: prodor bure.' if p.get('wdir') is not None and (p['wdir'] >= 315 or p['wdir'] <= 70) else ': prolaz fronte ili hladni prodor.'), p['name'])
    if p.get('drh3') is not None and p['drh3'] >= 15 and p.get('wdir') is not None and 100 <= p['wdir'] <= 200: sig('umjereno', f'Vlaga raste uz SE – {p["name"]}', f'+{p["drh3"]} % u 3 h uz jugoistočnjak: jugo se razvija.', p['name'])
# a wind spreading along the coast: strong NE in the north, not yet in the south (bura) – and the other way for jugo
def strong(names, lo, hi, kn=20):
    return [n for n in names if n in P and P[n].get('wspd', 0) >= kn and P[n].get('wdir') is not None and (lo <= P[n]['wdir'] <= hi if lo < hi else (P[n]['wdir'] >= lo or P[n]['wdir'] <= hi))]
north, south = ['Kvarner', 'Senj', 'Rab', 'Rijeka', 'Porer - svjetionik'], ['Blitvenica', 'Šibenik', 'Split-Marjan', 'Viški kanal', 'Hvar', 'Palagruža']
bn, bs = strong(north, 20, 80), strong(south, 20, 80)
if bn and not bs: sig('umjereno', 'Bura na sjeveru, jug je još nema', f'Jaka bura mjeri se na: {", ".join(bn)}. Južnije još ne – može se proširiti niz obalu.')
jn, js = strong(south + ['Molunat', 'Lastovo', 'Dubrovnik'], 100, 170), strong(north, 100, 170)
if jn and not js: sig('umjereno', 'Jugo na jugu, sjever ga još nema', f'Jako jugo mjeri se na: {", ".join(jn)}. Na sjeveru još ne – širi se prema Kvarneru.')

# ---------------- scoring the models against the measurements ----------------
# every cloud package publishes the models' wind at these places for the next 48 h (data/models/points.json); we keep
# them for 3 days and, as the measurements come in, add each model's error to hourly totals (kept 8 days):
# speed error = model − measured (buoys brought from 3 m to 10 m), split by how far ahead the forecast was made
U3_10 = 1.12
fc = hist.setdefault('fc', {})
try:
    raw, _ = get('https://clockwork-75.github.io/Clock-the-wind/data/models/points.json?t=%d' % int(now))
    pts = json.loads(raw)
    if str(pts['created']) not in fc: fc[str(pts['created'])] = pts; print('nova prognoza za ocjenu:', dt.datetime.fromtimestamp(pts['created'] / 1000, ZG))
except Exception as e: print('!! točke prognoze', e)
for k in list(fc):
    if int(k) / 1000 < now - 3 * 24 * H: del fc[k]
agg = hist.setdefault('score', {})        # hour → model → lead bin → [sum |e|, sum e, n]
done = set(hist.setdefault('scored', []))
FEEDS = {r[0]: r[5] for r in REGISTRY}
BINS = (('0-12', 0, 12), ('12-24', 12, 24), ('24-48', 24, 49))
def measured(pid, t):
    """measured wind at the full hour t as a vector (u, v toward which it blows, kn) + speed; buoys brought from 3 m to 10 m.
    Every source of the place is tried: 10-minute value at the hour first, then hourly XML, then the nearest METAR/ARSO."""
    for src, key in sorted(FEEDS.get(pid, []), key=lambda f: {'amp': 0, 'buoy': 1, 'xml': 2, 'arso': 3, 'metar': 4}[f[0]]):
        s = feed_series(src, key)
        v = s.get(str(t)) if src != 'metar' and src != 'arso' else at(s, t, tol=20 * 60, key='wspd')
        if not v or v.get('wspd') is None: continue
        sp = v['wspd'] * (U3_10 if src == 'buoy' else 1)
        if sp < 0.5: return (0.0, 0.0, 0.0)
        if v.get('wdir') is None: continue
        a = math.radians(v['wdir'])          # direction the wind comes FROM
        return (-sp * math.sin(a), -sp * math.cos(a), sp)
    return None
def ang(a, b): d = abs(a - b) % 360; return 360 - d if d > 180 else d
def frm(u, v): return (math.degrees(math.atan2(-u, -v)) + 360) % 360
# score2: hour → model → lead bin → [Σ vector error, Σ speed error, Σ |speed error|, n, Σ direction error, n dir]
agg2 = hist.setdefault('score2', {})
for created, P_ in sorted(fc.items()):
    if not P_.get('uv'): continue          # old packages without direction: not scored
    t0 = P_['t0'] // 1000
    for k in range(len(next(iter(P_['models'].values())))):
        t = t0 + k * H
        if t > now: break
        lead = (t * 1000 - int(created)) / 3600000
        if lead < 0: continue
        b = next((n for n, lo, hi in BINS if lo <= lead < hi), None)
        if not b: continue
        for j, pid in enumerate(P_['places']):
            key = f'{created}|{pid}|{t}'
            if key in done: continue
            m = measured(pid, t)
            if m is None: continue
            done.add(key)
            for mid, rows in P_['models'].items():
                f = rows[k][j]
                if not f: continue
                fu, fv = f; fs = math.hypot(fu, fv)
                c = agg2.setdefault(str(t), {}).setdefault(mid, {}).setdefault(b, [0, 0, 0, 0, 0, 0])
                c[0] += math.hypot(fu - m[0], fv - m[1]); c[1] += fs - m[2]; c[2] += abs(fs - m[2]); c[3] += 1
                if fs >= 5 and m[2] >= 5: c[4] += ang(frm(fu, fv), frm(m[0], m[1])); c[5] += 1
hist.pop('score', None)
for t in list(agg2):
    if int(t) < now - 8 * 24 * H: del agg2[t]
hist['scored'] = [k for k in done if int(k.rsplit('|', 1)[1]) >= now - 4 * 24 * H]
def skill(hours, bins=None):
    tot = {}
    for t, mm in agg2.items():
        if int(t) < now - hours * H: continue
        for mid, bb in mm.items():
            for b, c in bb.items():
                if bins and b not in bins: continue
                x = tot.setdefault(mid, [0] * 6)
                for i_ in range(6): x[i_] += c[i_]
    out = []
    for m, (sv, se, sa, n, sd, nd) in tot.items():
        if n < 20: continue
        out.append({'id': m, 'mae': round(sv / n, 2), 'spd': round(sa / n, 2), 'bias': round(se / n, 2), 'dir': round(sd / nd) if nd >= 10 else None, 'n': n})
    return sorted(out, key=lambda r: r['mae'])   # ranked by the vector error: speed and direction together
SKILL = {'24h': skill(24), '72h': skill(72), '7d': skill(7 * 24), '7d_0-12': skill(7 * 24, ['0-12']), '7d_24-48': skill(7 * 24, ['24-48'])}
print('Rang modela 24 h (vektorska greška):', ', '.join(f"{r['id']} ±{r['mae']} (smjer ±{r['dir']}°)" for r in SKILL['24h']) or 'još nema dovoljno podataka')

# ---------------- measured pressure gradients (with the places, so the app can read the same from each model) ----------------
def group(names):
    pts = []
    for n in names:
        if n in P and P[n].get('pres'): pts.append((P[n]['lat'], P[n]['lon'], P[n]['pres']))
        elif n in hist['stations']:
            t_, v_ = last(hist['stations'][n], 3 * H)
            if v_ and v_.get('pres') and v_.get('lat'): pts.append((v_['lat'], v_['lon'], v_['pres']))
    return pts
GRADS = []
for gid, name, hi, lo in (('bura_kv', 'Bura – Kvarner (unutrašnjost − obala)', ['Ogulin', 'Plaški', 'Bosiljevo', 'Gospić'], ['Senj', 'Rijeka', 'Crikvenica', 'Rab']),
                          ('bura_da', 'Bura – Dalmacija (unutrašnjost − obala)', ['Gospić', 'Knin'], ['Zadar', 'Šibenik', 'Split-Marjan']),
                          ('jugo', 'Jugo (jug − sjever Jadrana)', ['Molunat', 'Dubrovnik', 'Lastovo', 'Palagruža'], ['Kvarner', 'Rijeka', 'Senj', 'Pula-aerodrom'])):
    A, B_ = group(hi), group(lo)
    if len(A) >= 1 and len(B_) >= 2:
        GRADS.append({'id': gid, 'name': name, 'obs': round(sum(x[2] for x in A) / len(A) - sum(x[2] for x in B_) / len(B_), 1),
                      'a': [[round(x[0], 3), round(x[1], 3)] for x in A], 'b': [[round(x[0], 3), round(x[1], 3)] for x in B_]})
print('Gradijenti:', ', '.join(f"{g['id']} {g['obs']:+.1f} hPa" for g in GRADS))

# 72 h series for the app (buoys every 30 min, stations hourly)
series = {}
KEEP = ('wspd', 'wgust', 'wdir', 'pres', 'tair', 'rh', 'hs', 'hmax', 'tp', 'vdir', 'sst')
for pid, name, kind, lat, lon, feeds in REGISTRY:
    out = {}
    for src, key in sorted(feeds, key=lambda f: {'buoy': 0, 'amp': 1, 'xml': 2, 'arso': 3, 'metar': 4}[f[0]]):
        have = sorted(int(x) for x in out)
        for t_, v in sorted(feed_series(src, key).items()):
            ti = int(t_)
            if ti < now - 72 * H: continue
            if src in ('buoy', 'amp') and ti % 1800: continue            # every 30 min is enough for the graphs
            if src not in ('buoy', 'amp') and any(abs(ti - h) < 25 * 60 for h in have): continue   # already covered
            r = {k: v[k] for k in KEEP if v.get(k) is not None}
            if r: out.setdefault(t_, {}).update({k: x for k, x in r.items() if k not in out.get(t_, {})})
    if out: series[pid] = dict(sorted(out.items(), key=lambda kv: int(kv[0])))

json.dump(hist, open(os.path.join(OUT, 'history.json'), 'w'), separators=(',', ':'))
json.dump({'created': int(now), 'places': places, 'signals': signals, 'series': series, 'errors': errors, 'skill': SKILL, 'grads': GRADS,
           'note': 'DHMZ izvorni nekontrolirani podaci (plutače i automatske postaje očitane s grafova, plutače vjetar na 3 m); METAR (aerodromi); ARSO (Koper, Portorož).'},
          open(os.path.join(OUT, 'obs.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print(f'Mjesta: {len(places)} ({len(live_places)} javlja se), signali: {len(signals)}', '|', ' · '.join(s['title'] for s in signals))
for p in live_places[:60]: print('  ', p['name'], p.get('by'), {k: p.get(k) for k in ('wspd', 'wgust', 'wdir', 'pres', 'dp3', 'hs', 'tair', 'rh')})

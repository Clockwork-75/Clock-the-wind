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

def get(url, timeout=40):
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

# keep 7 days
cut = now - 7 * 24 * H
for grp in ('buoys', 'stations'):
    for k in list(hist[grp]):
        hist[grp][k] = {t: v for t, v in hist[grp][k].items() if int(t) >= cut}

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

places = []
for bid, name, lat, lon in BUOYS:
    s = hist['buoys'].get(bid, {})
    t, v = last(s, 12 * H)
    if not t: continue
    v = latest_each(s, t)
    old3 = at(s, t - 3 * H, key='pres'); old1 = at(s, t - H, key='tair'); old3h = at(s, t - 3 * H, key='rh')
    places.append({'id': 'b:' + bid, 'name': name, 'kind': 'buoy', 'lat': round(lat, 4), 'lon': round(lon, 4), 't': t, 'h': 3, 'stale': now - t > 2 * H, **v,
                   **({'dp3': round(v['pres'] - old3['pres'], 1)} if old3 and 'pres' in v else {}),
                   **({'dT1': round(v['tair'] - old1['tair'], 1)} if old1 and 'tair' in v else {}),
                   **({'drh3': round(v['rh'] - old3h['rh'])} if old3h and 'rh' in v else {})})
for nm, s in hist['stations'].items():
    if nm not in COAST: continue
    t, v = last(s, 3 * H)
    if not t: continue
    old1 = at(s, t - H, key='tair'); old3 = at(s, t - 3 * H, key='rh')
    places.append({'id': 's:' + nm, 'name': nm, 'kind': 'lighthouse' if 'svjetionik' in nm else 'station', 'lat': v['lat'], 'lon': v['lon'], 't': t, 'h': 10,
                   **{k: v[k] for k in ('wspd', 'wdir', 'pres', 'tair', 'rh') if v.get(k) is not None},
                   **({'dp3': v['ptend']} if 'ptend' in v else {}),
                   **({'dT1': round(v['tair'] - old1['tair'], 1)} if old1 and 'tair' in v else {}),
                   **({'drh3': round(v['rh'] - old3['rh'])} if old3 and v.get('rh') is not None and old3.get('rh') is not None else {})})

P = {p['name']: p for p in places}
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
for p in places:
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
BINS = (('0-12', 0, 12), ('12-24', 12, 24), ('24-48', 24, 49))
def measured(pid, t):
    """measured wind as a vector (u, v toward which it blows, kn) + speed; buoys brought from 3 m to 10 m"""
    if pid.startswith('b:'): v = hist['buoys'].get(pid[2:], {}).get(str(t)); k = U3_10
    else: v = hist['stations'].get(pid[2:], {}).get(str(t)); k = 1
    if not v or v.get('wspd') is None: return None
    sp = v['wspd'] * k
    if sp < 0.5: return (0.0, 0.0, 0.0)
    if v.get('wdir') is None: return None
    a = math.radians(v['wdir'])          # direction the wind comes FROM
    return (-sp * math.sin(a), -sp * math.cos(a), sp)
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
for bid, name, lat, lon in BUOYS:
    s = hist['buoys'].get(bid, {})
    series['b:' + bid] = {t: v for t, v in sorted(s.items()) if int(t) >= now - 72 * H and int(t) % 1800 == 0}
for nm in COAST:
    s = hist['stations'].get(nm, {})
    series['s:' + nm] = {t: {k: v[k] for k in ('wspd', 'wdir', 'pres', 'tair', 'rh') if v.get(k) is not None} for t, v in sorted(s.items()) if int(t) >= now - 72 * H}

json.dump(hist, open(os.path.join(OUT, 'history.json'), 'w'), separators=(',', ':'))
json.dump({'created': int(now), 'places': places, 'signals': signals, 'series': series, 'errors': errors, 'skill': SKILL, 'grads': GRADS,
           'note': 'DHMZ izvorni nekontrolirani podaci; plutače očitane s grafova (vjetar na 3 m).'},
          open(os.path.join(OUT, 'obs.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print(f'Mjesta: {len(places)}, signali: {len(signals)}', '|', ' · '.join(s['title'] for s in signals))
for p in places[:8]: print('  ', p['name'], {k: p.get(k) for k in ('wspd', 'wgust', 'wdir', 'pres', 'dp3', 'hs', 'tair', 'rh')})

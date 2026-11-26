"""Clock the Wind – where lightning really strikes: EUMETSAT MTG Lightning Imager (satellite), every 10 min.

The public EUMETView map service (layer mtg_fd:li_afa, 'accumulated flash area', a new picture every 5 min) is read for
the wider Adriatic; every coloured pixel is a place where the satellite saw lightning. Pixels are grouped into 0.05°
cells, so the app can put one small lightning icon on each. The last four pictures (≈20 min) are kept with their time,
so the newest can flash and the older fade. Output: lightning.json (branch `munje`).
The app cannot read the map service itself (no CORS), which is why this runs on GitHub.
"""
import sys, os, json, re, time, io, urllib.request
from datetime import datetime, timedelta, timezone
from PIL import Image
import numpy as np

OUT = sys.argv[1] if len(sys.argv) > 1 else 'munje'
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'ClockTheWind sailing app (github actions)'}
S, N, W, E = 38.0, 48.0, 8.0, 24.0          # the Adriatic with a margin (storms come from Italy / the Balkans)
WIDTH, HEIGHT = 1600, 1000                    # 0.01° per pixel
CELL = 0.05

def get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()

cap = get('https://view.eumetsat.int/geoserver/mtg_fd/li_afa/wms?service=WMS&request=GetCapabilities&version=1.3.0').decode('utf-8', 'replace')
m = re.search(r'<Dimension name="time" default="([^"]+)"', cap)
latest = datetime.fromisoformat(m.group(1).replace('Z', '+00:00')) if m else datetime.now(timezone.utc).replace(second=0, microsecond=0)
points, frames = [], []
for k in range(4):
    t = latest - timedelta(minutes=5 * k)
    ts = t.strftime('%Y-%m-%dT%H:%M:%SZ')
    url = ('https://view.eumetsat.int/geoserver/wms?service=WMS&request=GetMap&version=1.3.0&layers=mtg_fd:li_afa&styles='
           f'&format=image/png&transparent=true&crs=EPSG:4326&bbox={S},{W},{N},{E}&width={WIDTH}&height={HEIGHT}&time={ts}')
    try:
        a = np.asarray(Image.open(io.BytesIO(get(url))).convert('RGBA'))
    except Exception as e:
        print('!!', ts, e); continue
    on = a[:, :, 3] > 40
    ys, xs = np.nonzero(on)
    cells = {}
    for y, x in zip(ys, xs):
        lat = N - (y + 0.5) * (N - S) / HEIGHT; lon = W + (x + 0.5) * (E - W) / WIDTH
        key = (round(lat / CELL), round(lon / CELL))
        c = cells.setdefault(key, [0, 0.0, 0.0]); c[0] += 1; c[1] += lat; c[2] += lon
    for (n, sl, so) in cells.values():
        points.append({'lat': round(sl / n, 3), 'lon': round(so / n, 3), 'n': int(n), 't': int(t.timestamp())})
    frames.append({'t': int(t.timestamp()), 'cells': len(cells)})
    print(ts, 'piksela', int(on.sum()), 'mjesta', len(cells))
# one icon per place: the newest time it was seen
best = {}
for p in points:
    k = (round(p['lat'] / CELL), round(p['lon'] / CELL))
    if k not in best or p['t'] > best[k]['t']: best[k] = p
json.dump({'created': int(time.time()), 'latest': int(latest.timestamp()), 'frames': frames, 'points': sorted(best.values(), key=lambda p: -p['t']),
           'source': 'EUMETSAT MTG Lightning Imager (view.eumetsat.int, mtg_fd:li_afa)'},
          open(os.path.join(OUT, 'lightning.json'), 'w'), separators=(',', ':'))
print('ukupno mjesta s munjama:', len(best), '| zadnja slika', latest.isoformat())

"""Diagnostic: EUMETSAT MTG Lightning Imager WMS – CORS for the app, and where the flashes are in the latest picture."""
import urllib.request, io
from PIL import Image
import numpy as np
U = ('https://view.eumetsat.int/geoserver/wms?service=WMS&request=GetMap&version=1.3.0&layers=mtg_fd:li_afa&styles=&format=image/png'
     '&transparent=true&crs=EPSG:4326&bbox=30,-10,50,40&width=1000&height=400')
req = urllib.request.Request(U, headers={'Origin': 'https://clockwork-75.github.io', 'User-Agent': 'ClockTheWind'})
with urllib.request.urlopen(req, timeout=60) as r:
    h = dict(r.headers); b = r.read()
print('status', r.status, 'tip', h.get('Content-Type'), 'CORS:', h.get('Access-Control-Allow-Origin'), 'bajtova', len(b))
a = np.asarray(Image.open(io.BytesIO(b)).convert('RGBA')).astype(int)
on = a[:, :, 3] > 30
print('obojenih piksela', int(on.sum()), 'boje', np.unique(a[on][:, :3], axis=0)[:12].tolist() if on.any() else '-')
ys, xs = np.nonzero(on)
for y, x in list(zip(ys, xs))[:: max(1, len(xs) // 15)][:15]:
    print('  munja oko', round(50 - y * 20 / 400, 2), 'N', round(-10 + x * 50 / 1000, 2), 'E', a[y, x].tolist())
# time dimension of the layer
cap = urllib.request.urlopen('https://view.eumetsat.int/geoserver/mtg_fd/li_afa/wms?service=WMS&request=GetCapabilities&version=1.3.0', timeout=60).read().decode('utf-8', 'replace')
i = cap.find('<Dimension'); print('vrijeme sloja:', cap[i:i + 300].replace('\n', ' ') if i >= 0 else 'nema')

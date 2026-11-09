# Builds data/world.json: land outlines outside the detailed Adriatic coast (data/coast.json).
#   w  = Natural Earth 1:50m land, whole world (simplified ~3 km)        – zoomed far out / outside Europe
#   eu = Natural Earth 1:10m land, Europe + Mediterranean (simplified ~150 m), clipped to the box in "clip"
# Encoding as coast.json: integer deltas (lon, lat) * scale; rings are oriented so that holes cut with fill rule 'nonzero'.
# Usage: python3 tools/basemap/build_world.py ne_50m_land.geojson ne_10m_land.geojson data/world.json
import json, sys
from shapely.geometry import shape, box, Polygon, MultiPolygon
from shapely.geometry.polygon import orient

SCALE = 10000
EU = (-12.0, 28.0, 45.0, 62.0)   # w, s, e, n

def polys(g):
    if g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    if isinstance(g, MultiPolygon): return list(g.geoms)
    return [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]

def enc(coords):
    out, px, py = [], 0, 0
    for x, y in coords:
        ix, iy = round(x * SCALE), round(y * SCALE)
        if out and ix == px and iy == py: continue
        out += [ix - px, iy - py]; px, py = ix, iy
    return out

def build(path, tol, clip=None, min_area=0.0):
    feats = json.load(open(path))['features']
    lines = []
    cb = box(*clip) if clip else None
    for f in feats:
        g = shape(f['geometry'])
        if cb is not None:
            if not g.intersects(cb): continue
            g = g.intersection(cb)
        for p in polys(g):
            p = p.simplify(tol, preserve_topology=True)
            for q in polys(p):
                if q.area < min_area: continue
                q = orient(q, 1.0)
                lines.append({'p': enc(q.exterior.coords), 'c': 1})
                for h in q.interiors:
                    if Polygon(h).area < min_area: continue
                    lines.append({'p': enc(h.coords), 'c': 1})
    return lines

w = build(sys.argv[1], 0.03, None, 0.0004)
eu = build(sys.argv[2], 0.0015, EU, 0.000002)
json.dump({'scale': SCALE, 'source': 'Natural Earth 1:50m / 1:10m land (public domain)',
           'sets': [{'id': 'w', 'lines': w}, {'id': 'eu', 'clip': list(EU), 'lines': eu}]},
          open(sys.argv[3], 'w'), separators=(',', ':'))
print('w rings', len(w), 'pts', sum(len(l['p']) for l in w) // 2, '| eu rings', len(eu), 'pts', sum(len(l['p']) for l in eu) // 2)

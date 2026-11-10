"""Read the DHMZ buoy graphs (vrijeme.hr/plutace/plutaca-<Name>.png) back into numbers.

The graphs are drawn by matplotlib with a fixed layout: 14 panels, the time axis spans three local days
(00:00 of the first day to 00:00 after the last), one point every 10 minutes. Curves are found by their colour,
the value axis is read from the tick labels (digits matched against DejaVu Sans glyphs, the font matplotlib uses).
Anything that does not look exactly as expected is dropped – never a wrong number.
"""
import sys, json, math, datetime as dt
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
GLYPHS = '0123456789.-'

def dark_mask(a, thr=200):
    return a.sum(2) < thr

# ---------- digit recognition ----------
def _norm(m):
    ys, xs = np.nonzero(m)
    if not len(ys): return None
    c = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(float)
    return c

def _resize(c, w=9, h=13):
    im = Image.fromarray((c * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
    return np.asarray(im).astype(float) / 255

TEMPL = None
def templates():
    """digit masks rendered in DejaVu Sans at matplotlib's 10 pt @ 100 dpi (≈13.9 px), several sizes and thresholds"""
    global TEMPL
    if TEMPL is not None: return TEMPL
    TEMPL = {}
    for size in (13, 14, 15):
        f = ImageFont.truetype(FONT, size)
        for ch in '0123456789':
            im = Image.new('L', (40, 40), 0); ImageDraw.Draw(im).text((8, 8), ch, fill=255, font=f)
            g = np.asarray(im)
            for thr in (70, 110, 150):
                c = _norm(g > thr)
                if c is not None: TEMPL.setdefault(ch, []).append(c > 0.5)
    return TEMPL

def _match(c, t):
    """best overlap (IoU) of two masks over small shifts"""
    H = max(c.shape[0], t.shape[0]) + 2; W = max(c.shape[1], t.shape[1]) + 2
    best = 0
    for dy in range(0, H - c.shape[0] + 1):
        for dx in range(0, W - c.shape[1] + 1):
            A = np.zeros((H, W), bool); A[dy:dy + c.shape[0], dx:dx + c.shape[1]] = c
            for ey in range(0, H - t.shape[0] + 1):
                for ex in range(0, W - t.shape[1] + 1):
                    if abs((dy - ey)) > 1 or abs(dx - ex) > 1: continue
                    Bm = np.zeros((H, W), bool); Bm[ey:ey + t.shape[0], ex:ex + t.shape[1]] = t
                    u = (A | Bm).sum()
                    if u: best = max(best, (A & Bm).sum() / u)
    return best

def read_label(gray_crop):
    """gray_crop: 2D bool array (text pixels) of one tick label → float or None"""
    # only the label next to the tick: the rightmost group of text columns (the axis title further left is ignored)
    cols = gray_crop.any(0)
    xs = np.nonzero(cols)[0]
    if not len(xs): return None
    x = xs.max(); gap = 0
    while x > 0 and gap <= 5:
        x -= 1; gap = 0 if cols[x] else gap + 1
    gray_crop = gray_crop[:, x + gap:]
    rows = gray_crop.any(1); r = np.nonzero(rows)[0]
    if not len(r) or r.max() - r.min() > 14: return None
    cols = gray_crop.any(0)
    xs = np.nonzero(cols)[0]
    if not len(xs): return None
    # split into characters at empty columns
    chars, start = [], None
    for x in range(xs.min(), xs.max() + 2):
        on = x <= xs.max() and cols[x]
        if on and start is None: start = x
        if not on and start is not None: chars.append((start, x)); start = None
    rows = gray_crop.any(1); ys = np.nonzero(rows)[0]; top, bot = ys.min(), ys.max()
    hfull = bot - top + 1
    out = ''
    T = templates()
    for a, b in chars:
        sub = gray_crop[:, a:b]
        c = _norm(sub)
        if c is None: continue
        hy = np.nonzero(sub.any(1))[0]
        if c.shape[0] <= max(3, hfull * 0.3):
            # small blob: decimal point (at the baseline) or minus (in the middle)
            out += '.' if hy.max() >= bot - 1 else '-'
            continue
        cm = c > 0.5
        best, bs = None, -1
        for ch, lst in T.items():
            for t in lst:
                if abs(t.shape[0] - cm.shape[0]) > 2 or abs(t.shape[1] - cm.shape[1]) > 2: continue
                m = _match(cm, t)
                if m > bs: bs, best = m, ch
        if best is None or bs < 0.45: return None
        out += best
    try: return float(out)
    except ValueError: return None

# ---------- axes ----------
def find_panels(a):
    """frames of the panels: (top, bottom, left spine, right spine) – the spines differ between panels"""
    dark = dark_mask(a, 150)
    rows = [y for y in range(a.shape[0]) if dark[y].sum() > 600]
    lines = []
    for y in rows:
        if lines and y - lines[-1] <= 1: continue
        lines.append(y)
    panels = []
    for i in range(len(lines) - 1):
        t, b = lines[i], lines[i + 1]
        if b - t < 60: continue
        frac = dark[t + 5:b - 5].mean(0)
        sp = np.nonzero(frac > 0.95)[0]
        if len(sp) >= 2 and sp.max() - sp.min() > 600: panels.append((t, b, int(sp.min()), int(sp.max())))
    return panels

def y_axis(a, top, bot, left):
    """tick marks left of the spine and their labels → (pixel_y, value) pairs"""
    dark = dark_mask(a, 300)
    ticks = [y for y in range(top, bot + 1) if dark[y, left - 4] and dark[y, left - 2]]
    tt = []
    for y in ticks:
        if tt and y - tt[-1] <= 1: continue
        tt.append(y)
    pairs = []
    for y in tt:
        crop = dark_mask(a[max(0, y - 9):y + 9, max(0, left - 70):left - 6], 380)
        v = read_label(crop)
        if v is not None: pairs.append((y, v))
    return pairs

def fit_axis(pairs, log=False):
    """linear fit value = A + B*y from tick pairs, rejecting a misread label"""
    if len(pairs) < 2: return None
    ys = np.array([p[0] for p in pairs], float); vs = np.array([p[1] for p in pairs], float)
    if log:
        if (vs <= 0).any(): return None
        vs = np.log10(vs)
    best = None
    for i in range(len(ys)):
        for j in range(i + 1, len(ys)):
            if ys[j] == ys[i]: continue
            B = (vs[j] - vs[i]) / (ys[j] - ys[i]); A = vs[i] - B * ys[i]
            err = np.abs(A + B * ys - vs); ok = err < max(1e-9, abs(B) * 1.5)
            if best is None or ok.sum() > best[0]: best = (ok.sum(), A, B)
    n, A, B = best
    # the ticks are evenly spaced numbers: most labels must agree on one straight line (a misread digit is outvoted)
    if n < max(3, math.ceil(0.6 * len(ys))): return None
    return (A, B, log)

def val(ax, y):
    A, B, log = ax
    v = A + B * y
    return 10 ** v if log else v

# ---------- curves ----------
def curve(a, top, bot, left, right, rgb, tol=40, dots=False):
    """for every pixel column: the y of the pixels of this colour (median); None where absent"""
    c = np.array(rgb)
    sub = a[top + 1:bot, left + 1:right]
    d = np.abs(sub - c).sum(2)
    m = d < tol
    ys = [None] * sub.shape[1]
    for x in range(sub.shape[1]):
        idx = np.nonzero(m[:, x])[0]
        if len(idx): ys[x] = top + 1 + (float(np.median(idx)) if dots else float(idx.mean()))
    return ys

def series_colour(a, top, bot, left, right, near_rgb, tol=110):
    """the exact colour of a series: the most common saturated colour inside the panel close to the expected one"""
    sub = a[top + 2:bot - 1, left + 2:right - 1].reshape(-1, 3)
    sat = sub.max(1) - sub.min(1)
    cand = sub[sat > 25]
    if not len(cand): return None
    vals, counts = np.unique(cand, axis=0, return_counts=True)
    d = np.abs(vals - np.array(near_rgb)).sum(1)
    ok = (d < tol) & (counts >= 15)
    if not ok.any(): return None
    k = np.argmax(np.where(ok, counts, -1))
    return tuple(int(x) for x in vals[k])

def y_axis_right(a, top, bot, right):
    """ticks right of the right spine and their labels (e.g. relative humidity on the temperature panel)"""
    dark = dark_mask(a, 300)
    tt = []
    for y in range(top, bot + 1):
        if dark[y, right + 2] and dark[y, right + 4] and (not tt or y - tt[-1] > 1): tt.append(y)
    pairs = []
    for y in tt:
        crop = dark_mask(a[max(0, y - 9):y + 9, right + 6:min(a.shape[1], right + 60)], 380)
        # the label is the leftmost text group here: mirror, reuse the right-group logic, mirror back
        v = read_label(crop[:, ::-1][:, ::-1] if False else _left_group(crop))
        if v is not None: pairs.append((y, v))
    return pairs

def _left_group(crop):
    cols = crop.any(0); xs = np.nonzero(cols)[0]
    if not len(xs): return crop
    x = xs.min(); gap = 0
    while x < crop.shape[1] - 1 and gap <= 5:
        x += 1; gap = 0 if cols[x] else gap + 1
    return crop[:, :x - gap + 1]

PANELS = [   # order of the frames in the image; series: (key, approximate colour, kind)
    ('wind_dir', [('wdir', (34, 139, 34), 'dir')]),
    ('wind', [('wspd', (65, 105, 225), 'lin'), ('wgust', (255, 0, 0), 'lin')]),
    ('wave_dir', [('vdir', (34, 139, 34), 'dir')]),
    ('wave', [('hs', (0, 0, 255), 'lin'), ('hmax', (220, 20, 60), 'lin')]),
    ('wave_per', [('tp', (162, 192, 217), 'lin')]),
    ('temp', [('tair', (255, 20, 20), 'lin')]),
    ('vis', []),
    ('pres', [('pres', (106, 90, 205), 'lin')]),
    ('rad', []),
    ('sst', [('sst', (0, 0, 205), 'lin')]),
]
DIR_LABELS = {'N': 0, 'E': 90, 'S': 180, 'W': 270}

def dir_axis(a, top, bot, left):
    """direction panels: labels E, S, W, N from the bottom up; gridded at 90° steps"""
    dark = dark_mask(a, 300)
    tt = []
    for y in range(top, bot + 1):
        if dark[y, left - 4] and dark[y, left - 2] and (not tt or y - tt[-1] > 1): tt.append(y)
    if len(tt) < 4: return None
    # bottom→top: E(90) S(180) W(270) N(360)
    tt = sorted(tt, reverse=True)[:4]
    ys = np.array(tt, float); vs = np.array([90, 180, 270, 360], float)
    B, A = np.polyfit(ys, vs, 1)
    return (A, B, False)

def read(path, last_modified=None):
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    panels = find_panels(a)
    if len(panels) < 10: raise SystemExit(f'{path}: {len(panels)} panels – layout changed, nothing read')
    out = {'series': {}, 'axes': {}, 'frames': {}}
    for (name, series), (top, bot, left, right) in zip(PANELS, panels):
        out['frames'][name] = [top, bot, left, right]
        if not series: continue
        ax = dir_axis(a, top, bot, left) if series[0][2] == 'dir' else fit_axis(y_axis(a, top, bot, left))
        if ax is None: out['axes'][name] = 'NEČITLJIVO'; continue
        out['axes'][name] = [round(ax[0], 4), round(ax[1], 6)]
        if name == 'temp':   # relative humidity: black line on the right axis
            axr = fit_axis(y_axis_right(a, top, bot, right))
            if axr:
                ys = curve(a, top, bot, left, right, (0, 0, 0), tol=60)
                out['series']['rh'] = [None if y is None else round(val(axr, y), 1) for y in ys]
        for key, rgb, kind in series:
            col = series_colour(a, top, bot, left, right, rgb)
            if col is None: continue   # this buoy has no such sensor (empty panel)
            ys = curve(a, top, bot, left, right, col, tol=60, dots=(kind == 'dir'))
            out['series'][key] = [None if y is None else round(val(ax, y) % 360 if kind == 'dir' else val(ax, y), 3) for y in ys]
    return out

if __name__ == '__main__':
    r = read(sys.argv[1])
    for k, v in r['series'].items():
        good = [x for x in v if x is not None]
        print(k, len(good), 'zadnje', [x for x in v if x is not None][-3:] if good else '-')
    print(json.dumps(r['axes']))

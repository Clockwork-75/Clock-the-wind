"""Diagnostic: formats of DHMZ sea temperature (more_n.xml) and the IZOR station portal."""
import urllib.request, re, os
UA = {'User-Agent': 'Mozilla/5.0 (ClockTheWind sailing app)'}
os.makedirs('shots/p3', exist_ok=True)
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30) as r: return r.status, r.read(), dict(r.headers)
    except Exception as e: return str(e), b'', {}
for name, u in (('more_n.xml', 'https://vrijeme.hr/more_n.xml'), ('izor-postaje.html', 'http://faust.izor.hr/autodatapub/postaje'),
                ('izor-root.html', 'http://faust.izor.hr/autodatapub/'), ('hrvatska_n.xml', 'https://vrijeme.hr/hrvatska_n.xml')):
    s, b, h = get(u)
    print('=====', name, s, len(b), h.get('Content-Type'), h.get('Last-Modified'))
    open('shots/p3/' + name, 'wb').write(b)
    t = b.decode('utf-8', 'replace')
    print(t[:2500])
    if 'izor' in name:
        links = sorted(set(re.findall(r'href="([^"]+)"', t)))
        print('LINKS', links[:80])
        for l in links[:6]:
            if l.startswith('#') or l.startswith('mailto'): continue
            u2 = l if l.startswith('http') else 'http://faust.izor.hr' + (l if l.startswith('/') else '/autodatapub/' + l)
            s2, b2, h2 = get(u2); print('--', u2, s2, len(b2), h2.get('Content-Type')); print(b2.decode('utf-8', 'replace')[:1500])
            open('shots/p3/izor-' + re.sub(r'[^A-Za-z0-9]+', '_', l)[:60] + '.html', 'wb').write(b2)

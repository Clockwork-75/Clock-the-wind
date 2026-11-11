"""Diagnostic: IZOR real-time stations (faust.izor.hr/autodatapub) – the JSON behind each station page."""
import urllib.request, os
UA = {'User-Agent': 'Mozilla/5.0 (ClockTheWind sailing app)'}
os.makedirs('shots/p4', exist_ok=True)
for pid in (1, 3, 5, 7, 8, 9, 14):
    u = f'http://faust.izor.hr/autodatapub/postaja_json_r?p_pos_id={pid}&jezik=&p_grupa='
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30) as r: b = r.read(); print('=====', pid, r.status, len(b), r.headers.get('Content-Type'))
    except Exception as e: print('=====', pid, e); continue
    open(f'shots/p4/izor-{pid}.json', 'wb').write(b)
    print(b.decode('utf-8', 'replace')[:1800])

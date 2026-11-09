// Clock the Wind service worker: app shell offline + cache-as-you-go map tiles.
const SHELL = 'ctw-shell-v51';
const TILES = 'ctw-tiles-v2';   // v2: old cache may hold CARTO "API key required" tiles
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/polar.js', 'js/sails.js', 'js/geo.js', 'js/landmask.js', 'js/field.js', 'js/forecast.js',
  'js/db.js', 'js/layers.js', 'js/courses.js', 'js/router.js', 'js/router.worker.js', 'js/grib.worker.js', 'js/bathy.js', 'js/grib.js', 'js/intro.js', 'js/direct.js', 'js/ensemble.js', 'js/boatdata.js', 'img/clockwork-logo.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'data/landmask.bin', 'data/coast.json', 'data/world.json', 'data/depth.bin.gz', 'data/polar_melges40.csv',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith('ctw-shell') && k !== SHELL) || (k.startsWith('ctw-tiles') && k !== TILES)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const isTile = u => /basemaps\.cartocdn\.com|arcgisonline\.com|openseamap\.org|emodnet-bathymetry\.eu\/wms/.test(u);
const isApi = u => /open-meteo\.com|meteomatics\.com/.test(u);
self.addEventListener('fetch', e => {
  const url = e.request.url;
  // forecasts are kept in IndexedDB by the app – never in the cache (each cloud package is ~11 MB; caching every
  // download under its own ?t= address filled the phone's storage and then new forecasts could not be saved)
  if (e.request.method !== 'GET' || isApi(url) || url.includes('/proxy') || /\.ctw(\?|$)|\.grib2?(\?|$)|[?&]t=\d/.test(url)) return;
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(url);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(url, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // app shell: network first (fresh updates when online), fallback to cache
  // 'no-cache' = always ask the server whether the file changed (a cheap check), so a new version shows on the next start
  // instead of after the browser's 10-minute cache
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && new URL(url).origin === location.origin) caches.open(SHELL).then(c => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

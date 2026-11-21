/* WeFo service worker – only keeps what the DSO Explorer needs offline: the catalogue files and every DSS2 photo that
   has been opened. Everything else (API calls, pages, maps) goes straight to the network as before. */
const CACHE = 'wefo-dso-v1';
const MAX_PHOTOS = 400;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isData = url.origin === self.location.origin && /\/assets\/[^/]+\.json$/.test(url.pathname);
  const isPhoto = url.hostname === 'alasky.cds.unistra.fr' && url.pathname.includes('hips2fits');
  if (!isData && !isPhoto) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (isPhoto) {                                   // cache first: a photo of a given object never changes
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone());
        const keys = await cache.keys();
        const photos = keys.filter((k) => k.url.includes('hips2fits'));
        if (photos.length > MAX_PHOTOS) await cache.delete(photos[0]);
      }
      return res;
    }
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);   // data: network first, cache when offline
    return (await net) || hit || new Response('', { status: 504 });
  })());
});

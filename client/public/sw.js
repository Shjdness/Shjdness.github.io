const CACHE_VERSION = 'v2';
const STATIC_CACHE = `shjdness-static-${CACHE_VERSION}`;
const PAGE_CACHE = `shjdness-pages-${CACHE_VERSION}`;
const FIXED_ASSETS = [
  '/', '/index.html', '/manifest.webmanifest', '/favicon.png', '/avatar.jpg', '/guest-avatar.jpg',
  '/background-home-v2.jpg', '/background-inner.jpg', '/life-guide.json',
  '/cantarell_5.0.12_latin-400-normal.woff2', '/cantarell_5.0.13_latin-400-normal.woff',
];

const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function discoverBuildAssets() {
  const response = await fetch('/index.html', { cache: 'no-store' });
  if (!response.ok) return [];
  const html = await response.text();
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const discovered = await discoverBuildAssets().catch(() => []);
    await Promise.allSettled([...new Set([...FIXED_ASSETS, ...discovered])].map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const current = new Set([STATIC_CACHE, PAGE_CACHE]);
    await Promise.all((await caches.keys()).filter(key => !current.has(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(timeout(fetch(request), 3000).then(async response => {
      if (response.ok) (await caches.open(PAGE_CACHE)).put('/', response.clone());
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match('/')) || (await caches.match('/index.html'))));
    return;
  }

  if (url.pathname === '/life-guide.json') {
    event.respondWith(caches.match(request).then(cached => {
      const refresh = fetch(request).then(async response => { if (response.ok) (await caches.open(STATIC_CACHE)).put(request, response.clone()); return response; });
      if (cached) { event.waitUntil(refresh.catch(() => undefined)); return cached; }
      return refresh;
    }));
    return;
  }

  if (/\.(?:js|css|woff2?|png|jpe?g|webp|avif|svg)$/i.test(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(async response => { if (response.ok) (await caches.open(STATIC_CACHE)).put(request, response.clone()); return response; })));
  }
});

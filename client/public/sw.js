const CACHE_NAME = 'shjdshy-local-first-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.png', '/avatar.jpg', '/life-guide.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(url)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(timeout(fetch(request), 3000).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match('/')) || (await caches.match('/index.html'))));
    return;
  }

  event.respondWith(caches.match(request).then(cached => {
    const refresh = fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    });
    return cached || refresh;
  }));
});

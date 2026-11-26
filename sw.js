const CACHE_NAME = 'falacloze-v25-09dd503b';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app/falacloze-v2.5.html',
  './app/css/theme.css',
  './app/css/views.css',
  './app/js/state.js',
  './app/js/fsrs.js',
  './app/js/storage.js',
  './app/js/grading.js',
  './app/js/tts.js',
  './app/js/views/home.js',
  './app/js/views/session.js',
  './app/js/views/dictionary.js',
  './app/js/main.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('falacloze-') && k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  const lowerPath = url.pathname.toLowerCase();

  // 1. manifest.json: strictly network-first (fallback to cache only when offline)
  if (lowerPath.endsWith('/manifest.json') || lowerPath === 'manifest.json') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(res => {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, cp)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // 2. Modular app HTML/CSS/JS and root shell: strictly network-first (even with ?v= query)
  if (
    lowerPath === '/' ||
    lowerPath.endsWith('/') ||
    lowerPath.endsWith('/index.html') ||
    (lowerPath.includes('/app/') && (lowerPath.endsWith('.html') || lowerPath.endsWith('.css') || lowerPath.endsWith('.js')))
  ) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE_NAME).then(cache =>
            cache.keys().then(keys =>
              Promise.all(keys.map(k => {
                try {
                  const ku = new URL(k.url);
                  if (ku.pathname === url.pathname && k.url !== e.request.url) return cache.delete(k);
                } catch (_) {}
                return null;
              }))
            ).then(() => cache.put(e.request, cp))
          ).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match(e.request, { ignoreSearch: true })))
    );
    return;
  }

  // 3. Versioned ?v=<hash> data assets: cache-first by exact versioned URL, evicting stale ?v= entries for same pathname
  if (url.searchParams.has('v')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res && res.ok) {
              const cp = res.clone();
              cache.keys().then(keys =>
                Promise.all(keys.map(k => {
                  try {
                    const ku = new URL(k.url);
                    if (ku.pathname === url.pathname && k.url !== e.request.url) return cache.delete(k);
                  } catch (_) {}
                  return null;
                }))
              ).then(() => cache.put(e.request, cp)).catch(() => {});
            }
            return res;
          });
        })
      )
    );
    return;
  }

  // 4. Other GET requests: cache-first with background refresh
  e.respondWith(caches.match(e.request).then(cached => {
    const net = fetch(e.request).then(res => {
      if (res && res.ok) {
        const cp = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, cp)).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});

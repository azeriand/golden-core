/* golden-core service worker
 *
 * Offline-first PWA support. Strategies:
 *   - Navigations (HTML): network-first, fall back to the cached app shell so
 *     the SPA opens offline and can render from cached data.
 *   - Next static assets (/_next/static, /_next/image?...): stale-while-
 *     revalidate — instant from cache, refreshed in the background.
 *   - Vercel Blob media (images/videos): cache-first + background revalidate in
 *     a dedicated media cache, so already-retrieved media is available offline
 *     and served instantly.
 *   - Event data (GET /api/event/<slug>): stale-while-revalidate in a data
 *     cache, so the gallery renders offline from the last response and updates
 *     when the network returns.
 *   - Everything else under /api (auth, uploads handshake/confirm, likes, ...):
 *     network-only. These simply fail when offline (by design). Upload intent is
 *     queued client-side in IndexedDB and resumed on reconnect/reload.
 *
 * A `PURGE_CACHES` message (sent by the client on auth invalidation) clears the
 * data + media caches so a logged-out/invalid session cannot see cached private
 * media.
 */

const VERSION = 'v1';
const SHELL_CACHE = `gc-shell-${VERSION}`;
const STATIC_CACHE = `gc-static-${VERSION}`;
const MEDIA_CACHE = `gc-media-${VERSION}`;
const DATA_CACHE = `gc-data-${VERSION}`;

// Minimal shell precache. The root document is the SPA entry; Next serves the
// same client bundle for every route, so caching "/" is enough to boot offline.
const SHELL_URLS = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              k.startsWith('gc-') &&
              ![SHELL_CACHE, STATIC_CACHE, MEDIA_CACHE, DATA_CACHE].includes(k)
          )
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Client -> SW messages. PURGE_CACHES clears private data + media on auth
// invalidation (logout / 401 / 403). SKIP_WAITING lets the client activate a
// newly installed SW immediately.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PURGE_CACHES') {
    event.waitUntil(
      Promise.all([caches.delete(DATA_CACHE), caches.delete(MEDIA_CACHE)])
    );
  } else if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isBlobMedia(url) {
  return url.hostname.endsWith('.public.blob.vercel-storage.com');
}

function isNextStatic(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/_next/static') ||
      url.pathname.startsWith('/_next/image'))
  );
}

function isEventDataRequest(url) {
  // GET /api/event/<slug>  (the gallery payload) — NOT the media sub-routes
  // (upload-token/confirm/likes/download), which must stay network-only.
  if (url.origin !== self.location.origin) return false;
  return /^\/api\/event\/[^/]+$/.test(url.pathname);
}

// Cache-first with background revalidation. Serves cached instantly (offline
// too) and refreshes the cache when online. Never rejects for the caller.
async function cacheFirstRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchAndUpdate = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Kick off revalidation but return the cached copy immediately.
    fetchAndUpdate;
    return cached;
  }
  const network = await fetchAndUpdate;
  if (network) return network;
  // Offline and nothing cached.
  return new Response('', { status: 504, statusText: 'Offline' });
}

// Stale-while-revalidate: return cache immediately if present, always refresh in
// the background; fall back to network when nothing is cached.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const network = await networkPromise;
  if (network) return network;
  return new Response('', { status: 504, statusText: 'Offline' });
}

// Network-first for navigations: fresh HTML when online, cached shell offline.
async function navigationHandler(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put('/', response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = (await cache.match(request)) || (await cache.match('/'));
    if (cached) return cached;
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let the browser do POST/PUT/DELETE normally (uploads,
  // likes, auth) — these are network-only by design.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // App shell navigations.
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Vercel Blob media (cross-origin images/videos) — cache-first + revalidate.
  if (isBlobMedia(url)) {
    event.respondWith(cacheFirstRevalidate(request, MEDIA_CACHE));
    return;
  }

  // Next static assets — stale-while-revalidate.
  if (isNextStatic(url)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // Event gallery data — stale-while-revalidate so it works offline.
  if (isEventDataRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Everything else (other same-origin GETs, other APIs): pass through to the
  // network. If offline, the request fails as normal — intentional.
});

// Terminal Sessions Web GUI - service worker
//
// Only registered from a secure context (https or localhost); see app.js. Over
// plain http on a VPN address it never runs, and the GUI does not depend on it.
// It keeps a copy of the app shell so an installed app still opens (and shows
// "Disconnected") when the server is unreachable. Network first, so a server
// upgrade is picked up on the next load; the cache is only a fallback.

const CACHE = 'terminal-sessions-shell-v1';

const SHELL = [
  '/',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

// Third-party scripts/styles loaded by index.html (opaque responses, cached as-is)
const VENDOR = [
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css',
  'https://cdn.socket.io/4.7.2/socket.io.min.js',
  'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js',
  'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js',
  'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(
        // Vendor fetches may fail offline/behind a proxy; don't fail the install over them
        SHELL.map(url => cache.add(url)).concat(VENDOR.map(url => cache.add(url).catch(() => {})))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Ignore the query (?token=...) so every start URL maps to the same cached shell
  const key = url.origin === self.location.origin ? url.origin + url.pathname : url.href;
  const cacheable = url.origin === self.location.origin
    ? SHELL.includes(url.pathname)
    : VENDOR.includes(url.href);
  if (!cacheable) return;  // API, socket.io and everything else go straight to the network

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok || response.type === 'opaque') {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)));
        }
        return response;
      })
      .catch(() => caches.match(key).then(cached => cached || Response.error()))
  );
});

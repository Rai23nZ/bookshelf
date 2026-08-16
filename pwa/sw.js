// Service worker for the Bookshelf PWA.
//
// The app ships as ONE self-contained file: index.html carries the runtime,
// the design-system CSS, the fonts, React and the book catalogue as inlined
// base64 payloads, and mints blob: URLs for them at load time. So the whole
// precache is that file plus the icons and the manifest — there are no chunks
// to enumerate and nothing else to keep in step with a build.
const CACHE = 'bookshelf-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Must match the tag registered by the support layer in src/support.js.
const SYNC_TAG = 'bookshelf-outbox';

const DB_NAME = 'BookshelfLocalDB';
const DB_VERSION = 2;
const OUTBOX_ID = 'shelf';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Cloud sync is cross-origin (a workers.dev Worker), so it never reaches the
  // branches below — but be explicit: a cached sync response would pin the
  // first shelf forever and make Download keep restoring stale data.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isHtml = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    // Network-first for the app shell so a new deploy reaches visitors on
    // their next load instead of being stuck behind the old cached copy;
    // cache is the fallback for when they're offline.
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for static assets, and deliberately WITHOUT an index.html
  // fallback: handing HTML to something that asked for a PNG or a script just
  // turns a clean 404 into a confusing parse error.
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => new Response('', { status: 503, statusText: 'Offline' })))
  );
});

// ── Background Sync: retry a queued shelf upload ────────────────────────────
// The page parks one snapshot in IndexedDB when an upload fails, then asks for
// this tag. Chrome fires it once connectivity is back, whether or not a tab is
// still open. Throwing keeps the registration alive so the browser retries.
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) e.waitUntil(flushOutbox());
});

function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    // The worker can reach the database before a v2-aware page has run, so it
    // has to be able to perform the upgrade itself.
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

function idbGetPending(db) {
  return new Promise((resolve, reject) => {
    const rq = db.transaction('outbox').objectStore('outbox').get(OUTBOX_ID);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}

function idbClearPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(OUTBOX_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function flushOutbox() {
  const db = await openDB();
  const rec = await idbGetPending(db);
  if (!rec || !rec.url || !rec.code) return;

  const res = await fetch(rec.url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sync-code': rec.code },
    body: JSON.stringify(rec.snapshot)
  });
  // Reject so the browser schedules another attempt; the record stays put.
  if (!res.ok) throw new Error('sync upload failed: ' + res.status);

  await idbClearPending(db);

  // Tell any open tab, so a status line still reading "queued" catches up.
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'outbox-flushed' }));
}

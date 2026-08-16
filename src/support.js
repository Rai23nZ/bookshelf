    // Offline cover cache: fetches book cover images as bytes (in a
    // background Worker, off the main thread) and stores them in IndexedDB,
    // so covers already seen once keep rendering with no network at all —
    // unlike caching just the URL, which still needs to be re-fetched live
    // every time. Wired into the app in the BookApp component below via
    // window.fetchImageBlob / window.bookshelfDB / window.memoryManager.
    //
    // The worker also keeps its original job type (decoding a base64,
    // optionally gzip-compressed, payload) since that was already correct —
    // only unused. Both job types share one long-lived worker rather than
    // spinning up a new one per call, routed by a uuid per request; the
    // original two wrapper functions each created a fresh Worker (and never
    // used the uuid the message format already carried for exactly this).
    const workerScriptText = `
      self.onmessage = async (e) => {
        const { uuid, base64Data, compressed, mime, url } = e.data;
        try {
          let resultBytes, resultType = mime;

          if (url) {
            // Fetch-and-cache path: download a remote image so its bytes
            // can be stored in IndexedDB and shown with no network round
            // trip next time.
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            resultBytes = new Uint8Array(await res.arrayBuffer());
            resultType = res.headers.get('content-type') || mime || 'image/jpeg';
          } else {
            // Decode path: a base64 string, optionally gzip-compressed.
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            resultBytes = bytes;
            if (compressed && typeof DecompressionStream !== 'undefined') {
              const ds = new DecompressionStream('gzip');
              const writer = ds.writable.getWriter();
              writer.write(bytes);
              writer.close();
              resultBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
            }
          }

          self.postMessage({ uuid, bytes: resultBytes, mime: resultType, success: true }, [resultBytes.buffer]);
        } catch (error) {
          self.postMessage({ uuid, error: error.message, success: false });
        }
      };
    `;

    // ==========================================
    // Memory manager — tracks blob: URLs so they can be explicitly revoked
    // instead of leaking for the life of the page.
    // ==========================================
    class MemoryManager {
      constructor() {
        this.activeUrls = new Set();
      }
      createUrl(blob) {
        const url = URL.createObjectURL(blob);
        this.activeUrls.add(url);
        return url;
      }
      revokeUrl(url) {
        if (this.activeUrls.has(url)) {
          URL.revokeObjectURL(url);
          this.activeUrls.delete(url);
        }
      }
      clearAll() {
        this.activeUrls.forEach((url) => URL.revokeObjectURL(url));
        this.activeUrls.clear();
      }
    }
    window.memoryManager = new MemoryManager();

    const _bgWorker = new Worker(URL.createObjectURL(new Blob([workerScriptText], { type: 'application/javascript' })));
    const _bgPending = new Map();
    _bgWorker.onmessage = (e) => {
      const { uuid, success, bytes, mime, error } = e.data;
      const p = _bgPending.get(uuid);
      if (!p) return;
      _bgPending.delete(uuid);
      if (success) p.resolve(new Blob([bytes], { type: mime }));
      else p.reject(new Error(error || 'worker reported failure'));
    };
    _bgWorker.onerror = (e) => {
      // A crash in the worker script itself, not a per-job failure (those
      // come back as {success:false} above) — without this, every promise
      // still waiting would simply hang forever.
      for (const [, p] of _bgPending) p.reject(new Error(e.message || 'worker crashed'));
      _bgPending.clear();
    };

    function unpackModule(moduleData) {
      return new Promise((resolve, reject) => {
        const uuid = (Date.now().toString(36)) + '-' + Math.random().toString(36).slice(2);
        _bgPending.set(uuid, { resolve, reject });
        _bgWorker.postMessage({ ...moduleData, uuid });
      });
    }
    window.unpackModule = unpackModule;

    // Fetch a remote image in the background worker; resolves to a Blob.
    function fetchImageBlob(url) {
      return unpackModule({ url });
    }
    window.fetchImageBlob = fetchImageBlob;

    // ==========================================
    // Local cover cache (IndexedDB) — deliberately scoped to just the cover
    // image bytes, keyed by book id. Everything else about a book (title,
    // rating, shelf, notes, reading progress) already lives in
    // localStorage via the app's own save/load — duplicating it here would
    // just be a second, driftable source of truth for no benefit.
    //
    // The same database also carries the sync outbox (store 'outbox', added
    // in version 2). It lives here rather than in localStorage because the
    // service worker has to read it to retry a queued upload after the page
    // is gone, and a worker cannot touch localStorage.
    // ==========================================
    const OUTBOX_ID = 'shelf';

    class BookshelfDB {
      constructor() {
        this.dbName = 'BookshelfLocalDB';
        this.dbVersion = 2;
        this.db = null;
        this._ready = null;
      }

      init() {
        if (this._ready) return this._ready;
        this._ready = new Promise((resolve, reject) => {
          const request = indexedDB.open(this.dbName, this.dbVersion);
          request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Runs for a fresh database and for the v1 -> v2 upgrade alike;
            // existing cover bytes are left untouched either way.
            if (!db.objectStoreNames.contains('covers')) {
              db.createObjectStore('covers', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('outbox')) {
              db.createObjectStore('outbox', { keyPath: 'id' });
            }
          };
          request.onsuccess = (event) => { this.db = event.target.result; resolve(this); };
          request.onerror = (event) => reject(event.target.error);
        });
        return this._ready;
      }

      async saveCover(id, blob) {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['covers'], 'readwrite');
          tx.objectStore('covers').put({ id, coverBlob: blob, updatedAt: Date.now() });
          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);
        });
      }

      async getAllCovers() {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['covers'], 'readonly');
          const req = tx.objectStore('covers').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = (e) => reject(e.target.error);
        });
      }

      async deleteCover(id) {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['covers'], 'readwrite');
          tx.objectStore('covers').delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);
        });
      }

      // ── outbox ──
      // Keyed by a fixed id: see SyncOutbox below for why there is only ever
      // one record.
      async getPending() {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['outbox'], 'readonly');
          const req = tx.objectStore('outbox').get(OUTBOX_ID);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = (e) => reject(e.target.error);
        });
      }

      async putPending(record) {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['outbox'], 'readwrite');
          tx.objectStore('outbox').put({ ...record, id: OUTBOX_ID });
          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);
        });
      }

      async clearPending() {
        await this.init();
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(['outbox'], 'readwrite');
          tx.objectStore('outbox').delete(OUTBOX_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = (e) => reject(e.target.error);
        });
      }
    }

    window.bookshelfDB = new BookshelfDB();
    window.bookshelfDB.init().catch(() => { /* IndexedDB unavailable (e.g. private browsing) — offline cover cache is best-effort */ });

    // ==========================================
    // Cloud sync outbox
    //
    // The cloud payload is a whole-shelf snapshot with last-write-wins
    // semantics, not a stream of edits. So a queue of pending operations
    // would be wrong as well as pointless: replaying five stale snapshots in
    // order just uploads four shelves nobody wants, and the fifth is the only
    // one that survives. The outbox therefore holds exactly ONE record — the
    // most recent snapshot — under a fixed key, and a newer one overwrites it.
    //
    // Uploading stays a deliberate act: the user presses Upload, as before.
    // What changes is that a press which fails (offline, worker down, KV not
    // bound yet) is no longer dropped on the floor with a red message — the
    // snapshot is parked here and re-sent on the next 'online' event or
    // Background Sync wake-up. Nothing is ever pushed that the user did not
    // ask to push.
    // ==========================================
    const SYNC_URL_KEY = 'bookshelf.syncurl.v1';
    // Fallback only. The address is editable in Export -> Cloud sync, so a
    // rename of the Worker (or moving off workers.dev) needs no code change.
    const DEFAULT_SYNC_URL = 'https://bookshelf-sync.cloudflare-uncommon.workers.dev';

    class SyncOutbox {
      constructor(db) {
        this.db = db;
        this._listeners = new Set();
        this._flushing = false;
      }

      get url() {
        try { return (localStorage.getItem(SYNC_URL_KEY) || '').trim() || DEFAULT_SYNC_URL; }
        catch (e) { return DEFAULT_SYNC_URL; }
      }

      set url(value) {
        try {
          const v = (value || '').trim();
          if (v) localStorage.setItem(SYNC_URL_KEY, v);
          else localStorage.removeItem(SYNC_URL_KEY);
        } catch (e) { /* blocked */ }
        // Re-point anything already queued at the new address. A pending
        // record has to carry its own url (the service worker retries it and
        // cannot read localStorage), but the overwhelmingly likely reason the
        // user is editing this field is that the queue exists BECAUSE the
        // address was wrong — pinning the retry to the broken one would make
        // the fix do nothing.
        const next = this.url;
        this.db.getPending()
          .then(rec => { if (rec && rec.url !== next) return this.db.putPending({ ...rec, url: next }); })
          .catch(() => { /* nothing queued, or IndexedDB blocked */ });
      }

      get defaultUrl() { return DEFAULT_SYNC_URL; }

      // The UI subscribes so a background retry can update the status line
      // that the failed upload left behind.
      subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
      }

      _emit(status) {
        this._listeners.forEach((fn) => { try { fn(status); } catch (e) { /* a bad listener must not break the flush */ } });
      }

      async hasPending() {
        try { return !!(await this.db.getPending()); } catch (e) { return false; }
      }

      // One upload attempt. Throws on any non-2xx so callers can distinguish
      // "sent" from "queued".
      async _send(snapshot, code, url) {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-sync-code': code },
          body: JSON.stringify(snapshot)
        });
        if (!res.ok) throw new Error('server said ' + res.status);
        return res;
      }

      // Try now; park it for later if that fails. Resolves to a small result
      // object rather than throwing, because "queued" is a success from the
      // user's point of view — nothing was lost.
      async push(snapshot, code) {
        const url = this.url;
        if (navigator.onLine) {
          try {
            await this._send(snapshot, code, url);
            await this.db.clearPending().catch(() => {});
            return { sent: true };
          } catch (err) {
            await this._park(snapshot, code, url);
            return { sent: false, queued: true, error: err.message };
          }
        }
        await this._park(snapshot, code, url);
        return { sent: false, queued: true, offline: true };
      }

      async _park(snapshot, code, url) {
        try {
          await this.db.putPending({ snapshot, code, url, at: Date.now() });
        } catch (e) { /* IndexedDB blocked — the upload is simply lost, as before */ }
        this._registerBackgroundSync();
      }

      _registerBackgroundSync() {
        // Best-effort: absent on iOS Safari and Firefox, where the 'online'
        // listener below is the only retry path. Tag matches sw.js.
        if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
        navigator.serviceWorker.ready
          .then((reg) => reg.sync && reg.sync.register('bookshelf-outbox'))
          .catch(() => { /* registration refused — 'online' still covers it */ });
      }

      // Retry whatever is parked. Safe to call at any time; a no-op when the
      // outbox is empty or a flush is already running.
      async flush() {
        if (this._flushing || !navigator.onLine) return { skipped: true };
        this._flushing = true;
        try {
          const rec = await this.db.getPending();
          if (!rec) return { empty: true };
          await this._send(rec.snapshot, rec.code, rec.url || this.url);
          await this.db.clearPending();
          this._emit('Uploaded ' + new Date().toLocaleTimeString() + ' (queued while offline).');
          return { sent: true };
        } catch (err) {
          // Stays parked for the next attempt.
          return { sent: false, error: err.message };
        } finally {
          this._flushing = false;
        }
      }
    }

    window.bookshelfSync = new SyncOutbox(window.bookshelfDB);

    window.addEventListener('online', () => { window.bookshelfSync.flush(); });
    // A Background Sync wake-up flushes in the worker, which then tells any
    // open page so its status line stops claiming the upload failed.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'outbox-flushed') {
          window.bookshelfSync._emit('Uploaded ' + new Date().toLocaleTimeString() + ' (queued while offline).');
        }
      });
    }

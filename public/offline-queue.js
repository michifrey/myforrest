'use strict';

/*
 * Offline upload queue for MyForrest.
 *
 * Uploads that cannot reach the server (no connection, network error) are
 * parked in IndexedDB together with their photos, GPX track and form fields
 * and sent later – by the page (online event, app start, button) or by the
 * service worker (Background Sync). The same file is loaded in both
 * contexts: as a classic script in the page and via importScripts in sw.js.
 * It defines a single global, `offlineQueue`.
 */
(function (root) {
  const DB_NAME = 'myforrest-offline';
  const DB_VERSION = 1;
  const STORE = 'uploads';
  const SYNC_TAG = 'myforrest-uploads';
  const LOCK = 'myforrest-upload-queue';
  const ENDPOINT = 'api/photos';
  // HTTP statuses where trying again later can help; anything else is final.
  // 401/403: logged out or the session changed (CSRF token) – keep the upload until the user logs in again.
  const RETRY_STATUS = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('myforrest-queue') : null;
  const listeners = new Set();
  const emit = (msg) => {
    for (const fn of listeners) {
      try { fn(msg); } catch (err) { console.error(err); }
    }
  };
  const broadcast = (msg) => {
    emit(msg);
    try { channel?.postMessage(msg); } catch { /* summaries are plain data, but never let this break a flush */ }
  };
  if (channel) channel.onmessage = (e) => emit(e.data);

  /** Base URL the endpoint is resolved against (SW scope or the page's base). */
  function baseUrl() {
    return root.registration?.scope || root.document?.baseURI || root.location.href;
  }

  let dbPromise = null;
  function openDb() {
    if (!root.indexedDB) return Promise.reject(new Error('IndexedDB ist nicht verfügbar'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB ist blockiert')); };
      });
    }
    return dbPromise;
  }

  /** Runs `fn(store)` in a transaction and resolves with the result of the request it returns. */
  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaktion abgebrochen'));
    });
  }

  const isBlob = (v) => typeof Blob === 'function' && v instanceof Blob;

  /** FormData → storable record. Files become Blobs with their file name kept alongside. */
  function serialize(fd) {
    const entries = [];
    for (const [name, value] of fd.entries()) {
      if (isBlob(value)) {
        // Copy into a plain Blob: some browsers keep only a reference to the picked file.
        entries.push({ name, blob: value.slice(0, value.size, value.type), filename: value.name || 'foto.jpg' });
      } else {
        entries.push({ name, value: String(value) });
      }
    }
    return entries;
  }

  function deserialize(entries) {
    const fd = new FormData();
    for (const e of entries) {
      if (e.blob) fd.append(e.name, e.blob, e.filename);
      else fd.append(e.name, e.value);
    }
    return fd;
  }

  /**
   * Stores an upload. Adds `takenAt` (the time of queueing) so photos without
   * an EXIF date are not dated to the moment they finally reach the server.
   */
  async function add(fd) {
    const entries = serialize(fd);
    const now = new Date();
    if (!entries.some((e) => e.name === 'takenAt')) entries.push({ name: 'takenAt', value: now.toISOString() });
    const photos = entries.filter((e) => e.name === 'photos' && e.blob);
    const field = (n) => entries.find((e) => e.name === n && !e.blob)?.value || '';
    const item = {
      createdAt: now.getTime(),
      entries,
      photos: photos.map((e) => e.filename),
      bytes: entries.reduce((s, e) => s + (e.blob ? e.blob.size : 0), 0),
      gpx: entries.find((e) => e.name === 'gpx' && e.blob)?.filename || null,
      spotId: field('spotId') ? Number(field('spotId')) : null,
      note: field('note'),
      // The session's CSRF token (account.js), so the service worker can send it too.
      csrf: (typeof self !== 'undefined' && self.Account && self.Account.csrf) || null,
      attempts: 0,
      lastError: null,
      failed: null,
    };
    item.id = await withStore('readwrite', (s) => s.add(item));
    broadcast({ type: 'changed' });
    return item;
  }

  const list = () => withStore('readonly', (s) => s.getAll());
  const get = (id) => withStore('readonly', (s) => s.get(id));

  async function remove(id) {
    await withStore('readwrite', (s) => s.delete(id));
    broadcast({ type: 'changed' });
  }

  async function clear() {
    await withStore('readwrite', (s) => s.clear());
    broadcast({ type: 'changed' });
  }

  const put = (item) => withStore('readwrite', (s) => s.put(item));

  /** Photo counts: waiting to be sent, and permanently rejected by the server. */
  async function stats() {
    const items = await list();
    const count = (arr) => arr.reduce((n, i) => n + i.photos.length, 0);
    const pending = items.filter((i) => !i.failed);
    const failed = items.filter((i) => i.failed);
    return { items: items.length, pending: count(pending), failed: count(failed), pendingItems: pending.length };
  }

  /** Sends one stored upload. Returns 'sent' | 'failed' | 'retry' | 'offline'. */
  async function sendItem(item, summary) {
    let res;
    try {
      // In the page, account.js's fetch wrapper sets the current token; the service worker uses the stored one.
      const headers = item.csrf ? { 'X-CSRF-Token': item.csrf } : {};
      res = await fetch(new URL(ENDPOINT, baseUrl()), { method: 'POST', body: deserialize(item.entries), credentials: 'same-origin', headers });
    } catch (err) {
      item.lastError = 'Keine Verbindung';
      await put(item);
      return 'offline';
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok || res.status === 422) {
      // 422: the server understood the upload but could not place any photo.
      summary.created.push(...(body.created || []));
      summary.skipped.push(...(body.skipped || []));
      for (const s of body.spots || []) if (!summary.spots.includes(s)) summary.spots.push(s);
      await withStore('readwrite', (s) => s.delete(item.id));
      return 'sent';
    }
    item.attempts += 1;
    item.lastError = body.error || `HTTP ${res.status}`;
    if (!RETRY_STATUS.has(res.status)) item.failed = item.lastError;
    await put(item);
    if (item.failed) summary.failed.push({ id: item.id, photos: item.photos, reason: item.failed });
    return item.failed ? 'failed' : 'retry';
  }

  async function runFlush() {
    const summary = { sent: 0, created: [], skipped: [], spots: [], failed: [], offline: false, remaining: 0 };
    const tried = new Set();
    for (;;) {
      // Re-read the queue each round so uploads added meanwhile are picked up.
      const next = (await list()).find((i) => !i.failed && !tried.has(i.id));
      if (!next) break;
      tried.add(next.id);
      const outcome = await sendItem(next, summary);
      if (outcome === 'sent') summary.sent += 1;
      if (outcome === 'offline') { summary.offline = true; break; }
    }
    summary.remaining = (await stats()).pending;
    return summary;
  }

  let running = null;
  /**
   * Sends every queued upload in order. Only one flush runs at a time across
   * tabs and the service worker (Web Locks), so nothing is uploaded twice.
   * Resolves with a summary; `busy: true` when another context is already sending.
   */
  function flush() {
    if (running) return running;
    const locks = root.navigator?.locks;
    const exec = locks
      ? locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? runFlush() : { busy: true }))
      : runFlush();
    running = Promise.resolve(exec)
      .then((summary) => {
        if (!summary.busy) broadcast({ type: 'flushed', summary });
        return summary;
      })
      .finally(() => { running = null; });
    return running;
  }

  /** Asks the service worker to send the queue via Background Sync. Resolves true when registered. */
  async function requestSync() {
    try {
      const reg = await root.navigator?.serviceWorker?.ready;
      if (!reg?.sync) return false;
      await reg.sync.register(SYNC_TAG);
      return true;
    } catch {
      return false;
    }
  }

  // fetch() rejects with a TypeError when the network fails; HTTP errors from api() are plain Errors.
  const isNetworkError = (err) => err?.name === 'TypeError' || err?.name === 'NetworkError';

  /**
   * Sends an upload with `send()` (which should POST the FormData and resolve
   * with the server's JSON). Offline or on a network error the upload is
   * queued instead and the result says how many photos were parked.
   */
  async function post(fd, send) {
    const queue = async () => {
      const item = await add(fd);
      requestSync();
      return { created: [], skipped: [], spots: [], queued: item.photos.length };
    };
    if (root.navigator?.onLine === false) return queue();
    try {
      return await send();
    } catch (err) {
      if (isNetworkError(err)) return queue();
      throw err;
    }
  }

  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  root.offlineQueue = {
    SYNC_TAG, add, list, get, remove, clear, stats, flush, post, requestSync, subscribe, serialize, deserialize,
  };
})(typeof self !== 'undefined' ? self : globalThis);

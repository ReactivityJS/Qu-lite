/**
 * BLOBS - attachments (images, files) of any size up to `maxBytes`, as
 * ordinary records: chunked, encrypted, signed, padded, stored locally,
 * synced, mirrored, quota-checked and deletable like everything else - no
 * second storage path, no protocol change, nothing new for the blind mirror.
 *
 *   const ref = await qu.blobs.put(space, file, { name: 'a.jpg', type: 'image/jpeg' })
 *   await qu.write(space, 'chat', { text: 'look', file: ref })   // the app links it
 *   const bytes = await qu.blobs.get(space, ref)                 // waits for missing chunks
 *
 * Records under the path `_blob-<id>` (its own first segment = its own
 * shard, so a peer can fetch one blob without the rest of the space):
 *
 *   manifest  {v: 1, size, chunkSize, hashes, type?}   hashes = base64 of the
 *             SHA-256 of every chunk, concatenated
 *   chunk     {i, d}                                   d = base64 of chunk i
 *
 * All are log entries (never superseded). The blob id is content-addressed:
 * SHA-256 over size, chunk size and the chunk hashes. A reader accepts only
 * a manifest that hashes to the id it asked for and only chunks that match
 * their hash - a member writing junk under someone's blob path changes
 * nothing. Putting the same content twice into a space writes nothing new.
 * Chunks are hashed and read one by one (a `Blob`/`File` is sliced), so a
 * large file is never held twice in memory while it is written.
 *
 * Transfers are tracked: an upload until every chunk left the outbox (sync
 * acks), a download until every chunk arrived - `qu.blob.progress` /
 * `qu.blob.done`. Uploads survive a reload (`blobs/up/<sid>/<id>`). While a
 * transfer runs and a peer is connected, the screen is kept on (Screen Wake
 * Lock, re-acquired when the page becomes visible again; released while
 * offline, where it would only drain the battery) and leaving the page asks
 * first (`beforeunload`) - a phone that sleeps or a closed tab would stop
 * the sync.
 *
 * Needs `records()`; uses `sync()` (fetching, upload tracking).
 */
import * as crypto from './crypto.js';

const PREFIX = '_blob-';
const enc = new TextEncoder();

/**
 * @param {{chunkSize?: number, maxBytes?: number, keepAwake?: boolean, warnOnUnload?: boolean, wakeLock?: object|null}} [options]
 *   `chunkSize`: raw bytes per chunk record (64 KiB -> ~96 KiB envelopes, below a mirror's 256 KiB limit).
 *   `keepAwake`: hold a screen wake lock while transfers run. `warnOnUnload`: ask before leaving the page then.
 *   `wakeLock`: the WakeLock API to use (default `navigator.wakeLock`; tests inject one).
 */
export function blobs({ chunkSize = 64 * 1024, maxBytes = 64 * 1024 * 1024, keepAwake = true, warnOnUnload = true, wakeLock = globalThis.navigator?.wakeLock ?? null } = {}) {
  return (qu) => {
    if (!qu.records) throw new Error('blobs(): install records() first');
    if (qu.blobs) return qu.blobs;
    const { bus, storage } = qu;
    const records = qu.records;
    /** @type {Map<string, {sid: string, blob: string, ids: Set<string>, total: number}>} `${sid}/${blob}` -> upload */
    const uploads = new Map();
    /** @type {Map<string, {sid: string, blob: string, done: number, total: number}>} downloads in progress */
    const downloads = new Map();

    const pathOf = (blob) => `${PREFIX}${blob}`;
    const idOf = (ref) => (typeof ref === 'string' ? ref : ref?.blob);
    const sidOf = (spaceRef) => records.spaceOf(spaceRef).id;

    async function blobId(size, chunk, hashes) {
      const head = enc.encode(`qu-lite/blob\n${size}\n${chunk}\n`);
      return crypto.toHex((await crypto.sha256(crypto.concat(head, hashes))).slice(0, 16));
    }

    /** Chunk i of the input, as bytes (a Blob is sliced and read on demand). */
    async function chunkOf(data, i, size) {
      const start = i * chunkSize;
      const end = Math.min(size, start + chunkSize);
      if (data instanceof Uint8Array) return data.subarray(start, end);
      return new Uint8Array(await data.slice(start, end).arrayBuffer());
    }

    // --- keeping the device awake while transfers run ---------------------
    let lock = null;
    let requesting = false;
    let connected = 0;
    const busy = () => uploads.size + downloads.size > 0 && connected > 0;
    bus.on('net.peer.up', () => {
      connected++;
      holdAwake();
    });
    bus.on('net.peer.down', () => {
      connected = Math.max(0, connected - 1);
      holdAwake();
    });
    async function holdAwake() {
      if (!keepAwake || !wakeLock) return;
      if (busy() && !lock && !requesting && globalThis.document?.visibilityState !== 'hidden') {
        requesting = true;
        try {
          lock = await wakeLock.request('screen');
          lock.addEventListener?.('release', () => (lock = null));
          if (!busy()) await release();
        } catch {
          lock = null; // denied (battery saver, not visible): the sync still runs while the page is open
        } finally {
          requesting = false;
        }
      } else if (!busy() && lock) await release();
    }
    async function release() {
      const held = lock;
      lock = null;
      await held?.release?.().catch(() => {});
    }
    // the system drops the lock when the page is hidden; take it again on return
    globalThis.document?.addEventListener?.('visibilitychange', () => holdAwake());
    if (warnOnUnload) {
      globalThis.addEventListener?.('beforeunload', (event) => {
        if (!uploads.size) return; // unfinished uploads, connected or not: they only live on this device
        event.preventDefault();
        event.returnValue = '';
      });
    }

    // --- upload tracking -------------------------------------------------------
    const upKey = (sid, blob) => `blobs/up/${sid}/${blob}`;
    async function progressUp(up) {
      const done = up.total - up.ids.size;
      await bus.notify('qu.blob.progress', { space: up.sid, blob: up.blob, direction: 'up', done, total: up.total });
      if (up.ids.size) return;
      uploads.delete(`${up.sid}/${up.blob}`);
      await storage.remove(upKey(up.sid, up.blob));
      await holdAwake();
      await bus.notify('qu.blob.done', { space: up.sid, blob: up.blob, direction: 'up' });
    }
    /** Starts tracking record ids until they left the outbox. */
    async function track(sid, blob, ids) {
      if (typeof qu.syncState !== 'function' || !ids.length) return;
      const up = { sid, blob, ids: new Set(), total: ids.length };
      for (const id of ids) if ((await qu.syncState(sid, id)) === 'pending') up.ids.add(id);
      uploads.set(`${sid}/${blob}`, up);
      await storage.set(upKey(sid, blob), { ids });
      await holdAwake();
      await progressUp(up);
    }
    bus.on('qu.record.acked', async ({ sid, id }) => {
      for (const up of uploads.values()) {
        if (up.sid !== sid || !up.ids.has(id) || (await qu.syncState(sid, id)) !== 'sent') continue;
        up.ids.delete(id);
        await progressUp(up);
      }
    });
    // uploads that were still running when the page closed
    const restored = (async () => {
      for (const key of await storage.keys('blobs/up/')) {
        const [, , sid, blob] = key.split('/');
        const kept = await storage.get(key);
        if (Array.isArray(kept?.ids)) await track(sid, blob, kept.ids);
      }
    })();

    // --- reading -----------------------------------------------------------------
    /**
     * Collects what this peer holds of a blob: the verified manifest and the
     * verified chunks, from records of its path.
     */
    function collector(blob) {
      const state = { manifest: null, hashes: null, chunks: new Map(), candidates: [] };
      async function verifyManifest(value) {
        if (state.manifest || value?.v !== 1 || typeof value.hashes !== 'string') return;
        // Anyone in the space can write a manifest that hashes to ITS id - so it must also be
        // self-consistent and within maxBytes before a reader allocates or trusts anything.
        const { size, chunkSize: chunk } = value;
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || !Number.isSafeInteger(chunk) || chunk <= 0 || chunk > maxBytes) return;
        const hashes = crypto.fromBase64(value.hashes);
        if (hashes.length !== Math.ceil(size / chunk) * 32) return;
        if ((await blobId(size, chunk, hashes)) !== blob) return;
        state.manifest = value;
        state.hashes = hashes;
        const waiting = state.candidates;
        state.candidates = [];
        for (const c of waiting) await addChunk(c);
      }
      async function addChunk(value) {
        if (!Number.isInteger(value?.i) || typeof value.d !== 'string' || state.chunks.has(value.i)) return;
        if (!state.manifest) return void state.candidates.push(value);
        const { size, chunkSize: chunk } = state.manifest;
        if (value.i < 0 || value.i >= state.hashes.length / 32) return;
        const bytes = crypto.fromBase64(value.d);
        if (bytes.length !== Math.min(chunk, size - value.i * chunk)) return; // exactly its slice, so bytes() fits
        const want = state.hashes.subarray(value.i * 32, value.i * 32 + 32);
        if (crypto.toHex(await crypto.sha256(bytes)) !== crypto.toHex(want)) return; // junk under the path
        state.chunks.set(value.i, bytes);
      }
      return {
        state,
        async add(record) {
          if ('hashes' in (record.value ?? {})) await verifyManifest(record.value);
          else await addChunk(record.value);
        },
        get total() {
          return state.manifest ? state.hashes.length / 32 : null;
        },
        get complete() {
          return state.manifest !== null && state.chunks.size === state.hashes.length / 32;
        },
        bytes() {
          const out = new Uint8Array(state.manifest.size);
          for (const [i, chunk] of state.chunks) out.set(chunk, i * state.manifest.chunkSize);
          return out;
        },
      };
    }

    async function collect(space, blob) {
      const c = collector(blob);
      for (const record of await qu.query({ space, path: pathOf(blob) })) await c.add(record);
      return c;
    }

    // --- API ---------------------------------------------------------------------
    /**
     * Stores a blob in a space: chunked into records (manifest first), synced
     * like any record. Content-addressed: the same bytes give the same ref,
     * and chunks a peer already holds are not written again.
     * @param {import('./space.js').Space|string} spaceRef
     * @param {Uint8Array|ArrayBuffer|Blob} input
     * @param {{type?: string, name?: string}} [meta] - `name` stays in the ref only (the app's record)
     * @returns {Promise<{blob: string, size: number, chunks: number, type?: string, name?: string}>}
     */
    async function put(spaceRef, input, { type, name } = {}) {
      const space = records.spaceOf(spaceRef);
      const data = input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input;
      if (!(data instanceof Uint8Array) && typeof data?.slice !== 'function') throw new TypeError('blobs.put: Uint8Array, ArrayBuffer or Blob expected');
      const size = data instanceof Uint8Array ? data.length : data.size;
      if (size > maxBytes) throw new Error(`blobs: ${size} bytes exceed maxBytes (${maxBytes})`);
      type = type ?? (data.type || undefined);
      const count = Math.ceil(size / chunkSize);
      const hashes = new Uint8Array(count * 32);
      for (let i = 0; i < count; i++) hashes.set(await crypto.sha256(await chunkOf(data, i, size)), i * 32);
      const blob = await blobId(size, chunkSize, hashes);
      const ref = { blob, size, chunks: count, ...(type ? { type } : {}), ...(name ? { name } : {}) };

      const held = await collect(space, blob);
      const written = [];
      if (!held.state.manifest) {
        const manifest = { v: 1, size, chunkSize, hashes: crypto.toBase64(hashes), ...(type ? { type } : {}) };
        written.push((await qu.write(space, pathOf(blob), manifest)).id);
      }
      for (let i = 0; i < count; i++) {
        if (held.state.chunks.has(i)) continue;
        written.push((await qu.write(space, pathOf(blob), { i, d: crypto.toBase64(await chunkOf(data, i, size)) })).id);
      }
      await track(space.id, blob, written);
      return ref;
    }

    /**
     * The blob's bytes. Missing chunks are fetched (its scope is watched) and
     * waited for; progress is reported as `qu.blob.progress {direction: 'down'}`.
     * @param {import('./space.js').Space|string} spaceRef
     * @param {object|string} ref - a ref from `put()` or a blob id
     * @param {{wait?: boolean, timeoutMs?: number}} [options] - `timeoutMs` 0: no limit
     * @returns {Promise<Uint8Array>}
     */
    async function get(spaceRef, ref, { wait = true, timeoutMs = 0 } = {}) {
      const space = records.spaceOf(spaceRef);
      const blob = idOf(ref);
      const c = await collect(space, blob);
      if (c.complete) return c.bytes();
      if (!wait) throw new Error(`blobs: ${blob} incomplete (${c.state.chunks.size}/${c.total ?? '?'} chunks)`);

      const key = `${space.id}/${blob}`;
      const down = { sid: space.id, blob, done: c.state.chunks.size, total: c.total };
      downloads.set(key, down);
      await holdAwake();
      let off = () => {};
      let unwatch = null;
      let timer = null;
      try {
        return await new Promise((resolve, reject) => {
          const check = async () => {
            if (c.state.chunks.size !== down.done || c.total !== down.total) {
              down.done = c.state.chunks.size;
              down.total = c.total;
              await bus.notify('qu.blob.progress', { space: space.id, blob, direction: 'down', done: down.done, total: down.total });
            }
            if (c.complete) resolve(c.bytes());
          };
          off = bus.on(`qu.record.${space.id}`, async (record) => {
            if (record.path !== pathOf(blob)) return;
            await c.add(record);
            await check();
          });
          if (timeoutMs > 0) {
            timer = setTimeout(() => reject(new Error(`blobs: ${blob} incomplete after ${timeoutMs} ms (${c.state.chunks.size}/${c.total ?? '?'} chunks)`)), timeoutMs);
          }
          // fetch exactly this blob's shard (and keep it live while waiting)
          if (typeof qu.watch === 'function') {
            qu.watch({ space, path: pathOf(blob) })
              .then(async (release) => {
                unwatch = release;
                // records that arrived between the first read and the subscription
                for (const record of await qu.query({ space, path: pathOf(blob) })) await c.add(record);
                await check();
              })
              .catch(() => {});
          }
        });
      } finally {
        off();
        clearTimeout(timer);
        unwatch?.();
        downloads.delete(key);
        await holdAwake();
        await bus.notify('qu.blob.done', { space: space.id, blob, direction: 'down' });
      }
    }

    /**
     * What this peer holds of a blob.
     * @returns {Promise<{have: number, total: number|null, complete: boolean}>}
     */
    async function has(spaceRef, ref) {
      const c = await collect(records.spaceOf(spaceRef), idOf(ref));
      return { have: c.state.chunks.size, total: c.total, complete: c.complete };
    }

    /**
     * Deletes a blob everywhere (drop lists, like `qu.del`): the records you
     * wrote - or, as owner/admin, all of them. Other members' copies of the
     * same content stay until they (or an admin) delete them.
     * @returns {Promise<number>} records listed for dropping
     */
    async function del(spaceRef, ref) {
      const space = records.spaceOf(spaceRef);
      const blob = idOf(ref);
      const targets = [];
      for (const record of await qu.query({ space, path: pathOf(blob) })) {
        const bytes = await storage.get(`rec/${space.id}/${record.id}`);
        if (bytes) targets.push({ id: record.id, path: record.path, ts: record.ts, author: record.author });
      }
      if (targets.length) await records.dropList(space, targets);
      const up = uploads.get(`${space.id}/${blob}`);
      if (up) {
        up.ids.clear();
        await progressUp(up);
      }
      return targets.length;
    }

    /** @returns {Array<{space: string, blob: string, direction: 'up'|'down', done: number, total: number|null}>} transfers running */
    const pending = () => [
      ...[...uploads.values()].map((u) => ({ space: u.sid, blob: u.blob, direction: 'up', done: u.total - u.ids.size, total: u.total })),
      ...[...downloads.values()].map((d) => ({ space: d.sid, blob: d.blob, direction: 'down', done: d.done, total: d.total })),
    ];

    const api = { put, get, has, del, pending, ready: restored, path: pathOf, get awake() { return lock !== null; } };
    qu.blobs = api;
    return api;
  };
}

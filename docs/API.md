# Qu Lite – API reference

This is the reference for the public API of `@qu/lite` 0.1. Runnable examples live in
[`examples/`](../examples/) and are executed by the test suite (`test/examples.test.js`), so
they always match this API. To learn why things work the way they do, read
[DECISIONS.md](DECISIONS.md). The README has one section per milestone.

- [Entry points](#entry-points)
- [Concepts in one minute](#concepts-in-one-minute)
- [Building a peer](#building-a-peer): `createQu`, `createPeer`, `Registry`, `nodeRegistry`
- [Kernel](#kernel): `qu.*` and the [Bus](#bus)
- [Storage](#storage): drivers, mounts, the driver contract
- [Space](#space)
- Plugins: [records](#records) · [sync](#sync) · [user](#user) · [inbox](#inbox) ·
  [members](#members) · [signals](#signals) · [status](#status) · [compaction](#compaction) ·
  [text](#text) · [blobs](#blobs) · [stats](#stats) · [mirror](#mirror) · [limits](#limits)
- [Transports](#transports): in-process, WebSocket, relay with SSE fallback, SSE, WebRTC, topology, server, `createLink`
- [Mirror CLI and Docker](#mirror-cli-and-docker)
- [Events](#events)
- [Low-level building blocks](#low-level-building-blocks): envelope, crypto, HLC, drop lists
- [Errors](#errors)

---

## Entry points

| Import | Environment | Contains |
|---|---|---|
| `@qu/lite` | browser + Node | everything below except the Node-only adapters |
| `@qu/lite/client` | browser + Node | small entry: `createClient`, `createPeer`, `defaultRegistry`, `createQu`, `Registry`, `Bus`, `Space`, `memoryDriver` - every named plugin/store/transport is loaded on demand |
| `@qu/lite/node` | Node | `createRelay`, `createClient`, `nodeRegistry`, `sqliteDriver`, `listenHttp`, `listenWs`, `httpServerTransport`, `wsServerTransport`, plus `createPeer`/`defaultRegistry` |
| `@qu/lite/devtools` | browser + Node | `devtools()` ([Dev console](CONSOLE.md)) |
| `@qu/lite/sw` | service worker | `quServiceWorker()`, Background Sync and push ([Service worker](#service-worker)); as a classic script `<relay>/dist/qu-sw.js` |
| `@qu/lite/sqlite` | Node ≥ 22.5 | `sqliteDriver` (`node:sqlite`) |
| `@qu/lite/ws-server` | Node | `listenHttp`, `listenWs`, `httpServerTransport`, `wsServerTransport` |
| `qu-lite-mirror` (bin) | Node | relay/mirror CLI, see [Mirror CLI](#mirror-cli-and-docker) |

The library is plain ES modules and needs no build step. It has one runtime dependency,
`ws`, used only on Node. Bundlers include an optional plugin (`text`, `rtc`/`topology`,
`relayTransport`/SSE) only if you import it. `defaultRegistry()` imports each module only when its
name is used, so `createPeer`/`createClient` load exactly the plugins they are given (a bundler
puts each one into its own chunk; the relay serves them as `dist/qu-client.js` + `dist/chunks/`).

**TypeScript**: every entry point ships declarations (`types/`, generated from the JSDoc by
`npm run types`, also run on `npm pack`). `createClient()`/`createPeer()` return the `Qu` type
(`src/qu-types.d.ts`): the kernel plus the members the standard plugins add - `write<V>()`,
`query<V>()` → `QuRecord<V>[]`, `members()`, `status()`, `device`, `dev`, `transports`. Members of
other plugins stay reachable as `any`. `test/types/app.ts` is a compiled example. Plain JavaScript
projects get the same hints in editors that read JSDoc.

A guided introduction (German) is [GUIDE.md](GUIDE.md); inspecting a running peer from the browser
console or the relay REPL is [CONSOLE.md](CONSOLE.md).

## Concepts in one minute

- **Peer (`qu`)**: one node with an identity, storage, a bus and plugins. Browser clients,
  Node clients and mirrors are all peers.
- **Identity**: an Ed25519 key pair plus an X25519 key pair, generated or loaded from storage.
  The **network id** (`qu.peerId`) is random and unrelated to the identity.
- **Space**: an encrypted container with an opaque id (`space.id`). Kinds: *group* (shared
  secret, members, epochs), *user node* (reachable by pubkey, writable by its owner) and
  *inbox* (anyone drops, only the owner reads).
- **Record**: a sealed, signed envelope in a space. A *log entry* has no `key`. A *keyed
  entry* uses last-write-wins per `(path, key)`. The author is a per-space **alias**, not the
  identity.
- **Plugin**: `(qu) => api`, installed with `qu.use(plugin)`. Plugins talk to each other over
  the **bus** through hooks and events, never by importing each other.
- **Mirror**: a peer that stores and forwards envelopes for spaces it was granted. It
  verifies signatures but holds no key and cannot read anything.

Typical plugin sets:

| Use | Plugins (in this order) |
|---|---|
| Minimal client | `records`, `sync` |
| Chat/group app | `records`, `user`, `members`, `inbox`, `sync`, `status`, `compaction` (+ `text`, `blobs`) |
| Mirror/relay | `limits`, `sync({ role: 'mirror' })`, `mirror` (+ `stats`) |

Dependencies: `user` needs `records`. `inbox` needs `records` and `user`. `status` needs
`records` and `members`, and installs `signals` itself. `text`, `blobs` and `compaction` need `records`.
`sync` is optional for everything, but without it nothing leaves the device.

---

## Building a peer

### `createQu(options?) → Promise<qu>`

This creates the bare kernel: a bus, a mount router, a clock and a registry. Install plugins with `qu.use()`.

```js
import { createQu, records, sync, indexedDbDriver } from '@qu/lite';
const qu = await createQu({ root: indexedDbDriver({ name: 'my-app' }) });
qu.use(records());
qu.use(sync({ ackFrom: 'mirror' }));
```

| Option | Default | |
|---|---|---|
| `identity` | generated | `{publicKey, privateKey, xPublicKey, xPrivateKey}` (see `crypto.generateIdentity`) |
| `root` | `memoryDriver()` | storage driver for the root mount |
| `bus` | `new Bus()` | |
| `clock` | `createClock()` | hybrid logical clock |
| `registry` | `new Registry()` | |
| `netId` | persisted random | network id, stored at `qu/net-id` |

`createQu` does **not** persist the identity. Persist it yourself, or use `createPeer`.

### `createClient(options?) → Promise<qu>`

The usual app peer in one call (browser and Node), built with `createPeer`:

```js
import { createClient } from '@qu/lite/client';
const qu = await createClient({ url: 'https://relay.example', name: 'my-app', extra: ['text'] });
```

| Option | Default | |
|---|---|---|
| `url` | browser page: its own address (folder); Node: – | relay origin, or an array of origins for redundancy (each kept connected); installs the `relay` transport (WebSocket, SSE fallback). An app served by its relay needs none; `null` = no relay |
| `name` | `'qu-lite'` | IndexedDB database name |
| `store` | `['indexeddb', {name}]` if IndexedDB exists, else `'memory'` | any `createPeer` store spec |
| `plugins` | `CLIENT_PLUGINS`: `records, user, members, inbox, sync({ackFrom:'mirror'}), status, compaction, device` | replaces the defaults |
| `extra` | `[]` | added after the defaults, e.g. `['text', 'blobs']` |
| `relay` | `{}` | options for the relay transport (`isolate`, `prefer`, …) |
| `transports` | relay from `url` | replaces the relay transport |
| `devtools` | `true` in browsers | `true`, `false` or options for [`devtools`](#devtools) |
| `persist` | `false` | ask the browser at start to keep the storage ([device](#device)) |
| `restore` | – | `{backup, passphrase, force?}`: start from a device backup ([device](#device)) |
| `passphrase` | – | keep the identity encrypted in storage; needed on every start ([device](#device)) |
| `registry`, `identity` | as `createPeer` | `nodeRegistry()` for `sqlite` on Node |

### `createRelay(options?) → Promise<{qu, port, spaces, close()}>` (Node)

A relay/mirror in one call (`@qu/lite/node`); the CLI is a thin wrapper around it.

```js
import { createRelay } from '@qu/lite/node';
const relay = await createRelay({ port: 8787, db: './relay.sqlite', logFormat: 'json', handleSignals: true });
relay.qu.dev.links();
await relay.close();   // graceful
```

Options: `port` (8787), `host`, `db` (`':memory:'`), `allow`, `static`, `app` (a folder served at `/` before `static`; the start page moves to `/qu.html`), `spa` (unknown paths → the app's index.html), `quota`, `maxEnvelopeBytes`,
`maxSpaces`, `rate` (200, `0` = off), `statsToken`, `maxConnections`, `maxBufferedBytes`, `log`
(`console.log`), `logFormat` (`'text'` | `'json'`: one JSON object per line), `extra` (more plugins),
`devtools` (`true`: `qu.dev` without a global), `handleSignals` (close on SIGINT/SIGTERM and exit).
`/readyz` answers 200 once the stored grants are loaded.

### `createPeer(options?) → Promise<qu>`

This builds a peer from registry names. It is the same builder for browsers, Node clients and mirrors.

```js
import { createPeer } from '@qu/lite';
import { nodeRegistry } from '@qu/lite/node';

// browser
const qu = await createPeer({
  store: ['indexeddb', { name: 'me' }],
  plugins: ['records', 'user', 'members', 'inbox', 'sync', 'status', 'compaction'],
  transports: [['relay', { url: 'https://relay.example' }]],
});

// mirror (Node)
const relay = await createPeer({
  registry: nodeRegistry(),
  store: ['sqlite', { path: 'relay.sqlite' }],
  plugins: [['limits', {}], ['sync', { role: 'mirror' }], 'mirror'],
  transports: [['ws-server', { port: 8787, static: './public' }]],
});
```

| Option | Default | |
|---|---|---|
| `registry` | `defaultRegistry()` | `nodeRegistry()` adds `sqlite`, `ws-server`/`http-server` |
| `store` | `'memory'` | a name, `[name, options]` or a driver object |
| `identity` | `'persisted'` | `'persisted'` loads `qu/identity` from the store or creates and saves one; or pass an identity |
| `plugins` | `['records', 'sync']` | entries: name, `[name, options]` or a plugin function |
| `transports` | `[]` | same entry forms |
| `netId` | persisted | |

The peer gets `qu.root`, the root driver. `qu.close()` closes it. Each plugin is recorded under its
registry name (`qu.has('sync')`). A transport API with a `ready` promise (the HTTP server) is awaited.
If building fails half-way, everything installed so far is closed and the error is rethrown.

### `Registry`, `defaultRegistry()`, `nodeRegistry(registry?)`

```js
const registry = defaultRegistry().register('plugin', 'audit', (opts) => auditPlugin(opts));
registry.names('plugin');            // ['records', 'sync', ..., 'audit']
await registry.create('store', 'memory');
```

`register(slot, name, factory)` throws on duplicates. The slots are `store`, `plugin` and
`transport`. Names in `defaultRegistry()`:

- stores: `memory`, `indexeddb`
- plugins: `records`, `sync`, `mirror`, `user`, `members`, `inbox`, `signals`, `status`,
  `compaction`, `limits`, `text`, `blobs`, `stats`, `topology`, `devtools`, `device`
- transports: `ws`, `sse`, `relay`, `webrtc`

`nodeRegistry()` adds the store `sqlite` and the transports `http-server` and `ws-server`.

---

## Kernel

| Member | |
|---|---|
| `qu.bus` | the [Bus](#bus) |
| `qu.storage` | the mount router (driver contract plus `mount`/`unmount`) |
| `qu.identity` | `{publicKey, privateKey, xPublicKey, xPrivateKey}` (Uint8Array) |
| `qu.peerId` | network id (hex) used in `net.*` topics |
| `qu.rotateNetId()` | picks a fresh network id for links opened from now on |
| `qu.clock` | HLC: `tick()`, `now()`, `peek()`, `recv(hlc)` |
| `qu.registry` | the registry the peer was built with |
| `qu.use(plugin, name?)` | installs a plugin and returns its API; `name` (default `plugin.pluginName`) records it in `qu.plugins`; an API with `close()` is closed by `qu.close()` |
| `qu.has(name)` / `qu.plugins` | whether / which named plugins are installed (`Map name -> api`) |
| `qu.mount(base, driver)` / `qu.unmount(base)` | mounts a driver on a key prefix |
| `qu.close({keepStore?}) → Promise` | shuts the peer down: `qu.closing`, disposers in reverse order (plugins, transports, links, timers), the root store (unless `keepStore`), `qu.closed`. Idempotent. |
| `qu.onClose(fn) → unregister` | cleanup for `close()` |
| `qu.timers.interval(fn, ms)` / `qu.timers.timeout(fn, ms) → cancel` | timers owned by the peer: cleared on close, never keep Node alive |
| `qu.closed` | `true` once `close()` started |

Plugins add more members to `qu`, listed with each plugin below.

**Writing a plugin**: return an API object; register listeners' `off` functions and other
cleanup with `qu.onClose()`, use `qu.timers` instead of `setInterval`, report background failures with
`qu.bus.error(error, where)`, and set `plugin.pluginName` so `qu.has()` and the devtools know it.

### Bus

The bus has dot-namespaced topics. `*` matches one segment and `**` matches the rest (last
segment only).

```js
const off = qu.bus.on('qu.record.*', (record, ctx) => { … }, { order: 0 }); // lower order runs first
qu.bus.once('net.peer.up', ({ peer }) => …);
off();
```

| Method | Semantics |
|---|---|
| `on(pattern, handler, {order}?) → off` | subscribes; handler gets `(payload, ctx)` |
| `once(pattern, handler, options?)` | removed after the first call |
| `emit(topic, payload, ctx?) → ctx` | handlers in order, awaited one by one; a hook may call `ctx.stop()` (veto) or annotate `ctx` |
| `notify(topic, payload)` | handlers in parallel, side effects only |
| `run(topic, payload) → payload` | transform chain: a returned object is merged into the payload; a throw aborts (veto) |
| `collect(topic, payload) → array` | every handler's result |
| `listenerCount(topic)` | |

A throwing handler never breaks the others. It is reported on `bus.error` as `{topic, error}`,
or on the console if nobody listens. The exception is `run()`, where a throw aborts the chain.
`bus.error(error, where)` reports a failure outside a handler (a timer, a deferred flush) the same way.
`new Bus({cacheSize = 2048})`: the sorted handler list of a topic is cached until a listener is added or removed.

---

## Storage

| Driver | Import | |
|---|---|---|
| `memoryDriver()` | `@qu/lite` | in memory |
| `indexedDbDriver({name?, store?, indexedDB?, IDBKeyRange?, onBlocked?})` | `@qu/lite` | browser; defaults `name: 'qu-lite'`, `store: 'kv'`; closes on `versionchange`, reopens a connection the browser closed |
| `sqliteDriver({path?})` | `@qu/lite/sqlite` | Node ≥ 22.5, WAL, one table; default `':memory:'`; `close()` |

**Driver contract**: `get(key)`, `set(key, value)`, `remove(key)` and `keys(prefix)`.
Optional: `has(key)`, `range(prefix, {gte, lt, limit, reverse})` and `batch(ops)` for an atomic
multi-key write, where `ops` is `[{op: 'set'|'remove', key, value?}]`. Values are
structured-clonable (objects, Uint8Array). Keys are `/`-separated. Every driver sees the
**full** key.

**Mounts** follow unstorage: the longest prefix wins and the root `''` is always mounted.
`createMountRouter({root, bus})` is the router that `createQu` uses. A batch is atomic within
a mount, not across mounts. `qu.storage.afterWrite(prefix, fn) → off` calls `fn(keys)` after every
completed `set`/`remove`/`batch` touching `prefix`, before the write resolves to its caller - the hook
for caches derived from stored data (sync uses it for its index cache). Writes that bypass `qu.storage`
(straight to a driver) are not seen.

```js
qu.mount('sync/', memoryDriver());   // e.g. keep sync bookkeeping in memory
```

Keys used by the library: `rec/`, `sx/`, `idx/`, `head/`, `loc/`, `defer/`, `gone/` and `gcs/`
(per sid); `sync/out/`, `sync/pending/`, `members/`, `mirror/` and `qu/`. Don't write there.

---

## Space

```js
import { Space } from '@qu/lite';
const group = await Space.create(qu.identity);    // new group, qu.identity is the owner (via alias)
const same  = await Space.open(group.invite);     // {secret, owner} – whoever holds it can read & write
const node  = await Space.user(pubkeyBytes);      // someone's user node (public view)
const box   = await Space.inbox(pubkeyBytes);     // someone's inbox
```

| Member | |
|---|---|
| `Space.create(identity?)` | new group with a random 32-byte secret. Without an identity the owner is a throwaway key and nobody can administer the group. |
| `Space.open(secret, {owner})` or `Space.open(invite)` | opens a group; `owner` is the owner's alias pubkey (bytes or hex) |
| `Space.user(identityPub, identity?)` | user node; with the matching identity you get the owner's view (writable, private fields readable) |
| `Space.inbox(identityPub)` | an identity's inbox |
| `space.id` | opaque sid (hex) – it reveals nothing about members or content |
| `space.kind` | `'group'`, `'user'` or `'inbox'` |
| `space.invite` | `{secret, owner}` – plain group access, without roles |
| `space.ownerId` | owner (alias for groups, identity for user nodes), hex |
| `space.epoch`, `space.latestEpoch` | current / highest known key epoch |
| `space.writable` | whether this peer holds the write key of the current epoch |
| `space.authorFor(identity, mode?)` | the signing key pair here: per-space alias (default) or `'identity'` |
| `space.rotate(admin)`, `addEpoch(grant, key)`, `useEpoch(epoch?)` | epoch management (prefer `members().rotate()`) |
| `space.grants()`, `grantState()`, `isAdmin(pub)` | the signed epoch/admin chain |

For role-based groups use the [members](#members) plugin (`qu.createGroup()`,
`members.invite()`). `space.invite` alone gives access without a member entry. On a group
with `members()` installed, such a peer cannot write.

---

## records

`qu.use(records({ author?, cacheSize?, cacheBytes?, padding?, maxIndexes?, maxIndexEntries? }))` – read and write records of joined spaces.
This plugin installs the blind envelope layer.

| Option | Default | |
|---|---|---|
| `author` | `'alias'` | default signing key for group spaces (`'identity'` signs with the identity; user nodes always use the identity) |
| `cacheSize` | `1000` | decrypted records kept in memory (count) ... |
| `cacheBytes` | `4194304` | ... and by size (4 MiB of envelopes). Records over 1/8 of it (large file chunks) are not cached |
| `padding` | `'quarter'` | private inners padded to size steps: `'quarter'`, `'small'`, `'pow2'` or `'none'` |
| `maxIndexes` | `64` | in-memory field indexes kept for `where`/`orderBy` queries (least recently used leave) |
| `maxIndexEntries` | `200000` | ... and their entries in all (~200 bytes each, ~40 MB at most) |

| Method | |
|---|---|
| `qu.join(space, {author?, mirror = true}?) → space` | starts reading/writing a space; `mirror`: announce its write keys to mirrors |
| `qu.leave(space)` | stops using a space. With `status()` installed, `qu.leave()` is the clean presence leave instead; use `qu.records.leave(space)`. |
| `qu.write(space, path, value, {key?, visibility?}?) → record` | `value`: any JSON. `key`: last-write-wins entry. `visibility: 'public'`: signed, not encrypted. Throws if a hook vetoes or the commit fails (retryable). |
| `qu.get(space, path, key) → value \| null` | current value of a keyed entry (`null` if missing or deleted) |
| `qu.query({space, path, from?, to?, limit?, reverse?, ensure?, where?, orderBy?}) → record[]` | one path, ordered by HLC; `from` inclusive and `to` exclusive (ms); `ensure: true` reconciles the window first (needs `sync`); `where`/`orderBy`: by any field, see below |
| `qu.scrub(space) → {checked, dropped, reindexed}` | local integrity repair without decrypting: drops broken envelopes (resync fetches them again) and re-indexes lost indexes |
| `qu.forget(space) → number` | removes everything stored locally for a space (other peers keep theirs) |
| `qu.space(sid) → space \| null` | a joined space by id |
| `qu.announce(space)` | re-announces write keys to mirrors (after epoch changes; `members()` does it) |
| `qu.reindex(space) → {admitted, rejected, deferred}` | re-checks deferred records (`members()` triggers it) |
| `qu.records` | `{…above, dropList, spaceOf, read, authorOf(space), headOf(space, path, key), joined()}` |

`space` arguments accept a `Space` or a joined sid.

**Record** (what `write`, `query` and `qu.record.<sid>` deliver):

```js
{ id, path, key /* null for log entries */, value, hlc, author /* alias hex */, ts /* minute, ms */,
  epoch, visibility /* 'private'|'public' */, deleted? /* tombstone */, type? }
```

**Queries by field.** `where` and `orderBy` work on any field of the value, the same way for
every app:

```js
// calendar: one week, by start time (ms or ISO strings)
await qu.query({ space, path: 'events', where: { start: { gte: monday, lt: nextMonday } }, orderBy: 'start' });
// tasks: equality on several fields (AND); an array field matches if it contains the value
await qu.query({ space, path: 'tasks', where: { status: 'open', tags: 'urgent' } });
await qu.query({ space, path: 'tasks', where: { status: ['open', 'blocked'] } });          // in
// search and prefix (case-insensitive substring / string prefix)
await qu.query({ space, path: 'posts', where: { title: { contains: 'sync' } }, limit: 20 });
await qu.query({ space, path: 'contacts', where: { name: { prefix: 'An' } }, orderBy: 'name' });
// game: top 10 of a round; nested fields with dots
await qu.query({ space, path: 'scores', where: { round: 7 }, orderBy: 'points', reverse: true, limit: 10 });
await qu.query({ space, path: 'events', where: { 'place.city': 'Berlin' } });
// the value itself, the entry key, the author
await qu.query({ space, path: 'chat', where: { $value: { contains: 'hallo' } } });
await qu.query({ space, path: 'events', where: { $key: { prefix: '2026-11' } } });
```

| Condition | Matches |
|---|---|
| `value` / `{eq}` | equal (`5` ≠ `'5'`) |
| `[a, b]` / `{in}` | equal to one of them |
| `{gt, gte, lt, lte}` | range; only values of the same type as the bound |
| `{prefix}` | strings starting with it |
| `{contains}` | strings containing it, case-insensitive |

- **Order and paging:** comparable values are numbers, strings and booleans, ordered in that
  type order. `orderBy` puts records without the field last. Without `orderBy`, results keep HLC
  order. `reverse`, `limit`, `from` and `to` apply as in a plain query.
- **What matches:** only current versions. For keyed entries that is the newest one; deleted
  entries never match.
- **Cost:** the first query on a field of a path builds a sorted index **in memory**, which is one
  pass over that path (about 0.1 ms per record). After that it is kept up to date as records
  arrive, change or are deleted, and a query takes about 1 ms even at 20,000 records
  (`test/fields.test.js`).
- **Privacy:** nothing readable is written to disk; the store keeps only sealed envelopes and
  opaque pointers.
- **Loading:** the code (`fields.js`, ~2 KB gzip) is loaded the first time a query uses `where`
  or `orderBy`.

**Hooks**:

```js
// transform or veto local writes (draft: {space, path, key, value, visibility, deleted})
qu.bus.on('qu.write.before', (draft) => ({ value: sanitize(draft.value) }));
qu.bus.on('qu.write.before', (draft) => { if (tooLong(draft)) throw new Error('too long'); });

// accept/reject every record (local or remote) before it is indexed
qu.bus.on('qu.accept', (record, ctx) => {
  if (record.path === 'admin-only' && !isAdmin(record.author)) { ctx.reason = 'not allowed'; ctx.stop(); }
  // ctx.defer = true postpones the decision (re-checked by qu.reindex())
});
```

Example: [01-records.mjs](../examples/01-records.mjs).

---

## sync

`qu.use(sync(options?))` – Negentropy reconciliation with a durable outbox and resumable reconciles.

| Option | Default | |
|---|---|---|
| `role` | `'peer'` | `'mirror'` for mirrors |
| `ackFrom` | `'any'` | `'mirror'`: an outbox entry stays until a **mirror** stored it |
| `releaseMs` | `30000` | how long an unwatched scope stays subscribed |
| `timeoutMs` | `10000` | how long a reconcile waits for wanted records |
| `retryMs` | `30000` | retry interval for unfinished reconciles while connected (`0`: only on connect) |
| `sessionTtlMs` | `60000` | responder session lifetime |
| `maxSessionsPerPeer` | `8` | concurrent responder sessions per peer (beyond: `negerr busy`, retried after ~1 s with backoff) |
| `maxConcurrentPerPeer` | `4` | own reconciles running at once per peer; more scopes queue instead of being declined |
| `digest` | `true` | offer/use the digest pre-check: identical whole-space/shard sets are confirmed with one 16-byte fingerprint each, batched into one frame; only differing scopes run Negentropy. Used only when both sides announce it in `hello` |
| `ackDelayMs` | `20` | acks are collected this long and sent as one frame per space |
| (ack8) | always offered | acks to a peer that offers `ack8` carry 8-byte id prefixes, matched against the receiver's outbox; `qu.record.acked` fires for outbox records only |
| `batch` | `true` | offer/use batched `recs` frames: bulk record sends go up to 64 records / 64 KiB per frame to a peer that offers them (any other sync frame flushes first, so the order is unchanged). 20 spaces x 200 records: first upload 4,564 -> 167 frames, -5 % bytes; fresh device -6.5 % |
| `indexCacheItems` | mirror `250000`, peer `50000` | sync-index entries kept in memory (~300 bytes each, LRU; `0` = off). The (ts, id) vector of a whole space or shard and its fingerprint are shared by all sessions, digest checks and pulls until the space's index changes (generation bumped by `storage.afterWrite`); concurrent reads of one scope share one load |
| `pull` | `true` | offer/use the direct download: a scope this device holds nothing of is fetched with one `pull` request instead of a reconcile (no id lists), checked by fingerprint at the end; on any difference, decline or timeout the normal reconcile runs. Used only when both sides announce it in `hello` |
| `frameSizeLimit` | `262144` | max Negentropy message in bytes (0 = unlimited); bigger differences take more rounds. `want`/`ack` id lists go out in batches of 4096 ids |
| `stale` | `'retire'` | a scope not completely synced for longer than the drop-list horizon retires old records the peer lacks instead of pushing them (they may have been deleted meanwhile); `'push'`: push anyway |

| Method | |
|---|---|
| `qu.watch({space, path?, from?, to?}) → unwatch` | subscribes and reconciles exactly this scope (whole space, one path's shard, optional time window) with every peer, now and on every connect |
| `qu.resync({space, path?, from?, to?, peer?}) → result[]` | reconciles now; result: `{peer, sid, shard, sent, received, missing, error?}` |
| `qu.syncStatus() → {outbox, pending}` | what still waits |
| `qu.syncState(sid, id) → 'pending' \| 'sent'` | whether a local write left the outbox |
| `qu.lastSync(sid, shard?) → ms \| null` | start of the last complete reconcile of the space (or shard) with a mirror |
| `qu.staleSpaces() → [{sid, last}]` | spaces this device has not completely synced within the horizon - check at start-up to warn the user |

`members()`, `user()` and `inbox()` call `watch()` for their spaces themselves.

**Grants on reconnect**: a client sends a mirror that offers `grantsum` only fingerprints of its grants
(24 bytes per space); the mirror asks (`grantneed`) for those it lacks or holds differently. Reconnect of
20 unchanged spaces: 6.6 KiB before, 3.6 KiB now. Plugins add hello features to `netOf(qu).features`.

**Relay load** (`bench/relay-load.mjs`, 20 devices reconnecting at once, 20,000 records, SQLite): 20 index loads and a
1,081 ms event-loop stall before, 1 load and 67 ms now; after one new record 40 loads / 1,778 ms before,
1 load / 15 ms now. The index is read in pages of 5,000 keys with the event loop running in between.
`sync.index {sid, shard, items, ms, cached}` reports every load (`cached: true` = served from memory).

**Traffic**: a reconcile waits up to 5 s for the peer's `hello` (its role and features decide the path).
An empty scope is pulled (`sync.pull {peer, sid, shard, received, complete, reason?}`; `sync.start` has
`pull: true`); a pull never decides correctness - the fingerprint or the fallback reconcile does. Bulk
record sends (pull, `want`, push, outbox) are paced by the link's send buffer, so large spaces never
trip the slow-consumer limit. A reconcile of the same scope with the same peer is never started twice (a second call
joins the running one). Outbox records pushed on connect are not pushed again by the reconcile on that
link. A mirror gets no acks (it never writes). `sync.start` carries `digest: true` when a matching digest
finished the scope without a session. `bench/sync-bytes.mjs [spaces] [records]` prints the bytes per
frame type for upload, reconnect, offline changes and a fresh device.

| Situation (20 spaces x 200 records, 1.36 MiB of envelopes) | before | now |
|---|---|---|
| first upload | 3,490 KiB / 14,664 frames | 1,699 KiB / 4,584 frames |
| reconnect, nothing changed | 15.5 KiB / 70 frames, 12 sessions declined | 6.6 KiB / 24 frames, no session |
| reconnect after 10 offline writes per space | 117.9 KiB | 100.6 KiB |
| fresh device downloads everything | 3,205 KiB, declined sessions wait for `retryMs` | 1,598 KiB (pull), no waiting |
| fresh device, 5 spaces x 2,000 records (3.3 MiB) | – | 3,800 KiB with pull, 4,459 KiB without |

**Devices offline longer than 90 days**: a stale scope still pushes its outbox and every record
younger than the horizon. Older records the peer lacks are removed locally: `sync.stale {peer, sid,
shard, since, retired}`, then `qu.record.deleted {space, id, stale: true}` for each one. After that
reconcile the device is current again.

Example: [02-sync.mjs](../examples/02-sync.mjs).

---

## user

`qu.use(user())` – every identity's home space, reachable by pubkey.

```js
const me = await qu.me();
await me.set('name', 'Anna');                                // public field (signed plaintext)
await me.set('phone', '+49 …', { visibility: 'private' });   // only own devices
await me.getPrivate('phone'); await me.privateFields();

const anna = await qu.user(pubHex);   // someone else: public fields, kept live via sync
await anna.get('name'); await anna.fields();
```

The view is `{space, id, get(field), fields()}`, and `me` adds `set`, `getPrivate` and
`privateFields`. `qu.me()` publishes `epub` (X25519, used to encrypt to you) automatically.

## inbox

`qu.use(inbox({ enabled = true, maxBytes = 65536, epubTimeoutMs = 5000 }))` – a mailbox per identity.

```js
await qu.inbox.ready;                                         // own inbox announced and subscribed
await qu.inbox.send(pubHex, { type: 'hello', text: 'hi' });   // sealed box to their epub
qu.bus.on('qu.inbox.message', ({ id, at, payload }) => …);
await qu.inbox.messages();                                    // [{id, at, payload}], oldest first
```

The relay only sees "mailbox X got N bytes". `enabled: false` makes you unreachable this way.

## members

`qu.use(members({ pad = 8 }))` – groups with roles, admin-signed epochs and invites.

```js
const group = await qu.createGroup();            // joined, watched, I'm the owner
const m = await qu.members(group);
const invite = await m.invite();                 // link/QR: {type:'invite', secret, owner, epochs, admins, token, expiresAt}
await m.invite(null, { expiresIn: 24 * 3600_000 }); // valid for a day (default 7 days, null = never)
await m.invite(bobPubHex, { role: 'member' });   // or into Bob's inbox (needs inbox())
// Bob:
qu.bus.on('qu.inbox.message', ({ payload }) => payload.type === 'invite' && qu.acceptInvite(payload));
const space = await qu.acceptInvite(invite);     // verifies epochs/admins, writes the own entry
await qu.restoreGroups();                        // after a reload: reopens every joined group
```

| `qu.members(space) → manager` | |
|---|---|
| `me` | own alias in this space (hex) |
| `list()` | `[{alias, role, xpub, identity?, name?, verified, me}]` |
| `role(alias = me)`, `isAdmin(alias = me)` | |
| `invite(identityPub?, {role?, expiresIn?})` | admin only; `role`: `'member'` or `'admin'`; `expiresIn` ms (default 7 days, `null` = never). The window (`token.iat`/`token.exp`) is signed; `acceptInvite()` refuses an expired invite, and every member refuses a join entry dated outside it (`qu.record.rejected` reason `invite expired`) |
| `reveal({name}?)` | optional, verifiable "alias X is identity Y" (visible to members only) |
| `promote(alias, role)` | owner only; re-signs the admin list |
| `remove(alias) → epoch` | admin; role → `removed`, new epoch for everyone else |
| `rotate() → epoch` | admin; new epoch, e.g. after a suspected key leak |
| `open` | `true` for a space created with `createGroup({ open: true })` |
| `link() → invite` | admin; an invite **without token**: in an open space anyone holding it writes; otherwise it is a **read-only** link (its holder's records are never accepted) |
| `ban(alias)`, `unban(alias)`, `bans()` | admin; refuses everything the alias writes from now on - at every member and at the relay |

**Open spaces** (forum, comments, public room): `createGroup({ open: true })` writes the public
record `_mod/open`. Anyone who has `m.link()` may then write without an invite or member entry.
Moderation replaces membership: `ban(alias)` writes the public record `_mod/ban:<alias>`, so
members *and* the relay refuse the alias's later records. `qu.del(space, record)` lets an admin
delete anyone's record for everyone. In an open space `remove(alias)` bans instead of rotating
keys, because the link is public. At the relay every author except owner and admins has a rate
limit for fresh writes (mirror `openRate`, default 0.2 records/s with a burst of 20). Refused
records stay in the sender's outbox and are retried.

The roles are `owner`, `admin`, `member` and `removed`. The rules are enforced by every peer on
every record. Events: `qu.members.changed {space}` and `qu.members.epoch {space, epoch}`.

Example: [04-groups.mjs](../examples/04-groups.mjs).

## signals

`qu.use(signals({ maxAgeMs = 60000, maxFutureMs = 300000, seenSize = 5000 }))`. `status()`
installs it.

```js
await qu.signal(space, 'wave', { hi: true });   // sealed, signed, never stored or synced
qu.bus.on(`qu.signal.${space.id}.wave`, ({ author, value, at }) => …);
```

## status

`qu.use(status(options?))` – presence, typing, sent/delivered/read.

| Option | Default | |
|---|---|---|
| `interval` | `20000` | presence heartbeat while the app is visible; online = heartbeat younger than 2.5 × the interval the sender announced (`every`, at most 30 min) |
| `hiddenInterval` | `300000` | heartbeat while the page is hidden (`document.visibilityState`, or `qu.status.setHidden(true)`); `0` = announce "offline" while hidden. 10 groups: ~1.3 MiB/hour visible, ~90 KiB/hour hidden |
| `presence` | `true` | `false`: never announce yourself (you still see others) |
| `readReceipts` | `true` | `false`: only "delivered" is sent |
| `typingThrottleMs` / `typingTtlMs` | `3000` / `5000` | |
| `receiptThrottleMs` | `2000` | |

```js
const st = await qu.status(group);
st.isOnline(alias); st.online();               // Map alias -> {lastSeen, state, online}
await st.sendTyping('chat'); st.typing('chat'); // aliases typing in 'chat'
await st.markRead('chat');                     // my read cursor (default: newest record)
await st.of(record);                           // {sent, delivered: [alias], read: [alias], members}
await qu.leave();                              // clean leave: "offline" in every tracked space
qu.status.setHidden(true);                     // app in the background (runtimes without visibilityState)
```

Events: `qu.status.hidden {hidden}`, `qu.status.presence {space, alias, online}`, `qu.status.typing {space, path, typing}` and
`qu.status.receipts {space, path, alias}`. Example: [05-status.mjs](../examples/05-status.mjs).

## compaction

`qu.use(compaction({ auto = true, delayMs = 60000, expireEveryMs = 21600000, keep = ['_keys', '_grants'] }))`

```js
await qu.del(space, record);               // log entry (record or id): gone at every peer and the mirror
await qu.del(space, 'settings', 'theme');  // keyed entry: tombstone, get() → null
await qu.compact(space);                   // drop own superseded versions now
await qu.compact(space, { all: true });    // owner/admin: everyone's superseded versions
qu.bus.on('qu.compact.candidate', (c, ctx) => keepIt(c) && ctx.stop());   // veto
```

You may delete your own records. Owners and admins may delete any record. Drop lists expire
after `GC_HORIZON_MS` (90 days). Events: `qu.record.deleted {space, id, gc}`,
`qu.envelope.dropped`, `qu.compact.done {space, dropped, expired}` and `qu.gc.expired`.
Example: [06-delete-compact.mjs](../examples/06-delete-compact.mjs).

## text

`qu.use(text({ batchMs = 300, snapshotEvery = 200 }))` – optional collaborative plain text (RGA CRDT).

```js
const doc = await qu.text(space, 'notes/main');
doc.value(); doc.insert(i, 'abc'); doc.delete(i, n); doc.set(textarea.value);
const off = doc.on(({ text, remote }) => …);
const caret = doc.anchor(i); doc.indexOf(caret);   // positions that survive remote edits
await doc.flush(); await doc.compact(); doc.stats(); await doc.close();
```

`TextCrdt` is exported for use without records. Positions count Unicode code points. The
document lives in memory as runs (one node per stretch typed in one go), so cost grows with the
number of edits, not of characters. Example: [07-text.mjs](../examples/07-text.mjs).

## blobs

`qu.use(blobs(options?))` – attachments as chunked, encrypted records, fetched on demand.

| Option | Default | |
|---|---|---|
| `chunkSize` | `65536` | raw bytes per chunk record (~96 KiB envelopes, under a mirror's 256 KiB limit) |
| `maxBytes` | `67108864` | largest blob (64 MiB) |
| `keepAwake` | `true` | hold a Screen Wake Lock while uploads or downloads run and a peer is connected (re-acquired when the page is visible again) |
| `warnOnUnload` | `true` | `beforeunload` asks before leaving the page while uploads are unfinished |
| `wakeLock` | `navigator.wakeLock` | the WakeLock API to use (tests inject one) |

```js
const ref = await qu.blobs.put(space, file, { name: 'a.jpg', type: 'image/jpeg' }); // Uint8Array, ArrayBuffer or Blob/File
await qu.write(space, 'chat', { text: 'look', file: ref });     // the app links it in its own record
const bytes = await qu.blobs.get(space, ref, { timeoutMs: 30_000 }); // waits for and fetches missing chunks
img.src = URL.createObjectURL(new Blob([bytes], { type: ref.type }));
await qu.blobs.has(space, ref);      // {have, total, complete}
qu.blobs.pending();                  // [{space, blob, direction: 'up'|'down', done, total}]
await qu.blobs.del(space, ref);      // drop lists: your records (owner/admin: all of them)
```

| Method | |
|---|---|
| `put(space, data, {type?, name?}) → ref` | `ref = {blob, size, chunks, type?, name?}`. Content-addressed: the same bytes give the same ref, and chunks already held are not written again. `name` stays in the ref only. |
| `get(space, ref \| id, {wait = true, timeoutMs = 0}) → Uint8Array` | reads what is held; otherwise watches the blob's own shard until it is complete (`timeoutMs` 0: no limit) |
| `has(space, ref)` | what this peer holds |
| `del(space, ref) → number` | records listed for dropping |
| `pending()` | transfers running; uploads survive a reload (`await qu.blobs.ready` restores them) |
| `awake` | whether a wake lock is held |
| `path(blobId)` | the record path (`_blob-<id>`) |

Records under `_blob-<id>`: a manifest `{v: 1, size, chunkSize, hashes, type?}` and chunks `{i, d}`.
Readers accept only a manifest whose hash is the blob id and only chunks matching their hash, so
junk under the path changes nothing. Each blob has its own shard: a peer that syncs only some
paths fetches exactly the blobs it opens. The mirror sees that a group of records belongs
together (roughly the attachment's size), never its content, name or type.

Events: `qu.blob.progress {space, blob, direction, done, total}` (uploads count records until they
left the outbox, downloads count chunks) and `qu.blob.done {space, blob, direction}`. Example:
[08-blobs.mjs](../examples/08-blobs.mjs).

## stats

`qu.use(stats({ windowMs = 10000, sampleMs = 1000, emitMs = 0, storageCacheMs = 5000 }))` – operating
figures for any peer, client or relay. Optional and cheap: links count bytes and frames anyway
(`qu.net.links`); the plugin only reads those counters and bus events. One sampling timer (unref'd).

```js
const s = qu.stats.snapshot();       // sync: traffic, connections, peers, record outcomes, counters
s.traffic;      // {bytesIn, bytesOut, framesIn, framesOut, inBps, outBps}  totals incl. closed links, throughput over windowMs
s.peers;        // [{peer, via, since, bytesIn, bytesOut, framesIn, framesOut, inBps, outBps}]  open connections
s.connections;  // {open, total, peak}
s.records;      // {local: {stored: n, …}, remote: {stored, duplicate, rejected, gone, …}}  ingest outcomes
s.counters;     // {reconciles, syncErrors, staleRetired, rateLimited, quotaRefused, refusedByPeer}
await qu.stats.storage();   // {spaces, records, bytes, outbox, pending, driverBytes, quota}
await qu.stats.report();    // snapshot + storage
await qu.stats.prometheus(); // the report as Prometheus text
qu.bus.on('qu.stats', (snapshot) => render(snapshot)); // every emitMs (0: off)
```

`storage()` reads key names only: a mirror sums its kept per-space usage (`bytes` = stored
envelopes), any other peer counts envelopes per known space. `driverBytes` is the SQLite file
size, or in a browser `navigator.storage.estimate()` (with `quota`). Results are cached for
`storageCacheMs`. Peers are named by network id only. The figures contain no space ids or
identities. Example: [09-stats.mjs](../examples/09-stats.mjs).

## device

`qu.use(device({ iterations = 600000, navigator?, credentials?, relay?, rpId?, vaultDelayMs = 1000 }))` – device
backup, browser storage persistence, security keys / passkeys. `createClient()` installs it.
`credentials` (default `navigator.credentials`) and `rpId` (default: the page's host) are for
WebAuthn; `relay` is where tresors go (default: the relay transport's url).

| Method | |
|---|---|
| `qu.device.exportBackup(passphrase) → string` | the device-only keys (`qu/identity`, `members/groups/`, `members/keys/`), sealed: PBKDF2-SHA256 (`iterations`) + AES-256-GCM, header authenticated; one line `qu-backup.…`. Passphrase ≥ 8 characters. Records `qu/backup-at`, notifies `qu.device.backup {groups}` |
| `qu.device.downloadBackup(passphrase, filename = 'qu-backup.txt')` | browser: the same, offered as a file |
| `qu.device.persist() → boolean \| null` | `navigator.storage.persist()` (may prompt); `null` where unsupported; `qu.device.persist {granted}` |
| `qu.device.status() → {persisted, usage, quota, backupAt, groups, locked, keys, keyLocked}` | `null` for what the runtime cannot tell |
| `qu.device.addKey({name?, kind?, lock?, rpName?}) → {id, synced}` | registers a security key (YubiKey: USB, NFC) or passkey that unlocks this identity, here and on other devices; one tap (two on keys without PRF on creation). `kind`: `'security-key'` \| `'passkey'` (default: the browser offers both). `lock: true`: this device keeps no usable identity, every start needs the key. `synced`: the relay holds the tresor. Call from a click |
| `qu.device.keys() → [{id, name, type, transports, model, created}]` | registered keys. `type`: `'security-key'` \| `'passkey'`, `transports`: e.g. `['usb', 'nfc']`, `['internal', 'hybrid']`, `model`: the AAGUID (when the browser tells; the community list *passkey-authenticator-aaguids* maps it to a name). Without `name` at `addKey`, a label like `Security key (USB, NFC)` or `Passkey (Google Password Manager)` |
| `qu.device.removeKey(id)` | the key no longer opens the tresor (here and at the relay); the last key of a key-locked device stores the identity plain again |
| `qu.device.lock(passphrase)` / `changePassphrase(old, new)` / `removeLock(passphrase)` | identity lock at runtime (see below) |

`readBackup(text, passphrase) → {identity, entries, created}` checks a backup without using it (wrong
passphrase and damage both throw `backup: wrong passphrase or damaged backup`).
Restore: `createClient({ restore: {backup, passphrase, force?} })` (or `createPeer`) writes the backup
into the store first; a store whose identity differs and has groups is refused unless `force` (then its
group and epoch keys are dropped). Then `await qu.restoreGroups()`. `createClient({ persist: true })`
calls `qu.device.persist()` at start.

**Identity lock** (optional): `createClient({ passphrase })` (or `createPeer`) keeps the identity only
encrypted in storage (`qu/identity-locked`, the backup format without group entries); an unlocked
identity is locked on the first start with a passphrase (the plain copy is removed after the sealed
one was read back). Every start then needs it: without, the start rejects with `error.code ===
'QU_LOCKED'`, with a wrong one `'QU_WRONG_PASSPHRASE'`. Protects data at rest (copied disk, profile,
database file), not a compromised running page. `restore` into a locked storage needs that storage's
`passphrase` or `force`.

**Security keys and passkeys** (`keys.js`): `createClient({ url, unlock: 'key' })` (or
`unlock: {kind?, remember?, rpId?, credentials?}`, `createPeer({ unlock: {relay, …} })`) opens the identity
with one tap, as follows:

- **plain identity in the store:** nothing to do, no tap;
- **tresor on this device (key lock):** opens locally;
- **empty store:** the tresor comes from the relay, and the identity and group keys are written.
  `remember: false` keeps a new device key-locked.

Then `await qu.restoreGroups()`. Errors: `QU_KEY_CANCELLED` (dismissed, timed out),
`QU_KEY_UNSUPPORTED` (no WebAuthn PRF), `QU_KEY_UNKNOWN` (no tresor for this key at this address),
`QU_KEY_EXISTS`, `QU_KEY_FAILED`. A key-locked store started without `unlock` rejects with
`QU_LOCKED` (`error.unlock === 'key'`) and never creates a new identity.

How it works:

- **PRF:** WebAuthn's PRF extension (CTAP2 `hmac-secret`) gives a 32-byte secret per credential and
  address. With it, `HKDF(secret | salt)` wraps a random DEK.
- **Tresor:** the DEK encrypts `{identity, entries}` with AES-256-GCM (entries: `members/groups/`,
  `members/keys/`).
- **Storage:** `qu/vault` (the tresor), `qu/vault-dek` (only where the identity is stored plain
  anyway), `qu/vault-lock`. The relay keeps one copy per key (`GET`/`POST /id/<sha256(credential
  id)>`, written only with the identity's signature, `at` must grow, mirror option `vault`). The
  tresor is re-sealed when group or epoch keys change (`qu.device.vault {synced}`).
- **Credentials:** discoverable (resident), so no user name is needed. They are bound to the
  page's host (`rpId`): use one address for all devices.
- **No dead entries:** a credential without PRF (`QU_KEY_UNSUPPORTED`) and a removed key are
  reported to the browser (`PublicKeyCredential.signalUnknownCredential`, newer browsers), so the
  user's passkey manager can drop them.

## devtools

`qu.use(devtools({ global?, log?, table? }))` – the inspection API `qu.dev` for the browser console and
the relay REPL. `global`: name on `globalThis` (browser default `'qu'`, Node default none, `false` = none).
`createClient()` installs it in browsers, `createRelay()` always (without a global).

`qu.dev.help()`, `info()`, `links()`, `transports()`, `traffic()`, `watchTraffic(seconds) → stop`, `resetTraffic()`, `trace(pattern, {persist?, filter?}) → stop`,
`untrace()`, `spaces()`, `pending()`, `ls(prefix, limit)`, `get(key)`, `dump(prefix, limit)`, `stats()`,
`listeners(topic)`, `emit(topic, payload)`. The identity (`qu/identity`) is always masked.
`?qu-trace=<pattern>` in the page URL, or `trace(p, {persist: true})`, traces from start-up.
Details and recipes: [CONSOLE.md](CONSOLE.md).

## mirror

`qu.use(mirror({ allow = null, quota = null, maxEnvelopeBytes = 262144, expireEveryMs }))` on a
peer with `sync({ role: 'mirror' })` and **without** `records()`.

| Option | |
|---|---|
| `allow` | list of sids to serve (`null`: any that is granted) |
| `quota` | `{records?, bytes?}` per space; refused envelopes produce `qu.record.refused` at the sender, whose outbox keeps them |
| `maxEnvelopeBytes` | size limit per envelope |
| `maxSpaces` | most spaces this mirror accepts (`null`: unlimited). Grants are self-certifying, so anyone can create spaces; set it on a public relay. Refusals: `mirror.full {sid, spaces}` |
| `openRate` | `{rate, burst}` records per second per author for fresh writes in open spaces (default `{rate: 0.2, burst: 20}`; `null` = off). Owner and admins are exempt |

The mirror also serves plain HTTP (CORS for any origin):

| Route | |
|---|---|
| `GET /q/<sid>/<path>?key=&limit=&before=&after=` | public records of one path, newest first: `{sid, path, grants, records: [base64 envelope], next?}`. Private records are never served |
| `POST /q/in` | body: envelopes (`packEnvelopes()`); ingested like records from a link → `{results: [{id, status, reason?}]}`. Used by the service worker for Background Sync |

API: `qu.mirror.ready` resolves to the served sids. Also `spaces()`, `count(sid)`, `usage(sid)`,
`writeKeys(sid)`, `admins(sid)` and `expire()`. Events: `mirror.grant {sid, changed}` and
`mirror.quota {sid, usage}`.

## Reading without membership

```js
import { fetchPublic, publicLink } from '@qu/lite';
const posts = await fetchPublic('https://relay.example', sid, 'blog');            // newest first
const about = await fetchPublic('https://relay.example', sid, 'pages', { key: 'about' });
const more  = await fetchPublic(publicLink('https://relay.example', sid, 'blog'), { before: posts.next });
```

Reads the **public** records (`write(..., { visibility: 'public' })`) of one path. You need no
identity, no peer and no membership. The relay sends the sealed envelopes plus the space's grants,
and `fetchPublic` checks the grant chain and both signatures of every record. A relay can withhold
records but cannot forge or alter them. For keyed entries only the newest version is returned, and
deletions are left out. A blog is a group whose members are its authors. A forum is an open space
(see members).

## background

`qu.use(background({ serviceWorker?, wakeLock?, relay? }))`, or `createClient({ extra: ['background'] })`.

```js
await qu.background.progress()          // {records, bytes} still in the outbox
qu.bus.on('qu.sync.progress', ({ records, bytes }) => showUploadBar(records, bytes));
qu.background.backgroundSync            // true | false | null (not known yet)
```

While the outbox is not empty:

- **Background Sync** (Chrome, Edge, Samsung Internet): the plugin registers the sync tag
  `qu-outbox` with the service worker. When the network is back, the browser wakes the worker,
  even after the tab was closed. The worker posts the sealed envelopes straight from IndexedDB to
  `POST /q/in` and clears what the relay stored.
- **Fallback** (Safari, Firefox, no service worker): the screen is kept on (Screen Wake Lock)
  while a relay is connected and the page is visible.
  The same happens when Chromium has Background Sync switched off for the site; the plugin then
  emits `qu.background.unavailable {reason}`.

`blobs` uses the same shared lock (`awakeOf(qu)`). It keeps it for uploads only when there is no
Background Sync, and for downloads always.

## push

Relay: `createRelay({ push: { subject: 'mailto:ops@example.org' } })` or `--push mailto:…` /
`QU_PUSH`. Client: `createClient({ extra: ['push'] })`.

```js
// from a click (the browser asks for permission only then):
await qu.push.enable([family, team], { labels: { [family.id]: 'Familie' }, paths: ['chat'] });
await qu.push.ring(family);                       // a call: wakes the others' devices now
qu.push.opened                                    // {sid, kind} if a notification opened the app
qu.bus.on('qu.push.open', ({ sid, kind }) => kind === 'call' && showCallScreen(sid));
await qu.push.disable([team]);                    // or disable() for everything
```

The push carries **no payload**. When it arrives, the service worker asks the relay
`POST /push/pending` what happened ("3 messages in family", "call in family") and shows it. The
labels stay on the device. Tapping opens `?qu-space=<sid>` or `?qu-call=<sid>`, or focuses the open
app, which then receives `qu.push.open`.

The relay wakes a device for a new record in a subscribed space, except when:

- the device wrote the record itself,
- the record is not under one of the `paths`, so receipts and presence wake nobody (the relay
  compares opaque shard tags),
- the device is connected right now.

Pushes are throttled per device (`minIntervalMs`, default 30 s; 30 messages are one push). A ring
is sent at once with urgency `high`. Subscribing and ringing are signed with the space's epoch
write key, so only members can do either; the relay checks the signature blind. Push services
learn when a device is woken, never anything else. iOS supports this only for web apps added to
the home screen (16.4+). Every push must show a notification, so use push for things worth one.

| Relay route | |
|---|---|
| `GET /push/key` | VAPID public key |
| `POST /push/subscribe` | `{endpoint, peer?, spaces: [{sid, epoch, sig, author?, shards?}]}` → `{accepted}` |
| `POST /push/unsubscribe` | `{endpoint, sids?}` |
| `POST /push/pending` | `{endpoint}` → `{spaces: [{sid, count, kind, at}]}` |
| `POST /push/ring` | `{sid, epoch, at, kind, sig, peer?}` → `{woken}` |

## Service worker

```js
// sw.js of the app (same origin as the app), classic script:
importScripts('https://relay.example/dist/qu-sw.js');
quServiceWorker({ db: 'qu-lite', open: '/', icon: '/icon.png',
  texts: { message: (label, n) => ({ title: label, body: `${n} neue Nachricht${n > 1 ? 'en' : ''}` }),
           call: (label) => ({ title: `Anruf – ${label}`, body: 'Tippen zum Annehmen' }) } });
// app: navigator.serviceWorker.register('/sw.js')
```

`@qu/lite/sw` exports the same as a module, and also `deliverOutbox(storage)`, `showPending(scope,
storage)` and `openFromNotification(scope, notification)` for your own worker. The worker opens the
app's IndexedDB (`db`: the `name` given to `createClient`) and reaches the relay over HTTP; the
relay origin is stored by the plugins (`bg/relay`). `dist/qu-sw.js` is about 3 KB gzipped.

## limits

`qu.use(limits({ frames = {rate: 200, burst: 400}, bytes = {rate: 1 MiB, burst: 4 MiB}, strikes = 50, windowMs = 10000 }))`

These are token buckets per connection, for any peer. Frames above the limit are dropped
(`net.limited`), and repeated strikes close the connection. Nothing is lost: the outbox and
pending reconciles retry.

The limits are announced in every link's `hi` (`limits: {frames, bytes}`, from `qu.net.inbound`).
The other side then sends at most 80 % of the rate with half the burst: frames wait in order on its
link (`links.get(peer).backlog()`, `.budget`) and bulk senders wait via `whenWritable` once half a
second of budget is queued. A big outbox therefore uploads without drops and without the
disconnect/re-upload loop (`bench/upload-rate.mjs`: 2,000 records 47 s, 195 reconnects and ~280,000
dropped frames before; 13 s, one connection, none dropped now). The guard stays for peers that
ignore the announcement. Install `limits` before the transports. Rate limits count RECORDS: a batched
`recs` frame costs one frame per record it carries (`frameUnits`, read from the length prefixes before
parsing), in the guard and in the sender's budget - batching saves bytes and work, it does not raise the
allowed rate. Throughput for big uploads is set by `--rate` (`bench/upload-rate.mjs`, 2,000 records:
11.8 s at 200/s, 3.8 s at 1,000/s).

---

## Transports

Every transport ends in the same `createLink`. Records, sync, signals and status run over any
of them unchanged.

| | |
|---|---|
| `connectInProcess(a, b, {scope?}?)` | two peers in one process (tests, examples); `{ready, disconnect(), stats, peer()}` |
| `connectWs(qu, url, opts?)` | one WebSocket with reconnect (backoff + jitter, `online` event); `{close(), connected, peer, url}` |
| `wsTransport({connect: [url], …})` | plugin form: `qu.transports.ws.{connect(url), disconnect(url?), status()}` |
| `relayTransport({url, isolate?, prefer?, wsAttempts?, retryWsMs?, wsPath?, ssePath?})` | WebSocket first (`wss://…/ws`), falls back to HTTPS + SSE (`https://…/sse`); a path in `url` is kept (`https://example.org/qu` → `wss://example.org/qu/ws`), for relays behind a proxy prefix; `qu.transports.relay.{via, urls, status(), connect(origins), disconnect()}`. `isolate: true` gives each space its own connection and network id. `url` may be an array: every relay is kept connected (redundancy; one going down changes nothing, it catches up by reconcile when back). |
| `connectSse(qu, base, opts?)` / `sseTransport({connect: [url]})` | SSE only |
| `rtc({mode, iceServers, maxMesh, fanout})` | WebRTC between members; signaling sealed through the space; `await qu.rtc.track(space)`, `qu.rtc.setMode('auto'\|'mesh'\|'relay-only')`. Needs `status`. |
| `topology({mode, mirrors, peers, maxMesh, fanout, connect})` | `star`, `mesh` or `auto` over URL endpoints; `qu.topology.{setPeers, setMode, endpoints(), close()}` |
| `listenHttp(qu, {port, host?, server?, static?, ws = true, sse = true, pingMs = 25000, statsToken?, maxFrameBytes = 8 MiB, maxConnections = 10000, maxBufferedBytes = 16 MiB, drainMs = 1000, ready?})` (Node) | one port for WebSocket upgrades, `/sse`, `/healthz`, `/readyz` (200 once `ready()` is truthy, 503 while shutting down), `/info` (incl. `protocol`) and static files; beyond `maxConnections` peers a WebSocket is closed with 1013 and SSE gets 503 (`net.refused`); `close()` is graceful (1001 to clients, terminate after `drainMs`); with `statsToken` (and the `stats` plugin) also `/stats` (JSON) and `/metrics` (Prometheus) for requests sending `Authorization: Bearer <token>` or `?token=`; `{port, close()}`. WebSocket clients are pinged every `pingMs` (keeps proxies from closing idle connections; silent clients are closed). `listenWs` is the same without SSE. |
| `httpServerTransport(opts)` / registry `ws-server`, `http-server` (Node) | plugin form; `qu.transports['ws-server'].{ready, close()}` |
| `createLink(qu, {send, close?, onUp?, onDown?, scope?})` | write your own transport: call `receive(bytes)` for incoming data and `closed()` on disconnect |

**Link rules** (every transport): `hi` carries `{peer, v}` with `v = PROTOCOL_VERSION` - a remote with a newer
version is refused (`net.error {reason: 'protocol'}`); a remote that sends no valid `hi` within
`netOf(qu).helloTimeoutMs` (15 s) or more than 8 frames before it is closed; frame types must match
`[a-z][a-z0-9_-]{0,31}`; the rate guard (`limits`) sees type and size before the frame is parsed; frames
are decoded strictly. **Backpressure**: a WebSocket or SSE stream whose send buffer exceeds `maxBufferedBytes`
(16 MiB) is closed (`net.slow`) - the peer reconnects and resumes. `qu.close()` drops every link.
**Inbound backpressure**: at most `netOf(qu).maxInflight` (64) frames per link are processed at once;
the rest wait raw and in order (`links.get(peer).inbound() → {inflight, queued, bytes, paused}`).
Above 4 MiB waiting the transport stops reading (`pause`/`resume` options of `createLink`; Node `ws`
pauses the TCP socket, the SSE server holds back its POST answer) until below 1 MiB: `net.paused` /
`net.resumed`. Frames that arrived before a link closed are still processed. `bench/inbound-load.mjs`:
6,000 small records from one fast client against a slow relay ran 2,335 frames at once and +109 MiB
heap before, 64 and +22 MiB now. **Send budget**: a remote's `hi` may carry its inbound `limits`; the link then queues frames to stay
at 80 % of them (see [limits](#limits)). **Pacing**: a transport passes `buffered()` and `maxBuffered` to `createLink`; `whenWritable(qu, peer)` (from
`src/net/link.js`) resolves once there is room (waits above `maxBuffered / 4`, at most 4 MiB, until below a
quarter of that) and returns `false` when the link went away. WebSocket, SSE server and WebRTC report their buffer.

Events: `net.peer.up {peer, via}`, `net.peer.down {peer, via}`, `net.connecting`, `net.error {via, reason, peer}`,
`net.slow {via, peer, buffered}`, `net.refused {via, reason}`,
`net.relay.transport {url, via, scoped}`, `net.rtc.open` and `net.rtc.closed`.

Example: [03-mirror-websocket.mjs](../examples/03-mirror-websocket.mjs).

## Mirror CLI and Docker

```sh
npx qu-lite-mirror --port 8787 --db ./mirror.sqlite [--host 0.0.0.0] [--allow sid1,sid2] [--static ./web]
                   [--quota-records N] [--quota-bytes N] [--max-envelope N] [--max-spaces N] [--rate 200]
                   [--stats-token SECRET] [--max-connections N] [--log-format text|json] [--repl] [--quiet]
                   [--push mailto:ops@example.org]
docker compose up --build                       # same, port 8787, data in a volume
```

`--max-spaces N` (`QU_MAX_SPACES`) limits how many spaces the relay accepts.
Every flag also has an environment variable: `QU_PORT`, `QU_HOST`, `QU_DB`, `QU_ALLOW`,
`QU_STATIC`, `QU_QUOTA_RECORDS`, `QU_QUOTA_BYTES`, `QU_MAX_ENVELOPE`, `QU_RATE` (`0` disables
rate limiting) and `QU_STATS_TOKEN` (installs `stats`, enables `/stats` and `/metrics`). Every variable can also
be read from a file named by `<NAME>_FILE` (Docker/Swarm secrets, e.g. `QU_STATS_TOKEN_FILE=/run/secrets/qu_stats_token`);
the file wins. Also `QU_MAX_CONNECTIONS` and `QU_LOG_FORMAT`. The mirror keeps its identity in its database, so clients resume after a
restart. `createRelay(options)` from `@qu/lite/node` is the same thing in code (`startMirror` in
`bin/mirror.mjs` remains as an alias). `--repl` opens an interactive console with `qu`, `dev` and `relay`
next to the running relay ([CONSOLE.md](CONSOLE.md#relay-repl)); SIGINT/SIGTERM shut down gracefully.

With `--static ./web` (the Docker image always sets it) the same port also serves the client start page
(`/`: connection check and how an app connects), the demo (`/demo.html`) and the library as one browser
module (`/dist/qu-lite.js`, or the small `/dist/qu-client.js` with on-demand chunks, built by
`node web/build.mjs`). `/healthz`, `/readyz` and `/info` are always served.
TLS and reverse proxy setups (nginx, Caddy, path prefix): [DEPLOY.md](DEPLOY.md).

---

## Events

| Topic | Payload | |
|---|---|---|
| `qu.record.<sid>` | record | a record is stored and indexed (local or remote) |
| `qu.record.superseded` | `{space, id, author}` | a keyed version was replaced |
| `qu.record.deleted` | `{space, id, gc}` or `{space, id, stale: true}` | removed by a drop list, or retired by a stale device |
| `qu.record.deferred` | `{space, id}` | waiting for membership or key data |
| `qu.record.rejected` | `{from, space?, id?, reason}` | refused (signature, rules, …) |
| `qu.record.failed` | `{from, space, id, reason}` | storage commit failed |
| `qu.record.acked` | `{sid, id, peer, role}` | a peer/mirror stored a local write |
| `qu.record.refused` | `{sid, id, reason, peer}` | a mirror refused it (quota/size) |
| `qu.space.joined` / `left` / `forgotten` | `{space}` | |
| `qu.members.changed` / `qu.members.epoch` | `{space}` / `{space, epoch}` | |
| `qu.inbox.message` | `{id, at, payload}` | |
| `qu.signal.<sid>.<type>` | `{sid, type, author, value, at, from}` | |
| `qu.status.presence` / `typing` / `receipts` | see [status](#status) | |
| `qu.stats` | snapshot | every `emitMs` (stats plugin) |
| `qu.blob.progress` / `qu.blob.done` | `{space, blob, direction, done?, total?}` | attachment transfers |
| `qu.compact.done`, `qu.envelope.dropped`, `qu.gc.expired`, `qu.scrub.done` | | maintenance |
| `sync.start`, `sync.done`, `sync.error`, `sync.busy` | `{peer, sid, …}` | reconcile sessions |
| `sync.stale` | `{peer, sid, shard, since, retired}` | a stale device retired old records instead of pushing them |
| `qu.envelope.retired` | `{sid, ids}` | envelopes removed locally (blind layer) |
| `net.peer.up` / `net.peer.down` | `{peer, via}` / `{peer, via, stats}` | `stats`: the link's final byte and frame counters |
| `net.limited` | `{peer, type, size, closed}` | rate limit hit |
| `mirror.grant` / `mirror.quota` | `{sid, …}` | |
| `net.error` / `net.slow` / `net.refused` | see [Transports](#transports) | bad frames, protocol, handshake; slow consumer closed; capacity |
| `qu.closing` / `qu.closed` | `{}` | `qu.close()` started / finished |
| `bus.error` | `{topic, error}` | a handler threw, or `bus.error(error, where)` was called |

Hooks (processes you can change): `qu.write.before` (run), `qu.accept` (emit, `ctx.stop()` /
`ctx.defer`), `qu.query.before` (emit) and `qu.compact.candidate` (emit, `ctx.stop()`).
Low-level hooks used by the blind layer are `qu.envelope.accept`, `qu.envelope.stored`,
`qu.grant.offer` and `qu.route`.

---

## live

`qu.use(live({ delayMs = 16 }))`, or `createClient({ extra: ['live'] })` – a query that answers again
whenever its result may have changed. It is a thin wrapper around `qu.query()` and the record events.

```js
const stop = qu.live({ space, path: 'chat', limit: 50, reverse: true }, (rows) => render(rows));
qu.live({ space, path: 'events', where: { start: { gte: monday } }, orderBy: 'start' }, (rows) => calendar(rows));
stop();
```

`render(rows)` runs once at once and again after records of that space and path arrive, change, are
deleted or dropped:

- **Coalesced:** a burst of records re-runs the query once (`delayMs`).
- **Only on change:** `render` runs only if the ids or versions of the result changed.
- **Errors:** they go to `onError` (third argument `{onError}`; default `bus.error`), and the
  subscription stays.
- **Closing the peer** stops every subscription.

React, for example:

```js
function useQu(query) {
  const [rows, setRows] = useState([]);
  useEffect(() => qu.live(query, setRows), [JSON.stringify(query)]);
  return rows;
}
```

## schema

`qu.use(schema(rules))`, or `createClient({ extra: [['schema', rules]] })` – what may be stored under a
path. Rules are checked when writing on this device (the write throws `QU_INVALID`) **and** when records
of other devices arrive (refused: `qu.record.rejected {reason: 'invalid: …'}`, never indexed).

```js
qu.use(schema({
  chat: 'string',                                                     // the value itself
  events: { title: 'string', start: 'number', tags: 'string[]?', 'place.city': 'string?' },
  'files/': { name: 'string', size: 'number' },                       // trailing /: every sub-path
  scores: (value, record) => value.points >= 0 || 'points must not be negative',
}));
qu.schema('polls', { question: 'string', options: 'string[]' });       // later
```

A rule is one of:

- a **type**: `string`, `number`, `boolean`, `object`, `array`, `any`; `[]` means an array of that
  type, `?` means it may be missing or null;
- a **shape**: field → type, where dots reach into nested objects and extra fields are allowed;
- a **function**: returns `true`, `false` or a reason.

Paths without a rule, internal paths (`_…`) and deletions are not checked. Records stored before a
rule existed are not checked again.

## archive

`qu.use(archive())`, or `createClient({ extra: ['archive'] })` – spaces as one file, for backup, a
move to another relay, an offline copy, or handing a group's history over.

```js
const file = await qu.archive.export({ spaces: [group] });       // Uint8Array; default: every space held here
const all  = await qu.archive.export({ passphrase });            // + identity and keys (a device backup)
await qu.archive.download({ passphrase });                       // browser: as a file

// elsewhere
const { backup } = readArchive(all);
const qu = await createClient({ url, restore: { backup, passphrase }, extra: ['archive'] });
await qu.archive.import(all);          // {spaces, stored, duplicate, rejected}; opens the restored groups first
```

What an archive holds:

- **Contents:** the sealed envelopes as stored (still encrypted and signed) and each space's grants.
  With `passphrase` it also holds a device backup (PBKDF2 + AES-GCM). Without a passphrase nobody
  without the keys can read it.
- **On import:** every grant and envelope is verified as if it came from the network, with
  signatures, quotas and rules. A changed envelope is rejected.
- **Where:** on clients and on relays (moving a relay: export there, import into the new one).
- **Format:** `QUARCH1\n`, u32 header length, header JSON `{v, created, backup?, spaces: [{sid,
  grants, count}]}`, then the envelopes (`packEnvelopes`). `readArchive(bytes)` reads it without
  importing.

## Storage format and a full disk

**Format version** (always on, one read at start; `format.js`): the store carries `qu/format`.

- New or older stores get the current version.
- Older data is migrated step by step (`MIGRATIONS`; none yet). The marker moves only after each
  step finished.
- Data of a **newer** app version is refused with `QU_FORMAT_NEWER`, so an old app never
  overwrites converted data.

**Storage full:** a write that fails because the disk or the browser quota is used up (IndexedDB
`QuotaExceededError`, SQLite `SQLITE_FULL`, `ENOSPC`) notifies `qu.storage.full {keys, reason}` (at most
every 10 s) and throws `QU_STORAGE_FULL`. Nothing half-written stays behind: a write set is atomic.

```js
qu.bus.on('qu.storage.full', async () => {
  const { usage, quota } = await qu.device.status();
  warn(`Storage full (${usage} of ${quota} bytes) - delete old files or allow more storage`);
  await qu.device.persist();
});
```

## Caches and memory

Every cache is **RAM only**: nothing of it is written to storage or sent, so caching costs no
storage and no data volume. Each cache has a hard bound.

| Cache | Where | Bound (default) | Typical use | Saves |
|---|---|---|---|---|
| decrypted records | client | 1000 records **and** 4 MiB | < 1 MB in a chat | decrypting again on every read |
| field indexes (`where`/`orderBy`) | client, only after the first such query | 64 indexes, 200,000 entries (~200 B each) | 3,000 events: ~0.6 MB | scanning and decrypting the path per query |
| path and shard tags | per space | 4,096 each | a few KB | one HMAC with key import per read/write |
| sync index (Negentropy vectors) | client and relay | client 50,000 / relay 250,000 items (~300 B each) | relay with 10,000 records: ~3 MB | rebuilding the index for every reconcile and every client |
| outbox sizes (`background`) | client | outbox size | - | reading every queued record per update |
| moderation, push subscriptions, rate buckets | relay | per space / per subscription / 50,000 buckets | small | a storage read per incoming record |

`qu.dev.memory()` shows what they hold right now (`qu.records.memory()`, `qu.sync.memory()` in
code). On a phone, lower the bounds if needed:

```js
createClient({ plugins: [['records', { cacheBytes: 1 << 20, maxIndexEntries: 50_000 }], ...CLIENT_PLUGINS.slice(1)] });
```

## Low-level building blocks

These are exported for tools, tests and custom plugins. Apps rarely need them.

- **Envelope**: `sealEnvelope(space, {path, key?, hlc, value, visibility?}, author)`,
  `openEnvelope(space, bytes, {verify?})`, `peekEnvelope(bytes)` (public header),
  `verifyEnvelope(bytes, writePub)`, `envelopeId(bytes)`, `readPublic(bytes)`,
  `paddedLength(n, mode)`.
- **Blind layer**: `envelopes({acceptGrants?})` (installed by `records()`/`mirror()`), `sxKey(header, id)`;
  `qu.envelopes.retire(sid, ids)` removes envelopes locally (no drop list), with the readers' indexes.
- **Grants**: `verifyGrants(sid, grants, state)`, `grantMessage`, `emptyGrantState`, `sidOf`,
  `userSidOf`, `inboxSidOf`, `encodeGrant`, `decodeGrant`.
- **Crypto** (`import { crypto } from '@qu/lite'`, WebCrypto only): `generateIdentity()`,
  `sign`/`verify` (Ed25519), `sealTo(xpub, bytes)`/`openSealed(xpriv, xpub, box)` (anonymous
  sealed box), `aesKey`/`aesEncrypt`/`aesDecrypt`, `hkdf`, `hmac`, `sha256`, `keypairFromSeed`,
  `randomBytes`, `toHex`/`fromHex`, `toBase64`/`fromBase64` and `concat`.
- **HLC**: `createClock({now?, maxDriftMs?})`, `formatHlc(ms, counter)`, `parseHlc(hlc)`.
- **Field values**: `compareValues(a, b)` (the order `where`/`orderBy` use), `fieldOf(record, field)`.
- **HTTP** (relay plugins): `route(qu, method, prefix, handler)` adds an endpoint to the relay's
  HTTP server (CORS for any origin); `rateLimit(rate, burst?)` a per-route ceiling (429), because
  plain HTTP bypasses the per-link limits. Built in: `POST /q/in` 20 requests/s, `GET /q/…` 200/s,
  push writes 50/s, `/push/pending` 200/s; `packEnvelopes(list)` / `unpackEnvelopes(body)` (the
  `POST /q/in` body), `httpOrigin(url)` (ws(s):// → http(s):// origin).
- **Push / background**: `pushMessage(sid, endpoint)` and `ringMessage(sid, at, kind)` (what a
  member signs with the write key), `OUTBOX_TAG` (`'qu-outbox'`, the Background Sync tag),
  `awakeOf(qu)` (the shared wake lock: `set(reason, on)`, `held`, `reasons`).
- **Transports by hand**: `attachSocket(qu, socket, options)` turns an open WebSocket into a link
  (both ends); `inprocTransport()` / `connectInProcess(a, b)` link two peers in one process
  (tests, workers).
- **Device**: `BACKUP_ITERATIONS` (PBKDF2 rounds of backups, 600,000); `unlockWithKey(store, options)`
  (what `createPeer({ unlock })` calls).
- **Security keys** (`keys.js`): `registerKey(options)`, `keySecret(options)` → `{id, secret}` (one tap
  each), `sealVault`, `openVault`, `wrapFor`, `vaultClient(relay)` (`get`/`put` of a tresor at the relay),
  `describeCredential(credential)` → `{type, transports, model, label}`.
- **Format**: `FORMAT`, `checkFormat(store, {migrations?, format?})`. **Schema**: `compileRule(rule)`.
  **Archive**: `readArchive(bytes)`.
- **Drop lists**: `GC_HORIZON_MS`, `gcCutoff(now)`, `encodeEntries`, `decodeEntries`, `mayDrop`.
- **Traffic by type**: `netOf(qu).traffic` (Map type -> `{framesIn, bytesIn, framesOut, bytesOut}`, all links
  since `trafficSince`, unknown types as `other`), `FRAME_TYPES` (type -> meaning; from `devtools.js`, so client bundles without devtools skip the texts); `stats` reports it as
  `traffic.byType` and `qu_lite_traffic_bytes_total{direction, type}` / `qu_lite_traffic_frames_total`.
- **Frames**: `encodeFrame(type, payload)`, `decodeFrame(bytes)` (strict), `peekFrameType(bytes)`,
  `PROTOCOL_VERSION`. `netOf(qu)` holds the link scopes, open links (`links`: `{via, since, version, stats}`)
  and `helloTimeoutMs`.

## Errors

Methods throw `Error`s whose message names the module, such as `records: …`, `members: …` or
`compaction: …`:

- A write vetoed by a hook rethrows the hook's error.
- A write that could not be committed throws `records: write not stored (failed: …)` and is safe to retry.
- Member rule violations throw, for example `not an active member` or `members: only the owner changes roles`.
- A plugin installed without its dependencies throws at `qu.use()`, for example `status(): install records() and members() first`.

**Error codes** (`error.code`), for the cases an app should handle on purpose:

| Code | When | What the app does |
|---|---|---|
| `QU_LOCKED` | start of a locked identity without passphrase or `unlock` (`error.unlock === 'key'`: a key is needed) | ask for the passphrase or offer "unlock with key" |
| `QU_WRONG_PASSPHRASE` | wrong passphrase (start, `changePassphrase`, `removeLock`) | ask again |
| `QU_KEY_CANCELLED` | the user dismissed the key dialog, or it timed out | offer "try again" |
| `QU_KEY_UNSUPPORTED` | no WebAuthn, or the key/passkey has no PRF | offer passphrase or backup file instead |
| `QU_KEY_UNKNOWN` | no identity registered for this key at this address | offer "create a new identity" or another key |
| `QU_KEY_EXISTS` | the key is already registered here | nothing to do |
| `QU_KEY_FAILED` | relay refused the tresor, damaged tresor | show the message, retry later |
| `QU_FORMAT_NEWER` | the stored data was written by a newer app version | ask the user to update (never downgrade data) |
| `QU_STORAGE_FULL` | disk or browser quota used up (also the event `qu.storage.full`) | tell the user, `qu.device.persist()`, free space; the write can be retried |
| `QU_INVALID` | a write fails its schema rule (`schema` plugin) | show which field is wrong |
| `QU_ARCHIVE_INVALID` | not an archive, or a damaged one | ask for the right file |

Refusals of records (from relays or members) are not thrown: they arrive as `qu.record.rejected
{reason}` and, from a relay, as `net.in.<peer>.nack {reason}`. Reasons include `'quota'`, `'rate'`,
`'banned'`, `'too large'`, `'invalid: …'` and `'removed'`. The outbox keeps refused local records and
retries them.

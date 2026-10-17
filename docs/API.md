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
  [text](#text) · [mirror](#mirror) · [limits](#limits)
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
| `@qu/lite/node` | Node | `nodeRegistry`, `sqliteDriver`, `listenHttp`, `listenWs`, `httpServerTransport`, `wsServerTransport`, plus `createPeer`/`defaultRegistry` |
| `@qu/lite/sqlite` | Node ≥ 22.5 | `sqliteDriver` (`node:sqlite`) |
| `@qu/lite/ws-server` | Node | `listenHttp`, `listenWs`, `httpServerTransport`, `wsServerTransport` |
| `qu-lite-mirror` (bin) | Node | relay/mirror CLI, see [Mirror CLI](#mirror-cli-and-docker) |

The library is plain ES modules and needs no build step. It has one runtime dependency,
`ws`, used only on Node. Bundlers include an optional plugin (`text`, `rtc`/`topology`,
`relayTransport`/SSE) only if you import it.

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
| Chat/group app | `records`, `user`, `members`, `inbox`, `sync`, `status`, `compaction` (+ `text`) |
| Mirror/relay | `limits`, `sync({ role: 'mirror' })`, `mirror` |

Dependencies: `user` needs `records`. `inbox` needs `records` and `user`. `status` needs
`records` and `members`, and installs `signals` itself. `text` and `compaction` need `records`.
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

The peer gets `qu.root`, the root driver, for example to call `qu.root.close()` on SQLite.

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
  `compaction`, `limits`, `text`, `topology`
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
| `qu.use(plugin)` | installs a plugin and returns its API |
| `qu.mount(base, driver)` / `qu.unmount(base)` | mounts a driver on a key prefix |

Plugins add more members to `qu`, listed with each plugin below.

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

---

## Storage

| Driver | Import | |
|---|---|---|
| `memoryDriver()` | `@qu/lite` | in memory |
| `indexedDbDriver({name?, store?, indexedDB?, IDBKeyRange?})` | `@qu/lite` | browser; defaults `name: 'qu-lite'`, `store: 'kv'` |
| `sqliteDriver({path?})` | `@qu/lite/sqlite` | Node ≥ 22.5, WAL, one table; default `':memory:'`; `close()` |

**Driver contract**: `get(key)`, `set(key, value)`, `remove(key)` and `keys(prefix)`.
Optional: `has(key)`, `range(prefix, {gte, lt, limit, reverse})` and `batch(ops)` for an atomic
multi-key write, where `ops` is `[{op: 'set'|'remove', key, value?}]`. Values are
structured-clonable (objects, Uint8Array). Keys are `/`-separated. Every driver sees the
**full** key.

**Mounts** follow unstorage: the longest prefix wins and the root `''` is always mounted.
`createMountRouter({root, bus})` is the router that `createQu` uses. A batch is atomic within
a mount, not across mounts.

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

`qu.use(records({ author?, cacheSize?, padding? }))` – read and write records of joined spaces.
This plugin installs the blind envelope layer.

| Option | Default | |
|---|---|---|
| `author` | `'alias'` | default signing key for group spaces (`'identity'` signs with the identity; user nodes always use the identity) |
| `cacheSize` | `1000` | decrypted records kept in memory |
| `padding` | `'quarter'` | private inners padded to size steps: `'quarter'`, `'pow2'` or `'none'` |

| Method | |
|---|---|
| `qu.join(space, {author?, mirror = true}?) → space` | starts reading/writing a space; `mirror`: announce its write keys to mirrors |
| `qu.leave(space)` | stops using a space. With `status()` installed, `qu.leave()` is the clean presence leave instead; use `qu.records.leave(space)`. |
| `qu.write(space, path, value, {key?, visibility?}?) → record` | `value`: any JSON. `key`: last-write-wins entry. `visibility: 'public'`: signed, not encrypted. Throws if a hook vetoes or the commit fails (retryable). |
| `qu.get(space, path, key) → value \| null` | current value of a keyed entry (`null` if missing or deleted) |
| `qu.query({space, path, from?, to?, limit?, reverse?, ensure?}) → record[]` | one path, ordered by HLC; `from` inclusive and `to` exclusive (ms); `ensure: true` reconciles the window first (needs `sync`) |
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
| `maxSessionsPerPeer` | `8` | concurrent responder sessions per peer |
| `frameSizeLimit` | `0` | Negentropy frame size limit (0 = none) |
| `stale` | `'retire'` | a scope not completely synced for longer than the drop-list horizon retires old records the peer lacks instead of pushing them (they may have been deleted meanwhile); `'push'`: push anyway |

| Method | |
|---|---|
| `qu.watch({space, path?, from?, to?}) → unwatch` | subscribes and reconciles exactly this scope (whole space, one path's shard, optional time window) with every peer, now and on every connect |
| `qu.resync({space, path?, from?, to?, peer?}) → result[]` | reconciles now; result: `{peer, sid, shard, sent, received, missing, error?}` |
| `qu.syncStatus() → {outbox, pending}` | what still waits |
| `qu.syncState(sid, id) → 'pending' \| 'sent'` | whether a local write left the outbox |
| `qu.lastSync(sid, shard?) → ms \| null` | start of the last complete reconcile of the space (or shard) |
| `qu.staleSpaces() → [{sid, last}]` | spaces this device has not completely synced within the horizon - check at start-up to warn the user |

`members()`, `user()` and `inbox()` call `watch()` for their spaces themselves.

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
const invite = await m.invite();                 // link/QR: {type:'invite', secret, owner, epochs, admins, token}
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
| `invite(identityPub?, {role}?)` | admin only; `role`: `'member'` or `'admin'` |
| `reveal({name}?)` | optional, verifiable "alias X is identity Y" (visible to members only) |
| `promote(alias, role)` | owner only; re-signs the admin list |
| `remove(alias) → epoch` | admin; role → `removed`, new epoch for everyone else |
| `rotate() → epoch` | admin; new epoch, e.g. after a suspected key leak |

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
| `interval` | `20000` | presence heartbeat; online = heartbeat younger than 2.5 × interval |
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
```

Events: `qu.status.presence {space, alias, online}`, `qu.status.typing {space, path, typing}` and
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

## mirror

`qu.use(mirror({ allow = null, quota = null, maxEnvelopeBytes = 262144, expireEveryMs }))` on a
peer with `sync({ role: 'mirror' })` and **without** `records()`.

| Option | |
|---|---|
| `allow` | list of sids to serve (`null`: any that is granted) |
| `quota` | `{records?, bytes?}` per space; refused envelopes produce `qu.record.refused` at the sender, whose outbox keeps them |
| `maxEnvelopeBytes` | size limit per envelope |

API: `qu.mirror.ready` resolves to the served sids. Also `spaces()`, `count(sid)`, `usage(sid)`,
`writeKeys(sid)`, `admins(sid)` and `expire()`. Events: `mirror.grant {sid, changed}` and
`mirror.quota {sid, usage}`.

## limits

`qu.use(limits({ frames = {rate: 200, burst: 400}, bytes = {rate: 1 MiB, burst: 4 MiB}, strikes = 50, windowMs = 10000 }))`

These are token buckets per connection, for any peer. Frames above the limit are dropped
(`net.limited`), and repeated strikes close the connection. Nothing is lost: the outbox and
pending reconciles retry.

---

## Transports

Every transport ends in the same `createLink`. Records, sync, signals and status run over any
of them unchanged.

| | |
|---|---|
| `connectInProcess(a, b, {scope?}?)` | two peers in one process (tests, examples); `{ready, disconnect(), stats, peer()}` |
| `connectWs(qu, url, opts?)` | one WebSocket with reconnect (backoff + jitter, `online` event); `{close(), connected, peer, url}` |
| `wsTransport({connect: [url], …})` | plugin form: `qu.transports.ws.{connect(url), disconnect(url?), status()}` |
| `relayTransport({url, isolate?, prefer?, wsAttempts?, retryWsMs?, wsPath?, ssePath?})` | WebSocket first (`wss://…/ws`), falls back to HTTPS + SSE (`https://…/sse`); `qu.transports.relay.{via, status(), disconnect()}`. `isolate: true` gives each space its own connection and network id. |
| `connectSse(qu, base, opts?)` / `sseTransport({connect: [url]})` | SSE only |
| `rtc({mode, iceServers, maxMesh, fanout})` | WebRTC between members; signaling sealed through the space; `await qu.rtc.track(space)`, `qu.rtc.setMode('auto'\|'mesh'\|'relay-only')`. Needs `status`. |
| `topology({mode, mirrors, peers, maxMesh, fanout, connect})` | `star`, `mesh` or `auto` over URL endpoints; `qu.topology.{setPeers, setMode, endpoints(), close()}` |
| `listenHttp(qu, {port, host?, server?, static?, ws = true, sse = true})` (Node) | one port for WebSocket upgrades, `/sse` and static files; `{port, close()}`. `listenWs` is the same without SSE. |
| `httpServerTransport(opts)` / registry `ws-server`, `http-server` (Node) | plugin form; `qu.transports['ws-server'].{ready, close()}` |
| `createLink(qu, {send, close?, onUp?, onDown?, scope?})` | write your own transport: call `receive(bytes)` for incoming data and `closed()` on disconnect |

Events: `net.peer.up {peer, via}`, `net.peer.down {peer, via}`, `net.connecting`, `net.error`,
`net.relay.transport {url, via, scoped}`, `net.rtc.open` and `net.rtc.closed`.

Example: [03-mirror-websocket.mjs](../examples/03-mirror-websocket.mjs).

## Mirror CLI and Docker

```sh
npx qu-lite-mirror --port 8787 --db ./mirror.sqlite [--host 0.0.0.0] [--allow sid1,sid2] [--static ./public]
                   [--quota-records N] [--quota-bytes N] [--max-envelope N] [--rate 200] [--quiet]
docker compose up --build                       # same, port 8787, data in a volume
```

Every flag also has an environment variable: `QU_PORT`, `QU_HOST`, `QU_DB`, `QU_ALLOW`,
`QU_STATIC`, `QU_QUOTA_RECORDS`, `QU_QUOTA_BYTES`, `QU_MAX_ENVELOPE` and `QU_RATE` (`0` disables
rate limiting). The mirror keeps its identity in its database, so clients resume after a
restart. `startMirror(options)` from `bin/mirror.mjs` is the same thing in code.

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
| `qu.compact.done`, `qu.envelope.dropped`, `qu.gc.expired`, `qu.scrub.done` | | maintenance |
| `sync.start`, `sync.done`, `sync.error`, `sync.busy` | `{peer, sid, …}` | reconcile sessions |
| `sync.stale` | `{peer, sid, shard, since, retired}` | a stale device retired old records instead of pushing them |
| `qu.envelope.retired` | `{sid, ids}` | envelopes removed locally (blind layer) |
| `net.peer.up` / `net.peer.down` | `{peer, via}` | |
| `net.limited` | `{peer, type, size, closed}` | rate limit hit |
| `mirror.grant` / `mirror.quota` | `{sid, …}` | |
| `bus.error` | `{topic, error}` | a handler threw |

Hooks (processes you can change): `qu.write.before` (run), `qu.accept` (emit, `ctx.stop()` /
`ctx.defer`), `qu.query.before` (emit) and `qu.compact.candidate` (emit, `ctx.stop()`).
Low-level hooks used by the blind layer are `qu.envelope.accept`, `qu.envelope.stored`,
`qu.grant.offer` and `qu.route`.

---

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
- **Drop lists**: `GC_HORIZON_MS`, `gcCutoff(now)`, `encodeEntries`, `decodeEntries`, `mayDrop`.
- **Frames**: `encodeFrame(type, payload)`, `decodeFrame(bytes)`. `netOf(qu)` holds the link
  scopes.

## Errors

Methods throw `Error`s whose message names the module, such as `records: …`, `members: …` or
`compaction: …`:

- A write vetoed by a hook rethrows the hook's error.
- A write that could not be committed throws `records: write not stored (failed: …)` and is safe to retry.
- Member rule violations throw, for example `not an active member` or `members: only the owner changes roles`.
- A plugin installed without its dependencies throws at `qu.use()`, for example `status(): install records() and members() first`.

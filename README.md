# @qu/lite

A small, event-driven Qu core. Milestones 1-4: kernel, mounts, spaces and user nodes, a privacy-first
envelope, robust sync (Negentropy reconciliation, partial sync, resync/repair, durable outbox and
resumable reconciles), persistent drivers (IndexedDB, SQLite), transports as plugins (WebSocket first),
one peer base for clients and relays/mirrors, a Docker relay and a two-browser demo.

**Try it:** `npm run lite:demo` (or `docker compose -f docker-compose.lite.yml up --build`), then open
`http://localhost:8787/?name=alice` and `http://localhost:8787/?name=bob` in two browsers, create a group,
share the invite link, write, disconnect, reload - and watch the event log.

```js
import { createQu, records, sync, Space, connectInProcess } from '@qu/lite';

const qu = await createQu();
qu.use(records());
const space = qu.join(await Space.create());

qu.bus.on('qu.write.before', (draft) => ({ value: draft.value.trim() })); // hook
qu.bus.on(`qu.record.${space.id}`, (rec) => console.log(rec.path, rec.value)); // listener

await qu.write(space, 'chat/general', ' hallo ');
await qu.write(space, 'profile', 'Anna', { key: 'name' }); // last-write-wins
await qu.query({ space, path: 'chat/general', from: Date.now() - 3600_000 });

qu.use(sync());                                        // reconciliation plugin
const unwatch = await qu.watch({ space, path: 'chat' }); // sync only what the app mounts
await qu.query({ space, path: 'chat', from, to, ensure: true }); // reconcile the window first
await qu.resync({ space });                            // manual full resync
await qu.scrub(space);                                 // local integrity repair
await qu.syncStatus();                                 // { outbox, pending } still waiting
```

- **Kernel** (`qu.js`): `EventBus` (`@qu/events`) + mount router + registry; everything else is `qu.use(plugin)`.
- **Mounts** (`mount.js`): unstorage-style, longest prefix wins; drivers implement `get/set/remove/keys`, optionally `range`.
- **Space** (`space.js`): group spaces (32-byte secret → opaque `sid`, shard/tag HMAC keys, epoch keys, per-epoch write key; `rotate()`/`acceptEpoch()` for member removal) and user nodes (`Space.user(pubkey, identity?)`); `authorFor(identity)` gives the per-space alias.
- **Envelope** (`envelope.js`, v2): see *Privacy model* below - both signatures over the ciphertext, author = alias. One ciphertext per record, no recipient list.
- **Records** (`records.js`): `write/get/query/scrub` for members; write = `qu.write.before` → seal → `envelopes.ingest`; read = `qu.envelope.stored` → open → drift check → `qu.accept` (stoppable) → pointer index → `qu.record.<sid>`.
- **Network** (`net/link.js`): one link maps `net.out.<peer>.*` to `net.in.<peer>.*` on the other side; transports (in-process, WebSocket) only move bytes.
- **Sync** (`sync/sync.js`): Negentropy range-based set reconciliation over the public sync index
  (`sx/<sid>/<shard>/<ts>-<id>`) - cost grows with the difference, not the history (test: 10,000
  records + 1 offline change reconcile in ~2 KB vs. ~3.5 MB for a replay). `watch()` subscribes
  and reconciles exactly a space / path shard / time window; live records are routed only to
  peers that subscribed. A mirror is a peer with `role: 'mirror'` that watches whole spaces.
- **Durability**: every local write sits in `sync/out/` until a peer (or, with `ackFrom: 'mirror'`,
  a mirror) acks it, and is re-pushed on every connect; every reconcile is recorded in
  `sync/pending/<peer>/` until it completes and is resumed on reconnect and every `retryMs`. Both
  live in storage, so a reload or a dropped connection loses nothing.
- **Negentropy** (`sync/negentropy.js`): vendored from hoytech/negentropy (MIT), as an ES module,
  with its varint coding fixed for values >= 2^31 (upstream loops forever on ms timestamps).

## Persistence, network, mirror (milestone 3)

```js
import { createQu, records, sync, Space, connectWs, indexedDbDriver } from '@qu/lite';

const qu = await createQu({ root: indexedDbDriver() });       // browser; Node: sqliteDriver from '@qu/lite/sqlite'
qu.use(records());
qu.use(sync({ ackFrom: 'mirror' }));                           // outbox clears only once a mirror stored it
const space = qu.join(await Space.open(secret));
connectWs(qu, 'ws://localhost:8787');                          // reconnects with backoff, and on `online`
```

```sh
npm run lite:mirror -- --port 8787 --db ./mirror.sqlite      # or: node packages/lite/bin/mirror.mjs
```

- **Drivers**: `indexedDbDriver()` (browser, one object store, cursor ranges) and `sqliteDriver()`
  (`node:sqlite`, Node >= 22.5, WAL, one `WITHOUT ROWID` table). Same contract as `memoryDriver()`.
- **WebSocket** (`net/ws.js`, `net/ws-server.js`): the bridge contract over a socket; binary frames
  (`net/frame.js`) - byte fields travel raw, not base64. Clients reconnect with backoff + jitter.
- **Mirror** (`mirror.js`, `bin/mirror.mjs`): a policy on an always-on peer without `records()`. The sid is
  `SHA-256(epoch-0 write key)[0..16]` (user nodes: `SHA-256('qu-lite/user' || pubkey)`), so a peer's `grant`
  (sent to mirrors on connect) is self-certifying; later epochs are signed by the previous epoch's write
  key. The mirror verifies both signatures and stores envelopes + sync index - no space secret, no plaintext. Its
  identity lives in its database, so clients can resume pending syncs across mirror restarts.
- **Topology** (`net/topology.js`): `star` (mirrors only), `mesh` (mirrors + all known peers) or
  `auto` (mesh up to `maxMesh`, then mirrors + `fanout` peers, keeping open links).
  Browser-to-browser links need WebRTC, which is not part of this package yet.
- **Keyed records**: superseded versions leave the query index but keep their envelope, so a mirror
  that can't read keys and every peer hold the same set; pruning is a later compaction step.

## Privacy model (milestone 4)

- **Envelope v2** (`envelope.js`): public header = version, visibility, opaque `sid`, opaque shard tag,
  epoch, minute, author key; then the author's signature and the space-membership signature, both
  **over the ciphertext** - any peer, relay or mirror verifies a stored record without reading it.
  Path, key, precise time and value are encrypted (or, for `visibility: 'public'`, signed plaintext).
- **Authors are aliases**: `space.authorFor(identity)` derives a per-space Ed25519 key from the
  identity's private key - the same on all of a person's devices, unlinkable to the identity and
  across spaces. A member can reveal "alias X is identity Y" inside the (encrypted) space.
- **Network id** (`qu.peerId`): random per device, persisted, rotatable - never derived from the identity.
- **User nodes** (`user.js`, `Space.user`): a space reachable by pubkey, writable only by its owner.
  `profile/*` fields are public (e.g. `epub`, name), `private/*` fields are readable only by the
  owner's devices; visitors subscribe only to the public shard.
- **Storage is sealed**: `rec/` holds the signed envelopes; indexes hold pointers and HMAC'd path/key
  tags only; reads decrypt on demand. Grants (write *public* keys) go to mirrors only.
- Still visible: IP and timing at the relay, which opaque sids a connection subscribes to, size and
  minute of a record, and records of the same alias as "same pseudonym" within a space.

## One peer base, transports as plugins (milestone 4)

- `envelopes.js` is the single blind ingest path for every peer (policy hook, dedupe, keyring,
  verify, store, route, ack). `records.js` is only a member's reader/writer on top of it;
  `mirror.js` is only a policy (verify grants into the keyring, allow-list, watch whole spaces,
  forward what it pulls). A relay is `createPeer()` with other registry entries:

```js
import { createPeer } from '@qu/lite';                      // browser / any
import { nodeRegistry } from '@qu/lite/node';               // + sqlite, ws-server

const browser = await createPeer({ store: ['indexeddb', { name: 'me' }], plugins: ['records', 'user', 'sync'],
                                   transports: [['ws', { connect: ['wss://relay.example/ws'] }]] });
const relay = await createPeer({ registry: nodeRegistry(), store: ['sqlite', { path: 'relay.sqlite' }],
                                 plugins: [['sync', { role: 'mirror' }], 'mirror'],
                                 transports: [['ws-server', { port: 8787, static: './demo' }]] });
```

- `net/link.js` holds handshake, framing and bus wiring once; a transport only moves bytes
  (`createLink(qu, {send, close})`, then `receive(bytes)` / `closed()`). WebSocket client/server and
  the in-process test transport use it; WebRTC and HTTPS+SSE are planned on the same contract.

## Next milestones

5 space management & secure epochs (admin-signed chain, `_members`/`_keys` records, invites via user
nodes) · 6 status (presence, delivered/read cursors) · 7 WebRTC + browser mesh · 8 HTTPS+SSE transport ·
9 atomic writes · 10 compaction & deletion · 11 mirror hardening & metadata padding · 12 collaborative
text (optional).

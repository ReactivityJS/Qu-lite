# @qu/lite

A small, event-driven Qu core. Milestones 1-3: kernel, mounts, Space keys, metadata-hiding
envelope, records as bus processes, robust sync (Negentropy reconciliation, partial sync,
resync/repair, durable outbox and resumable reconciles), persistent drivers (IndexedDB, SQLite),
WebSocket transport with auto-reconnect, mesh/star topology and a key-less mirror.

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
- **Space** (`space.js`): 32-byte secret → opaque `sid`, shard HMAC key, epoch keys, per-epoch write key; `rotate()`/`acceptEpoch()` for member removal; `Space.forUser(identity)`.
- **Envelope** (`envelope.js`): public header is only `sid`, `shard`, `epoch`, minute-rounded `ts`, plus the space write signature; path, key, precise HLC, author and value are encrypted and author-signed inside. One ciphertext per record, no recipient list.
- **Records** (`records.js`): `write/get/query`; write = `qu.write.before` → seal → store → `qu.record.<sid>` → `net.out.<peer>.rec`; receive = dedupe → open → drift check → `qu.accept` (stoppable) → store → forward.
- **Network** (`net/inproc.js`): a bridge maps `net.out.<peer>.*` to `net.in.<peer>.*` on the other bus.
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
- **Mirror** (`mirror.js`, `bin/mirror.mjs`): replaces `records()` on an always-on node. The sid is
  `SHA-256(epoch-0 write key)[0..16]`, so a peer's `grant` (sent automatically on connect) is
  self-certifying; later epochs are signed by the previous epoch's write key. The mirror verifies
  outer signatures and stores envelopes + sync index - no space secret, no plaintext. Its
  identity lives in its database, so clients can resume pending syncs across mirror restarts.
- **Topology** (`net/topology.js`): `star` (mirrors only), `mesh` (mirrors + all known peers) or
  `auto` (mesh up to `maxMesh`, then mirrors + `fanout` peers, keeping open links).
  Browser-to-browser links need WebRTC, which is not part of this package yet.
- **Keyed records**: superseded versions leave the query index but keep their envelope, so a mirror
  that can't read keys and every peer hold the same set; pruning is a later compaction step.

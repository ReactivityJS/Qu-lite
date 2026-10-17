# @qu/lite

A small, event-driven, offline-first sync core with end-to-end encryption - no runtime dependencies
besides WebCrypto (and `ws` on Node). Kernel, mounts, spaces and user nodes, a privacy-first envelope,
robust sync (Negentropy reconciliation, partial sync, resync/repair, durable outbox and resumable
reconciles), atomic writes, persistent drivers (IndexedDB, SQLite), transports as plugins (WebSocket,
HTTPS + SSE fallback, WebRTC), one peer base for clients and relays/mirrors, group membership with roles,
admin-signed key epochs, anonymous key packages, per-user inboxes, status (online, typing, sent,
delivered, read), deletion and compaction, a hardened mirror (quotas, rate limits, padding, one
connection per space) and - optional - collaborative text. Started as `packages/lite` in [QuV5](https://github.com/ReactivityJS/QuV5); it
shares no code with the rest of Qu. Design reasons and known limits: [docs/DECISIONS.md](docs/DECISIONS.md).

**Documentation:** [API reference](docs/API.md) · [runnable examples](examples/) (records, sync, mirror over
WebSocket, groups, status, deleting, collaborative text - each one runs with `node examples/<file>`) ·
[changelog](CHANGELOG.md).

```sh
npm install
npm test                # all tests, including two Playwright browser tests (skipped without Chromium)
npm run test:unit       # without the browser tests
node examples/02-sync.mjs   # any example from examples/
npm run demo            # build the demo and serve it with a local mirror on :8787
npm run mirror -- --port 8787 --db ./mirror.sqlite
docker compose up --build
```

**Size** (minified + gzip, browser): core (records, sync, WebSocket, IndexedDB) ~18.5 KB; with members,
user nodes, inbox, status and compaction ~26.6 KB; everything incl. SSE fallback, WebRTC and
collaborative text ~31.5 KB. The optional plugins (`text`, `rtc`/`topology`, `relayTransport`/SSE) are
only bundled when imported.

**Try it:** `npm run demo` (or `docker compose up --build`), then open
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

- **Kernel** (`qu.js`): `Bus` (`bus.js`) + mount router + registry; everything else is `qu.use(plugin)`.
- **Crypto** (`crypto.js`): WebCrypto only - Ed25519, X25519, AES-GCM, HKDF/HMAC, seeded key pairs and an anonymous sealed box.
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
const space = qu.join(await Space.open(invite));                // invite = {secret, owner}, see space.invite
connectWs(qu, 'ws://localhost:8787');                          // reconnects with backoff, and on `online`
```

```sh
npm run mirror -- --port 8787 --db ./mirror.sqlite           # or: npx qu-lite-mirror
```

- **Drivers**: `indexedDbDriver()` (browser, one object store, cursor ranges) and `sqliteDriver()`
  (`node:sqlite`, Node >= 22.5, WAL, one `WITHOUT ROWID` table). Same contract as `memoryDriver()`.
- **WebSocket** (`net/ws.js`, `net/ws-server.js`): the bridge contract over a socket; binary frames
  (`net/frame.js`) - byte fields travel raw, not base64. Clients reconnect with backoff + jitter.
- **Mirror** (`mirror.js`, `bin/mirror.mjs`): a policy on an always-on peer without `records()`. The sid is
  `SHA-256(epoch-0 write key || owner)[0..16]` (user nodes: `SHA-256('qu-lite/user' || pubkey)`), so a peer's `grant`
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

## Members, epochs, inbox (milestone 5)

```js
const group = await qu.createGroup();                  // I am the owner (through my alias)
const members = await qu.members(group);
await members.invite(bobPubHex);                       // sealed box into Bob's inbox
const link = await members.invite();                   // or an invite object for a link
// Bob:
qu.bus.on('qu.inbox.message', ({ payload }) => payload.type === 'invite' && qu.acceptInvite(payload));
// later:
await members.promote(carolAlias, 'admin');            // owner signs the admin list
await members.remove(bobAlias);                        // role -> removed, new epoch for everyone else
await members.reveal({ name: 'Alice' });               // optional, verifiable, members-only
await qu.restoreGroups();                              // after a reload
```

- **Owner and admins sign the epoch chain** (`space.js` grants): a group's sid certifies epoch 0's write
  key *and* the owner; the owner signs the admin list; the owner or an admin signs every later epoch. A
  mirror and every member verify the same chain - a removed member can no longer announce (and so block)
  the next epoch.
- **Everything is a record in the space** (`members.js`): `_members/<alias>` (role, alias-X25519 key,
  optional reveal), `_grants/admins`, and `_keys/<epoch>` - the new epoch key as **anonymous sealed boxes**,
  one per remaining member, padded to a multiple of 8, published (public visibility) under the old epoch
  so members receive it by sync without anyone learning which box is whose.
- **Rules on every record**: owner/admins manage members and keys; a member edits only its own entry and
  cannot change its role; newcomers need an admin-signed, single-use invite token; records of removed
  members written after the removal are refused. What cannot be decided yet (membership or key not
  synced) is **deferred** and re-checked automatically (`records.reindex`).
- **Inbox** (`inbox.js`): one mailbox per identity, addressed by pubkey, writable by anyone with a public
  write key, messages are sealed boxes to the owner's `epub` signed by one-time keys - the relay sees
  "mailbox X got N bytes", nothing more. `inbox({ enabled: false })` makes you unreachable this way.
- **Local state survives reloads**: kept epoch keys (`members/keys/`) and joined groups (`members/groups/`).

## Status (milestone 6)

```js
qu.use(status());                                      // options: interval, presence, readReceipts
const st = await qu.status(group);
st.isOnline(alias); st.typing('chat');                 // presence & typing of the others
await st.sendTyping('chat');
await st.markRead('chat');                             // my read cursor for this conversation
await st.of(record);                                   // {sent, delivered: [aliases], read: [aliases], members}
await qu.signal(group, 'wave', { hi: true });          // any ephemeral event of your own
```

- **Signals** (`signals.js`): ephemeral remote events - sealed, signed, encrypted envelopes like records,
  sent as `sig` and **never stored** (not at peers, not at the mirror, never in sync). Receivers check
  freshness (60 s), dedupe by id (replays), verify both signatures and the member rules; a mirror
  forwards verified signals to its subscribers without reading them.
- **Presence and typing** are signals: a heartbeat every `interval`, an immediate answer to newcomers
  and a re-announce when the member list changes, `offline` on a clean leave (`pagehide`), typing
  expiring after 5 s. `status({ presence: false })` never announces you.
- **Sent / delivered / read** with no per-message overhead: *sent* = the envelope left the outbox (a
  mirror stored it); *delivered* and *read* are ONE cursor record per member and conversation
  (`_receipts/<path>`, key = own alias, `{delivered, read}`), raised automatically on arrival and by
  `markRead()`; only its owner may write it. `status({ readReceipts: false })` sends delivered only.

## WebRTC (milestone 7)

```js
const qu = await createPeer({ store: ['indexeddb', { name: 'me' }],
  plugins: ['records', 'user', 'members', 'inbox', 'sync', 'status'],
  transports: [['ws', { connect: [relay] }], ['webrtc', { mode: 'auto', iceServers: [{ urls: 'stun:…' }] }]] });
await qu.rtc.track(group);                             // direct links to online members of this group
await qu.rtc.setMode('relay-only');                    // privacy: never reveal your IP to members
```

- **Just another transport** (`net/webrtc.js`): a DataChannel is a byte channel for `createLink`, so sync,
  records, signals and status run over it unchanged. The relay stays connected (durability, members who
  are offline); duplicates arriving both ways are deduplicated by id.
- **Signaling through the space**: offer, answer and ICE candidates travel as `rtc` signals whose payload is
  an anonymous sealed box to the target's alias key - the relay and the other members see neither SDP nor
  candidates (no IP addresses). The member with the smaller alias offers (no glare).
- **Topology**: `mesh` (all online members), `auto` (mesh up to `maxMesh`, then `fanout` peers chosen by a
  per-peer rendezvous hash so links spread), `relay-only` (no direct links; switchable at runtime).
- Tested with a fake RTCPeerConnection in Node and with real WebRTC between two Chromium instances, which
  keep chatting after the relay is shut down.

## HTTPS + SSE fallback (milestone 8)

```js
qu.use(relayTransport({ url: 'https://relay.example' }));  // wss://…/ws, falls back to https://…/sse
qu.transports.relay.via;                                     // 'ws' | 'sse'
qu.use(sseTransport({ connect: ['https://relay.example/sse'] }));   // SSE only
```

- **Server** (`net/ws-server.js` `listenHttp` / transport `http-server`): one port for WebSocket upgrades,
  `GET/POST /sse/<session>` and static files. `bin/mirror.mjs` serves both transports.
- **SSE** (`net/sse.js`, `net/sse-server.js`): down = one long-lived event stream (one link frame per event,
  base64), up = frames batched per tick and POSTed in order (`u32 length || frame`). The session id is 128
  random bits from the client and valid only while its stream is open. The client uses streaming `fetch`
  (browsers and Node), reconnects with backoff, and ends in the same `createLink` as every transport.
- **Fallback** (`net/relay.js`): WebSocket first; after `wsAttempts` failures - refused, or hanging past
  `connectTimeoutMs`, as blocking proxies often do - it switches to SSE and retries WebSocket every
  `retryWsMs`. The demo uses it (`&transport=sse` forces SSE); the e2e test runs one browser over SSE.
- Cost: server-to-client frames are base64 (+33 %); client-to-server stays binary.

## Atomic writes (milestone 9)

- **One envelope, one batch**: the sealed envelope (`rec/`), its sync-index entry (`sx/`), the pointer indexes
  (`idx/`, `head/`, `loc/`, `defer/`) and - for a local write - its outbox entry (`sync/out/`) are collected in
  a write set (`src/writeset.js`) and committed with ONE `storage.batch()`. A crash or a failing disk leaves
  either all of them or none: no envelope without index, no unindexed outbox entry, no index pointing nowhere.
- **Drivers**: `batch(ops)` is atomic in memory, SQLite (`BEGIN IMMEDIATE … COMMIT`, rollback on error) and
  IndexedDB (one readwrite transaction). The mount router batches per mount: atomic within a mount, not across
  mounts. A driver without `batch()` still works (ops run one by one).
- **Events after commit**: `qu.record.<sid>`, `superseded`, `deferred` and the read cache run via
  `ws.after()` - only once the data is durable. A failed commit yields status `failed` and
  `qu.record.failed`; `qu.write()` throws (and can be retried), a received record is fetched again by the next
  resync (it was never acknowledged).
- **LWW without races**: which version of a keyed entry is current is decided inside a short per-space commit
  lock (`ws.locked()`), against the committed heads; decryption and hooks run outside it. `reindex()` and
  `scrub()` repair one record per write set under the same lock.

## Deleting and compaction (milestone 10)

```js
qu.use(compaction());                       // registry name 'compaction'
await qu.del(space, record);                // a message: gone at every peer and the mirror
await qu.del(space, 'settings', 'theme');   // a keyed entry: tombstone
await qu.compact(space, { all: true });     // superseded versions (all: owner/admin)
qu.forget(space);                           // local only: drop everything stored for a space
```

- **Drop lists** (`src/gc.js`): a public, signed envelope at `<segment>/_gc` (same shard as its targets) listing
  `id ‖ ts ‖ author` per target - data that is public in the target's header anyway. Every peer and the blind
  mirror apply it in the shared envelope layer, in the same atomic write set: an entry counts if its signer
  wrote the target, is the space's owner/admin (verified grants) or owns the inbox. Members additionally check
  the drop list like any record (active member).
- **Nothing comes back**: the target's sync-index entry stays as a *gone* item, so reconcile transfers nothing;
  a peer asking for a dropped id gets the drop list instead and verifies it itself; a stale device re-pushing an
  old version is refused (`gone`), and learns the drop list by reconcile. A gone marker whose author claim does
  not match the real record is ignored.
- **Tombstones**: deleting a keyed entry writes a `deleted` version that stays the head - an older version
  arriving later stays superseded. `get()` returns `null`.
- **Auto-compaction**: your own superseded versions (profile fields, `_receipts` cursors, settings) are collected
  and dropped in one drop list after `delayMs` (60 s). `qu.compact.candidate` can veto; `_keys`/`_grants` are kept.
- **Horizon**: drop lists and their gone markers expire after `GC_HORIZON_MS` (90 days, a protocol constant cut at
  day boundaries, so every peer and the mirror expire the same set). Limit: a device offline for longer can bring
  dropped entries back.
- Events: `qu.record.deleted`, `qu.envelope.dropped`, `qu.compact.done`, `qu.gc.expired`.

## Mirror hardening and metadata (milestone 11)

```js
mirror({ quota: { records: 100_000, bytes: 1 << 30 }, maxEnvelopeBytes: 256 * 1024 })
qu.use(limits({ frames: { rate: 200, burst: 400 } }))       // per connection, any peer
qu.use(relayTransport({ url, isolate: true }))               // one connection per space
records({ padding: 'quarter' })                              // default; 'pow2' | 'none'
```

- **One reconcile per pair, no sid leaks**: subscriptions travel in `hello`, reconciles start once the other
  side's hello is known. A mirror never initiates towards a client and never sends it `sub`s - a client learns
  nothing about the other spaces a mirror serves, and connecting costs the mirror nothing per stored space (it
  only fetches from a peer that just granted it a NEW space). Between equals, the smaller network id initiates.
  `maxSessionsPerPeer` (8) caps concurrent responder sessions (`negerr`, retried later).
- **Quotas** (`mirror.js`): per space `{records, bytes}` and a size limit per envelope. Usage lives in
  `mirror/usage/<sid>` and moves in the envelope's own atomic write set (minus what a drop list removes, minus
  expired drop lists). Refused envelopes are answered with `nack` -> `qu.record.refused` at the sender, whose
  outbox keeps them; drop lists are always accepted (they free space). CLI: `--quota-records`, `--quota-bytes`,
  `--max-envelope`, `--rate` (or `QU_QUOTA_RECORDS`, ...).
- **Rate limits** (`limits.js`): token buckets per connection (frames and bytes) on the link's inbound guard;
  frames above the limit are dropped (`net.limited`), repeated strikes close the connection. Nothing is lost:
  unacknowledged records stay in the sender's outbox, unfinished reconciles are retried. The mirror CLI uses it
  by default (200 frames/s).
- **Padding**: private inners are padded to size steps (`JSON || 0x00 || zeros`) - with `quarter`: min 128 B, then
  quarter steps of the next power of two (at most +25 %). Old unpadded envelopes stay readable. Reconcile cost is
  unchanged (~2 KB for 10,000 records + 1 change); tiny records grow to the 128 B minimum.
- **One connection per space** (`relayTransport({isolate: true})`): every joined space gets its own connection
  with a random network id and a SCOPED link that carries only that space (subs, records, grants, acks; a record
  arriving on the wrong link is ignored, never acked). The shared connection carries the rest (other users'
  nodes, inbox drops). The relay can no longer tie spaces to a device from the protocol - IP address and timing
  still can (put a proxy/Tor in front for that). Decoy subscriptions were left out: a relay recognises them at
  once (no grants, no data).

## Collaborative text (milestone 12)

```js
qu.use(text({ batchMs: 300, snapshotEvery: 200 }));   // registry name 'text'
const doc = await qu.text(space, 'notes/main');
doc.insert(0, 'Hallo'); doc.delete(0, 2); doc.set(textarea.value);   // set(): smallest single edit
doc.on(({ text, remote }) => ...);
const caret = doc.anchor(i); /* remote edits */ doc.indexOf(caret);  // positions that survive remote edits
await doc.compact();
```

- **CRDT** (`src/text.js`, `TextCrdt`): RGA with Lamport-ordered char ids `(counter, site)`; a char is inserted
  after its reference char, skipping every char with a greater id. Concurrent runs never interleave; replicas
  that see the same ops in any order (out-of-order ops wait for their reference) end with the same text.
- **Records**: keystrokes within `batchMs` become ONE ordinary encrypted, padded record at the doc's path
  (`{site, ops}`), synced and reconciled like any other - offline edits merge on reconnect. A site is the
  author's alias prefix plus a random per-session suffix (two devices of one identity don't collide); ops of a
  batch must carry its author's site, forgeries are ignored.
- **Compaction**: `<path>/_snap`, keyed by the author's alias (a hook refuses anyone else's key), holds the
  author's full state as runs - with tombstone ids but without deleted text. Snapshots are op unions, so they
  merge: each member snapshots its own state and drops its own batches (drop lists, M10). Nothing is lost,
  whoever compacts when; superseded own snapshots are compacted by `compaction()`.
- Limits: the whole state lives in memory (fine for notes up to ~100k chars; positions are linear scans); a
  member can still vandalise a shared text (delete it, or collide future char ids of another site) - the same
  trust as in any group space. The demo has a shared note per group (caret kept across remote edits).

## Next milestones

All planned milestones (1-12) are done.

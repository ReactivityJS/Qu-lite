# Changelog

All notable changes to `@qu/lite`. The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) - before 1.0, a minor version may change the API.

## Unreleased

Stability, scalability and one base for client and relay.

- **Lifecycle**: `qu.close()`, `qu.onClose()`, `qu.timers`; plugins, transports, links and timers are
  torn down in reverse order (`qu.closing`/`qu.closed`). `qu.use(plugin, name)` records plugins
  (`qu.plugins`, `qu.has()`).
- **Presets**: `createClient()` (browser + Node) and `createRelay()` (`@qu/lite/node`); the CLI is a
  thin wrapper with `--repl`, `--log-format json`, `--max-connections`.
- **Lazy registry**: `defaultRegistry()` imports modules on first use; new small entry `@qu/lite/client`,
  served as `dist/qu-client.js` (~4 KB gzip) with plugins as on-demand chunks.
- **Hardened links**: strict frame decoding, frame-type check, rate guard before parsing, `hi` timeout
  and early-frame limit, protocol version in `hi` (`PROTOCOL_VERSION`, also in `/info`).
- **Backpressure**: WebSocket and SSE peers that do not drain are closed (`net.slow`) instead of being
  buffered without bound.
- **Server**: `maxConnections` (1013 / 503, `net.refused`), `/readyz`, graceful shutdown (1001, drain).
- **IndexedDB**: closes on `versionchange`, reopens connections the browser closed.
- **Devtools**: `devtools()` plugin, `qu.dev` in the browser console and the relay REPL
  (docs/CONSOLE.md). Developer guide in German: docs/GUIDE.md.
- Fix: `bus.error?.(…)` calls in `compaction`/`text` were no-ops - `Bus#error(error, where)` exists now.
- **Sync traffic** (`bench/sync-bytes.mjs`): digest pre-check (`digest`/`digestr` frames, offered in
  `hello.features`) - an unchanged reconnect runs no Negentropy session; one reconcile per (peer, scope)
  (fixes double downloads when `watch()` raced the reconnect); `maxConcurrentPerPeer` queue instead of
  `busy` declines, a declined session is retried after ~1 s; outbox records are not pushed twice on one
  link; acks batched (`ackDelayMs`) and never sent to mirrors. First upload -51 %, fresh device -42 %,
  unchanged reconnect -57 % bytes.
- **Direct download** (`pull`/`pullend` frames, feature `pull` in `hello`): a scope this device holds
  nothing of is fetched without Negentropy's two id lists (32 B per record each way); the result is
  checked by fingerprint, anything else falls back to the normal reconcile. Fresh device -15 % bytes
  on top of the above (-50 % vs. before this release), no reconcile rounds. Pull records carry a small
  integer tag instead of `sync: true`.
- **Paced sending** (`whenWritable`): bulk record sends wait for the transport's send buffer. Fixes a
  regression of the slow-consumer limit above: a download of more than 16 MiB from a relay was closed
  as slow on every reconnect.
- A reconcile started right after connecting waits (max 5 s) for the peer's `hello`, so digest and pull
  apply to `watch()` calls racing the handshake.
- **Announced rate limits**: `limits` announces its buckets in `hi`; the other side sends at most 80 %
  of them, queueing frames in order. Fixes a big first upload against a relay: frames above the
  burst were dropped, the relay closed the link after 50 drops and the client re-sent its whole
  outbox on every reconnect (2,000 records: 47 s, 195 reconnects, ~280,000 dropped frames; now 13 s,
  one connection, none dropped). `bench/upload-rate.mjs`.
- **Sync-index cache** (`indexCacheItems`): the (ts, id) vector and fingerprint of a space are loaded
  once and shared by every session, digest and pull until the index changes; generation-based
  invalidation through the new `storage.afterWrite(prefix, fn)` hook (after every completed write,
  whoever wrote); single-flight reads; index read in pages with the event loop running between them.
  Reconnect storm of 20 devices on 20,000 records: index loads 20 -> 1, longest event-loop stall
  1,081 ms -> 67 ms; after a change 40 -> 1 loads, 1,778 ms -> 15 ms. `bench/relay-load.mjs`.
- **Inbound backpressure**: at most 64 frames per link are processed at once, the rest wait in order;
  above 4 MiB waiting the transport stops reading (Node ws: TCP pause; SSE server: POST answer held
  back) and resumes below 1 MiB (`net.paused`/`net.resumed`, logged by the relay). One fast client
  against a slow relay (6,000 records): 2,335 -> 64 frames in progress, +109 -> +22 MiB heap.
  The SSE client reports its unanswered POSTs as its send buffer. `bench/inbound-load.mjs`.
- **Device backup and restore** (`device` plugin, in `createClient`): `qu.device.exportBackup(passphrase)`
  seals the device-only keys (identity, group secrets, epoch keys) with PBKDF2-SHA256 (600,000 rounds)
  + AES-256-GCM; `createClient({ restore: {backup, passphrase} })` + `restoreGroups()` brings a user back
  completely on a new device (content comes from the relay). Refuses to overwrite another identity
  that has groups unless `force`. `qu.device.persist()` / `status()` for the browser's storage grant;
  `createClient({ persist: true })`.
- **Several relays**: `createClient({ url: [a, b] })` / `relayTransport({ url: [...] })` keeps every relay
  connected (each with its own WebSocket -> SSE fallback, with `isolate` one connection per space and
  relay). One relay going down changes nothing for the app; when it is back, the reconcile delivers
  what it missed. `qu.transports.relay.urls`.
- **Identity lock (optional)**: `createClient({ passphrase })` keeps the identity only encrypted in
  storage (backup format); every start needs the passphrase (`error.code` `QU_LOCKED` /
  `QU_WRONG_PASSPHRASE`). An unlocked identity is locked on the first start with a passphrase, the plain
  copy removed only after the sealed one read back; half-finished locks are completed. `qu.device.lock`,
  `changePassphrase`, `removeLock`, `status().locked`; restore into a locked storage needs its passphrase
  or `force`.
- **Batched records** (`recs` frame, feature `recs` in `hello`, `sync({ batch })`): bulk record sends go
  up to 64 records / 64 KiB per frame; any other sync frame flushes first. Rate limits and the send
  budget count records (`frameUnits`), not frames. Acks for a batch go out together. First upload of
  4,000 records: 4,564 -> 167 frames, -5 % bytes; fresh device -6.5 %.
- **Traffic by message type**: every link counts frames and bytes per type for the whole session
  (`netOf(qu).traffic`); `qu.dev.traffic()`, `watchTraffic(seconds)`, `resetTraffic()` in the console;
  `traffic.byType` and `qu_lite_traffic_bytes_total{direction,type}` in stats and `/metrics`.
  `bench/idle-traffic.mjs` measures an idle client: presence heartbeats cost ~1.3 MiB/hour for 10 groups.
- **Presence in the background**: while the page is hidden (or `qu.status.setHidden(true)`) the
  heartbeat slows to `hiddenInterval` (5 min, `0` = offline while hidden); every heartbeat carries its
  interval (`every`) and receivers keep the sender online for 2.5 x that. 10 groups idle: 1.3 MiB/hour
  -> ~90 KiB/hour in the background (-93 %).
- **Grants on reconnect**: to a mirror that offers `grantsum`, a client sends 24 bytes per space (sid +
  grant fingerprint, `grantFingerprint()`); the mirror answers `grantneed` with the spaces it lacks or holds
  differently, and only those grants are sent. Older mirrors get all grants. Plugins can offer hello
  features via `netOf(qu).features`. Reconnect without changes (20 spaces): 6.6 -> 3.6 KiB, 24 -> 5 frames.
  A mirror remembers who sent records for a space it did not know yet and fetches them from each of those
  peers when the grant arrives - not only from the peer whose grant was new (two clients reconnecting to a
  restarted relay could otherwise wait for the 30 s retry).
- **Short acks** (feature `ack8`): acks carry 8-byte id prefixes, matched against the receiver's outbox
  (acks for records not in the outbox are dropped - they carried no information). Ack volume -74 %,
  first upload of 4,000 records 1,609 -> 1,512 KiB (-6 %).
- **Smaller signals**: signals are sealed with the new `'small'` padding (quarter steps from 32 bytes instead
  of 128) - a presence heartbeat 378 -> 346 bytes (-8.5 %). Padding is the sender's choice; readers of any
  version strip it. Both signatures stay: the relay needs them to refuse spam, receivers to know who it is.
- **TypeScript declarations** for all entry points (`npm run types`, run on `npm pack`; `types/` is
  generated, not committed). `createClient()`/`createPeer()` return `Qu` with typed plugin members
  (`write<V>`, `query<V>`, `members`, `status`, `device`, `dev`, …). Option JSDoc completed where it
  lacked options (`sync`, `createLink`, `connectWs`, `connectSse`, `topology`, drivers). CI checks a
  typed sample app (`test/types/app.ts`).

## [Unreleased]

### Security

Findings of the security review (docs/SECURITY-REVIEW.md), all fixed with regression tests:

- **High** - a relay routed live envelopes of every space to any connection that had not subscribed (also anonymous
  ones without keys): ciphertext, space ids, aliases, sizes and timing. Live records and reconcile pushes now reach a
  peer only for what it subscribed to; mirrors take everything as before.
- **Medium** - a connection claiming another client's network id received that client's routed traffic. The newest
  link with an id now replaces the older one.
- **Medium** - static files: `..%2F` reached sibling directories whose name starts like the web root
  (`web` -> `web-secret`).
- **Medium** - attachments: a member could publish a manifest whose size made readers allocate gigabytes (or throw).
  Manifests must now be self-consistent and within `maxBytes`, chunks exactly their slice.
- **Medium** - the WebSocket server accepted 100 MiB messages (the `ws` default) before rate limits applied: now
  `maxFrameBytes` (8 MiB); Negentropy messages are limited to 256 KiB (`frameSizeLimit`) and id lists are batched.
- **Medium** - stale devices: any peer could make a stale device delete old records by claiming to lack them, and a
  reconcile with any peer marked the device current again. Only a mirror's view now retires records or proves a
  device current.
- **Low** - a public relay accepted unlimited new spaces: `mirror({ maxSpaces })`, `--max-spaces`, `QU_MAX_SPACES`.
- Invites expire: `members.invite(pub, { expiresIn })` signs a validity window into the token (default 7 days,
  `null` = never); `acceptInvite()` refuses expired invites and every member refuses join entries dated outside the
  window. Tokens without a window (older invites) stay valid. The demo shows the expiry and handles expired links.

### Added

- Stale-device check: a device whose last complete sync of a space is older than the 90-day drop-list horizon no
  longer pushes old records the network lacks (they may have been deleted meanwhile) - it retires them locally.
  `qu.staleSpaces()`, `qu.lastSync()`, event `sync.stale`, option `sync({ stale: 'retire' | 'push' })`,
  `qu.envelopes.retire()`.
- Attachments: `blobs()` plugin - chunked, encrypted, content-addressed blobs as ordinary records, fetched on demand,
  upload/download progress (`qu.blob.progress`, `qu.blob.done`), uploads tracked across reloads, screen wake lock and
  unload warning while transfers run. Example `examples/08-blobs.mjs`.
- One port for everything: the relay serves a client start page (`/`, connection check and connect snippet), the demo
  (`/demo.html`), the library as one browser module (`/dist/qu-lite.js`), `/healthz` and `/info` next to `/ws` and
  `/sse`. WebSocket heartbeat (`pingMs`, 25 s) for reverse proxies; `relayTransport` keeps a URL path prefix.
  Deployment guide with Caddy and nginx: `docs/DEPLOY.md`.
- Operating figures: optional `stats()` plugin - traffic in/out (total, per connection, throughput), connections,
  record outcomes, sync counters, storage (spaces, records, bytes, database size). The relay serves it as `/stats`
  (JSON) and `/metrics` (Prometheus) with `--stats-token` / `QU_STATS_TOKEN`. Links now also count frames, list
  open links in `qu.net.links` and pass their final counters with `net.peer.down`; the SQLite driver has `size()`.
  The demo header shows live traffic. Example `examples/09-stats.mjs`.
- Guides: `docs/INSTALL.md` (relay with Docker step by step: `.env`, Caddy, update, backup/restore, troubleshooting)
  and `docs/TESTING.md` (test suites, browser tests and how to debug them, a manual browser checklist).
- `bin/backup.mjs` / `npm run backup`: online backup of the relay database while it runs (no sqlite3 needed).
- `npm run test:browser`; `QU_E2E_HEADED` / `QU_E2E_SLOWMO` show and slow down the browser tests.
- Docker Swarm: `docker-stack.yml` for caddy-docker-proxy (labels, no published port, one replica pinned to the
  node with the volume, stop-first updates, rollback), guide in `docs/INSTALL.md`. The CI publishes the image to
  `ghcr.io/<owner>/qu-lite` (amd64 + arm64) after tests pass - `:main` from `main`, `:x.y.z`/`:x.y`/`:latest` from
  tags. The mirror CLI reads every `QU_*` setting also from `QU_*_FILE` (secrets).

### Changed

- `docker-compose.yml` reads its settings from `.env` (template `.env.example`) and publishes the port on
  `127.0.0.1` by default (`QU_BIND=0.0.0.0` to expose it directly).
- The web files moved from `demo/` to `web/` (`index.html` = start page, `demo.html` = demo); `npm run build:web`
  replaces `npm run demo:build`. The Docker healthcheck uses `/healthz`.

- Text CRDT keeps chars as runs (split where an edit lands, extended while typing): 100k typed chars in ~10 ms
  instead of ~12 s, snapshot load instantly instead of ~1.7 s. Ops and snapshot format are unchanged.

### Fixed

- `doc.set()` and the end anchor now count code points like every other text position (emoji were split).
- Demo: the shared note was bound to the private-note input (two elements with `id="note"`).
- Presence: a member-list change right after an announce dropped the re-announce, so a newcomer whose first
  heartbeat had arrived before its member entry stayed invisible until the next interval (up to 20 s); the
  re-announce is now postponed instead (also the cause of an occasionally failing status test).

## [0.1.0] - 2026-10-17

First release as a standalone repository (previously `packages/lite` in
[QuV5](https://github.com/ReactivityJS/QuV5); history preserved).

### Added

- Kernel: event bus with hooks (`emit`/`notify`/`run`/`collect`), unstorage-style mounts, registry, `createQu`/`createPeer`.
- Spaces (groups, user nodes, inboxes) with opaque ids, per-space author aliases and key epochs.
- Envelope v2: records sealed and signed over the ciphertext, verifiable by any peer or mirror without a key; padding.
- Records: log and last-write-wins entries, time-window queries, hooks, scrub/repair, atomic write sets.
- Sync: Negentropy set reconciliation (cost ∝ difference), partial sync by path/time window, durable outbox,
  resumable reconciles, `ackFrom: 'mirror'`.
- Storage drivers: memory, IndexedDB, SQLite (`node:sqlite`).
- Transports: in-process, WebSocket (with reconnect), HTTPS + SSE fallback (`relayTransport`), WebRTC with
  sealed signaling, topology (`star`/`mesh`/`auto`), one connection per space (`isolate`).
- Members: owner/admin/member roles, admin-signed epoch chain, invites by link or inbox, verifiable reveal,
  removal with key rotation; per-user inboxes; user nodes with public and private fields.
- Status: presence, typing, sent/delivered/read without per-message overhead; ephemeral signals.
- Deletion and compaction: signed drop lists honoured by every peer and the blind mirror, tombstones,
  auto-compaction, 90-day horizon.
- Mirror: blind relay on the same peer base, quotas, size limits, rate limits, `qu-lite-mirror` CLI, Docker image.
- Optional collaborative text (RGA CRDT) with anchors and snapshots.
- Documentation: API reference (`docs/API.md`), runnable examples (`examples/`, executed by the test suite),
  design decisions (`docs/DECISIONS.md`).

[Unreleased]: https://github.com/ReactivityJS/Qu-lite/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ReactivityJS/Qu-lite/releases/tag/v0.1.0

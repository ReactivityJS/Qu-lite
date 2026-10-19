# Changelog

All notable changes to `@qu/lite`. The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) - before 1.0, a minor version may change the API.

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

### Changed

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

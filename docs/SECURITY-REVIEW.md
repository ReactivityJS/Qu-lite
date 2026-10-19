# Security review – October 2026

Scope: the whole library at the state after milestone 16 (stale devices, attachments, one-port relay,
operating figures): network input, the blind envelope layer and grants, membership rules, crypto, sync, the
optional plugins, the HTTP server and the web pages. Method: code reading along the attack surfaces, then a
reproduction for every suspected issue. Each fix comes with a regression test that fails without it.

## Threat model (short)

- **Relay/mirror**: honest-but-curious, or reachable by anyone. It must never read content, and it must not hand
  out metadata of spaces to connections that did not ask for them.
- **Anonymous network client**: connects to a public relay without keys.
- **Member** of a group: holds the keys. Members are trusted not to vandalise shared data (DECISIONS.md), but they
  must not crash or exhaust other members' devices, or read other spaces.
- **Former member / removed admin**: knows old keys and the space id.
- **Device thief**: out of scope (identity and data are stored unencrypted on the device).

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Live routing leak at relays | fixed |
| 2 | Medium | Network-id impostor receives another client's traffic | fixed |
| 3 | Medium | Static files: traversal into sibling directories | fixed |
| 4 | Medium | Attachments: oversized manifest → memory exhaustion / crash at readers | fixed |
| 5 | Medium | 100 MiB WebSocket messages buffered before rate limits | fixed |
| 6 | Medium | Stale devices: any peer could trigger local deletion / reset staleness | fixed |
| 7 | Low | Unlimited new spaces at a public relay | fixed (option) |
| 8–14 | Low / info | see "Accepted / documented" | documented |

### 1 – Live routing leak (High)

Any connection to a relay received a live copy of every new envelope of every space the relay served, even
without keys, a `hello` or any subscription. It got the ciphertext plus space id, shard tag, author alias,
size and minute. The cause was the routing rule "a peer that never sent `sub` gets everything" in `sync.js`. The
same rule let a client push envelopes of all its spaces in reconciles with any peer, for example a member of a
different group over WebRTC. This broke the design goal "no sid leaks".

**Fix**: a mirror takes everything (as before); any other peer gets live records and reconcile pushes only for
what it subscribed to. Tests: `hardening.test.js` (anonymous connection, with and without the sync plugin).

### 2 – Network-id impostor (Medium)

A second link with an already connected network id was registered next to the first. Both received every frame
sent to that id, including the first peer's subscribed records. Network ids are random, but direct (WebRTC)
peers learn them. **Fix**: the newest link with an id replaces the older one (peer down, then up). A reconnect
before the dead socket is noticed now works at once, and an impostor only gets what it subscribes to itself.
Test: `hardening.test.js`.

### 3 – Static files outside the web root (Medium)

`file.startsWith(root)` without a path separator let `/..%2Fweb-secret%2Fkey.txt` read files from a sibling
directory whose name starts like the root (`/app/web` → `/app/web-secret`). **Fix**: `file === root ||
file.startsWith(root + sep)`. Test: `server.test.js` (temp directories).

### 4 – Attachments: oversized manifest (Medium)

The blob id covers the manifest, so any member can publish a manifest for an id they choose. A manifest
claiming `size: 1.5 GB` in one chunk made `blobs.get()` allocate that much, or throw. Chunk lengths were not
checked either, so short chunks left zeros. **Fix**: a manifest is accepted only if `size ≤ maxBytes`, the chunk
size is sane and the hash list has exactly `ceil(size/chunkSize)` entries. A chunk is accepted only with
exactly its slice length and hash. Test: `blobs.test.js`.

### 5 – Unbounded WebSocket messages (Medium)

The `ws` default `maxPayload` is 100 MiB, buffered completely before the link's rate limit sees it. **Fix**:
`listenHttp({ maxFrameBytes })`, 8 MiB by default (over the limit: close 1009). Legitimate frames now stay small:
- Negentropy messages are limited to 256 KiB (`frameSizeLimit`; bigger differences take more rounds).
- `want`/`ack` id lists go out in batches of 4096 ids.
- This also makes very large reconciles work over SSE, whose uploads are capped at 1 MiB.

Tests: `server.test.js`, `sync.test.js` ("bounded frames").

### 6 – Stale devices: deletion on a peer's word (Medium)

A stale device retired old records whenever the peer it reconciled with, or that asked for them, lacked them.
Any peer could therefore delete a stale device's old data by claiming not to have it. In addition, a complete
reconcile with *any* peer marked the device current again, so a second exchange pushed the old records anyway.
**Fix**: only a reconcile with a mirror retires records or updates `lastSync`. Towards other peers a stale
device withholds old records but keeps them. Test: `stale.test.js` (stable over repeated runs).

### 7 – Unlimited spaces (Low)

A space's grant is self-certifying, so anyone can create spaces at a public relay, and per-space quotas don't
bound the total. **Fix**: `mirror({ maxSpaces })`, `--max-spaces`, `QU_MAX_SPACES`; refusals emit
`mirror.full`. Hardening recommendations are in DEPLOY.md. Test: `hardening.test.js`.

## Accepted / documented (no code change)

8. **Space-id holders can subscribe**: current or former members know the sid and can fetch its envelopes at a
   relay. They get ciphertext and header metadata only; new epochs stay unreadable for removed members.
9. **Invite tokens don't expire**: an unused invite link stays valid. A possible extension is an expiry in the
   signed token.
10. **Removed admin, stale verifier**: an ex-admin can still sign epochs at a verifier that hasn't seen the newer
    admin list yet.
11. **Inbox flooding**: anyone may write into an inbox by design. It is bounded only by per-space quota and rate
    limits; set quotas on public relays.
12. **No per-IP connection limit** in the relay, which doesn't see client IPs behind the proxy. Limit
    connections at the proxy (DEPLOY.md).
13. **Stats token in the query string** ends up in proxy access logs. Prefer the `Authorization` header
    (DEPLOY.md).
14. **Text CRDT**: deletes of unknown char ids are kept until the chars arrive, so a member can grow that list.
    This is the same trust as vandalising the text.

## Checked without findings

- **Envelopes**: both signatures cover the ciphertext, and the id is the SHA-256 of the whole envelope. Network
  input is verified against the keyring; local writes alone skip verification.
- **Grants**: epoch 0 is self-certifying through the sid; the admin list is owner-signed with increasing `seq`;
  later epochs are signed by the owner or an admin; first valid grant per epoch wins.
- **Crypto**:
  - AES-GCM uses a random 96-bit IV per record and the header as AAD.
  - The sealed box uses an ephemeral X25519 key, with ephemeral and recipient key bound into the HKDF.
  - Ed25519 is WebCrypto's.
- **Frames**: malformed lengths and types only throw inside the link (caught; `net.error`).
- **Records**: drift check on remote HLCs; drop lists honour `mayDrop` for every entry, blind as well.
- **Signals**: 60-second freshness window, replay deduplication, both signatures checked.
- **Stats endpoints**: constant-time token comparison; no space ids or identities in the report (tested).
- **Web pages**: no `innerHTML` or `eval` with data; `nosniff` and `no-referrer`; invite secrets only in the URL
  fragment.

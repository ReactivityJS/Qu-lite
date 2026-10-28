# Testing

Qu Lite has three kinds of tests:
- automated Node tests (`node:test`, no extra framework);
- two automated browser tests (Playwright + Chromium against the real relay);
- a manual checklist for real browsers and devices.

Requirements: Node ≥ 22.5 and `npm ci` in the repository.

## Automated tests

```sh
npm test                    # everything (~45 s), including the two browser tests
npm run test:unit           # everything except the browser tests
npm run test:browser        # only the browser tests
node --test --test-timeout=240000 test/sync.test.js                              # one file
node --test --test-timeout=240000 --test-name-pattern="stale" test/*.test.js     # tests whose name matches
```

Run the full suite **twice** before pushing a non-trivial change. Several tests depend on timing (presence,
reconnects), and a single green run can hide a race.

| File | Covers |
|---|---|
| `bus`, `mount`, `drivers`, `hlc`, `crypto`, `frame` | kernel, storage drivers (memory, SQLite, IndexedDB via `fake-indexeddb`), clocks, crypto, wire format |
| `envelope`, `envelopes`, `space`, `records`, `atomic` | sealed records, blind layer, spaces and epochs, reading/writing, atomic write sets |
| `sync`, `stale`, `link`, `ws`, `sse`, `server` | reconciliation, devices offline past 90 days, transports, one-port server behind a proxy |
| `members`, `inbox`, `signals`, `status`, `compaction` | groups, invites (incl. expiry), inbox, presence/receipts, deleting |
| `mirror`, `hardening`, `privacy` | the blind relay, quotas/limits/routing, what is visible to whom |
| `text`, `blobs`, `stats`, `webrtc`, `topology` | optional plugins |
| `examples` | runs every script in `examples/` |
| `demo.e2e` | the browser tests (below) |

## Browser tests

`test/demo.e2e.test.js` starts the real relay (`bin/mirror.mjs` with SQLite, serving `web/`) and drives
separate Chromium contexts, which behave like separate browsers:

1. **Start page**: it connects to the relay that serves it, and its store test gets an acknowledgement.
2. **Three browsers** on the demo:
   - Alice founds a group; Bob joins by link; Carol joins over HTTPS + SSE, invited through her inbox.
   - Chat, online status, read receipts, typing and deleting a message.
   - The shared note: both type, both see the merged text.
   - Offline writes and a reload before reconnecting.
   - Removing a member: a new epoch, and Bob is locked out.
   - The event log, and a check that the relay holds no plaintext.
3. **WebRTC**: two browsers connect directly and keep chatting after the relay is shut down.

### Setup

```sh
npx playwright install --with-deps chromium     # once; --with-deps installs system libraries (Linux, needs sudo)
npm run test:browser
```

Without a usable Chromium the two tests are **skipped**, not failed (`# skipped 2`). Check the output so you
don't mistake a skip for a pass. The tests look for a browser in this order:
1. Playwright's own Chromium;
2. `QU_CHROMIUM=/path/to/chromium`;
3. `/opt/pw-browsers/chromium`.

### Debugging

| Variable | Effect |
|---|---|
| `QU_E2E_DEBUG=1` | prints every step and the browsers' console output |
| `QU_E2E_HEADED=1` | shows the browser windows (needs a display; on a Linux server: `xvfb-run -a npm run test:browser`) |
| `QU_E2E_SLOWMO=250` | with `QU_E2E_HEADED`: waits this many ms after every action |

```sh
QU_E2E_DEBUG=1 QU_E2E_HEADED=1 QU_E2E_SLOWMO=200 npm run test:browser
```

### CI

`.github/workflows/test.yml` runs `npm test` with Chromium installed (`npx playwright install --with-deps chromium`).
The `docker` job builds the image, starts it and checks `/healthz`, `/info`, the start page, the demo and the
browser bundle on one port.

## Manual browser test

Use it before a release, after deploying, or on real devices (phones, other browsers, networks with proxies). Start
locally with `npm run demo` (`http://localhost:8787`), or use your deployed relay (`https://relay.example.org`).
Use **two different browsers** (or one normal and one private window) for Alice and Bob. Each `?name=` keeps its
own identity and data in that browser.

**Relay and connection**

- [ ] `/` shows **verbunden über ws**, the relay network id and the server version.
- [ ] **Speichertest** reports "gespeichert und bestätigt in … ms".
- [ ] `/healthz` shows `ok`. With a stats token, `/stats` returns JSON (otherwise 404).

**Group and chat** (`/demo.html?name=alice` and `/demo.html?name=bob`)

- [ ] Alice: **Neue Gruppe**, then **Einladungslink**. The tooltip on the link shows "gültig bis …" (7 days).
- [ ] Bob opens the link: the group opens, and both see two members under *Mitglieder*.
- [ ] Messages arrive both ways. Under your own message `✓` → `✓✓ 1/1` → `gelesen 1/1`.
- [ ] Bob types: Alice sees the typing hint. Both see a green online dot for each other.
- [ ] Bob sets a display name (*Meine User-Node* → **Speichern**), then **Mich zu erkennen geben**: Alice's member
      list shows his name instead of the alias.
- [ ] Shared note (*Gemeinsame Notiz*): both type at the same time, and the texts converge. The caret stays in
      place, also next to emoji.
- [ ] `✕` on your own message deletes it on both sides.

**Offline and reload**

- [ ] Bob: **Trennen**. Alice writes. Bob: **Verbinden** - the messages arrive.
- [ ] Alice: **Trennen**, write, reload the page (F5), **Verbinden**. The message reaches Bob (*Outbox* goes back
      to 0).
- [ ] Turn off Wi-Fi or mobile data, then back on: the connection returns by itself.

**Fallback and direct links**

- [ ] `…/demo.html?name=carol&transport=sse`: the status shows **über sse**, and chat works.
- [ ] Two browsers on the same network: *Direkt* counts 1. Press **Trennen** in both (or stop the relay): chat still
      works over the direct link. Switching to *Nur Relay* closes it again.

**Membership**

- [ ] Alice: **Entfernen** next to Bob. The epoch display goes up by one, Bob sees a removal notice, and Alice's
      new messages no longer reach him.
- [ ] Expired invite: with the group open, run this in Alice's browser console. It prints a link that is valid
      for one second:
      ```js
      const inv = await (await qu.members(qu.space(location.hash.slice(3)))).invite(null, { expiresIn: 1000 });
      `${location.origin}${location.pathname}?name=dave#i=${btoa(JSON.stringify(inv)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
      ```
      Wait two seconds, then open the link: the banner says the invite has expired, and nothing is joined.

**Traffic and storage**

- [ ] The header shows *Traffic* (↓/↑ per second, totals). The tooltip lists the connections.
- [ ] Click a message to see its stored envelope: it is ciphertext only.

### Testing behind a proxy locally

Caddy can put TLS in front of the local relay without a domain:

```sh
npm run demo                                                    # relay on :8787
caddy reverse-proxy --from localhost:8443 --to 127.0.0.1:8787   # https://localhost:8443 (local CA)
```

Under a path prefix, use a Caddyfile with `handle_path /qu/*` (see [DEPLOY.md](DEPLOY.md)) and open
`https://localhost:8443/qu/`. `test/server.test.js` checks the same thing automatically with a minimal
prefix-stripping proxy.

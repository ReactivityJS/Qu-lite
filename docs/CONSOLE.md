# Qu Lite in der Dev-Console

Jeder Peer – im Browser wie im Relay – hat dieselbe Untersuchungs-API: **`qu.dev`**. Sie kommt vom
Plugin `devtools`, das `createClient()` im Browser automatisch installiert und `createRelay()` immer.

- [Browser](#browser)
- [Befehle](#befehle)
- [Rezepte für typische Fragen](#rezepte-für-typische-fragen)
- [Tracing: Bus-Ereignisse mitlesen](#tracing-bus-ereignisse-mitlesen)
- [Direkt mit dem Peer arbeiten](#direkt-mit-dem-peer-arbeiten)
- [Relay-REPL](#relay-repl)
- [Sicherheit](#sicherheit)

## Browser

Beim Start meldet sich der Peer in der Konsole:

```
[qu-lite] peer 3f9a1c0d2b4e6f80 is window.qu - try qu.dev.help()
```

DevTools öffnen (F12 → Console) und loslegen:

```js
qu.dev.help()          // alle Befehle als Tabelle
qu.dev.info()          // Peer-Id, Public Key, Plugins, Mounts, Anzahl Links
qu.dev.links()         // offene Verbindungen
```

Selbst gebaute Peers bekommen die Konsole mit einem Plugin:

```js
qu.use(devtools());                          // window.qu
qu.use(devtools({ global: 'chat' }));        // window.chat
await createPeer({ plugins: [..., 'devtools'] });
```

Laufen mehrere Peers auf einer Seite, bekommt der zweite einen Suffix (`window.qu_3f9a`) – die
Konsole sagt welchen.

## Befehle

| Befehl | Ergebnis |
|---|---|
| `qu.dev.help()` | Übersicht aller Befehle |
| `qu.dev.info()` | `{peerId, publicKey, plugins, mounts, links, uptime, closed}` |
| `qu.dev.links()` | Tabelle: Peer, Transport (`ws`, `sse`, `webrtc`, `ws-server`), seit, Protokoll, Bytes/Frames rein/raus, Scope |
| `qu.dev.transports()` | Status der Client-Transporte: URL, verbunden, `via` (ws/sse), Remote-Peer |
| `qu.dev.trace(muster, opts)` | Bus-Ereignisse mitloggen, gibt `stop()` zurück – siehe unten |
| `qu.dev.untrace()` | alle Traces beenden (auch den gespeicherten) |
| `qu.dev.spaces()` | beigetretene Spaces |
| `await qu.dev.pending()` | `{outbox, pending}` – was noch auf Bestätigung bzw. Abgleich wartet |
| `await qu.dev.ls(prefix, limit)` | Speicherschlüssel unter einem Präfix mit Größe |
| `await qu.dev.get(key)` | ein gespeicherter Wert |
| `await qu.dev.dump(prefix, limit)` | Werte als JSON (Bytes als `hex:…`) – für Bug-Reports |
| `await qu.dev.stats()` | Betriebszahlen (Plugin `stats`) |
| `qu.dev.listeners(topic)` | wie viele Handler ein Topic erreicht |
| `await qu.dev.emit(topic, payload)` | Bus-Ereignis von Hand auslösen |

### Speicher-Präfixe zum Stöbern

| Präfix | Inhalt |
|---|---|
| `qu/` | Identität (maskiert), Netz-Id |
| `rec/<sid>/` | versiegelte Records eines Space |
| `idx/<sid>/` | Indizes (Pfad, Zeit, Schlüssel) |
| `sx/<sid>/` | Sync-Index (nur öffentliche Header) |
| `sync/out/<sid>/` | **Outbox** – lokale Writes, die noch kein Relay bestätigt hat |
| `sync/pending/` | angefangene Abgleiche, die beim nächsten Connect fortgesetzt werden |
| `sync/last/` | Zeitpunkt des letzten vollständigen Abgleichs mit einem Relay |
| `mirror/` | nur im Relay: Grants und Nutzung pro Space |

## Rezepte für typische Fragen

**„Bin ich verbunden – und worüber?“**
```js
qu.dev.transports()     // via: 'ws' oder 'sse' (Fallback), connected: true/false
qu.dev.links()          // Bytes rein/raus zeigen, ob tatsächlich Verkehr fließt
```

**„Warum kommt meine Nachricht nicht an?“**
```js
await qu.dev.pending()                 // outbox > 0 → Relay hat noch nicht bestätigt
await qu.dev.ls('sync/out/')           // welche Records genau warten
qu.dev.trace('net.**')                 // läuft überhaupt Verkehr? kommen ack/nack?
qu.dev.trace('net.in.*.nack')          // Relay lehnt ab (z. B. reason: 'quota', 'too large')
```

**„Wird ein Record lokal abgelehnt?“**
```js
qu.dev.trace('qu.record.rejected')     // z. B. invite expired, nicht erlaubt
qu.dev.trace('qu.accept')              // jeder Record vor der Indizierung
```

**„Was macht der Abgleich?“**
```js
qu.dev.trace('sync.**')                // sync.done, sync.pull {complete}, sync.index {items, ms, cached}, sync.busy …
await qu.resync({ space: qu.space(qu.dev.spaces()[0].sid) })   // sofort abgleichen
```

**„Wie viele Daten liegen lokal?“**
```js
await qu.dev.ls('rec/', 1000)           // Anzahl/Größe der Records
await navigator.storage.estimate()      // Browser-Quote
```

**„Fehler, die sonst niemand sieht“**
```js
qu.dev.trace('bus.error')              // geworfene Handler, Fehler in Timern/Flushes
qu.dev.trace('net.error')              // kaputte Frames, falsches Protokoll, Handshake-Timeout
qu.dev.trace('net.slow')               // Verbindung wegen Rückstau geschlossen
qu.dev.trace('net.paused')             // Relay liest vorübergehend nicht (zu viel Rückstand)
```

## Tracing: Bus-Ereignisse mitlesen

```js
const stop = qu.dev.trace('net.**');                 // alles im Netz
qu.dev.trace('qu.record.*');                         // jeder Record jedes Space
qu.dev.trace('**', { filter: (topic) => !topic.startsWith('net.in') });
stop();                                              // einzelnen Trace beenden
qu.dev.untrace();                                    // alle
```

Muster: `*` = genau ein Segment, `**` = beliebig viele (nur am Ende). Ausgabe: Millisekunden seit
Trace-Start, Topic, Payload (Bytes gekürzt als `<32 bytes>`).

**Trace über einen Reload hinweg** – für Probleme beim Start:

```js
qu.dev.trace('net.**', { persist: true })   // in localStorage gemerkt, startet nach Reload sofort
qu.dev.untrace()                            // wieder aus
```

oder per URL: `https://app.example/?qu-trace=sync.**`

## Direkt mit dem Peer arbeiten

`window.qu` ist der echte Peer – alles aus der [API-Referenz](API.md) geht auch in der Konsole:

```js
const g = await qu.createGroup()
await qu.write(g, 'chat', 'aus der Konsole')
await qu.query({ space: g, path: 'chat' })
const m = await qu.members(g); m.list()
await (await qu.me()).set('name', 'Anna')
qu.transports.relay.disconnect()            // Offline simulieren …
qu.transports.relay.connect(location.origin) // … und zurück
await qu.close()                            // Peer sauber beenden
```

## Relay-REPL

Dieselbe API am laufenden Relay:

```sh
npx qu-lite-mirror --db ./relay.sqlite --repl
# Docker: docker compose run --rm qu-lite node bin/mirror.mjs --repl --db /data/relay.sqlite --port 8788
```

```
qu> dev.info()
qu> dev.links()                      // alle verbundenen Clients
qu> dev.trace('mirror.**')           // Grants, Quoten, volle Instanz
qu> await qu.mirror.spaces()         // bediente Spaces
qu> await qu.mirror.usage('<sid>')   // {records, bytes}
qu> await dev.ls('mirror/usage/')
qu> await qu.mirror.expire()         // abgelaufene Drop-Listen jetzt entfernen
```

`Ctrl+D` beendet REPL und Relay sauber (Graceful Shutdown). Wichtig: Ein zweiter Prozess auf
**derselben** SQLite-Datei ist ein zweites Relay – für reine Inspektion lieber eine Kopie öffnen
(`npm run backup`) oder den laufenden Prozess mit `--repl` starten.

Im Code ohne CLI: `const relay = await createRelay(); relay.qu.dev.links()`.

## Sicherheit

- `devtools` ist **nur lesend** – außer `emit()` und dem, was man selbst über `qu` aufruft.
- Die Identität (`qu/identity`, private Schlüssel) wird in `ls`, `get` und `dump` **maskiert**; ein Dump
  kann in einen Bug-Report.
- `window.qu` gibt jedem Skript auf der Seite Zugriff auf den Peer. Das gilt aber ohnehin für jedes
  Skript im selben Origin (es kann IndexedDB direkt lesen). In Produktion trotzdem bewusst entscheiden:
  `createClient({ devtools: false })` oder `devtools({ global: false })` (nur `qu.dev` am eigenen Objekt).

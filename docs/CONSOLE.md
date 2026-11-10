# Qu Lite in der Dev-Console

Jeder Peer – im Browser wie im Relay – hat dieselbe Untersuchungs-API: **`qu.dev`**. Sie kommt vom
Plugin `devtools`, das `createClient()` im Browser automatisch installiert und `createRelay()` immer.

- [Browser](#browser)
- [Befehle](#befehle)
- [Rezepte für typische Fragen](#rezepte-für-typische-fragen)
- [Tracing: Bus-Ereignisse mitlesen](#tracing-bus-ereignisse-mitlesen)
- [Zwei Browser über einen Relay](#zwei-browser-über-einen-relay)
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
| `qu.dev.memory()` | Caches im RAM: entschlüsselte Records, Feld-Indizes, Sync-Index |
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

## Zwei Browser über einen Relay

Der schnellste Weg, Qu kennenzulernen: zwei Konsolen, ein Relay, kein eigener Code. Relay starten
(`npm run demo` oder `npx qu-lite-mirror`), dann `http://localhost:8787/` in **zwei** Browsern öffnen
(oder in zwei Fenstern desselben Browsers, die Namen `konsole-a` und `konsole-b` trennen die
Identitäten) und jeweils F12 → Console. Die Blöcke laufen der Reihe nach; `test/demo.e2e.test.js`
führt genau diesen Text in zwei Chromium-Instanzen aus.

**A** – Peer anlegen, Gruppe gründen, Einladung kopieren:

```js konsole-a
const { createClient } = await import('/dist/qu-client.js');
await createClient({ url: location.origin, name: 'konsole-a', extra: ['blobs'] });   // jetzt gibt es window.qu
g = await qu.createGroup();
copy(JSON.stringify(await (await qu.members(g)).invite()));   // Einladung liegt in der Zwischenablage
qu.bus.on(`qu.record.${g.id}`, (r) => r.path.startsWith('_') || console.log('neu:', r.path, r.value));
```

**B** – Peer anlegen, Einladung einfügen, erste Nachricht:

```js konsole-b
const { createClient } = await import('/dist/qu-client.js');
await createClient({ url: location.origin, name: 'konsole-b', extra: ['blobs'] });
g = await qu.acceptInvite(JSON.parse(prompt('Einladung einfügen')));
qu.bus.on(`qu.record.${g.id}`, (r) => r.path.startsWith('_') || console.log('neu:', r.path, r.value));
await qu.write(g, 'chat', { text: 'Hallo von B' });
```

**A** – antworten, einen Termin und eine Datei schicken:

```js konsole-a
await qu.write(g, 'chat', { text: 'Hallo zurück' });
await qu.write(g, 'events', { title: 'Treffen', start: Date.parse('2026-11-12T18:00Z') }, { key: 'treffen' });
ref = await qu.blobs.put(g, new TextEncoder().encode('Inhalt der Notiz'), { name: 'notiz.txt', type: 'text/plain' });
await qu.write(g, 'chat', { text: 'Datei anbei', file: ref });
```

**B** – lesen, nach Feld suchen, die Datei holen:

```js konsole-b
(await qu.query({ space: g, path: 'chat' })).map((r) => r.value.text);
await qu.query({ space: g, path: 'events', where: { start: { gte: Date.parse('2026-11-01'), lt: Date.parse('2026-12-01') } } });
anhang = (await qu.query({ space: g, path: 'chat', where: { 'file.name': 'notiz.txt' } }))[0];
new TextDecoder().decode(await qu.blobs.get(g, anhang.value.file));   // 'Inhalt der Notiz'
```

**Beide** – Präsenz (jede Seite muss den Status einmal öffnen):

```js konsole-a konsole-b
st = await qu.status(g);
st.online();   // nach ein paar Sekunden: die andere Seite mit online: true
```

**B** – offline schreiben und wieder verbinden:

```js konsole-b
qu.transports.relay.disconnect();
await qu.write(g, 'chat', { text: 'offline geschrieben' });
await qu.syncStatus();                        // {outbox: 1, …} – wartet auf den Relay
qu.transports.relay.connect(location.origin); // A bekommt die Nachricht sofort
```

**A** – was übertragen wurde und was im Speicher liegt:

```js konsole-a
(await qu.query({ space: g, path: 'chat' })).map((r) => r.value.text);
qu.dev.traffic();   // Bytes pro Nachrichtentyp
qu.dev.memory();    // Caches (nur RAM)
qu.dev.links();     // die Verbindung zum Relay
```

Ein Reload ändert nichts: Identität, Gruppe und Nachrichten liegen in IndexedDB. Nach dem Reload
reichen die ersten zwei Zeilen (mit demselben `name`) und `g = (await qu.restoreGroups())[0]`.

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

## Datenvolumen und Durchsatz

Jede Verbindung zählt Frames und Bytes pro Nachrichtentyp, für die ganze Sitzung (auch über
Reconnects hinweg):

```js
qu.dev.traffic()          // Tabelle: Typ, raus/rein, Frames, Anteil, Hochrechnung pro Stunde, Bedeutung
qu.dev.watchTraffic(10)   // alle 10 s: "last 10 s: 3.7 KiB (378 B/s) - sig 3.7 KiB"; gibt stop() zurück
qu.dev.resetTraffic()     // ab jetzt neu zählen (z. B. vor einem Test)
qu.dev.links()            // pro Verbindung: Bytes/Frames, Warteschlangen
```

So findet man einen Volumenfresser: `resetTraffic()`, die App eine Weile so benutzen (oder liegen
lassen) wie im Verdachtsfall, dann `traffic()`. Die Spalte *what* erklärt jeden Typ:

| Typ | Was |
|---|---|
| `rec` / `recs` | Records (Nachrichten, Profile, Quittungen) – Nutzdaten |
| `sig` | flüchtige Signale: **Präsenz-Herzschlag**, Tippen, WebRTC-Aufbau |
| `ack` / `nack` | Bestätigungen des Relays |
| `neg` / `negr` / `want` / `wantmiss` / `negend` | Abgleich (Negentropy) |
| `digest` / `digestr` | Fingerprint-Vergleich beim Verbinden |
| `pull` / `pullend` | Direkt-Download eines leeren Space |
| `hi` / `hello` / `grant` / `sub` / `unsub` | Verbindungsaufbau, Freigaben, Abos |

Die Bytes sind Frame-Bytes. Auf der Leitung kommen pro Frame grob 60 Byte für WebSocket, TLS und
TCP hinzu (`traffic()` zeigt die Schätzung). WebSocket-Pings des Relays (alle 25 s) sind nicht enthalten.

**Bekannter Posten:** Präsenz kostet pro Gruppe und anwesendem Mitglied alle 20 s einen `sig` von etwa
380 Byte – in 10 Gruppen mit einem weiteren Mitglied rund 1,3 MiB pro Stunde, solange die App
verbunden und sichtbar ist (`bench/idle-traffic.mjs`). Im Hintergrund schlägt das Herz nur alle 5 min
(~90 KiB pro Stunde). Weniger: `status({ presence: false })`, `status({ hiddenInterval: 0 })` (im
Hintergrund offline) oder `status(group)` nur für sichtbare Gruppen öffnen.

**Speicher:** `qu.dev.memory()` zeigt die Caches. Sie liegen nur im RAM: Auf die Platte oder ins Netz
geht davon nichts. Jeder Cache hat eine feste Obergrenze (Records: 1000 Stück und 4 MiB; Feld-Indizes:
200.000 Einträge à ~200 Byte). Übersicht: [API.md – Caches](API.md#caches-and-memory).

Am Relay stehen dieselben Zahlen in `/metrics` (`qu_lite_traffic_bytes_total{direction, type}`) und in
`/stats` (`traffic.byType`).

## Hintergrund und Push

```js
await qu.background.progress()     // {records, bytes} – was noch zum Relay muss
qu.background.backgroundSync       // true: Background Sync; false: Wake Lock als Rückfall
qu.awake?.reasons                  // warum der Bildschirm gerade an bleibt
qu.push.opened                     // {sid, kind}, wenn eine Benachrichtigung die App geöffnet hat
qu.dev.trace('qu.push.**')
```

Am Relay: `qu.pushRelay.size()` (gespeicherte Push-Abos), `dev.trace('push.**')` (`push.sent {status}`,
`push.failed`).

## Geräte-Backup und Speicher

```js
await qu.device.addKey({ name: 'YubiKey' })  // Sicherheitsschlüssel / Passkey: antippen
await qu.device.keys()                       // registrierte Keys
// anderes Gerät, gleiche Adresse:
// await (await import('/dist/qu-client.js')).createClient({ url: location.origin, name: 'neu', unlock: 'key' })
await qu.device.status()                    // {persisted, usage, quota, backupAt, groups, locked, keys, keyLocked}
await qu.device.persist()                   // Browser bitten, den Speicher nicht zu räumen
await qu.device.downloadBackup('lange passphrase hier')   // Backup als Datei
await qu.device.lock('lange passphrase hier')             // Identität nur noch verschlüsselt speichern
```

Ein Backup enthält die privaten Schlüssel (verschlüsselt). Nie in Bug-Reports oder Chats einfügen.

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

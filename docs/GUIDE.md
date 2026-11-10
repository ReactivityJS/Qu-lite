# Qu Lite – Entwicklerleitfaden

Dieser Leitfaden zeigt, wie man mit Qu Lite eine verteilte Webanwendung baut: **ein Code-Stand für
Browser-Client, Node-Client und Relay**. Er ergänzt die [API-Referenz](API.md) (alle Optionen und
Methoden) und die [Dev-Console-Anleitung](CONSOLE.md) (Untersuchen eines laufenden Peers).

- [1. Das Modell in fünf Sätzen](#1-das-modell-in-fünf-sätzen)
- [2. Schnellstart](#2-schnellstart)
- [3. Einstiegspunkte: was man woher importiert](#3-einstiegspunkte-was-man-woher-importiert)
- [4. Ein Peer, drei Rollen](#4-ein-peer-drei-rollen)
- [5. Daten: Spaces, Records, Abfragen](#5-daten-spaces-records-abfragen)
- [6. Gruppen, Einladungen, Status](#6-gruppen-einladungen-status)
- [7. Eigene Plugins schreiben](#7-eigene-plugins-schreiben)
- [8. Lebenszyklus und Aufräumen](#8-lebenszyklus-und-aufräumen)
- [9. Relay betreiben](#9-relay-betreiben)
- [10. Robustheit: was das System für dich erledigt – und was nicht](#10-robustheit)
- [10a. Identität absichern: Backup, Wiederherstellung, Speicherschutz](#10a-identität-absichern)
- [11. Testen](#11-testen)
- [12. Checkliste für produktive Apps](#12-checkliste-für-produktive-apps)

---

## 1. Das Modell in fünf Sätzen

1. Jeder Knoten ist ein **Peer** (`qu`): Identität + Speicher + Bus + Plugins. Browser, Node-Skript und
   Relay sind *derselbe* Peer mit anderen Adaptern.
2. Daten liegen in **Spaces** (Gruppe, Benutzerknoten, Inbox) als **versiegelte, signierte Records**.
   Nur Mitglieder können sie lesen.
3. Peers gleichen sich mit **Negentropy** ab: Kosten proportional zur *Differenz*, nicht zur Historie;
   ein **Outbox** sorgt dafür, dass nichts verloren geht, auch nicht bei Reload oder Funkloch.
4. Ein **Relay** ist ein Peer mit `sync({role: 'mirror'})` + `mirror`: Er speichert und verteilt die
   versiegelten Daten, prüft Signaturen – und kann nichts lesen.
5. Alles Verhalten ist ein **Plugin** `(qu) => api`; Plugins reden nur über den **Bus** miteinander.

```
 Browser (IndexedDB)            Relay (SQLite)              Node-Client (SQLite/Memory)
 ┌──────────────────┐   ws /    ┌──────────────────┐   ws    ┌──────────────────┐
 │ createClient()   │◄─ sse ───►│ createRelay()    │◄───────►│ createClient()   │
 │ records, sync,   │           │ sync(mirror),    │         │ records, sync …  │
 │ members, status… │◄─webrtc──►│ mirror, limits   │         │                  │
 └──────────────────┘ (direkt)  └──────────────────┘         └──────────────────┘
          gleicher Kern: createQu → Bus · Mount-Router · Registry · Plugins
```

## 2. Schnellstart

```sh
npm install
npm run demo        # Relay auf :8787 mit Startseite (/), Demo (/demo.html) und Browser-Bundle
```

**Relay** (Node, eine Datei):

```js
import { createRelay } from '@qu/lite/node';

const relay = await createRelay({ port: 8787, db: './relay.sqlite', handleSignals: true });
```

**Client** (Browser oder Node – derselbe Code):

```js
import { createClient } from '@qu/lite';          // im Browser ohne Bundler: '<relay>/dist/qu-client.js'

const qu = await createClient({ url: 'https://relay.example' });
const group = await qu.createGroup();
qu.bus.on(`qu.record.${group.id}`, (rec) => console.log(rec.path, rec.value));
await qu.write(group, 'chat', 'hallo');
```

`createClient()` wählt selbst: **IndexedDB** wenn vorhanden (Identität und Daten überleben einen
Reload), sonst **Memory**; das Plugin-Set einer Gruppen-App; den **Relay-Transport** (WebSocket mit
HTTPS+SSE-Fallback); im Browser die **Devtools** (`window.qu`, siehe [CONSOLE.md](CONSOLE.md)).

## 3. Einstiegspunkte: was man woher importiert

| Import | Umgebung | Inhalt | Wann |
|---|---|---|---|
| `@qu/lite/client` | Browser + Node | `createClient`, `createPeer`, Kernel | **Standard für Apps** – Plugins werden bei Bedarf nachgeladen |
| `@qu/lite` | Browser + Node | alles Browser-Sichere (Plugins, Transporte, Bausteine) | wenn man Plugins von Hand verdrahtet (`qu.use(records())`) |
| `@qu/lite/node` | Node | `createRelay`, `nodeRegistry`, `sqliteDriver`, HTTP/WS-Server | Relay, Node-Clients mit SQLite |
| `@qu/lite/devtools` | Browser + Node | `devtools()` | Konsolen-API einzeln |
| `<relay>/dist/qu-client.js` | Browser, ohne Bundler | wie `@qu/lite/client`, Plugins als Chunks | Prototypen, statische Seiten |
| `<relay>/dist/qu-lite.js` | Browser, ohne Bundler | wie `@qu/lite`, ein File | wenn alles auf einmal geladen werden soll |

**Warum das wichtig ist:** Die Registry lädt jedes Plugin erst, wenn sein Name benutzt wird
(`import()`). Eine App, die `text`, `blobs`, `webrtc` oder `stats` nicht nennt, lädt sie nicht. Der
Einstieg `qu-client.js` ist ~4 KB (gzip); der Rest kommt in Chunks nach Bedarf. Node-only-Code
(`node:sqlite`, `ws`) liegt ausschließlich hinter `@qu/lite/node` – ein Browser-Bundle kann ihn nicht
versehentlich enthalten.

**TypeScript:** Alle Einstiege bringen Typdeklarationen mit (`npm run types`, läuft auch bei `npm pack`).
`createClient()` liefert den Typ `Qu` – mit `write<V>()`, `query<V>()`, `members()`, `status()`,
`device`, `dev`. Ein Tippfehler wie `qu.query(group, 'chat')` statt `qu.query({ space: group, path: 'chat' })`
fällt schon im Editor auf. Reines JavaScript bekommt dieselben Hinweise über JSDoc.

## 4. Ein Peer, drei Rollen

Alle drei Rollen sind `createPeer()` mit anderen Namen aus der Registry. Die Presets sind nur
Voreinstellungen – jede Option lässt sich überschreiben.

### Browser-Client

```js
import { createClient } from '@qu/lite/client';

const qu = await createClient({
  url: 'https://relay.example',
  name: 'meine-app',              // IndexedDB-Name: eine Datenbank pro App
  extra: ['text', 'blobs'],       // zusätzlich zu den Standard-Plugins
  relay: { isolate: true },       // eine Verbindung pro Space (Relay sieht keine Zuordnung)
});
```

### Node-Client (Bot, Import-Job, Integration)

```js
import { createClient, nodeRegistry } from '@qu/lite/node';

const qu = await createClient({
  url: 'https://relay.example',
  registry: nodeRegistry(),                      // kennt zusätzlich 'sqlite'
  store: ['sqlite', { path: './bot.sqlite' }],   // Identität bleibt über Neustarts gleich
  devtools: { global: false },
});
```

### Relay

```js
import { createRelay } from '@qu/lite/node';

const relay = await createRelay({
  port: 8787,
  db: './relay.sqlite',
  static: './web',                 // Startseite, Demo, Browser-Bundle auf demselben Port
  quota: { records: 100_000, bytes: 256 << 20 },
  maxSpaces: 10_000,
  maxConnections: 10_000,
  statsToken: process.env.QU_STATS_TOKEN,   // /stats und /metrics
  logFormat: 'json',
  extra: [myAuditPlugin],          // eigene Plugins laufen auch im Relay
});
```

### Ganz von Hand

Wer volle Kontrolle braucht, baut den Peer aus Teilen – das ist exakt, was die Presets intern tun:

```js
import { createPeer } from '@qu/lite/client';

const qu = await createPeer({
  store: ['indexeddb', { name: 'meine-app' }],
  plugins: ['records', 'user', 'members', 'inbox', ['sync', { ackFrom: 'mirror' }], 'status', 'compaction'],
  transports: [['relay', { url: 'https://relay.example' }]],
});
```

Reihenfolge der Plugins: siehe Abhängigkeiten in der [API-Referenz](API.md#concepts-in-one-minute)
(`user` braucht `records`, `inbox` braucht `records` + `user`, `status` braucht `members`).

## 5. Daten: Spaces, Records, Abfragen

```js
// Log-Einträge (Chat, Ereignisse): jeder write ist ein neuer Record
await qu.write(group, 'chat/general', { text: 'hallo' });

// Schlüssel-Einträge (Einstellungen, Profile): last-write-wins pro (path, key)
await qu.write(group, 'settings', 'dark', { key: 'theme' });
await qu.get(group, 'settings', 'theme');                 // 'dark'

// Abfragen: ein Pfad, zeitlich sortiert (HLC), optional Zeitfenster
const lastHour = await qu.query({ space: group, path: 'chat/general', from: Date.now() - 3600_000 });

// Abfragen nach beliebigem Feld (für jede App gleich: Termin, Aufgabe, Punktestand, Beitrag)
await qu.query({ space: group, path: 'events', where: { start: { gte: montag, lt: sonntag } }, orderBy: 'start' });
await qu.query({ space: group, path: 'tasks', where: { status: 'offen', tags: 'dringend' } });
await qu.query({ space: group, path: 'posts', where: { title: { contains: 'sync' } }, limit: 20 });

// Live: jeder neue Record, lokal oder remote
qu.bus.on(`qu.record.${group.id}`, (rec) => render(rec));

// Nur synchronisieren, was die App gerade zeigt (Partial Sync)
const unwatch = await qu.watch({ space: group, path: 'chat/general' });
```

**Feld-Abfragen** brauchen keine Vorbereitung. Beim ersten `where` auf ein Feld entsteht ein sortierter
Index im Arbeitsspeicher (ein Durchgang über den Pfad, etwa 0,1 ms pro Record). Danach dauert eine
Abfrage rund 1 ms und folgt jeder Änderung, auch von anderen Geräten. Auf die Platte kommt nichts
Lesbares. Bedingungen: Wert (gleich), Array (eines davon), `gt`/`gte`/`lt`/`lte`, `prefix`, `contains`
(Suche ohne Groß-/Kleinschreibung). Felder mit Punkt (`'ort.stadt'`) sowie `$value`, `$key` und
`$author`. Mehr Rezepte je App-Typ: [REZEPTE.md](REZEPTE.md).

**Live-Abfragen** (Plugin `live`, optional): `qu.live(query, render)` ruft `render` sofort und nach jeder
passenden Änderung erneut auf. Bursts werden gebündelt, und `render` läuft nur, wenn sich das Ergebnis
wirklich geändert hat. Das passt direkt in React, Vue oder Svelte:

```js
const qu = await createClient({ url, extra: ['live'] });
const stop = qu.live({ space: group, path: 'chat', limit: 50, reverse: true }, (rows) => zeige(rows));
```

**Datenprüfung** (Plugin `schema`, optional): Regeln pro Pfad greifen beim Schreiben **und** beim
Empfangen. Was ein anderes Gerät falsch oder böswillig schickt, wird abgewiesen und nie angezeigt.

```js
createClient({ url, extra: [['schema', { events: { title: 'string', start: 'number', tags: 'string[]?' }, chat: 'string' }]] });
```

**Validierung und Rechte** gehören in Hooks, nicht in die UI – sie gelten dann für lokale *und*
empfangene Records:

```js
qu.bus.on('qu.write.before', (draft) => ({ value: { ...draft.value, text: draft.value.text.trim() } }));
qu.bus.on('qu.accept', (record, ctx) => {
  if (record.path.startsWith('admin/') && !isAdmin(record.author)) { ctx.reason = 'nicht erlaubt'; ctx.stop(); }
});
```

**Was der Abgleich überträgt:** Records sind bereits Deltas (unveränderlich, inhaltsadressiert), und
Negentropy vergleicht Indizes statt Daten. Zusätzlich prüft ein Reconnect zuerst pro Space einen
16-Byte-Fingerprint (Digest) – nur abweichende Spaces laufen Negentropy. Ein Space, von dem das Gerät
noch nichts hat (neues Gerät, frisch beigetreten), wird direkt geladen (`pull`), ohne Id-Listen, und am
Ende per Fingerprint geprüft; bei Abweichung läuft der normale Abgleich. Große Downloads werden nach dem
Sendepuffer getaktet. Messen: `node bench/sync-bytes.mjs` (Vergleich: `PULL=0`, `DIGEST=0`).

**Last am Relay:** Der Sync-Index eines Space wird einmal geladen und von allen Sitzungen geteilt,
bis sich der Space ändert. Ein Reconnect-Sturm nach einem Relay-Neustart kostet so einen
Ladevorgang pro Space statt einen pro Client. Messen: `node bench/relay-load.mjs [clients] [records]`.
Speicher: `sync({ indexCacheItems })`, etwa 300 Byte pro Eintrag.

**Zustellung prüfen:** `qu.syncState(sid, id)` → `'pending' | 'sent'`; `qu.syncStatus()` →
`{outbox, pending}`. Mit `ackFrom: 'mirror'` (Standard in `createClient`) gilt ein Record erst als
gesendet, wenn ein **Relay** ihn dauerhaft gespeichert hat.

## 6. Gruppen, Einladungen, Status

```js
const group = await qu.createGroup();                    // ich bin Owner
const m = await qu.members(group);
const invite = await m.invite(null, { expiresIn: 24 * 3600_000 });
shareAsLink(invite);                                     // z. B. als #fragment – landet nie im Referer

// beim Eingeladenen
const space = await qu.acceptInvite(invite);

// nach Reload
await qu.restoreGroups();

// Präsenz, Tippen, Lesebestätigungen
const st = await qu.status(group);
await st.sendTyping('chat');
await st.markRead('chat');
```

Entfernen (`m.remove(alias)`) startet eine neue **Epoche**: Entfernte können neue Records nicht mehr
lesen. Details: [API.md → members](API.md#members).

## 6a. Wenn die App zu ist: Hintergrund, Push, Lesen ohne Mitgliedschaft, offene Räume

**Hintergrund-Sync.** Was offline geschrieben wurde, liegt in der Outbox. `background` zeigt den
Stand und sorgt dafür, dass er ankommt:

```js
const qu = await createClient({ url, extra: ['background', 'push'] });
qu.bus.on('qu.sync.progress', ({ records, bytes }) => zeigeFortschritt(records, bytes));
```

In Chrome und Edge übernimmt Background Sync: Der Browser weckt den Service Worker, sobald wieder
Netz da ist, auch wenn der Tab längst geschlossen ist. Der Worker schickt die versiegelten Records
direkt aus IndexedDB an den Relay. In Safari und Firefox gibt es das nicht. Dort bleibt der
Bildschirm an, solange etwas aussteht und eine Verbindung besteht (Wake Lock, nur als Rückfall).

**Push.** Der Relay weckt geschlossene Apps mit einem Push **ohne Inhalt**. Der Service Worker fragt
dann den Relay, worum es geht („3 neue Nachrichten in Familie“, „Anruf in Familie“). Der Name der
Gruppe bleibt auf dem Gerät. Über Apple, Google oder Mozilla läuft nur das Wecken.

```js
// in einem Klick-Handler (nur dann fragt der Browser um Erlaubnis):
await qu.push.enable([familie], { labels: { [familie.id]: 'Familie' }, paths: ['chat'] });
await qu.push.ring(familie);          // Anruf: weckt die anderen sofort
if (qu.push.opened?.kind === 'call') zeigeAnrufAnnehmen(qu.push.opened.sid);
qu.bus.on('qu.push.open', ({ sid, kind }) => kind === 'call' && zeigeAnrufAnnehmen(sid));
```

Relay: `createRelay({ push: { subject: 'mailto:ops@example.org' } })` bzw. `--push mailto:…`.
Service Worker der App (`/sw.js`, gleicher Origin):

```js
importScripts('https://relay.example/dist/qu-sw.js');
quServiceWorker({ db: 'qu-lite', open: '/',
  texts: { message: (name, n) => ({ title: name, body: `${n} neue Nachricht${n > 1 ? 'en' : ''}` }),
           call: (name) => ({ title: `Anruf – ${name}`, body: 'Tippen zum Annehmen' }) } });
```

Auf dem iPhone geht Push nur, wenn die Web-App zum Home-Bildschirm hinzugefügt wurde. Jeder Push
muss eine sichtbare Meldung erzeugen. Deshalb weckt nur, was unter `paths` liegt (z. B. `chat`).
Lesebestätigungen und Präsenz wecken nie.

**Lesen ohne Mitgliedschaft (Blog, öffentliches Profil).** Öffentliche Records
(`visibility: 'public'`) kann jeder über den Relay lesen, ohne Identität und ohne Peer:

```js
await autor.write(blog, 'posts', { titel: 'Hallo Welt' }, { visibility: 'public' });
const posts = await fetchPublic('https://relay.example', blog.id, 'posts');
// teilbar: https://relay.example/q/<sid>/posts  ->  fetchPublic(link)
```

Der Leser prüft beide Signaturen jedes Records selbst. Ein Relay kann Records also unterschlagen,
aber nicht fälschen. Wer schreiben darf, regelt der Space: Ein Blog ist eine Gruppe, deren
Mitglieder die Autoren sind.

**Offene Räume (Forum, Kommentare).** Jeder mit dem Link darf schreiben, ohne Einladung:

```js
const forum = await mod.createGroup({ open: true });
const link = await (await mod.members(forum)).link();     // veröffentlichen
const raum = await gast.acceptInvite(link);               // Gast schreibt sofort
await (await mod.members(forum)).ban(alias);              // ab jetzt nimmt niemand mehr etwas an
await mod.del(forum, beitrag);                            // Beitrag für alle löschen
```

Statt Mitgliedschaft gibt es Moderation. Sperren sind öffentliche Records, damit auch der Relay sie
durchsetzt, ohne Inhalte zu lesen. Pro Autor gilt am Relay eine Grenze für neue Beiträge
(Standard: 20 auf einmal, dann einer alle 5 s). Owner und Admins sind davon ausgenommen. Ein Link
ohne `open` ist ein reiner **Lese-Link**: Sein Inhaber liest alles, aber was er schreibt, nimmt
niemand an.

## 7. Eigene Plugins schreiben

Ein Plugin ist eine Funktion `(qu) => api`. Konventionen, die das System stabil halten:

```js
export function auditLog({ path = 'audit' } = {}) {
  const plugin = (qu) => {
    // 1. Nur über den Bus mit anderen Plugins reden
    const off = qu.bus.on('qu.record.*', (rec) => count(rec));

    // 2. Zeitgeber über den Kernel: werden bei qu.close() gestoppt und halten Node nie am Leben
    qu.timers.interval(() => flush().catch((e) => qu.bus.error(e, 'audit.flush')), 60_000);

    // 3. Alles, was wieder abgebaut werden muss, registrieren
    qu.onClose(off);

    // 4. Optionale Nachbarn per Name prüfen, nicht per Methoden-Probe
    const canSync = qu.has('sync');

    // 5. Hintergrundfehler melden statt verschlucken
    async function flush() { /* … */ }

    const api = { flush, close: () => flush() };  // close() wird von qu.close() aufgerufen
    qu.audit = api;
    return api;
  };
  plugin.pluginName = 'audit';                    // erscheint in qu.plugins / qu.dev.info()
  return plugin;
}

qu.use(auditLog());
```

Eigene Plugins kann man auch in die Registry eintragen, um sie per Name zu konfigurieren:

```js
const registry = defaultRegistry().register('plugin', 'audit', (o) => auditLog(o));
await createClient({ registry, extra: [['audit', { path: 'log' }]] });
```

**Bus-Formen** (Details in [API.md → Bus](API.md#bus)):

| Aufruf | Verhalten | Typischer Zweck |
|---|---|---|
| `emit(topic, p)` | Handler nacheinander, `ctx.stop()` = Veto | Prozesse mit Hooks |
| `notify(topic, p)` | parallel, nur Seiteneffekte | Ereignisse für UI/Logs |
| `run(topic, p)` | Rückgabewerte werden in den Payload gemischt; Throw bricht ab | Transformationen |
| `collect(topic, p)` | sammelt alle Rückgabewerte | Abfragen über Plugins hinweg |

## 8. Lebenszyklus und Aufräumen

```js
const qu = await createClient({ url });
// …
await qu.close();     // idempotent
```

`qu.close()` sendet `qu.closing`, schließt Plugins und Transporte in umgekehrter Reihenfolge, trennt
alle Links (`net.peer.down`), stoppt alle Kernel-Timer, schließt den Speicher und sendet `qu.closed`.
Wichtig für:

- **Single-Page-Apps**: Peer beim Logout/Account-Wechsel schließen, dann neuen bauen.
- **Hot Module Reload**: `import.meta.hot?.dispose(() => qu.close())`.
- **Tests**: jeder Test schließt seine Peers – keine hängenden Timer, kein „test timed out“.
- **Relay**: `relay.close()` ist ein Graceful Shutdown (siehe [9](#9-relay-betreiben)).

Schlägt `createPeer()`/`createClient()` mittendrin fehl (Plugin wirft, Port belegt), wird alles bereits
Geöffnete wieder geschlossen und der Fehler geworfen.

## 9. Relay betreiben

```sh
npx qu-lite-mirror --port 8787 --db ./relay.sqlite --static ./web --log-format json \
  --max-connections 10000 --quota-records 100000 --max-spaces 10000
docker compose up --build        # oder: docs/INSTALL.md
```

| Endpunkt | Zweck |
|---|---|
| `GET /healthz` | Liveness – Prozess antwortet (Container-Healthcheck) |
| `GET /readyz` | Readiness – 200 erst wenn die gespeicherten Grants geladen sind, 503 beim Herunterfahren (Load-Balancer) |
| `GET /info` | Name, Version, **Protokollversion**, Transporte, Uptime – keine Space-Daten |
| `GET /stats`, `/metrics` | Betriebszahlen als JSON / Prometheus, nur mit `--stats-token` |
| WebSocket (`/ws`), `GET/POST /sse/<session>` | Peers |

**Kapazität und Schutz** (alles pro Relay-Prozess):

| Schutz | Option / Flag | Verhalten |
|---|---|---|
| Max. Verbindungen | `maxConnections` / `--max-connections` (10 000) | WebSocket: Close 1013, SSE: 503 – Clients versuchen später erneut |
| Schnelle Clients | 64 Frames gleichzeitig pro Verbindung | darüber wird gewartet; über 4 MiB Rückstand hört der Relay auf zu lesen, der Client wartet über seine Taktung |
| Langsame Clients | `maxBufferedBytes` (16 MiB) | Verbindung wird geschlossen statt unbegrenzt zu puffern (`net.slow`); Client resynchronisiert |
| Rate-Limit | `--rate` (200 Records/s) | Token-Bucket pro Verbindung, vor dem Parsen; wird im Handshake angekündigt, Clients takten sich auf 80 % davon (kein Verwerfen, keine Abbrüche bei großen Uploads) |
| Frame-Größe | `maxFrameBytes` (8 MiB) | größere WebSocket-Nachrichten → Close 1009 |
| Handshake | 15 s / 8 Frames | wer kein gültiges `hi` sendet, wird getrennt |
| Quoten | `--quota-records`, `--quota-bytes`, `--max-envelope`, `--max-spaces` | Envelopes werden per `nack` abgelehnt, bleiben im Outbox des Senders |

**Graceful Shutdown** (SIGTERM, `relay.close()`): `/readyz` → 503, Clients erhalten Close 1001
(„going away“) und verbinden sich neu, Nachzügler werden nach `drainMs` getrennt, SQLite wird
geschlossen. Durch Outbox + Negentropy geht dabei nichts verloren.

**Interaktive Konsole am laufenden Relay:** `--repl` – siehe [CONSOLE.md](CONSOLE.md#relay-repl).

**Upload-Durchsatz:** Ein Relay erlaubt pro Verbindung `--rate` Records pro Sekunde (Standard 200), Clients
takten sich auf 80 % davon. Große Importe (2 000 Records) dauern damit etwa 12 s; mit `--rate 1000` etwa 4 s.
Das Limit schützt die CPU des Relays (Signaturprüfung und Schreiben pro Record) – passend zur Hardware wählen.

**Ausfallsicherheit mit zwei Relays:** `createClient({ url: ['https://relay-a.example', 'https://relay-b.example'] })`
hält zu beiden eine Verbindung. Geschrieben wird an beide; ein Record gilt als zugestellt, sobald einer
ihn gespeichert hat. Fällt ein Relay aus, merkt die App nichts. Kommt er zurück, gleicht der Client ab
und liefert nach, was er verpasst hat. Die Relays kennen sich nicht und brauchen keine Konfiguration
füreinander – nur getrennte Datenbanken.

**Skalierung:** Ein Relay ist ein einzelner Prozess mit einer SQLite-Datei (WAL). Für mehr Last:
mehrere Relays mit `--allow` für disjunkte Space-Mengen (Sharding nach Space), oder Redundanz, indem
Clients mit mehreren Relays verbunden sind (`transports: [['ws', {connect: [a, b]}]]`) – ein Client
gleicht seine Spaces mit jedem verbundenen Relay ab. Grenzen und Gründe: [DECISIONS.md](DECISIONS.md)
und der Review-Bericht.

## 10. Robustheit

**Erledigt das System für dich:**

- Nichts geht verloren: jeder lokale Write liegt im Outbox, bis ein Relay ihn bestätigt; unterbrochene
  Abgleiche werden fortgesetzt (Reload, Funkloch, Relay-Neustart).
- Reconnect mit Backoff + Jitter, sofort bei `online`; WebSocket → SSE-Fallback bei blockierenden Proxys.
- Duplikate sind harmlos (inhaltsadressiert, idempotent).
- Unbekannte/kaputte Frames, falsche Typen, neue Protokollversionen werden gemeldet (`net.error`), nicht
  ausgeführt.
- IndexedDB: Upgrade in anderem Tab blockiert nicht, vom Browser geschlossene Verbindungen werden
  neu geöffnet.

**Musst du selbst entscheiden:**

- **Speicherdruck im Browser:** `qu.device.persist()` zu einem passenden Zeitpunkt aufrufen, sonst darf
  der Browser IndexedDB räumen (Identität weg!) – siehe [10a](#10a-identität-absichern).
- **Backup anbieten:** `qu.device.exportBackup(passphrase)` / `downloadBackup()` in der UI anbieten und an
  fehlende Backups erinnern (`qu.device.status().backupAt`).
- **UI für Zustände:** `net.peer.up/down`, `qu.transports.relay.status()`, `qu.syncStatus()` und
  `qu.staleSpaces()` anzeigen (z. B. „offline – 3 Nachrichten warten“).
- **Validierung** fremder Records in `qu.accept`-Hooks.

## 10a. Identität absichern

Nur drei Dinge existieren ausschließlich auf dem Gerät: die **Identität**, die **Gruppenschlüssel**
(`members/groups/`) und die **Epochenschlüssel** (`members/keys/`). Alles andere – Nachrichten, Profile,
Mitgliederlisten – liegt verschlüsselt am Relay und kommt per Sync zurück. Ein Backup dieser Schlüssel
stellt einen Nutzer daher vollständig auf einem neuen Gerät wieder her.

```js
// altes Gerät: Backup erzeugen (eine Zeile Text, mit Passphrase verschlüsselt)
const backup = await qu.device.exportBackup(passphrase);   // oder: await qu.device.downloadBackup(passphrase)

// neues Gerät
const qu = await createClient({ url, restore: { backup, passphrase } });
await qu.restoreGroups();                                   // Gruppen öffnen, Inhalte kommen vom Relay
```

- **Verschlüsselung:** PBKDF2-SHA256 mit 600 000 Runden (≈ 0,1 s am Desktop, bis ≈ 1 s auf schwachen
  Handys) und AES-256-GCM. Falsche Passphrase und beschädigtes Backup ergeben denselben Fehler.
  Passphrasen unter 8 Zeichen werden abgelehnt – in der UI lieber eine lange Passphrase (mehrere
  Wörter) empfehlen, denn wer das Backup hat, kann offline raten.
- **Gleiche Identität auf zwei Geräten** funktioniert: Beide schreiben, beide lesen.
- **Schutz vor Überschreiben:** Gehört der Speicher schon einer anderen Identität, die hier Gruppen hat,
  verweigert `restore` – andere Datenbank wählen (`name`) oder bewusst `force: true`. Eine beim ersten
  Start automatisch erzeugte Identität ohne Gruppen wird einfach ersetzt (typischer Ablauf: App startet,
  Nutzer wählt „Aus Backup wiederherstellen“).
- **Speicherschutz:** `qu.device.persist()` bittet den Browser, IndexedDB nicht zu räumen. Firefox fragt
  den Nutzer dabei, Chrome entscheidet selbst (z. B. für installierte PWAs). Deshalb nicht automatisch
  beim ersten Laden, sondern an einem verständlichen Punkt – etwa nach dem Anlegen der ersten Gruppe.
  `createClient({ persist: true })` fragt sofort.
- **Optional: Identität mit Passphrase sperren.** Mit `createClient({ url, passphrase })` liegt die
  Identität nur noch verschlüsselt im Speicher. Jeder Start braucht dann die Passphrase:

  ```js
  try {
    qu = await createClient({ url, passphrase: await askUser() });
  } catch (e) {
    if (e.code === 'QU_LOCKED' || e.code === 'QU_WRONG_PASSPHRASE') showUnlockDialog(e.code);
    else throw e;
  }
  ```

  Eine vorhandene unverschlüsselte Identität wird beim ersten Start mit Passphrase umgestellt. Zur
  Laufzeit: `qu.device.lock(p)`, `changePassphrase(alt, neu)`, `removeLock(p)`. Das schützt kopierte
  Festplatten, Browser-Profile und Datenbankdateien – nicht eine kompromittierte, laufende Seite. Ohne
  Passphrase und ohne Backup ist die Identität bei vergessener Passphrase verloren: Backup anbieten!
- **Status für die UI:** `await qu.device.status()` → `{persisted, usage, quota, backupAt, groups, locked, keys, keyLocked}` – z. B.
  „Kein Backup seit 30 Tagen“ oder „Speicher nicht geschützt“ anzeigen.

**Archiv** (Plugin `archive`, optional): Spaces oder einen ganzen Nutzer als Datei sichern und
wiederherstellen. Ohne Passphrase ist das Archiv für jeden ohne Schlüssel unlesbar; mit Passphrase
enthält es zusätzlich Identität und Schlüssel. Beim Import wird alles geprüft wie Daten aus dem Netz.
Damit lässt sich auch ein Relay umziehen.

```js
await qu.archive.download({ passphrase });                 // alles, als Datei
const { backup } = readArchive(datei);                     // auf dem neuen Gerät
const qu = await createClient({ url, restore: { backup, passphrase }, extra: ['archive'] });
await qu.archive.import(datei);
```

### Anmelden mit YubiKey oder Passkey

Statt Backup-Datei und Passphrase: Ein **Sicherheitsschlüssel** (YubiKey per USB am PC, per NFC am
Handy) oder ein **Passkey** (Face ID, Fingerabdruck, Windows Hello; von Apple bzw. Google zwischen den
eigenen Geräten synchronisiert) öffnet die Identität auf jedem Gerät.

```js
// Einrichten (einmal, aus einem Klick heraus): Key antippen
await qu.device.addKey({ name: 'YubiKey blau' });
await qu.device.addKey({ name: 'YubiKey Ersatz' });            // empfohlen: ein zweiter Key

// Neues Gerät ("Einloggen"): Key einstecken oder ans Handy halten, antippen
const qu = await createClient({ url, unlock: 'key' });
await qu.restoreGroups();                                      // alle Gruppen, Inhalte kommen vom Relay
```

So funktioniert es:

- **Nichts wird ausgelesen.** Der Key liefert über die WebAuthn-Erweiterung PRF ein Geheimnis, das nur er
  erzeugen kann.
- **Tresor:** Damit wird ein Tresor verschlüsselt, der die Identität und die Gruppenschlüssel enthält.
  Der Relay bewahrt ihn für andere Geräte auf, kann ihn aber nicht öffnen. Ändern oder löschen kann ihn
  nur die Identität selbst (signiert).
- **Kein Benutzername nötig:** Der Browser bietet den passenden Schlüssel von sich aus an.
- **Der Tresor folgt den Gruppen:** Neue Gruppen und neue Epochen kommen automatisch hinein.

Einstellungen:

- **Nur mit Key starten (geteilte Geräte):** `addKey({ lock: true })`. Dann liegt auf dem Gerät keine
  nutzbare Identität mehr, und jeder Start braucht `createClient({ url, unlock: 'key' })`. Ohne
  `unlock` bricht der Start mit `QU_LOCKED` ab und legt nie stillschweigend eine neue Identität an.
  Auf einem neuen Gerät entscheidet `unlock: { remember: false }` dasselbe.
- **Art des Schlüssels vorgeben:** `kind: 'security-key'` oder `kind: 'passkey'` bei `addKey` und
  `unlock` (ohne Angabe bietet der Browser beides an). Verwalten mit `qu.device.keys()` und
  `qu.device.removeKey(id)`.

**Was der Nutzer sieht:** Die App muss nicht wissen, was benutzt wird. Der Browser zeigt seinen eigenen
Dialog mit dem, was vorhanden ist, und der Nutzer wählt. Danach steht in `qu.device.keys()`, was es war.

| Nutzer wählt | `type` / `transports` | Name ohne Angabe | Geht? |
|---|---|---|---|
| YubiKey am PC (USB) | `security-key` / `usb` | Security key (USB) | ja |
| YubiKey am Handy (NFC) | `security-key` / `nfc` | Security key (NFC) | iPhone ab iOS 26.4; Android je nach Gerät |
| eToken FIDO (FIDO2) | `security-key` | Security key (…) | ja, wenn er `hmac-secret` kann. Klassische eTokens (Zertifikat/Smartcard) gehen im Browser nicht |
| Android-Fingerabdruck, Google Passwortmanager | `passkey` / `internal`, `hybrid` | Passkey (Google Password Manager) | ja |
| Face ID / Touch ID (iCloud-Schlüsselbund) | `passkey` | Passkey (iCloud Keychain) | ja (iOS/macOS 18+) |
| Windows Hello | `passkey` / `internal` | Passkey (Windows Hello) | neuere Versionen, vorher testen |
| anderes Handy per QR-Code | `passkey` / `hybrid` | Passkey (phone) | ja |

Für die Oberfläche reicht ein Knopf „Mit Passkey oder Sicherheitsschlüssel schützen“. Ein eigener
Knopf „YubiKey“ (`kind: 'security-key'`) lohnt nur, wenn die Zielgruppe gezielt Hardware-Keys nutzt.
Wählt der Nutzer etwas ohne die nötige Fähigkeit, meldet Qu `QU_KEY_UNSUPPORTED` und bittet den
Browser, den unbrauchbaren Eintrag wieder zu entfernen. Alle Fehlercodes stehen in
[API.md](API.md#errors).

Fehler, die die App abfangen sollte:

```js
try {
  qu = await createClient({ url, unlock: 'key' });
} catch (e) {
  if (e.code === 'QU_KEY_CANCELLED') zeige('Abgebrochen – nochmal antippen');
  else if (e.code === 'QU_KEY_UNKNOWN') zeige('Dieser Schlüssel gehört zu keiner Identität hier – neu anlegen?');
  else if (e.code === 'QU_KEY_UNSUPPORTED') zeige('Key oder Browser kann das nicht – Backup-Datei verwenden');
  else throw e;
}
```

Grenzen:

- **Adresse:** Die Registrierung gilt pro Web-Adresse. PC und Handy müssen dieselbe App-Domain öffnen.
  `http://localhost` geht zum Entwickeln, eine IP-Adresse nicht.
- **Klick nötig:** Browser verlangen einen Klick des Nutzers, sonst bricht der Aufruf ab. Safari ist
  dabei streng.
- **Plattformen:**
  - Am PC laufen Chrome, Edge und Firefox mit YubiKey per USB.
  - iPhone und Mac (Safari ab 26.4) können Keys per USB und NFC. Ein Fehler in 26.4 ist in späteren
    Versionen behoben.
  - Bei Android mit NFC hängt es vom Gerät ab, bitte einmal testen.
  - Passkeys gehen fast überall.
  - Rückfall bleibt immer das Backup.
- **Key verloren:** Vom anderen Key aus `removeKey(id)` aufrufen. Was jemand mit dem verlorenen Key schon
  geöffnet hat, lässt sich nicht zurückholen. Deshalb am YubiKey eine **PIN** setzen: Ohne PIN genügt
  der Besitz des Keys.
- **Die Demo** zeigt beides: „Sicherheitsschlüssel / Passkey hinzufügen“ und auf dem zweiten Gerät
  `demo.html?name=neu&unlock`.

## 11. Testen

```js
import { createQu, records, sync, Space, connectInProcess } from '@qu/lite';

const a = await createQu(); a.use(records()); a.use(sync({ retryMs: 0 }));
const b = await createQu(); b.use(records()); b.use(sync({ retryMs: 0 }));
const link = connectInProcess(a, b);          // gleicher Code-Pfad wie echte Transporte
await link.ready;
// … Asserts …
await Promise.all([a.close(), b.close()]);
```

- Warten mit `until(check, ms)` (siehe `test/helpers.js`), nie mit festen Sleeps.
- Relay im Test: `createRelay({ port: 0, log: () => {} })` – Port 0 = frei gewählt.
- Gesamtsuite **zweimal** laufen lassen (`npm test`): einige Tests sind zeitbasiert.

## 12. Checkliste für produktive Apps

- [ ] `createClient({ name })` mit eigenem DB-Namen pro App
- [ ] `qu.device.persist()` an einem passenden Punkt (z. B. nach der ersten Gruppe)
- [ ] Backup in der UI anbieten (`downloadBackup`), Erinnerung über `device.status().backupAt`
- [ ] Wiederherstellung anbieten: `createClient({ restore })` + `restoreGroups()`
- [ ] `qu.close()` bei Logout / HMR / Unmount
- [ ] Verbindungs- und Outbox-Status in der UI
- [ ] `qu.staleSpaces()` beim Start prüfen (Gerät > 90 Tage offline)
- [ ] Eigene Validierung in `qu.accept`
- [ ] Relay hinter TLS-Proxy ([DEPLOY.md](DEPLOY.md)), `/readyz` im Load-Balancer, `/metrics` im Monitoring
- [ ] Quoten, `--max-spaces`, `--max-connections` passend zur Hardware
- [ ] Backups der Relay-DB (`npm run backup`, [INSTALL.md](INSTALL.md))
- [ ] Devtools in Produktion: `createClient({ devtools: false })` oder bewusst lassen (nur lesend, Schlüssel maskiert)

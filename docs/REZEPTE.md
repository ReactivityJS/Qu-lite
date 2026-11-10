# Rezepte: welche Bausteine für welche App

Qu Lite hat keine App-spezifischen Teile. Jede App setzt sich aus denselben Bausteinen zusammen:

| Baustein | Wofür | API |
|---|---|---|
| **Space** | ein verschlüsselter Datenraum mit Mitgliedern (Gruppe), einem Besitzer (Profil) oder offenem Schreibzugang (Forum) | `createGroup()`, `acceptInvite()`, `members()` |
| **Log-Record** | etwas, das passiert ist: Nachricht, Spielzug, Messwert | `write(space, path, value)` |
| **Keyed Record** | etwas mit aktuellem Stand: Termin, Profilfeld, Spielstand (letzter Schreiber gewinnt) | `write(…, { key })`, `get()` |
| **Abfrage** | Zeitfenster oder beliebiges Feld | `query({ space, path, where, orderBy, from, to })` |
| **Signal** | flüchtig, nie gespeichert: Tippen, Zeiger, „klingelt“ | `signal()`, `status()` |
| **Datei** | beliebig groß, in Stücken, verschlüsselt, auf Abruf | `blobs.put()`, `blobs.get()` |
| **Öffentlich** | signiert, nicht verschlüsselt, ohne Mitgliedschaft lesbar | `write(…, { visibility: 'public' })`, `fetchPublic()` |
| **Hintergrund / Push** | Ausliefern bei geschlossener App, Wecken | `background`, `push`, `quServiceWorker()` |

Alle Rezepte nutzen `createClient()` im Browser (IndexedDB, Relay-Verbindung, Konsole) und einen
Relay (`npx qu-lite-mirror` oder `createRelay()`). Die lauffähigen Fassungen liegen in
[examples/](../examples/); sie laufen in jedem Testlauf mit.

## Messenger

```js
const qu = await createClient({ url: 'https://relay.example', extra: ['blobs', 'background', 'push'] });
await qu.restoreGroups();                                   // nach jedem Start
const chat = await qu.createGroup();                        // oder: await qu.acceptInvite(einladung)
const invite = await (await qu.members(chat)).invite();     // als Link/QR teilen (7 Tage gültig)

qu.bus.on(`qu.record.${chat.id}`, (r) => r.path === 'chat' && zeige(r));   // live
await qu.write(chat, 'chat', { text: 'Hallo' });
const verlauf = await qu.query({ space: chat, path: 'chat', limit: 50, reverse: true });

const st = await qu.status(chat);                           // online, tippt, gelesen
await st.sendTyping('chat');
await st.markRead('chat');
const { delivered, read } = await st.of(nachricht);

const bild = await qu.blobs.put(chat, file, { name: file.name, type: file.type });
await qu.write(chat, 'chat', { text: 'Foto', file: bild });
qu.bus.on('qu.sync.progress', ({ records, bytes }) => zeigeUpload(records, bytes));
await qu.push.enable([chat], { labels: { [chat.id]: 'Familie' } });   // aus einem Klick heraus
```

Beispiele: [04-groups](../examples/04-groups.mjs), [05-status](../examples/05-status.mjs), [08-blobs](../examples/08-blobs.mjs).

## Kalender, Aufgaben, Listen

Ein Termin ist ein Keyed Record (Schlüssel = Termin-Id); Bearbeiten schreibt eine neue Version.
Abfragen gehen über jedes Feld, ohne Kalender-Sonderweg:

```js
await qu.write(team, 'events', { title: 'Review', start: Date.UTC(2026, 10, 11, 14), tags: ['work'] }, { key: id });
const woche = await qu.query({ space: team, path: 'events', where: { start: { gte: montag, lt: naechsterMontag } }, orderBy: 'start' });
const offen = await qu.query({ space: team, path: 'tasks', where: { status: 'offen', tags: 'dringend' } });
const suche = await qu.query({ space: team, path: 'events', where: { title: { contains: 'review' } } });
await qu.del(team, 'events', id);                            // löschen (für alle)
```

Beispiel: [10-calendar](../examples/10-calendar.mjs).

## Multiplayer-Spiel

- **Was gerade passiert** (Zeiger, Bewegung, „bereit?“): Signale. Sie werden nie gespeichert und
  kosten keinen Speicher.
- **Was bleiben muss** (Brett, wer am Zug ist, Punkte): Records. Sie sind auch offline und nach
  einem Reload gleich.
- **Kurze Latenz zwischen Spielern:** zusätzlich direkte Verbindungen über WebRTC (Transport
  `webrtc`, siehe [API.md](API.md#transports)).

```js
qu.bus.on(`qu.signal.${spiel.id}.zug`, ({ author, value }) => animiere(author, value));
await qu.signal(spiel, 'zug', { x: 3, y: 4 });
await qu.write(spiel, 'game', { brett, amZug: gegner, runde }, { key: 'state' });
const top = await qu.query({ space: spiel, path: 'scores', where: { runde: 7 }, orderBy: 'punkte', reverse: true, limit: 10 });
```

Beispiel: [11-game](../examples/11-game.mjs).

## Forum, Kommentare, offener Raum

```js
const forum = await mod.createGroup({ open: true });
const link = await (await mod.members(forum)).link();       // veröffentlichen: jeder darf schreiben
const raum = await gast.acceptInvite(link);
await gast.write(raum, 'posts', { thread: 'start', text: 'Hallo' }, { visibility: 'public' });
const thread = await qu.query({ space: forum, path: 'posts', where: { thread: 'start' } });   // in Schreib-Reihenfolge
await (await mod.members(forum)).ban(alias);                 // gilt bei allen Mitgliedern und am Relay
await mod.del(forum, beitrag);
```

Der Relay begrenzt neue Beiträge pro Autor (Standard 20 auf einmal, dann einer alle 5 s). Gäste
ohne Qu lesen öffentliche Beiträge mit `fetchPublic()`.

## Blog, öffentliche Seite, Profil

```js
const blog = await autor.createGroup();                      // Mitglieder = Autoren
await autor.write(blog, 'posts', { title, body }, { key: slug, visibility: 'public' });
// irgendwo im Web, ohne Identität:
const posts = await fetchPublic('https://relay.example', blog.id, 'posts');
const link = publicLink('https://relay.example', blog.id, 'posts');   // https://relay.example/q/<sid>/posts
```

Jeder Leser prüft die Signaturen selbst. Ein Relay kann Beiträge unterschlagen, aber nicht ändern.

Beispiel: [12-forum-blog](../examples/12-forum-blog.mjs).

## Dateien austauschen

```js
const ref = await qu.blobs.put(space, file, { name: file.name, type: file.type }); // auch offline
qu.bus.on('qu.blob.progress', ({ direction, done, total }) => zeige(direction, done, total));
const bytes = await qu.blobs.get(space, ref);                // lädt fehlende Stücke nach
```

So bleibt es zuverlässig:

- Dateien werden in 64-KiB-Stücken übertragen, jedes Stück ist ein normaler Record. Ein
  abgebrochener Upload macht nach dem Reconnect oder Reload genau dort weiter.
- Jedes Stück wird gegen seinen Hash geprüft.
- Gleiche Dateien werden nicht doppelt gespeichert.
- Mit `background` liefert Background Sync die Outbox auch bei geschlossenem Tab aus.

## Mobile Apps und Offline

- **Offline:** Jede Schreiboperation landet sofort lokal und in der Outbox. Der Abgleich läuft
  beim nächsten Kontakt automatisch und ist unterbrechbar. `ackFrom: 'mirror'` meldet „gesendet“
  erst, wenn ein Relay den Record dauerhaft gespeichert hat.
- **Im Hintergrund:** Präsenz schlägt nur alle 5 min statt alle 20 s (`status`). Background Sync
  liefert die Outbox aus. Push weckt bei neuen Nachrichten und Anrufen (iOS: als
  Home-Bildschirm-App).
- **Daten sparen:** Ein Reconnect ohne Änderungen kostet etwa 3,6 KiB für 20 Spaces.
  `qu.dev.traffic()` zeigt, wofür Bytes fließen.
- **Gerät wechseln:** `qu.device.exportBackup(passphrase)` und `createClient({ restore })`.
  `qu.device.persist()` bittet den Browser, die Daten nicht zu räumen.

Mehr: [GUIDE.md](GUIDE.md) (Einführung), [API.md](API.md) (Referenz), [CONSOLE.md](CONSOLE.md) (Fehlersuche).

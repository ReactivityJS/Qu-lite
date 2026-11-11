# Anleitung für Nutzer

Diese Seite erklärt für Menschen ohne Technikhintergrund, wie eine App auf Basis von Qu Lite mit deinen Daten
umgeht und wie du Geräte, Sicherheitsschlüssel und Sicherungen einrichtest.

*Für App-Entwickler:* Die Abschnitte sind so geschrieben, dass du sie in die Hilfe deiner App übernehmen kannst.
Ersetze „die App“ durch ihren Namen und lass weg, was deine App nicht anbietet. Was im Code dahintersteht,
steht jeweils am Ende des Abschnitts.

- [Das Wichtigste in Kürze](#das-wichtigste-in-kürze)
- [Dein Konto ist dein Gerät](#dein-konto-ist-dein-gerät)
- [Mit YubiKey oder Passkey schützen](#mit-yubikey-oder-passkey-schützen)
- [Auf einem neuen Gerät anmelden](#auf-einem-neuen-gerät-anmelden)
- [Schlüssel verloren](#schlüssel-verloren)
- [Sicherung als Datei](#sicherung-als-datei)
- [Passphrase für dieses Gerät](#passphrase-für-dieses-gerät)
- [Offline und schlechtes Netz](#offline-und-schlechtes-netz)
- [Benachrichtigungen](#benachrichtigungen)
- [Speicher und Daten auf dem Gerät](#speicher-und-daten-auf-dem-gerät)
- [Was der Server sieht](#was-der-server-sieht)
- [Meldungen und was sie bedeuten](#meldungen-und-was-sie-bedeuten)

## Das Wichtigste in Kürze

- **Kein Passwort, kein Konto beim Anbieter.** Die App erzeugt auf deinem Gerät einen geheimen Schlüssel.
  Er ist deine Identität und verlässt das Gerät nie unverschlüsselt.
- **Ende-zu-Ende-verschlüsselt.** Nachrichten, Termine und Dateien werden auf deinem Gerät verschlüsselt. Der
  Server (das *Relay*) leitet sie weiter und bewahrt sie auf, kann sie aber nicht lesen.
- **Funktioniert offline.** Du kannst jederzeit schreiben; die App schickt alles, sobald wieder Netz da ist.
- **Sichere dich ab.** Ein YubiKey, ein Passkey oder eine Sicherungsdatei, sonst sind deine Daten mit dem Gerät
  weg.

## Dein Konto ist dein Gerät

Beim ersten Start legt die App deine Identität auf diesem Gerät an. Es gibt keinen Benutzernamen und kein
Passwort, das jemand stehlen oder zurücksetzen könnte. Daraus folgt:

- **Neues Handy, neuer Browser, Browserdaten gelöscht:** Ohne Schlüssel oder Sicherung beginnst du von vorn. Der
  Anbieter kann dein Konto nicht wiederherstellen, er hat es nie gehabt.
- **Mehrere Geräte:** Mit YubiKey, Passkey oder Sicherungsdatei nimmst du dieselbe Identität mit, inklusive aller
  Gruppen.
- **Privates Fenster (Inkognito):** Dort vergisst der Browser beim Schließen alles. Für dauerhaftes Arbeiten
  ein normales Fenster nutzen.

*Entwickler:* `createClient()` legt die Identität in IndexedDB an; [GUIDE.md](GUIDE.md#10a-identität-absichern).

## Mit YubiKey oder Passkey schützen

Am bequemsten: Ein **Passkey** (Fingerabdruck, Gesichtserkennung, Windows Hello) oder ein
**Sicherheitsschlüssel** wie ein YubiKey öffnet deine Identität auf jedem Gerät, mit einem Antippen.

**Einrichten** (einmal):

1. In der App **„Mit Passkey oder Sicherheitsschlüssel schützen“** wählen.
2. Der Browser zeigt ein eigenes Fenster. Wähle, was du nutzen willst:
   - **YubiKey am Computer:** einstecken, auf die goldene Fläche tippen.
   - **YubiKey am Handy:** an die Rückseite des Handys halten (NFC), bis es vibriert oder piept.
   - **Fingerabdruck / Gesicht:** wie beim Entsperren des Handys. Dein Passwortmanager (Google, Apple) speichert
     den Passkey und hat ihn auch auf deinen anderen Geräten.
3. Hat dein YubiKey eine **PIN**, fragt der Browser danach. Am YubiKey ist es manchmal nötig, zweimal zu tippen.
4. Fertig. Die App zeigt den Schlüssel in der Liste, z. B. „Security key (USB, NFC)“.

**Empfehlung:** Einen **zweiten Schlüssel** als Ersatz einrichten, z. B. einen zweiten YubiKey, der zu Hause
liegt, oder zusätzlich den Passkey im Handy. Und am YubiKey eine PIN setzen: Ohne PIN genügt es, den Schlüssel
in der Hand zu haben.

**Was geht wo?**

| Gerät | YubiKey per USB | YubiKey per NFC | Fingerabdruck / Gesicht |
|---|---|---|---|
| Windows, Mac, Linux (Chrome, Edge, Firefox) | ja | – | Windows Hello: neuere Versionen |
| Mac (Safari) | ja | – | Touch ID: ja |
| iPhone, iPad | ja (USB-C / Lightning-Key) | ja, ab iOS 26.4 | Face ID / Touch ID: ja |
| Android (Chrome) | ja (USB-C) | je nach Gerät, bitte ausprobieren | Fingerabdruck: ja |

Ein **eToken** funktioniert, wenn es ein FIDO2-Modell ist (z. B. „eToken FIDO“). Ältere eTokens mit Zertifikat
(Smartcard) kann der Browser dafür nicht nutzen.

**Wichtig:** Der Schlüssel gilt für **eine Adresse**. Öffne die App auf allen Geräten unter derselben Adresse
(z. B. immer `https://chat.example.org`).

*Entwickler:* `qu.device.addKey()`, Tabelle „Was der Nutzer sieht“ in
[GUIDE.md](GUIDE.md#anmelden-mit-yubikey-oder-passkey).

## Auf einem neuen Gerät anmelden

1. Die App auf dem neuen Gerät unter **derselben Adresse** öffnen.
2. **„Mit Passkey oder Sicherheitsschlüssel anmelden“** wählen.
3. Schlüssel einstecken bzw. ans Handy halten, oder Fingerabdruck. Einmal antippen.
4. Deine Identität und alle Gruppen sind da. Nachrichten laden in den nächsten Sekunden nach.

Geht es nicht?

- **„Dieser Schlüssel gehört zu keiner Identität hier“:** Andere Adresse als beim Einrichten, oder ein anderer
  Schlüssel.
- **„Abgebrochen“:** Das Fenster wurde geschlossen oder es dauerte zu lange. Einfach nochmal.
- **„Kann dieser Schlüssel/Browser nicht“:** Der Schlüssel oder Browser beherrscht die nötige Funktion nicht.
  Nimm die [Sicherungsdatei](#sicherung-als-datei) oder einen anderen Schlüssel.

**Geteilte Geräte** (Familien-Tablet, Arbeitsplatz): Die App kann so eingestellt sein, dass sie bei **jedem**
Start nach dem Schlüssel fragt. Ohne Schlüssel kommt dann niemand an deine Daten.

*Entwickler:* `createClient({ url, unlock: 'key' })`, `addKey({ lock: true })`.

## Schlüssel verloren

1. Auf einem Gerät, das noch angemeldet ist (oder mit dem Ersatzschlüssel), die Schlüsselliste öffnen.
2. Den verlorenen Schlüssel **entfernen**. Er öffnet danach nichts mehr.
3. Einen neuen Ersatzschlüssel einrichten.

Hatte der verlorene YubiKey **keine PIN**, konnte der Finder ihn benutzen. Was er damit schon geöffnet hat,
lässt sich nicht zurückholen. Dann sicherheitshalber eine neue Identität anlegen und deine Gruppen neu einladen
lassen.

*Entwickler:* `qu.device.removeKey(id)`.

## Sicherung als Datei

Ohne YubiKey oder Passkey: eine **Sicherungsdatei** mit einer Passphrase.

- **Erstellen:** In der App „Sicherung herunterladen“ wählen und eine **lange Passphrase** vergeben (mindestens
  12 Zeichen, besser ein ganzer Satz). Die Datei sicher aufbewahren, z. B. im Passwortmanager oder auf einem
  USB-Stick.
- **Wiederherstellen:** Auf dem neuen Gerät „Sicherung einspielen“, Datei wählen, Passphrase eingeben.
- **Ohne Passphrase ist die Datei wertlos.** Niemand, auch nicht der Anbieter, kann sie öffnen. Die Passphrase
  geht nirgendwohin und lässt sich nicht zurücksetzen.
- **Neue Gruppe seit der letzten Sicherung?** Dann eine neue Sicherung machen. Mit YubiKey/Passkey ist das nicht
  nötig, dort kommen neue Gruppen automatisch hinzu.

Manche Apps bieten zusätzlich ein **Archiv** an: Es enthält zusätzlich alle Nachrichten und Dateien und
eignet sich zum Aufbewahren oder für einen Umzug.

*Entwickler:* `qu.device.downloadBackup()`, `createClient({ restore })`, Plugin `archive`.

## Passphrase für dieses Gerät

Eine App kann deine Identität zusätzlich mit einer **Passphrase** auf dem Gerät verschließen. Dann fragt sie bei
jedem Start danach, ähnlich wie eine PIN. Sinnvoll auf Geräten, die andere mitbenutzen. Die Passphrase lässt
sich ändern oder wieder entfernen; vergessen bedeutet: Die Identität auf diesem Gerät ist nicht mehr nutzbar
(mit Schlüssel oder Sicherung geht es trotzdem weiter).

*Entwickler:* `createClient({ passphrase })`, `qu.device.lock()`.

## Offline und schlechtes Netz

- Du kannst **jederzeit schreiben**, auch im Flugzeug. Die App merkt sich alles und schickt es, sobald wieder
  Netz da ist.
- Ein Hinweis wie „3 Nachrichten werden gesendet“ zeigt, dass noch etwas unterwegs ist.
- **Große Uploads am Handy:** Chrome und Edge schicken auch nach dem Schließen der App weiter. In Safari und
  Firefox die App offen lassen, bis alles gesendet ist; die App hält den Bildschirm dafür an, sonst geht es beim
  nächsten Öffnen weiter.
- Abgebrochene Uploads und Downloads setzen dort fort, wo sie aufgehört haben.

*Entwickler:* Plugin `background`, `qu.sync.progress`.

## Benachrichtigungen

- Die App fragt **einmal** um Erlaubnis, wenn du Benachrichtigungen einschaltest.
- Du bekommst Bescheid über neue Nachrichten in den Gruppen, die du ausgewählt hast, und über **Anrufe**.
  Lesebestätigungen und „ist online“ lösen nie eine Benachrichtigung aus.
- **iPhone/iPad:** Benachrichtigungen gibt es nur, wenn du die App **zum Home-Bildschirm hinzufügst**
  (Teilen-Symbol → „Zum Home-Bildschirm“) und sie von dort öffnest.
- **Datenschutz:** Über Apple, Google oder Mozilla läuft nur das Signal „aufwachen“. Was in der Benachrichtigung
  steht, holt die App direkt vom Relay, und der Gruppenname kommt von deinem Gerät.
- Abschalten: in der App oder in den Einstellungen des Browsers / Handys.

*Entwickler:* Plugin `push`, Service Worker `qu-sw.js`.

## Speicher und Daten auf dem Gerät

- Alles liegt im Speicher des Browsers. Browser dürfen diesen Speicher bei Platzmangel räumen. Die App bittet
  deshalb darum, ihn **dauerhaft** zu behalten; manche Browser fragen dich dazu.
- **„Speicher voll“:** Platz auf dem Gerät schaffen (alte Fotos, andere Apps) oder in der App alte Dateien
  löschen. Danach geht es normal weiter, nichts ist verloren.
- **Browserdaten löschen** löscht auch die App-Daten. Vorher Schlüssel oder Sicherung einrichten.

*Entwickler:* `qu.device.persist()`, `qu.device.status()`, Ereignis `qu.storage.full`.

## Was der Server sieht

Das Relay ist ein Briefkasten für verschlossene Umschläge:

| Sieht der Server … | |
|---|---|
| Inhalt von Nachrichten, Terminen, Dateien | **nein**, verschlüsselt |
| Namen von Gruppen und Personen | **nein** |
| Wer mit wem schreibt (Namen) | **nein**; er sieht nur Kennungen ohne Namen |
| Wann und wie viel geschrieben wird (Zeit, Größe) | **ja**, grob (Zeit auf die Minute, Größe gerundet) |
| Deine IP-Adresse | ja, wie jede Website |
| **Öffentliche** Beiträge (Blog, offenes Forum) | ja, die sind ausdrücklich für alle |

Auch der Betreiber des Relays kann deine Nachrichten nicht lesen. Er kann sie aber zurückhalten oder löschen,
deshalb lassen sich Apps mit mehreren Relays gleichzeitig betreiben.

*Entwickler:* [SECURITY-REVIEW.md](SECURITY-REVIEW.md), [DECISIONS.md](DECISIONS.md).

## Meldungen und was sie bedeuten

| Meldung (sinngemäß) | Bedeutung | Was tun |
|---|---|---|
| Abgebrochen | Schlüssel-Fenster geschlossen oder zu langsam | nochmal |
| Dieser Schlüssel gehört zu keiner Identität hier | falsche Adresse oder anderer Schlüssel | richtige Adresse / anderen Schlüssel nehmen |
| Kann dieser Schlüssel/Browser nicht | Funktion fehlt | anderen Schlüssel, Passkey oder Sicherungsdatei |
| Gesperrt | Identität braucht Passphrase oder Schlüssel | Passphrase eingeben bzw. Schlüssel antippen |
| Falsche Passphrase | Tippfehler? | nochmal |
| Speicher voll | Gerät hat keinen Platz mehr | Platz schaffen, nichts geht verloren |
| Daten stammen von einer neueren Version | App wurde auf einem anderen Gerät schon aktualisiert | App aktualisieren (Seite neu laden) |
| Ungültige Daten | Eingabe passt nicht (z. B. Datum fehlt) | Eingabe prüfen |

*Entwickler:* Fehlercodes `QU_*` mit empfohlener Reaktion in [API.md](API.md#errors).

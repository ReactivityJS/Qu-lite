# Qu Lite – Dokumentation

Qu Lite ist eine Basis für verteilte, Ende-zu-Ende-verschlüsselte Apps: Chat und Messenger, Kalender, Spiele,
Foren, Blogs. Daten liegen auf den Geräten und werden über ein Relay abgeglichen, das sie nicht lesen kann.
Alles funktioniert offline, mehrere Geräte und mehrere Relays sind vorgesehen.

## Wer liest was

| Du bist … | Lies | Darin |
|---|---|---|
| **Nutzer einer App** | [Anleitung für Nutzer](BENUTZER.md) | YubiKey / Passkey, neues Gerät, Sicherung, offline, Benachrichtigungen, was der Server sieht |
| **Entwickler, Einstieg** | [Entwickler-Guide](GUIDE.md) | das Modell, Schnellstart, Daten und Abfragen, Gruppen, Plugins, Identität, Checkliste |
| **Entwickler, „wie baue ich …“** | [Rezepte](REZEPTE.md) | Messenger, Kalender, Spiel, Forum, Blog, Dateien, Mobil – jeweils mit Code |
| **Entwickler, Nachschlagen** | [API-Referenz](API.md) (englisch) | jede Funktion, jede Option, Fehlercodes, Ereignisse, Formate |
| **Entwickler, Fehlersuche** | [Dev-Konsole](CONSOLE.md) | `qu.dev`, Datenvolumen, Speicher, zwei Browser über ein Relay |
| **Betreiber eines Relays** | [Installation](INSTALL.md) · [Betrieb](DEPLOY.md) (englisch) | Docker, Swarm, Reverse Proxy, eigene App unter `/`, Backups, Monitoring |
| **Prüfer, Architekt** | [Sicherheit](SECURITY-REVIEW.md) · [Entscheidungen](DECISIONS.md) · [Tests](TESTING.md) | Bedrohungsmodell, Begründungen, Testabdeckung |

Lauffähige Beispiele liegen in [`examples/`](../examples/README.md) (jedes mit `node examples/<datei>`); sie laufen
in jedem Testlauf mit und bleiben deshalb aktuell.

## In fünf Minuten ausprobieren

```sh
git clone https://github.com/ReactivityJS/Qu-lite && cd Qu-lite
npm install && npm run demo          # Relay mit Startseite und Demo auf http://localhost:8787
```

- `http://localhost:8787/demo.html?name=anna` und in einem zweiten Browser `…?name=ben`: Gruppe gründen,
  Einladung teilen, chatten.
- Oder zwei Browser-Konsolen Schritt für Schritt: [Dev-Konsole → Zwei Browser über einen Relay](CONSOLE.md#zwei-browser-über-einen-relay).

## Die Doku im Web

Ein Relay kann diese Doku selbst ausliefern (`/docs/`). Das ist abgeschaltet, bis man es einschaltet:
`QU_DOCS=1` im Container bzw. `--docs` beim Start ([Installation](INSTALL.md#documentation-on-the-relay)).

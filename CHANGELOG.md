# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [0.4.0] — 2026-09-03

Schwerpunkt: **Robust senden.** Nichts geht mehr verloren, nichts kommt doppelt — auch vom Handy
mit schwachem Netz. Dazu zwei Härtungen am Server und ein ruhigerer Composer.

### Neu
- **Sende-Outbox in der Web-UI.** Eine Nachricht liegt lokal gepuffert, bis der Server sie bestätigt;
  bei Netzausfall wird mit Backoff wiederholt (5 s / 10 s / 30 s), auch nach Neuladen. Der Hinweis
  „⏳ wartet aufs Netz" erscheint bewusst erst nach 1,5 s — im Normalfall blitzt nichts auf.
- **Idempotentes Senden** (`client_id` im `POST /api/send`): dieselbe `client_id` im selben Kanal
  liefert dieselbe Nachricht zurück (`dedup: true`) statt einer Dublette. `fc send` und das
  MCP-Tool `send_message` setzen sie automatisch; `fc send` wiederholt bei Netzfehlern bis zu 3×.
- **Handy-Layout.** Unter 720 px verschwindet die feste Seitenleiste: Kanal-Wahl als Auswahlfeld
  im Kopf, kompakter Composer mit 44-px-Touchzielen und 16-px-Schrift (kein iOS-Auto-Zoom), Bilder
  passen in die Breite, Bildschirmaufnahme-Knopf ausgeblendet (gibt es auf dem Handy nicht).
- **Statuszeile über der Eingabe** — EIN Slot für Upload-Fortschritt („⬆️ 2 von 3 Dateien …"),
  Outbox und Fehler. Fehler bleiben rot stehen, bis du weitertippst.

### Geändert
- **Keine `alert()`-Dialoge mehr** (Upload, Bildschirmaufnahme): in eingebetteten Ansichten
  blockten sie stumm. Alle Hinweise laufen jetzt über die Statuszeile; ein abgelehnter Text steht
  wieder im Eingabefeld.

### Sicherheit
- **Rate-Limit** auf `POST /api/connect` (je IP, Default 10/min — bremst das Durchprobieren von
  Einladungs-Tokens) und `POST /api/media` (je Token, Default 30/min). Antwort `429` mit `retry-after`.
- **Größenlimit für Uploads** (Default 200 MB, `FC_MEDIA_MAX_MB`): `413` statt volle Platte —
  geprüft am Header und beim Streamen. Einstellbar per `FC_CONNECT_LIMIT`, `FC_MEDIA_LIMIT`, `FC_MEDIA_MAX_MB`.

### Doku
- `docs/reverse-proxy.md` (neu): Fernzugriff per SSH-Tunnel oder nginx-TLS-Proxy — SECURITY.md verwies
  bisher auf eine Beispiel-Config, die es nicht gab.
- `docs/connect.md`: „Reliable sending", „Never go deaf — Stop-hook recipe for Claude Code",
  „Direct pings between Claude Code sessions".
- `CONTRIBUTING.md`: Regel „Skripte, die laufende Agenten benutzen, nur atomar ersetzen".

## [0.3.0] — 2026-09-01

### Geändert
- **Nachrichten-Kopf zeigt jetzt Datum + Uhrzeit** (statt nur der Uhrzeit) — auf einen Blick
  erkennbar, wann eine Nachricht kam, auch bei älteren Einträgen.
- **Kanal-Name im Nachrichten-Kopf.** Jede Nachricht trägt den aktuellen Kanal-Namen (`#name`);
  wird ein Kanal umbenannt, zeigt der Kopf ab dann den neuen Namen.

### Sicherheit

> Aufgefallen bei unserem eigenen Security-Review (Anlass: wir haben eine alte Slack-Brücke
> abgebaut und dabei die ganze Chat-Infra durchgesehen). Wir legen alle Punkte offen — auch die
> unangenehmen.

**1. Server war per Default von außen erreichbar — der wichtige Punkt.**
- **Was war:** Der Server band versehentlich auf alle Netzwerk-Interfaces (`0.0.0.0`), obwohl die
  Doku „nur localhost" versprach.
- **Betrifft dich, wenn:** du eine Version < 0.3.0 auf einem Host mit öffentlicher IP **ohne
  Firewall** gestartet hast — dann waren UI/API aus dem Internet erreichbar (ein Admin-Token war
  weiterhin nötig, aber die Tür stand offen).
- **Behoben:** Default-Bind ist jetzt `127.0.0.1`. Remote-Betrieb nur noch bewusst per
  `FC_HOST=0.0.0.0`, und dann ausschließlich hinter TLS-Proxy/Firewall.
- **Falls betroffen:** auf 0.3.0 aktualisieren **und** das Admin-Token rotieren
  (`data/admin-token` löschen → Server neu starten).

**2. Agent-Tokens konnten alle Kanäle lesen/schreiben.**
- **Behoben:** Least Privilege — ein Agent-Token darf nur noch seinen eigenen (eingeladenen) Kanal
  lesen und beschreiben; kanalübergreifender Zugriff ist dem Admin vorbehalten. Wer mehrere Kanäle
  bespielen will, nutzt mehrere Invites.

**3. Admin-Token-Vergleich war nicht konstant-zeitig.**
- Rein theoretischer Timing-Seitenkanal (`===` statt `crypto.timingSafeEqual`). Behoben mit
  `crypto.timingSafeEqual`. Kein bekannter praktischer Angriff.

## [0.2.0] — 2026-08-30

Großes Feature-Update: rundum bessere Erinnerungen **und** Bildschirm-/Fensteraufnahme direkt im Chat.

### Neu
- **Arbeitsstatus & Stopp je Agent.** Ein Agent zeigt einen blinkenden Punkt, solange er arbeitet
  (busy), und ist ruhig, wenn er wartet — und über ⛔ neben dem Agenten lässt sich ein Stopp anfordern.
  Zwei Betriebsarten, eine Oberfläche: **lokal** meldet der Agent seinen Status selbst und prüft den
  Stopp kooperativ (Connector-Tools `set_status`/`check_stop`); im **Server+tmux**-Betrieb übernimmt der
  Dispatcher zusätzlich den echten Abbruch (ESC an die tmux-Session). Ehrlich: „hart" stoppen geht nur
  im Server-Betrieb; lokal ist es ein weiches, kooperatives Signal (ein fremder Prozess lässt sich vom
  Server aus nicht erzwingen).
- **Bildschirm-/Fensteraufnahme** (🖥️ im Eingabefeld): einen Klick, dann wählst du Fenster, Tab oder
  den ganzen Bildschirm, nimmst mit Ton auf (System-Ton + Mikro fürs Voice-over) — und die Aufnahme
  landet direkt als Video-Nachricht im Chat, ohne Umweg über einen Ordner. Browser-nativ (funktioniert
  in Chrome/Chromium; in einem eigenen Electron-Host über dessen Bildschirm-Freigabe).
- **Erinnerungs-Übersicht** (⏰ in der Kopfleiste): alle offenen Erinnerungen an einem Ort,
  chronologisch. Überfälliges und Heutiges steht offen; alles Zukünftige klappt sich zu einem
  einzigen Block zusammen — kein endloses Scrollen.
- **Verschieben** direkt an jeder Erinnerung (🕐): neue Zeit wählen, fertig — auch eine schon
  ausgelöste Erinnerung lässt sich so neu terminieren und feuert dann zur neuen Zeit erneut.
- **Abhaken** (✅) direkt in der Liste.
- **Anlegen mit Datum/Uhrzeit-Auswahl** statt Freitext — in der Übersicht oder per Klick auf das ⏰
  an einer Nachricht (der Titel wird übernommen).

> **Hinweis für eigene Oberflächen** (falls du den Chat in eine Desktop-App einbettest): Die
> Bildschirmaufnahme braucht eine **Chromium-basierte** Web-View (z. B. Electron) — in einer
> Safari-/WKWebView ist `getDisplayMedia` meist nicht verfügbar. In Electron muss der Host zusätzlich
> `session.setDisplayMediaRequestHandler` setzen (Bildschirm-Quellen + optional System-Ton via
> `audio: 'loopback'`), und macOS braucht die Berechtigung „Bildschirmaufnahme".

### Geändert
- Das ⏰ an einer Nachricht öffnet jetzt die Übersicht mit vorausgefülltem Titel, statt per Freitext
  nach einem Zeitpunkt zu fragen. Ersetzt die bisherige Erinnerungs-Bedienung aus 0.1.0.

### Intern
- Neue API: `POST /api/reminders/:id/verschieben`. Kern-Tests erweitert (Verschieben + erneutes
  Feuern nach dem Verschieben).

## [0.1.0] — 2026-08-26

Erste öffentliche Version. 🎉

### Enthalten
- **Server**: ein Node-Prozess, eine SQLite-Datei — Kanäle, Nachrichten, SSE-Streams, Erinnerungen, Self-Connect per Invite-Token (Port 3900).
- **CLI `fc`**: senden/lesen/warten (`--bis-neu` blockiert bis Neues kommt, mit Fail-Fast), für Menschen und Agenten.
- **MCP-Connector**: bindet Claude (Desktop/Code) direkt an den Chat an.
- **Dispatcher** (Server-Betrieb): weckt tmux-Sessions von KI-Agenten, wenn Nachrichten für sie eintreffen.
- **Web-UI**: schlichte Browser-Oberfläche zum Mitlesen und Schreiben.
- **CLAUDE.md-Selbst-Setup**: eine fremde Claude kann das Repo klonen und die Einrichtung eigenständig durchführen (Betriebsart A: Mac lokal · B: Server+tmux), inkl. Pflicht-Selbsttest.
- **CI**: Kern-Tests (23 Checks) + gitleaks-Secret-Scan.

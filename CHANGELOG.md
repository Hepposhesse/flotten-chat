# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.2.0] — 2026-11-01

### Aufgaben mit Zeit
- **Aufgaben-Store** (`server/aufgaben.mjs`, Tabelle `aufgaben` + Spalte `fenster.aufgabe_id`, additiv/idempotent): Titel,
  Beschreibung, freies Label, Fälligkeit, Startzeit, optional Board-Karte, Ordner/Repo/Ort fürs Fenster. Reine Logik mit
  Zeit als Parameter, Dienst mit injizierten Abhängigkeiten (ohne tmux testbar).
- **▶ Starten** legt über die normale Fenster-Anlage ein frisches Fenster an (Name aus dem Titel, Kanal heißt wie die
  Aufgabe), der Auftrag ist der Start-Text. Eine Aufgabe, ein Fenster (409 beim zweiten Start).
- **Start-Text-Vorlage**: erst Lage + Ist → Soll → Weg + Lücken, dann EINE AskUserQuestion mit Empfehlung — kein Alleingang.
  Je Aufgabe abschaltbar, als Standard per `FC_AUFGABEN_ERST_FRAGEN=0`.
- **Zeitmessung im Server-Takt** (20 s): du (eigene Nachricht < 60 s) · Claude (laufende Klammer-Zeit, wie die Lampe) ·
  Warten auf dich (Rückfrage/Freigabe offen) · Leerlauf · Pause; Takte gedeckelt, totes Fenster wird nicht gemessen und
  pausiert nach 90 s. Tages-Töpfe in `FC_TZ` für die Auswertung.
- **Abschluss**: Fertig-Satz `✅ Aufgabe fertig: …` des Fensters, Knopf ⏹ (Ergebnis optional) oder **Kanal schließen =
  erledigt** → Abschluss-Karte mit Dauer und Anteilen im Kanal.
- **Stopp** = zurück in die Liste, Zeit + Stand (letzte Nachrichten) bleiben; **Weiter** im alten Fenster (läuft es noch)
  oder in einem neuen mit dem Stand im Start-Text. Fenster löschen = Stopp.
- **Start zur Uhrzeit** im Server-Takt (kein externes Skript); verpasste Starts (> 6 h) werden gemeldet, nicht nachgeholt.
- **Seitenleiste**: bis zu fünf kompakte Kacheln (überfällig rot pulsierend, läuft grün, Pause/heute gelb), ziehbar,
  ▶/↗ direkt an der Kachel; **„Alle“** (auch 📋 im Kopf, am Handy) mit Offen (▲/▼), Erledigt, Papierkorb, Auswertung
  (Zeit je Tag und je Aufgabe). Klick öffnet die Aufgabe im Chatbereich.
- **Uhr im Kanal-Kopf** mit ⏸/⏏/⏹ — nur für die eigene Sitzung des Fensters (gleicher Name, frühere Sitzung = keine Uhr).
- **Papierkorb** mit Rückfrage, Zurückholen, endgültig löschen.
- **Erinnerungen**: bleiben der Wecker, unverändert. „▶ Fenster“ an einer Erinnerung startet jetzt eine Aufgabe mit
  Zeitmessung (Route `/api/reminders/<id>/session` antwortet wie bisher, plus `aufgabe`), 🎯 macht ohne Start eine daraus;
  die Erinnerung gilt als übergeben, die Fälligkeit der Aufgabe meldet sich im Kanal „Erinnerungen“.
- **Board**: „🎯 Als Aufgabe“ an der Karte; Stopp und Abschluss schreiben einen Verlaufs-Eintrag an die verknüpfte Karte.
- Routen `GET/POST /api/aufgaben`, `POST /api/aufgaben/<id>[/(start|pause|weiter|stopp|fertig|verwerfen|zurueck|loeschen)]`,
  `POST /api/aufgaben/reihenfolge`, `GET /api/aufgaben/auswertung`, `POST /api/reminders/<id>/aufgabe`. Doku `docs/aufgaben.md`.
- Tests: neue `test_aufgaben.mjs` (172 Checks: Logik, Datenbank, Start/Stopp/Weiter/Fertig/Takt/Autostart/Fälligkeit,
  Erinnerung → Aufgabe, Routen), in `npm test`.

## [1.1.0] — 2026-10-06

Schwerpunkt: **Mehrstufige Rückfragen.** Alles, was eine `AskUserQuestion` kann, geht jetzt auch im Chat —
Mehrfachauswahl, mehrere Fragen hintereinander, die Absenden-Übersicht. Nachzug aus dem Live-Betrieb
(05./06.10.2026, Claude Code 2.1.289).

### Neu
- **Mehrfachauswahl mit Häkchen** (`multiSelect`): Optionen „[ ]/[✔]" werden erkannt, Knöpfe in der Karte haken
  an statt zu antworten, dazu ein Feld „Eigene Antwort" und der Knopf „Weiter ›". Eine Chat-Nachricht ist der
  ganze Schritt: „1, 3" = genau diese, „1, 3: Text" = dazu eigene Antwort, reiner Text = nur eigene Antwort,
  „keine" = nichts, „weiter" = so lassen. Der Server setzt die Häkchen per Space, tippt den Freitext ohne Enter
  (`send-keys -l`, Ctrl+U leert das Feld) und geht auf „Next" (`mehrfachSchritte()`, `textTippen()`).
  Vorbelegt mit dem, was im Terminal schon angehakt oder getippt ist.
- **Mehrere Fragen hintereinander**: die Reiter-Leiste („← ☒ Obst ☐ Farbe ✔ Submit →") wird gelesen, jede Frage
  ist eine eigene Karte; mit Protokoll steht „Frage 1 von 2" dabei.
- **Absenden-Karte** (Dialog-Art `absenden`): der Review-Reiter „Review your answers" kommt als Übersicht aller
  Antworten mit den Knöpfen „Absenden" / „Abbrechen" in den Chat; die Bestätigung ist auf Deutsch.
- `meta.dialog` trägt dafür `mehrfach`, `an` je Option, `freitext`, `freitextBisher` bzw. `antworten`.
- **Kanal-Verwaltung** (`server/kanaele.mjs`): „⋯" an jeder Zeile der Seitenleiste → Anzeigename (der technische
  Kanal-Name bleibt), Reihenfolge per Drag & Drop oder ▲/▼, Archivieren (Bereich „Archiv" unten, eingeklappt,
  „Aus dem Archiv holen"), Stumm (kein Ungelesen-Zähler, keine Zahl im Tab). Gilt global für die Instanz, also auf
  allen Geräten gleich. `GET/POST /api/kanal-einstellungen {reihenfolge, archiviert, stumm, namen}` (POST nur Admin).
- **Gelesen/Ungelesen**: Zähler je Kanal als Badge in der Seitenleiste und in Klammern in der Handy-Auswahl, Tab-Titel
  „(N) Flotten-Chat". Kanal öffnen = gelesen bis zur letzten Nachricht (Marker serverseitig, geräteübergreifend,
  monoton — `force` setzt zurück). Eigene Nachrichten zählen nie, stumme Kanäle nie. `GET /api/unread` (eine
  Abfrage für alle sichtbaren Kanäle, liefert auch Marker + Einstellungen) · `GET/POST /api/gelesen {kanal, bis}`.
  Ein Agent-Token darf nur den eigenen Kanal markieren.
- **Suche** (`server/suche.mjs`): Lupe im Kopf (Strg/⌘+K), Wörter-Suche über alle sichtbaren Kanäle — alle Wörter
  müssen vorkommen, Groß/klein egal (auch bei Umlauten), „zwei wörter" in Anführungszeichen = ein Begriff. Treffer
  mit Kanal, Absender, Zeit und Ausschnitt (Wörter markiert), Klick springt in den Kanal zur Nachricht und hebt sie
  hervor, Esc schließt. `GET /api/search?q=` (SQLite LIKE als Vorfilter, max. 50 Treffer, neueste zuerst; Agenten
  sehen nur ihren Kanal).
- Tests: neue `test_kanaele.mjs` (72 Checks: Einstellungen säubern/sortieren/verschieben, Marker, Ungelesen, Suche).

- **Fenster-Lampen** (`server/lampen.mjs`): grün pulsierend + laufende Uhr = beschäftigt, blau = bereit, grau = aus,
  rot = tot (Prozess weg, ohne dass jemand Stop gedrückt hat — bleibt rot bis zum Neustart). Beschäftigt heißt genau:
  im Terminalbild steht eine laufende Klammer-Zeit „(47s · …)“; das Urteil ist nie null (sonst bliebe Falsch-Grün).
  Die Uhr (`zustand.busy_sekunden`) tickt im Browser sekündlich weiter; Sidebar, Kanal-Kopf und Handy-Liste zeigen sie.
- **Ablage-Tresor 🔗** (`server/ablage.mjs`, `docs/ablage.md`): Aufnahmen (Bildschirm/Sprache) und Dateien dauerhaft in
  `data/ablage/` ablegen statt senden — sprechende Namen (`2026-10-06-1952-bildschirmaufnahme.webm`), nie aufgeräumt,
  Pfad + Link zurück (Pfad landet gleich im Zwischenspeicher, „In die Nachricht“ fügt `[Video: /pfad]` ein), Liste mit
  Ansehen/Löschen. `.webm` ist Video ODER Sprachnotiz — ffprobe entscheidet an der Bildspur, nie die Endung.
  Auslieferung mit Range/206. Routen `GET/POST /api/ablage`, `POST /api/ablage/loeschen`, `GET /api/ablage/<name>`.
- **Erinnerungs-Ordner, Titel/Notiz, Übergabe** (`server/erinnerungen.mjs`): Ordner anlegen/umbenennen/löschen (Inhalt
  zurück in die Inbox), Erinnerung in einen Ordner legen, Titel und Notiz nachträglich ändern (✏️ oder Klick auf den
  Titel), **an ein laufendes Fenster übergeben** — der Auftrag landet als Nachricht in dessen Kanal und wird ins
  Terminal getippt, die Erinnerung gilt als übergeben und feuert nicht mehr. Schema additiv (Tabelle `reminder_ordner`,
  Spalte `reminders.ordner_id`). Routen `GET/POST /api/reminders/ordner`, `POST /api/reminders/ordner/<id>/(umbenennen|loeschen)`,
  `POST /api/reminders/<id>/(ordner|titel|notiz|uebergeben)`.
- Tests: `test_lampen.mjs` (36), `test_ablage.mjs` (67), `test_erinnerungen.mjs` (39); `npm test` führt sie mit aus.

### Geändert
- **Rückfrage-Titel = die ganze Frage** bis zur Trennlinie (max. 60 Zeilen) — vorher nur die letzten 8 Zeilen,
  eine lange Frage begann im Chat mitten im Satz. Freigaben bleiben bei 8 Zeilen (Befehl + „Do you want to
  proceed?"). Textgrenzen für Frage/Titel 2500 Zeichen.
- **Keine Doppelkarten**: die Dialog-Kennung kommt weiter aus den letzten 8 Zeilen (gleiche Kennung im kleinen
  80×24-Fenster und nach dem Vergrößern), ohne Zeilenumbrüche (Ink bricht bei anderer Fenstergröße anders um)
  und ohne die Kästchen der Reiter-Leiste (der erste Haken ändert ☐ zu ☒). Mehrfachauswahl gilt auch, wenn die
  „Next"-Zeile beim Neuzeichnen kurz fehlt.
- Tests: `test_konsole.mjs` jetzt 118 Checks (Mehrfachauswahl, Absenden, lange Frage, kleines Fenster).

## [1.0.0] — 2026-10-04

Schwerpunkt: **Konsole im Chat.** Jedes Claude-Code-Fenster ist ein Kanal — der Server tippt hinein
und spiegelt heraus. Kein Bus, kein Watcher, kein Re-Arm im Fenster mehr. Und: keine Einstellungen.

### Neu
- **Konsole im Chat** (`server/konsole.mjs`, `server/protokoll.mjs`, `server/orte.mjs`): Terminalbild +
  Sitzungsprotokoll → Chat (Antworten, Rückfragen als Knöpfe, Freigaben, Auto-Mode-Sperren);
  Chat → Fenster per tmux (Text, Zahl = Wahl, „nein" = Esc, „manual"/„auto" = Modus).
- **Fenster-Registry** (Tabelle `fenster`): Name = Kanal, Ort (`lokal` | `ssh:host`), Ordner, Konto,
  Start-Modus, Worktree, Stand. Orte: `lokal`, `ssh:<host>`, `geraet:<id>`. „＋ Fenster" in der UI, `POST /api/fenster` per API.
- **Kopfzeile je Fenster**: Name grün/rot + „seit", Modus-Schalter, Terminal, Schließen und Neu starten.
- **Geräte koppeln** (`server/geraete.mjs`, `server/geraeteDienst.mjs`, `bin/geraete-server-einrichten.sh`): jeder Mac
  oder Linux-Rechner wird per Einmal-Code zum Ort `geraet:<id>` — Rückkanal-Tunnel (ssh -R) auf einen eigenen Port,
  Tunnel-Nutzer ohne Shell, Server-Schlüssel nur durch den Tunnel, Host-Schlüssel festgehalten; Status 🟢/🔴 im
  Ort-Menü, Wächter meldet Tunnel-Wechsel im Kanal „Alarm". Der Chat-Server muss dafür nicht als root laufen.
  Tests: `test_geraete.mjs` (48 Checks).
- **Live-Terminal** (`server/terminal.mjs`): Knopf „Terminal" zeigt das echte Terminalbild mit Farben (alle 2 s,
  nur lesen) plus Tastenleiste mit fester Liste — für alles, was der Spiegel nicht kennt. Handy: Vollbild-Blatt.
- **Rückfragen vollständig im Chat**: Frage, Kopf und Beschreibungen aus dem Protokoll; der Text über der
  Rückfrage (Erklärung, Bilder) kommt aus dem Terminal-Verlauf VOR der Frage; Vorschau-Kästen als Text.
- **Freitext ist die Antwort**: ins Antwortfeld („Type something."); ohne Antwortfeld wählt der Server
  „Chat about this" und schickt den Text hinterher.
- **Hohe Dialoge**: im 80×24-Fenster oben abgeschnittene Rückfragen/Freigaben werden erkannt; das Fenster wird
  kurz vergrößert, gelesen und zurückgestellt. Dialoge ohne Nummern (Claude Code 2.1.289) werden erkannt.
- **Worktree-Hygiene**: eigener Worktree je Fenster (`<repo>/worktrees/<name>`, Branch `fc/<name>`),
  Schließ-Ritual (60 s Stand wegschreiben → WIP sichern → Session beenden → Worktree weg, wenn sauber;
  danach verschwindet der Kanal und der Name ist wieder frei; ausgeschaltete Fenster schließen sofort),
  Kehrdienst für verwaiste Worktrees (`GET /api/worktrees`).
- **Themen-Board** (Tabelle `karten`): 5 Spalten, Verlauf mit Medien. Lose zu den Fenstern — keine
  Karten-Pflicht, kein Start von der Karte (im Betrieb war die feste Kopplung nur Pflegeaufwand).
- **Login mit E-Mail + Passwort** (scrypt, Cookie-Sitzungen, Rate-Limit). Admin-Token bleibt für
  Skripte/Agenten.
- **Anhang-Bühne**: Bilder mit Lightbox, Video/Audio nativ, PDF inline; Sprachnachricht aus dem Mikro.
- **Erinnerungen als Standard-Kanal** mit „▶ Fenster" (Session zur Erinnerung), **Alarm-Eingang**
  (`POST /api/alarm`), **Hilfe-Kanal** (Support-Brücke zum Hersteller, Antworten landen im Kanal).
- **Nachrichten-Typen** `question` und `task`, Feld `meta` (JSON) für Knöpfe/Bezüge.
- Neue Tests: `test_konsole.mjs` (73 Checks) für die reine Logik + Registry/Board/Login.

### Geändert
- Chat: Antworten mit Überschriften und Listen (Markdown-lite); Kanalwechsel verwirft verspätete Antworten
  des alten Kanals (kein fremder Verlauf mehr im falschen Kanal).
- `CLAUDE.md` neu geschrieben: „Ort einrichten" heißt jetzt: Claude-Session öffnen, „let's go" sagen.
- README neu: die fünf Momente, Regeln aus dem Betrieb, keine Einstellungen.
- Standard-Kanäle: `erinnerungen`, `hilfe`, `allgemein` (statt nur `allgemein`).
- SSE `/api/events` funktioniert mit Login-Cookie (kein Token in der URL nötig).

### Weiter vorhanden (Betriebsart ohne tmux)
- Self-Connect, `fc watch --bis-neu`, MCP-Connector, Dispatcher — für Agenten, die nicht in tmux auf dem
  Chat-Server laufen. Empfehlung: Fenster per `ssh:`-Ort statt Watcher.

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

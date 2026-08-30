# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [0.2.0] — 2026-08-30

Großes Feature-Update: rundum bessere Erinnerungen **und** Bildschirm-/Fensteraufnahme direkt im Chat.

### Neu
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

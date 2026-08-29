# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [0.2.0] — 2026-08-29

Schwerpunkt: rundum bessere Erinnerungen. Die bisherige einfache Erinnerungs-Funktion (⏰ an einer
Nachricht mit Freitext-Eingabe) wird durch eine vollwertige Übersicht **ersetzt und verbessert** —
gleiche verlässliche Basis (feuert serverseitig ohne AI-Aufruf, übersteht Neustarts und holt
Verpasstes nach), nur deutlich komfortabler.

### Neu
- **Erinnerungs-Übersicht** (⏰ in der Kopfleiste): alle offenen Erinnerungen an einem Ort,
  chronologisch. Überfälliges und Heutiges steht offen; alles Zukünftige klappt sich zu einem
  einzigen Block zusammen — kein endloses Scrollen.
- **Verschieben** direkt an jeder Erinnerung (🕐): neue Zeit wählen, fertig — auch eine schon
  ausgelöste Erinnerung lässt sich so neu terminieren und feuert dann zur neuen Zeit erneut.
- **Abhaken** (✅) direkt in der Liste.
- **Anlegen mit Datum/Uhrzeit-Auswahl** statt Freitext — in der Übersicht oder per Klick auf das ⏰
  an einer Nachricht (der Titel wird übernommen).

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

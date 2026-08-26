# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

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

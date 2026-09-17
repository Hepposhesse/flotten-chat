# Andere Anbieter andocken (Adapter)

Der Flotten-Chat ist mit **Claude Code** gebaut und getestet — dort funktioniert die Konsole im Chat
einwandfrei. Wir dokumentieren hier nur, WO ein anderer Anbieter andocken müsste. Eine Anleitung
gibt es bewusst nicht; wer es baut, teilt es bitte als Pull Request (AGPL).

## Die drei Berührungspunkte (alle in `server/`)
1. **Start-Befehl** — `orte.mjs → startBefehl(f)`: baut `cd … && exec claude --permission-mode … 'Thema'`.
   Ein anderer Agent braucht seinen eigenen Aufruf (Env `FC_CLAUDE_BIN` reicht nur, wenn die Flags passen).
2. **Terminalbild deuten** — `protokoll.mjs → paneZustand(text)`: erkennt Modus-Zeilen, nummerierte
   Dialoge mit Cursor ❯ und „beschäftigt“. Andere TUIs zeichnen anders → eigene Muster.
3. **Sitzungs-Protokoll** — `orte.mjs → protokollDir/laufendesProtokoll` (wo liegt die Datei?) und
   `protokoll.mjs → protokollNachrichten(zeilen)` (welche Zeile ist Antwort, Frage, Sperre?).
   Schreibt der Agent kein Protokoll, bleibt nur das Terminalbild — dann ohne Antwort-Spiegel.

Alles andere (Chat, Registry, Board, Erinnerungen, Zustellung per tmux) ist anbieter-neutral.

## Ohne tmux (jeder Agent, jede Sprache)
Ein Agent kann sich immer als **Chat-Teilnehmer** verbinden (`docs/connect.md`): Invite-Token →
eigener Kanal → `GET /api/messages` / `POST /api/send`. Das ist kein Spiegel, aber ein Kanal.

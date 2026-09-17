# Konsole im Chat — wie es funktioniert

Der Kern von 1.0. Kein Bus, kein Watcher im Fenster, kein Re-Arm. Der Server macht alles.

## Die Runde (alle 3 s, je Fenster) — `server/konsole.mjs`
1. **Terminalbild** (`tmux capture-pane`) → `paneZustand()`:
   Modus (`auto` / `default` = Manual / `plan` / `accept`), offener Dialog (nummerierte Liste mit
   Cursor ❯), beschäftigt (laufende Klammer-Zeit „(12s · …)“).
2. **Protokoll** — Claude Code schreibt jede Sitzung als JSONL nach
   `<config>/projects/<ordner, alles außer [A-Za-z0-9] → ->/<sitzung>.jsonl`. Wir merken uns den
   Byte-Offset und lesen nur Neues. `protokollNachrichten()` macht daraus Rollen:
   `sitzung` (Antwort-Text, mit Medien-Markern), `frage` (AskUserQuestion), `antwort` (im Fenster
   beantwortet), `gesperrt` (Auto-Mode-Sperre), `schritt` (Werkzeug-Aufruf, nur für Kontext).
   `spiegelBeitraege()` → Chat-Nachrichten `answer` / `fyi` / `error`.
3. **Dialog** — erscheint ein Dialog neu (Kennung = Titel + Anzahl Optionen), kommt EINE Nachricht
   vom Typ `question` mit `meta.dialog = {art, titel, optionen[]}` in den Kanal. Die UI macht Knöpfe
   daraus. Verschwindet der Dialog, wird `meta.dialog.zu = true` gesetzt (Knöpfe aus).
4. **Zustellung** — neue Nachrichten des Menschen (Cursor je Fenster) → `chatBefehl()`:
   - `text` → `tmux send-keys "📨 Name · #id: Text"` + Enter (Anhänge als `[Bild: /pfad]`)
   - Zahl(en) bei offenem Dialog → Cursor-Tasten + Enter (`tastenFuerWahl`), Mehrfachwahl mit Space
   - „ja“ = 1 · „nein“ = Escape · Freitext bei Freigabe = Escape + Text · Freitext bei Rückfrage wartet
   - „manual“/„auto“/„plan“ → Shift+Tab bis der Modus steht (mit Warten auf die TUI)
   Zu alte Nachrichten (> 2 h, Fenster war weg) werden nicht nachgeliefert — sie stehen ja im Chat.

## Warum das Fenster nichts vom Chat weiß
Weil das die stabile Variante ist. Alles, was wir vorher hatten (Bus-Polling im Fenster, Watcher,
Hooks, „bin ich noch wach?“), ist gestorben, sobald ein Fenster neu startete oder ein Socket weg war.
Jetzt gibt es genau einen Zustand: das Terminal. Der Chat ist nur die Fernbedienung und der Spiegel.

## Erste Frage von Claude Code („Is this a project you trust?“)
Wird automatisch mit „Yes“ beantwortet und im Kanal gesagt — der Mensch hat das Fenster bewusst in
diesem Ordner angelegt.

## Orte
`lokal`: tmux-Socket `flottenchat` (Env `FC_TMUX_SOCKET`), Claude-Binary `claude` (`FC_CLAUDE_BIN`).
`ssh:user@host`: dieselben Befehle über `ssh -o BatchMode=yes`; Protokolle werden per `tail -c +N`
gelesen (GNU und BSD `stat`). Voraussetzung: Key-Login ohne Passwort, tmux + claude auf dem Zielrechner.

## Was NICHT gespiegelt wird
Werkzeug-Ausgaben, Subagenten-Zweige, System-Einspielungen. Der Mensch sieht, was er auch in der
Konsole sehen würde: Antworten, Fragen, Sperren — nicht jeden `ls`.

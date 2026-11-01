# Konsole im Chat — wie es funktioniert

Der Kern von 1.0. Kein Bus, kein Watcher im Fenster, kein Re-Arm. Der Server macht alles.

## Die Runde (jede Sekunde, je Fenster) — `server/konsole.mjs`
Lokale Fenster jede Sekunde, entfernte Orte (ssh/Gerät) jede dritte — außer dort arbeitet etwas oder ein Dialog
ist offen. Dazu sofort (+300/900 ms Nachlauf): wenn das Sitzungsprotokoll eines lokalen Fensters wächst
(Protokoll-Horcher, `fs.watch`) und wenn eine Chat-Nachricht ankommt. Ändert sich Dialog, Modus oder Lampe eines
Fensters, weckt der Server die Oberfläche per SSE (`presence`), statt auf den nächsten Abruf zu warten.

1. **Terminalbild** (`tmux capture-pane`) → `paneZustand()`:
   Modus (`auto` / `default` = Manual / `plan` / `accept`), offener Dialog (nummerierte Liste mit
   Cursor ❯ — oder, seit Claude Code 2.1.289, auch ohne Nummern über einem Fuß „Enter to confirm · Esc to
   cancel“), beschäftigt (laufende Klammer-Zeit „(12s · …)“).
   **Hohe Dialoge:** tmux-Fenster ohne angehängten Bildschirm sind 80×24. Ist eine Rückfrage höher, fällt
   „❯ 1.“ oben raus (`dialogAbgeschnitten()`); der Server vergrößert das Fenster kurz auf 200×60, liest,
   und stellt es zurück. Der gelesene Dialog wird gemerkt, solange er klein abgeschnitten bleibt.
2. **Protokoll** — Claude Code schreibt jede Sitzung als JSONL nach
   `<config>/projects/<ordner, alles außer [A-Za-z0-9] → ->/<sitzung>.jsonl`. Wir merken uns den
   Byte-Offset und lesen nur Neues. `protokollNachrichten()` macht daraus Rollen:
   `sitzung` (Antwort-Text, mit Medien-Markern), `frage` (AskUserQuestion), `antwort` (im Fenster
   beantwortet), `gesperrt` (Auto-Mode-Sperre), `schritt` (Werkzeug-Aufruf, nur für Kontext).
   `spiegelBeitraege()` → Chat-Nachrichten `answer` / `fyi` / `error`.
3. **Dialog** — erscheint ein Dialog neu (Kennung = Titel ohne Countdown + Anzahl Optionen), kommt EINE
   Nachricht vom Typ `question` mit `meta.dialog = {art, titel, optionen[{nr, label, beschreibung}]}` in
   den Kanal. Die UI macht Knöpfe daraus. Verschwindet der Dialog, wird `meta.dialog.zu = true` gesetzt.
   Rückfragen nehmen Frage, Kopf und Beschreibungen aus dem Protokoll (der AskUserQuestion-Aufruf steht
   dort, bevor geantwortet wird); fehlt er noch, wartet der Spiegel eine Runde. Der **Text über der
   Rückfrage** (Erklärung, Bilder) kommt erst nach der Antwort ins Protokoll — der Server liest ihn aus
   dem Terminal-Verlauf (`textVorDialog()`) und postet ihn VOR der Frage (später nicht doppelt).
   Ein **Vorschau-Kasten** (AskUserQuestion mit `preview`) wird aus dem Bild gelöst und als Text gezeigt.
   **Titel** einer Rückfrage = die ganze Frage über den Optionen bis zur Trennlinie (max. 60 Zeilen); bei
   Freigaben die letzten 8 Zeilen (Befehl + „Do you want to proceed?“). Die **Kennung** nimmt nur die letzten
   8 Zeilen (ohne Umbrüche, Countdown, Reiter-Kästchen) — so ist es derselbe Dialog im kleinen 80×24-Fenster
   und nach dem Vergrößern, und beim Anhaken entsteht keine zweite Karte.
   **Mehrfachauswahl** (`multiSelect`): Optionen „[ ]/[✔]“ → `dialog.mehrfach`, je Option `an`, der getippte
   Freitext steht in der Freitext-Option, darunter „Next“ (`cursorWeiter`). Die Reiter-Leiste
   („← ☒ Obst ☐ Farbe ✔ Submit →“) wird als `reiter` gelesen; der letzte Reiter „Review your answers“ ist die
   **Absenden-Karte** (`art: 'absenden'`, Übersicht in `pruefung`). `meta.dialog` bekommt `mehrfach`, `an`,
   `freitext`, `freitextBisher` bzw. `antworten` — die UI macht daraus Häkchen-Knöpfe, ein Feld „Eigene
   Antwort“ und „Weiter ›“ bzw. die Knöpfe „Absenden“/„Abbrechen“.
4. **Zustellung** — neue Nachrichten des Menschen (Cursor je Fenster) → `chatBefehl()`:
   - `text` → `tmux send-keys "📨 Name · #id: Text"` + Enter (Anhänge als `[Bild: /pfad]`)
   - Zahl(en) bei offenem Dialog → Cursor-Tasten + Enter (`tastenFuerWahl`), Mehrfachwahl mit Space
   - „ja“ = 1 · „nein“ = Escape · Freitext bei Freigabe = Escape + Text
   - Freitext bei Rückfrage = die Antwort: ins Antwortfeld („Type something.“) und abschicken. Hat die
     Frage kein Antwortfeld (z. B. mit Vorschau), wählt der Server „Chat about this“ und schickt den Text
     hinterher, sobald der Dialog zu ist. Gibt es beides nicht, wartet der Text.
   - Mehrfachauswahl: die Nachricht ist der ganze Schritt — „1, 3“ = genau diese anhaken, „1, 3: Text“ = dazu
     eigene Antwort, reiner Text = nur eigene Antwort, „keine“ = nichts, „weiter“ = so lassen wie im Terminal.
     `mehrfachSchritte()` setzt Häkchen per Space, tippt den Freitext ohne Enter (`textTippen`, tmux
     `send-keys -l`; Ctrl+U leert das Feld, Enter dort nähme den Haken wieder weg) und geht auf „Next“.
   - Absenden-Karte: „1“ = Absenden, „2“/„nein“ = Abbrechen; Freitext wartet.
   - „manual“/„auto“/„plan“ → Shift+Tab bis der Modus steht (mit Warten auf die TUI)
   Zu alte Nachrichten (> 2 h, Fenster war weg) werden nicht nachgeliefert — sie stehen ja im Chat.
   Anhänge (Sprachnachricht, Bild) gehen nie verloren: als Antwort auf eine Rückfrage steht ihr Pfad im
   Antwortfeld, nach einer Wahl oder beim Warten kommen sie mit dem Text hinterher.
   Eine **nackte Zahl** kurz (15 Min) nach einer geschlossenen Rückfrage wird nicht getippt — sie war für die alte Karte.

## Robustheit des Spiegels (1.2)
- **Keine Doppelkarten:** ein Dialog gilt erst nach 1,5 s ohne Dialog als zu (Neuzeichnen); gleicher Kartentext
  binnen 2 Min = dieselbe Karte. Eine neue Rückfrage schließt die vorige Karte.
- **Gemerkter Dialog** aus dem vergrößerten Bild gilt nur, solange das kleine Bild gleich aussieht
  (`paneFingerabdruck()`); nach einer Antwort aus dem Chat wird frisch gelesen. Ein Bild, das auch groß nicht
  lesbar ist, wird nicht alle 30 s neu vergrößert.
- **Keine Karte für** Claude Codes eigene Dialoge (/model, /login, Rewind — `claudeEigenerDialog()`) und
  Anzeige-Panels (/status, /usage — `infoPanel()`). Die Bypass-Bestätigung bleibt ein Dialog.
- **Erkennung:** Optionen mit langen Beschreibungen, Freigaben mit umgebrochenem „Nou“, ▔-Rahmen (auch mit
  Effort-Anzeige) nicht im Titel; eine neue Rückfrage bekommt nie den Titel der vorigen (`frageIndex()`).
- **Text vor dem Dialog** auch vor Freigaben; Bilder in einer Frage hängen als Medien an der Karte.
- **Geheimnisse:** `geheimMaske()` macht `pwd=…`, `--password …`, `token: …`, `Bearer …`, `Authorization: …` in
  allem, was der Spiegel in den Chat schreibt, zu `***`.
- **Protokoll-Zuordnung:** zuerst exakt über `<config>/sessions/<pid>.json` (sessionId), sonst über die Startzeit —
  auch mehrere Fenster im selben Ordner bekommen so ihr eigenes Protokoll.
- **Hintergrund-Agent/Schwarm** („Waiting for 1 background agent“, „◯ name … 3m35s“) zählt für die Lampe als beschäftigt.
- **Langer Start-Text** (> 1000 Zeichen) geht über eine Datei (`/tmp/flottenchat-start-<session>.txt`, 0600) statt
  getippt — das Terminal kappt eine Zeile bei 4095 Zeichen.

## Aufräumen vor Neu starten / Schließen / Löschen (1.2) — `server/aufraeumen.mjs`
Das Fenster bekommt „Stand wegschreiben, committen, antworte nur mit „aufgeräumt““. Die Aktion folgt, sobald es
„aufgeräumt“ antwortet, der Prozess endet oder nach höchstens 2 Minuten. Eine offene Rückfrage wird vorher mit Esc
geschlossen. Läuft im Fenster nichts (aus oder nur die nackte Shell), passiert die Aktion sofort. Solange es aufräumt,
steht `raeumt: {art, seit}` am Fenster (`/api/fenster`, `/api/channels`) und der Kanal zeigt „räumt auf …“.

## Fenster-Lampen (1.1) — `server/lampen.mjs`
Je Runde schreibt die Konsole den Lampen-Stand fort (`lampenStand()`, rein, Zeit als Parameter) und gibt ihn in
`zustand.lampe` / `zustand.busy_sekunden` an die UI (`GET /api/channels`, `/api/fenster`):
- **beschaeftigt** (grün pulsierend + Uhr): `paneZustand().busy` — im Terminalbild steht eine laufende Klammer-Zeit
  „(47s · …)“ / „(1m 30s · esc to interrupt)“. Nur das. „Cooked for 37s“, ein stehengebliebener Spinner-Glyph, die
  Hint-Leiste mit „esc to interrupt“ → nicht beschäftigt. `tuiUrteil()` liefert `'busy'|'idle'`, nie null — ein
  fehlendes Urteil ließe den alten Stand stehen (Dauer-Grün).
- **bereit** (blau): Prozess lebt, keine laufende Zeit.
- **aus** (grau): kein Prozess, und die Registry sagte vorher nicht „laeuft“ (Stop/Schließen durch den Menschen).
- **tot** (rot): Prozess weg, aber die Registry sagte noch „laeuft“ — niemand hat gestoppt. Bleibt rot, bis jemand neu
  startet (die Konsole zieht die Registry eine Runde später selbst auf „aus“, das ist kein Stopp).
Die Uhr startet mit der ersten beschäftigten Runde; der Browser tickt sie sekündlich weiter (`busy_sekunden` + Zeit
seit dem letzten Abruf).

## Warum das Fenster nichts vom Chat weiß
Weil das die stabile Variante ist. Alles, was wir vorher hatten (Bus-Polling im Fenster, Watcher,
Hooks, „bin ich noch wach?“), ist gestorben, sobald ein Fenster neu startete oder ein Socket weg war.
Jetzt gibt es genau einen Zustand: das Terminal. Der Chat ist nur die Fernbedienung und der Spiegel.

## Live-Terminal
Im Kanal-Menü (⋯ im Kanal-Kopf, Rechtsklick oder lange drücken auf den Kanal) „🖥 Terminal ansehen“: das echte Terminalbild mit Farben (`capture-pane -e` → `server/terminal.mjs`),
alle 2 s, nur lesen — dazu eine Tastenleiste mit fester Liste (1–6, ↑ ↓, Tab, Esc, Shift+Tab, Enter). Nie
Text oder Befehle vom Client. Für alles, was der Spiegel (noch) nicht kennt. Nur für Admins.

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

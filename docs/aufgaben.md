# Aufgaben mit Zeit (1.2)

Eine Aufgabe ist Arbeit, die ein Fenster **am Stück** erledigt. „▶ Starten“ legt ein frisches Fenster (Kanal) an, der
Auftrag ist der Start-Text, die Zeit läuft mit. Am Ende steht eine Abschluss-Karte mit der Dauer im Kanal.

## Bedienung
- **Seitenleiste oben**: bis zu fünf Kacheln. Linkes Band = Stand: rot pulsierend = überfällig, grün = läuft,
  gelb = Pause oder heute fällig. ▶ startet, ↗ springt in den Kanal, Klick öffnet die Aufgabe im Chatbereich.
  Kacheln lassen sich ziehen; Überfälliges und Laufendes bleiben immer oben.
- **„Alle“** (auch über 📋 im Kopf, am Handy der Weg): Offen (ziehen oder ▲/▼), Erledigt, Papierkorb, Auswertung.
- **Uhr im Kanal-Kopf**: nur im Fenster, dessen Sitzung die Aufgabe gerade bearbeitet (ein neues Fenster mit dem
  Namen eines alten zeigt keine fremde Aufgabe). ⏸ Pause · ⏏ Stopp · ⏹ Fertig (ein Satz Ergebnis, optional).
- **Stopp** = zurück in die Liste. Zeit und Stand (die letzten Nachrichten des Kanals) bleiben. „Weiter“ geht im alten
  Fenster weiter, wenn es noch läuft — oder in einem neuen, das den Stand im Start-Text bekommt.
- **Kanal schließen = Aufgabe erledigt.** Fenster löschen (ohne Schließ-Ritual) = Stopp.
- **Verwerfen** legt die Aufgabe nach einer Rückfrage in den Papierkorb; von dort „↻ Zurückholen“ oder endgültig löschen.
- **Selbst starten um …**: die Aufgabe geht zur Uhrzeit von allein auf (Server-Takt, kein Cron). War der Server
  länger als 6 Stunden aus, wird nicht nachgeholt — die Meldung steht im Kanal „Erinnerungen“.
- **Fällig**: färbt die Kachel und meldet sich einmal je Termin im Kanal „Erinnerungen“.
- **Label**: ein freies Wort je Aufgabe (z. B. „Website“), optional.
- **Bereich** (1.3, Standard: der erste): ▶ Starten nimmt Ort, Ordner bzw. Repo und Worktree aus dem Bereich, wenn die
  Aufgabe keinen eigenen Ordner hat, und startet ein Baufenster (Auto-Modus) unter diesem Bereich. Benannt wird das
  Fenster weiter nach dem Titel.

## Wie gemessen wird
Der Server-Takt (alle 20 s) ordnet jeden Takt einer laufenden Aufgabe zu:

| Topf | wann |
|---|---|
| du | eigene Nachricht im Kanal in den letzten 60 s (auch Knopf-Antworten) |
| Claude | laufende Klammer-Zeit „(47s · …)“ im Terminalbild — dieselbe Erkennung wie die grüne Lampe |
| Warten auf dich | keiner arbeitet, eine Rückfrage oder Freigabe ist offen |
| Leerlauf | keiner arbeitet, nichts offen |
| Pause | Pause gedrückt |

Du und Claude zugleich zählen in beide Töpfe; ein Takt zählt höchstens 40 s (ein Hänger zählt nicht stundenlang).
Ein abgestürztes Fenster wird nicht gemessen, nach 90 s pausiert die Aufgabe. „Aktiv“ = du + Claude.

**Fertig-Satz**: schreibt das Fenster eine Zeile `✅ Aufgabe fertig: <Ergebnis>`, ist die Aufgabe abgeschlossen.
Das steht im Start-Text, zusammen mit der Standard-Vorlage *erst Lage + Empfehlung + AskUserQuestion, dann bauen*.
Die Vorlage ist je Aufgabe abschaltbar (Häkchen im Formular) oder als Standard mit `FC_AUFGABEN_ERST_FRAGEN=0`.

**Auswertung**: Zeit je Tag und je Aufgabe (7 oder 30 Tage), Tage in `FC_TZ` (Standard Europe/Berlin).

## Zusammenspiel mit Erinnerungen und Board
- **Erinnerungen bleiben der Wecker** (Zeitpunkt → Nachricht, ohne KI, mit Ordnern). Nichts wird umgebaut oder migriert.
  Die Brücke: „▶ Fenster“ an einer Erinnerung startet jetzt eine **Aufgabe** mit Zeitmessung, 🎯 macht ohne Start eine
  daraus. Die Erinnerung gilt dann als übergeben (`aufgabe:<id>`) und feuert nicht doppelt — die Fälligkeit der Aufgabe
  meldet sich im selben Kanal „Erinnerungen“. Ein Ort für alles Zeitliche.
- **Board bleibt lose.** Eine Aufgabe kann auf eine Karte zeigen („🎯 Als Aufgabe“ an der Karte oder Feld im Formular);
  dann ist die Karte die feste Stelle für den Stand: Stopp und Abschluss schreiben je einen Verlaufs-Eintrag. Spalten
  schiebt weiter der Mensch.

## API (Admin-Token oder Login; Agent-Tokens nur lesen)
| Methode | Pfad | |
|---|---|---|
| GET | `/api/aufgaben` | offen (sortiert) + zuletzt erledigt + Papierkorb, `je_fenster` (Uhr) |
| POST | `/api/aufgaben` | anlegen `{titel, beschreibung, label, faellig_am, start_um, karte_id, ordner, repo, ort, erst_fragen, starten}` |
| POST | `/api/aufgaben/<id>` | ändern (gleiche Felder) |
| POST | `/api/aufgaben/<id>/start` | `{neues_fenster?, ordner?, repo?, ort?}` → `{aufgabe, fenster}`; 409 = läuft schon |
| POST | `/api/aufgaben/<id>/(pause\|weiter\|stopp\|fertig\|verwerfen\|zurueck\|loeschen)` | `fertig` nimmt `{ergebnis}` |
| POST | `/api/aufgaben/reihenfolge` | `{ids:[…]}` |
| GET | `/api/aufgaben/auswertung?von=&bis=` | Zeit je Tag + je Aufgabe |
| POST | `/api/reminders/<id>/(session\|aufgabe)` | Erinnerung → Aufgabe (mit/ohne Start) |

Datenbank: Tabelle `aufgaben` und Spalte `fenster.aufgabe_id` — additiv, idempotent, beim Start angelegt.

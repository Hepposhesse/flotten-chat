# Themen-Board

Karte = Thema. Fünf Spalten: Ideen · In Arbeit · Wartet auf Freigabe · Bitte prüfen · Erledigt.

- **▶ Fenster starten** von der Karte: jedes Mal ein NEUES Fenster (Kanal) zum Thema, Karte → „In Arbeit“,
  Karte erscheint mittig in der Kopfzeile des Kanals (klickbar).
- **Schließen** des Fensters: Karte → „Bitte prüfen“ + Verlaufs-Eintrag. Der Mensch entscheidet, ob fertig.
- **Verlauf**: kurze Einträge für Menschen (was ist passiert), optional mit Medium. Fenster schreiben
  ihren Stand hierher (`POST /api/karten/<id>/verlauf`).
- **Regeln**: kein Bau ohne Karte; die KI legt Karten nie selbst an, sondern nur auf Zuruf — sie befüllt
  vorhandene Karten (Meilensteine, Entscheidungen, Stand) aber selbständig.
- Sessions ohne Karte sind erlaubt (Infos, Fragen). Sobald gebaut werden soll, weist das Fenster darauf hin.

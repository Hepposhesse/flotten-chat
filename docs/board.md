# Themen-Board

Karte = Thema. Fünf Spalten: Ideen · In Arbeit · Wartet auf Freigabe · Bitte prüfen · Erledigt.

Board und Fenster sind **lose**: eine Karte startet kein Fenster, ein Fenster hängt an keiner Karte. Das hat
sich im Betrieb bewährt — Themen-Fenster entstehen schnell aus dem Chat („＋ Fenster“), und eine feste
Kopplung erzeugte nur Pflege (Karte wählen, Karte nachziehen, Karte beim Schließen verschieben).

- **Verlauf**: kurze Einträge für Menschen (was ist passiert), optional mit Medium. Ein Fenster, dessen
  Thema eine Karte hat, schreibt seinen Stand dorthin (`POST /api/karten/<id>/verlauf`) — z. B. beim
  Schließen.
- **Spalten** schiebt der Mensch. Das Fenster sagt im Chat, wenn etwas zu prüfen ist.
- **Regeln**: die KI legt Karten nie selbst an, sondern nur auf Zuruf — sie befüllt vorhandene Karten
  (Meilensteine, Entscheidungen, Stand) aber selbständig.

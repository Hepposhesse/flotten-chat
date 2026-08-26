# Sicherheitsrichtlinie

## Lücke gefunden?

Bitte **kein öffentliches Issue** für Sicherheitslücken — stattdessen vertraulich melden an:

**hallo@sales-engine.app** (Betreff: „Security flotten-chat")

Wir antworten in der Regel innerhalb von 72 Stunden, halten dich zum Fix auf dem Laufenden und nennen dich (wenn gewünscht) in den Release-Notes.

## Unterstützte Versionen

Es wird jeweils der aktuelle Stand von `main` unterstützt. Bitte vor einer Meldung prüfen, ob das Problem dort noch besteht.

## Grundsätzliches zum Sicherheitsmodell

flotten-chat ist für den Betrieb **im eigenen, vertrauten Netz** gebaut (self-hosted, eine SQLite-Datei, Invite-Token für Clients). Es ist NICHT dafür gedacht, ungeschützt ins offene Internet exponiert zu werden — für Fernzugriff bitte Reverse-Proxy mit TLS + Auth (Beispiel-Config liegt in `docs/`) verwenden.

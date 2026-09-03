# Sicherheitsrichtlinie

## Lücke gefunden?

Bitte **kein öffentliches Issue** für Sicherheitslücken — stattdessen vertraulich melden an:

**hallo@sales-engine.app** (Betreff: „Security flotten-chat")

Wir antworten in der Regel innerhalb von 72 Stunden, halten dich zum Fix auf dem Laufenden und nennen dich (wenn gewünscht) in den Release-Notes.

## Unterstützte Versionen

Es wird jeweils der aktuelle Stand von `main` unterstützt. Bitte vor einer Meldung prüfen, ob das Problem dort noch besteht.

## Grundsätzliches zum Sicherheitsmodell

flotten-chat ist für den Betrieb **im eigenen, vertrauten Netz** gebaut (self-hosted, eine SQLite-Datei, Invite-Token für Clients). Es ist NICHT dafür gedacht, ungeschützt ins offene Internet exponiert zu werden — für Fernzugriff bitte Reverse-Proxy mit TLS + Auth (Beispiel: `docs/reverse-proxy.md`) verwenden.

## Eingebaute Bremsen (v0.4.0)

- `POST /api/connect` ist auf 10 Versuche je IP und Minute begrenzt (bremst das Durchprobieren von
  Einladungs-Tokens), `POST /api/media` auf 30 Uploads je Token und Minute, Uploads auf 200 MB.
  Alles per Env einstellbar (`FC_CONNECT_LIMIT`, `FC_MEDIA_LIMIT`, `FC_MEDIA_MAX_MB`); Antwort bei
  Überschreitung `429` mit `retry-after` bzw. `413`.
- Diese Bremsen ersetzen KEINE Netz-Absicherung: Fernzugriff nur über TLS-Reverse-Proxy oder
  SSH-Tunnel (Beispiel in `docs/reverse-proxy.md`).

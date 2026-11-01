# Ablage-Tresor 🔗 — Aufnahmen und Dateien dauerhaft ablegen

Chat-Medien (`data/media/`) heißen nach ihrer Zufallskennung — gut für den Chat, untauglich für „das Video will ich
später nochmal hergeben“. Die **Ablage** (`data/ablage/`) ist der zweite Ort: sprechende Namen, wird **nie aufgeräumt**,
und zu jeder Datei gibt es den absoluten **Pfad** (fürs Fenster auf demselben Rechner) und einen **Link**.

## Bedienung
- **🔗 im Composer** öffnet die Ablage: Liste (neueste zuerst) mit ▶ Ansehen · Pfad · Link · „In die Nachricht“ · 🗑.
- **Ablegen statt senden:** in der Ablage „📎 Datei ablegen“, „🎤 Sprachnotiz“ oder „🖥️ Bildschirm“ wählen. Das schaltet
  den **Ablage-Modus** (🔗 leuchtet) und startet die normale Aufnahme — der fertige Upload wandert in die Ablage, nicht
  in den Chat. Danach erscheint über dem Composer die Leiste „✅ … abgelegt“ mit dem Pfad (schon im Zwischenspeicher),
  „Link kopieren“ und „In die Nachricht“ (fügt `[Video: /…/data/ablage/….webm]` ein — das Fenster liest die Datei dann
  selbst). Ein Klick auf das leuchtende 🔗 bricht den Modus ab.
- Name = `JJJJ-MM-TT-HHMM-<name>.<endung>` in der Zeitzone `FC_TZ` (Standard `Europe/Berlin`); gleiche Minute, gleicher
  Name → `-2`, `-3`.

## `.webm` ist Video ODER Sprachnotiz
Bildschirmaufnahme und Mikrofon liefern beide `.webm`. Ob eine Bildspur drin ist, entscheidet **ffprobe** (steht neben
der Datei in `<name>.meta`: `{typ, dauer, mime}`) — nie die Endung. Ohne ffprobe zählt das MIME des Uploads
(`audio/webm` vom Mikrofon), ohne beides die Endung (webm → video). Eine Sprachnotiz wird als `audio/webm` ausgeliefert,
sonst bleibt der Player schwarz.

## Transkript am Eintrag (1.2.1)
Bildschirmaufnahmen und Sprachnotizen bekommen ihr Transkript als Beiwerk `<name>.transkript.txt` (Bildschirmaufnahme mit
Zeitmarken `[mm:ss]`). Die Liste trägt dann `transkript_pfad` und `transkript_url`, in der Ablage gibt es „Text“ und 📝.
Löschen nimmt das Transkript mit. Wie es entsteht: [aufnahme.md](aufnahme.md).

## API (Login-Cookie oder Admin-Token)
- `GET /api/ablage?limit=200` → `{ok, eintraege:[{name, pfad, url, typ, groesse, dauer, zeit, transkript_pfad?, transkript_url?}]}`
- `GET /api/ablage/<name>.transkript.txt` — Transkript als Text (404, solange keins da ist).
- `POST /api/ablage {ids:[<media-id>, …]}` — kopiert hochgeladene Chat-Medien (`POST /api/media`) in die Ablage, max. 20,
  Original bleibt. Antwort wie die Liste, dazu `fehler:[…]` je nicht gefundener Datei.
- `POST /api/ablage/loeschen {name}` — Datei samt `.meta` weg.
- `GET /api/ablage/<name>[?dl=1]` — Auslieferung mit **Range/206** (Video/Audio springen und scrubben), `?dl=1` als Download.

Namen werden vor jedem Zugriff geprüft (`nameGueltig`: nur `[A-Za-z0-9_.-]`, kein `..`, kein führender Punkt) — ein
Ausbruch aus `data/ablage/` ist damit kein Pfad, sondern ein 404.

## Grenzen
Der Pfad gilt auf dem Chat-Server. Fenster auf einem gekoppelten Gerät oder per SSH erreichen ihn nicht — dort den Link
geben (der verlangt Login/Token). Reine Logik: `server/ablage.mjs` (oben rein, unten I/O), Tests `test_ablage.mjs`.

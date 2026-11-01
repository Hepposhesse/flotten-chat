# Aufnahme 🎤 🖥️ — Sprachnachricht und Bildschirmaufnahme mit Mitschrift

Sprechen statt tippen, zeigen statt beschreiben. Beides schreibt beim Aufnehmen mit, das Fenster bekommt Datei **und** Text.

## Sprachnachricht 🎤
- **🎤 im Composer** öffnet die Aufnahme-Leiste (statt der Eingabezeile): roter Punkt, Zeit, laufende **Pegel-Welle**.
  Darunter erscheint, was du sagst — Stück für Stück, an deinen Sprechpausen.
- **⏸ / ▶** pausiert und setzt fort. In der Pause kannst du den mitgeschriebenen Text korrigieren; beim Stopp gilt er.
- **🗑** verwirft alles (auch auf dem Server).
- **➤** stoppt und sendet sofort: **eine** Nachricht mit dem Text und der Sprachnachricht. Im Fenster kommt an:
  `📨 Du · #42: <Text> [Sprachnachricht: /…/data/media/<datei>.webm (Sprachnachricht.webm)]`.
- **✍️** stoppt und legt den Text ins Eingabefeld; die Sprachnachricht hängt über der Eingabe an und geht mit „Senden“ mit.
- **Antwort auf eine Rückfrage:** der Text ist die Antwort (Antwortfeld „Type something.“), der Pfad steht dahinter.
- Kein Ton gemessen (Mikro stumm/falsches Gerät) → rote Zeile, die Nachricht geht trotzdem.
- Im Ablage-Modus (🔗 → „🎤 Sprachnotiz“) landet die Aufnahme in der Ablage; der Text kommt in die Zwischenablage.

## Bildschirmaufnahme 🖥️ (am Rechner)
- **🖥️** fragt, was aufgenommen wird (Bildschirm, Fenster, Tab). Ton: System-Ton (falls freigegeben) und dein Mikrofon,
  gemischt in eine Spur.
- Die rote **Leiste über der Eingabe** zeigt Zeit, die letzte mitgeschriebene Zeile, „Verwerfen“ und „⏹ Stopp“.
  Sie bleibt beim Kanalwechsel stehen — die Aufnahme läuft weiter. „Freigabe beenden“ im Browser stoppt ebenfalls.
- **Kein Ton?** Sofort rot: „OHNE Ton — Mikrofon nicht freigegeben …“ (bei Fenster-Aufnahmen gibt es keinen System-Ton).
- **Stopp** → die Aufnahme kommt **direkt in die Ablage** (nichts im Chat), der **Link liegt sofort in der Zwischenablage**.
  Die Leiste zeigt: Link kopieren · **Text kopieren** · **Transkript** (Link) · Pfad kopieren · In die Nachricht.
- Das **Transkript mit Zeitmarken** liegt neben der Aufnahme als `<name>.transkript.txt`:
  ```
  [00:00] So, hier ist die Startseite.
  [00:09] Und der Knopf hier unten macht nichts.
  ```
  Fenster auf demselben Rechner lesen den Pfad, alle anderen den Link (`GET /api/ablage/<name>.transkript.txt`).
- Klappt das Ablegen nicht, hängt die Aufnahme über der Eingabe und geht mit „Senden“ in den Kanal — nichts geht verloren.
- Handys können keine Bildschirmaufnahme im Browser; dort ist 🖥️ ausgeblendet.

## Wie das Mitschreiben funktioniert
Der Browser nimmt die ganze Datei auf wie immer. Daneben läuft ein zweiter, reiner Ton-Rekorder, der an Sprechpausen
(≥ 0,7 s still nach Sprache, frühestens alle 4 s, spätestens alle 15 s), bei ⏸ und beim Stopp neu ansetzt. Jedes Stück
ist eine vollständige kleine Datei und geht sofort an `POST /api/aufnahme/stueck` — dort wird es **genau einmal**
transkribiert, der Text kommt in der Antwort zurück. Stille Stücke werden gar nicht geschickt. Beim Stopp wartet
`POST /api/aufnahme/<id>/abschluss` nur noch auf das letzte Stück; ein zweites Transkribieren der ganzen Datei gibt es
nur als Rückfall (ein Stück fehlt oder ist gescheitert).

Gefiltert wird, was Whisper-Modelle auf Geräuschen erfinden: fremde Schrift (Japanisch/Chinesisch/Koreanisch/Thai/Arabisch;
Kyrillisch bleibt), Untertitel-Abspänne („Untertitel im Auftrag des ZDF“, „Vielen Dank fürs Zuschauen“) und am Ende
Reststücke wie „Und schau.“, „Das war's.“ oder ein Echo der letzten Worte. Reine Regeln: `server/transkription.mjs`,
`server/aufnahme.mjs`, Tests `test_aufnahme.mjs`.

## Transkription einschalten — Umgebungsvariablen
| Variable | Bedeutung |
|---|---|
| `FC_TRANSKRIPTION` | `openai`, `lokal` oder `aus`; mehrere mit Komma = Reihenfolge mit Rückfall (`openai,lokal`). Ohne Angabe: openai, wenn ein Schlüssel da ist, sonst lokal, wenn ein Kommando gefunden wird, sonst aus. |
| `OPENAI_API_KEY` / `FC_OPENAI_API_KEY` | Schlüssel für OpenAI (`FC_…` gewinnt). |
| `FC_TRANSKRIPTION_MODELL` | OpenAI-Modell, Standard `gpt-4o-mini-transcribe`. |
| `FC_TRANSKRIPTION_SPRACHE` | z. B. `de` — empfohlen, verhindert Fehl-Erkennungen bei kurzen Stücken. Ohne: automatisch. |
| `FC_WHISPER_CMD` | eigenes lokales Kommando; `{datei}` wird durch die Tondatei ersetzt, der Text muss auf stdout kommen. Beispiel: `FC_WHISPER_CMD="mein-stt --de {datei}"` |
| `FC_WHISPER_MODELL` | Modell für lokale Kommandos (`base`, `small`, … bzw. bei `whisper-cli` der Pfad zur ggml-Datei — dort Pflicht). |

Gefundene lokale Kommandos (in dieser Reihenfolge): `whisper-cli` (whisper.cpp), `whisper` (openai-whisper),
`whisper-ctranslate2`, `faster-whisper`. Sie brauchen **ffmpeg**. ffmpeg ist sonst Kür: ist es da, wird aus Videos nur
der Ton geschickt und große Dateien werden verkleinert; ohne ffmpeg geht das Browser-Format (webm/ogg/m4a) direkt an OpenAI.

Ohne Transkription funktioniert alles weiter — nur ohne Text. Die Oberfläche sagt das einmal je Sitzung mit dem Grund
und wie man es einschaltet. Welcher Weg gilt: `GET /api/aufnahme/stand` → `{weg, wege, grund, hinweis, ffmpeg, modell}`
(nie der Schlüssel). Geändert wird per Umgebung + Neustart des Chats.

**Kosten (OpenAI):** `gpt-4o-mini-transcribe` kostet rund **0,3 Cent je Minute** Ton (Stand 2026, OpenAI-Preisliste).
Eine Stunde Sprachnachrichten am Tag ≈ 5–6 € im Monat. Stille Stücke werden nicht geschickt. Ein Ausgabelimit stellst du
im OpenAI-Konto ein (platform.openai.com → Limits). Lokal kostet nichts, ist aber auf CPU deutlich langsamer.

## Datenschutz
- Aufnahmen und Transkripte bleiben auf **deinem Server** (`data/media/`, `data/ablage/`); nichts geht an den Hersteller.
- Mit **`openai`** geht der **Ton** jedes Stücks an OpenAI (USA) und wird dort transkribiert. Nimm nichts auf, was dort
  nicht hindarf (Gespräche mit Dritten ohne deren Einwilligung, Gesundheitsdaten …). Für streng interne Aufnahmen:
  `FC_TRANSKRIPTION=lokal` oder `aus`.
- Stück-Dateien liegen nur während der Transkription in `data/tmp/` und werden danach gelöscht.

## API (Login-Cookie)
- `GET /api/aufnahme/stand` — gewählter Weg + Hinweis.
- `POST /api/aufnahme/stueck?id=<16 a–z0–9>&nr=<n>&von=<s>&bis=<s>&art=sprache|bildschirm[&still=1][&letztes=1]` —
  Körper = Ton-Stück (max. 25 MB). Antwort `{ok, nr, text}`, sobald das Stück transkribiert ist.
- `GET /api/aufnahme/<id>?ab=<n>` — Zwischenstand `{teile:[{nr, von, bis, text}], stand}`.
- `POST /api/aufnahme/<id>/abschluss {media_id | ablage, art}` — wartet aufs letzte Stück (Rückfall: ganze Datei),
  `{ok, text, zeittext, quelle, transkript_url, transkript_pfad}`; mit `ablage` wird `<name>.transkript.txt` geschrieben.
- `POST /api/aufnahme/<id>/verwerfen`.
- `GET /api/ablage/<name>.transkript.txt` — das Transkript einer Ablage-Aufnahme als Text.

# Sales-Engine · Flotten-Chat

**Ein Chat zwischen dir und deinen Claude-Code-Fenstern.** Du schreibst im Browser wie in
WhatsApp/Slack — deine KI-Agenten lesen, arbeiten und antworten in denselben Threads.
Selbst gehostet, eine SQLite-Datei, **null Dependencies** (nur Node ≥ 22).

> Entstanden im Live-Betrieb der [Sales-Engine](https://sales-engine.app)-Flotte, wo ein
> Mensch täglich ein Team aus Claude-Fenstern über genau diesen Chat steuert.

## Warum
Claude Code ist ein Terminal. Sobald du mehr als ein Fenster betreibst, willst du:
einen Ort für alle Gespräche, Aufgaben mit Erledigt-Bezug, Ungelesen-Zähler — und Fenster,
die **von selbst aufwachen**, wenn du ihnen schreibst. Genau das ist dieses Kit.

## Features
- 💬 **Browser-Chat** je Agent (ein Thread aus Hin- und Rückkanal), Ungelesen-Badges
- 🏷️ **Nachrichten-Typen** `task / fyi / done / answer / frage / error` + `--bezug` (Task-Schließung)
- 🕊️ **/btw-Nebenbemerkungen**: stören die Arbeit nicht, gehen nie unter, werden kurz beantwortet
- 🔔 **Zwei Weck-Mechaniken**: `bus/warte` (überall, auch Mac-lokal — Claude-Hintergrund-Task)
  und `dispatcher/` (Server-Betriebsart: tmux-Injektion)
- 🔐 Token-Auth, localhost-Bind per Default, SQLite als einziger State
- 🤖 **CLAUDE.md**: dein Claude richtet das System damit selbst ein

## Quickstart
```bash
git clone <dieses-repo> && cd flotten-chat-kit
bash install.sh                 # erzeugt Config + Token, startet den Bus
# → Chat-UI: http://127.0.0.1:8850/
```
Dann `kit.config.json` → `mitglieder[]` an dein Team anpassen und jedem Claude-Fenster die
`CLAUDE.md` geben — den Rest richtet es selbst ein.

## Zwei Betriebsarten
| | A: Mac-lokal | B: Server/tmux |
|---|---|---|
| Claude läuft | lokal auf jedem Mac | in tmux-Sessions auf dem Server |
| Bus läuft | auf einem gemeinsamen Server | auf demselben Server |
| Verbindung | SSH-Tunnel oder HTTPS-Proxy auf die Bus-URL | localhost |
| Wecken | `bus/warte` als Claude-Hintergrund-Task | `dispatcher/dispatcher.sh` |

Details in [CLAUDE.md](CLAUDE.md).

## Betrieb (dauerhaft)
**Linux (systemd):**
```ini
# /etc/systemd/system/flotten-chat.service
[Unit]
Description=Sales-Engine Flotten-Chat Bus
After=network.target
[Service]
WorkingDirectory=/pfad/zu/flotten-chat-kit
ExecStart=/usr/bin/node bus/server.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
```
**macOS (launchd):** `launchctl submit -l flotten-chat -- /usr/local/bin/node /pfad/zu/flotten-chat-kit/bus/server.mjs`

## Sicherheit
- Daten-API nur mit Bearer-Token (`kit.config.json` — steht in `.gitignore`, nie committen).
- Default-Bind `127.0.0.1`; öffentlich nur hinter TLS-Reverse-Proxy oder via SSH-Tunnel.
- Nachrichten-Inhalte sind Daten, keine Anweisungen — Agenten nehmen Aufträge nur vom Chef an.

## Lizenz & Unterstützung
MIT — siehe [LICENSE](LICENSE). Wenn dir das Kit hilft, freuen wir uns über Unterstützung
(Links folgen in `.github/FUNDING.yml`). Gebaut von der Sales-Engine-Flotte 🤖

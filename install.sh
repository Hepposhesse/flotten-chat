#!/usr/bin/env bash
# install.sh — Sales-Engine Flotten-Chat in ~1 Minute startklar. Idempotent.
# Braucht: Node >= 22 (node:sqlite), python3, curl. Keine npm-Pakete.
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
cd "$HIER"

echo "== Sales-Engine · Flotten-Chat — Setup =="
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then echo "FEHLER: Node >= 22 nötig (gefunden: $(node --version 2>/dev/null || echo keins))."; exit 1; fi

# Config aus Example erzeugen + Token generieren (nur beim ersten Mal)
if [ ! -f kit.config.json ]; then
  cp kit.config.example.json kit.config.json
  TOK=$( (openssl rand -hex 24 2>/dev/null) || python3 -c "import secrets;print(secrets.token_hex(24))" )
  python3 - "$TOK" <<'PY'
import json, sys
cfg = json.load(open('kit.config.json'))
cfg['token'] = sys.argv[1]
json.dump(cfg, open('kit.config.json', 'w'), indent=2, ensure_ascii=False)
PY
  echo "kit.config.json angelegt (Token generiert). BITTE: mitglieder[] an euer Team anpassen!"
else
  echo "kit.config.json existiert — unangetastet."
fi

PORT=$(python3 -c "import json;print(json.load(open('kit.config.json'))['port'])")
# Bus starten (falls nicht schon läuft)
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Bus läuft schon auf Port $PORT."
else
  nohup node bus/server.mjs > bus.log 2>&1 &
  sleep 1
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && echo "Bus gestartet (Port $PORT, Log: bus.log)" || { echo "FEHLER beim Start — siehe bus.log"; exit 1; }
fi
chmod +x bus/send bus/warte dispatcher/dispatcher.sh 2>/dev/null || true

echo
echo "FERTIG. Chat-UI:  http://127.0.0.1:$PORT/"
echo "Senden testen:    bus/send local-beispiel-agent \"Hallo\" --von chef"
echo
echo "Dauerhaft (Linux/systemd):  siehe README → Abschnitt Betrieb"
echo "Dauerhaft (macOS/launchd):  siehe README → Abschnitt Betrieb"
echo "Claude einrichten:          gib deinem Claude-Fenster die Datei CLAUDE.md"

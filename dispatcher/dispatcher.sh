#!/usr/bin/env bash
# dispatcher.sh — OPTIONALER Fenster-Wecker für die SERVER-Betriebsart (Claude-Fenster in tmux).
# Mac-lokale Fenster brauchen ihn NICHT — dort übernimmt bus/warte als Hintergrund-Task (CLAUDE.md).
#
# Pollt je Mitglied den inChannel; bei neuen Nachrichten injiziert er einen Weck-Text per
# tmux send-keys in die Session des Mitglieds (Feld tmuxSession in kit.config.json).
# /btw-Semantik (v2): sind die neuen Nachrichten AUSSCHLIESSLICH /btw-Nebenbemerkungen,
# kommt der sanfte 🕊-Wake (kurz antworten, Arbeit nicht unterbrechen) — sonst der normale.
set -uo pipefail
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HIER/../kit.config.json"
URL="${KIT_URL:-$(python3 -c "import json;c=json.load(open('$CFG'));print(c.get('url') or 'http://127.0.0.1:'+str(c['port']))")}"
TOKEN="${KIT_TOKEN:-$(python3 -c "import json;print(json.load(open('$CFG'))['token'])")}"
SOCK="${KIT_TMUX_SOCKET:-default}"

mapfile -t MITGLIEDER < <(python3 -c "
import json
for m in json.load(open('$CFG'))['mitglieder']:
    if m.get('tmuxSession'): print(m['name'] + '|' + m['tmuxSession'] + '|' + m['inChannel'])
")

declare -A CUR
neue() { # $1=kanal $2=seit → "MAX_ID NUR_BTW(0/1)" oder ""
  curl -sf -H "Authorization: Bearer $TOKEN" "$URL/api/kanal?kanal=$1&seit=$2&limit=50" 2>/dev/null \
    | python3 -c "
import json, sys
try: ns = json.load(sys.stdin).get('nachrichten') or []
except Exception: ns = []
if ns:
    nur = all(str(n.get('inhalt','')).lstrip().startswith('/btw') for n in ns)
    print(max(n['id'] for n in ns), 1 if nur else 0)
"
}
for z in "${MITGLIEDER[@]}"; do IFS='|' read -r name sess inch <<< "$z"
  r=$(neue "$inch" 0 || true); CUR[$name]=${r%% *}; CUR[$name]=${CUR[$name]:-0}
done
echo "$(date +%T) dispatcher bereit: ${#MITGLIEDER[@]} Mitglied(er)"

while true; do
  for z in "${MITGLIEDER[@]}"; do IFS='|' read -r name sess inch <<< "$z"
    r=$(neue "$inch" "${CUR[$name]:-0}" || true)
    [ -z "$r" ] && continue
    L=${r%% *}; BTW=${r##* }
    if tmux -L "$SOCK" has-session -t "$sess" 2>/dev/null; then
      if [ "$BTW" = "1" ]; then
        MSG="🕊 /btw-Nebenbemerkung auf $inch (bis id=$L) — kurz lesen und KURZ auf deinem out-Kanal antworten. Falls du mitten in Arbeit bist: NICHT unterbrechen, nur kurz quittieren und weitermachen."
      else
        MSG="📨 Neue Nachricht(en) auf deinem Kanal $inch (bis id=$L) — bitte lesen + handeln, danach wie gewohnt im Wartemodus bleiben."
      fi
      tmux -L "$SOCK" send-keys -t "$sess" "$MSG" 2>/dev/null
      sleep 0.4
      tmux -L "$SOCK" send-keys -t "$sess" "" Enter 2>/dev/null
      echo "$(date +%T) WAKE -> $sess (bis id=$L, btw=$BTW)"
    fi
    CUR[$name]=$L
  done
  sleep 3
done

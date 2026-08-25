#!/usr/bin/env bash
# dispatcher.sh — OPTIONALER Fenster-Wecker für die SERVER-Betriebsart (Claude-Fenster in tmux).
# Mac-lokale Fenster brauchen ihn NICHT — dort läuft `fc watch --bis-neu` als Claude-Hintergrund-Task.
#
# Pollt je Eintrag aus dispatcher/mitglieder.json den Kanal (Admin-Token) und injiziert bei neuen
# Nachrichten einen Weck-Text per tmux send-keys. /btw-Semantik: bestehen die neuen Nachrichten
# AUSSCHLIESSLICH aus /btw-Nebenbemerkungen, kommt der sanfte 🕊-Wake (kurz antworten, Arbeit
# nicht unterbrechen) — sonst der normale.
#
# Konfig dispatcher/mitglieder.json:  [{"kanal":"claude-1","tmuxSession":"kk-claude-1"}, …]
# Env: FC_URL (default http://127.0.0.1:3900) · FC_TOKEN (Admin-Token; default: liest data/admin-token)
#      KIT_TMUX_SOCKET (default: default)
set -uo pipefail
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${FC_URL:-http://127.0.0.1:3900}"
TOKEN="${FC_TOKEN:-$(cat "$HIER/../data/admin-token" 2>/dev/null || true)}"
SOCK="${KIT_TMUX_SOCKET:-default}"
CFG="$HIER/mitglieder.json"
[ -f "$CFG" ] || { echo "dispatcher: $CFG fehlt — Beispiel: [{\"kanal\":\"claude-1\",\"tmuxSession\":\"kk-claude-1\"}]" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "dispatcher: kein Token (FC_TOKEN oder data/admin-token)" >&2; exit 2; }

mapfile -t MITGLIEDER < <(python3 -c "
import json
for m in json.load(open('$CFG')):
    print(m['kanal'] + '|' + m['tmuxSession'])
")

declare -A CUR
neue() { # $1=kanal $2=seit → "MAX_ID NUR_BTW(0/1)" oder ""
  curl -sf -H "Authorization: Bearer $TOKEN" "$URL/api/messages?kanal=$1&seit=$2" 2>/dev/null \
    | python3 -c "
import json, sys
try: ns = json.load(sys.stdin).get('messages') or []
except Exception: ns = []
if ns:
    nur = all(str(n.get('inhalt','')).lstrip().startswith('/btw') for n in ns)
    print(max(n['id'] for n in ns), 1 if nur else 0)
"
}
for z in "${MITGLIEDER[@]}"; do IFS='|' read -r kanal sess <<< "$z"
  r=$(neue "$kanal" 0 || true); CUR[$kanal]=${r%% *}; CUR[$kanal]=${CUR[$kanal]:-0}
done
echo "$(date +%T) dispatcher bereit: ${#MITGLIEDER[@]} Mitglied(er) @ $URL"

while true; do
  for z in "${MITGLIEDER[@]}"; do IFS='|' read -r kanal sess <<< "$z"
    r=$(neue "$kanal" "${CUR[$kanal]:-0}" || true)
    [ -z "$r" ] && continue
    L=${r%% *}; BTW=${r##* }
    if tmux -L "$SOCK" has-session -t "$sess" 2>/dev/null; then
      if [ "$BTW" = "1" ]; then
        MSG="🕊 /btw-Nebenbemerkung auf $kanal (bis id=$L) — kurz lesen und KURZ antworten (fc send --typ answer --bezug <id>). Falls du mitten in Arbeit bist: NICHT unterbrechen, nur kurz quittieren und weitermachen."
      else
        MSG="📨 Neue Nachricht(en) auf deinem Kanal $kanal (bis id=$L) — bitte lesen (fc watch --once) + handeln, danach wie gewohnt im Wartemodus bleiben."
      fi
      tmux -L "$SOCK" send-keys -t "$sess" "$MSG" 2>/dev/null
      sleep 0.4
      tmux -L "$SOCK" send-keys -t "$sess" "" Enter 2>/dev/null
      echo "$(date +%T) WAKE -> $sess (bis id=$L, btw=$BTW)"
    fi
    CUR[$kanal]=$L
  done
  sleep 3
done

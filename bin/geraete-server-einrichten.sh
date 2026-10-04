#!/usr/bin/env bash
# Flotten-Chat · Geräte koppeln — einmalige Einrichtung auf dem Chat-Server (als root).
#
#   sudo bash bin/geraete-server-einrichten.sh [datenverzeichnis] [server-nutzer] [tunnel-nutzer]
#   (tunnel-nutzer Standard fcgeraet; anderer Name → im Chat-Server FC_GERAETE_NUTZER gleich setzen)
#
# Legt den Tunnel-Nutzer `fcgeraet` an und begrenzt ihn per sshd auf reine Rückkanäle (ssh -R): keine Shell,
# kein -L, kein Passwort. Welche Schlüssel er hat und welchen Port jeder öffnen darf (permitlisten), liest sshd
# über AuthorizedKeysCommand aus <datenverzeichnis>/geraete-authorized-keys — die Datei pflegt der Chat-Server.
# So muss der Chat-Server nicht als root laufen. Idempotent: mehrfach ausführen schadet nicht.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "✗ bitte als root (sudo) ausführen"; exit 1; }
DATA=$(cd "${1:-${FC_DATA_DIR:-$(dirname "$0")/../data}}" && pwd)
NUTZER=${2:-${SUDO_USER:-root}}
id "$NUTZER" >/dev/null || { echo "✗ Server-Nutzer $NUTZER unbekannt"; exit 1; }
TN=${3:-fcgeraet}
[[ "$TN" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "✗ Tunnel-Nutzer ungültig"; exit 1; }
HELFER=/usr/local/libexec/flotten-chat-geraete-keys-$TN

id "$TN" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$TN" --shell /bin/sh "$TN"
passwd -l "$TN" >/dev/null 2>&1 || true

install -d -m 755 -o root -g root /usr/local/libexec
cat > "$HELFER.tmp" <<HELF
#!/bin/sh
# Vom Flotten-Chat eingerichtet: Schlüssel des Tunnel-Nutzers $TN (sshd AuthorizedKeysCommand).
[ "\$1" = "$TN" ] || exit 0
exec cat '$DATA/geraete-authorized-keys' 2>/dev/null
HELF
install -m 755 -o root -g root "$HELFER.tmp" "$HELFER" && rm -f "$HELFER.tmp"

cat > /etc/ssh/sshd_config.d/60-flotten-chat-$TN.conf <<CONF
# Flotten-Chat Geräte-Tunnel: nur Rückkanal auf den eigenen Port, sonst nichts.
Match User $TN
    AuthorizedKeysFile none
    AuthorizedKeysCommand $HELFER %u
    AuthorizedKeysCommandUser $NUTZER
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    PermitOpen none
    GatewayPorts no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /bin/false
    ClientAliveInterval 30
    ClientAliveCountMax 3
CONF

sshd -t
# Probe: der Match-Block gilt für fcgeraet und NICHT für andere Nutzer.
# (Ausgabe erst einsammeln: „sshd -T | grep -q" bricht mit pipefail per SIGPIPE ab.)
T_TN=$(sshd -T -C user="$TN",host=x,addr=1.2.3.4); T_ROOT=$(sshd -T -C user=root,host=x,addr=1.2.3.4)
grep -qi '^allowtcpforwarding remote' <<<"$T_TN" || { echo "✗ Match-Block greift nicht für $TN"; exit 1; }
! grep -qi '^allowtcpforwarding remote' <<<"$T_ROOT" || { echo "✗ Match-Block greift auch für root"; exit 1; }
if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then :
elif pkill -HUP -x sshd 2>/dev/null; then :
else echo "⚠ sshd läuft nicht oder ließ sich nicht neu laden — bitte starten/neu laden."; fi
echo "✓ Geräte-Tunnel eingerichtet: Nutzer $TN, Schlüssel aus $DATA (gelesen als $NUTZER), sshd neu geladen."

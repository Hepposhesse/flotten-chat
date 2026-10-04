// server/geraete.mjs — Geräte koppeln (1.0), der reine Teil: kein I/O, Zeit und Zufall als Parameter.
//
// Ein Fenster kann auf jedem Rechner laufen, der dem Chat-Server einen Rückkanal öffnet: Mac, zweiter Server,
// Laptop. Kein offener Port am Gerät, keine VPN-Pflicht, kein Schlüssel-Hin-und-her von Hand:
//   1. ＋ Fenster → Ort → „＋ Gerät koppeln …" (Name) → Einmal-Code (30 min) + Textblock für Claude Code am Gerät.
//   2. Claude Code am Gerät lädt das Einrichtungs-Skript von /geraet/<code>, prüft tmux/claude/sshd, erzeugt
//      einen Schlüssel, meldet ihn per Code an und richtet einen dauerhaften Rückkanal ein
//      (ssh -R 127.0.0.1:<port> → Gerät:22; macOS: LaunchAgent, Linux: systemd --user).
//   3. Der Server spricht das Gerät über 127.0.0.1:<port> an — wie jeden anderen ssh-Ort.
// „Entfernen" sperrt den Tunnel-Schlüssel und kappt den Tunnel.
//
// Sicherheits-Zuschnitt: Der Tunnel-Nutzer `fcgeraet` darf per sshd nur Rückkanäle öffnen
// (bin/geraete-server-einrichten.sh), und je Schlüssel nur auf SEINEM Port (permitlisten). Der Server-Schlüssel
// steht auf dem Gerät mit from="127.0.0.1,::1" — er gilt also nur durch den Tunnel. Der Host-Schlüssel des
// Geräts wird beim Anmelden festgehalten (known_hosts je Port), damit niemand anderes den Port übernehmen kann.

export const PORT_BASIS = Number(process.env.FC_GERAETE_PORT_BASIS) || 22101;
export const CODE_GUELTIG_MS = 30 * 60 * 1000;
export const TUNNEL_NUTZER = 'fcgeraet'; // Standard; Env FC_GERAETE_NUTZER, falls der Name schon belegt ist
const RESERVIERT = ['lokal', 'ssh', 'geraet', 'server'];

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Name → id (klein, a-z0-9-). Umlaute werden ausgeschrieben. */
export function geraetSlug(name) {
  return String(name || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

/** Liste normalisieren: kaputte Einträge fallen raus. */
export function geraeteListe(roh) {
  return (Array.isArray(roh) ? roh : []).filter((g) => g && typeof g === 'object' && /^[a-z0-9-]{1,40}$/.test(String(g.id || '')));
}

/** Nächster freier Tunnel-Port (ab PORT_BASIS, Env FC_GERAETE_PORT_BASIS). */
export function freierPort(liste, schonBelegt = []) {
  // Auch Ports, auf denen schon etwas lauscht (z. B. eine zweite Instanz mit eigenen Geräten), sind tabu.
  const belegt = new Set([...(liste || []).map((g) => Number(g.port)), ...schonBelegt].filter(Boolean));
  let p = PORT_BASIS; while (belegt.has(p)) p++;
  return p;
}

/** Einmal-Code: 8 Zeichen ohne Verwechsler (kein 0/O/1/l/i). zufall = Bytes. */
export function codeAus(zufall) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(zufall || []).slice(0, 8).map((b) => abc[b % abc.length]).join('');
}
export const codeFormOk = (code) => /^[a-hj-km-np-z2-9]{8}$/.test(String(code || ''));

/** Neues Gerät anlegen (wartet auf Kopplung). → { geraet } | { fehler } */
export function geraetAnlegen(liste, { name, zufall, jetzt, portsBelegt = [] }) {
  const n = String(name || '').trim().slice(0, 60);
  let id = geraetSlug(n);
  if (!id) return { fehler: 'Name fehlt.' };
  if (RESERVIERT.includes(id)) id = `${id}-geraet`;
  const ids = new Set((liste || []).map((g) => g.id));
  if (ids.has(id)) { let i = 2; while (ids.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }
  const code = codeAus(zufall);
  if (!codeFormOk(code)) return { fehler: 'Code konnte nicht erzeugt werden.' };
  const t = new Date(jetzt).getTime();
  return {
    geraet: {
      id, name: n, status: 'wartet', port: freierPort(liste, portsBelegt), code,
      code_bis: new Date(t + CODE_GUELTIG_MS).toISOString(), angelegt: new Date(t).toISOString(),
      ssh_ziel: '', heimordner: '', tmux: '', system: '', tunnel_key: '', host_key: '',
    },
  };
}

/** Gerät zum Code finden, solange der Code gilt. Nach der Kopplung gilt er nur noch für die Status-Abfrage. */
export function geraetZumCode(liste, code, jetzt, { nurWartend = true } = {}) {
  if (!codeFormOk(code)) return null;
  const g = (liste || []).find((x) => x.code === code);
  if (!g) return null;
  if (new Date(jetzt).getTime() > Date.parse(g.code_bis || 0)) return null;
  if (nurWartend && g.status !== 'wartet') return null;
  return g;
}

export const pubkeyOk = (k) => /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{40,80}={0,2}( [^\n\r"'\\]{0,100})?$/.test(String(k || '').trim());
const nutzerOk = (u) => /^[a-z_][a-z0-9_.-]{0,31}$/i.test(String(u || ''));
const pfadOk = (p) => /^\/[A-Za-z0-9._/ -]{1,200}$/.test(String(p || '')) && !String(p).includes('..');

/**
 * Anmeldung des Geräts (vom Einrichtungs-Skript). Prüft alles, was später in ssh-Aufrufe oder
 * authorized_keys wandert. → { geraet } (gekoppelt, Code verbraucht) | { fehler }
 */
export function geraetAnmelden(g, { pubkey, nutzer, heimordner, tmux, hostkey, system }, jetzt) {
  if (!g || g.status !== 'wartet') return { fehler: 'Code ungültig oder abgelaufen.' };
  const pk = String(pubkey || '').trim().split(/\s+/).slice(0, 2).join(' ');
  const hk = String(hostkey || '').trim().split(/\s+/).slice(0, 2).join(' ');
  if (!pubkeyOk(pk)) return { fehler: 'Schlüssel fehlt oder ist kein ed25519-Schlüssel.' };
  if (!pubkeyOk(hk)) return { fehler: 'Host-Schlüssel des Geräts fehlt (läuft sshd / „Entfernte Anmeldung"?).' };
  if (!nutzerOk(nutzer)) return { fehler: 'Benutzername ungültig.' };
  if (!pfadOk(heimordner)) return { fehler: 'Heimordner ungültig.' };
  if (!pfadOk(tmux)) return { fehler: 'tmux-Pfad ungültig.' };
  return {
    geraet: {
      ...g, status: 'gekoppelt', tunnel_key: pk, host_key: hk, ssh_ziel: `${nutzer}@127.0.0.1`,
      heimordner: String(heimordner), tmux: String(tmux), system: system === 'linux' ? 'linux' : 'macos',
      gekoppelt: new Date(jetzt).toISOString(),
    },
  };
}

/** authorized_keys des Tunnel-Nutzers: je gekoppeltem Gerät eine eng begrenzte Zeile. */
export function authorizedKeys(liste) {
  const zeilen = (liste || []).filter((g) => g.status === 'gekoppelt' && pubkeyOk(g.tunnel_key) && Number(g.port) >= PORT_BASIS)
    .map((g) => `restrict,port-forwarding,permitlisten="127.0.0.1:${Number(g.port)}",command="/bin/false" ${g.tunnel_key.split(' ').slice(0, 2).join(' ')} fc-geraet-${g.id}`);
  return ['# Vom Flotten-Chat gepflegt (server/geraete.mjs) — nicht von Hand ändern.', ...zeilen, ''].join('\n');
}

/** known_hosts für die Tunnel-Ports (Host-Schlüssel je Gerät festgehalten). */
export function knownHosts(liste) {
  return (liste || []).filter((g) => g.status === 'gekoppelt' && pubkeyOk(g.host_key))
    .map((g) => `[127.0.0.1]:${Number(g.port)} ${g.host_key}`).join('\n') + '\n';
}

/** ssh-Argumente (ohne Befehl) für ein gekoppeltes Gerät. */
export function sshArgs(g, { schluessel, knownHostsDatei }) {
  return ['-i', schluessel, '-p', String(Number(g.port)), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHostsDatei}`, '-o', 'IdentitiesOnly=yes',
    '-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/fc-cm-%C', '-o', 'ControlPersist=600', g.ssh_ziel];
}

/** Öffentliche Sicht (UI): ohne Schlüssel und ohne Code. */
export function geraetOeffentlich(g, { tunnelOffen = false } = {}) {
  return {
    id: g.id, name: g.name, status: g.status, system: g.system || '', port: g.port, offen: !!tunnelOffen,
    heimordner: g.heimordner || '', gekoppelt: g.gekoppelt || '', zuletzt_offen: g.zuletzt_offen || '',
    code_bis: g.status === 'wartet' ? g.code_bis : '',
  };
}

/** Wartende Geräte, deren Code abgelaufen ist, fliegen raus. */
export function abgelaufeneRaus(liste, jetzt) {
  const t = new Date(jetzt).getTime();
  return (liste || []).filter((g) => g.status !== 'wartet' || Date.parse(g.code_bis || 0) >= t);
}

/** „vor 6 h" / „vor 12 min" / „vor 3 Tagen". */
export function vorText(isoZeit, jetztMs) {
  const t = Date.parse(isoZeit); if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((jetztMs - t) / 60000));
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60); if (h < 36) return `vor ${h} h`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

/** Wächter: Tunnel-Wechsel je Gerät → Meldungen. alt/neu = { [id]: offen(bool) }. Erster Lauf: nur geschlossene. */
export function tunnelUebergaenge(alt, neu, geraete) {
  const aus = [];
  for (const g of geraete || []) {
    if (g.status !== 'gekoppelt' || !(g.id in neu)) continue;
    const erster = !(g.id in (alt || {}));
    if (!neu[g.id] && (erster || alt[g.id])) aus.push({ id: g.id, text: `⚠ ${g.name} ist nicht erreichbar (Tunnel zu). Fenster dort lassen sich nicht öffnen, laufende antworten nicht. Am Gerät prüfen: eingeschaltet, nicht im Ruhezustand, Netz da.` });
    else if (neu[g.id] && !erster && !alt[g.id]) aus.push({ id: g.id, text: `✓ ${g.name} ist wieder erreichbar.` });
  }
  return aus;
}

/** Textblock zum Einfügen in Claude Code auf dem Gerät. */
export function einfuegeBlock({ code, basisUrl, name }) {
  const url = `${basisUrl}/geraet/${code}`;
  return [
    `Richte dieses Gerät („${name}") für den Flotten-Chat ein.`,
    `1. Lade das Einrichtungs-Skript: curl -fsSL ${url} -o /tmp/fleet-geraet.sh`,
    '2. Lies es durch und sag mir in zwei Sätzen, was es tut.',
    '3. Führe es aus: bash /tmp/fleet-geraet.sh',
    '4. Meldet es, dass die Entfernte Anmeldung (sshd) aus ist, führe mich durchs Einschalten und starte es danach erneut.',
    'Der Code gilt 30 Minuten und nur einmal.',
  ].join('\n');
}

/** Einrichtungs-Skript fürs Gerät (bash; macOS oder Linux). Enthält nur Öffentliches + den Einmal-Code. */
export function einrichtungsSkript({ code, port, host, sshPort = 22, basisUrl, serverPubKey, serverHostKey, name, tmuxSocket = 'flottenchat', tunnelNutzer = TUNNEL_NUTZER }) {
  const tn = /^[a-z_][a-z0-9_-]{0,31}$/.test(String(tunnelNutzer)) ? tunnelNutzer : TUNNEL_NUTZER;
  const label = 'chat.flotten.geraet';
  const hostEintrag = Number(sshPort) === 22 ? host : `[${host}]:${Number(sshPort)}`;
  return `#!/bin/bash
# Flotten-Chat: Gerät „${String(name || '').replace(/[^\p{L}\p{N} ._-]/gu, '')}" koppeln.
# Richtet einen dauerhaften Rückkanal-Tunnel zu ${host} ein, über den der Chat-Server Claude-Fenster
# auf diesem Gerät starten und lesen kann. Rückgängig: bash "$0" --entfernen
set -euo pipefail
CODE=${q(code)}
PORT=${Number(port)}
HOST=${q(host)}
SSH_PORT=${Number(sshPort)}
BASIS=${q(basisUrl)}
SERVER_PUB=${q(serverPubKey)}
SERVER_HOSTKEY=${q(`${hostEintrag} ${serverHostKey}`)}
KEY="$HOME/.ssh/flotten_chat_ed25519"
SYSTEM=$(uname)
ok(){ printf '✓ %s\\n' "$*"; }
nein(){ printf '✗ %s\\n' "$*"; }
LA="$HOME/Library/LaunchAgents"; T_PLIST="$LA/${label}-tunnel.plist"; M_PLIST="$LA/${label}-tmux.plist"
SD="$HOME/.config/systemd/user"; UNIT="flotten-chat-tunnel.service"

if [ "\${1:-}" = "--entfernen" ]; then
  if [ "$SYSTEM" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/${label}-tunnel" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/${label}-tmux" 2>/dev/null || true
    rm -f "$T_PLIST" "$M_PLIST"
  else
    systemctl --user disable --now "$UNIT" 2>/dev/null || true; rm -f "$SD/$UNIT"
  fi
  [ -f "$HOME/.ssh/authorized_keys" ] && grep -vF "$SERVER_PUB" "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.fleet" && mv "$HOME/.ssh/authorized_keys.fleet" "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
  ok "Tunnel und Server-Zugang entfernt (~/fleet-themen bleibt)."; exit 0
fi

# 1 · Werkzeuge
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v tmux >/dev/null; then
  if [ "$SYSTEM" = "Darwin" ] && command -v brew >/dev/null; then echo "… installiere tmux"; brew install tmux >/dev/null
  else nein "tmux fehlt — bitte installieren (macOS: brew install tmux · Debian/Ubuntu: sudo apt install tmux)"; exit 1; fi
fi
TMUX_BIN=$(command -v tmux); ok "tmux: $TMUX_BIN"
if command -v claude >/dev/null; then ok "Claude Code da"; else nein "Claude Code fehlt — erst installieren: https://claude.com/claude-code"; exit 1; fi

# 2 · sshd am Gerät: darüber spricht der Server das Gerät durch den Tunnel an
if ! (exec 3<>/dev/tcp/127.0.0.1/22) 2>/dev/null; then
  if [ "$SYSTEM" = "Darwin" ]; then
    nein "Entfernte Anmeldung ist aus."
    echo "   Systemeinstellungen → Allgemein → Teilen → „Entfernte Anmeldung“ einschalten (nur für dich reicht), dann dieses Skript erneut starten."
    open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" 2>/dev/null || true
  else
    nein "sshd läuft nicht auf Port 22 — z. B. sudo apt install openssh-server, dann erneut starten."
  fi
  exit 2
fi
ok "sshd läuft"
HOSTKEY=$(cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)

# 3 · Schlüssel für den Tunnel
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "flotten-chat-$(hostname -s)" -f "$KEY"
ok "Schlüssel $KEY"

# 4 · Server darf sich anmelden — nur durch den Tunnel (from=127.0.0.1)
touch "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"
grep -qF "$SERVER_PUB" "$HOME/.ssh/authorized_keys" || printf 'from="127.0.0.1,::1" %s\\n' "$SERVER_PUB" >> "$HOME/.ssh/authorized_keys"
touch "$HOME/.ssh/known_hosts"
grep -qF "$SERVER_HOSTKEY" "$HOME/.ssh/known_hosts" || printf '%s\\n' "$SERVER_HOSTKEY" >> "$HOME/.ssh/known_hosts"
ok "Server-Zugang eingetragen"

# 5 · Beim Server anmelden (Einmal-Code)
SYS=macos; [ "$SYSTEM" = "Darwin" ] || SYS=linux
ANTWORT=$(curl -fsS -X POST "$BASIS/geraet/$CODE/anmelden" \\
  --data-urlencode "pubkey=$(cat "$KEY.pub")" --data-urlencode "hostkey=$HOSTKEY" --data-urlencode "system=$SYS" \\
  --data-urlencode "nutzer=$(id -un)" --data-urlencode "heimordner=$HOME" --data-urlencode "tmux=$TMUX_BIN") \\
  || { nein "Anmeldung abgelehnt — Code abgelaufen? Im Flotten-Chat neu erzeugen."; exit 1; }
case "$ANTWORT" in *'"ok":true'*) ok "beim Server angemeldet";; *) nein "Anmeldung: $ANTWORT"; exit 1;; esac

# 6 · Arbeitsordner
mkdir -p "$HOME/fleet-themen"; ok "~/fleet-themen"

# 7 · Dauerhafter Tunnel (startet nach Neustart/Abbruch von selbst)
SSH_OPTS=(-N -i "$KEY" -p "$SSH_PORT" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -R "127.0.0.1:$PORT:127.0.0.1:22" "${tn}@$HOST")
if [ "$SYSTEM" = "Darwin" ]; then
  # macOS: Tunnel + tmux-Grundsitzung als LaunchAgents. tmux läuft im Anmelde-Kontext → Claude-Fenster darin
  # sehen den Schlüsselbund (Login bleibt gültig).
  mkdir -p "$LA" "$HOME/Library/Logs"
  ARGS=""; for a in /usr/bin/ssh "\${SSH_OPTS[@]}"; do ARGS="$ARGS<string>$a</string>"; done
  cat > "$T_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${label}-tunnel</string>
 <key>ProgramArguments</key><array>$ARGS</array>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
 <key>StandardErrorPath</key><string>$HOME/Library/Logs/fleet-tunnel.log</string>
</dict></plist>
PLIST
  cat > "$M_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${label}-tmux</string>
 <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
  <string>while true; do "$TMUX_BIN" -L ${String(tmuxSocket).replace(/[^A-Za-z0-9_-]/g, '')} has-session -t fc-geraet 2>/dev/null || "$TMUX_BIN" -L ${String(tmuxSocket).replace(/[^A-Za-z0-9_-]/g, '')} new-session -d -s fc-geraet; sleep 30; done</string></array>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLIST
  for P in "$T_PLIST" "$M_PLIST"; do L=$(basename "$P" .plist); launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$P"; done
  ok "Tunnel läuft als LaunchAgent"
elif ! systemctl --user show-environment >/dev/null 2>&1; then
  # Linux ohne systemd (Container, WSL): Schleife im Hintergrund — überlebt keinen Neustart.
  pkill -u "$(id -u)" -f "127.0.0.1:$PORT:127.0.0.1:22" 2>/dev/null || true
  nohup sh -c "while true; do /usr/bin/ssh $(printf '%q ' "\${SSH_OPTS[@]}"); sleep 15; done" >"$HOME/.fleet-tunnel.log" 2>&1 &
  ok "Tunnel läuft im Hintergrund (ohne systemd)"
  echo "⚠ Nach einem Neustart: dieses Skript mit neuem Code erneut ausführen oder einen @reboot-Eintrag anlegen."
else
  # Linux: systemd --user-Dienst. Ohne „linger" endet er beim Abmelden — dann einmal: sudo loginctl enable-linger $(id -un)
  mkdir -p "$SD"
  ZEILE="/usr/bin/ssh"; for a in "\${SSH_OPTS[@]}"; do ZEILE="$ZEILE $(printf '%q' "$a")"; done
  printf '[Unit]\\nDescription=Flotten-Chat Rückkanal\\nAfter=network-online.target\\n\\n[Service]\\nExecStart=%s\\nRestart=always\\nRestartSec=15\\n\\n[Install]\\nWantedBy=default.target\\n' "$ZEILE" > "$SD/$UNIT"
  systemctl --user daemon-reload && systemctl --user enable --now "$UNIT" >/dev/null
  ok "Tunnel läuft als systemd --user-Dienst"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "⚠ Damit der Tunnel auch ohne Anmeldung läuft: sudo loginctl enable-linger $(id -un)"
  fi
fi

# 8 · Warten, bis der Server den Tunnel sieht
for i in $(seq 1 20); do
  S=$(curl -fsS "$BASIS/geraet/$CODE/status" 2>/dev/null || true)
  case "$S" in *'"offen":true'*) ok "Tunnel offen — das Gerät ist im Flotten-Chat unter ＋ Fenster → Ort wählbar."; exit 0;; esac
  sleep 3
done
nein "Tunnel noch nicht offen. Log: macOS ~/Library/Logs/fleet-tunnel.log · Linux journalctl --user -u $UNIT (ohne systemd: ~/.fleet-tunnel.log)"; exit 1
`;
}

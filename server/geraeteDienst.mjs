// server/geraeteDienst.mjs — I/O zu server/geraete.mjs: Geräteliste im Datenverzeichnis, Server-Schlüssel,
// Schlüsselliste für den Tunnel-Nutzer, Tunnel-Status (lauscht der Port auf 127.0.0.1?) und Tunnel kappen.
//
// Die Schlüsselliste liegt als Datei im Datenverzeichnis (geraete-authorized-keys). sshd liest sie über
// AuthorizedKeysCommand (bin/geraete-server-einrichten.sh) — so muss der Chat-Server nicht als root laufen.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { geraeteListe, authorizedKeys, knownHosts, abgelaufeneRaus, TUNNEL_NUTZER } from './geraete.mjs';

export function createGeraeteDienst(dataDir, { tunnelNutzer = process.env.FC_GERAETE_NUTZER || TUNNEL_NUTZER } = {}) {
  const datei = path.join(dataDir, 'geraete.json');
  const knownHostsDatei = path.join(dataDir, 'geraete-known-hosts');
  const keysDatei = path.join(dataDir, 'geraete-authorized-keys');
  const schluessel = path.join(dataDir, 'geraete_ed25519');
  const roh = () => { try { const d = JSON.parse(fs.readFileSync(datei, 'utf8')); return Array.isArray(d.geraete) ? d.geraete : []; } catch { return []; } };
  const atomar = (ziel, inhalt, mode = 0o600) => { fs.writeFileSync(ziel + '.tmp', inhalt, { mode }); fs.renameSync(ziel + '.tmp', ziel); };
  let lauschCache = { am: 0, ports: new Set() };
  try { fs.mkdirSync(path.join(os.homedir(), '.ssh'), { recursive: true, mode: 0o700 }); } catch { /* ssh-Multiplex läuft dann ohne */ }

  return {
    datei, knownHostsDatei, keysDatei, schluessel, tunnelNutzer,
    /** Alle Geräte, abgelaufene Kopplungs-Codes schon raus. */
    alle() { return abgelaufeneRaus(geraeteListe(roh()), new Date()); },
    holen(id) { return this.alle().find((g) => g.id === String(id || '')) || null; },
    speichern(liste) {
      atomar(datei, JSON.stringify({ geraete: liste, stand: new Date().toISOString() }, null, 1));
      atomar(knownHostsDatei, knownHosts(liste));
      atomar(keysDatei, authorizedKeys(liste), 0o644); // sshd liest sie als AuthorizedKeysCommandUser
    },
    /** Server-Schlüssel (für die Anmeldung am Gerät durch den Tunnel) — beim ersten Bedarf erzeugen. */
    serverPubKey() {
      try {
        if (!fs.existsSync(schluessel)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'flotten-chat-geraete', '-f', schluessel], { stdio: 'ignore', timeout: 10000 });
        return fs.readFileSync(schluessel + '.pub', 'utf8').trim();
      } catch { return ''; }
    },
    serverHostKey() { try { return fs.readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' '); } catch { return ''; } },
    /** Server eingerichtet? Tunnel-Nutzer existiert und sshd fragt uns nach seinen Schlüsseln. */
    bereit() {
      try { execFileSync('id', [tunnelNutzer], { stdio: 'ignore', timeout: 3000 }); } catch { return { ok: false, fehler: `Tunnel-Nutzer „${tunnelNutzer}" fehlt — einmal: sudo bash bin/geraete-server-einrichten.sh` }; }
      if (!this.serverHostKey()) return { ok: false, fehler: 'Kein ed25519-Host-Schlüssel unter /etc/ssh — läuft sshd?' };
      return { ok: true };
    },
    /** Ports, auf denen 127.0.0.1 lauscht (5 s Cache — die Kanalliste fragt oft). */
    lauschendePorts() {
      if (Date.now() - lauschCache.am < 5000) return lauschCache.ports;
      const ports = new Set();
      try {
        const out = execFileSync('ss', ['-ltnH'], { encoding: 'utf8', timeout: 4000 });
        for (const z of out.split('\n')) { const m = /\s127\.0\.0\.1:(\d+)\s/.exec(z); if (m) ports.add(Number(m[1])); }
      } catch { /* ohne ss: leer */ }
      lauschCache = { am: Date.now(), ports };
      return ports;
    },
    tunnelOffen(g) { return !!g && g.status === 'gekoppelt' && this.lauschendePorts().has(Number(g.port)); },
    /** Tunnel kappen: den sshd-Prozess des Tunnel-Nutzers beenden, der den Port hält (braucht Rechte dazu;
     *  ohne sie greift die Sperre beim nächsten Verbindungsaufbau, weil der Schlüssel schon raus ist). */
    tunnelKappen(g) {
      if (!g || !Number(g.port)) return { ok: false };
      let pids = [];
      try { pids = [...execFileSync('ss', ['-ltnpH', `sport = :${Number(g.port)}`], { encoding: 'utf8', timeout: 4000 }).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])); } catch { /* keiner */ }
      let beendet = 0;
      for (const pid of new Set(pids)) {
        try { if (execFileSync('ps', ['-o', 'user=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim() === tunnelNutzer) { process.kill(pid, 'SIGTERM'); beendet++; } } catch { /* schon weg / keine Rechte */ }
      }
      lauschCache.am = 0;
      return { ok: true, beendet };
    },
  };
}

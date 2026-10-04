// server/orte.mjs — der I/O-Griff zu einem Fenster (v1.0 „Konsole im Chat“).
//
// Ein Fenster ist eine tmux-Session mit einem Claude-Code-Prozess. Sie läuft an einem „Ort“:
//   lokal       auf dem Rechner, auf dem der Chat-Server läuft (tmux direkt)
//   ssh:<host>  auf einem anderen Rechner (Mac, zweiter Server) — dieselben Befehle über ssh
//   geraet:<id> auf einem gekoppelten Gerät — ssh durch dessen Rückkanal-Tunnel (server/geraete.mjs)
// Alles hier ist bewusst dünn: tmux + ps + Dateien lesen. Die Logik (Protokoll deuten, Dialoge,
// Tasten) steht rein in protokoll.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { protokollOrdner, protokollZuProzess } from './protokoll.mjs';

const TMUX = process.env.FC_TMUX || 'tmux';
const SOCK = process.env.FC_TMUX_SOCKET || 'flottenchat';
const CLAUDE = process.env.FC_CLAUDE_BIN || 'claude';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// „~/…" am entfernten Ort: $HOME ausserhalb der Anführungszeichen, damit die Shell ihn auflöst.
const rq = (p) => (String(p).startsWith('~/') ? `"$HOME"/${q(String(p).slice(2))}` : q(p));

// Gekoppelte Geräte (server/geraete.mjs): Ort „geraet:<id>" → ssh durch den Rückkanal-Tunnel.
let geraetHolen = () => null, geraetSsh = () => [];
export function setGeraeteQuelle(holen, sshArgsFuer) { geraetHolen = holen; geraetSsh = sshArgsFuer; }
export function geraetVon(f) { const m = /^geraet:([a-z0-9-]+)$/.exec(String(f && f.ort || '')); return m ? geraetHolen(m[1]) : null; }

export function istSsh(f) { return /^(ssh|geraet):/.test(String(f && f.ort || '')); }
export function sshHost(f) { return String(f.ort).slice(4).trim(); }
/** ssh-Argumente bis vor den Befehl: Gerät → Tunnel-Argumente, sonst der Host aus „ssh:<host>". */
function sshZiel(f) {
  if (/^geraet:/.test(String(f.ort))) { const g = geraetVon(f); return g && g.status === 'gekoppelt' ? geraetSsh(g) : null; }
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshHost(f)];
}

/** Befehl am Ort ausführen (lokal direkt, sonst via ssh). Rückgabe stdout oder '' bei Fehler. */
export function run(f, cmd, args = [], { timeout = 8000 } = {}) {
  try {
    if (!istSsh(f)) return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ziel = sshZiel(f);
    if (!ziel) return '';
    const zeile = [cmd, ...args].map(q).join(' ');
    return execFileSync('ssh', [...ziel, zeile], { encoding: 'utf8', timeout: timeout + 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
// Auf einem Gerät liegt tmux oft nicht im PATH einer ssh-Sitzung (macOS: /opt/homebrew/bin) — Pfad aus der Kopplung.
const tmuxBin = (f) => { const g = geraetVon(f); return (g && g.tmux) || TMUX; };
const tm = (f, args, opt) => run(f, tmuxBin(f), ['-L', SOCK, ...args], opt);
export const TMUX_SOCKET = SOCK;

/** ps-„etime“ ([[dd-]hh:]mm:ss) → Sekunden (portabel Linux/macOS). */
export function etimeSekunden(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + Number(m[3]) * 60 + Number(m[4]);
}

/** Läuft das Fenster? → {lebt, pid, gestartetMs} */
export function prozessVon(f) {
  const pid = Number((tm(f, ['list-panes', '-t', `${f.tmux}:0`, '-F', '#{pane_pid}']) || '').split('\n')[0] || 0);
  if (!pid) return { lebt: false, pid: 0, gestartetMs: 0 };
  // Der Claude-Prozess ist das Kind der Pane-Shell (oder die Pane selbst bei exec).
  const kinder = run(f, 'pgrep', ['-P', String(pid)]).split('\n').filter(Boolean);
  const kandidat = kinder.length ? Number(kinder[0]) : pid;
  const sek = etimeSekunden(run(f, 'ps', ['-o', 'etime=', '-p', String(kandidat)]));
  return { lebt: true, pid: kandidat, gestartetMs: sek ? Date.now() - sek * 1000 : 0 };
}

/** Start-Befehl für die Session-Shell (ein String). */
export function startBefehl(f) {
  const cfg = f.config_dir ? `CLAUDE_CONFIG_DIR=${q(f.config_dir)} ` : '';
  const modus = ['auto', 'default', 'plan', 'acceptEdits'].includes(f.start_modus) ? f.start_modus : 'auto';
  const text = String(f.start_text || '').replace(/\s+/g, ' ').trim();
  return `cd ${q(f.ordner)} && clear && export DISABLE_AUTOUPDATER=1 && ${cfg}exec ${CLAUDE} --permission-mode ${modus}${text ? ' ' + q(text) : ''}`;
}

/** Session anlegen + Claude starten (idempotent: läuft sie schon, nichts tun). */
export function sessionStarten(f) {
  if (!/^fc-[a-z0-9_-]+$/.test(String(f.tmux || ''))) return { ok: false, fehler: 'Session-Name nicht erlaubt' };
  const sessions = () => tm(f, ['list-sessions', '-F', '#{session_name}']).split('\n');
  if (sessions().includes(f.tmux)) { if (prozessVon(f).lebt) return { ok: true, schon: true }; return sessionNeustart(f); }
  if (!istSsh(f) && !fs.existsSync(f.ordner)) return { ok: false, fehler: `Ordner fehlt: ${f.ordner}` };
  if (istSsh(f)) run(f, 'mkdir', ['-p', f.ordner]);
  tm(f, ['new-session', '-d', '-s', f.tmux, '-c', f.ordner]);
  if (!sessions().includes(f.tmux)) return { ok: false, fehler: 'tmux-Session konnte nicht angelegt werden (tmux installiert? Ort erreichbar?)' };
  tm(f, ['send-keys', '-t', `${f.tmux}:0`, startBefehl(f), 'Enter']);
  return { ok: true };
}

/** Frischer Claude in derselben Session (Viewer bleiben dran). */
export function sessionNeustart(f) {
  const liste = tm(f, ['list-sessions', '-F', '#{session_name}']).split('\n');
  if (!liste.includes(f.tmux)) return sessionStarten(f);
  tm(f, ['set-option', '-t', f.tmux, 'remain-on-exit', 'on']);
  tm(f, ['respawn-pane', '-k', '-t', `${f.tmux}:0`, `bash -lc ${q(startBefehl(f))}`]);
  return { ok: true };
}

/** Session beenden (Prozess + Fenster weg). */
export function sessionBeenden(f) {
  tm(f, ['kill-session', '-t', f.tmux]);
  return { ok: !tm(f, ['list-sessions', '-F', '#{session_name}']).split('\n').includes(f.tmux) };
}

/** Terminalbild (tmux capture-pane). */
export function paneLesen(f) { return tm(f, ['capture-pane', '-t', `${f.tmux}:0`, '-p'], { timeout: 3000 }); }

/** Terminalbild mit Verlauf (die letzten 300 Zeilen) — für den Text, der über einer Rückfrage steht. */
export function paneVerlaufLesen(f) { return tm(f, ['capture-pane', '-t', `${f.tmux}:0`, '-p', '-S', '-300'], { timeout: 3000 }); }
/** Terminalbild MIT Farben (ANSI) fürs Live-Terminal im Kanal-Kopf. */
export function paneFarbigLesen(f) { return tm(f, ['capture-pane', '-t', `${f.tmux}:0`, '-p', '-e'], { timeout: 3000 }); }

// tmux-Fenster ohne angehängten Bildschirm sind 80×24 groß; eine hohe Rückfrage fällt dann oben raus.
// Kurz vergrößern, lesen, zurück auf die Größe des angehängten Bildschirms (window-size wieder global).
export const FENSTER_GROESSE = { x: 200, y: 60 };
export function fensterVergroessern(f) {
  tm(f, ['resize-window', '-t', `${f.tmux}:0`, '-x', String(FENSTER_GROESSE.x), '-y', String(FENSTER_GROESSE.y)], { timeout: 4000 });
  return { ok: true };
}
export function fensterZurueck(f) {
  tm(f, ['set-option', '-wu', '-t', `${f.tmux}:0`, 'window-size'], { timeout: 3000 });
  const clients = String(tm(f, ['list-clients', '-t', f.tmux], { timeout: 3000 }) || '').trim();
  if (clients) { tm(f, ['resize-window', '-A', '-t', `${f.tmux}:0`], { timeout: 3000 }); tm(f, ['set-option', '-wu', '-t', `${f.tmux}:0`, 'window-size'], { timeout: 3000 }); }
  return { ok: true };
}

const TASTEN = new Set(['Down', 'Up', 'Enter', 'Escape', 'Space', 'BTab', 'Tab', '1', '2', '3', '4', '5', '6', '7', '8', '9']); // Ziffern: Tastenleiste im Live-Terminal
export function tastenSenden(f, tasten = []) {
  const liste = (Array.isArray(tasten) ? tasten : []).filter((t) => TASTEN.has(t)).slice(0, 40);
  if (!liste.length) return { ok: false, fehler: 'Keine Taste' };
  for (const t of liste) tm(f, ['send-keys', '-t', `${f.tmux}:0`, t], { timeout: 4000 });
  return { ok: true, getippt: liste.length };
}
/** Text ins Fenster tippen (Umbrüche → Leerzeichen), dann getrennt Enter. */
export function textSenden(f, text) {
  const t = String(text || '').replace(/\r/g, '').replace(/\n/g, ' ').trim();
  if (!t) return { ok: false, fehler: 'Kein Text' };
  if (t.length > 8000) return { ok: false, fehler: 'Zu lang für eine Eingabe' };
  tm(f, ['send-keys', '-t', `${f.tmux}:0`, t]);
  tm(f, ['send-keys', '-t', `${f.tmux}:0`, '', 'Enter']);
  return { ok: true };
}

// ── Protokoll-Dateien ───────────────────────────────────────────────────────
export function protokollDir(f) {
  const g = geraetVon(f);
  const cfg = f.config_dir || (g && g.heimordner ? `${g.heimordner}/.claude` : (istSsh(f) ? '~/.claude' : path.join(process.env.HOME || '/root', '.claude')));
  return protokollOrdner(cfg, f.ordner);
}
/** Dateiliste {name, geburtMs, letzteMs, groesse} im Protokoll-Ordner. */
export function protokollDateien(f) {
  const dir = protokollDir(f);
  if (!istSsh(f)) {
    let namen = []; try { namen = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    return namen.map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, geburtMs: st.birthtimeMs || st.ctimeMs, letzteMs: st.mtimeMs, groesse: st.size }; });
  }
  // Remote: GNU stat zuerst, sonst BSD (macOS).
  const out = run(f, 'sh', ['-c', `cd ${rq(dir)} 2>/dev/null && (stat -c '%n %s %W %Y' *.jsonl 2>/dev/null || stat -f '%N %z %B %m' *.jsonl 2>/dev/null)`], { timeout: 8000 });
  return out.split('\n').filter(Boolean).map((z) => { const [name, groesse, geburt, letzte] = z.trim().split(/\s+/); return { name, groesse: Number(groesse) || 0, geburtMs: (Number(geburt) || Number(letzte) || 0) * 1000, letzteMs: (Number(letzte) || 0) * 1000 }; }).filter((d) => d.name && d.name.endsWith('.jsonl'));
}
/** Das laufende Protokoll dieses Fensters (Datei, Sitzung, Start), oder null. */
export function laufendesProtokoll(f) {
  const p = prozessVon(f);
  if (!p.lebt || !p.gestartetMs) return null;
  const dateien = protokollDateien(f);
  const name = protokollZuProzess(p.gestartetMs, dateien);
  if (!name) return null;
  const d = dateien.find((x) => x.name === name);
  return { datei: path.join(protokollDir(f), name), name, sitzung: name.replace(/\.jsonl$/, ''), gestartetMs: p.gestartetMs, pid: p.pid, groesse: d ? d.groesse : 0 };
}
/** Datei ab Byte-Offset lesen (max 4 MB je Runde). */
export function dateiAb(f, datei, ab = 0) {
  const start = Math.max(0, Number(ab) || 0);
  if (!istSsh(f)) {
    let st; try { st = fs.statSync(datei); } catch { return { roh: '', groesse: 0 }; }
    if (start >= st.size) return { roh: '', groesse: st.size };
    const fd = fs.openSync(datei, 'r');
    const buf = Buffer.alloc(Math.min(st.size - start, 4 * 1024 * 1024));
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return { roh: buf.toString('utf8'), groesse: st.size };
  }
  const roh = run(f, 'sh', ['-c', `tail -c +${start + 1} ${rq(datei)} | head -c 4194304`], { timeout: 15000 });
  const groesse = Number(run(f, 'sh', ['-c', `stat -c %s ${rq(datei)} 2>/dev/null || stat -f %z ${rq(datei)}`])) || 0;
  return { roh, groesse };
}

// ── Worktree-Hygiene ────────────────────────────────────────────────────────
/** git-Worktree für ein Fenster anlegen: <repo>/worktrees/<name>, Branch fc/<name>. Nur lokal. */
export function worktreeAnlegen(repo, name) {
  const ziel = path.join(repo, 'worktrees', name);
  if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, fehler: 'Kein git-Repo: ' + repo };
  if (fs.existsSync(ziel)) return { ok: true, ordner: ziel, schon: true };
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', `fc/${name}`, ziel], { stdio: 'ignore', timeout: 30000 });
    return { ok: true, ordner: ziel };
  } catch (e) {
    try { execFileSync('git', ['-C', repo, 'worktree', 'add', ziel, `fc/${name}`], { stdio: 'ignore', timeout: 30000 }); return { ok: true, ordner: ziel }; } catch { /* unten */ }
    return { ok: false, fehler: 'git worktree add scheiterte: ' + String(e && e.message || e).slice(0, 160) };
  }
}
/** Ist der Worktree sauber (nichts Ungesichertes)? */
export function worktreeSauber(ordner) {
  try { return execFileSync('git', ['-C', ordner, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000 }).trim() === ''; } catch { return false; }
}
/** Ungesichertes als WIP-Commit sichern (nie löschen), dann Branch pushen (fail-soft). */
export function worktreeSichern(ordner, { nachricht = 'WIP: Stand beim Schließen des Fensters (Flotten-Chat)' } = {}) {
  try {
    if (!worktreeSauber(ordner)) {
      execFileSync('git', ['-C', ordner, 'add', '-A'], { stdio: 'ignore', timeout: 15000 });
      execFileSync('git', ['-C', ordner, 'commit', '-q', '-m', nachricht], { stdio: 'ignore', timeout: 30000 });
    }
    try { execFileSync('git', ['-C', ordner, 'push', '-q', '-u', 'origin', 'HEAD'], { stdio: 'ignore', timeout: 60000 }); } catch { /* kein Remote — Branch bleibt lokal */ }
    return { ok: true };
  } catch (e) { return { ok: false, fehler: String(e && e.message || e).slice(0, 160) }; }
}
/** Worktree entfernen — nur wenn sauber. Branch bleibt. */
export function worktreeEntfernen(repo, ordner) {
  if (!worktreeSauber(ordner)) return { ok: false, fehler: 'Ungesicherte Änderungen — wird nicht gelöscht.' };
  try { execFileSync('git', ['-C', repo, 'worktree', 'remove', ordner], { stdio: 'ignore', timeout: 30000 }); return { ok: true }; }
  catch (e) { return { ok: false, fehler: String(e && e.message || e).slice(0, 160) }; }
}
/** Verwaiste Worktrees eines Repos: Ordner unter worktrees/, die kein registriertes Fenster besitzt. */
export function worktreesVerwaist(repo, bekannteOrdner = []) {
  const basis = path.join(repo, 'worktrees');
  let namen = []; try { namen = fs.readdirSync(basis); } catch { return []; }
  return namen.map((n) => path.join(basis, n)).filter((p) => fs.existsSync(path.join(p, '.git')) && !bekannteOrdner.includes(p))
    .map((p) => ({ ordner: p, sauber: worktreeSauber(p) }));
}
export function repoWurzel(ordner) {
  try { return execFileSync('git', ['-C', ordner, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 8000 }).trim(); } catch { return ''; }
}

/** Ein Skript losschicken, ohne zu warten (z. B. Neustart-Helfer). */
export function losschicken(cmd, args) { try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* egal */ } }

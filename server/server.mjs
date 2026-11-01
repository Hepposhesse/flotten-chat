// server/server.mjs — Sales Engine Flotten Chat v1.0 „Konsole im Chat“.
// Ein Node-Server ohne Framework: HTTP-API + SSE + Web-UI + Reminder-Timer + Konsole-Runde.
// Start: `flottenchat up` (bin/) oder `node server/server.mjs`.
// Zugang: Menschen per E-Mail + Passwort (Cookie), Agenten/Skripte per Bearer-Token
//         (Admin-Token in data/admin-token; Agenten-Tokens via Self-Connect).
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  openDb, neuerToken, kanalAnlegen, kanaele, senden, nachrichten,
  inviteAnlegen, connect, agentViaToken, cursorSetzen, presence,
  statusSetzen, statusSetzenNachName, stopAnfordern, stopHolenUndQuittieren, stopHolenUndQuittierenNachName,
  reminderAnlegen, reminders, reminderErledigt, reminderVerschieben, faelligeFeuern, nowIso,
  fensterAnlegen, fensterHolen, fensterAlle, fensterAendern, fensterLoeschen,
  karteAnlegen, karteHolen, karten, karteAendern, karteVerlauf, karteLoeschen, SPALTEN,
  nutzerAnlegen, nutzerAnzahl, nutzerPruefen, sitzungAnlegen, sitzungNutzer, sitzungLoeschen,
} from './db.mjs';
import { createLimiter, groesseErlaubt, clientIdSauber } from './limits.mjs';
import { starteKonsole } from './konsole.mjs';
import { setGeraeteQuelle, TMUX_SOCKET, sessionStarten, sessionNeustart, sessionBeenden, prozessVon, paneLesen, paneFarbigLesen, tastenSenden, textSenden, worktreeAnlegen, worktreeSichern, worktreeEntfernen, worktreeSauber, worktreesVerwaist, repoWurzel, istSsh } from './orte.mjs';
import { ansiZuHtml, TERMINAL_TASTEN } from './terminal.mjs';
import { geraetAnlegen, geraetZumCode, geraetAnmelden, geraetOeffentlich, einfuegeBlock, einrichtungsSkript, sshArgs, tunnelUebergaenge } from './geraete.mjs';
import { createGeraeteDienst } from './geraeteDienst.mjs';
import { slug } from './protokoll.mjs';
import { createAufraeumen, istAufgeraeumt } from './aufraeumen.mjs'; // 1.2 Spiegel
import { nurShell } from './orte.mjs'; // 1.2 Spiegel
import { letzteNachrichtId } from './db.mjs'; // 1.2 Spiegel
import { einstellungenLaden, einstellungenSpeichern, gelesenLaden, gelesenSetzen, ungelesen } from './kanaele.mjs';
import { sucheNachrichten } from './suche.mjs';
import { ablegen as ablageAblegen, liste as ablageListe, loeschen as ablageLoeschen, streamen as ablageStreamen } from './ablage.mjs';
import { erinnerungenSchema, ordnerAlle, ordnerAnlegen, ordnerUmbenennen, ordnerLoeschen, reminderInOrdner, reminderTitel, reminderNotiz, reminderUebergeben, uebergabeText } from './erinnerungen.mjs';
// === Chat-Komfort (1.2) ===
import { verlaufSchema, verlaufAb, verlaufAbSetzen, nachrichtenEtappe, nurAktuellerVerlauf } from './verlauf.mjs';
import { schwarmFuerOrdner } from './schwarm.mjs';
import { protokollDir } from './orte.mjs';
// === Ende Chat-Komfort (1.2) ===
// === Aufgaben (1.2) ===
import { createAufgabenDienst, TAKT_S as AUFGABEN_TAKT_S } from './aufgaben.mjs';
// === /Aufgaben (1.2) ===

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.FC_DATA_DIR || join(process.cwd(), 'data');
const PORT = Number(process.env.FC_PORT || 3900);
const db = openDb(DATA);

// Admin-Token: einmal erzeugen, Datei 0600 (für Skripte/Agenten; Menschen loggen sich mit E-Mail + Passwort ein).
const ADMIN_FILE = join(DATA, 'admin-token');
if (!existsSync(ADMIN_FILE)) writeFileSync(ADMIN_FILE, neuerToken('adm'), { mode: 0o600 });
const ADMIN = readFileSync(ADMIN_FILE, 'utf8').trim();

const connectLimiter = createLimiter({ limit: Number(process.env.FC_CONNECT_LIMIT || 10), windowMs: 60_000 });
const loginLimiter = createLimiter({ limit: Number(process.env.FC_LOGIN_LIMIT || 8), windowMs: 60_000 });
const mediaLimiter = createLimiter({ limit: Number(process.env.FC_MEDIA_LIMIT || 30), windowMs: 60_000 });
const MEDIA_MAX = Number(process.env.FC_MEDIA_MAX_MB || 200) * 1024 * 1024;
const zuViele = (res, r) => { res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(r.retryAfterS) }); res.end(JSON.stringify({ ok: false, fehler: `Zu viele Anfragen — bitte in ${r.retryAfterS} s nochmal.` })); };

// Standard-Kanäle (v1.0): Erinnerungen (Wecker ohne KI) + Hilfe (Support-Brücke zum Hersteller). Alles andere sind Fenster.
kanalAnlegen(db, { name: 'erinnerungen', label: '⏰ Erinnerungen' });
kanalAnlegen(db, { name: 'hilfe', label: '🛟 Hilfe' });
kanalAnlegen(db, { name: 'allgemein', label: 'Allgemein' });

// ── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const zeile = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(zeile); } catch { sseClients.delete(res); } }
}

// ── Reminder-Timer: feuert OHNE AI-Aufruf ───────────────────────────────────
setInterval(() => {
  try { for (const g of faelligeFeuern(db)) broadcast('message', g.message); } catch { /* fail-safe */ }
}, 30_000).unref();

// ── Konsole im Chat: die Runde über alle Fenster ────────────────────────────
const konsole = starteKonsole({ db, dataDir: DATA, broadcast });

// ── 1.2 Spiegel: Aufräumen vor Neu starten / Löschen / Schließen ──────────────
// Das Fenster schreibt seinen Stand weg und committet; die Aktion folgt nach „aufgeräumt“ (höchstens 2 Min).
// Aus oder nur die nackte Shell im Fenster → sofort (dort räumt niemand auf).
function fensterSchliessenJetzt(f) {
  const hinweis = [];
  if (f.worktree && !istSsh(f)) { const s = worktreeSichern(f.ordner); if (!s.ok) hinweis.push('Sichern scheiterte: ' + s.fehler); }
  sessionBeenden(f);
  if (f.worktree && !istSsh(f)) {
    const repo = repoWurzel(f.ordner) || dirname(dirname(f.ordner));
    const w = worktreeSauber(f.ordner) ? worktreeEntfernen(repo, f.ordner) : { ok: false, fehler: 'ungesichert' };
    hinweis.push(w.ok ? `Worktree entfernt, Branch fc/${f.name} bleibt.` : `Worktree bleibt liegen (${w.fehler}).`);
  }
  const e = senden(db, { kanal: f.name, von: 'flottenchat', typ: 'system', inhalt: `✅ Fenster geschlossen. ${hinweis.join(' ')}`.trim() }); if (e) broadcast('message', e);
  // Geschlossen = weg: Registry-Eintrag raus, Kanal archiviert (Verlauf bleibt in der DB), Name wieder frei.
  fensterLoeschen(db, f.name);
  broadcast('presence', { fenster: f.name, status: 'geschlossen' });
  return { ok: true };
}
const aufraeumen = createAufraeumen({
  lebt: (f) => !!prozessVon(f).lebt && !nurShell(f),
  dialogOffen: (f) => { const z = konsole.zustand(f.name); return !!(z && z.dialog); },
  escape: (f) => tastenSenden(f, ['Escape']),
  textSenden: (f, text) => textSenden(f, text),
  letzteId: (f) => letzteNachrichtId(db, f.name),
  aufgeraeumtSeit: (f, id) => nachrichten(db, { kanal: f.name, seit: id, limit: 200 }).some((m) => m.typ === 'answer' && istAufgeraeumt(m.inhalt)),
  melden: (f, text) => { const m = senden(db, { kanal: f.name, von: 'flottenchat', typ: 'system', inhalt: text }); if (m) broadcast('message', m); },
  geaendert: (f) => broadcast('presence', { fenster: f.name, raeumt: true }),
  ausfuehren: (f, art) => {
    if (art === 'neustart') { const r = sessionNeustart(f); fensterAendern(db, f.name, { spiegel: {} }); return r; }
    if (art === 'loeschen') {
      if (f.worktree && !istSsh(f)) worktreeSichern(f.ordner); // Ungesichertes als WIP auf den Branch, nie verwerfen
      sessionBeenden(f); fensterLoeschen(db, f.name); broadcast('presence', { fenster: f.name, geloescht: true }); return { ok: true };
    }
    return fensterSchliessenJetzt(f);
  },
});

// ── 1.1: Ablage-Tresor (data/ablage, nie aufgeräumt) + Erinnerungs-Ordner (Schema additiv) ──
const ABLAGE_DIR = join(DATA, 'ablage');
const ZONE = process.env.FC_TZ || 'Europe/Berlin';
erinnerungenSchema(db);
// === Chat-Komfort (1.2): frischer Verlauf je Fenster (Spalte fenster.verlauf_ab, additiv) ===
verlaufSchema(db);

// ── Geräte koppeln: Rückkanal-Tunnel je Gerät, Ort „geraet:<id>" ──
const geraete = createGeraeteDienst(DATA);
setGeraeteQuelle((id) => geraete.holen(id), (g) => sshArgs(g, { schluessel: geraete.schluessel, knownHostsDatei: geraete.knownHostsDatei }));
const geraetLimiter = createLimiter({ limit: Number(process.env.FC_GERAET_LIMIT || 20), windowMs: 10 * 60_000 });
/** Öffentliche Adresse dieser Instanz (für das Einrichtungs-Skript): FC_PUBLIC_URL oder aus dem Request. */
const basisUrl = (req) => (process.env.FC_PUBLIC_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
const formular = (req) => new Promise((resolve) => {
  let buf = ''; req.on('data', (d) => { buf += d; if (buf.length > 20_000) req.destroy(); });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(buf))));
});
// Wächter: geht ein Tunnel zu oder wieder auf, steht es im Kanal „alarm".
let tunnelStand = {};
setInterval(() => {
  try {
    const liste = geraete.alle().filter((g) => g.status === 'gekoppelt');
    const neu = Object.fromEntries(liste.map((g) => [g.id, geraete.tunnelOffen(g)]));
    for (const u of tunnelUebergaenge(tunnelStand, neu, liste)) { kanalAnlegen(db, { name: 'alarm', label: '🚨 Alarm' }); const m = senden(db, { kanal: 'alarm', von: 'Geräte', typ: 'error', inhalt: u.text }); if (m) broadcast('message', m); }
    if (liste.some((g) => neu[g.id])) geraete.speichern(geraete.alle().map((g) => (neu[g.id] ? { ...g, zuletzt_offen: new Date().toISOString() } : g)));
    tunnelStand = neu;
  } catch { /* Wächter darf nie den Server stören */ }
}, 120_000).unref();

// ── Hilfen ──────────────────────────────────────────────────────────────────
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(obj)); };
const koerper = (req) => new Promise((resolve) => {
  let buf = ''; req.on('data', (d) => { buf += d; if (buf.length > 2_000_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
});
const cookie = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(String(req.headers.cookie || '')); return m ? decodeURIComponent(m[1]) : ''; };
function auth(req, url) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : (url && url.searchParams.get('token')) || '';
  if (tok && ADMIN && tok.length === ADMIN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN))) return { rolle: 'admin', name: 'admin' };
  const agent = tok ? agentViaToken(db, tok) : null;
  if (agent) return { rolle: 'agent', name: agent.name, agent };
  const nutzer = sitzungNutzer(db, cookie(req, 'fc_session'));
  if (nutzer) return { rolle: 'admin', name: nutzer.name || nutzer.email, nutzer };
  return null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };
const fensterMitZustand = (f) => { let sp = {}; try { sp = JSON.parse(f.spiegel || '{}'); } catch { sp = {}; } const z = konsole.zustand(f.name) || {}; return { ...f, spiegel: undefined, sitzung: sp.sitzung || '', zustand: z, laeuft: !!z.lebt, gestartet_ms: z.gestartetMs || 0, raeumt: aufraeumen.stand(f.name) }; };
const SUPPORT_URL = process.env.FC_SUPPORT_URL || 'https://sales-engine.app/api/flotten-chat-hilfe';
const INSTANZ_FILE = join(DATA, 'instanz-id');
if (!existsSync(INSTANZ_FILE)) writeFileSync(INSTANZ_FILE, crypto.randomBytes(8).toString('hex'), { mode: 0o600 });
const INSTANZ = readFileSync(INSTANZ_FILE, 'utf8').trim();
// Hilfe-Token: erlaubt dem Hersteller NUR, Antworten in den Hilfe-Kanal zu legen (wird mit jeder Anfrage mitgeschickt).
const HILFE_FILE = join(DATA, 'hilfe-token');
if (!existsSync(HILFE_FILE)) writeFileSync(HILFE_FILE, neuerToken('hlp'), { mode: 0o600 });
const HILFE_TOKEN = process.env.FC_SUPPORT_TOKEN || readFileSync(HILFE_FILE, 'utf8').trim();

/** Fenster aus Angaben anlegen (Ordner oder Repo+Worktree), Kanal dazu, optional sofort starten. */
function fensterBauen(b) {
  const name = slug(b.name || b.label || b.thema);
  if (!name) return { ok: false, fehler: 'Name/Thema fehlt.' };
  if (fensterHolen(db, name)) return { ok: false, fehler: `Fenster „${name}" gibt es schon.` };
  let ordner = String(b.ordner || '').trim();
  let worktree = 0;
  let ort = /^ssh:\S+$/.test(String(b.ort || '')) ? String(b.ort) : 'lokal';
  const mG = /^geraet:([a-z0-9-]+)$/.exec(String(b.ort || ''));
  if (mG) {
    const g = geraete.holen(mG[1]);
    if (!g || g.status !== 'gekoppelt') return { ok: false, fehler: 'Gerät unbekannt oder noch nicht gekoppelt.' };
    if (!geraete.tunnelOffen(g)) return { ok: false, fehler: `${g.name} ist gerade nicht erreichbar (Tunnel zu${g.zuletzt_offen ? ', zuletzt offen ' + new Date(g.zuletzt_offen).toLocaleString('de-DE') : ''}). Gerät einschalten/aufwecken.` };
    ort = `geraet:${g.id}`;
    if (!ordner) ordner = `${g.heimordner}/fleet-themen/${name}`;
  }
  if (b.repo && ort === 'lokal') {
    const w = worktreeAnlegen(String(b.repo), name);
    if (!w.ok) return { ok: false, fehler: w.fehler };
    ordner = w.ordner; worktree = 1;
  }
  if (!ordner) ordner = process.env.FC_DEFAULT_ORDNER || process.cwd();
  const f = fensterAnlegen(db, { name, label: b.label || b.thema || name, ort, ordner, config_dir: b.config_dir || (ort === 'lokal' ? process.env.FC_CLAUDE_CONFIG_DIR || '' : ''), start_modus: b.start_modus || 'auto', start_text: b.start_text || '', worktree });
  if (!f) return { ok: false, fehler: 'Fenster konnte nicht angelegt werden.' };
  // Chat-Komfort (1.2): ein neues Fenster startet ohne den Verlauf eines geschlossenen Vorgängers gleichen Namens.
  { const ab = verlaufAbSetzen(db, f.name); if (ab) gelesenSetzen(db, f.name, ab); }
  let start = { ok: false };
  if (b.starten !== false) { start = sessionStarten(f); if (start.ok) fensterAendern(db, f.name, { status: 'laeuft', gestartet_am: nowIso() }); }
  return { ok: true, fenster: fensterHolen(db, f.name), start };
}

// === Aufgaben (1.2) ===
// Aufgaben mit Zeit (server/aufgaben.mjs): ▶ Starten legt über fensterBauen ein Fenster mit dem Auftrag als Start-Text an.
// Der Takt (alle 20 s) misst die Zeit an der Konsole (busy/Dialog) und an den Nachrichten des Menschen, erkennt den
// Fertig-Satz, startet Aufgaben zur Uhrzeit und meldet Fälligkeiten im Kanal „Erinnerungen“. FC_AUFGABEN_ERST_FRAGEN=0
// schaltet die Start-Text-Vorlage „erst Lage + Empfehlung + Rückfrage“ als Standard ab.
const aufgaben = createAufgabenDienst({ db, konsole, fensterBauen, broadcast, zone: ZONE, erstFragen: process.env.FC_AUFGABEN_ERST_FRAGEN !== '0', reminderUebergeben });
setInterval(() => { try { aufgaben.takt(Date.now()); } catch { /* fail-safe */ } }, AUFGABEN_TAKT_S * 1000).unref();
// === /Aufgaben (1.2) ===

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const wer = auth(req, url);

  // Ersteinrichtung + Login (öffentlich, gebremst)
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (nutzerAnzahl(db) > 0) return json(res, 403, { ok: false, fehler: 'Es gibt schon einen Zugang — bitte einloggen.' });
    const b = await koerper(req);
    const u = nutzerAnlegen(db, { email: b.email, passwort: b.passwort, name: b.name });
    if (!u) return json(res, 400, { ok: false, fehler: 'E-Mail prüfen, Passwort mindestens 8 Zeichen.' });
    const tok = sitzungAnlegen(db, u.id);
    return json(res, 200, { ok: true, nutzer: u }, { 'set-cookie': `fc_session=${tok}; HttpOnly; Path=/; Max-Age=7776000; SameSite=Lax` });
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const lim = loginLimiter.check(req.socket?.remoteAddress || 'unbekannt');
    if (!lim.ok) return zuViele(res, lim);
    const b = await koerper(req);
    const u = nutzerPruefen(db, { email: b.email, passwort: b.passwort });
    if (!u) return json(res, 401, { ok: false, fehler: 'E-Mail oder Passwort stimmt nicht.' });
    const tok = sitzungAnlegen(db, u.id);
    return json(res, 200, { ok: true, nutzer: u }, { 'set-cookie': `fc_session=${tok}; HttpOnly; Path=/; Max-Age=7776000; SameSite=Lax` });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') { sitzungLoeschen(db, cookie(req, 'fc_session')); return json(res, 200, { ok: true }, { 'set-cookie': 'fc_session=; HttpOnly; Path=/; Max-Age=0' }); }
  if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, { ok: true, eingerichtet: nutzerAnzahl(db) > 0, wer: wer ? { rolle: wer.rolle, name: wer.name } : null, instanz: INSTANZ });

  // Self-Connect (Agenten, Betriebsart „lokal ohne tmux“): einziger öffentlicher Schreib-Endpunkt.
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    const lim = connectLimiter.check(req.socket?.remoteAddress || 'unbekannt');
    if (!lim.ok) return zuViele(res, lim);
    const b = await koerper(req);
    const erg = connect(db, { invite_token: b.invite_token, name: b.name });
    if (!erg) return json(res, 403, { ok: false, fehler: 'Einladung ungültig oder schon benutzt.' });
    broadcast('presence', { neu: b.name || 'agent', kanal: erg.kanal });
    return json(res, 200, { ok: true, ...erg, anleitung: 'Lausche mit GET /api/messages?kanal=<kanal>&seit=<cursor> (Bearer agent_token) oder per SSE /api/events. Sende mit POST /api/send.' });
  }
  // Alarm-Eingang (Monitore, Cron, andere Systeme): Token im Header, landet im Kanal „alarm“.
  if (url.pathname === '/api/alarm' && req.method === 'POST') {
    const tok = String(req.headers['x-fc-alarm-token'] || url.searchParams.get('token') || '');
    const soll = process.env.FC_ALARM_TOKEN || ADMIN;
    if (!tok || tok.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(soll))) return json(res, 401, { ok: false });
    const b = await koerper(req);
    kanalAnlegen(db, { name: 'alarm', label: '🚨 Alarm' });
    const m = senden(db, { kanal: 'alarm', von: String(b.von || 'Monitor').slice(0, 80), typ: 'error', inhalt: String(b.text || b.inhalt || '').slice(0, 20000) });
    if (!m) return json(res, 400, { ok: false, fehler: 'text fehlt' });
    broadcast('message', m); return json(res, 200, { ok: true, id: m.id });
  }
  // Support-Antwort (vom Hersteller): landet im Hilfe-Kanal.
  if (url.pathname === '/api/hilfe/antwort' && req.method === 'POST') {
    const tok = String(req.headers['x-fc-hilfe-token'] || '');
    const soll = HILFE_TOKEN;
    if (!tok || tok.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(soll))) return json(res, 401, { ok: false });
    const b = await koerper(req);
    const m = senden(db, { kanal: 'hilfe', von: String(b.von || 'Support').slice(0, 80), typ: 'answer', inhalt: String(b.text || '').slice(0, 20000) });
    if (!m) return json(res, 400, { ok: false });
    broadcast('message', m); return json(res, 200, { ok: true, id: m.id });
  }

  // Geräte koppeln (öffentlich, Einmal-Code im Pfad, Fehlversuche gebremst):
  //   GET /geraet/<code> → Einrichtungs-Skript · POST …/anmelden → Schlüssel melden · GET …/status → Tunnel offen?
  const mGeraet = /^\/geraet\/([a-z0-9]{8})(?:\/(anmelden|status))?$/.exec(url.pathname);
  if (mGeraet) {
    const ip = req.socket?.remoteAddress || 'unbekannt';
    const [, code, teil] = mGeraet;
    const text = (code_, t) => { res.writeHead(code_, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(t); };
    const liste = geraete.alle();
    if (teil === 'status' && req.method === 'GET') {
      const g = geraetZumCode(liste, code, new Date(), { nurWartend: false });
      if (!g) { const l = geraetLimiter.check(ip); if (!l.ok) return zuViele(res, l); return json(res, 404, { ok: false }); }
      return json(res, 200, { ok: true, gekoppelt: g.status === 'gekoppelt', offen: geraete.tunnelOffen(g) });
    }
    const g = geraetZumCode(liste, code, new Date());
    if (!g) { const l = geraetLimiter.check(ip); if (!l.ok) return zuViele(res, l); return teil ? json(res, 404, { ok: false, fehler: 'Code ungültig oder abgelaufen.' }) : text(404, 'echo "✗ Code ungültig oder abgelaufen — im Flotten-Chat neu erzeugen."; exit 1\n'); }
    if (!teil && req.method === 'GET') {
      const b = geraete.bereit();
      if (!b.ok) return text(503, `echo ${JSON.stringify('✗ Server noch nicht eingerichtet: ' + b.fehler)}; exit 1\n`);
      const basis = basisUrl(req);
      return text(200, einrichtungsSkript({ code, port: g.port, host: process.env.FC_GERAETE_HOST || new URL(basis).hostname, sshPort: Number(process.env.FC_GERAETE_SSH_PORT || 22), basisUrl: basis, serverPubKey: geraete.serverPubKey(), serverHostKey: geraete.serverHostKey(), name: g.name, tmuxSocket: TMUX_SOCKET, tunnelNutzer: geraete.tunnelNutzer }));
    }
    if (teil === 'anmelden' && req.method === 'POST') {
      const r = geraetAnmelden(g, await formular(req), new Date());
      if (r.fehler) return json(res, 400, { ok: false, fehler: r.fehler });
      geraete.speichern(liste.map((x) => (x.id === g.id ? r.geraet : x)));
      const m = senden(db, { kanal: 'allgemein', von: 'flottenchat', typ: 'system', inhalt: `🔗 Gerät „${g.name}" ist gekoppelt — unter ＋ Fenster → Ort wählbar.` }); if (m) broadcast('message', m);
      broadcast('presence', { geraet: g.id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { ok: false });
  }

  // Medien-Auslieferung OHNE Bearer (Capability-URL, 9 Zufalls-Bytes), mit Range/206.
  const mMediaPub = /^\/api\/media\/([a-z0-9.]+)$/.exec(url.pathname);
  if (mMediaPub && req.method === 'GET') {
    const meta = db.prepare('SELECT * FROM media WHERE id = ?').get(mMediaPub[1]);
    const pfad = join(DATA, 'media', mMediaPub[1]);
    if (!meta || !existsSync(pfad)) return json(res, 404, { ok: false });
    const groesse = statSync(pfad).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    const disp = url.searchParams.get('dl') ? { 'content-disposition': `attachment; filename="${String(meta.name).replace(/"/g, '')}"` } : {};
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const ende = range[2] ? Number(range[2]) : groesse - 1;
      res.writeHead(206, { 'content-type': meta.mime, 'content-range': `bytes ${start}-${ende}/${groesse}`, 'accept-ranges': 'bytes', 'content-length': ende - start + 1, ...disp });
      return createReadStream(pfad, { start, end: ende }).pipe(res);
    }
    res.writeHead(200, { 'content-type': meta.mime, 'content-length': groesse, 'accept-ranges': 'bytes', ...disp });
    return createReadStream(pfad).pipe(res);
  }

  // Alles Weitere unter /api verlangt Zugang (Nutzer-Cookie, Admin- oder Agent-Token).
  if (url.pathname.startsWith('/api/')) {
    if (!wer) return json(res, 401, { ok: false, fehler: 'Nicht eingeloggt.' });
    const admin = wer.rolle === 'admin';

    if (url.pathname === '/api/channels' && req.method === 'GET') {
      return json(res, 200, { ok: true, channels: kanaele(db), fenster: fensterAlle(db).map(fensterMitZustand) });
    }
    if (url.pathname === '/api/channels' && req.method === 'POST') {
      const b = await koerper(req); const k = kanalAnlegen(db, b);
      return k ? json(res, 200, { ok: true, channel: k }) : json(res, 400, { ok: false, fehler: 'Name fehlt.' });
    }
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const angefragt = url.searchParams.get('kanal');
      if (wer.rolle === 'agent' && angefragt && angefragt !== wer.agent.kanal) return json(res, 403, { ok: false, fehler: 'Dieser Token darf nur den eigenen Kanal lesen.' });
      const kanal = angefragt || (wer.agent ? wer.agent.kanal : 'allgemein');
      // Chat-Komfort (1.2): `juengste=1` / `vor=<id>` = Verlauf in Etappen (jüngste zuerst geholt, aufsteigend geliefert);
      // bei Fenstern zählt nur, was nach `verlauf_ab` kam (Vorgänger gleichen Namens bleibt in der DB, aber unsichtbar).
      const ab = verlaufAb(db, kanal);
      const seit = Math.max(Number(url.searchParams.get('seit')) || 0, ab);
      const etappe = url.searchParams.get('juengste') === '1' || Number(url.searchParams.get('vor')) > 0;
      const liste = etappe
        ? nachrichtenEtappe(db, { kanal, limit: url.searchParams.get('limit'), vor: url.searchParams.get('vor'), ab })
        : nachrichten(db, { kanal, seit, limit: url.searchParams.get('limit') || 200 });
      if (wer.agent && liste.length) cursorSetzen(db, wer.agent.id, liste[liste.length - 1].id);
      return json(res, 200, { ok: true, messages: liste });
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const b = await koerper(req);
      if (wer.rolle === 'agent' && b.kanal && b.kanal !== wer.agent.kanal) return json(res, 403, { ok: false, fehler: 'Dieser Token darf nur in den eigenen Kanal senden.' });
      const kanal = b.kanal || (wer.agent ? wer.agent.kanal : '');
      const m = senden(db, { kanal, von: b.von || wer.name, typ: b.typ, inhalt: b.inhalt, bezug_id: b.bezug_id, media: b.media, client_id: clientIdSauber(b.client_id), meta: b.meta || null });
      if (!m) return json(res, 400, { ok: false, fehler: 'kanal und inhalt sind Pflicht.' });
      if (!m.dedup) broadcast('message', m);
      if (!m.dedup) konsole.anstossen(); // 1.2 Spiegel: Nachricht an ein Fenster sofort zustellen, nicht erst im Takt
      // Hilfe-Kanal (v1.0): Nachrichten des Menschen gehen zusätzlich an den Hersteller (Support-Brücke), fail-soft.
      if (!m.dedup && kanal === 'hilfe' && admin && SUPPORT_URL) {
        fetch(SUPPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instanz: INSTANZ, von: m.von, text: m.inhalt, id: m.id, antwort_url: (b.basis || '') + '/api/hilfe/antwort', antwort_token: HILFE_TOKEN }), signal: AbortSignal.timeout(8000) })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); })
          .catch(() => { const h = senden(db, { kanal: 'hilfe', von: 'flottenchat', typ: 'system', inhalt: 'Die Nachricht konnte gerade nicht an den Support übermittelt werden — sie bleibt hier stehen, bitte später nochmal senden.' }); if (h) broadcast('message', h); });
      }
      return json(res, 200, { ok: true, message: m, dedup: !!m.dedup });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res); req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname === '/api/invites' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false, fehler: 'Nur Admin lädt Agenten ein.' });
      const b = await koerper(req);
      const token = inviteAnlegen(db, { kanal: b.kanal || 'allgemein' });
      return json(res, 200, { ok: true, invite_token: token, hinweis: `Gib deinem Agenten: "Verbinde dich mit meinem Flotten Chat: POST ${b.basis || ''}/api/connect mit invite_token=${token}"` });
    }
    if (url.pathname === '/api/presence' && req.method === 'GET') return json(res, 200, { ok: true, agents: presence(db), fenster: fensterAlle(db).map(fensterMitZustand) });
    if (url.pathname === '/api/status' && req.method === 'POST') {
      const b = await koerper(req);
      if (wer.agent) statusSetzen(db, wer.agent.id, b.status);
      else if (admin && b.name) statusSetzenNachName(db, b.name, b.status);
      else return json(res, 403, { ok: false });
      broadcast('presence', { status: b.status }); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const b = await koerper(req); if (!b.name) return json(res, 400, { ok: false, fehler: 'name ist Pflicht.' });
      stopAnfordern(db, b.name); broadcast('presence', { stop: b.name }); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop-pending' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (wer.agent) return json(res, 200, { ok: true, stop: stopHolenUndQuittieren(db, wer.agent.id) });
      if (admin && name) return json(res, 200, { ok: true, stop: stopHolenUndQuittierenNachName(db, name) });
      return json(res, 403, { ok: false });
    }

    // ── Kanäle & Suche (1.1): Einstellungen (Reihenfolge/Namen/Archiv/Stumm, global), Gelesen-Marker, Ungelesen, Suche ──
    // Sichtbare Kanäle für diesen Zugang: Admin = alle nicht archivierten Kanäle + Fenster, Agent = nur der eigene Kanal.
    const sichtbareKanaele = () => (wer.agent ? [wer.agent.kanal] : [...new Set([...kanaele(db).filter((k) => !k.archiviert).map((k) => k.name), ...fensterAlle(db).map((f) => f.name)])]);
    if (url.pathname === '/api/kanal-einstellungen' && req.method === 'GET') return json(res, 200, { ok: true, einstellungen: einstellungenLaden(db) });
    if (url.pathname === '/api/kanal-einstellungen' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false, fehler: 'Nur Admin ändert Kanal-Einstellungen.' });
      const e = einstellungenSpeichern(db, await koerper(req));
      broadcast('presence', { einstellungen: true }); return json(res, 200, { ok: true, einstellungen: e });
    }
    if (url.pathname === '/api/gelesen' && req.method === 'GET') return json(res, 200, { ok: true, gelesen: gelesenLaden(db) });
    if (url.pathname === '/api/gelesen' && req.method === 'POST') {
      const b = await koerper(req);
      if (wer.agent && b.kanal && b.kanal !== wer.agent.kanal) return json(res, 403, { ok: false, fehler: 'Dieser Token darf nur den eigenen Kanal markieren.' });
      const bis = gelesenSetzen(db, b.kanal || (wer.agent ? wer.agent.kanal : ''), b.bis ?? b.bis_id, { force: !!b.force });
      return bis == null ? json(res, 400, { ok: false, fehler: 'kanal und bis (Nachrichten-ID) sind Pflicht.' }) : json(res, 200, { ok: true, kanal: b.kanal, bis });
    }
    if (url.pathname === '/api/unread' && req.method === 'GET') {
      const u = ungelesen(db, { kanaele: sichtbareKanaele(), ich: wer.name });
      return json(res, 200, { ok: true, counts: u.counts, gesamt: u.gesamt, gelesen: u.gelesen, einstellungen: einstellungenLaden(db) });
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const r = sucheNachrichten(db, { q: url.searchParams.get('q') || '', kanaele: sichtbareKanaele(), limit: url.searchParams.get('limit') || 50 });
      // Chat-Komfort (1.2): Treffer aus dem Verlauf eines geschlossenen Vorgängers gleichen Namens fallen weg.
      const grenzen = Object.fromEntries(fensterAlle(db).map((f) => [f.name, Number(f.verlauf_ab) || 0]));
      return json(res, 200, { ok: true, woerter: r.woerter, treffer: nurAktuellerVerlauf(r.treffer, grenzen) });
    }

    // ── Geräte ──
    if (url.pathname === '/api/geraete' && req.method === 'GET') {
      return json(res, 200, { ok: true, bereit: geraete.bereit(), geraete: geraete.alle().map((g) => geraetOeffentlich(g, { tunnelOffen: geraete.tunnelOffen(g) })) });
    }
    if (url.pathname === '/api/geraete' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const b0 = geraete.bereit(); if (!b0.ok) return json(res, 503, { ok: false, fehler: b0.fehler });
      const b = await koerper(req);
      const liste = geraete.alle();
      const r = geraetAnlegen(liste, { name: b.name, zufall: crypto.randomBytes(8), jetzt: new Date(), portsBelegt: [...geraete.lauschendePorts()] });
      if (r.fehler) return json(res, 400, { ok: false, fehler: r.fehler });
      geraete.speichern([...liste, r.geraet]);
      return json(res, 200, { ok: true, geraet: geraetOeffentlich(r.geraet), code: r.geraet.code, block: einfuegeBlock({ code: r.geraet.code, basisUrl: basisUrl(req), name: r.geraet.name }) });
    }
    const mGe = /^\/api\/geraete\/([a-z0-9-]+)\/entfernen$/.exec(url.pathname);
    if (mGe && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const g = geraete.holen(mGe[1]); if (!g) return json(res, 404, { ok: false, fehler: 'Gerät unbekannt.' });
      if (fensterAlle(db).some((f) => f.ort === `geraet:${g.id}`)) return json(res, 409, { ok: false, fehler: 'Auf dem Gerät gibt es noch Fenster — erst schließen.' });
      geraete.speichern(geraete.alle().filter((x) => x.id !== g.id)); // Schlüssel raus → kein neuer Tunnel
      const k = geraete.tunnelKappen(g);
      return json(res, 200, { ok: true, gekappt: k.beendet || 0 });
    }

    // === Aufgaben (1.2) === Routen /api/aufgaben…, Brücke /api/reminders/<id>/(session|aufgabe); Kanal schließen = Aufgabe
    // erledigt, Fenster löschen = Stopp (danach laufen die Fenster-Routen unten wie gehabt weiter).
    if (url.pathname.startsWith('/api/aufgaben') || /^\/api\/reminders\/\d+\/(session|aufgabe)$/.test(url.pathname)) {
      if (await aufgaben.route({ req, res, url, wer, json, koerper })) return;
    }
    const mFA = /^\/api\/fenster\/([a-z0-9_-]+)\/(schliessen|loeschen)$/.exec(url.pathname);
    if (mFA && req.method === 'POST' && admin && fensterHolen(db, mFA[1])) { if (mFA[2] === 'schliessen') aufgaben.fensterGeschlossen(mFA[1]); else aufgaben.fensterGeloescht(mFA[1]); }
    // === /Aufgaben (1.2) ===

    // ── Fenster (v1.0): Registry + Steuerung ──
    if (url.pathname === '/api/fenster' && req.method === 'GET') return json(res, 200, { ok: true, fenster: fensterAlle(db).map(fensterMitZustand) });
    if (url.pathname === '/api/fenster' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const r = fensterBauen(await koerper(req));
      if (r.ok) broadcast('presence', { fenster: r.fenster.name, neu: true });
      return json(res, r.ok ? 200 : 400, r);
    }
    // Live-Terminal: das echte Terminalbild mit Farben (nur lesen) + Tastenleiste mit fester Tastenliste —
    // nie Text oder Befehle vom Client. Nur für Admins (wer Fenster steuern darf).
    const mT = /^\/api\/fenster\/([a-z0-9_-]+)\/(terminal|tasten)$/.exec(url.pathname);
    if (mT) {
      if (!admin) return json(res, 403, { ok: false });
      const f = fensterHolen(db, mT[1]);
      if (!f) return json(res, 404, { ok: false, fehler: 'Fenster unbekannt.' });
      if (mT[2] === 'terminal' && req.method === 'GET') { const lebt = !!prozessVon(f).lebt; return json(res, 200, { ok: true, lebt, html: lebt ? ansiZuHtml(paneFarbigLesen(f)) : '' }); }
      if (mT[2] === 'tasten' && req.method === 'POST') {
        const b = await koerper(req);
        const tasten = (Array.isArray(b.tasten) ? b.tasten : []).map(String).filter((t) => TERMINAL_TASTEN.includes(t)).slice(0, 10);
        if (!tasten.length) return json(res, 400, { ok: false, fehler: 'Keine erlaubte Taste.' });
        const r = tastenSenden(f, tasten); return json(res, r.ok ? 200 : 400, r);
      }
    }
    // === Chat-Komfort (1.2): Schwarm-Leiste — laufende Claude-Code-Workflows des Fensters (nur lokale Fenster) ===
    const mSw = /^\/api\/fenster\/([a-z0-9_-]+)\/schwarm$/.exec(url.pathname);
    if (mSw && req.method === 'GET') {
      if (!admin) return json(res, 403, { ok: false });
      const f = fensterHolen(db, mSw[1]);
      if (!f) return json(res, 404, { ok: false, fehler: 'Fenster unbekannt.' });
      let schwarm = [];
      if (!istSsh(f)) { try { schwarm = schwarmFuerOrdner(protokollDir(f)); } catch { /* ohne Leiste */ } }
      return json(res, 200, { ok: true, schwarm });
    }
    // === Ende Chat-Komfort (1.2) ===
    const mF = /^\/api\/fenster\/([a-z0-9_-]+)\/(start|neustart|stop|schliessen|loeschen|pane|tippen)$/.exec(url.pathname);
    if (mF && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const f = fensterHolen(db, mF[1]);
      if (!f) return json(res, 404, { ok: false, fehler: 'Fenster unbekannt.' });
      const b = await koerper(req);
      if (mF[2] === 'start') { const r = sessionStarten(f); if (r.ok) fensterAendern(db, f.name, { status: 'laeuft' }); return json(res, r.ok ? 200 : 400, r); }
      if (mF[2] === 'neustart') { const { fertig, ...r } = aufraeumen.starten(f, 'neustart'); return json(res, r.ok ? 200 : 400, r); } // 1.2: erst aufräumen
      if (mF[2] === 'stop') { const r = sessionBeenden(f); fensterAendern(db, f.name, { status: 'aus' }); broadcast('presence', { fenster: f.name, status: 'aus' }); return json(res, 200, r); }
      if (mF[2] === 'tippen') { const r = textSenden(f, String(b.text || '')); return json(res, r.ok ? 200 : 400, r); }
      if (mF[2] === 'pane') return json(res, 200, { ok: true, pane: paneLesen(f), prozess: prozessVon(f) });
      // 1.2: Schließen und Löschen über denselben Aufräum-Ablauf (Stand wegschreiben → „aufgeräumt“ → Aktion, max. 2 Min).
      if (mF[2] === 'schliessen' || mF[2] === 'loeschen') {
        if (mF[2] === 'schliessen') fensterAendern(db, f.name, { status: 'schliesst' });
        const { fertig, ...r } = aufraeumen.starten(f, mF[2], { sofort: !!b.sofort });
        return json(res, r.ok ? 200 : 400, { ...r, laeuft: r.ok && !r.sofort });
      }
    }
    // Verwaiste Worktrees eines Repos (Kehrdienst): Liste + Aufräumen per Klick (nur saubere).
    if (url.pathname === '/api/worktrees' && req.method === 'GET') {
      const repo = url.searchParams.get('repo') || process.env.FC_DEFAULT_REPO || '';
      if (!repo) return json(res, 200, { ok: true, verwaist: [] });
      return json(res, 200, { ok: true, repo, verwaist: worktreesVerwaist(repo, fensterAlle(db).map((f) => f.ordner)) });
    }
    if (url.pathname === '/api/worktrees/entfernen' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const b = await koerper(req);
      if (!b.repo || !b.ordner || !String(b.ordner).startsWith(join(String(b.repo), 'worktrees'))) return json(res, 400, { ok: false, fehler: 'repo und ordner (unter repo/worktrees) sind Pflicht.' });
      if (fensterAlle(db).some((f) => f.ordner === b.ordner && f.status !== 'aus')) return json(res, 409, { ok: false, fehler: 'Ein laufendes Fenster besitzt diesen Worktree.' });
      return json(res, 200, worktreeEntfernen(String(b.repo), String(b.ordner)));
    }

    // ── Themen-Board (v1.0): Karten. Die KI legt Karten nur auf Zuruf an — der Mensch entscheidet. ──
    if (url.pathname === '/api/karten' && req.method === 'GET') return json(res, 200, { ok: true, karten: karten(db), spalten: SPALTEN });
    if (url.pathname === '/api/karten' && req.method === 'POST') {
      const b = await koerper(req); const k = karteAnlegen(db, b);
      if (!k) return json(res, 400, { ok: false, fehler: 'titel fehlt' });
      broadcast('karte', k); return json(res, 200, { ok: true, karte: k });
    }
    const mK = /^\/api\/karten\/(\d+)(?:\/(verlauf|loeschen))?$/.exec(url.pathname);
    if (mK && req.method === 'POST') {
      const b = await koerper(req);
      const k0 = karteHolen(db, mK[1]); if (!k0) return json(res, 404, { ok: false, fehler: 'Karte unbekannt.' });
      if (!mK[2]) { const k = karteAendern(db, mK[1], b); broadcast('karte', k); return json(res, 200, { ok: true, karte: k }); }
      if (mK[2] === 'verlauf') { const k = karteVerlauf(db, mK[1], { von: b.von || wer.name, text: b.text, media: b.media || null }); if (!k) return json(res, 400, { ok: false, fehler: 'text fehlt' }); broadcast('karte', k); return json(res, 200, { ok: true, karte: k }); }
      if (mK[2] === 'loeschen') { if (!admin) return json(res, 403, { ok: false }); karteLoeschen(db, mK[1]); broadcast('karte', { id: Number(mK[1]), geloescht: true }); return json(res, 200, { ok: true }); }
    }

    // ── Erinnerungen ──
    if (url.pathname === '/api/reminders' && req.method === 'GET') return json(res, 200, { ok: true, reminders: reminders(db, { status: url.searchParams.get('status') }) });
    if (url.pathname === '/api/reminders' && req.method === 'POST') {
      const b = await koerper(req);
      const r = reminderAnlegen(db, { ...b, kanal: b.kanal || (wer.agent ? wer.agent.kanal : 'erinnerungen') });
      return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 400, { ok: false, fehler: 'kanal und titel sind Pflicht.' });
    }
    const mErl = /^\/api\/reminders\/(\d+)\/erledigt$/.exec(url.pathname);
    if (mErl && req.method === 'POST') return json(res, 200, { ok: true, reminder: reminderErledigt(db, mErl[1]) });
    const mVer = /^\/api\/reminders\/(\d+)\/verschieben$/.exec(url.pathname);
    if (mVer && req.method === 'POST') { const b = await koerper(req); const r = reminderVerschieben(db, mVer[1], b.faellig_am); return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 400, { ok: false, fehler: 'faellig_am ist Pflicht.' }); }
    // Erinnerung → Fenster: seit 1.2 wird daraus eine Aufgabe mit Zeitmessung (Route im Block „Aufgaben (1.2)“ oben,
    // Antwort wie bisher {ok, fenster, start} + aufgabe).

    // ── 1.1: Ablage-Tresor 🔗 — ablegen (Chat-Medium → data/ablage mit sprechendem Namen), Liste, Löschen, Ausliefern (Range) ──
    if (url.pathname === '/api/ablage' && req.method === 'GET') return json(res, 200, ablageListe({ ablageDir: ABLAGE_DIR, max: Math.min(Number(url.searchParams.get('limit')) || 200, 1000) }));
    if (url.pathname === '/api/ablage' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const b = await koerper(req);
      const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter(Boolean).map(String).slice(0, 20);
      const medien = ids.map((id) => db.prepare('SELECT id, name, mime FROM media WHERE id = ?').get(id)).filter(Boolean);
      const r = ablageAblegen(medien, { jetzt: Date.now(), medienDir: join(DATA, 'media'), ablageDir: ABLAGE_DIR, zone: ZONE });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (url.pathname === '/api/ablage/loeschen' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const b = await koerper(req); const r = ablageLoeschen(String(b.name || ''), { ablageDir: ABLAGE_DIR });
      return json(res, r.ok ? 200 : 400, r);
    }
    const mAb = /^\/api\/ablage\/([^/]+)$/.exec(url.pathname);
    if (mAb && req.method === 'GET') return ablageStreamen(req, res, decodeURIComponent(mAb[1]), { ablageDir: ABLAGE_DIR, download: !!url.searchParams.get('dl') });

    // ── 1.1: Erinnerungen — Ordner (anlegen/umbenennen/löschen), in Ordner legen, Titel/Notiz, an ein laufendes Fenster übergeben ──
    if (url.pathname === '/api/reminders/ordner' && req.method === 'GET') return json(res, 200, { ok: true, ordner: ordnerAlle(db) });
    if (url.pathname === '/api/reminders/ordner' && req.method === 'POST') { const o = ordnerAnlegen(db, await koerper(req)); return o ? json(res, 200, { ok: true, ordner: o }) : json(res, 400, { ok: false, fehler: 'Name fehlt.' }); }
    const mOrd = /^\/api\/reminders\/ordner\/(\d+)\/(umbenennen|loeschen)$/.exec(url.pathname);
    if (mOrd && req.method === 'POST') {
      const b = await koerper(req);
      if (mOrd[2] === 'umbenennen') { const o = ordnerUmbenennen(db, mOrd[1], b.name); return o ? json(res, 200, { ok: true, ordner: o }) : json(res, 400, { ok: false, fehler: 'Ordner unbekannt oder Name fehlt.' }); }
      const r = ordnerLoeschen(db, mOrd[1]); return json(res, r.ok ? 200 : 404, r);
    }
    const mRem = /^\/api\/reminders\/(\d+)\/(ordner|titel|notiz|uebergeben)$/.exec(url.pathname);
    if (mRem && req.method === 'POST') {
      const b = await koerper(req);
      if (mRem[2] === 'ordner') { const r = reminderInOrdner(db, mRem[1], b.ordner_id); return json(res, r.ok ? 200 : 400, r); }
      if (mRem[2] === 'titel') { const r = reminderTitel(db, mRem[1], b.titel); return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 400, { ok: false, fehler: 'titel fehlt oder Erinnerung unbekannt.' }); }
      if (mRem[2] === 'notiz') { const r = reminderNotiz(db, mRem[1], b.notiz); return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 404, { ok: false, fehler: 'Erinnerung unbekannt.' }); }
      // Übergeben: der Auftrag geht als Chat-Nachricht in den Kanal des Fensters — die Konsole tippt ihn ins Terminal.
      if (!admin) return json(res, 403, { ok: false });
      const r0 = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(mRem[1])); if (!r0) return json(res, 404, { ok: false, fehler: 'Erinnerung unbekannt.' });
      const f = fensterHolen(db, b.fenster); if (!f) return json(res, 404, { ok: false, fehler: 'Fenster unbekannt.' });
      if (!prozessVon(f).lebt) return json(res, 409, { ok: false, fehler: 'Das Fenster läuft gerade nicht — erst starten.' });
      const m = senden(db, { kanal: f.name, von: wer.name, typ: 'task', inhalt: uebergabeText(r0, { zeitText: (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: ZONE }) }) }); if (m) broadcast('message', m);
      const r = reminderUebergeben(db, r0.id, f.name);
      const h = senden(db, { kanal: 'erinnerungen', von: 'flottenchat', typ: 'system', inhalt: `📌 „${r0.titel}“ an Fenster „${f.label || f.name}“ übergeben.` }); if (h) broadcast('message', h);
      return json(res, 200, { ok: true, reminder: r, message: m });
    }

    // ── Medien-Upload ──
    if (url.pathname === '/api/media' && req.method === 'POST') {
      const lim = mediaLimiter.check(wer.rolle + ':' + (wer.agent ? wer.agent.id : wer.name));
      if (!lim.ok) return zuViele(res, lim);
      if (!groesseErlaubt(req.headers['content-length'], MEDIA_MAX)) return json(res, 413, { ok: false, fehler: `Datei zu groß (max. ${Math.round(MEDIA_MAX / 1048576)} MB).` });
      let name = String(req.headers['x-fc-name'] || '');
      try { name = decodeURIComponent(name); } catch { /* roh lassen */ }
      const id = crypto.randomBytes(9).toString('hex') + extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      const ziel = join(DATA, 'media', id);
      const out = createWriteStream(ziel, { mode: 0o600 });
      let bytes = 0, abgebrochen = false;
      req.on('data', (d) => {
        bytes += d.length;
        if (bytes > MEDIA_MAX && !abgebrochen) { abgebrochen = true; req.unpipe(out); out.destroy(); try { unlinkSync(ziel); } catch { /* weg */ } json(res, 413, { ok: false, fehler: `Datei zu groß (max. ${Math.round(MEDIA_MAX / 1048576)} MB).` }); req.destroy(); }
      });
      req.pipe(out);
      out.on('finish', () => {
        if (abgebrochen) return;
        db.prepare('INSERT INTO media (id, name, mime, groesse, erstellt_am) VALUES (?, ?, ?, ?, ?)')
          .run(id, (name || id).slice(0, 200), String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100), statSync(ziel).size, nowIso());
        json(res, 200, { ok: true, id, url: '/api/media/' + id });
      });
      out.on('error', () => { if (!abgebrochen) json(res, 500, { ok: false }); });
      return;
    }
    return json(res, 404, { ok: false, fehler: 'Unbekannter Endpunkt.' });
  }

  // Web-UI (statisch; die API selbst ist geschützt).
  const datei = url.pathname === '/' ? '/index.html' : url.pathname;
  const pfad = join(ROOT, 'ui', datei.replace(/\.\./g, ''));
  if (existsSync(pfad) && statSync(pfad).isFile()) {
    res.writeHead(200, { 'content-type': MIME[extname(pfad)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return createReadStream(pfad).pipe(res);
  }
  res.writeHead(404); res.end('nicht gefunden');
});

const HOST = process.env.FC_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n⚡ Sales Engine Flotten Chat 1.0 läuft: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? '  ⚠ gebunden an 0.0.0.0 — nur hinter TLS-Proxy/Firewall betreiben!' : ''}`);
  console.log(`   Datenverzeichnis: ${DATA}`);
  console.log(`   ${nutzerAnzahl(db) ? 'Login: E-Mail + Passwort im Browser.' : 'Ersteinrichtung: im Browser öffnen und den ersten Zugang anlegen.'}`);
  console.log(`   Admin-Token (nur für Skripte/Agenten, geheim halten): ${ADMIN}\n`);
});
export default server;

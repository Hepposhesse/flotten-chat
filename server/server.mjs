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
import { sessionStarten, sessionNeustart, sessionBeenden, prozessVon, paneLesen, textSenden, worktreeAnlegen, worktreeSichern, worktreeEntfernen, worktreeSauber, worktreesVerwaist, repoWurzel, istSsh } from './orte.mjs';
import { slug } from './protokoll.mjs';

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
const fensterMitZustand = (f) => { let sp = {}; try { sp = JSON.parse(f.spiegel || '{}'); } catch { sp = {}; } const z = konsole.zustand(f.name) || {}; return { ...f, spiegel: undefined, sitzung: sp.sitzung || '', zustand: z, laeuft: !!z.lebt, gestartet_ms: z.gestartetMs || 0 }; };
const SUPPORT_URL = process.env.FC_SUPPORT_URL || 'https://sales-engine.app/api/flotten-chat-hilfe';
const INSTANZ_FILE = join(DATA, 'instanz-id');
if (!existsSync(INSTANZ_FILE)) writeFileSync(INSTANZ_FILE, crypto.randomBytes(8).toString('hex'), { mode: 0o600 });
const INSTANZ = readFileSync(INSTANZ_FILE, 'utf8').trim();

/** Fenster aus Angaben anlegen (Ordner oder Repo+Worktree), Kanal dazu, optional sofort starten. */
function fensterBauen(b) {
  const name = slug(b.name || b.label || b.thema);
  if (!name) return { ok: false, fehler: 'Name/Thema fehlt.' };
  if (fensterHolen(db, name)) return { ok: false, fehler: `Fenster „${name}" gibt es schon.` };
  let ordner = String(b.ordner || '').trim();
  let worktree = 0;
  const ort = /^ssh:\S+$/.test(String(b.ort || '')) ? String(b.ort) : 'lokal';
  if (b.repo && ort === 'lokal') {
    const w = worktreeAnlegen(String(b.repo), name);
    if (!w.ok) return { ok: false, fehler: w.fehler };
    ordner = w.ordner; worktree = 1;
  }
  if (!ordner) ordner = process.env.FC_DEFAULT_ORDNER || process.cwd();
  const f = fensterAnlegen(db, { name, label: b.label || b.thema || name, ort, ordner, config_dir: b.config_dir || process.env.FC_CLAUDE_CONFIG_DIR || '', start_modus: b.start_modus || 'auto', start_text: b.start_text || '', karte_id: b.karte_id || null, worktree });
  if (!f) return { ok: false, fehler: 'Fenster konnte nicht angelegt werden.' };
  if (f.karte_id) karteAendern(db, f.karte_id, { fenster: f.name, spalte: 'in_arbeit' });
  let start = { ok: false };
  if (b.starten !== false) { start = sessionStarten(f); if (start.ok) fensterAendern(db, f.name, { status: 'laeuft', gestartet_am: nowIso() }); }
  return { ok: true, fenster: fensterHolen(db, f.name), start };
}

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
    const soll = process.env.FC_SUPPORT_TOKEN || ADMIN;
    if (!tok || tok.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(soll))) return json(res, 401, { ok: false });
    const b = await koerper(req);
    const m = senden(db, { kanal: 'hilfe', von: String(b.von || 'Support').slice(0, 80), typ: 'answer', inhalt: String(b.text || '').slice(0, 20000) });
    if (!m) return json(res, 400, { ok: false });
    broadcast('message', m); return json(res, 200, { ok: true, id: m.id });
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
      const seit = url.searchParams.get('seit') || 0;
      const liste = nachrichten(db, { kanal, seit, limit: url.searchParams.get('limit') || 200 });
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
      // Hilfe-Kanal (v1.0): Nachrichten des Menschen gehen zusätzlich an den Hersteller (Support-Brücke), fail-soft.
      if (!m.dedup && kanal === 'hilfe' && admin && SUPPORT_URL) {
        fetch(SUPPORT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instanz: INSTANZ, von: m.von, text: m.inhalt, id: m.id, antwort_url: (b.basis || '') + '/api/hilfe/antwort', antwort_token: process.env.FC_SUPPORT_TOKEN || '' }), signal: AbortSignal.timeout(8000) })
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

    // ── Fenster (v1.0): Registry + Steuerung ──
    if (url.pathname === '/api/fenster' && req.method === 'GET') return json(res, 200, { ok: true, fenster: fensterAlle(db).map(fensterMitZustand) });
    if (url.pathname === '/api/fenster' && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const r = fensterBauen(await koerper(req));
      if (r.ok) broadcast('presence', { fenster: r.fenster.name, neu: true });
      return json(res, r.ok ? 200 : 400, r);
    }
    const mF = /^\/api\/fenster\/([a-z0-9_-]+)\/(start|neustart|stop|schliessen|loeschen|pane|tippen|karte)$/.exec(url.pathname);
    if (mF && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const f = fensterHolen(db, mF[1]);
      if (!f) return json(res, 404, { ok: false, fehler: 'Fenster unbekannt.' });
      const b = await koerper(req);
      if (mF[2] === 'start') { const r = sessionStarten(f); if (r.ok) fensterAendern(db, f.name, { status: 'laeuft' }); return json(res, r.ok ? 200 : 400, r); }
      if (mF[2] === 'neustart') { const r = sessionNeustart(f); fensterAendern(db, f.name, { spiegel: {} }); return json(res, r.ok ? 200 : 400, r); }
      if (mF[2] === 'stop') { const r = sessionBeenden(f); fensterAendern(db, f.name, { status: 'aus' }); broadcast('presence', { fenster: f.name, status: 'aus' }); return json(res, 200, r); }
      if (mF[2] === 'tippen') { const r = textSenden(f, String(b.text || '')); return json(res, r.ok ? 200 : 400, r); }
      if (mF[2] === 'pane') return json(res, 200, { ok: true, pane: paneLesen(f), prozess: prozessVon(f) });
      if (mF[2] === 'karte') { fensterAendern(db, f.name, { karte_id: b.karte_id || null }); if (b.karte_id) karteAendern(db, b.karte_id, { fenster: f.name }); return json(res, 200, { ok: true }); }
      if (mF[2] === 'schliessen') {
        // Schließ-Ritual: Stand wegschreiben lassen → Ungesichertes als WIP sichern → Session beenden → Worktree weg, wenn sauber.
        const sofort = !!b.sofort;
        fensterAendern(db, f.name, { status: 'schliesst' });
        const m = senden(db, { kanal: f.name, von: 'flottenchat', typ: 'system', inhalt: `🧹 Fenster wird geschlossen${sofort ? ' (sofort)' : ' — es bekommt 60 s, um seinen Stand wegzuschreiben'}.` }); if (m) broadcast('message', m);
        (async () => {
          if (!sofort && prozessVon(f).lebt) {
            textSenden(f, 'Das Fenster wird in 60 Sekunden geschlossen: schreib jetzt deinen Stand an die feste Stelle (Karte/Verlauf), committe alles auf deinen Branch und antworte mit einem Satz „aufgeräumt".');
            await new Promise((r) => setTimeout(r, 60_000));
          }
          const hinweis = [];
          if (f.worktree && !istSsh(f)) { const s = worktreeSichern(f.ordner); if (!s.ok) hinweis.push('Sichern scheiterte: ' + s.fehler); }
          sessionBeenden(f);
          if (f.worktree && !istSsh(f)) {
            const repo = repoWurzel(f.ordner) || dirname(dirname(f.ordner));
            const w = worktreeSauber(f.ordner) ? worktreeEntfernen(repo, f.ordner) : { ok: false, fehler: 'ungesichert' };
            hinweis.push(w.ok ? `Worktree entfernt, Branch fc/${f.name} bleibt.` : `Worktree bleibt liegen (${w.fehler}).`);
          }
          fensterAendern(db, f.name, { status: 'aus' });
          if (f.karte_id) { const k = karteHolen(db, f.karte_id); if (k && k.spalte !== 'erledigt') { karteAendern(db, f.karte_id, { spalte: 'pruefen' }); karteVerlauf(db, f.karte_id, { von: 'flottenchat', text: `Fenster „${f.label}" geschlossen — bitte prüfen, ob das Thema fertig ist.` }); } }
          const e = senden(db, { kanal: f.name, von: 'flottenchat', typ: 'system', inhalt: `✅ Fenster geschlossen. ${hinweis.join(' ')}`.trim() }); if (e) broadcast('message', e);
          broadcast('presence', { fenster: f.name, status: 'aus' });
        })();
        return json(res, 200, { ok: true, laeuft: !sofort });
      }
      if (mF[2] === 'loeschen') { sessionBeenden(f); fensterLoeschen(db, f.name); broadcast('presence', { fenster: f.name, geloescht: true }); return json(res, 200, { ok: true }); }
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
    const mK = /^\/api\/karten\/(\d+)(?:\/(verlauf|session|loeschen))?$/.exec(url.pathname);
    if (mK && req.method === 'POST') {
      const b = await koerper(req);
      const k0 = karteHolen(db, mK[1]); if (!k0) return json(res, 404, { ok: false, fehler: 'Karte unbekannt.' });
      if (!mK[2]) { const k = karteAendern(db, mK[1], b); broadcast('karte', k); return json(res, 200, { ok: true, karte: k }); }
      if (mK[2] === 'verlauf') { const k = karteVerlauf(db, mK[1], { von: b.von || wer.name, text: b.text, media: b.media || null }); if (!k) return json(res, 400, { ok: false, fehler: 'text fehlt' }); broadcast('karte', k); return json(res, 200, { ok: true, karte: k }); }
      if (mK[2] === 'loeschen') { if (!admin) return json(res, 403, { ok: false }); karteLoeschen(db, mK[1]); broadcast('karte', { id: Number(mK[1]), geloescht: true }); return json(res, 200, { ok: true }); }
      if (mK[2] === 'session') {
        // Karte → Fenster: jedes Mal ein NEUES Fenster (Kanal) zum Thema; Name aus Titel + Zähler.
        if (!admin) return json(res, 403, { ok: false });
        const basis = slug(k0.titel).slice(0, 28);
        let name = basis, n = 2; while (fensterHolen(db, name)) name = `${basis}-${n++}`;
        const r = fensterBauen({ ...b, name, label: k0.titel, karte_id: k0.id, start_text: b.start_text || `Thema aus dem Board: „${k0.titel}". ${k0.beschreibung ? 'Beschreibung: ' + k0.beschreibung.slice(0, 1500) : ''} Lies zuerst die CLAUDE.md, dann leg los; Stand kommt als Verlaufs-Eintrag auf die Karte.` });
        if (r.ok) { karteVerlauf(db, k0.id, { von: wer.name, text: `Fenster „${r.fenster.label}" (#${r.fenster.name}) gestartet.` }); broadcast('presence', { fenster: r.fenster.name, neu: true }); }
        return json(res, r.ok ? 200 : 400, r);
      }
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
    // Erinnerung → Fenster (v1.0): Klick startet eine Session mit der Erinnerung als Thema.
    const mRS = /^\/api\/reminders\/(\d+)\/session$/.exec(url.pathname);
    if (mRS && req.method === 'POST') {
      if (!admin) return json(res, 403, { ok: false });
      const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(mRS[1])); if (!r) return json(res, 404, { ok: false });
      const b = await koerper(req);
      const basis = slug(r.titel).slice(0, 28); let name = basis, n = 2; while (fensterHolen(db, name)) name = `${basis}-${n++}`;
      const erg = fensterBauen({ ...b, name, label: r.titel, start_text: `Erinnerung aus dem Flotten-Chat: „${r.titel}"${r.notiz ? ' — ' + r.notiz : ''}. Lies zuerst die CLAUDE.md, dann kümmere dich darum.` });
      if (erg.ok) broadcast('presence', { fenster: erg.fenster.name, neu: true });
      return json(res, erg.ok ? 200 : 400, erg);
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

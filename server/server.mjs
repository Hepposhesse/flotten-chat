// server/server.mjs — Sales Engine Flotten Chat (Community-Edition).
// Ein Node-Server ohne Framework: HTTP-API + SSE + Web-UI + Reminder-Timer.
// Start: `flottenchat up` (bin/) oder `node server/server.mjs`.
// Auth: Admin-Token (data/admin-token, beim ersten Start erzeugt + in der Konsole gezeigt)
//       für Menschen/UI; Agenten-Tokens via Self-Connect (/api/connect mit Einladungs-Token).
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
} from './db.mjs';
import { createLimiter, groesseErlaubt, clientIdSauber } from './limits.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.FC_DATA_DIR || join(process.cwd(), 'data');
const PORT = Number(process.env.FC_PORT || 3900);
const db = openDb(DATA);

// Admin-Token: einmal erzeugen, Datei 0600, beim Start anzeigen.
const ADMIN_FILE = join(DATA, 'admin-token');
if (!existsSync(ADMIN_FILE)) writeFileSync(ADMIN_FILE, neuerToken('adm'), { mode: 0o600 });
const ADMIN = readFileSync(ADMIN_FILE, 'utf8').trim();

// v0.4.0-Härtung: Limits für die zwei teuren/öffentlichen Wege. Einstellbar per Env, Defaults großzügig:
//   FC_CONNECT_LIMIT   Connect-Versuche je IP und Minute (Default 10) — bremst Token-Raten auf /api/connect
//   FC_MEDIA_LIMIT     Uploads je Token und Minute (Default 30)
//   FC_MEDIA_MAX_MB    maximale Upload-Größe in MB (Default 200) → 413 statt volle Platte
const connectLimiter = createLimiter({ limit: Number(process.env.FC_CONNECT_LIMIT || 10), windowMs: 60_000 });
const mediaLimiter = createLimiter({ limit: Number(process.env.FC_MEDIA_LIMIT || 30), windowMs: 60_000 });
const MEDIA_MAX = Number(process.env.FC_MEDIA_MAX_MB || 200) * 1024 * 1024;
const zuViele = (res, r) => { res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(r.retryAfterS) }); res.end(JSON.stringify({ ok: false, fehler: `Zu viele Anfragen — bitte in ${r.retryAfterS} s nochmal.` })); };

// Standard-Kanal, damit der erste Start nicht leer ist.
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

// ── Hilfen ──────────────────────────────────────────────────────────────────
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const koerper = (req) => new Promise((resolve) => {
  let buf = ''; req.on('data', (d) => { buf += d; if (buf.length > 2_000_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
});
function auth(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (tok && ADMIN && tok.length === ADMIN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN))) return { rolle: 'admin', name: 'admin' };
  const agent = agentViaToken(db, tok);
  if (agent) return { rolle: 'agent', name: agent.name, agent };
  return null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const wer = auth(req);

  // Self-Connect: der EINZIGE öffentliche Schreib-Endpunkt (Einmal-Einladungs-Token als Schutz).
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    const lim = connectLimiter.check(req.socket?.remoteAddress || 'unbekannt');
    if (!lim.ok) return zuViele(res, lim);
    const b = await koerper(req);
    const erg = connect(db, { invite_token: b.invite_token, name: b.name });
    if (!erg) return json(res, 403, { ok: false, fehler: 'Einladung ungültig oder schon benutzt.' });
    broadcast('presence', { neu: b.name || 'agent', kanal: erg.kanal });
    return json(res, 200, { ok: true, ...erg, anleitung: 'Lausche mit GET /api/messages?kanal=<kanal>&seit=<cursor> (Bearer agent_token) oder per SSE /api/events. Sende mit POST /api/send.' });
  }

  // Medien-Auslieferung OHNE Bearer (Capability-URL): <img>/<audio> im Browser können keine
  // Auth-Header setzen; die ID ist 9 Zufalls-Bytes = unratbar. Upload bleibt token-pflichtig.
  const mMediaPub = /^\/api\/media\/([a-z0-9.]+)$/.exec(url.pathname);
  if (mMediaPub && req.method === 'GET') {
    const meta = db.prepare('SELECT * FROM media WHERE id = ?').get(mMediaPub[1]);
    const pfad = join(DATA, 'media', mMediaPub[1]);
    if (!meta || !existsSync(pfad)) return json(res, 404, { ok: false });
    const groesse = statSync(pfad).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) { // Range/206 — sonst schwarzer Player bei Voice/Video (Fleet-Lektion)
      const start = range[1] ? Number(range[1]) : 0;
      const ende = range[2] ? Number(range[2]) : groesse - 1;
      res.writeHead(206, { 'content-type': meta.mime, 'content-range': `bytes ${start}-${ende}/${groesse}`, 'accept-ranges': 'bytes', 'content-length': ende - start + 1 });
      return createReadStream(pfad, { start, end: ende }).pipe(res);
    }
    res.writeHead(200, { 'content-type': meta.mime, 'content-length': groesse, 'accept-ranges': 'bytes' });
    return createReadStream(pfad).pipe(res);
  }

  // Alles Weitere unter /api verlangt Token (Admin oder Agent).
  if (url.pathname.startsWith('/api/')) {
    if (!wer) return json(res, 401, { ok: false, fehler: 'Token fehlt oder ungültig (Bearer).' });

    if (url.pathname === '/api/channels' && req.method === 'GET') return json(res, 200, { ok: true, channels: kanaele(db) });
    if (url.pathname === '/api/channels' && req.method === 'POST') {
      const b = await koerper(req); const k = kanalAnlegen(db, b);
      return k ? json(res, 200, { ok: true, channel: k }) : json(res, 400, { ok: false, fehler: 'Name fehlt.' });
    }
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const angefragt = url.searchParams.get('kanal');
      // v0.3.0-Härtung (Least Privilege): ein Agent-Token darf nur den eigenen (eingeladenen) Kanal lesen; Admin darf alles.
      if (wer.rolle === 'agent' && angefragt && angefragt !== wer.agent.kanal) return json(res, 403, { ok: false, fehler: 'Dieser Token darf nur den eigenen Kanal lesen.' });
      const kanal = angefragt || (wer.agent ? wer.agent.kanal : 'allgemein');
      const seit = url.searchParams.get('seit') || 0;
      const liste = nachrichten(db, { kanal, seit, limit: url.searchParams.get('limit') || 200 });
      if (wer.agent && liste.length) cursorSetzen(db, wer.agent.id, liste[liste.length - 1].id);
      return json(res, 200, { ok: true, messages: liste });
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const b = await koerper(req);
      // v0.3.0-Härtung (Least Privilege): ein Agent-Token darf nur in den eigenen Kanal senden; Admin darf alles.
      if (wer.rolle === 'agent' && b.kanal && b.kanal !== wer.agent.kanal) return json(res, 403, { ok: false, fehler: 'Dieser Token darf nur in den eigenen Kanal senden.' });
      // v0.4.0: client_id (vom Sender erzeugt) macht das Senden idempotent — Wiederholung nach
      // Netzfehler liefert dieselbe Nachricht zurück (dedup: true) statt einer Dublette.
      const m = senden(db, { kanal: b.kanal || (wer.agent ? wer.agent.kanal : ''), von: b.von || wer.name, typ: b.typ, inhalt: b.inhalt, bezug_id: b.bezug_id, media: b.media, client_id: clientIdSauber(b.client_id) });
      if (!m) return json(res, 400, { ok: false, fehler: 'kanal und inhalt sind Pflicht.' });
      if (!m.dedup) broadcast('message', m);
      return json(res, 200, { ok: true, message: m, dedup: !!m.dedup });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res); req.on('close', () => sseClients.delete(res));
      return; // Verbindung bleibt offen
    }
    if (url.pathname === '/api/invites' && req.method === 'POST') {
      if (wer.rolle !== 'admin') return json(res, 403, { ok: false, fehler: 'Nur Admin lädt Agenten ein.' });
      const b = await koerper(req);
      const token = inviteAnlegen(db, { kanal: b.kanal || 'allgemein' });
      return json(res, 200, { ok: true, invite_token: token, hinweis: `Gib deinem Agenten: "Verbinde dich mit meinem Flotten Chat: POST ${b.basis || ''}/api/connect mit invite_token=${token}"` });
    }
    if (url.pathname === '/api/presence' && req.method === 'GET') return json(res, 200, { ok: true, agents: presence(db) });
    // Arbeitsstatus melden (v0.2.0): Agent meldet sich selbst {status:'busy'|'idle'} (lokaler Modus);
    // Dispatcher (Admin-Token) darf per {name,status} für ein benanntes Fenster melden (server+tmux).
    if (url.pathname === '/api/status' && req.method === 'POST') {
      const b = await koerper(req);
      if (wer.agent) statusSetzen(db, wer.agent.id, b.status);
      else if (wer.rolle === 'admin' && b.name) statusSetzenNachName(db, b.name, b.status);
      else return json(res, 403, { ok: false, fehler: 'Nur ein Agent (eigener Status) oder Admin (mit name).' });
      broadcast('presence', { status: b.status });
      return json(res, 200, { ok: true });
    }
    // Stopp anfordern (v0.2.0): Steuer-Aktion aus der UI (Admin). Setzt ein Flag je Agent-Name.
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      if (wer.rolle !== 'admin') return json(res, 403, { ok: false, fehler: 'Nur Admin.' });
      const b = await koerper(req);
      if (!b.name) return json(res, 400, { ok: false, fehler: 'name ist Pflicht.' });
      stopAnfordern(db, b.name); broadcast('presence', { stop: b.name });
      return json(res, 200, { ok: true });
    }
    // Stopp-Abfrage (v0.2.0): „soll gestoppt werden?" (holt & quittiert einmalig).
    //   • Agent-Token → für SICH selbst (lokaler Modus, Connector-check_stop).
    //   • Admin-Token + ?name= → für ein benanntes Fenster (Dispatcher schickt dann ESC, server+tmux).
    if (url.pathname === '/api/stop-pending' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (wer.agent) return json(res, 200, { ok: true, stop: stopHolenUndQuittieren(db, wer.agent.id) });
      if (wer.rolle === 'admin' && name) return json(res, 200, { ok: true, stop: stopHolenUndQuittierenNachName(db, name) });
      return json(res, 403, { ok: false, fehler: 'Agent-Token (eigener) oder Admin (mit name).' });
    }

    if (url.pathname === '/api/reminders' && req.method === 'GET') return json(res, 200, { ok: true, reminders: reminders(db, { status: url.searchParams.get('status') }) });
    if (url.pathname === '/api/reminders' && req.method === 'POST') {
      const b = await koerper(req);
      const r = reminderAnlegen(db, { ...b, kanal: b.kanal || (wer.agent ? wer.agent.kanal : 'allgemein') });
      return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 400, { ok: false, fehler: 'kanal und titel sind Pflicht.' });
    }
    const mErl = /^\/api\/reminders\/(\d+)\/erledigt$/.exec(url.pathname);
    if (mErl && req.method === 'POST') return json(res, 200, { ok: true, reminder: reminderErledigt(db, mErl[1]) });
    const mVer = /^\/api\/reminders\/(\d+)\/verschieben$/.exec(url.pathname);
    if (mVer && req.method === 'POST') {
      const b = await koerper(req);
      const r = reminderVerschieben(db, mVer[1], b.faellig_am);
      return r ? json(res, 200, { ok: true, reminder: r }) : json(res, 400, { ok: false, fehler: 'faellig_am ist Pflicht.' });
    }

    // Medien: roher Upload (x-fc-name-Header), Auslieferung mit Range/206 (Lektion: Video/Voice braucht das).
    if (url.pathname === '/api/media' && req.method === 'POST') {
      // v0.4.0-Härtung: Rate-Limit je Token + Größenlimit (Header vorab, beim Streamen gezählt).
      const lim = mediaLimiter.check(wer.rolle + ':' + (wer.agent ? wer.agent.id : 'admin'));
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
        if (bytes > MEDIA_MAX && !abgebrochen) { // Header gelogen/fehlend: hart abbrechen, Datei weg
          abgebrochen = true; req.unpipe(out); out.destroy();
          try { unlinkSync(ziel); } catch { /* schon weg */ }
          json(res, 413, { ok: false, fehler: `Datei zu groß (max. ${Math.round(MEDIA_MAX / 1048576)} MB).` });
          req.destroy();
        }
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

  // Web-UI (statisch, ohne Auth ausgeliefert — die API selbst ist token-geschützt).
  const datei = url.pathname === '/' ? '/index.html' : url.pathname;
  const pfad = join(ROOT, 'ui', datei.replace(/\.\./g, ''));
  if (existsSync(pfad) && statSync(pfad).isFile()) {
    res.writeHead(200, { 'content-type': MIME[extname(pfad)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return createReadStream(pfad).pipe(res);
  }
  res.writeHead(404); res.end('nicht gefunden');
});

// v0.3.0-Härtung: Default-Bind auf localhost (Doku-konform). Für Remote-Betrieb hinter TLS-Proxy/Firewall FC_HOST=0.0.0.0 setzen.
const HOST = process.env.FC_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n⚡ Sales Engine Flotten Chat läuft: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? '  ⚠ gebunden an 0.0.0.0 — nur hinter TLS-Proxy/Firewall betreiben!' : ''}`);
  console.log(`   Datenverzeichnis: ${DATA}`);
  console.log(`   Admin-Token (für UI/API, geheim halten): ${ADMIN}\n`);
});
export default server;

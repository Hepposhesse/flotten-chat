// flotten-chat-kit — Bus + Chat-Server in EINER Datei. Keine npm-Dependencies (node:sqlite, Node >= 22).
// Start:  node bus/server.mjs   (liest ../kit.config.json relativ zu dieser Datei)
//
// Das System: Menschen + Claude-Fenster reden über einen SQLite-Nachrichten-Bus.
//   - Jedes Mitglied hat ZWEI Kanäle: inChannel (an das Fenster) + outChannel (vom Fenster an den Chef).
//   - Die Chat-UI (GET /) zeigt je Mitglied EINEN Thread (in+out chronologisch gemerged).
//   - Claude-Fenster lesen ihren inChannel (API oder sqlite3-CLI) und antworten auf ihren outChannel.
//   - Der Dispatcher (dispatcher/dispatcher.sh) weckt Fenster bei neuen Nachrichten per tmux.
// Sicherheit: API nur mit Bearer-Token (kit.config.json); standardmäßig NUR localhost binden.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(HIER, '..', 'kit.config.json'), 'utf8'));
const DB_PFAD = process.env.KIT_DB || path.join(HIER, '..', 'messages.db');
const BIND = process.env.KIT_BIND || '127.0.0.1';

const db = new DatabaseSync(DB_PFAD);
db.exec(`CREATE TABLE IF NOT EXISTS nachrichten (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kanal TEXT NOT NULL,
  von TEXT NOT NULL DEFAULT 'chef',
  typ TEXT NOT NULL DEFAULT 'fyi',
  inhalt TEXT NOT NULL,
  bezug_id INTEGER,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kanal_id ON nachrichten(kanal, id);`);

const ok = (res, daten, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(daten)); };
const authOk = (req) => (req.headers.authorization || '') === `Bearer ${CFG.token}`;
const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
const TYPEN = ['task', 'fyi', 'done', 'answer', 'accept', 'frage', 'error'];

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CFG.port}`);
  // UI + Health sind offen (localhost); die Daten-API verlangt den Token.
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(HIER, '..', 'ui', 'chat.html'), 'utf8').replaceAll('__TOKEN__', CFG.token).replaceAll('__TITEL__', CFG.titel || 'Flotten-Chat'));
  }
  if (url.pathname === '/health') return ok(res, { ok: true });
  if (!authOk(req)) return ok(res, { error: 'token' }, 401);

  // Mitglieder/Kanäle (aus der Config — die UI baut daraus die Thread-Liste).
  if (url.pathname === '/api/mitglieder' && req.method === 'GET') return ok(res, { ok: true, mitglieder: CFG.mitglieder });

  // Verlauf EINES Mitglieds: in+out gemerged, aufsteigend. ?name=&seit=&limit=
  if (url.pathname === '/api/nachrichten' && req.method === 'GET') {
    const m = CFG.mitglieder.find((x) => x.name === url.searchParams.get('name'));
    if (!m) return ok(res, { error: 'unbekanntes Mitglied' }, 404);
    const seit = Math.max(0, parseInt(url.searchParams.get('seit') || '0', 10) || 0);
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10) || 200);
    const rows = db.prepare(`SELECT id, kanal, von, typ, inhalt, bezug_id, erstellt_am FROM nachrichten
      WHERE kanal IN (?, ?) AND id > ? ORDER BY id DESC LIMIT ?`).all(m.inChannel, m.outChannel, seit, limit);
    rows.reverse();
    return ok(res, { ok: true, nachrichten: rows.map((r) => ({ ...r, richtung: r.kanal === m.outChannel ? 'agent' : 'chef' })) });
  }

  // Roh-Kanal lesen (für Claude-Fenster/Dispatcher): ?kanal=&seit=&limit=
  if (url.pathname === '/api/kanal' && req.method === 'GET') {
    const kanal = safe(url.searchParams.get('kanal'));
    const seit = Math.max(0, parseInt(url.searchParams.get('seit') || '0', 10) || 0);
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '50', 10) || 50);
    const rows = db.prepare('SELECT id, von, typ, inhalt, bezug_id, erstellt_am FROM nachrichten WHERE kanal = ? AND id > ? ORDER BY id ASC LIMIT ?').all(kanal, seit, limit);
    return ok(res, { ok: true, nachrichten: rows });
  }

  // Senden: {kanal|name+richtung, von, typ, inhalt, bezug}
  if (url.pathname === '/api/nachrichten' && req.method === 'POST') {
    let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 300_000) req.destroy(); });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return ok(res, { error: 'json' }, 400); }
      let kanal = safe(b.kanal);
      if (!kanal && b.name) { // Bequem-Form: name + richtung ('an-agent' | 'von-agent')
        const m = CFG.mitglieder.find((x) => x.name === b.name);
        if (!m) return ok(res, { error: 'unbekanntes Mitglied' }, 404);
        kanal = b.richtung === 'von-agent' ? m.outChannel : m.inChannel;
      }
      const inhalt = String(b.inhalt || '').trim().slice(0, 100_000);
      if (!kanal || !inhalt) return ok(res, { error: 'kanal/inhalt fehlt' }, 400);
      const typ = TYPEN.includes(b.typ) ? b.typ : 'fyi';
      const bezug = Number.isInteger(Number(b.bezug)) && Number(b.bezug) > 0 ? Number(b.bezug) : null;
      const r = db.prepare('INSERT INTO nachrichten (kanal, von, typ, inhalt, bezug_id) VALUES (?, ?, ?, ?, ?)')
        .run(kanal, String(b.von || 'chef').slice(0, 60), typ, inhalt, bezug);
      return ok(res, { ok: true, id: Number(r.lastInsertRowid) });
    });
    return;
  }

  // Unread je Mitglied: POST {markers:{name: gelesen_bis_id}} → zählt NUR outChannel (Agent→Chef).
  if (url.pathname === '/api/unread' && req.method === 'POST') {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let markers = {}; try { markers = JSON.parse(raw || '{}').markers || {}; } catch { /* leer */ }
      const counts = {};
      for (const m of CFG.mitglieder) {
        const seit = Math.max(0, Number(markers[m.name]) || 0);
        const row = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS maxid FROM nachrichten WHERE kanal = ? AND id > ?').get(m.outChannel, seit);
        counts[m.name] = { n: Number(row.n) || 0, maxid: Number(row.maxid) || seit };
      }
      return ok(res, { ok: true, counts });
    });
    return;
  }

  ok(res, { error: 'not found' }, 404);
}).listen(CFG.port, BIND, () => console.log(`flotten-chat-kit läuft auf http://${BIND}:${CFG.port} · DB ${DB_PFAD} · ${CFG.mitglieder.length} Mitglied(er)`));

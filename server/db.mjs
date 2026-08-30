// server/db.mjs — Datenschicht des Sales Engine Flotten Chat (Community-Edition).
// Eine SQLite-Datei (node:sqlite, keine Dependencies), Schema idempotent.
// Prinzip wie im Mutterschiff: fail-safe, klein, lesbar.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'media'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'flottenchat.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT '',
      archiviert INTEGER DEFAULT 0,
      erstellt_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kanal TEXT NOT NULL,
      von TEXT NOT NULL,
      typ TEXT DEFAULT 'fyi',
      inhalt TEXT NOT NULL,
      bezug_id INTEGER,
      media TEXT,
      erstellt_am TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_kanal ON messages(kanal, id);
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      kanal TEXT NOT NULL,
      cursor INTEGER DEFAULT 0,
      zuletzt_gesehen TEXT,
      status TEXT DEFAULT 'idle',
      status_seit TEXT,
      stop_angefordert INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      kanal TEXT NOT NULL,
      benutzt INTEGER DEFAULT 0,
      erstellt_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quelle_msg INTEGER,
      kanal TEXT NOT NULL,
      titel TEXT NOT NULL,
      notiz TEXT DEFAULT '',
      ordner TEXT DEFAULT '',
      faellig_am TEXT,
      status TEXT DEFAULT 'offen',
      uebergeben_an TEXT,
      gefeuert_am TEXT,
      erstellt_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT DEFAULT 'application/octet-stream',
      groesse INTEGER DEFAULT 0,
      erstellt_am TEXT NOT NULL
    );
  `);
  // Migration für bestehende DBs (v0.2.0): Status-/Stopp-Spalten idempotent nachziehen.
  for (const sp of ['status TEXT DEFAULT \'idle\'', 'status_seit TEXT', 'stop_angefordert INTEGER DEFAULT 0']) {
    try { db.exec(`ALTER TABLE agents ADD COLUMN ${sp}`); } catch { /* Spalte existiert schon */ }
  }
  return db;
}

export const nowIso = () => new Date().toISOString();
export const neuerToken = (praefix) => praefix + '_' + crypto.randomBytes(24).toString('hex');

// ── Kanäle ──────────────────────────────────────────────────────────────────
export function kanalAnlegen(db, { name, label = '' }) {
  const sauber = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);
  if (!sauber) return null;
  try {
    db.prepare('INSERT INTO channels (name, label, erstellt_am) VALUES (?, ?, ?)').run(sauber, String(label).slice(0, 120), nowIso());
  } catch { /* existiert schon — idempotent */ }
  return db.prepare('SELECT * FROM channels WHERE name = ?').get(sauber);
}
export function kanaele(db) {
  return db.prepare('SELECT * FROM channels ORDER BY archiviert, id').all();
}

// ── Nachrichten ─────────────────────────────────────────────────────────────
export function senden(db, { kanal, von, typ = 'fyi', inhalt, bezug_id = null, media = null }) {
  if (!kanal || !inhalt || !von) return null;
  const t = ['fyi', 'done', 'answer', 'error', 'system'].includes(typ) ? typ : 'fyi';
  const r = db.prepare('INSERT INTO messages (kanal, von, typ, inhalt, bezug_id, media, erstellt_am) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(kanal).slice(0, 60), String(von).slice(0, 80), t, String(inhalt).slice(0, 20000),
      bezug_id ? Number(bezug_id) : null, media ? JSON.stringify(media).slice(0, 4000) : null, nowIso());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
}
export function nachrichten(db, { kanal, seit = 0, limit = 200 }) {
  return db.prepare('SELECT * FROM messages WHERE kanal = ? AND id > ? ORDER BY id LIMIT ?')
    .all(String(kanal), Number(seit) || 0, Math.min(Number(limit) || 200, 500));
}

// ── Agenten + Self-Connect ──────────────────────────────────────────────────
export function inviteAnlegen(db, { kanal }) {
  const token = neuerToken('inv');
  db.prepare('INSERT INTO invites (token, kanal, erstellt_am) VALUES (?, ?, ?)').run(token, String(kanal), nowIso());
  return token;
}
export function connect(db, { invite_token, name }) {
  const inv = db.prepare('SELECT * FROM invites WHERE token = ? AND benutzt = 0').get(String(invite_token || ''));
  if (!inv) return null;
  db.prepare('UPDATE invites SET benutzt = 1 WHERE token = ?').run(inv.token);
  const token = neuerToken('agt');
  const cur = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE kanal = ?').get(inv.kanal).m;
  db.prepare('INSERT INTO agents (name, token, kanal, cursor, zuletzt_gesehen) VALUES (?, ?, ?, ?, ?)')
    .run(String(name || 'agent').slice(0, 80), token, inv.kanal, cur, nowIso());
  return { agent_token: token, kanal: inv.kanal, cursor: cur };
}
export function agentViaToken(db, token) {
  if (!token) return null;
  const a = db.prepare('SELECT * FROM agents WHERE token = ?').get(String(token));
  if (a) db.prepare('UPDATE agents SET zuletzt_gesehen = ? WHERE id = ?').run(nowIso(), a.id);
  return a || null;
}
export function cursorSetzen(db, agentId, cursor) {
  db.prepare('UPDATE agents SET cursor = ?, zuletzt_gesehen = ? WHERE id = ?').run(Number(cursor) || 0, nowIso(), agentId);
}
export function presence(db) {
  return db.prepare('SELECT id, name, kanal, zuletzt_gesehen, status, status_seit, stop_angefordert FROM agents ORDER BY id').all();
}
// ── Arbeitsstatus (v0.2.0): busy/idle je Agent. EINE Presence-Wahrheit, zwei Quellen —
//    lokal meldet der Agent sich selbst (Connector-Heartbeat), server+tmux meldet der Dispatcher.
export function statusSetzen(db, agentId, status) {
  const s = status === 'busy' ? 'busy' : 'idle';
  db.prepare('UPDATE agents SET status = ?, status_seit = ?, zuletzt_gesehen = ? WHERE id = ?').run(s, nowIso(), nowIso(), Number(agentId) || 0);
  return db.prepare('SELECT id, name, status, status_seit FROM agents WHERE id = ?').get(Number(agentId) || 0);
}
/** Für den Dispatcher (Server-Betrieb): Status je Agent-NAME setzen (der Dispatcher kennt keinen Token). */
export function statusSetzenNachName(db, name, status) {
  const s = status === 'busy' ? 'busy' : 'idle';
  db.prepare('UPDATE agents SET status = ?, status_seit = ?, zuletzt_gesehen = ? WHERE name = ?').run(s, nowIso(), nowIso(), String(name || ''));
}
// ── Stopp anfordern (v0.2.0): setzt ein Flag; server+tmux → Dispatcher schickt ESC, lokal →
//    der Connector prüft das Flag beim Heartbeat (kooperatives, weiches Stoppen). ──
export function stopAnfordern(db, name) {
  db.prepare("UPDATE agents SET stop_angefordert = 1 WHERE name = ?").run(String(name || ''));
  return db.prepare('SELECT id, name FROM agents WHERE name = ?').get(String(name || ''));
}
/** Der Empfänger (Dispatcher/Connector) holt & quittiert die Stopp-Anforderung (einmalig). */
export function stopHolenUndQuittieren(db, agentId) {
  const a = db.prepare('SELECT stop_angefordert FROM agents WHERE id = ?').get(Number(agentId) || 0);
  if (a && a.stop_angefordert) { db.prepare('UPDATE agents SET stop_angefordert = 0 WHERE id = ?').run(Number(agentId) || 0); return true; }
  return false;
}
/** Für den Dispatcher (server+tmux): Stopp je Agent-NAME holen & quittieren (schickt dann ESC). */
export function stopHolenUndQuittierenNachName(db, name) {
  const a = db.prepare('SELECT id, stop_angefordert FROM agents WHERE name = ?').get(String(name || ''));
  if (a && a.stop_angefordert) { db.prepare('UPDATE agents SET stop_angefordert = 0 WHERE id = ?').run(a.id); return true; }
  return false;
}

// ── Erinnerungen (feuern OHNE AI — der Produkt-Kern) ────────────────────────
export function reminderAnlegen(db, { kanal, titel, notiz = '', ordner = '', faellig_am = null, quelle_msg = null, uebergeben_an = null }) {
  if (!kanal || !titel) return null;
  const r = db.prepare('INSERT INTO reminders (quelle_msg, kanal, titel, notiz, ordner, faellig_am, uebergeben_an, erstellt_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(quelle_msg ? Number(quelle_msg) : null, String(kanal), String(titel).slice(0, 300), String(notiz).slice(0, 2000),
      String(ordner).slice(0, 80), faellig_am ? String(faellig_am) : null, uebergeben_an ? String(uebergeben_an).slice(0, 80) : null, nowIso());
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.lastInsertRowid);
}
export function reminders(db, { status = null } = {}) {
  return status
    ? db.prepare('SELECT * FROM reminders WHERE status = ? ORDER BY COALESCE(faellig_am, erstellt_am)').all(String(status))
    : db.prepare('SELECT * FROM reminders ORDER BY COALESCE(faellig_am, erstellt_am)').all();
}
export function reminderErledigt(db, id) {
  db.prepare("UPDATE reminders SET status = 'erledigt' WHERE id = ?").run(Number(id));
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(id));
}
/** Neu terminieren: setzt die Fälligkeit + macht die Erinnerung wieder offen und ungefeuert,
 *  damit sie zur NEUEN Zeit erneut auslöst (auch eine schon gefeuerte lässt sich so verschieben). */
export function reminderVerschieben(db, id, faellig_am) {
  if (!id || !faellig_am) return null;
  db.prepare("UPDATE reminders SET faellig_am = ?, status = 'offen', gefeuert_am = NULL WHERE id = ?")
    .run(String(faellig_am), Number(id));
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(id));
}
/** Fällige, noch nicht gefeuerte Erinnerungen: als System-Nachricht in den Kanal + markieren. */
export function faelligeFeuern(db, jetzt = new Date()) {
  const due = db.prepare("SELECT * FROM reminders WHERE status = 'offen' AND gefeuert_am IS NULL AND faellig_am IS NOT NULL AND faellig_am <= ?")
    .all(jetzt.toISOString());
  const gefeuert = [];
  for (const r of due) {
    const an = r.uebergeben_an ? ` an:${r.uebergeben_an}` : '';
    const msg = senden(db, { kanal: r.kanal, von: 'flottenchat', typ: 'system', inhalt: `⏰ Erinnerung fällig${an}: ${r.titel}${r.notiz ? `\n${r.notiz}` : ''}` });
    db.prepare('UPDATE reminders SET gefeuert_am = ? WHERE id = ?').run(nowIso(), r.id);
    gefeuert.push({ reminder: r, message: msg });
  }
  return gefeuert;
}

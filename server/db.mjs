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
  // v0.4.0: idempotentes Senden — client_id je Nachricht (vom Sender erzeugt). Gleiche client_id im
  // selben Kanal = dieselbe Nachricht (Netz-Retry erzeugt keine Dublette). Teil-Index nur für gesetzte IDs.
  try { db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT'); } catch { /* existiert schon */ }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client ON messages(kanal, client_id) WHERE client_id IS NOT NULL');
  // v1.0 „Konsole im Chat": meta (JSON: Dialog-Optionen für Knöpfe, Karten-Bezug), Fenster-Registry,
  // Themen-Board, Nutzer-Login (E-Mail + Passwort) und Browser-Sitzungen — alles additiv/idempotent.
  try { db.exec('ALTER TABLE messages ADD COLUMN meta TEXT'); } catch { /* existiert schon */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fenster (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,          -- Kanal-Name = Fenster-Name (slug)
      label TEXT DEFAULT '',
      ort TEXT DEFAULT 'lokal',           -- 'lokal' (tmux auf dem Chat-Server) | 'ssh:<host>' (tmux auf einem anderen Rechner)
      ordner TEXT NOT NULL,               -- Arbeitsordner des Fensters
      config_dir TEXT DEFAULT '',         -- CLAUDE_CONFIG_DIR (leer = Standard ~/.claude)
      start_modus TEXT DEFAULT 'auto',    -- Claude permission-mode beim Start
      start_text TEXT DEFAULT '',         -- erster Satz ans Fenster (Thema)
      tmux TEXT NOT NULL,                 -- tmux-Session-Name
      karte_id INTEGER,                   -- verknüpfte Karte (Themen-Board)
      worktree INTEGER DEFAULT 0,         -- 1 = Ordner ist ein eigener git-Worktree dieses Fensters
      cursor INTEGER DEFAULT 0,           -- Chat-Cursor der Zustellung
      spiegel TEXT DEFAULT '{}',          -- Spiegel-Stand (Sitzung, Offset) als JSON
      status TEXT DEFAULT 'aus',          -- aus | laeuft | schliesst
      gestartet_am TEXT,
      erstellt_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS karten (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titel TEXT NOT NULL,
      beschreibung TEXT DEFAULT '',
      spalte TEXT DEFAULT 'ideen',        -- ideen | in_arbeit | freigabe | pruefen | erledigt
      fenster TEXT DEFAULT '',            -- Name des verbundenen Fensters
      verlauf TEXT DEFAULT '[]',          -- [{am, von, text, media?}]
      erstellt_am TEXT NOT NULL,
      stand_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nutzer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      erstellt_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sitzungen (
      token TEXT PRIMARY KEY,
      nutzer_id INTEGER NOT NULL,
      erstellt_am TEXT NOT NULL,
      zuletzt TEXT
    );
  `);
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
/** Senden. Mit `client_id` idempotent: existiert im Kanal schon eine Nachricht mit dieser ID, kommt
 *  SIE zurück (mit `dedup: true`) statt einer Dublette — der Sender darf also bei Netzfehlern
 *  gefahrlos wiederholen (Outbox-Muster, v0.4.0). */
export function senden(db, { kanal, von, typ = 'fyi', inhalt, bezug_id = null, media = null, client_id = null, meta = null }) {
  if (!kanal || !inhalt || !von) return null;
  const t = ['fyi', 'done', 'answer', 'error', 'system', 'question', 'task'].includes(typ) ? typ : 'fyi';
  const cid = client_id ? String(client_id).slice(0, 64) : null;
  if (cid) {
    const alt = db.prepare('SELECT * FROM messages WHERE kanal = ? AND client_id = ?').get(String(kanal).slice(0, 60), cid);
    if (alt) return { ...alt, dedup: true };
  }
  const r = db.prepare('INSERT INTO messages (kanal, von, typ, inhalt, bezug_id, media, erstellt_am, client_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(kanal).slice(0, 60), String(von).slice(0, 80), t, String(inhalt).slice(0, 20000),
      bezug_id ? Number(bezug_id) : null, media ? JSON.stringify(media).slice(0, 4000) : null, nowIso(), cid,
      meta ? JSON.stringify(meta).slice(0, 8000) : null);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
}
/** Meta einer Nachricht nachträglich setzen/ändern (z. B. Dialog als beantwortet markieren). */
export function metaSetzen(db, id, meta) {
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(meta ? JSON.stringify(meta).slice(0, 8000) : null, Number(id));
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
}
export function letzteNachrichtId(db, kanal) {
  return db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE kanal = ?').get(String(kanal)).m;
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

// ── v1.0: Fenster-Registry ─────────────────────────────────────────────────
// EIN Ort für alles, was ein Fenster ausmacht (Name = Kanal, Ort, Ordner, tmux-Session, Karte, Stand).
export function fensterAnlegen(db, { name, label = '', ort = 'lokal', ordner, config_dir = '', start_modus = 'auto', start_text = '', karte_id = null, worktree = 0 }) {
  const sauber = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!sauber || !ordner) return null;
  const modus = ['auto', 'default', 'plan', 'acceptEdits'].includes(start_modus) ? start_modus : 'auto';
  try {
    db.prepare('INSERT INTO fenster (name, label, ort, ordner, config_dir, start_modus, start_text, tmux, karte_id, worktree, erstellt_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sauber, String(label || sauber).slice(0, 120), String(ort || 'lokal').slice(0, 120), String(ordner).slice(0, 400), String(config_dir || '').slice(0, 400),
        modus, String(start_text || '').slice(0, 4000), 'fc-' + sauber, karte_id ? Number(karte_id) : null, worktree ? 1 : 0, nowIso());
  } catch { return null; } // Name vergeben
  kanalAnlegen(db, { name: sauber, label: label || sauber });
  return fensterHolen(db, sauber);
}
export function fensterHolen(db, name) { return db.prepare('SELECT * FROM fenster WHERE name = ?').get(String(name || '')) || null; }
export function fensterAlle(db) { return db.prepare('SELECT * FROM fenster ORDER BY id').all(); }
export function fensterAendern(db, name, patch = {}) {
  const f = fensterHolen(db, name); if (!f) return null;
  const erlaubt = ['label', 'status', 'gestartet_am', 'cursor', 'spiegel', 'karte_id', 'start_text', 'start_modus', 'worktree'];
  for (const k of erlaubt) if (patch[k] !== undefined) {
    const v = k === 'spiegel' ? JSON.stringify(patch[k] || {}) : patch[k];
    db.prepare(`UPDATE fenster SET ${k} = ? WHERE id = ?`).run(v == null ? null : (typeof v === 'number' ? v : String(v)), f.id);
  }
  return fensterHolen(db, name);
}
export function fensterLoeschen(db, name) {
  const f = fensterHolen(db, name); if (!f) return false;
  db.prepare('DELETE FROM fenster WHERE id = ?').run(f.id);
  db.prepare('UPDATE channels SET archiviert = 1 WHERE name = ?').run(f.name);
  return true;
}

// ── v1.0: Themen-Board (Karte = Thema) ─────────────────────────────────────
export const SPALTEN = ['ideen', 'in_arbeit', 'freigabe', 'pruefen', 'erledigt'];
export function karteAnlegen(db, { titel, beschreibung = '', spalte = 'ideen', fenster = '' }) {
  if (!titel) return null;
  const sp = SPALTEN.includes(spalte) ? spalte : 'ideen';
  const r = db.prepare('INSERT INTO karten (titel, beschreibung, spalte, fenster, erstellt_am, stand_am) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(titel).slice(0, 200), String(beschreibung || '').slice(0, 8000), sp, String(fenster || '').slice(0, 40), nowIso(), nowIso());
  return karteHolen(db, r.lastInsertRowid);
}
export function karteHolen(db, id) {
  const k = db.prepare('SELECT * FROM karten WHERE id = ?').get(Number(id));
  if (!k) return null;
  try { k.verlauf = JSON.parse(k.verlauf || '[]'); } catch { k.verlauf = []; }
  return k;
}
export function karten(db) { return db.prepare('SELECT * FROM karten ORDER BY stand_am DESC').all().map((k) => { try { k.verlauf = JSON.parse(k.verlauf || '[]'); } catch { k.verlauf = []; } return k; }); }
export function karteAendern(db, id, patch = {}) {
  const k = karteHolen(db, id); if (!k) return null;
  if (patch.titel != null) db.prepare('UPDATE karten SET titel = ? WHERE id = ?').run(String(patch.titel).slice(0, 200), k.id);
  if (patch.beschreibung != null) db.prepare('UPDATE karten SET beschreibung = ? WHERE id = ?').run(String(patch.beschreibung).slice(0, 8000), k.id);
  if (patch.spalte != null && SPALTEN.includes(patch.spalte)) db.prepare('UPDATE karten SET spalte = ? WHERE id = ?').run(patch.spalte, k.id);
  if (patch.fenster !== undefined) db.prepare('UPDATE karten SET fenster = ? WHERE id = ?').run(String(patch.fenster || '').slice(0, 40), k.id);
  db.prepare('UPDATE karten SET stand_am = ? WHERE id = ?').run(nowIso(), k.id);
  return karteHolen(db, id);
}
/** Verlaufs-Eintrag (für Menschen): kurzer Text, optional ein Medium {id,url,name,mime}. */
export function karteVerlauf(db, id, { von = '', text = '', media = null }) {
  const k = karteHolen(db, id); if (!k || !text) return null;
  k.verlauf.push({ am: nowIso(), von: String(von || '').slice(0, 80), text: String(text).slice(0, 4000), ...(media ? { media } : {}) });
  db.prepare('UPDATE karten SET verlauf = ?, stand_am = ? WHERE id = ?').run(JSON.stringify(k.verlauf.slice(-200)), nowIso(), k.id);
  return karteHolen(db, id);
}
export function karteLoeschen(db, id) { db.prepare('DELETE FROM karten WHERE id = ?').run(Number(id)); return true; }

// ── v1.0: Nutzer-Login (E-Mail + Passwort, scrypt) + Browser-Sitzungen ─────
export function nutzerAnlegen(db, { email, passwort, name = '' }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || String(passwort || '').length < 8) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passwort), salt, 64).toString('hex');
  try { db.prepare('INSERT INTO nutzer (email, name, salt, hash, erstellt_am) VALUES (?, ?, ?, ?, ?)').run(e, String(name || '').slice(0, 80), salt, hash, nowIso()); } catch { return null; }
  return db.prepare('SELECT id, email, name, erstellt_am FROM nutzer WHERE email = ?').get(e);
}
export function nutzerAnzahl(db) { return db.prepare('SELECT COUNT(*) AS n FROM nutzer').get().n; }
export function nutzerPruefen(db, { email, passwort }) {
  const u = db.prepare('SELECT * FROM nutzer WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!u) return null;
  const hash = crypto.scryptSync(String(passwort || ''), u.salt, 64);
  const soll = Buffer.from(u.hash, 'hex');
  if (hash.length !== soll.length || !crypto.timingSafeEqual(hash, soll)) return null;
  return { id: u.id, email: u.email, name: u.name };
}
export function sitzungAnlegen(db, nutzerId) {
  const token = neuerToken('ses');
  db.prepare('INSERT INTO sitzungen (token, nutzer_id, erstellt_am, zuletzt) VALUES (?, ?, ?, ?)').run(token, Number(nutzerId), nowIso(), nowIso());
  return token;
}
export function sitzungNutzer(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT s.token, u.id, u.email, u.name FROM sitzungen s JOIN nutzer u ON u.id = s.nutzer_id WHERE s.token = ?').get(String(token));
  if (s) db.prepare('UPDATE sitzungen SET zuletzt = ? WHERE token = ?').run(nowIso(), s.token);
  return s ? { id: s.id, email: s.email, name: s.name } : null;
}
export function sitzungLoeschen(db, token) { db.prepare('DELETE FROM sitzungen WHERE token = ?').run(String(token || '')); }

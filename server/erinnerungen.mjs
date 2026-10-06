// server/erinnerungen.mjs — Erinnerungs-Ordner, Titel/Notiz, Übergabe an ein Fenster (v1.1).
//
// Der Kanal „Erinnerungen“ (db.mjs: reminderAnlegen/faelligeFeuern) bekommt Ordner, damit die Inbox schlank bleibt:
// Erinnerung in einen Ordner legen, Ordner anlegen/umbenennen/löschen (Inhalt zurück in die Inbox). Titel und Notiz
// lassen sich nachträglich ändern. „Übergeben“ gibt eine Erinnerung an ein LAUFENDES Fenster: der Auftrag wird als
// Chat-Nachricht in dessen Kanal gelegt und von der Konsole ins Terminal getippt — die Erinnerung ist dann erledigt
// in dem Sinn, dass sich jemand kümmert (status 'uebergeben', feuert nicht mehr).
// Schema: additiv + idempotent, hier gehalten (eine Tabelle, eine Spalte) — db.mjs bleibt unverändert.
import { nowIso } from './db.mjs';

export function erinnerungenSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_ordner (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    reihenfolge INTEGER DEFAULT 0,
    erstellt_am TEXT NOT NULL
  )`);
  try { db.exec('ALTER TABLE reminders ADD COLUMN ordner_id INTEGER'); } catch { /* existiert schon */ }
}

// ── Ordner ──────────────────────────────────────────────────────────────────
export const ordnerName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
export function ordnerAlle(db) { return db.prepare('SELECT * FROM reminder_ordner ORDER BY reihenfolge, id').all(); }
export function ordnerHolen(db, id) { return db.prepare('SELECT * FROM reminder_ordner WHERE id = ?').get(Number(id)) || null; }
export function ordnerAnlegen(db, { name }) {
  const n = ordnerName(name); if (!n) return null;
  const max = db.prepare('SELECT COALESCE(MAX(reihenfolge), 0) AS m FROM reminder_ordner').get().m;
  const r = db.prepare('INSERT INTO reminder_ordner (name, reihenfolge, erstellt_am) VALUES (?, ?, ?)').run(n, max + 1, nowIso());
  return ordnerHolen(db, r.lastInsertRowid);
}
export function ordnerUmbenennen(db, id, name) {
  const o = ordnerHolen(db, id); const n = ordnerName(name);
  if (!o || !n) return null;
  db.prepare('UPDATE reminder_ordner SET name = ? WHERE id = ?').run(n, o.id);
  return ordnerHolen(db, o.id);
}
/** Ordner löschen → sein Inhalt liegt wieder in der Inbox (ordner_id NULL). */
export function ordnerLoeschen(db, id) {
  const o = ordnerHolen(db, id); if (!o) return { ok: false, fehler: 'Ordner unbekannt.' };
  const z = db.prepare('UPDATE reminders SET ordner_id = NULL WHERE ordner_id = ?').run(o.id).changes;
  db.prepare('DELETE FROM reminder_ordner WHERE id = ?').run(o.id);
  return { ok: true, zurueck: z };
}

// ── Erinnerung bearbeiten ───────────────────────────────────────────────────
const holen = (db, id) => db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(id)) || null;
/** In einen Ordner legen (ordner_id) oder zurück in die Inbox (null). */
export function reminderInOrdner(db, id, ordnerId) {
  const r = holen(db, id); if (!r) return { ok: false, fehler: 'Erinnerung unbekannt.' };
  const ziel = ordnerId == null || ordnerId === '' ? null : Number(ordnerId);
  if (ziel != null && !ordnerHolen(db, ziel)) return { ok: false, fehler: 'Ordner unbekannt.' };
  db.prepare('UPDATE reminders SET ordner_id = ? WHERE id = ?').run(ziel, r.id);
  return { ok: true, reminder: holen(db, r.id) };
}
export function reminderTitel(db, id, titel) {
  const r = holen(db, id); const t = String(titel || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!r || !t) return null;
  db.prepare('UPDATE reminders SET titel = ? WHERE id = ?').run(t, r.id);
  return holen(db, r.id);
}
/** Notiz setzen (leer = löschen). */
export function reminderNotiz(db, id, notiz) {
  const r = holen(db, id); if (!r) return null;
  db.prepare('UPDATE reminders SET notiz = ? WHERE id = ?').run(String(notiz || '').trim().slice(0, 2000), r.id);
  return holen(db, r.id);
}

// ── Übergabe an ein Fenster ─────────────────────────────────────────────────
/** Der Auftrag, der im Fenster ankommt (rein). */
export function uebergabeText(r, { zeitText = (iso) => iso } = {}) {
  const zeilen = [`📌 Übergabe aus den Erinnerungen: „${String(r.titel || '').trim()}“`];
  if (r.notiz) zeilen.push(`Notiz: ${String(r.notiz).trim()}`);
  if (r.faellig_am) zeilen.push(`Fällig: ${zeitText(r.faellig_am)}`);
  zeilen.push('→ Bitte nimm das Thema ab hier auf und melde dich, wenn es erledigt ist.');
  return zeilen.join('\n');
}
/** Erinnerung als übergeben markieren (feuert dann nicht mehr; die Liste „offen“ zeigt sie nicht mehr). */
export function reminderUebergeben(db, id, fenster) {
  const r = holen(db, id); const ziel = String(fenster || '').trim().slice(0, 80);
  if (!r || !ziel) return null;
  db.prepare("UPDATE reminders SET status = 'uebergeben', uebergeben_an = ? WHERE id = ?").run(ziel, r.id);
  return holen(db, r.id);
}

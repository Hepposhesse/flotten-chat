// server/verlauf.mjs — Verlauf in Etappen + frischer Verlauf je Fenster (1.2, Chat-Komfort).
//
// Etappen: ein Kanal geht mit den JÜNGSTEN Nachrichten auf (erst 25, dann still je 60 ältere bzw. beim Hochscrollen),
// statt mit den ältesten 200. `GET /api/messages?kanal=…&juengste=1&limit=25` und `…&vor=<id>&limit=60`.
// Der alte Weg (`seit=<cursor>`, aufsteigend) bleibt unverändert — Agenten und Polling lesen weiter so.
//
// Frischer Verlauf: Ein Fenster, das den Namen eines geschlossenen Vorgängers bekommt, startet OHNE dessen Verlauf.
// Die Nachrichten bleiben in der DB (nichts wird gelöscht), der Kanal zeigt nur, was nach `verlauf_ab` kam.
// Spalte additiv + idempotent auf `fenster`.

export const ERSTE_LADUNG = 25;
export const MAX_ETAPPE = 200;

/** Spalte `verlauf_ab` an der Fenster-Tabelle anlegen (idempotent). */
export function verlaufSchema(db) {
  try { db.exec('ALTER TABLE fenster ADD COLUMN verlauf_ab INTEGER DEFAULT 0'); } catch { /* existiert schon */ }
}

/** Ab welcher Nachrichten-ID gehört der Kanal zum heutigen Fenster? 0 = ganzer Verlauf (kein Fenster/kein Vorgänger). */
export function verlaufAb(db, kanal) {
  try { const r = db.prepare('SELECT verlauf_ab FROM fenster WHERE name = ?').get(String(kanal || '')); return r ? Number(r.verlauf_ab) || 0 : 0; } catch { return 0; }
}

/** Beim Anlegen eines Fensters: alles, was schon im Kanal steht (Vorgänger gleichen Namens), gehört nicht dazu. */
export function verlaufAbSetzen(db, kanal) {
  const r = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE kanal = ?').get(String(kanal || ''));
  const ab = Number(r && r.m) || 0;
  db.prepare('UPDATE fenster SET verlauf_ab = ? WHERE name = ?').run(ab, String(kanal || ''));
  return ab;
}

/** Grenzen säubern (PURE): limit 1…MAX_ETAPPE, vor ≥ 0, ab ≥ 0. */
export function etappeGrenzen({ limit, vor, ab } = {}) {
  const l = Math.floor(Number(limit));
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, MAX_ETAPPE) : ERSTE_LADUNG,
    vor: Math.max(0, Math.floor(Number(vor)) || 0),
    ab: Math.max(0, Math.floor(Number(ab)) || 0),
  };
}

/** Die jüngsten `limit` Nachrichten eines Kanals (optional nur IDs < vor, > ab), aufsteigend sortiert. */
export function nachrichtenEtappe(db, { kanal, limit, vor = 0, ab = 0 }) {
  const g = etappeGrenzen({ limit, vor, ab });
  const bed = ['kanal = ?', 'id > ?']; const params = [String(kanal || ''), g.ab];
  if (g.vor) { bed.push('id < ?'); params.push(g.vor); }
  return db.prepare(`SELECT * FROM messages WHERE ${bed.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, g.limit).reverse();
}

/** Nachrichten, die vor dem heutigen Fenster lagen, aus einer Liste (z. B. Suchtreffer) entfernen (PURE). */
export function nurAktuellerVerlauf(zeilen, grenzen = {}) {
  return (zeilen || []).filter((z) => !(Number(grenzen[z.kanal]) > 0 && Number(z.id) <= Number(grenzen[z.kanal])));
}

/** 1.3: Suchtreffer als „archiviert" kennzeichnen statt sie zu verstecken (PURE): Kanal geschlossen/archiviert oder
 *  Nachricht aus dem Verlauf eines geschlossenen Vorgängers gleichen Namens (id ≤ grenze). */
export function archivMarkieren(zeilen, grenzen = {}, archiviert = new Set()) {
  return (zeilen || []).map((z) => ((archiviert.has(z.kanal) || (Number(grenzen[z.kanal]) > 0 && Number(z.id) <= Number(grenzen[z.kanal]))) ? { ...z, archiviert: true } : z));
}

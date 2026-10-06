// server/suche.mjs — Wörter-Suche über Kanäle (1.1). Alle Wörter müssen vorkommen, Groß/klein egal.
// SQLite LIKE ist nur für ASCII schreibungs-unabhängig, darum: LIKE als Vorfilter (ASCII-Wörter),
// Feinprüfung in JS mit echtem toLowerCase (Umlaute). Reine Logik (woerter/passt/ausschnitt) testbar.

export const MAX_TREFFER = 50;
const MAX_KANDIDATEN = 5000;

/** Suchbegriff → Wörter: klein, ohne Dubletten, max. 8 Wörter, Satz in Anführungszeichen = ein Wort. */
export function woerter(q) {
  const t = String(q || '').toLowerCase().trim();
  if (!t) return [];
  const out = [];
  const re = /"([^"]+)"|„([^“”]+)[“”]|(\S+)/g;
  let m;
  while ((m = re.exec(t)) && out.length < 8) {
    const w = (m[1] || m[2] || m[3] || '').trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** Passt ein Text zu allen Wörtern? */
export function passt(text, ws) {
  const t = String(text || '').toLowerCase();
  return ws.length > 0 && ws.every((w) => t.includes(w));
}

/** Ausschnitt um den ersten Treffer, mit „…“ an den Schnittkanten. */
export function ausschnitt(text, ws, breite = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= breite) return t;
  const lower = t.toLowerCase();
  let erster = -1;
  for (const w of ws) { const p = lower.indexOf(w); if (p >= 0 && (erster < 0 || p < erster)) erster = p; }
  if (erster < 0) return t.slice(0, breite - 1) + '…';
  const start = Math.max(0, Math.min(erster - Math.floor(breite / 3), t.length - breite));
  const ende = Math.min(t.length, start + breite);
  return (start > 0 ? '…' : '') + t.slice(start, ende).trim() + (ende < t.length ? '…' : '');
}

/** LIKE-Muster für ein Wort: \ % _ escapen (ESCAPE '\'). Nur für ASCII-Wörter sinnvoll (sonst JS). */
export const likeMuster = (w) => '%' + String(w).replace(/([\\%_])/g, '\\$1') + '%';
const istAscii = (w) => /^[\x20-\x7e]+$/.test(w);

/** Treffer aus Kandidaten-Zeilen bauen (neueste zuerst erwartet): Feinprüfung + Ausschnitt + Limit. */
export function trefferAus(zeilen, ws, limit = MAX_TREFFER) {
  const out = [];
  for (const z of zeilen || []) {
    if (!passt(z.inhalt, ws)) continue;
    out.push({ id: z.id, kanal: z.kanal, von: z.von, typ: z.typ, erstellt_am: z.erstellt_am, ausschnitt: ausschnitt(z.inhalt, ws) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Suche in der DB. `kanaele` = erlaubte Kanäle (null = alle). Liefert {woerter, treffer}. */
export function sucheNachrichten(db, { q, kanaele = null, limit = MAX_TREFFER } = {}) {
  const ws = woerter(q);
  if (!ws.length) return { woerter: ws, treffer: [] };
  const erlaubt = Array.isArray(kanaele) ? [...new Set(kanaele.map((k) => String(k || '')).filter(Boolean))] : null;
  if (erlaubt && !erlaubt.length) return { woerter: ws, treffer: [] };
  const bed = [], params = [];
  if (erlaubt) { bed.push(`kanal IN (${erlaubt.map(() => '?').join(',')})`); params.push(...erlaubt); }
  for (const w of ws) if (istAscii(w)) { bed.push("inhalt LIKE ? ESCAPE '\\'"); params.push(likeMuster(w)); }
  const sql = `SELECT id, kanal, von, typ, inhalt, erstellt_am FROM messages${bed.length ? ' WHERE ' + bed.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const zeilen = db.prepare(sql).all(...params, MAX_KANDIDATEN);
  return { woerter: ws, treffer: trefferAus(zeilen, ws, Math.min(Math.max(Number(limit) || MAX_TREFFER, 1), MAX_TREFFER)) };
}

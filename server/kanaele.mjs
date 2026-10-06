// server/kanaele.mjs — Kanal-Verwaltung + Gelesen/Ungelesen (1.1).
// Reihenfolge, Anzeigenamen, Archiv und Stumm liegen GLOBAL in einer kleinen JSON-Zeile (eine Instanz =
// ein Betreiber mit mehreren Geräten, wie im Mutterschiff). Gelesen-Marker je Kanal ebenfalls global.
// Reine Logik (saeubern/sortieren/verschieben/zaehlen) ist ohne DB testbar; die DB-Hilfen sind dünn.
import { nowIso } from './db.mjs';

export const MAX_KANAELE = 200;
const NAME_RE = /[^a-z0-9_-]/gi;
export const kanalName = (k) => String(k || '').replace(NAME_RE, '').slice(0, 60);
const liste = (a, max = MAX_KANAELE) => (Array.isArray(a) ? [...new Set(a.map(kanalName).filter(Boolean))].slice(0, max) : null);

/** Leere Einstellungen — immer dieselbe Form. */
export const leereEinstellungen = () => ({ reihenfolge: [], archiviert: [], stumm: [], namen: {} });

/** Patch auf bestehende Einstellungen anwenden — nur saubere Werte kommen durch.
 *  Listen (reihenfolge/archiviert/stumm) werden komplett ersetzt, wenn sie als Array kommen;
 *  `namen` wird gemischt: leerer Name = Anzeigename löschen (Kanal-Key bleibt immer). */
export function einstellungenSaeubern(alt, patch = {}) {
  const e = { ...leereEinstellungen(), ...(alt && typeof alt === 'object' ? alt : {}) };
  e.namen = e.namen && typeof e.namen === 'object' ? { ...e.namen } : {};
  for (const feld of ['reihenfolge', 'archiviert', 'stumm']) {
    const l = liste(patch[feld]);
    if (l) e[feld] = l; else if (!Array.isArray(e[feld])) e[feld] = [];
  }
  if (patch.namen && typeof patch.namen === 'object') {
    for (const [k, v] of Object.entries(patch.namen)) {
      const kanal = kanalName(k); if (!kanal) continue;
      const name = String(v == null ? '' : v).replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name) e.namen[kanal] = name; else delete e.namen[kanal];
    }
  }
  return { reihenfolge: e.reihenfolge, archiviert: e.archiviert, stumm: e.stumm, namen: e.namen };
}

/** Kanäle (oder Fenster) nach der gespeicherten Reihenfolge sortieren: bekannte zuerst in Wunsch-Order,
 *  unbekannte dahinter in ihrer bisherigen Reihenfolge. Jeder Eintrag bekommt anzeige/archiviert/stumm. */
export function kanaeleSortieren(eintraege, einstellungen) {
  const e = einstellungenSaeubern(einstellungen);
  const pos = new Map(e.reihenfolge.map((k, i) => [k, i]));
  const arch = new Set(e.archiviert), stumm = new Set(e.stumm);
  return (eintraege || []).map((x, i) => ({
    ...x,
    anzeige: e.namen[x.name] || x.label || x.name,
    archiviert: arch.has(x.name),
    stumm: stumm.has(x.name),
    _i: i,
  })).sort((a, b) => {
    const pa = pos.has(a.name) ? pos.get(a.name) : 1e6 + a._i, pb = pos.has(b.name) ? pos.get(b.name) : 1e6 + b._i;
    return pa - pb;
  }).map(({ _i, ...x }) => x);
}

/** Einen Kanal in der Reihenfolge einen Platz nach oben (-1) oder unten (+1) schieben.
 *  `alle` = die sichtbare Reihenfolge der Namen (Ergebnis von kanaeleSortieren), damit auch Kanäle ohne
 *  gespeicherte Position verschoben werden können. Liefert die neue komplette Reihenfolge. */
export function reihenfolgeVerschieben(alle, kanal, richtung) {
  const namen = liste(alle) || [];
  const i = namen.indexOf(kanalName(kanal));
  const j = i + (richtung < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= namen.length) return namen;
  [namen[i], namen[j]] = [namen[j], namen[i]];
  return namen;
}

/** Kanal an eine Stelle ziehen (Drag & Drop): `vor` = Name des Kanals, vor dem er landen soll (leer = ans Ende). */
export function reihenfolgeZiehen(alle, kanal, vor = '') {
  const namen = (liste(alle) || []).filter((k) => k !== kanalName(kanal));
  const k = kanalName(kanal); if (!k) return namen;
  const i = vor ? namen.indexOf(kanalName(vor)) : -1;
  if (i < 0) namen.push(k); else namen.splice(i, 0, k);
  return namen;
}

/** Ungelesen-Zahlen aus Rohzeilen: `zeilen` = [{kanal, id, von}] aller Kandidaten, `gelesen` = {kanal: bis},
 *  `stumm` = Liste. Eigene Nachrichten (von === ich) zählen nie, stumme Kanäle liefern 0, Summe dazu. */
export function ungelesenZaehlen(zeilen, gelesen = {}, stumm = [], ich = '') {
  const st = new Set(liste(stumm) || []);
  const counts = {};
  for (const z of zeilen || []) {
    if (!z || !z.kanal || st.has(z.kanal)) continue;
    if (ich && z.von === ich) continue;
    if (Number(z.id) <= (Number(gelesen[z.kanal]) || 0)) continue;
    counts[z.kanal] = (counts[z.kanal] || 0) + 1;
  }
  return { counts, gesamt: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/** Neuen Marker bestimmen: normal nur nach vorn (monoton), mit `force` auch zurück („ab hier ungelesen“). */
export function markerNeu(alt, bis, force = false) {
  const b = Math.floor(Number(bis));
  if (!Number.isFinite(b) || b < 0) return null;
  const a = Number(alt) || 0;
  return force || b > a ? b : a;
}

// ── DB ──────────────────────────────────────────────────────────────────────
/** Schema additiv/idempotent — hier statt in db.mjs, damit das Modul für sich steht. */
export function schemaSicherstellen(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS einstellungen (
      schluessel TEXT PRIMARY KEY,
      wert TEXT NOT NULL,
      stand_am TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gelesen (
      kanal TEXT PRIMARY KEY,
      bis INTEGER NOT NULL DEFAULT 0,
      stand_am TEXT NOT NULL
    );
  `);
}
export function einstellungenLaden(db) {
  schemaSicherstellen(db);
  const z = db.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'kanaele'").get();
  let d = {}; try { d = z ? JSON.parse(z.wert) : {}; } catch { d = {}; }
  return einstellungenSaeubern(d);
}
export function einstellungenSpeichern(db, patch = {}) {
  const neu = einstellungenSaeubern(einstellungenLaden(db), patch);
  db.prepare("INSERT INTO einstellungen (schluessel, wert, stand_am) VALUES ('kanaele', ?, ?) ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert, stand_am = excluded.stand_am")
    .run(JSON.stringify(neu), nowIso());
  return neu;
}
export function gelesenLaden(db) {
  schemaSicherstellen(db);
  return Object.fromEntries(db.prepare('SELECT kanal, bis FROM gelesen').all().map((z) => [z.kanal, z.bis]));
}
/** Marker setzen; liefert den gültigen Marker oder null bei unbrauchbarer Eingabe. */
export function gelesenSetzen(db, kanal, bis, { force = false } = {}) {
  schemaSicherstellen(db);
  const k = kanalName(kanal); if (!k) return null;
  const alt = db.prepare('SELECT bis FROM gelesen WHERE kanal = ?').get(k);
  const neu = markerNeu(alt ? alt.bis : 0, bis, force);
  if (neu == null) return null;
  db.prepare('INSERT INTO gelesen (kanal, bis, stand_am) VALUES (?, ?, ?) ON CONFLICT(kanal) DO UPDATE SET bis = excluded.bis, stand_am = excluded.stand_am').run(k, neu, nowIso());
  return neu;
}
/** Ungelesen je Kanal: nur Kanäle aus `kanaele`, Nachrichten nach dem Marker, ohne eigene, stumme = 0.
 *  Eine Abfrage für alle Kanäle (kein Request-Sturm). */
export function ungelesen(db, { kanaele = [], ich = '', stumm = null } = {}) {
  const gelesen = gelesenLaden(db);
  const e = stumm ? { stumm } : einstellungenLaden(db);
  const namen = liste(kanaele) || [];
  if (!namen.length) return { counts: {}, gesamt: 0, gelesen };
  const zeilen = [];
  const st = db.prepare('SELECT id, von FROM messages WHERE kanal = ? AND id > ?');
  for (const k of namen) {
    if ((e.stumm || []).includes(k)) continue;
    for (const z of st.all(k, Number(gelesen[k]) || 0)) zeilen.push({ kanal: k, id: z.id, von: z.von });
  }
  return { ...ungelesenZaehlen(zeilen, gelesen, e.stumm, ich), gelesen };
}

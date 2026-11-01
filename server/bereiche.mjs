// server/bereiche.mjs — Bereiche (1.3).
//
// Ein Bereich ist eine Vorlage für Fenster: Ort, Ordner (oder Repo mit eigenem Worktree je Fenster) und optional ein
// erster Satz. Je Bereich gibt es zwei Fensterarten, beide starten mit einem Klick im Auto-Modus:
//   🔨 Bau    — normales Baufenster, darf alles (Worktree wie im Bereich eingestellt). Name „<kürzel>-bau-<n>", Anzeige „Bau <n>".
//   💬 Wissen — liest, erklärt, beantwortet Fragen, baut nichts. Kein Worktree (liest im Ordner/Repo selbst), Start-Text
//               mit der Regel, dazu hart: Claude Code startet mit --disallowedTools (Edit/Write/… gesperrt, orte.mjs).
//               Name „<kürzel>-wissen-<n>", Anzeige „Wissen <n>".
// <n> ist die kleinste freie Zahl je Bereich und Art. Das Kürzel macht die Namen über Bereiche hinweg eindeutig; in der
// Kanalliste stehen die Fenster unter der Bereichs-Überschrift, darum reicht dort „Bau 1".
//
// Aufbau wie die anderen Module: reine Logik oben (ohne DB, ohne Uhr), dünne DB-Hilfen in der Mitte (Schema additiv +
// idempotent), unten die Routen mit injizierten Abhängigkeiten (fensterBauen, lebt, broadcast) — so ohne tmux testbar.
import { nowIso } from './db.mjs';
import { slug } from './protokoll.mjs';

export const NAME_MAX = 40;
export const KUERZEL_MAX = 16;
export const ORDNER_MAX = 400;
export const START_TEXT_MAX = 3900;
export const ARTEN = ['bau', 'wissen'];
export const ART_LABEL = { bau: 'Bau', wissen: 'Wissen' };
/** Regel für Wissensfenster (Start-Text). Die harte Sperre setzt orte.mjs (WISSEN_GESPERRT). */
export const WISSEN_HINWEIS = 'Du bist ein Wissensfenster: du darfst nichts bauen — keine Dateien ändern, nichts committen, nichts deployen, keine Befehle mit Wirkung; nur lesen, erklären, Fragen beantworten. Soll gebaut werden, sag, dass ein Baufenster das übernimmt. Lies dich kurz ein (CLAUDE.md, README) und melde dich in einem Satz startklar.';
export const ORT_RE = /^(lokal|ssh:[^\s;|&$`'"<>]{1,118}|geraet:[a-z0-9-]{1,40})$/;

const einzeilig = (s, max) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ── Reine Logik ──────────────────────────────────────────────────────────────
/** Kürzel aus dem Namen: Slug, höchstens 16 Zeichen, ohne Ziffern-Ende (sonst liest sich „web2-3" schief). */
export function kuerzelAus(name) {
  const s = slug(einzeilig(name, NAME_MAX)).slice(0, KUERZEL_MAX).replace(/-+$/g, '');
  const k = s.replace(/[-0-9]+$/g, '') || s;
  return k && k !== 'thema' ? k : 'fenster';
}
/** Ein vom Menschen getipptes Kürzel säubern (gleiche Regeln wie Fensternamen). Leer → ''. */
export function kuerzelSauber(k) {
  if (k == null || String(k).trim() === '') return '';
  return slug(String(k)).slice(0, KUERZEL_MAX).replace(/-+$/g, '').replace(/[-0-9]+$/g, '') || '';
}

/**
 * Eingabe für Anlegen/Ändern säubern und prüfen. Einen Start-Modus gibt es nicht: Fenster laufen immer im Auto-Modus.
 * @param e       rohe Eingabe {name, kuerzel, ort, ordner, repo, worktree, start_text, rang}
 * @param opt.alt bestehender Bereich (beim Ändern) — fehlende Felder bleiben dann wie sie sind
 * @param opt.istRepo (ordner) → bool — entscheidet den Worktree-Standard, wenn worktree nicht angegeben ist
 * @returns {ok, bereich} mit vollständigen Feldern oder {ok:false, fehler}
 */
export function bereichSaeubern(e = {}, { alt = null, istRepo = () => false } = {}) {
  const b = alt ? { ...alt } : { name: '', kuerzel: '', ort: 'lokal', ordner: '', worktree: 0, start_text: '', rang: 0 };
  if (e.name !== undefined || !alt) {
    const n = einzeilig(e.name, NAME_MAX).replace(/[<>"]/g, '');
    if (!n) return { ok: false, fehler: 'Name fehlt.' };
    b.name = n;
  }
  if (e.kuerzel !== undefined || !alt) b.kuerzel = kuerzelSauber(e.kuerzel) || (alt && e.kuerzel === undefined ? b.kuerzel : kuerzelAus(b.name));
  if (e.ort !== undefined) {
    const o = String(e.ort || 'lokal').trim();
    if (!ORT_RE.test(o)) return { ok: false, fehler: 'Ort ungültig (lokal, ssh:user@rechner oder geraet:<id>).' };
    b.ort = o;
  }
  // Ordner ODER Repo: ein Repo heißt „eigener Worktree je Fenster" (Standard an); ein Ordner ohne Angabe bekommt den
  // Worktree, wenn er ein git-Repo ist (nur lokal — auf anderen Rechnern legt der Chat keine Worktrees an).
  const repo = e.repo !== undefined ? String(e.repo ?? '').trim() : '';
  if (repo) { b.ordner = repo.slice(0, ORDNER_MAX); b.worktree = e.worktree === undefined ? 1 : (wahr(e.worktree) ? 1 : 0); }
  else if (e.ordner !== undefined) {
    b.ordner = String(e.ordner ?? '').trim().slice(0, ORDNER_MAX);
    if (e.worktree === undefined) b.worktree = b.ordner && b.ort === 'lokal' && istRepo(b.ordner) ? 1 : 0;
  }
  if (!repo && e.worktree !== undefined) b.worktree = wahr(e.worktree) ? 1 : 0;
  if (b.ordner && !b.ordner.startsWith('/') && !b.ordner.startsWith('~')) return { ok: false, fehler: 'Ordner bitte als vollen Pfad (/… oder ~/…).' };
  if (b.ort !== 'lokal') b.worktree = 0;
  if (e.start_text !== undefined) b.start_text = String(e.start_text ?? '').replace(/\r/g, '').trim().slice(0, START_TEXT_MAX);
  if (e.rang !== undefined) { const r = Math.floor(Number(e.rang)); b.rang = Number.isFinite(r) ? r : 0; }
  return { ok: true, bereich: b };
}
const wahr = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

export const artSauber = (a) => (ARTEN.includes(a) ? a : 'bau');

/**
 * Nächster Fenstername eines Bereichs: „<kürzel>-<art>-<n>" mit der kleinsten freien Zahl ab 1 (je Bereich und Art).
 * belegt(name) → true, wenn es den Namen schon gibt (Fenster-Registry, aktive Kanäle).
 */
export function naechsterName(kuerzel, art = 'bau', belegt = () => false, max = 999) {
  const k = kuerzelSauber(kuerzel) || 'fenster', a = artSauber(art);
  for (let n = 1; n <= max; n++) { const name = `${k}-${a}-${n}`; if (!belegt(name)) return { name, n, art: a }; }
  return null;
}

/** Angaben für fensterBauen aus einem Bereich (+ Art, optional eigener Start-Text). Modus immer auto. */
export function fensterAngaben(bereich, { name, n, art = 'bau', start_text } = {}) {
  const a = artSauber(art);
  const b = { name, label: `${ART_LABEL[a]} ${n}`, ort: bereich.ort || 'lokal', start_modus: 'auto', bereich_id: bereich.id, art: a };
  const eigen = start_text !== undefined && String(start_text).trim() ? String(start_text).trim().slice(0, START_TEXT_MAX) : '';
  const text = a === 'wissen' ? [WISSEN_HINWEIS, eigen].filter(Boolean).join('\n\n') : (eigen || bereich.start_text);
  if (text) b.start_text = text;
  // Wissen liest nur: kein eigener Worktree, sondern der Ordner bzw. der Repo-Hauptordner selbst.
  if (bereich.ordner) { if (a === 'bau' && bereich.worktree && b.ort === 'lokal') b.repo = bereich.ordner; else b.ordner = bereich.ordner; }
  return b;
}

/** Löschen erlaubt? Nicht, solange ein Fenster des Bereichs läuft. lebt(f) → bool (Konsole). */
export function loeschenPruefen(bereichId, fenster = [], lebt = () => false) {
  const dran = fenster.filter((f) => Number(f.bereich_id) === Number(bereichId));
  const laufend = dran.filter((f) => f.status === 'laeuft' || f.status === 'schliesst' || lebt(f));
  if (laufend.length) return { ok: false, status: 409, fehler: `Im Bereich ${laufend.length === 1 ? 'läuft noch ein Fenster' : `laufen noch ${laufend.length} Fenster`} (${laufend.map((f) => f.label || f.name).join(', ')}) — erst schließen.` };
  return { ok: true, loesen: dran.map((f) => f.name) };
}

/** Kurzbeschreibung für den Knopf: „Dieser Server · projekt (Worktree)". orte: {id → Name} der Geräte. */
export function ortText(ort, geraeteNamen = {}) {
  const o = String(ort || 'lokal');
  if (o === 'lokal') return 'Dieser Server';
  if (o.startsWith('ssh:')) return o.slice(4);
  if (o.startsWith('geraet:')) return geraeteNamen[o.slice(7)] || 'Gerät';
  return o;
}

// ── Datenbank (Schema additiv + idempotent) ─────────────────────────────────
export function bereicheSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bereiche (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kuerzel TEXT NOT NULL,
    ort TEXT DEFAULT 'lokal',           -- lokal | ssh:<host> | geraet:<id>
    ordner TEXT DEFAULT '',             -- Arbeitsordner oder Repo (leer = Standard des Servers)
    worktree INTEGER DEFAULT 0,         -- 1 = je Baufenster ein eigener git-Worktree im Repo „ordner"
    start_text TEXT DEFAULT '',
    rang INTEGER DEFAULT 0,
    erstellt_am TEXT NOT NULL,
    stand_am TEXT NOT NULL
  )`);
  try { db.exec('ALTER TABLE fenster ADD COLUMN bereich_id INTEGER'); } catch { /* existiert schon */ }
  try { db.exec("ALTER TABLE fenster ADD COLUMN art TEXT DEFAULT ''"); } catch { /* existiert schon; '' = Bau (wie bis 1.2) */ }
}
const FELDER = ['name', 'kuerzel', 'ort', 'ordner', 'worktree', 'start_text', 'rang'];
export function bereichHolen(db, id) { return db.prepare('SELECT * FROM bereiche WHERE id = ?').get(Number(id) || 0) || null; }
export function bereicheAlle(db) { return db.prepare('SELECT * FROM bereiche ORDER BY rang, id').all(); }
export function bereichAnlegen(db, eingabe = {}, opt = {}) {
  const r = bereichSaeubern(eingabe, opt); if (!r.ok) return r;
  const b = r.bereich;
  if (eingabe.rang === undefined) b.rang = (db.prepare('SELECT COALESCE(MAX(rang), 0) AS m FROM bereiche').get().m || 0) + 1;
  const t = nowIso();
  const x = db.prepare(`INSERT INTO bereiche (${FELDER.join(', ')}, erstellt_am, stand_am) VALUES (${FELDER.map(() => '?').join(', ')}, ?, ?)`)
    .run(...FELDER.map((k) => b[k]), t, t);
  return { ok: true, bereich: bereichHolen(db, x.lastInsertRowid) };
}
export function bereichAendern(db, id, patch = {}, opt = {}) {
  const alt = bereichHolen(db, id); if (!alt) return { ok: false, status: 404, fehler: 'Bereich unbekannt.' };
  const r = bereichSaeubern(patch, { ...opt, alt }); if (!r.ok) return r;
  db.prepare(`UPDATE bereiche SET ${FELDER.map((k) => `${k} = ?`).join(', ')}, stand_am = ? WHERE id = ?`).run(...FELDER.map((k) => r.bereich[k]), nowIso(), alt.id);
  return { ok: true, bereich: bereichHolen(db, alt.id) };
}
/** Löschen (mit Sperre). Fenster ohne laufende Sitzung verlieren nur die Zuordnung (landen unter „Weitere Fenster"). */
export function bereichLoeschen(db, id, { fenster = [], lebt = () => false } = {}) {
  const b = bereichHolen(db, id); if (!b) return { ok: false, status: 404, fehler: 'Bereich unbekannt.' };
  const p = loeschenPruefen(b.id, fenster, lebt); if (!p.ok) return p;
  db.prepare('UPDATE fenster SET bereich_id = NULL WHERE bereich_id = ?').run(b.id);
  db.prepare('DELETE FROM bereiche WHERE id = ?').run(b.id);
  return { ok: true, geloest: p.loesen };
}
export function fensterBereichSetzen(db, name, id, art = null) {
  db.prepare('UPDATE fenster SET bereich_id = ? WHERE name = ?').run(id == null ? null : Number(id), String(name || ''));
  if (art != null) db.prepare('UPDATE fenster SET art = ? WHERE name = ?').run(artSauber(art), String(name || ''));
}
/** Kanal-Anzeige für Suche/Archiv: „<Bereich> · Bau 1" (in der Liste reicht „Bau 1" unter der Überschrift). */
export function kanalLabelSetzen(db, name, label) { db.prepare('UPDATE channels SET label = ? WHERE name = ?').run(String(label || '').slice(0, 120), String(name || '')); }

// ── Dienst + Routen ──────────────────────────────────────────────────────────
/**
 * @param deps.db, deps.fensterBauen (Angaben → {ok, fenster, start}), deps.fensterAlle (() → Fenster),
 *        deps.belegt (name → bool: Fenster/aktiver Kanal), deps.lebt (f → bool), deps.istRepo (ordner → bool),
 *        deps.standard (() → {ordner, repo}) für das Formular, deps.broadcast
 */
export function createBereicheDienst({ db, fensterBauen, fensterAlle, belegt = () => false, lebt = () => false, istRepo = () => false, standard = () => ({}), broadcast = () => {} } = {}) {
  bereicheSchema(db);
  const geaendert = () => broadcast('presence', { bereiche: true });

  /** Ein Fenster in einem Bereich starten (Name automatisch, Art bau|wissen). */
  function fensterStarten(id, { start_text, art = 'bau' } = {}) {
    const b = bereichHolen(db, id); if (!b) return { ok: false, status: 404, fehler: 'Bereich unbekannt.' };
    const nn = naechsterName(b.kuerzel, art, belegt); if (!nn) return { ok: false, status: 409, fehler: 'Keine freie Nummer mehr in diesem Bereich.' };
    const angaben = fensterAngaben(b, { ...nn, start_text });
    let r; try { r = fensterBauen(angaben); } catch (e) { r = { ok: false, fehler: String((e && e.message) || e) }; }
    if (!r || !r.ok) return { ok: false, status: 400, fehler: (r && r.fehler) || 'Fenster ging nicht.' };
    kanalLabelSetzen(db, r.fenster.name, `${b.name} · ${angaben.label}`);
    broadcast('presence', { fenster: r.fenster.name, neu: true });
    return { ok: true, fenster: r.fenster, start: r.start, bereich: b };
  }

  async function route({ req, res, url, admin, json, koerper }) {
    const p = url.pathname;
    const antwort = (r) => { const { status = r.ok ? 200 : 400, ...rest } = r; json(res, status, rest); return true; };
    if (p === '/api/bereiche' && req.method === 'GET') return antwort({ ok: true, bereiche: bereicheAlle(db), standard: standard() });
    if (!admin) return antwort({ status: 403, ok: false, fehler: 'Nur Admin ändert Bereiche.' });
    if (p === '/api/bereiche' && req.method === 'POST') {
      const b = await koerper(req);
      const r = bereichAnlegen(db, b, { istRepo }); if (!r.ok) return antwort(r);
      geaendert();
      if (b.starten === true || ARTEN.includes(b.starten)) { const s = fensterStarten(r.bereich.id, { art: b.starten === true ? 'bau' : b.starten }); return antwort({ ...s, status: s.ok ? 200 : s.status, bereich: r.bereich }); }
      return antwort(r);
    }
    const m = /^\/api\/bereiche\/(\d+)(?:\/(loeschen|fenster))?$/.exec(p);
    if (!m || req.method !== 'POST') return antwort({ status: 404, ok: false, fehler: 'Unbekannter Endpunkt.' });
    const b = await koerper(req);
    if (!m[2]) { const r = bereichAendern(db, m[1], b, { istRepo }); if (r.ok) geaendert(); return antwort(r); }
    if (m[2] === 'loeschen') { const r = bereichLoeschen(db, m[1], { fenster: fensterAlle(), lebt }); if (r.ok) geaendert(); return antwort(r); }
    return antwort(fensterStarten(m[1], { start_text: b.start_text, art: b.art }));
  }

  return { route, fensterStarten, alle: () => bereicheAlle(db), holen: (id) => bereichHolen(db, id) };
}

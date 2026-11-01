// server/aufgaben.mjs — Aufgaben mit Zeit (1.2).
//
// Eine Aufgabe ist Arbeit, die ein Fenster am Stück erledigt: „▶ Starten" legt ein frisches Fenster (Kanal) mit dem
// Auftrag als Start-Text an, die Zeit läuft mit. Ein Sampler (alle 20 s, im Server-Takt) ordnet jeden Takt zu:
// Mensch aktiv (eigene Nachricht im Kanal in den letzten 60 s) · Claude aktiv (laufende Klammer-Zeit im Terminalbild,
// dieselbe Erkennung wie die Lampen) · Warten auf den Menschen (Rückfrage/Freigabe offen) · Leerlauf · Pause.
// Abschluss: das Fenster schreibt „✅ Aufgabe fertig: <Ergebnis>", der Mensch klickt „Fertig" — oder er schließt den
// Kanal (Kanal zu = Aufgabe erledigt). Dann kommt die Abschluss-Karte mit der Dauer in den Kanal.
// Stopp = zurück in die Liste: Zeit und Stand (letzte Nachrichten) bleiben, „Weiter" im alten Fenster oder in einem
// neuen mit dem Stand im Start-Text.
//
// Aufbau wie die anderen Module: reine Logik oben (Zeit immer als Parameter jetztMs, keine Uhr), dünne DB-Hilfen
// in der Mitte (Schema additiv + idempotent, hier gehalten), unten der Dienst (Start/Stopp/Takt/Routen) mit
// injizierten Abhängigkeiten — so ist auch der Ablauf ohne tmux testbar.
import { senden, fensterHolen, fensterAlle, karteHolen, karteVerlauf, letzteNachrichtId } from './db.mjs';
import { slug } from './protokoll.mjs';

export const STATUS = ['geplant', 'laeuft', 'pausiert', 'fertig', 'abgebrochen'];
export const OFFEN = ['geplant', 'laeuft', 'pausiert'];
export const ZEIT_FELDER = ['mensch_aktiv_s', 'claude_aktiv_s', 'warten_mensch_s', 'leerlauf_s', 'pause_s'];
export const TAKT_S = 20;
export const MENSCH_AKTIV_S = 60;
export const NACHHOL_MS = 6 * 3600_000;     // Autostart: verpasste Starts (Server war aus) älter als 6 h starten nicht mehr
export const FERTIG_SATZ = '✅ Aufgabe fertig:';
export const TITEL_MAX = 160;
export const BESCHREIBUNG_MAX = 4000;
export const LABEL_MAX = 24;
export const STAND_MAX = 1500;
export const START_TEXT_MAX = 3900;         // fensterAnlegen kappt bei 4000
export const LEISTE_MAX = 5;

// ── Reine Logik ─────────────────────────────────────────────────────────────
const iso = (ms) => new Date(ms).toISOString();
const istIso = (s) => !!s && Number.isFinite(Date.parse(String(s)));
const sek = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0; };
const einzeilig = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const leereZeiten = () => ({ mensch_aktiv_s: 0, claude_aktiv_s: 0, warten_mensch_s: 0, leerlauf_s: 0, pause_s: 0 });

/** Kalendertag (YYYY-MM-DD) in einer Zeitzone. */
export function tagIn(ms, zone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(new Date(ms));
}
const uhrzeitIn = (ms, zone) => new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/** Freies Label (optional): kurz, ohne Steuerzeichen/Spitzklammern. */
export const labelSauber = (s) => einzeilig(s, LABEL_MAX).replace(/[<>"]/g, '');

/** Eingaben für Anlegen/Ändern säubern. Nur bekannte Felder kommen durch; undefined = nicht angefasst. */
export function eingabeSaeubern(e = {}) {
  const raus = {};
  if (e.titel !== undefined) { const t = einzeilig(e.titel, TITEL_MAX); if (t) raus.titel = t; }
  if (e.beschreibung !== undefined) raus.beschreibung = String(e.beschreibung ?? '').replace(/\r/g, '').trim().slice(0, BESCHREIBUNG_MAX);
  if (e.label !== undefined) raus.label = labelSauber(e.label);
  for (const k of ['faellig_am', 'start_um']) if (e[k] !== undefined) raus[k] = istIso(e[k]) ? iso(Date.parse(e[k])) : null;
  if (e.erst_fragen !== undefined) raus.erst_fragen = e.erst_fragen === false || e.erst_fragen === 0 || e.erst_fragen === '0' ? 0 : 1;
  if (e.ort !== undefined) raus.ort = /^(lokal|ssh:\S{1,118}|geraet:[a-z0-9-]{1,40})$/.test(String(e.ort || '')) ? String(e.ort) : '';
  for (const k of ['ordner', 'repo']) if (e[k] !== undefined) raus[k] = String(e[k] ?? '').trim().slice(0, 400);
  for (const k of ['karte_id', 'erinnerung_id']) if (e[k] !== undefined) { const n = Math.floor(Number(e[k])); raus[k] = Number.isFinite(n) && n > 0 ? n : null; }
  return raus;
}

/** DB-Zeile → Objekt (JSON-Felder geparst). */
export function zeileLesen(r) {
  if (!r) return null;
  const json = (s, leer) => { try { const v = JSON.parse(s || ''); return v && typeof v === 'object' ? v : leer; } catch { return leer; } };
  return { ...r, zeiten: { ...leereZeiten(), ...json(r.zeiten, {}) }, tage: json(r.tage, {}), laeufe: json(r.laeufe, []), erst_fragen: r.erst_fragen === 0 ? 0 : 1 };
}

/** Ein Takt → Sekunden je Anteil. Mensch und Claude zugleich zählen in beide; Warten nur, wenn keiner arbeitet. */
export function sampleZuordnen({ claude_busy = false, mensch_aktiv = false, rueckfrage_offen = false, pause = false } = {}, dt_s = TAKT_S) {
  const z = leereZeiten(); const dt = sek(dt_s);
  if (!dt) return z;
  if (pause) { z.pause_s = dt; return z; }
  if (mensch_aktiv) z.mensch_aktiv_s = dt;
  if (claude_busy) z.claude_aktiv_s = dt;
  if (!mensch_aktiv && !claude_busy) { if (rueckfrage_offen) z.warten_mensch_s = dt; else z.leerlauf_s = dt; }
  return z;
}
export function zeitenAddieren(a = {}, b = {}) {
  const z = leereZeiten();
  for (const k of ZEIT_FELDER) z[k] = sek(a && a[k]) + sek(b && b[k]);
  return z;
}
export function zeitenSummen(zeiten = {}) {
  const z = zeitenAddieren(zeiten, {});
  return { ...z, aktiv_s: z.mensch_aktiv_s + z.claude_aktiv_s, gesamt_s: ZEIT_FELDER.reduce((s, k) => s + z[k], 0) };
}

/** Dauer des nächsten Samples: seit dem letzten, höchstens 2 Takte (ein Hänger zählt nicht stundenlang), nie negativ. */
export function naechstesSample(letztes, jetztMs, taktS = TAKT_S) {
  const t = Date.parse(String(letztes || ''));
  if (!Number.isFinite(t)) return taktS;
  const dt = (jetztMs - t) / 1000;
  return dt > 0 ? Math.round(Math.min(dt, 2 * taktS)) : 0;
}

/** War der Mensch in den letzten fensterS Sekunden aktiv? (bis 2 Min „Zukunft" = Uhren-Abweichung) */
export function menschAktiv(letzteMs, jetztMs, fensterS = MENSCH_AKTIV_S) {
  const t = Number(letzteMs);
  if (!Number.isFinite(t) || t <= 0) return false;
  const d = jetztMs - t;
  return d >= -120_000 && d <= fensterS * 1000;
}

/** Jüngste Nachricht des Menschen in einer Kanal-Liste: nicht vom Fenster selbst, nicht vom Server, keine Automatik
 *  (typ 'task' = in seinem Namen weitergereicht, 'system'/'answer'/'question'/'error'/'done' = Spiegel/Server). */
export function letzteMenschMs(msgs = [], eigeneNamen = []) {
  let max = NaN;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || m.typ !== 'fyi' || m.von === 'flottenchat' || eigeneNamen.includes(m.von)) continue;
    const t = Date.parse(String(m.erstellt_am || ''));
    if (Number.isFinite(t) && !(t <= max)) max = t;
  }
  return max;
}

/** Ein Sampler-Schritt für eine Aufgabe. beob = {lebt, claude_busy, dialog_art, letzteMenschMs}. → {zeiten, dt_s} | null */
export function sampleFuerAufgabe(a = {}, beob = {}, jetztMs = 0) {
  if (!a || (a.status !== 'laeuft' && a.status !== 'pausiert')) return null;
  if (!beob || !beob.lebt) return null;
  const dt_s = naechstesSample(a.letztes_sample, jetztMs);
  const zeiten = sampleZuordnen({
    claude_busy: !!beob.claude_busy,
    mensch_aktiv: menschAktiv(beob.letzteMenschMs, jetztMs),
    rueckfrage_offen: ['frage', 'freigabe', 'absenden'].includes(beob.dialog_art),
    pause: a.status === 'pausiert',
  }, dt_s);
  return { zeiten, dt_s };
}

/** Fertig-Satz in einer Fenster-Antwort finden → Ergebnis-Text (Rest der Zeile) oder null. */
export function fertigSatzErkennen(text) {
  const s = String(text || '');
  if (!s.includes(FERTIG_SATZ)) return null;
  for (const roh of s.split(/\r?\n/)) {
    const zeile = roh.replace(/^[\s>*_`\-•"„“]+/, '').trimEnd();
    if (!zeile.startsWith(FERTIG_SATZ)) continue;
    return zeile.slice(FERTIG_SATZ.length).replace(/[\s*_`"“”]+$/, '').trim();
  }
  return null;
}

/** Pflicht-Absatz der Standard-Vorlage: erst Lage + Empfehlung + Rückfrage, kein Alleingang. Abschaltbar je Aufgabe
 *  (erst_fragen) oder als Standard per FC_AUFGABEN_ERST_FRAGEN=0. */
export const ERST_FRAGEN = 'ZUERST, bevor du irgendetwas änderst: Lage lesen (Code, Stand, Unterlagen), dann in einem Satz sagen, worum es geht, und je Punkt (nummeriert) kurz: Ist (geprüfter Stand) → Soll (was gewünscht ist) → Weg (deine Empfehlung). Nenn fehlende Abhängigkeiten oder Lücken, ohne die nur ein Teil des Nutzens ankommt. Dann EINE AskUserQuestion mit deiner Empfehlung als erster Option. Erst nach der Antwort bauen, senden oder antworten.';

/** Start-Text fürs Fenster: Auftrag + (optional) Stand aus dem letzten Lauf + Vorlage + Regeln. Passt immer in START_TEXT_MAX. */
export function startText(a = {}, { erstFragen = true, karteTitel = '' } = {}) {
  const regeln = [
    'Regeln für diese Aufgabe:',
    '- Genau diese eine Aufgabe, am Stück. Kein zweites Thema.',
    `- Stand am Ende an die feste Stelle schreiben${a.karte_id ? ` (Verlaufs-Eintrag an Board-Karte #${a.karte_id}${karteTitel ? ` „${einzeilig(karteTitel, 80)}“` : ''})` : ' (Board-Karte, falls es eine gibt; Repo, CLAUDE.md)'}.`,
    `- Zum Schluss GENAU EINE Zeile „${FERTIG_SATZ} <Ergebnis in einem Satz>“ — damit stoppt die Zeitmessung. Erst, wenn die Aufgabe wirklich fertig ist, und als letzte Nachricht ohne Werkzeug-Aufruf danach.`,
    '- Rückfragen immer als AskUserQuestion.',
  ].join('\n');
  const kopf = `🎯 Aufgabe: ${a.titel || ''}${a.label ? ` [${a.label}]` : ''}`;
  const vorlage = (erstFragen && a.erst_fragen !== 0) ? ERST_FRAGEN : '';
  const fest = [kopf, vorlage, regeln].filter(Boolean).join('\n\n');
  let platz = START_TEXT_MAX - fest.length - 40;
  const teile = [];
  const stand = String(a.stand_text || '').trim();
  if (stand && platz > 200) {
    const s = stand.length > Math.min(STAND_MAX, platz - 160) ? '…' + stand.slice(-(Math.min(STAND_MAX, platz - 160))) : stand;
    const block = `Diese Aufgabe lief schon und wurde gestoppt. Letzter Stand aus dem alten Fenster:\n${s}\n→ Mach dort weiter, fang nicht von vorn an. Prüf den Stand kurz, bevor du ihm glaubst.`;
    teile.push(block); platz -= block.length + 2;
  }
  const b = String(a.beschreibung || '').trim();
  if (b && platz > 40) teile.unshift('Was dahinter steckt:\n' + (b.length > platz - 25 ? b.slice(0, platz - 26) + '…' : b));
  return [kopf, ...teile, vorlage, regeln].filter(Boolean).join('\n\n');
}

/** Fenstername für eine Aufgabe: Slug aus dem Titel, frei gemacht mit -2, -3 … */
export function fensterNameFuer(titel, belegt = () => false) {
  const basis = slug(titel).slice(0, 28) || 'aufgabe';
  let name = basis, n = 2;
  while (belegt(name) && n < 500) name = `${basis}-${n++}`;
  return name;
}
/** Kanal-Anzeige: Titel, gekürzt (die Aufgabe soll in der Kanalliste erkennbar sein). */
export const kanalLabel = (titel) => { const t = einzeilig(titel, TITEL_MAX); return t.length > 40 ? t.slice(0, 39).trimEnd() + '…' : t; };

const minText = (s) => { const m = Math.round(sek(s) / 60); return m < 60 ? `${m} Min` : `${Math.floor(m / 60)} Std ${m % 60} Min`; };
export function textBalken(anteil, breite = 8) {
  const a = Number.isFinite(Number(anteil)) ? Math.min(1, Math.max(0, Number(anteil))) : 0;
  const voll = Math.round(a * breite);
  return '▇'.repeat(voll) + '▁'.repeat(breite - voll);
}

/** Abschluss-Karte als Chat-Text: Dauer aktiv/gesamt, Anteile als Balken, Ergebnis. */
export function abschlussKarte(a = {}, { zone = 'Europe/Berlin', jetztMs = 0 } = {}) {
  const s = zeitenSummen(a.zeiten);
  const pct = (x) => (s.gesamt_s ? Math.round((x / s.gesamt_s) * 100) : 0);
  const erster = (a.laeufe || [])[0];
  const startMs = Date.parse(String((erster && erster.gestartet) || a.gestartet || ''));
  const endMs = Date.parse(String(a.beendet || '')) || jetztMs;
  const spanne = Number.isFinite(startMs) && endMs ? ` · ${uhrzeitIn(startMs, zone)}–${uhrzeitIn(endMs, zone)}` : '';
  const zeilen = [
    `🏁 Aufgabe fertig: ${a.titel || 'Aufgabe'}${spanne}`,
    `Aktiv ${minText(s.aktiv_s)} (du ${minText(s.mensch_aktiv_s)} · Claude ${minText(s.claude_aktiv_s)}) · gesamt ${minText(s.gesamt_s)}${(a.laeufe || []).length ? ` · ${(a.laeufe || []).length + 1} Läufe` : ''}`,
  ];
  const anteile = [['Du', s.mensch_aktiv_s], ['Claude', s.claude_aktiv_s], ['Warten auf dich', s.warten_mensch_s], ['Leerlauf', s.leerlauf_s], ['Pause', s.pause_s]];
  const breit = Math.max(...anteile.map(([n]) => n.length));
  // Balken als Codeblock: im Chat in fester Schrift, damit die Spalten stehen.
  zeilen.push('```');
  for (const [name, wert] of anteile) if (wert > 0 || name === 'Du' || name === 'Claude') zeilen.push(`${name.padEnd(breit)} ${textBalken(s.gesamt_s ? wert / s.gesamt_s : 0)} ${String(pct(wert)).padStart(3)} % · ${minText(wert)}`);
  zeilen.push('```');
  zeilen.push(`Ergebnis: ${String(a.ergebnis || '').trim() || '–'}`);
  return zeilen.join('\n');
}

/** Fälligkeit: ueberfaellig | heute | spaeter | ohne. */
export function faelligStufe(a, jetztMs, zone = 'Europe/Berlin') {
  const f = a && a.faellig_am ? Date.parse(a.faellig_am) : NaN;
  if (!Number.isFinite(f)) return 'ohne';
  if (f <= jetztMs) return 'ueberfaellig';
  return tagIn(f, zone) === tagIn(jetztMs, zone) ? 'heute' : 'spaeter';
}

/** Reihenfolge der offenen Aufgaben (Seitenleiste + „Alle"): überfällig ganz oben, dann läuft/Pause, dann der Rest
 *  in der Reihenfolge, die der Mensch gezogen hat (rang), ohne Rang nach Fälligkeit, dann Anlage. Gezogen wird also
 *  nur innerhalb des Rests — Überfälliges und Laufendes bleiben oben stehen, damit nichts untergeht. */
export function offeneSortieren(liste, jetztMs, zone = 'Europe/Berlin') {
  const gruppe = (a) => (faelligStufe(a, jetztMs, zone) === 'ueberfaellig' ? 0 : a.status === 'laeuft' || a.status === 'pausiert' ? 1 : 2);
  const r = (a) => (Number(a.rang) > 0 ? Number(a.rang) : 1e9);
  const f = (a) => (a.faellig_am ? Date.parse(a.faellig_am) : Infinity);
  return (liste || []).filter((a) => a && OFFEN.includes(a.status))
    .sort((a, b) => gruppe(a) - gruppe(b) || (gruppe(a) === 0 ? f(a) - f(b) : 0) || r(a) - r(b) || f(a) - f(b) || String(a.erstellt_am || '').localeCompare(String(b.erstellt_am || '')) || a.id - b.id);
}

/** Neue Reihenfolge: ids in Wunsch-Reihenfolge → {id: rang 1..n}. Doppelte/leere werden übersprungen. */
export function rangAusIds(ids = []) {
  const pos = {}; let n = 0;
  for (const x of Array.isArray(ids) ? ids : []) { const id = Math.floor(Number(x)); if (id > 0 && !(id in pos)) pos[id] = ++n; }
  return pos;
}

/** Aufgabe zur Uhr eines Fensters — nur die eigene Sitzung zählt: fest gebunden über fenster.aufgabe_id, sonst nur
 *  Aufgaben mit fenster === Name, die NACH dem Anlegen dieses Fensters gestartet wurden (eine Aufgabe aus einer früheren
 *  Sitzung gleichen Namens taucht im frischen Fenster nicht auf). */
export function aufgabeFuersFenster(liste, f) {
  if (!f || !f.name) return null;
  const alle = (liste || []).filter(Boolean);
  if (f.aufgabe_id) { const a = alle.find((x) => x.id === Number(f.aufgabe_id)); if (a) return a; }
  const abMs = Date.parse(String(f.erstellt_am || '')) || 0;
  const gleiche = alle.filter((x) => x.fenster === f.name && (!abMs || (Date.parse(String(x.gestartet || '')) || 0) >= abMs - 60_000))
    .sort((x, y) => String(y.gestartet || '').localeCompare(String(x.gestartet || '')));
  return gleiche.find((x) => x.status === 'laeuft' || x.status === 'pausiert') || null;
}

/** Autostart: welche geplanten Aufgaben sind jetzt dran, welche wurden verpasst (Server war zu lange aus)? */
export function faelligeAutostarts(liste, jetztMs) {
  const starten = [], verpasst = [];
  for (const a of liste || []) {
    if (!a || a.status !== 'geplant' || a.autostart || !a.start_um) continue;
    const um = Date.parse(a.start_um);
    if (!Number.isFinite(um) || um > jetztMs) continue;
    (jetztMs - um < NACHHOL_MS ? starten : verpasst).push(a.id);
  }
  return { starten, verpasst };
}
/** Fälligkeits-Meldung: offene Aufgabe, Fälligkeit erreicht, für genau diese Fälligkeit noch nicht gemeldet. */
export function faelligeMeldungen(liste, jetztMs) {
  return (liste || []).filter((a) => a && OFFEN.includes(a.status) && a.faellig_am && Date.parse(a.faellig_am) <= jetztMs && a.faellig_gemeldet !== a.faellig_am).map((a) => a.id);
}

/** Stand aus den letzten Kanal-Nachrichten („HH:MM von: text"), fürs Weitermachen in einem neuen Fenster. */
export function standAusNachrichten(msgs = [], { zone = 'Europe/Berlin', max = 12 } = {}) {
  return (Array.isArray(msgs) ? msgs : []).filter((m) => m && m.typ !== 'system' && m.inhalt).slice(-max)
    .map((m) => { const t = Date.parse(String(m.erstellt_am || '')); return `${Number.isFinite(t) ? uhrzeitIn(t, zone) + ' ' : ''}${m.von}: ${einzeilig(m.inhalt, 400)}`; })
    .join('\n').slice(-STAND_MAX);
}

/** Erinnerung → Angaben für eine neue Aufgabe (Brücke Erinnerungen → Aufgaben). */
export function ausErinnerung(r) {
  if (!r || !r.titel) return null;
  return { titel: r.titel, beschreibung: r.notiz || '', faellig_am: r.faellig_am || undefined, erinnerung_id: r.id };
}

/** Auswertung: Zeit je Tag (aus den Tages-Töpfen) und je Aufgabe im Zeitraum von…bis (Tage, einschließlich). */
export function auswertung(liste, { von, bis } = {}) {
  const v = String(von || '0000-00-00'), b = String(bis || '9999-99-99');
  const tage = {}; const aufgaben = [];
  for (const a of liste || []) {
    if (!a) continue;
    let summe = leereZeiten(); let drin = false;
    for (const [tag, z] of Object.entries(a.tage || {})) {
      if (tag < v || tag > b) continue;
      drin = true; summe = zeitenAddieren(summe, z);
      const t = (tage[tag] = tage[tag] || { tag, ...leereZeiten(), aufgaben: 0 });
      Object.assign(t, zeitenAddieren(t, z)); t.aufgaben++;
    }
    if (!drin) continue;
    const s = zeitenSummen(summe);
    aufgaben.push({ id: a.id, titel: a.titel, label: a.label || '', status: a.status, aktiv_s: s.aktiv_s, gesamt_s: s.gesamt_s, mensch_aktiv_s: s.mensch_aktiv_s, claude_aktiv_s: s.claude_aktiv_s, warten_s: s.warten_mensch_s + s.leerlauf_s, beendet: a.beendet || null });
  }
  const tageListe = Object.values(tage).map((t) => { const s = zeitenSummen(t); return { tag: t.tag, aufgaben: t.aufgaben, aktiv_s: s.aktiv_s, gesamt_s: s.gesamt_s, mensch_aktiv_s: s.mensch_aktiv_s, claude_aktiv_s: s.claude_aktiv_s, warten_s: s.warten_mensch_s + s.leerlauf_s }; }).sort((x, y) => y.tag.localeCompare(x.tag));
  aufgaben.sort((x, y) => y.aktiv_s - x.aktiv_s);
  const sum = (k) => tageListe.reduce((s, t) => s + t[k], 0);
  return { von: v, bis: b, tage: tageListe, aufgaben, summe: { aktiv_s: sum('aktiv_s'), gesamt_s: sum('gesamt_s'), mensch_aktiv_s: sum('mensch_aktiv_s'), claude_aktiv_s: sum('claude_aktiv_s'), warten_s: sum('warten_s') } };
}

// ── Datenbank (Schema additiv + idempotent) ─────────────────────────────────
export function aufgabenSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aufgaben (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titel TEXT NOT NULL,
    beschreibung TEXT DEFAULT '',
    label TEXT DEFAULT '',              -- freies Label, optional
    status TEXT DEFAULT 'geplant',      -- geplant | laeuft | pausiert | fertig | abgebrochen (Papierkorb)
    rang INTEGER DEFAULT 0,             -- gezogene Reihenfolge, 0 = ohne
    faellig_am TEXT, faellig_gemeldet TEXT,
    start_um TEXT, autostart TEXT DEFAULT '',   -- '' | gestartet | verpasst | fehler: …
    erst_fragen INTEGER DEFAULT 1,      -- Start-Text-Vorlage „erst Lage + Empfehlung + Rückfrage"
    ort TEXT DEFAULT '', ordner TEXT DEFAULT '', repo TEXT DEFAULT '',
    karte_id INTEGER, erinnerung_id INTEGER,
    fenster TEXT DEFAULT '',            -- Fenster des laufenden (oder letzten) Laufs
    gestartet TEXT, beendet TEXT, gestoppt TEXT,
    zeiten TEXT DEFAULT '{}', tage TEXT DEFAULT '{}', letztes_sample TEXT,
    fertig_ab_id INTEGER DEFAULT 0,     -- Fertig-Satz erst in Nachrichten nach dieser ID suchen
    stand_text TEXT DEFAULT '', ergebnis TEXT DEFAULT '', laeufe TEXT DEFAULT '[]',
    erstellt_am TEXT NOT NULL, stand_am TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_aufgaben_status ON aufgaben(status)');
  try { db.exec('ALTER TABLE fenster ADD COLUMN aufgabe_id INTEGER'); } catch { /* existiert schon */ }
}

const SPALTEN = ['titel', 'beschreibung', 'label', 'status', 'rang', 'faellig_am', 'faellig_gemeldet', 'start_um', 'autostart', 'erst_fragen', 'ort', 'ordner', 'repo', 'karte_id', 'erinnerung_id', 'fenster', 'gestartet', 'beendet', 'gestoppt', 'zeiten', 'tage', 'letztes_sample', 'fertig_ab_id', 'stand_text', 'ergebnis', 'laeufe'];
export function aufgabeHolen(db, id) { return zeileLesen(db.prepare('SELECT * FROM aufgaben WHERE id = ?').get(Number(id) || 0)); }
export function aufgabenAlle(db) { return db.prepare('SELECT * FROM aufgaben ORDER BY id').all().map(zeileLesen); }
function setzen(db, id, felder, jetztMs) {
  const k = Object.keys(felder).filter((x) => SPALTEN.includes(x));
  if (k.length) db.prepare(`UPDATE aufgaben SET ${k.map((x) => `${x} = ?`).join(', ')}, stand_am = ? WHERE id = ?`)
    .run(...k.map((x) => { const v = felder[x]; return v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v); }), iso(jetztMs), Number(id));
  return aufgabeHolen(db, id);
}
const fehler = (f) => ({ ok: false, fehler: f });

export function aufgabeAnlegen(db, eingabe = {}, jetztMs, { erstFragenStandard = true } = {}) {
  const e = eingabeSaeubern(eingabe);
  if (!e.titel) return fehler('titel_fehlt');
  const r = db.prepare('INSERT INTO aufgaben (titel, erst_fragen, zeiten, erstellt_am, stand_am) VALUES (?, ?, ?, ?, ?)')
    .run(e.titel, erstFragenStandard ? 1 : 0, JSON.stringify(leereZeiten()), iso(jetztMs), iso(jetztMs));
  return { ok: true, aufgabe: setzen(db, r.lastInsertRowid, e, jetztMs) };
}
export function aufgabeAendern(db, id, patch = {}, jetztMs) {
  const a = aufgabeHolen(db, id); if (!a) return fehler('unbekannt');
  const e = eingabeSaeubern(patch); delete e.erinnerung_id;
  if (e.start_um !== undefined && e.start_um !== a.start_um) e.autostart = ''; // neue Startzeit → wieder scharf
  return { ok: true, aufgabe: setzen(db, a.id, e, jetztMs) };
}
function wechsel(db, id, erlaubt, aendern, jetztMs) {
  const a = aufgabeHolen(db, id); if (!a) return fehler('unbekannt');
  if (!erlaubt.includes(a.status)) return fehler(a.status === 'laeuft' || a.status === 'pausiert' ? 'schon_gestartet' : OFFEN.includes(a.status) ? 'falscher_status' : 'schon_beendet');
  return { ok: true, aufgabe: setzen(db, a.id, aendern(a), jetztMs) };
}
/** Sperre: eine Aufgabe, ein Fenster — läuft sie schon (oder pausiert), gibt es kein zweites. */
export const aufgabeStarten = (db, id, { fenster, fertig_ab_id = 0 }, jetztMs) => wechsel(db, id, ['geplant'], (a) => ({ status: 'laeuft', fenster: String(fenster || ''), gestartet: iso(jetztMs), beendet: null, fertig_ab_id: Number(fertig_ab_id) || 0, letztes_sample: null, ...(a.start_um && !a.autostart ? { autostart: 'gestartet' } : {}) }), jetztMs); // von Hand vor der Startzeit gestartet = Autostart verbraucht
export const aufgabePausieren = (db, id, jetztMs) => wechsel(db, id, ['laeuft'], () => ({ status: 'pausiert' }), jetztMs);
export const aufgabeFortsetzen = (db, id, jetztMs) => wechsel(db, id, ['pausiert'], () => ({ status: 'laeuft' }), jetztMs);
/** Stopp: zurück in die Liste („geplant"), Zeit bleibt, Lauf wird gemerkt, Stand für den nächsten Start. */
export const aufgabeStoppen = (db, id, { stand_text = '' } = {}, jetztMs) => wechsel(db, id, ['laeuft', 'pausiert'], (a) => ({
  status: 'geplant', gestoppt: iso(jetztMs), fenster: '', letztes_sample: null,
  laeufe: [...a.laeufe, { fenster: a.fenster, gestartet: a.gestartet, gestoppt: iso(jetztMs) }].slice(-20),
  ...(String(stand_text || '').trim() ? { stand_text: String(stand_text).trim().slice(-STAND_MAX) } : {}),
}), jetztMs);
export const aufgabeAbschliessen = (db, id, { ergebnis = '' } = {}, jetztMs) => wechsel(db, id, OFFEN, (a) => ({ status: 'fertig', beendet: iso(jetztMs), ergebnis: einzeilig(ergebnis, 1000) || a.ergebnis || '' }), jetztMs);
/** Verwerfen = Papierkorb (aus jeder offenen Lage). */
export const aufgabeVerwerfen = (db, id, jetztMs) => wechsel(db, id, OFFEN, () => ({ status: 'abgebrochen', beendet: iso(jetztMs) }), jetztMs);
/** Aus dem Papierkorb / nach „fertig" zurück in die Liste — Zeiten bleiben. */
export const aufgabeZurueckholen = (db, id, jetztMs) => wechsel(db, id, ['abgebrochen', 'fertig'], () => ({ status: 'geplant', beendet: null, fenster: '', ergebnis: '' }), jetztMs);
/** Endgültig löschen — nur, was nicht läuft. */
export function aufgabeLoeschen(db, id) {
  const a = aufgabeHolen(db, id); if (!a) return fehler('unbekannt');
  if (a.status === 'laeuft' || a.status === 'pausiert') return fehler('schon_gestartet');
  db.prepare('DELETE FROM aufgaben WHERE id = ?').run(a.id);
  db.prepare('UPDATE fenster SET aufgabe_id = NULL WHERE aufgabe_id = ?').run(a.id);
  return { ok: true };
}
/** Sekunden addieren (Summe + Tages-Topf in der Zeitzone), setzt letztes_sample. */
export function zeitAddieren(db, id, zeiten = {}, jetztMs, zone = 'Europe/Berlin') {
  const a = aufgabeHolen(db, id); if (!a) return fehler('unbekannt');
  const tag = tagIn(jetztMs, zone);
  const tage = { ...a.tage, [tag]: zeitenAddieren(a.tage[tag], zeiten) };
  return { ok: true, aufgabe: setzen(db, a.id, { zeiten: zeitenAddieren(a.zeiten, zeiten), tage, letztes_sample: iso(jetztMs) }, jetztMs) };
}
export function reihenfolgeSetzen(db, ids = [], jetztMs) {
  const pos = rangAusIds(ids);
  for (const [id, rang] of Object.entries(pos)) db.prepare('UPDATE aufgaben SET rang = ?, stand_am = ? WHERE id = ?').run(rang, iso(jetztMs), Number(id));
  return { ok: true, gesetzt: Object.keys(pos).length };
}
export function fensterAufgabeSetzen(db, name, id) { db.prepare('UPDATE fenster SET aufgabe_id = ? WHERE name = ?').run(id == null ? null : Number(id), String(name || '')); }

// ── Dienst: Start/Stopp/Weiter/Fertig, Takt (Sampler, Fertig-Satz, Autostart, Fälligkeit), Routen ──
/**
 * @param deps.db, deps.konsole ({zustand(name)}), deps.fensterBauen (Angaben → {ok, fenster, start}),
 *        deps.broadcast, deps.zone, deps.jetzt (() => ms), deps.erstFragen (Standard der Vorlage),
 *        deps.reminderUebergeben (db, id, an) aus erinnerungen.mjs
 */
export function createAufgabenDienst({ db, konsole, fensterBauen, broadcast = () => {}, zone = 'Europe/Berlin', jetzt = () => Date.now(), erstFragen = true, reminderUebergeben = null, log = console } = {}) {
  aufgabenSchema(db);
  const post = (kanal, von, typ, inhalt, meta = null) => { const m = senden(db, { kanal, von, typ, inhalt, meta }); if (m) broadcast('message', m); return m; };
  const geaendert = (a) => { broadcast('aufgaben', { id: a ? a.id : null }); return a; };
  const lebt = (name) => { const z = konsole && konsole.zustand ? konsole.zustand(name) : null; return z ? !!z.lebt : null; };
  const verlaufAnKarte = (a, text) => { if (!a.karte_id || !karteHolen(db, a.karte_id)) return; const k = karteVerlauf(db, a.karte_id, { von: 'Aufgaben', text }); if (k) broadcast('karte', k); };
  const startTextFuer = (a) => startText(a, { erstFragen, karteTitel: a.karte_id ? (karteHolen(db, a.karte_id) || {}).titel : '' });

  function anlegen(eingabe) {
    const r = aufgabeAnlegen(db, eingabe, jetzt(), { erstFragenStandard: erstFragen });
    if (r.ok) geaendert(r.aufgabe);
    return r;
  }

  /** ▶ Starten. Gestoppte Aufgabe, deren altes Fenster noch läuft und frei ist → dort weiter (außer neues_fenster). */
  function starten(id, opt = {}, von = 'du') {
    const a = aufgabeHolen(db, id); if (!a) return { status: 404, ...fehler('unbekannt') };
    if (a.status === 'laeuft' || a.status === 'pausiert') return { status: 409, ...fehler('schon_gestartet'), fenster: a.fenster };
    if (a.status !== 'geplant') return { status: 409, ...fehler('schon_beendet') };
    const t = jetzt();
    const alt = a.laeufe.length ? fensterHolen(db, a.laeufe[a.laeufe.length - 1].fenster) : null;
    if (alt && !opt.neues_fenster && !alt.aufgabe_id && lebt(alt.name) !== false && alt.status === 'laeuft') {
      const s = aufgabeStarten(db, a.id, { fenster: alt.name, fertig_ab_id: letzteNachrichtId(db, alt.name) }, t);
      if (!s.ok) return { status: 409, ...s };
      fensterAufgabeSetzen(db, alt.name, a.id);
      post(alt.name, von, 'task', `▶ Aufgabe geht weiter: ${a.titel}\nMach da weiter, wo du beim Stoppen warst. Zum Schluss wieder genau eine Zeile „${FERTIG_SATZ} <Ergebnis>“.`, { aufgabe: a.id, auto: true });
      return { status: 200, ok: true, aufgabe: geaendert(s.aufgabe), fenster: fensterHolen(db, alt.name), weiter_im_alten_fenster: true };
    }
    const name = fensterNameFuer(a.titel, (n) => !!fensterHolen(db, n));
    const b = { name, label: kanalLabel(a.titel), start_text: startTextFuer(a), start_modus: opt.start_modus };
    const ort = eingabeSaeubern({ ort: opt.ort ?? a.ort }).ort; if (ort) b.ort = ort;
    const repo = String(opt.repo ?? a.repo ?? '').trim(), ordner = String(opt.ordner ?? a.ordner ?? '').trim();
    if (repo) b.repo = repo; else if (ordner) b.ordner = ordner;
    let r; try { r = fensterBauen(b); } catch (e) { r = fehler(String((e && e.message) || e)); }
    if (!r || !r.ok) return { status: 400, ok: false, fehler: (r && r.fehler) || 'Fenster ging nicht' };
    const s = aufgabeStarten(db, a.id, { fenster: r.fenster.name, fertig_ab_id: letzteNachrichtId(db, r.fenster.name) }, t);
    if (!s.ok) return { status: 409, ...s, fenster: r.fenster.name };
    fensterAufgabeSetzen(db, r.fenster.name, a.id);
    broadcast('presence', { fenster: r.fenster.name, neu: true });
    return { status: 200, ok: true, aufgabe: geaendert(s.aufgabe), fenster: fensterHolen(db, r.fenster.name), start: r.start };
  }

  function stoppen(id, von = 'du', { hinweis = true } = {}) {
    const a = aufgabeHolen(db, id); if (!a) return { status: 404, ...fehler('unbekannt') };
    // Stand = letzte Nachrichten dieses Laufs (ohne die eigenen Automatik-Aufträge); ein älterer Stand bleibt davor stehen,
    // damit ein neues Fenster nach „Weiter im alten Fenster" + erneutem Stopp nicht nur den letzten Schnipsel sieht.
    const kanalMsgs = a.fenster ? db.prepare("SELECT * FROM messages WHERE kanal = ? AND id > ? AND COALESCE(meta, '') NOT LIKE '%\"auto\":true%' ORDER BY id DESC LIMIT 12").all(a.fenster, Number(a.fertig_ab_id) || 0).reverse() : [];
    const neu = standAusNachrichten(kanalMsgs, { zone });
    const stand = neu && a.stand_text && a.laeufe.length ? `${a.stand_text}\n${neu}`.slice(-STAND_MAX) : neu;
    const r = aufgabeStoppen(db, a.id, { stand_text: stand }, jetzt());
    if (!r.ok) return { status: 409, ...r };
    const f = a.fenster ? fensterHolen(db, a.fenster) : null;
    if (f && Number(f.aufgabe_id) === a.id) fensterAufgabeSetzen(db, f.name, null);
    if (f && hinweis && lebt(f.name) !== false) post(f.name, von, 'task', `⏏ Aufgabe gestoppt: ${a.titel}\nEs geht später weiter. Schreib jetzt kurz deinen Stand an die feste Stelle und hör dann auf. Das Fenster darf offen bleiben.`, { aufgabe: a.id, auto: true });
    verlaufAnKarte(r.aufgabe, `⏏ Aufgabe „${a.titel}“ gestoppt — ${minText(zeitenSummen(r.aufgabe.zeiten).aktiv_s)} aktiv bisher.`);
    return { status: 200, ok: true, aufgabe: geaendert(r.aufgabe) };
  }

  function abschliessen(id, { ergebnis = '' } = {}) {
    const a = aufgabeHolen(db, id); if (!a) return { status: 404, ...fehler('unbekannt') };
    const r = aufgabeAbschliessen(db, a.id, { ergebnis }, jetzt());
    if (!r.ok) return { status: 409, ...r };
    const f = a.fenster ? fensterHolen(db, a.fenster) : null;
    if (f && Number(f.aufgabe_id) === a.id) fensterAufgabeSetzen(db, f.name, null);
    if (a.fenster && (a.status === 'laeuft' || a.status === 'pausiert')) post(a.fenster, 'flottenchat', 'done', abschlussKarte(r.aufgabe, { zone, jetztMs: jetzt() }), { aufgabe: a.id });
    const s = zeitenSummen(r.aufgabe.zeiten);
    verlaufAnKarte(r.aufgabe, `🏁 Aufgabe „${a.titel}“ fertig — ${minText(s.aktiv_s)} aktiv (gesamt ${minText(s.gesamt_s)}).${r.aufgabe.ergebnis ? ' Ergebnis: ' + r.aufgabe.ergebnis : ''}`);
    return { status: 200, ok: true, aufgabe: geaendert(r.aufgabe) };
  }

  function verwerfen(id) {
    const a = aufgabeHolen(db, id); if (!a) return { status: 404, ...fehler('unbekannt') };
    const r = aufgabeVerwerfen(db, a.id, jetzt()); if (!r.ok) return { status: 409, ...r };
    const f = a.fenster ? fensterHolen(db, a.fenster) : null;
    if (f && Number(f.aufgabe_id) === a.id) fensterAufgabeSetzen(db, f.name, null);
    if (a.fenster && f) post(a.fenster, 'flottenchat', 'system', `🗑 Aufgabe verworfen: ${a.titel} — die Zeitmessung ist aus.`);
    return { status: 200, ok: true, aufgabe: geaendert(r.aufgabe) };
  }

  /** Kanal geschlossen = Aufgabe erledigt (die Zeit steht ab dem Klick; Aufräumen zählt nicht). */
  function fensterGeschlossen(name) {
    for (const a of aufgabenAlle(db)) if ((a.status === 'laeuft' || a.status === 'pausiert') && a.fenster === name) abschliessen(a.id, { ergebnis: a.ergebnis || 'Kanal geschlossen' });
  }
  /** Fenster gelöscht (ohne Schließ-Ritual) = Stopp: zurück in die Liste, Stand bleibt. */
  function fensterGeloescht(name) {
    for (const a of aufgabenAlle(db)) if ((a.status === 'laeuft' || a.status === 'pausiert') && a.fenster === name) stoppen(a.id, 'flottenchat', { hinweis: false });
  }

  /** Erinnerung → Aufgabe (optional gleich starten). Die Erinnerung gilt dann als übergeben und feuert nicht mehr. */
  function ausErinnerungAnlegen(rid, { starten: los = false, von = 'du', ...opt } = {}) {
    const rem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(rid) || 0);
    if (!rem) return { status: 404, ...fehler('unbekannt') };
    const r = anlegen(ausErinnerung(rem)); if (!r.ok) return { status: 400, ...r };
    if (reminderUebergeben) reminderUebergeben(db, rem.id, `aufgabe:${r.aufgabe.id}`);
    if (!los) return { status: 200, ok: true, aufgabe: r.aufgabe };
    const s = starten(r.aufgabe.id, opt, von);
    return { ...s, aufgabe: s.aufgabe || r.aufgabe };
  }

  /** Ein Takt (alle TAKT_S): Samples, Fertig-Satz, verwaiste Läufe, Autostart, Fälligkeit. Wirft nie. */
  function takt(jetztMs = jetzt()) {
    let alle = [];
    try { alle = aufgabenAlle(db); } catch (e) { log.error('[aufgaben]', e && e.message); return; }
    for (const a of alle) {
      if (a.status !== 'laeuft' && a.status !== 'pausiert') continue;
      try {
        const f = a.fenster ? fensterHolen(db, a.fenster) : null;
        if (!f || (f.aufgabe_id && Number(f.aufgabe_id) !== a.id)) { stoppen(a.id, 'flottenchat', { hinweis: false }); continue; } // Fenster weg oder neu vergeben
        const z = konsole && konsole.zustand ? konsole.zustand(f.name) : null;
        if (!z) continue; // Konsole hat das Fenster noch nicht gesehen
        if (!z.lebt) { if (a.status === 'laeuft' && jetztMs - (Date.parse(a.gestartet) || jetztMs) > 90_000) { const p = aufgabePausieren(db, a.id, jetztMs); if (p.ok) geaendert(p.aufgabe); } continue; }
        const msgs = db.prepare('SELECT von, typ, erstellt_am FROM messages WHERE kanal = ? ORDER BY id DESC LIMIT 20').all(f.name);
        const s = sampleFuerAufgabe(a, { lebt: true, claude_busy: !!z.busy, dialog_art: z.dialog ? z.dialog.art : null, letzteMenschMs: letzteMenschMs(msgs, [f.label, f.name]) }, jetztMs);
        if (s) zeitAddieren(db, a.id, s.zeiten, jetztMs, zone);
        // Fertig-Satz: eine Fenster-Antwort nach dem Start, die mit „✅ Aufgabe fertig:" beginnt.
        const treffer = db.prepare("SELECT id, inhalt FROM messages WHERE kanal = ? AND id > ? AND typ IN ('answer', 'done') AND von != 'flottenchat' AND inhalt LIKE ? ORDER BY id LIMIT 5").all(f.name, Number(a.fertig_ab_id) || 0, `%${FERTIG_SATZ}%`);
        let fertig = false;
        for (const m of treffer) { const erg = fertigSatzErkennen(m.inhalt); if (erg !== null) { abschliessen(a.id, { ergebnis: erg }); fertig = true; break; } }
        if (!fertig && treffer.length) setzen(db, a.id, { fertig_ab_id: treffer[treffer.length - 1].id }, jetztMs);
      } catch (e) { log.error('[aufgaben] Takt', a.id, e && e.message); }
    }
    try {
      const auto = faelligeAutostarts(alle, jetztMs);
      for (const id of auto.verpasst) { const a = setzen(db, id, { autostart: 'verpasst' }, jetztMs); post('erinnerungen', 'flottenchat', 'system', `⏰ Aufgabe „${a.titel}“ sollte um ${uhrzeitIn(Date.parse(a.start_um), zone)} starten — der Server war aus. Bitte von Hand starten.`, { aufgabe: id }); geaendert(a); }
      for (const id of auto.starten) {
        setzen(db, id, { autostart: 'gestartet' }, jetztMs); // erst merken, dann starten (nie doppelt)
        const r = starten(id, {}, 'flottenchat');
        if (!r.ok) { const a = setzen(db, id, { autostart: 'fehler: ' + String(r.fehler || '').slice(0, 120) }, jetztMs); post('erinnerungen', 'flottenchat', 'error', `⏰ Autostart „${a.titel}“ ging nicht: ${r.fehler}`, { aufgabe: id }); geaendert(a); }
        else post('erinnerungen', 'flottenchat', 'system', `▶ Aufgabe „${r.aufgabe.titel}“ ist zur Uhrzeit gestartet — Kanal „${r.fenster.label || r.fenster.name}“.`, { aufgabe: id });
      }
      for (const id of faelligeMeldungen(aufgabenAlle(db), jetztMs)) {
        const a = aufgabeHolen(db, id); setzen(db, id, { faellig_gemeldet: a.faellig_am }, jetztMs);
        post('erinnerungen', 'flottenchat', 'system', `⏰ Aufgabe fällig: ${a.titel}${a.label ? ` [${a.label}]` : ''}${a.status === 'geplant' ? ' — in der Seitenleiste mit ▶ starten.' : ''}`, { aufgabe: id });
        geaendert(a);
      }
    } catch (e) { log.error('[aufgaben] Takt', e && e.message); }
  }

  /** Was die UI braucht: alle offenen (sortiert) + zuletzt Erledigte + Papierkorb + Uhr je Fenster. */
  function liste(jetztMs = jetzt()) {
    const alle = aufgabenAlle(db);
    const offen = offeneSortieren(alle, jetztMs, zone);
    const fertig = alle.filter((a) => a.status === 'fertig').sort((x, y) => String(y.beendet || '').localeCompare(String(x.beendet || ''))).slice(0, 50);
    const papierkorb = alle.filter((a) => a.status === 'abgebrochen').sort((x, y) => String(y.beendet || '').localeCompare(String(x.beendet || ''))).slice(0, 50);
    const jeFenster = {};
    for (const f of fensterAlle(db)) { const a = aufgabeFuersFenster(alle, f); if (a) jeFenster[f.name] = a.id; }
    const ohneTage = (a) => ({ ...a, tage: undefined, stufe: faelligStufe(a, jetztMs, zone) });
    return { aufgaben: [...offen, ...fertig, ...papierkorb].map(ohneTage), offen: offen.map((a) => a.id), je_fenster: jeFenster, jetzt: iso(jetztMs), heute: tagIn(jetztMs, zone) };
  }

  /** Routen unter /api/aufgaben… (+ Brücke /api/reminders/<id>/(session|aufgabe)). true = erledigt. */
  async function route({ req, res, url, wer, json, koerper }) {
    const p = url.pathname;
    const admin = wer && wer.rolle === 'admin';
    const antwort = (r) => { const { status = r.ok ? 200 : 400, ...rest } = r; json(res, status, rest); return true; };
    const mR = /^\/api\/reminders\/(\d+)\/(session|aufgabe)$/.exec(p);
    if (mR && req.method === 'POST') {
      if (!admin) return antwort({ status: 403, ok: false });
      const b = await koerper(req);
      return antwort(ausErinnerungAnlegen(mR[1], { ...b, starten: mR[2] === 'session' || b.starten === true, von: wer.name }));
    }
    if (p === '/api/aufgaben' && req.method === 'GET') return antwort({ ok: true, ...liste() });
    if (p === '/api/aufgaben/auswertung' && req.method === 'GET') {
      const heute = tagIn(jetzt(), zone);
      const von = /^\d{4}-\d\d-\d\d$/.test(url.searchParams.get('von') || '') ? url.searchParams.get('von') : tagIn(jetzt() - 6 * 86_400_000, zone);
      const bis = /^\d{4}-\d\d-\d\d$/.test(url.searchParams.get('bis') || '') ? url.searchParams.get('bis') : heute;
      return antwort({ ok: true, ...auswertung(aufgabenAlle(db), { von, bis }) });
    }
    if (!p.startsWith('/api/aufgaben')) return false;
    if (req.method !== 'POST') return antwort({ status: 405, ok: false, fehler: 'methode' });
    if (!admin) return antwort({ status: 403, ok: false, fehler: 'Nur Menschen (Admin) ändern Aufgaben.' });
    const b = await koerper(req);
    if (p === '/api/aufgaben') {
      const r = anlegen(b); if (!r.ok) return antwort(r);
      if (b.starten === true) { const s = starten(r.aufgabe.id, b, wer.name); return antwort({ ...s, aufgabe: s.aufgabe || r.aufgabe }); }
      return antwort(r);
    }
    if (p === '/api/aufgaben/reihenfolge') { if (!Array.isArray(b.ids)) return antwort(fehler('ids_fehlen')); const r = reihenfolgeSetzen(db, b.ids.slice(0, 500), jetzt()); geaendert(null); return antwort(r); }
    const m = /^\/api\/aufgaben\/(\d+)(?:\/(start|pause|weiter|stopp|fertig|verwerfen|zurueck|loeschen))?$/.exec(p);
    if (!m) return antwort({ status: 404, ok: false, fehler: 'Unbekannter Endpunkt.' });
    const id = Number(m[1]), aktion = m[2] || '';
    const t = jetzt();
    const mitStatus = (r) => ({ status: r.ok ? 200 : r.fehler === 'unbekannt' ? 404 : 409, ...r });
    if (!aktion) { const r = aufgabeAendern(db, id, b, t); if (r.ok) geaendert(r.aufgabe); return antwort(mitStatus(r)); }
    if (aktion === 'start') return antwort(starten(id, b, wer.name));
    if (aktion === 'stopp') return antwort(stoppen(id, wer.name));
    if (aktion === 'fertig') return antwort(abschliessen(id, { ergebnis: b.ergebnis }));
    if (aktion === 'verwerfen') return antwort(verwerfen(id));
    if (aktion === 'pause' || aktion === 'weiter') { const r = (aktion === 'pause' ? aufgabePausieren : aufgabeFortsetzen)(db, id, t); if (r.ok) geaendert(r.aufgabe); return antwort(mitStatus(r)); }
    if (aktion === 'zurueck') { const r = aufgabeZurueckholen(db, id, t); if (r.ok) geaendert(r.aufgabe); return antwort(mitStatus(r)); }
    if (aktion === 'loeschen') { const r = aufgabeLoeschen(db, id); if (r.ok) geaendert(null); return antwort(mitStatus(r)); }
    return false;
  }

  return { anlegen, starten, stoppen, abschliessen, verwerfen, fensterGeschlossen, fensterGeloescht, ausErinnerungAnlegen, takt, liste, route, startTextFuer };
}

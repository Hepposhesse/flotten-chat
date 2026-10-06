// test_kanaele.mjs — Kanal-Verwaltung, Gelesen/Ungelesen, Suche (1.1). Muster: pass/fail-Zähler, letzte Zeile "N passed, M failed".
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, senden, kanalAnlegen } from './server/db.mjs';
import {
  einstellungenSaeubern, leereEinstellungen, kanaeleSortieren, reihenfolgeVerschieben, reihenfolgeZiehen,
  ungelesenZaehlen, markerNeu, einstellungenLaden, einstellungenSpeichern, gelesenLaden, gelesenSetzen, ungelesen,
} from './server/kanaele.mjs';
import { woerter, passt, ausschnitt, likeMuster, trefferAus, sucheNachrichten, MAX_TREFFER } from './server/suche.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

// ── Einstellungen säubern ──
eq(einstellungenSaeubern(null), leereEinstellungen(), 'leer → leere Form');
{
  const e = einstellungenSaeubern({}, { reihenfolge: ['b', 'a', 'b', 'Böse Name!', ''], archiviert: ['x'], stumm: ['y'], namen: { a: '  Mein  <Kanal> ', b: '', 'c!': 'C' } });
  eq(e.reihenfolge, ['b', 'a', 'BseName'], 'Reihenfolge: Dubletten raus, Namen gesäubert, leere raus');
  eq(e.archiviert, ['x'], 'archiviert übernommen');
  eq(e.stumm, ['y'], 'stumm übernommen');
  eq(e.namen, { a: 'Mein Kanal', c: 'C' }, 'namen: getrimmt, <> raus, Mehrfach-Leerzeichen eins, leer = löschen');
  const e2 = einstellungenSaeubern(e, { namen: { a: '' }, stumm: 'quatsch' });
  eq(e2.namen, { c: 'C' }, 'leerer Name löscht den Anzeigenamen');
  eq(e2.stumm, ['y'], 'Nicht-Array lässt die Liste stehen');
  eq(e2.reihenfolge, e.reihenfolge, 'Patch ohne reihenfolge lässt sie stehen');
  ok(einstellungenSaeubern({}, { namen: { a: 'x'.repeat(80) } }).namen.a.length === 40, 'Anzeigename max. 40 Zeichen');
  ok(einstellungenSaeubern({}, { reihenfolge: Array.from({ length: 300 }, (_, i) => 'k' + i) }).reihenfolge.length === 200, 'Reihenfolge max. 200');
}

// ── Sortieren ──
{
  const liste = [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }, { name: 'c', label: '' }, { name: 'd', label: 'D' }];
  const s = kanaeleSortieren(liste, { reihenfolge: ['c', 'a'], archiviert: ['d'], stumm: ['b'], namen: { a: 'Alpha' } });
  eq(s.map((x) => x.name), ['c', 'a', 'b', 'd'], 'bekannte in Wunsch-Order zuerst, unbekannte dahinter in alter Reihenfolge');
  eq(s.map((x) => x.anzeige), ['c', 'Alpha', 'B', 'D'], 'anzeige = Name-Override > label > name');
  ok(s[3].archiviert === true && s[0].archiviert === false, 'archiviert-Flag');
  ok(s[2].stumm === true && s[1].stumm === false, 'stumm-Flag');
  ok(!('_i' in s[0]), 'Hilfsfeld bleibt nicht am Eintrag');
  eq(kanaeleSortieren(liste, null).map((x) => x.name), ['a', 'b', 'c', 'd'], 'ohne Einstellungen: alte Reihenfolge');
}

// ── Verschieben / Ziehen ──
eq(reihenfolgeVerschieben(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'], '▲ tauscht mit dem Vorgänger');
eq(reihenfolgeVerschieben(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'], '▼ tauscht mit dem Nachfolger');
eq(reihenfolgeVerschieben(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'], 'ganz oben bleibt oben');
eq(reihenfolgeVerschieben(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c'], 'ganz unten bleibt unten');
eq(reihenfolgeVerschieben(['a', 'b'], 'zz', 1), ['a', 'b'], 'unbekannter Kanal: unverändert');
eq(reihenfolgeZiehen(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'], 'ziehen vor a');
eq(reihenfolgeZiehen(['a', 'b', 'c'], 'a', ''), ['b', 'c', 'a'], 'ziehen ans Ende');
eq(reihenfolgeZiehen(['a', 'b'], 'neu', 'b'), ['a', 'neu', 'b'], 'unbekannter Kanal wird eingefügt');

// ── Ungelesen zählen (rein) ──
{
  const zeilen = [{ kanal: 'a', id: 1, von: 'bot' }, { kanal: 'a', id: 2, von: 'bot' }, { kanal: 'a', id: 3, von: 'ich' }, { kanal: 'b', id: 4, von: 'bot' }, { kanal: 'c', id: 5, von: 'bot' }];
  const u = ungelesenZaehlen(zeilen, { a: 1 }, ['c'], 'ich');
  eq(u.counts, { a: 1, b: 1 }, 'nach Marker, ohne eigene, stumm = nichts');
  ok(u.gesamt === 2, 'Gesamtzahl');
  eq(ungelesenZaehlen(zeilen, {}, [], '').counts, { a: 3, b: 1, c: 1 }, 'ohne Marker/stumm zählt alles');
  eq(ungelesenZaehlen([], {}, [], '').gesamt, 0, 'leer → 0');
}
ok(markerNeu(5, 7) === 7 && markerNeu(5, 3) === 5, 'Marker ist monoton');
ok(markerNeu(5, 3, true) === 3, 'force darf zurück');
ok(markerNeu(5, 'x') === null && markerNeu(5, -1) === null, 'unbrauchbarer Marker → null');
ok(markerNeu(0, '12') === 12, 'Marker als Text ok');

// ── DB: Einstellungen, Gelesen, Ungelesen ──
const dir = mkdtempSync(join(tmpdir(), 'fc-kanaele-'));
const db = openDb(dir);
try {
  eq(einstellungenLaden(db), leereEinstellungen(), 'frische DB: leere Einstellungen');
  const e = einstellungenSpeichern(db, { reihenfolge: ['b', 'a'], namen: { a: 'Alpha' }, stumm: ['s'] });
  eq(einstellungenLaden(db), e, 'gespeichert = geladen');
  eq(einstellungenSpeichern(db, { archiviert: ['a'] }).reihenfolge, ['b', 'a'], 'Teil-Patch lässt den Rest stehen');
  ok(einstellungenLaden(db).archiviert[0] === 'a', 'archiviert gespeichert');

  for (const k of ['a', 'b', 's']) kanalAnlegen(db, { name: k });
  const m1 = senden(db, { kanal: 'a', von: 'bot', inhalt: 'eins' });
  const m2 = senden(db, { kanal: 'a', von: 'bot', inhalt: 'zwei' });
  senden(db, { kanal: 'a', von: 'simon', inhalt: 'meine eigene' });
  senden(db, { kanal: 'b', von: 'bot', inhalt: 'b1' });
  senden(db, { kanal: 's', von: 'bot', inhalt: 'stumm1' });
  senden(db, { kanal: 'geheim', von: 'bot', inhalt: 'nicht sichtbar' });
  eq(gelesenLaden(db), {}, 'frische DB: keine Marker');
  let u = ungelesen(db, { kanaele: ['a', 'b', 's'], ich: 'simon' });
  eq(u.counts, { a: 2, b: 1 }, 'ungelesen: eigene nicht, stumm nicht, nur sichtbare Kanäle');
  ok(u.gesamt === 3, 'gesamt 3');
  ok(gelesenSetzen(db, 'a', m1.id) === m1.id, 'Marker setzen');
  eq(ungelesen(db, { kanaele: ['a'], ich: 'simon' }).counts, { a: 1 }, 'nach Marker eine ungelesen');
  ok(gelesenSetzen(db, 'a', m1.id - 1) === m1.id, 'Marker geht nicht zurück');
  ok(gelesenSetzen(db, 'a', m1.id - 1, { force: true }) === m1.id - 1, 'force setzt zurück');
  ok(gelesenSetzen(db, 'a', m2.id + 5) === m2.id + 5, 'Marker über das Ende hinaus ist erlaubt');
  eq(ungelesen(db, { kanaele: ['a', 'b'], ich: 'simon' }).counts, { b: 1 }, 'a komplett gelesen → nicht in counts');
  ok(gelesenSetzen(db, '', 3) === null && gelesenSetzen(db, 'a', 'x') === null, 'Pflichtfelder');
  eq(gelesenLaden(db), { a: m2.id + 5 }, 'gelesenLaden liefert die Marker');
  eq(ungelesen(db, { kanaele: [] }).counts, {}, 'keine Kanäle → nichts');
  u = ungelesen(db, { kanaele: ['s'], ich: 'simon', stumm: [] });
  eq(u.counts, { s: 1 }, 'stumm explizit leer übergeben → zählt');

  // ── Suche ──
  eq(woerter('  Hallo WELT  hallo '), ['hallo', 'welt'], 'Wörter klein + ohne Dubletten');
  eq(woerter('"zwei wörter" drei'), ['zwei wörter', 'drei'], 'Anführungszeichen = ein Begriff');
  eq(woerter('„deutsch zitiert“ x'), ['deutsch zitiert', 'x'], 'deutsche Anführungszeichen');
  eq(woerter(''), [], 'leer → keine Wörter');
  ok(woerter('a b c d e f g h i j').length === 8, 'max. 8 Wörter');
  ok(passt('Hallo Welt', ['hallo', 'welt']) && !passt('Hallo', ['hallo', 'welt']) && !passt('x', []), 'passt: alle Wörter, Groß/klein egal, leer nie');
  ok(likeMuster('50%_a\\') === '%50\\%\\_a\\\\%', 'LIKE-Muster escaped % _ \\');
  const lang = 'x'.repeat(300) + ' Treffer hier ' + 'y'.repeat(300);
  const a = ausschnitt(lang, ['treffer'], 100);
  ok(a.length <= 102 && a.startsWith('…') && a.endsWith('…') && a.toLowerCase().includes('treffer'), 'Ausschnitt um den Treffer mit … an beiden Seiten: ' + a);
  ok(ausschnitt('kurz', ['kurz']) === 'kurz', 'kurzer Text bleibt ganz');
  ok(ausschnitt('a\n\n  b   c', ['zz']).startsWith('a b c'), 'Whitespace zusammengefasst, ohne Treffer von vorn');
  eq(trefferAus([{ id: 1, kanal: 'a', von: 'x', typ: 'fyi', inhalt: 'Apfel Birne', erstellt_am: 't' }, { id: 2, kanal: 'a', von: 'x', typ: 'fyi', inhalt: 'Apfel', erstellt_am: 't' }], ['apfel', 'birne']).map((t) => t.id), [1], 'trefferAus filtert auf alle Wörter');

  senden(db, { kanal: 'a', von: 'bot', inhalt: 'Die Rechnung für Müller ist raus.' });
  senden(db, { kanal: 'b', von: 'bot', inhalt: 'Rechnung an MÜLLER geschickt' });
  senden(db, { kanal: 'geheim', von: 'bot', inhalt: 'Rechnung Müller geheim' });
  senden(db, { kanal: 'a', von: 'bot', inhalt: 'Nur Rechnung, kein Name' });
  let r = sucheNachrichten(db, { q: 'rechnung müller', kanaele: ['a', 'b', 's'] });
  eq(r.woerter, ['rechnung', 'müller'], 'Wörter kommen mit');
  eq(r.treffer.map((t) => t.kanal), ['b', 'a'], 'beide Wörter nötig, neueste zuerst, nur erlaubte Kanäle');
  ok(r.treffer.every((t) => t.ausschnitt && t.id && t.von && t.erstellt_am), 'Treffer mit Ausschnitt, ID, Absender, Zeit');
  ok(sucheNachrichten(db, { q: 'MÜLLER', kanaele: ['b'] }).treffer.length === 1, 'Großschreibung mit Umlaut findet');
  ok(sucheNachrichten(db, { q: 'rechnung', kanaele: null }).treffer.some((t) => t.kanal === 'geheim'), 'kanaele=null = alle Kanäle');
  ok(sucheNachrichten(db, { q: 'rechnung', kanaele: [] }).treffer.length === 0, 'leere Erlaubnis → nichts');
  ok(sucheNachrichten(db, { q: '', kanaele: null }).treffer.length === 0, 'leere Suche → nichts');
  ok(sucheNachrichten(db, { q: '50%', kanaele: null }).treffer.length === 0, 'LIKE-Sonderzeichen sind kein Joker');
  senden(db, { kanal: 'a', von: 'bot', inhalt: 'Rabatt 50% auf alles' });
  ok(sucheNachrichten(db, { q: '50%', kanaele: null }).treffer.length === 1, 'Prozentzeichen wörtlich gefunden');
  for (let i = 0; i < 60; i++) senden(db, { kanal: 'a', von: 'bot', inhalt: 'massenhaft ' + i });
  const viele = sucheNachrichten(db, { q: 'massenhaft', kanaele: ['a'] });
  ok(viele.treffer.length === MAX_TREFFER && viele.treffer[0].ausschnitt.endsWith('59'), 'max. 50 Treffer, neueste zuerst');
  ok(sucheNachrichten(db, { q: 'massenhaft', kanaele: ['a'], limit: 5 }).treffer.length === 5, 'limit greift');
  ok(sucheNachrichten(db, { q: 'massenhaft', kanaele: ['a'], limit: 999 }).treffer.length === MAX_TREFFER, 'limit über Max wird gedeckelt');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

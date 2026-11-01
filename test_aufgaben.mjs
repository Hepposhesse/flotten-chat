// test_aufgaben.mjs — Aufgaben mit Zeit (1.2): reine Logik, Datenbank, Dienst (Start/Stopp/Weiter/Fertig/Takt) ohne tmux.
// Muster: pass/fail-Zähler, letzte Zeile "N passed, M failed".
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, senden, fensterAnlegen, fensterHolen, fensterLoeschen, karteAnlegen, karteHolen, reminderAnlegen, faelligeFeuern } from './server/db.mjs';
import { erinnerungenSchema, reminderUebergeben } from './server/erinnerungen.mjs';
import {
  leereZeiten, tagIn, eingabeSaeubern, sampleZuordnen, zeitenSummen, naechstesSample, menschAktiv, letzteMenschMs,
  sampleFuerAufgabe, fertigSatzErkennen, startText, ERST_FRAGEN, FERTIG_SATZ, START_TEXT_MAX, fensterNameFuer, kanalLabel,
  abschlussKarte, textBalken, faelligStufe, offeneSortieren, rangAusIds, aufgabeFuersFenster, faelligeAutostarts,
  faelligeMeldungen, standAusNachrichten, ausErinnerung, auswertung, labelSauber,
  aufgabenSchema, aufgabeAnlegen, aufgabeHolen, aufgabeAendern, aufgabeStarten, aufgabePausieren, aufgabeFortsetzen,
  aufgabeStoppen, aufgabeAbschliessen, aufgabeVerwerfen, aufgabeZurueckholen, aufgabeLoeschen, zeitAddieren,
  reihenfolgeSetzen, aufgabenAlle, createAufgabenDienst,
} from './server/aufgaben.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);
const T0 = Date.parse('2026-11-01T09:00:00Z'); // So, 10:00 Berlin
const MIN = 60_000;

// ── Reine Logik ──
eq(Object.keys(leereZeiten()), ['mensch_aktiv_s', 'claude_aktiv_s', 'warten_mensch_s', 'leerlauf_s', 'pause_s'], 'fünf Zeit-Töpfe');
eq(tagIn(Date.parse('2026-10-31T23:30:00Z')), '2026-11-01', 'Tag in Berlin: 23:30 UTC ist schon der nächste Tag');
eq(tagIn(Date.parse('2026-10-25T00:30:00Z')), '2026-10-25', 'Tag in Berlin über die Zeitumstellung (DST über Intl, kein fester Offset)');
eq(tagIn(Date.parse('2026-10-31T23:30:00Z'), 'UTC'), '2026-10-31', 'Zeitzone als Parameter');
{
  const e = eingabeSaeubern({ titel: '  Video   drehen ', label: ' <Kunde>  A ', faellig_am: '2026-11-02T10:00:00+01:00', start_um: 'quatsch', erst_fragen: false, ort: 'evil;rm', karte_id: '7', unbekannt: 1 });
  eq(e.titel, 'Video drehen', 'Titel getrimmt/zusammengezogen');
  eq(e.label, 'Kunde A', 'Label ohne Spitzklammern, einzeilig');
  eq(e.faellig_am, '2026-11-02T09:00:00.000Z', 'Fälligkeit → UTC-ISO');
  eq(e.start_um, null, 'unlesbare Startzeit → null');
  eq(e.erst_fragen, 0, 'erst_fragen aus');
  eq(e.ort, '', 'ungültiger Ort → leer (lokal)');
  eq(e.karte_id, 7, 'karte_id als Zahl');
  ok(!('unbekannt' in e), 'unbekannte Felder fallen weg');
  eq(eingabeSaeubern({ titel: '   ' }).titel, undefined, 'leerer Titel kommt nicht durch');
  eq(eingabeSaeubern({ ort: 'ssh:user@host' }).ort, 'ssh:user@host', 'ssh-Ort erlaubt');
  eq(labelSauber('x'.repeat(50)).length, 24, 'Label max. 24 Zeichen');
}
eq(sampleZuordnen({ claude_busy: true }, 20), { ...leereZeiten(), claude_aktiv_s: 20 }, 'Claude arbeitet → Claude aktiv');
eq(sampleZuordnen({ mensch_aktiv: true }, 20), { ...leereZeiten(), mensch_aktiv_s: 20 }, 'Mensch schreibt → Mensch aktiv');
eq(sampleZuordnen({ mensch_aktiv: true, claude_busy: true }, 20), { ...leereZeiten(), mensch_aktiv_s: 20, claude_aktiv_s: 20 }, 'beide zugleich zählen in beide');
eq(sampleZuordnen({ rueckfrage_offen: true }, 20), { ...leereZeiten(), warten_mensch_s: 20 }, 'Rückfrage offen, keiner arbeitet → Warten auf dich');
eq(sampleZuordnen({ rueckfrage_offen: true, claude_busy: true }, 20), { ...leereZeiten(), claude_aktiv_s: 20 }, 'Claude arbeitet trotz Dialog → kein Warten');
eq(sampleZuordnen({}, 20), { ...leereZeiten(), leerlauf_s: 20 }, 'niemand → Leerlauf');
eq(sampleZuordnen({ pause: true, claude_busy: true }, 20), { ...leereZeiten(), pause_s: 20 }, 'Pause schlägt alles');
eq(sampleZuordnen({ claude_busy: true }, -5), leereZeiten(), 'negative Dauer zählt nichts');
eq(zeitenSummen({ mensch_aktiv_s: 60, claude_aktiv_s: 120, leerlauf_s: 30 }).aktiv_s, 180, 'aktiv = Mensch + Claude');
eq(zeitenSummen({ mensch_aktiv_s: 60, claude_aktiv_s: 120, leerlauf_s: 30 }).gesamt_s, 210, 'gesamt = alle Töpfe');
eq(naechstesSample(null, T0), 20, 'erstes Sample = ein Takt');
eq(naechstesSample(new Date(T0 - 15_000).toISOString(), T0), 15, 'Sample = Abstand zum letzten');
eq(naechstesSample(new Date(T0 - 3600_000).toISOString(), T0), 40, 'Hänger gedeckelt auf 2 Takte');
eq(naechstesSample(new Date(T0 + 5000).toISOString(), T0), 0, 'Zukunft zählt nicht');
ok(menschAktiv(T0 - 30_000, T0), 'Nachricht vor 30 s = aktiv');
ok(!menschAktiv(T0 - 90_000, T0), 'Nachricht vor 90 s = nicht aktiv');
ok(!menschAktiv(NaN, T0), 'nie geschrieben = nicht aktiv');
{
  const msgs = [
    { von: 'du', typ: 'fyi', erstellt_am: new Date(T0 - 50_000).toISOString() },
    { von: 'du', typ: 'task', erstellt_am: new Date(T0 - 5_000).toISOString() },
    { von: 'Video drehen', typ: 'fyi', erstellt_am: new Date(T0 - 4_000).toISOString() },
    { von: 'flottenchat', typ: 'fyi', erstellt_am: new Date(T0 - 3_000).toISOString() },
    { von: 'x', typ: 'answer', erstellt_am: new Date(T0 - 2_000).toISOString() },
  ];
  eq(letzteMenschMs(msgs, ['Video drehen']), T0 - 50_000, 'Mensch = fyi, nicht Fenster/Server/Automatik');
}
eq(sampleFuerAufgabe({ status: 'geplant' }, { lebt: true }, T0), null, 'geplant wird nicht gemessen');
eq(sampleFuerAufgabe({ status: 'laeuft' }, { lebt: false }, T0), null, 'totes Fenster wird nicht gemessen');
eq(sampleFuerAufgabe({ status: 'laeuft' }, { lebt: true, dialog_art: 'freigabe' }, T0).zeiten.warten_mensch_s, 20, 'Freigabe offen = Warten auf dich');
eq(sampleFuerAufgabe({ status: 'pausiert' }, { lebt: true, claude_busy: true }, T0).zeiten.pause_s, 20, 'pausiert = Pause');
eq(fertigSatzErkennen('Erledigt.\n✅ Aufgabe fertig: Seite ist live'), 'Seite ist live', 'Fertig-Satz in eigener Zeile');
eq(fertigSatzErkennen('**✅ Aufgabe fertig: Bericht steht.**'), 'Bericht steht.', 'Markdown-Fett drumherum');
eq(fertigSatzErkennen('- ✅ Aufgabe fertig:'), '', 'leeres Ergebnis ist trotzdem fertig');
eq(fertigSatzErkennen('Ich schreibe dann „✅ Aufgabe fertig: …" am Ende'), null, 'mitten im Satz zählt nicht');
eq(fertigSatzErkennen(''), null, 'leer → null');
{
  const st = startText({ titel: 'Video 2 drehen', label: 'Marketing', beschreibung: 'Skript liegt im Repo.' });
  ok(st.startsWith('🎯 Aufgabe: Video 2 drehen [Marketing]'), 'Start-Text beginnt mit dem Auftrag');
  ok(st.includes(ERST_FRAGEN), 'Standard-Vorlage: erst Lage + Empfehlung + AskUserQuestion');
  ok(st.includes(FERTIG_SATZ), 'Start-Text nennt den Fertig-Satz');
  ok(st.includes('Skript liegt im Repo.'), 'Beschreibung im Start-Text');
  ok(!startText({ titel: 'x', erst_fragen: 0 }).includes(ERST_FRAGEN), 'Vorlage je Aufgabe abschaltbar');
  ok(!startText({ titel: 'x' }, { erstFragen: false }).includes(ERST_FRAGEN), 'Vorlage global abschaltbar');
  ok(startText({ titel: 'x', karte_id: 3 }, { karteTitel: 'Relaunch' }).includes('Board-Karte #3 „Relaunch“'), 'verknüpfte Karte = feste Stelle für den Stand');
  const lang = startText({ titel: 'x', beschreibung: 'b'.repeat(5000), stand_text: 's'.repeat(5000) });
  ok(lang.length <= START_TEXT_MAX, `Start-Text passt immer (${lang.length} ≤ ${START_TEXT_MAX})`);
  ok(lang.includes('wurde gestoppt') && lang.includes(FERTIG_SATZ), 'auch gekürzt: Stand + Regeln bleiben drin');
}
eq(fensterNameFuer('Video 2 drehen!'), 'video-2-drehen', 'Fenstername aus dem Titel');
eq(fensterNameFuer('Video', (n) => ['video', 'video-2'].includes(n)), 'video-3', 'belegte Namen werden übersprungen');
eq(kanalLabel('a'.repeat(60)).length, 40, 'Kanal-Label gekürzt');
eq(textBalken(0.5, 8), '▇▇▇▇▁▁▁▁', 'Textbalken halb');
{
  const a = { titel: 'Seite bauen', gestartet: '2026-11-01T09:00:00.000Z', beendet: '2026-11-01T09:45:00.000Z', ergebnis: 'live', zeiten: { mensch_aktiv_s: 300, claude_aktiv_s: 1500, warten_mensch_s: 600, leerlauf_s: 300, pause_s: 0 } };
  const k = abschlussKarte(a);
  ok(k.startsWith('🏁 Aufgabe fertig: Seite bauen · 10:00–10:45'), 'Abschluss-Karte: Titel + Spanne in Ortszeit');
  ok(k.includes('Aktiv 30 Min (du 5 Min · Claude 25 Min) · gesamt 45 Min'), 'Abschluss-Karte: aktiv/gesamt');
  ok(k.includes('Warten auf dich') && !k.includes('Pause '), 'leere Töpfe (außer du/Claude) fehlen');
  ok(k.endsWith('Ergebnis: live'), 'Ergebnis am Ende');
}
eq(faelligStufe({ faellig_am: new Date(T0 - 1).toISOString() }, T0), 'ueberfaellig', 'überfällig');
eq(faelligStufe({ faellig_am: new Date(T0 + 3 * 3600_000).toISOString() }, T0), 'heute', 'heute fällig');
eq(faelligStufe({ faellig_am: new Date(T0 + 30 * 3600_000).toISOString() }, T0), 'spaeter', 'später');
eq(faelligStufe({}, T0), 'ohne', 'ohne Fälligkeit');
{
  const L = [
    { id: 1, status: 'geplant', rang: 2, erstellt_am: '1' },
    { id: 2, status: 'geplant', rang: 1, erstellt_am: '2' },
    { id: 3, status: 'laeuft', erstellt_am: '3' },
    { id: 4, status: 'geplant', faellig_am: new Date(T0 - MIN).toISOString(), erstellt_am: '4' },
    { id: 5, status: 'fertig', erstellt_am: '5' },
    { id: 6, status: 'geplant', erstellt_am: '6' },
  ];
  eq(offeneSortieren(L, T0).map((a) => a.id), [4, 3, 2, 1, 6], 'überfällig → läuft → gezogene Reihenfolge → Rest; Fertiges raus');
}
eq(rangAusIds([3, '1', 3, 0, 'x', 2]), { 3: 1, 1: 2, 2: 3 }, 'Rang aus ids: doppelt/leer übersprungen');
{
  const L = [
    { id: 1, fenster: 'se', status: 'pausiert', gestartet: '2026-10-31T08:00:00.000Z' },
    { id: 2, fenster: 'se', status: 'laeuft', gestartet: '2026-11-01T09:01:00.000Z' },
  ];
  eq(aufgabeFuersFenster(L, { name: 'se', erstellt_am: '2026-11-01T09:00:00.000Z' }).id, 2, 'Uhr: Aufgabe dieser Sitzung');
  eq(aufgabeFuersFenster([L[0]], { name: 'se', erstellt_am: '2026-11-01T09:00:00.000Z' }), null, 'Uhr: pausierte Aufgabe einer früheren Sitzung gleichen Namens bleibt weg');
  eq(aufgabeFuersFenster(L, { name: 'se', aufgabe_id: 1, erstellt_am: '2026-11-01T09:00:00.000Z' }).id, 1, 'Uhr: feste Bindung gewinnt');
  eq(aufgabeFuersFenster(L, null), null, 'kein Fenster → null');
}
{
  const L = [
    { id: 1, status: 'geplant', start_um: new Date(T0 - MIN).toISOString() },
    { id: 2, status: 'geplant', start_um: new Date(T0 - 7 * 3600_000).toISOString() },
    { id: 3, status: 'geplant', start_um: new Date(T0 + MIN).toISOString() },
    { id: 4, status: 'geplant', start_um: new Date(T0 - MIN).toISOString(), autostart: 'gestartet' },
    { id: 5, status: 'laeuft', start_um: new Date(T0 - MIN).toISOString() },
  ];
  eq(faelligeAutostarts(L, T0), { starten: [1], verpasst: [2] }, 'Autostart: dran / verpasst (> 6 h) / später / schon / läuft');
}
{
  const f = new Date(T0 - MIN).toISOString();
  eq(faelligeMeldungen([{ id: 1, status: 'geplant', faellig_am: f }, { id: 2, status: 'geplant', faellig_am: f, faellig_gemeldet: f }, { id: 3, status: 'fertig', faellig_am: f }], T0), [1], 'Fälligkeit genau einmal je Termin, nur offene');
}
{
  const s = standAusNachrichten([{ von: 'du', typ: 'fyi', inhalt: 'mach A', erstellt_am: '2026-11-01T09:05:00Z' }, { von: 'flottenchat', typ: 'system', inhalt: 'x' }, { von: 'Video', typ: 'answer', inhalt: 'A ist\nfertig' }]);
  eq(s, '10:05 du: mach A\nVideo: A ist fertig', 'Stand: Zeit + Absender + einzeilig, ohne System');
}
eq(ausErinnerung({ id: 4, titel: 'Steuer', notiz: 'Belege', faellig_am: '2026-11-03T08:00:00.000Z' }), { titel: 'Steuer', beschreibung: 'Belege', faellig_am: '2026-11-03T08:00:00.000Z', erinnerung_id: 4 }, 'Erinnerung → Aufgabe');
{
  const L = [
    { id: 1, titel: 'A', status: 'fertig', tage: { '2026-10-31': { mensch_aktiv_s: 60, claude_aktiv_s: 600 }, '2026-11-01': { claude_aktiv_s: 120, leerlauf_s: 60 } } },
    { id: 2, titel: 'B', status: 'laeuft', tage: { '2026-11-01': { mensch_aktiv_s: 300 } } },
    { id: 3, titel: 'C', status: 'fertig', tage: { '2026-10-01': { claude_aktiv_s: 999 } } },
  ];
  const w = auswertung(L, { von: '2026-10-31', bis: '2026-11-01' });
  eq(w.tage.map((t) => [t.tag, t.aktiv_s, t.aufgaben]), [['2026-11-01', 420, 2], ['2026-10-31', 660, 1]], 'Auswertung je Tag (neueste zuerst)');
  eq(w.aufgaben.map((a) => [a.id, a.aktiv_s]), [[1, 780], [2, 300]], 'Auswertung je Aufgabe im Zeitraum, außerhalb fällt weg');
  eq(w.summe.aktiv_s, 1080, 'Summe aktiv');
  eq(w.summe.warten_s, 60, 'Summe Warten/Leerlauf');
}

// ── Datenbank ──
const dir = mkdtempSync(join(tmpdir(), 'fc-aufg-'));
const db = openDb(dir);
erinnerungenSchema(db);
aufgabenSchema(db); aufgabenSchema(db);
ok(true, 'Schema zweimal anlegen ist harmlos (idempotent)');
ok(db.prepare('PRAGMA table_info(fenster)').all().some((c) => c.name === 'aufgabe_id'), 'fenster.aufgabe_id additiv ergänzt');
{
  eq(aufgabeAnlegen(db, { titel: '' }, T0), { ok: false, fehler: 'titel_fehlt' }, 'ohne Titel keine Aufgabe');
  const r = aufgabeAnlegen(db, { titel: 'Erste', label: 'Test', faellig_am: '2026-11-02T08:00:00Z' }, T0);
  ok(r.ok && r.aufgabe.id > 0, 'Aufgabe angelegt');
  eq([r.aufgabe.status, r.aufgabe.label, r.aufgabe.erst_fragen], ['geplant', 'Test', 1], 'Standardwerte');
  eq(r.aufgabe.zeiten, leereZeiten(), 'Zeiten leer');
  const id = r.aufgabe.id;
  eq(aufgabeAendern(db, id, { titel: 'Erste Aufgabe', erst_fragen: false }, T0).aufgabe.titel, 'Erste Aufgabe', 'ändern');
  eq(aufgabeHolen(db, id).erst_fragen, 0, 'Vorlage je Aufgabe aus');
  eq(aufgabeAendern(db, 999, {}, T0).fehler, 'unbekannt', 'unbekannte Aufgabe');
  eq(aufgabePausieren(db, id, T0).fehler, 'falscher_status', 'geplant lässt sich nicht pausieren');
  ok(aufgabeStarten(db, id, { fenster: 'erste' }, T0).ok, 'starten');
  eq(aufgabeStarten(db, id, { fenster: 'zweite' }, T0).fehler, 'schon_gestartet', 'Sperre: kein zweiter Start');
  ok(aufgabePausieren(db, id, T0).ok && aufgabeFortsetzen(db, id, T0).ok, 'pausieren + fortsetzen');
  zeitAddieren(db, id, { claude_aktiv_s: 20 }, T0);
  zeitAddieren(db, id, { mensch_aktiv_s: 20 }, Date.parse('2026-11-01T23:30:00Z'));
  const a = aufgabeHolen(db, id);
  eq(a.zeiten.claude_aktiv_s + a.zeiten.mensch_aktiv_s, 40, 'Zeiten summiert');
  eq(Object.keys(a.tage), ['2026-11-01', '2026-11-02'], 'Tages-Töpfe in Ortszeit (00:30 Berlin = neuer Tag)');
  const s = aufgabeStoppen(db, id, { stand_text: 'Stand X' }, T0 + MIN);
  eq([s.aufgabe.status, s.aufgabe.fenster, s.aufgabe.stand_text, s.aufgabe.laeufe.length], ['geplant', '', 'Stand X', 1], 'Stopp: zurück in die Liste, Lauf + Stand gemerkt');
  eq(s.aufgabe.zeiten.claude_aktiv_s, 20, 'Stopp: Zeit bleibt');
  ok(aufgabeStarten(db, id, { fenster: 'erste' }, T0).ok && aufgabeAbschliessen(db, id, { ergebnis: ' fertig ' }, T0).ok, 'erneut starten + abschließen');
  eq(aufgabeHolen(db, id).ergebnis, 'fertig', 'Ergebnis gespeichert');
  eq(aufgabeAbschliessen(db, id, {}, T0).fehler, 'schon_beendet', 'zweimal abschließen geht nicht');
  ok(aufgabeZurueckholen(db, id, T0).ok, 'fertige Aufgabe zurück in die Liste');
  ok(aufgabeVerwerfen(db, id, T0).ok && aufgabeHolen(db, id).status === 'abgebrochen', 'verwerfen = Papierkorb');
  ok(aufgabeZurueckholen(db, id, T0).ok, 'aus dem Papierkorb zurück');
  const b = aufgabeAnlegen(db, { titel: 'Zweite' }, T0).aufgabe, c = aufgabeAnlegen(db, { titel: 'Dritte' }, T0).aufgabe;
  reihenfolgeSetzen(db, [c.id, b.id, id], T0);
  eq(offeneSortieren(aufgabenAlle(db), T0).map((x) => x.titel), ['Dritte', 'Zweite', 'Erste Aufgabe'], 'gezogene Reihenfolge gespeichert');
  aufgabeStarten(db, b.id, { fenster: 'x' }, T0);
  eq(aufgabeLoeschen(db, b.id).fehler, 'schon_gestartet', 'laufende Aufgabe lässt sich nicht löschen');
  ok(aufgabeLoeschen(db, c.id).ok && !aufgabeHolen(db, c.id), 'endgültig löschen');
  aufgabeStoppen(db, b.id, {}, T0);
}

// ── Dienst (ohne tmux: Fenster per fensterAnlegen, Konsole als Attrappe) ──
{
  const zustand = {};
  const konsole = { zustand: (n) => zustand[n] || null };
  let jetztMs = T0;
  const events = [];
  const fensterBauen = (b) => {
    if (b.ordner === '/gibt/es/nicht') return { ok: false, fehler: 'Ordner fehlt: /gibt/es/nicht' };
    const f = fensterAnlegen(db, { name: b.name, label: b.label, ordner: b.ordner || dir, start_text: b.start_text });
    if (!f) return { ok: false, fehler: 'Name vergeben' };
    db.prepare("UPDATE fenster SET status = 'laeuft', erstellt_am = ? WHERE name = ?").run(new Date(jetztMs).toISOString(), f.name);
    zustand[f.name] = { lebt: true, busy: false, dialog: null };
    return { ok: true, fenster: fensterHolen(db, f.name), start: { ok: true } };
  };
  const D = createAufgabenDienst({ db, konsole, fensterBauen, broadcast: (e, d) => events.push([e, d]), jetzt: () => jetztMs, reminderUebergeben, log: { error: () => {} } });
  const msgs = (k) => db.prepare('SELECT * FROM messages WHERE kanal = ? ORDER BY id').all(k);
  // senden() stempelt mit der echten Uhr — im Test zählt die injizierte Zeit.
  const sendeUm = (m) => { const x = senden(db, m); db.prepare('UPDATE messages SET erstellt_am = ? WHERE id = ?').run(new Date(jetztMs - 5000).toISOString(), x.id); return x; };
  const karte = karteAnlegen(db, { titel: 'Relaunch' });
  const a = D.anlegen({ titel: 'Landingpage bauen', beschreibung: 'Hero + Formular', karte_id: karte.id }).aufgabe;
  const s1 = D.starten(a.id, {}, 'du');
  ok(s1.ok && s1.fenster.name === 'landingpage-bauen', 'Start legt ein Fenster mit Namen aus dem Titel an');
  eq(s1.fenster.label, 'Landingpage bauen', 'Kanal heißt wie die Aufgabe');
  ok(s1.fenster.start_text.includes('🎯 Aufgabe: Landingpage bauen') && s1.fenster.start_text.includes('Board-Karte #'), 'Start-Text aus der Aufgabe (mit Karte)');
  eq(Number(s1.fenster.aufgabe_id), a.id, 'Fenster ist fest an die Aufgabe gebunden');
  eq(D.starten(a.id).status, 409, 'zweiter Start → 409');
  ok(events.some(([e]) => e === 'aufgaben'), 'Änderung wird gesendet (SSE „aufgaben")');
  const k = s1.fenster.name;
  // Takt: Claude arbeitet
  zustand[k].busy = true; jetztMs += 20_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, a.id).zeiten.claude_aktiv_s, 20, 'Takt: Claude aktiv gezählt');
  // Mensch schreibt, Claude still, Dialog offen → Mensch aktiv (kein Warten)
  zustand[k].busy = false; zustand[k].dialog = { art: 'frage' };
  jetztMs += 20_000; sendeUm({ kanal: k, von: 'du', inhalt: 'Option 1' }); D.takt(jetztMs);
  eq(aufgabeHolen(db, a.id).zeiten.mensch_aktiv_s, 20, 'Takt: Mensch aktiv (eigene Nachricht < 60 s)');
  jetztMs += 70_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, a.id).zeiten.warten_mensch_s, 40, 'Takt: Rückfrage offen, Mensch still → Warten (gedeckelt 2 Takte)');
  zustand[k].dialog = null;
  ok(D.liste(jetztMs).je_fenster[k] === a.id, 'Liste: Uhr je Fenster');
  // Stopp → Stand
  senden(db, { kanal: k, von: 'Landingpage bauen', typ: 'answer', inhalt: 'Hero steht, Formular fehlt.' });
  const st = D.stoppen(a.id, 'du');
  ok(st.ok && st.aufgabe.status === 'geplant', 'Stopp → zurück in die Liste');
  ok(st.aufgabe.stand_text.includes('Hero steht'), 'Stopp merkt den Stand aus dem Kanal');
  eq(fensterHolen(db, k).aufgabe_id, null, 'Stopp löst die Bindung am Fenster');
  ok(msgs(k).some((m) => m.typ === 'task' && m.inhalt.startsWith('⏏ Aufgabe gestoppt')), 'Stopp-Hinweis geht als Auftrag ins Fenster');
  ok(karteHolen(db, karte.id).verlauf.some((v) => v.text.includes('gestoppt')), 'Stopp steht im Verlauf der Karte');
  jetztMs += 20_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, a.id).zeiten.leerlauf_s, 0, 'gestoppt wird nicht weiter gemessen');
  // Weiter im alten Fenster
  const w1 = D.starten(a.id, {}, 'du');
  ok(w1.ok && w1.weiter_im_alten_fenster && w1.fenster.name === k, 'Weiter im alten Fenster, wenn es noch läuft');
  ok(msgs(k).some((m) => m.typ === 'task' && m.inhalt.startsWith('▶ Aufgabe geht weiter')), 'Weiter-Auftrag im Fenster');
  // Stopp + Weiter in einem neuen Fenster mit Stand
  D.stoppen(a.id, 'du');
  const w2 = D.starten(a.id, { neues_fenster: true }, 'du');
  ok(w2.ok && w2.fenster.name === 'landingpage-bauen-2', 'Weiter im neuen Fenster (Name frei gemacht)');
  ok(w2.fenster.start_text.includes('wurde gestoppt') && w2.fenster.start_text.includes('Hero steht'), 'neues Fenster bekommt den Stand im Start-Text');
  ok(!w2.fenster.start_text.includes('geht weiter') && !w2.fenster.start_text.includes('⏏'), 'Stand ohne die eigenen Automatik-Aufträge');
  // Fertig-Satz: alte Nachricht im Kanal zählt nicht, nur die neue Antwort des Fensters
  const k2 = w2.fenster.name;
  senden(db, { kanal: k2, von: 'du', inhalt: `${FERTIG_SATZ} vom Menschen getippt` });
  jetztMs += 20_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, a.id).status, 'laeuft', 'Fertig-Satz vom Menschen zählt nicht');
  senden(db, { kanal: k2, von: 'Landingpage bauen', typ: 'answer', inhalt: `Alles drin.\n${FERTIG_SATZ} Seite ist live` });
  jetztMs += 20_000; D.takt(jetztMs);
  const fa = aufgabeHolen(db, a.id);
  eq([fa.status, fa.ergebnis], ['fertig', 'Seite ist live'], 'Fertig-Satz des Fensters schließt ab');
  ok(msgs(k2).some((m) => m.typ === 'done' && m.inhalt.startsWith('🏁 Aufgabe fertig: Landingpage bauen')), 'Abschluss-Karte im Kanal');
  ok(karteHolen(db, karte.id).verlauf.some((v) => v.text.startsWith('🏁')), 'Abschluss im Verlauf der Karte');
  eq(fensterHolen(db, k2).aufgabe_id, null, 'nach Abschluss ist das Fenster frei');
  eq(D.liste(jetztMs).je_fenster[k2], undefined, 'Uhr verschwindet nach Abschluss');
  // Kanal schließen = erledigt
  const b = D.anlegen({ titel: 'Kanal zu' }).aufgabe; const sb = D.starten(b.id);
  D.fensterGeschlossen(sb.fenster.name);
  eq([aufgabeHolen(db, b.id).status, aufgabeHolen(db, b.id).ergebnis], ['fertig', 'Kanal geschlossen'], 'Kanal schließen = Aufgabe erledigt');
  // Fenster gelöscht = Stopp; verwaist im Takt = Stopp
  const c = D.anlegen({ titel: 'Gelöscht' }).aufgabe; const sc = D.starten(c.id);
  D.fensterGeloescht(sc.fenster.name);
  eq(aufgabeHolen(db, c.id).status, 'geplant', 'Fenster löschen = Stopp (Stand bleibt)');
  const d = D.anlegen({ titel: 'Verwaist' }).aufgabe; const sd = D.starten(d.id);
  fensterLoeschen(db, sd.fenster.name); jetztMs += 20_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, d.id).status, 'geplant', 'Fenster weg → Takt stellt die Aufgabe zurück in die Liste');
  // Totes Fenster → nach 90 s pausiert
  const e = D.anlegen({ titel: 'Abgestürzt' }).aufgabe; const se = D.starten(e.id);
  zustand[se.fenster.name].lebt = false; jetztMs += 30_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, e.id).status, 'laeuft', 'totes Fenster: erst nach 90 s pausieren');
  jetztMs += 90_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, e.id).status, 'pausiert', 'totes Fenster → Aufgabe pausiert');
  D.verwerfen(e.id);
  eq(aufgabeHolen(db, e.id).status, 'abgebrochen', 'verwerfen aus Pause');
  // Start scheitert → Aufgabe bleibt geplant
  const g = D.anlegen({ titel: 'Kaputt', ordner: '/gibt/es/nicht' }).aufgabe;
  const sg = D.starten(g.id);
  ok(!sg.ok && sg.status === 400 && /Ordner fehlt/.test(sg.fehler), 'Start-Fehler wird gemeldet');
  eq(aufgabeHolen(db, g.id).status, 'geplant', 'nach Start-Fehler bleibt die Aufgabe geplant');
  // Autostart im Takt
  const h = D.anlegen({ titel: 'Um zehn', start_um: new Date(jetztMs - MIN).toISOString() }).aufgabe;
  const v = D.anlegen({ titel: 'Verpasst', start_um: new Date(jetztMs - 8 * 3600_000).toISOString() }).aufgabe;
  D.takt(jetztMs);
  eq([aufgabeHolen(db, h.id).status, aufgabeHolen(db, h.id).autostart], ['laeuft', 'gestartet'], 'Autostart zur Uhrzeit');
  eq(aufgabeHolen(db, v.id).autostart, 'verpasst', 'zu alter Autostart wird nicht nachgeholt');
  ok(msgs('erinnerungen').some((m) => m.inhalt.includes('„Verpasst“ sollte um')), 'verpasster Autostart steht in „Erinnerungen"');
  D.stoppen(h.id); jetztMs += 20_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, h.id).status, 'geplant', 'nach Stopp kein zweiter Autostart');
  const hv = D.anlegen({ titel: 'Früher von Hand', start_um: new Date(jetztMs + 3600_000).toISOString() }).aufgabe;
  D.starten(hv.id); D.stoppen(hv.id); jetztMs += 2 * 3600_000; D.takt(jetztMs);
  eq(aufgabeHolen(db, hv.id).status, 'geplant', 'von Hand vor der Startzeit gestartet = Autostart verbraucht');
  // Fälligkeit: einmal melden, nach Verschieben erneut
  const fz = D.anlegen({ titel: 'Steuer abgeben', faellig_am: new Date(jetztMs - MIN).toISOString() }).aufgabe;
  D.takt(jetztMs); D.takt(jetztMs + 20_000);
  eq(msgs('erinnerungen').filter((m) => m.inhalt.startsWith('⏰ Aufgabe fällig: Steuer abgeben')).length, 1, 'Fälligkeit meldet sich genau einmal in „Erinnerungen"');
  aufgabeAendern(db, fz.id, { faellig_am: new Date(jetztMs + 10 * MIN).toISOString() }, jetztMs);
  jetztMs += 11 * MIN; D.takt(jetztMs);
  eq(msgs('erinnerungen').filter((m) => m.inhalt.startsWith('⏰ Aufgabe fällig: Steuer abgeben')).length, 2, 'verschoben → meldet sich zum neuen Termin wieder');
  // Erinnerung → Aufgabe
  const rem = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Angebot nachfassen', notiz: 'Mail von Montag', faellig_am: new Date(jetztMs + 3600_000).toISOString() });
  const ra = D.ausErinnerungAnlegen(rem.id, { starten: false });
  ok(ra.ok && ra.aufgabe.beschreibung === 'Mail von Montag' && ra.aufgabe.erinnerung_id === rem.id, 'Erinnerung → Aufgabe (Notiz = Beschreibung)');
  eq(db.prepare('SELECT status, uebergeben_an FROM reminders WHERE id = ?').get(rem.id), { status: 'uebergeben', uebergeben_an: `aufgabe:${ra.aufgabe.id}` }, 'Erinnerung gilt als übergeben');
  eq(faelligeFeuern(db, new Date(jetztMs + 7200_000)).length, 0, 'übergebene Erinnerung feuert nicht mehr doppelt');
  const rem2 = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Backup prüfen' });
  const rs = D.ausErinnerungAnlegen(rem2.id, { starten: true });
  ok(rs.ok && rs.fenster && rs.fenster.name === 'backup-pruefen' && rs.aufgabe.status === 'laeuft', '„▶ Fenster" an einer Erinnerung = Aufgabe mit Zeitmessung');
  eq(D.ausErinnerungAnlegen(9999).status, 404, 'unbekannte Erinnerung → 404');

  // ── Routen ──
  const rufe = async (methode, pfad, body = {}, rolle = 'admin') => {
    let raus = null;
    const json = (_res, code, obj) => { raus = { code, obj }; };
    const erledigt = await D.route({ req: { method: methode }, res: {}, url: new URL(pfad, 'http://x'), wer: { rolle, name: 'du' }, json, koerper: async () => body });
    return erledigt ? raus : null;
  };
  const l = await rufe('GET', '/api/aufgaben');
  ok(l.code === 200 && Array.isArray(l.obj.aufgaben) && Array.isArray(l.obj.offen), 'GET /api/aufgaben');
  ok(l.obj.aufgaben.every((x) => x.tage === undefined), 'Liste ohne Tages-Töpfe (schlank)');
  const neu = await rufe('POST', '/api/aufgaben', { titel: 'Per API', label: 'api' });
  ok(neu.code === 200 && neu.obj.aufgabe.label === 'api', 'POST /api/aufgaben legt an');
  eq((await rufe('POST', '/api/aufgaben', { titel: '' })).code, 400, 'ohne Titel → 400');
  eq((await rufe('POST', '/api/aufgaben', { titel: 'x' }, 'agent')).code, 403, 'Agent-Token darf nicht schreiben');
  ok((await rufe('GET', '/api/aufgaben', {}, 'agent')).code === 200, 'Agent-Token darf lesen');
  const pid = neu.obj.aufgabe.id;
  eq((await rufe('POST', `/api/aufgaben/${pid}`, { titel: 'Per API geändert' })).obj.aufgabe.titel, 'Per API geändert', 'ändern per API');
  eq((await rufe('POST', `/api/aufgaben/${pid}/pause`)).code, 409, 'Pause auf geplant → 409');
  const ps = await rufe('POST', `/api/aufgaben/${pid}/start`);
  ok(ps.code === 200 && ps.obj.fenster, 'Start per API');
  eq((await rufe('POST', `/api/aufgaben/${pid}/start`)).code, 409, 'zweiter Start per API → 409');
  ok((await rufe('POST', `/api/aufgaben/${pid}/pause`)).obj.aufgabe.status === 'pausiert', 'Pause per API');
  ok((await rufe('POST', `/api/aufgaben/${pid}/weiter`)).obj.aufgabe.status === 'laeuft', 'Weiter per API');
  const pf = await rufe('POST', `/api/aufgaben/${pid}/fertig`, { ergebnis: 'per Knopf' });
  eq([pf.code, pf.obj.aufgabe.status, pf.obj.aufgabe.ergebnis], [200, 'fertig', 'per Knopf'], 'Fertig per Knopf mit Ergebnis');
  eq((await rufe('POST', `/api/aufgaben/${pid}/zurueck`)).obj.aufgabe.status, 'geplant', 'zurückholen per API');
  eq((await rufe('POST', `/api/aufgaben/${pid}/verwerfen`)).obj.aufgabe.status, 'abgebrochen', 'verwerfen per API');
  eq((await rufe('POST', `/api/aufgaben/${pid}/loeschen`)).code, 200, 'endgültig löschen per API');
  eq((await rufe('POST', '/api/aufgaben/99999/start')).code, 404, 'unbekannte Aufgabe → 404');
  eq((await rufe('POST', '/api/aufgaben/reihenfolge', { ids: [3, 1] })).obj.gesetzt, 2, 'Reihenfolge per API');
  eq((await rufe('POST', '/api/aufgaben/reihenfolge', {})).code, 400, 'Reihenfolge ohne ids → 400');
  const aw = await rufe('GET', '/api/aufgaben/auswertung?von=2026-10-01&bis=2026-12-31');
  ok(aw.code === 200 && aw.obj.tage.length >= 1 && aw.obj.summe.aktiv_s > 0, 'Auswertung per API');
  const rem3 = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Alte API' });
  const rr = await rufe('POST', `/api/reminders/${rem3.id}/session`, {});
  ok(rr.code === 200 && rr.obj.fenster && rr.obj.fenster.name && rr.obj.aufgabe, 'alte Route /api/reminders/<id>/session bleibt nutzbar (jetzt mit Aufgabe)');
  eq(await rufe('GET', '/api/channels'), null, 'fremde Pfade fasst die Aufgaben-Route nicht an');
}
rmSync(dir, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

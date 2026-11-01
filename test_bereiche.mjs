// test_bereiche.mjs — Bereiche (1.2.1): reine Logik, Datenbank (Migration idempotent), Dienst + Routen ohne tmux,
// Aufgaben nehmen Ort/Ordner/Modus aus dem Bereich.
// Muster: pass/fail-Zähler, letzte Zeile "N passed, M failed".
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, fensterAnlegen, fensterHolen, fensterAlle, fensterAendern, kanalAnlegen, kanaele } from './server/db.mjs';
import {
  kuerzelAus, kuerzelSauber, bereichSaeubern, naechsterName, fensterAngaben, loeschenPruefen, ortText, WISSEN_HINWEIS, artSauber,
  bereicheSchema, bereichAnlegen, bereichAendern, bereichHolen, bereicheAlle, bereichLoeschen, fensterBereichSetzen,
  createBereicheDienst,
} from './server/bereiche.mjs';
import { createAufgabenDienst, aufgabeHolen } from './server/aufgaben.mjs';
import { startBefehl, WISSEN_GESPERRT } from './server/orte.mjs';
import { archivMarkieren } from './server/verlauf.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

// ── Kürzel ──
eq(kuerzelAus('Sales Engine'), 'sales-engine', 'Kürzel aus Name: Slug');
eq(kuerzelAus('Büro & Steuern'), 'buero-steuern', 'Umlaute werden umschrieben');
eq(kuerzelAus('Web 2'), 'web', 'Ziffern am Ende fallen weg (sonst „web-2-3")');
eq(kuerzelAus('Ein sehr langer Bereichsname für alles'), 'ein-sehr-langer', 'Kürzel höchstens 16 Zeichen, ohne Strich am Ende');
eq(kuerzelAus(''), 'fenster', 'leerer Name → „fenster"');
eq(kuerzelAus('!!!'), 'fenster', 'nur Sonderzeichen → „fenster"');
eq(kuerzelSauber(' SE '), 'se', 'getipptes Kürzel klein + getrimmt');
eq(kuerzelSauber('a b/c'), 'a-b-c', 'getipptes Kürzel ohne Sonderzeichen');
eq(kuerzelSauber(''), '', 'leeres Kürzel bleibt leer (dann aus dem Namen)');
eq(kuerzelSauber('se3'), 'se', 'Ziffern am Ende auch beim getippten Kürzel weg');

// ── Validierung ──
{
  const r = bereichSaeubern({ name: '  Sales   Engine ', ordner: '/srv/se' });
  ok(r.ok, 'gültiger Bereich');
  eq(r.bereich.name, 'Sales Engine', 'Name getrimmt/zusammengezogen');
  eq(r.bereich.kuerzel, 'sales-engine', 'Kürzel automatisch');
  eq(r.bereich.ort, 'lokal', 'Ort Standard „lokal"');
  ok(!('start_modus' in r.bereich), 'kein Start-Modus im Bereich (immer auto)');
  eq(r.bereich.worktree, 0, 'Ordner ohne Repo → kein Worktree');
  eq(bereichSaeubern({ name: 'X', ordner: '/srv/repo' }, { istRepo: (o) => o === '/srv/repo' }).bereich.worktree, 1, 'Ordner ist ein Repo → Worktree Standard an');
  eq(bereichSaeubern({ name: 'X', ordner: '/srv/repo', worktree: false }, { istRepo: () => true }).bereich.worktree, 0, 'Worktree abwählbar');
  eq(bereichSaeubern({ name: 'X', repo: '/srv/repo' }).bereich, { ...bereichSaeubern({ name: 'X' }).bereich, ordner: '/srv/repo', worktree: 1 }, 'repo → ordner + Worktree an');
  eq(bereichSaeubern({ name: 'X', repo: '/srv/repo', worktree: 0 }).bereich.worktree, 0, 'repo mit worktree:0 → ohne Worktree');
  eq(bereichSaeubern({ name: '' }).fehler, 'Name fehlt.', 'Name ist Pflicht');
  eq(bereichSaeubern({ name: '<>' }).ok, false, 'nur Spitzklammern → Name leer');
  ok(!bereichSaeubern({ name: 'X', ort: 'ssh:a;rm -rf' }).ok, 'Ort mit Shell-Zeichen abgelehnt');
  ok(!bereichSaeubern({ name: 'X', ort: 'irgendwo' }).ok, 'unbekannter Ort abgelehnt');
  eq(bereichSaeubern({ name: 'X', ort: 'ssh:user@host', repo: '/srv/r' }).bereich.worktree, 0, 'Worktree nur lokal');
  eq(bereichSaeubern({ name: 'X', ort: 'geraet:mac-1' }).bereich.ort, 'geraet:mac-1', 'Geräte-Ort erlaubt');
  ok(!bereichSaeubern({ name: 'X', ordner: 'relativ/pfad' }).ok, 'relativer Ordner abgelehnt');
  ok(!('start_modus' in bereichSaeubern({ name: 'X', start_modus: 'plan' }).bereich), 'Start-Modus wird ignoriert');
  eq(bereichSaeubern({ name: 'X', start_text: 'a'.repeat(5000) }).bereich.start_text.length, 3900, 'Start-Text gekappt');
  const alt = { id: 3, name: 'Alt', kuerzel: 'alt', ort: 'lokal', ordner: '/a', worktree: 1, start_text: 'hi', rang: 2 };
  eq(bereichSaeubern({ name: 'Neu' }, { alt }).bereich, { ...alt, name: 'Neu' }, 'Ändern: nur der Name, Kürzel bleibt');
  eq(bereichSaeubern({ kuerzel: '' }, { alt }).bereich.kuerzel, 'alt', 'Ändern: leeres Kürzel → aus dem Namen');
  eq(bereichSaeubern({ kuerzel: 'NEU' }, { alt }).bereich.kuerzel, 'neu', 'Ändern: Kürzel neu');
  ok(!bereichSaeubern({ name: ' ' }, { alt }).ok, 'Ändern: Name leeren geht nicht');
}

// ── Namensvergabe ──
eq(naechsterName('se'), { name: 'se-bau-1', n: 1, art: 'bau' }, 'erstes Baufenster „se-bau-1"');
eq(naechsterName('se', 'wissen'), { name: 'se-wissen-1', n: 1, art: 'wissen' }, 'erstes Wissensfenster „se-wissen-1"');
eq(naechsterName('se', 'bau', (n) => ['se-bau-1', 'se-bau-2'].includes(n)), { name: 'se-bau-3', n: 3, art: 'bau' }, 'nächste freie Zahl');
eq(naechsterName('se', 'bau', (n) => ['se-bau-1', 'se-bau-3'].includes(n)).name, 'se-bau-2', 'Lücke wird wieder benutzt (kleinste freie)');
eq(naechsterName('se', 'wissen', (n) => n === 'se-bau-1').name, 'se-wissen-1', 'Zählung je Art getrennt');
eq(naechsterName('se', 'bau', () => true, 5), null, 'alles belegt → null');
eq(naechsterName('', 'bau', () => false).name, 'fenster-bau-1', 'ohne Kürzel → fenster-bau-1');
eq(naechsterName('se', 'quatsch').art, 'bau', 'unbekannte Art → bau');
eq(artSauber('wissen'), 'wissen', 'Art wissen');
ok(naechsterName('se', 'bau').name !== naechsterName('web', 'bau').name, 'Kürzel macht Namen über Bereiche eindeutig');

// ── Fenster-Angaben ──
{
  const b = { id: 7, name: 'Sales Engine', kuerzel: 'se', ort: 'lokal', ordner: '/srv/se', worktree: 1, start_text: 'Lies die CLAUDE.md' };
  eq(fensterAngaben(b, { name: 'se-bau-2', n: 2 }), { name: 'se-bau-2', label: 'Bau 2', ort: 'lokal', start_modus: 'auto', bereich_id: 7, art: 'bau', start_text: 'Lies die CLAUDE.md', repo: '/srv/se' }, 'Bau: Repo + Worktree → repo, Label „Bau 2"');
  const w = fensterAngaben(b, { name: 'se-wissen-1', n: 1, art: 'wissen' });
  eq([w.label, w.art, w.start_modus, w.ordner, w.repo], ['Wissen 1', 'wissen', 'auto', '/srv/se', undefined], 'Wissen: Auto-Modus, kein Worktree (liest im Repo selbst)');
  eq(w.start_text, WISSEN_HINWEIS, 'Wissen: Start-Text ist die Regel (nicht der Bau-Satz des Bereichs)');
  ok(/nichts bauen/.test(WISSEN_HINWEIS) && /Baufenster/.test(WISSEN_HINWEIS), 'Regel nennt „nichts bauen" und verweist aufs Baufenster');
  ok(fensterAngaben(b, { name: 'x', n: 1, art: 'wissen', start_text: 'Was macht X?' }).start_text.endsWith('Was macht X?'), 'Wissen: eigene Frage hängt hinter der Regel');
  eq(fensterAngaben({ ...b, worktree: 0 }, { name: 'se-1', n: 1 }).ordner, '/srv/se', 'ohne Worktree → ordner');
  eq(fensterAngaben({ ...b, ort: 'ssh:u@h' }, { name: 'se-1', n: 1 }).ordner, '/srv/se', 'SSH → immer ordner');
  eq(fensterAngaben(b, { name: 'se-1', n: 1, start_text: ' Eigener Satz ' }).start_text, 'Eigener Satz', 'eigener Start-Text überschreibt');
  eq(fensterAngaben(b, { name: 'se-1', n: 1, start_text: '  ' }).start_text, 'Lies die CLAUDE.md', 'leerer eigener Text → der des Bereichs');
  ok(!('ordner' in fensterAngaben({ ...b, ordner: '' }, { name: 'se-1', n: 1 })) && !('repo' in fensterAngaben({ ...b, ordner: '' }, { name: 'se-1', n: 1 })), 'ohne Ordner → Standard des Servers');
}

// ── Löschsperre ──
{
  const fs = [{ name: 'se-1', label: 'Bau 1', bereich_id: 1, status: 'laeuft' }, { name: 'se-2', bereich_id: 1, status: 'aus' }, { name: 'x-1', bereich_id: 2, status: 'laeuft' }];
  const r = loeschenPruefen(1, fs);
  eq([r.ok, r.status], [false, 409], 'laufendes Fenster sperrt das Löschen (409)');
  ok(/Bau 1/.test(r.fehler) && /erst schließen/.test(r.fehler), 'Fehlertext nennt das Fenster');
  eq(loeschenPruefen(1, fs.map((f) => ({ ...f, status: 'aus' }))), { ok: true, loesen: ['se-1', 'se-2'] }, 'nur ausgeschaltete Fenster → erlaubt, Zuordnung wird gelöst');
  eq(loeschenPruefen(1, [{ name: 'se-1', bereich_id: 1, status: 'aus' }], () => true).ok, false, 'Konsole sagt „lebt" → gesperrt');
  eq(loeschenPruefen(3, fs).ok, true, 'Bereich ohne Fenster → erlaubt');
}
eq(ortText('lokal'), 'Dieser Server', 'Ort-Text lokal');
eq(ortText('ssh:u@h'), 'u@h', 'Ort-Text SSH');
eq(ortText('geraet:mac-1', { 'mac-1': 'Mac mini' }), 'Mac mini', 'Ort-Text Gerät');

// ── Datenbank: Migration idempotent, CRUD ──
const dir = mkdtempSync(join(tmpdir(), 'fc-bereiche-'));
try {
  let db = openDb(dir);
  fensterAnlegen(db, { name: 'alt-fenster', ordner: '/tmp' }); // Bestand aus 1.2
  bereicheSchema(db); bereicheSchema(db);
  ok(db.prepare('PRAGMA table_info(fenster)').all().some((c) => c.name === 'bereich_id'), 'Spalte fenster.bereich_id da');
  eq(db.prepare('PRAGMA table_info(fenster)').all().filter((c) => c.name === 'bereich_id').length, 1, 'Spalte nur einmal (idempotent)');
  eq(fensterHolen(db, 'alt-fenster').bereich_id, null, 'bestehende Fenster bleiben ohne Bereich');
  const a = bereichAnlegen(db, { name: 'Sales Engine', kuerzel: 'SE', ordner: '/srv/se' });
  ok(a.ok && a.bereich.id > 0, 'Bereich angelegt');
  eq(a.bereich.kuerzel, 'se', 'Kürzel gespeichert');
  eq(a.bereich.rang, 1, 'erster Bereich Rang 1');
  const b2 = bereichAnlegen(db, { name: 'Website' }).bereich;
  eq(b2.rang, 2, 'zweiter Bereich hinten');
  eq(bereichAnlegen(db, { name: '' }).ok, false, 'ungültig → nicht angelegt');
  eq(bereicheAlle(db).map((x) => x.name), ['Sales Engine', 'Website'], 'Liste nach Rang');
  bereichAendern(db, b2.id, { rang: 0 });
  eq(bereicheAlle(db).map((x) => x.name), ['Website', 'Sales Engine'], 'Rang ändert die Reihenfolge');
  eq(bereichAendern(db, 999, { name: 'x' }).status, 404, 'Ändern unbekannt → 404');
  eq(bereichAendern(db, a.bereich.id, { ort: 'quatsch' }).ok, false, 'Ändern prüft auch');
  eq(bereichHolen(db, a.bereich.id).ort, 'lokal', 'ungültige Änderung nicht gespeichert');
  db.close();
  db = openDb(dir); bereicheSchema(db); // Neustart: Migration läuft nochmal, nichts geht verloren
  eq(bereicheAlle(db).length, 2, 'nach Neustart: Bereiche noch da');

  // ── Dienst: Fenster starten (fensterBauen ohne tmux) ──
  const gebaut = [];
  const fensterBauen = (b) => {
    gebaut.push(b);
    const f = fensterAnlegen(db, { name: b.name, label: b.label, ort: b.ort, ordner: b.ordner || b.repo || '/tmp', start_modus: b.start_modus, start_text: b.start_text, worktree: b.repo ? 1 : 0 });
    if (!f) return { ok: false, fehler: 'Name vergeben' };
    if (b.bereich_id || b.art) fensterBereichSetzen(db, f.name, b.bereich_id || null, b.art || null);
    fensterAendern(db, f.name, { status: 'laeuft' });
    return { ok: true, fenster: fensterHolen(db, f.name), start: { ok: true } };
  };
  const events = [];
  let lebend = new Set();
  const dienst = createBereicheDienst({
    db, fensterBauen, broadcast: (e, d) => events.push([e, d]),
    fensterAlle: () => fensterAlle(db),
    belegt: (n) => !!fensterHolen(db, n) || kanaele(db).some((k) => k.name === n && !k.archiviert),
    lebt: (f) => lebend.has(f.name),
    istRepo: (o) => o === '/srv/repo',
    standard: () => ({ ordner: '/srv/repo', name: 'repo', repo: true }),
  });
  const se = bereicheAlle(db).find((x) => x.kuerzel === 'se');
  const r1 = dienst.fensterStarten(se.id);
  eq([r1.ok, r1.fenster.name, r1.fenster.label, r1.fenster.art], [true, 'se-bau-1', 'Bau 1', 'bau'], 'erstes Fenster „se-bau-1" / „Bau 1"');
  eq(r1.fenster.bereich_id, se.id, 'Fenster gehört zum Bereich');
  eq(r1.fenster.start_modus, 'auto', 'Auto-Modus');
  eq(kanaele(db).find((k) => k.name === 'se-bau-1').label, 'Sales Engine · Bau 1', 'Kanal-Anzeige mit Bereich (für Suche/Archiv)');
  const r2 = dienst.fensterStarten(se.id, { start_text: 'Mach X' });
  eq(r2.fenster.name, 'se-bau-2', 'zweites Baufenster im gleichen Bereich → „se-bau-2"');
  eq(gebaut[1].start_text, 'Mach X', 'eigener Start-Text kommt an');
  kanalAnlegen(db, { name: 'se-bau-3', label: 'Fremder Kanal' });
  eq(dienst.fensterStarten(se.id).fenster.name, 'se-bau-4', 'aktiver Kanal gleichen Namens wird übersprungen');
  const wi = dienst.fensterStarten(se.id, { art: 'wissen' });
  eq([wi.fenster.name, wi.fenster.label, wi.fenster.art], ['se-wissen-1', 'Wissen 1', 'wissen'], 'Wissensfenster „se-wissen-1" / „Wissen 1"');
  ok(/nichts bauen/.test(wi.fenster.start_text), 'Wissensfenster bekommt die Regel als Start-Text');
  eq(dienst.fensterStarten(999).status, 404, 'unbekannter Bereich → 404');
  ok(events.some(([e, d]) => e === 'presence' && d.fenster === 'se-bau-1'), 'presence-Event fürs neue Fenster');

  // ── Routen ──
  const anfrage = async (method, pfad, body = {}, admin = true) => {
    let antwort = null;
    const res = {};
    const json = (_res, status, obj) => { antwort = { status, ...obj }; };
    await dienst.route({ req: { method }, res, url: new URL('http://x' + pfad), admin, json, koerper: async () => body });
    return antwort;
  };
  const g = await anfrage('GET', '/api/bereiche');
  eq([g.status, g.bereiche.length, g.standard.repo], [200, 2, true], 'GET /api/bereiche mit Standard fürs Formular');
  eq((await anfrage('POST', '/api/bereiche', { name: 'X' }, false)).status, 403, 'nur Admin legt an');
  const p = await anfrage('POST', '/api/bereiche', { name: 'Kunden Portal', ordner: '/srv/repo', starten: true });
  eq([p.status, p.fenster && p.fenster.name, p.bereich.worktree], [200, 'kunden-portal-bau-1', 1], 'POST mit starten:true → Bereich + erstes Baufenster, Repo → Worktree');
  eq(gebaut[gebaut.length - 1].repo, '/srv/repo', 'Fenster bekommt das Repo (eigener Worktree)');
  const kp = p.bereich.id;
  const ae = await anfrage('POST', `/api/bereiche/${kp}`, { name: 'Portal' });
  eq([ae.status, ae.bereich.name, ae.bereich.kuerzel], [200, 'Portal', 'kunden-portal'], 'POST /api/bereiche/<id> ändert (Kürzel bleibt)');
  const f2 = await anfrage('POST', `/api/bereiche/${kp}/fenster`, { art: 'wissen' });
  eq([f2.status, f2.fenster.name, f2.fenster.label, f2.fenster.worktree], [200, 'kunden-portal-wissen-1', 'Wissen 1', 0], 'POST …/fenster {art:wissen} → Wissensfenster ohne Worktree');
  eq(gebaut[gebaut.length - 1].ordner, '/srv/repo', 'Wissensfenster liest im Repo selbst');
  const l1 = await anfrage('POST', `/api/bereiche/${kp}/loeschen`);
  eq(l1.status, 409, 'Löschen mit laufenden Fenstern → 409');
  ok(/erst schließen/.test(l1.fehler), '409 mit Text');
  for (const n of ['kunden-portal-bau-1', 'kunden-portal-wissen-1']) fensterAendern(db, n, { status: 'aus' });
  lebend = new Set(['kunden-portal-wissen-1']);
  eq((await anfrage('POST', `/api/bereiche/${kp}/loeschen`)).status, 409, 'Konsole lebt noch → weiter gesperrt');
  lebend = new Set();
  const l2 = await anfrage('POST', `/api/bereiche/${kp}/loeschen`);
  eq([l2.status, l2.geloest], [200, ['kunden-portal-bau-1', 'kunden-portal-wissen-1']], 'alles aus → gelöscht, Zuordnung gelöst');
  eq(fensterHolen(db, 'kunden-portal-bau-1').bereich_id, null, 'Fenster bleiben, nur ohne Bereich („Weitere Fenster")');
  eq(bereichHolen(db, kp), null, 'Bereich weg');
  eq((await anfrage('POST', '/api/bereiche/9999/loeschen')).status, 404, 'Löschen unbekannt → 404');
  eq((await anfrage('POST', '/api/bereiche', { name: 'Y', ort: 'ssh:a b' })).status, 400, 'ungültige Eingabe → 400');
  eq(bereichLoeschen(db, 12345).status, 404, 'bereichLoeschen unbekannt → 404');

  // ── Aufgaben: Ort/Ordner/Modus aus dem Bereich ──
  const ab = [];
  const aufg = createAufgabenDienst({
    db, konsole: { zustand: () => null }, broadcast: () => {}, jetzt: () => Date.parse('2026-11-01T10:00:00Z'), log: { log() {}, error() {} },
    bereichHolen: (id) => bereichHolen(db, id),
    fensterBauen: (b) => { ab.push(b); return fensterBauen(b); },
  });
  const web = bereichAendern(db, b2.id, { ordner: '/srv/web', worktree: 0, ort: 'lokal' }).bereich;
  const a1 = aufg.anlegen({ titel: 'Impressum prüfen', bereich_id: web.id });
  eq(a1.aufgabe.bereich_id, web.id, 'Aufgabe merkt sich den Bereich');
  const s1 = aufg.starten(a1.aufgabe.id);
  ok(s1.ok, 'Aufgabe startet');
  eq([ab[0].ordner, ab[0].start_modus, ab[0].bereich_id, ab[0].name], ['/srv/web', 'auto', web.id, 'impressum-pruefen'], 'Start nimmt den Ordner aus dem Bereich (Auto), Name aus dem Titel');
  ok(ab[0].art !== 'wissen', 'Aufgaben starten als Baufenster');
  eq(fensterHolen(db, 'impressum-pruefen').bereich_id, web.id, 'Aufgaben-Fenster steht unter dem Bereich');
  const a2 = aufg.anlegen({ titel: 'Eigenes', bereich_id: se.id, ordner: '/srv/eigen' });
  aufg.starten(a2.aufgabe.id);
  eq([ab[1].ordner, ab[1].repo], ['/srv/eigen', undefined], 'eigener Ordner der Aufgabe gewinnt');
  const a3 = aufg.anlegen({ titel: 'Repo-Aufgabe', bereich_id: se.id });
  bereichAendern(db, se.id, { repo: '/srv/repo' });
  aufg.starten(a3.aufgabe.id);
  eq(ab[2].repo, '/srv/repo', 'Bereich mit Worktree → Aufgabe bekommt eigenen Worktree');
  const a4 = aufg.anlegen({ titel: 'Ohne Bereich' });
  aufg.starten(a4.aufgabe.id);
  eq([ab[3].ordner, ab[3].repo, ab[3].bereich_id], [undefined, undefined, undefined], 'ohne Bereich wie in 1.2');
  eq(aufgabeHolen(db, a4.aufgabe.id).bereich_id, null, 'Aufgabe ohne Bereich bleibt ohne');
  db.close();
} finally { rmSync(dir, { recursive: true, force: true }); }

// ── Wissensfenster: harte Sperre im Startbefehl ──
{
  const wb = startBefehl({ ordner: '/srv/x', art: 'wissen', start_modus: 'auto', start_text: 'Hallo' });
  ok(wb.includes('--disallowedTools') && WISSEN_GESPERRT.every((t) => wb.includes(t)), 'Wissen: Claude startet mit gesperrten Schreib-Werkzeugen');
  ok(wb.indexOf('--disallowedTools') < wb.indexOf('--permission-mode'), 'Sperrliste vor --permission-mode (schluckt den Start-Text nicht)');
  ok(/--permission-mode auto 'Hallo'$/.test(wb), 'Auto-Modus + Start-Text am Ende');
  ok(!startBefehl({ ordner: '/srv/x', art: 'bau', start_modus: 'auto' }).includes('--disallowedTools'), 'Bau: keine Sperre');
  ok(!startBefehl({ ordner: '/srv/x', start_modus: 'auto' }).includes('--disallowedTools'), 'Altbestand ohne Art: keine Sperre');
}
// ── Suche: archivierte Treffer gekennzeichnet ──
{
  const z = [{ id: 5, kanal: 'a' }, { id: 20, kanal: 'a' }, { id: 3, kanal: 'zu' }, { id: 4, kanal: 'b' }];
  eq(archivMarkieren(z, { a: 10 }, new Set(['zu'])).map((t) => !!t.archiviert), [true, false, true, false], 'vor verlauf_ab + geschlossener Kanal → „archiviert", Rest normal');
  eq(archivMarkieren(z).length, 4, 'nichts fällt weg');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

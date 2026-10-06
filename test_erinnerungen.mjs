// test_erinnerungen.mjs — Erinnerungs-Ordner, Titel/Notiz, Übergabe (v1.1) gegen eine Temp-Datenbank.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, reminderAnlegen, reminders, faelligeFeuern } from './server/db.mjs';
import { erinnerungenSchema, ordnerAlle, ordnerAnlegen, ordnerUmbenennen, ordnerLoeschen, reminderInOrdner, reminderTitel, reminderNotiz, reminderUebergeben, uebergabeText, ordnerName } from './server/erinnerungen.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

const dir = mkdtempSync(join(tmpdir(), 'fc-erin-'));
const db = openDb(dir);
erinnerungenSchema(db); erinnerungenSchema(db);
ok(true, 'Schema zweimal anlegen ist harmlos (idempotent)');

// ── Ordner ──
eq(ordnerAlle(db), [], 'anfangs keine Ordner');
const o1 = ordnerAnlegen(db, { name: '  Kunden   Mai ' });
eq(o1.name, 'Kunden Mai', 'Name getrimmt und Leerzeichen zusammengezogen');
eq(ordnerAnlegen(db, { name: '   ' }), null, 'leerer Name → kein Ordner');
const o2 = ordnerAnlegen(db, { name: 'x'.repeat(80) });
eq(o2.name.length, 40, 'Name auf 40 Zeichen gekürzt');
ok(o2.reihenfolge > o1.reihenfolge, 'Reihenfolge zählt hoch');
eq(ordnerAlle(db).map((o) => o.id), [o1.id, o2.id], 'Liste in Reihenfolge');
eq(ordnerUmbenennen(db, o1.id, 'Kunden Juni').name, 'Kunden Juni', 'umbenennen');
eq(ordnerUmbenennen(db, o1.id, ''), null, 'umbenennen ohne Namen → null, alter Name bleibt');
eq(ordnerAlle(db)[0].name, 'Kunden Juni', 'alter Name blieb');
eq(ordnerUmbenennen(db, 999, 'x'), null, 'unbekannter Ordner → null');
eq(ordnerName('a\n  b'), 'a b', 'ordnerName normalisiert');

// ── Erinnerungen in Ordner ──
const r1 = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Angebot nachfassen', faellig_am: '2026-10-07T08:00:00.000Z' });
const r2 = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Rechnung schreiben' });
ok(r1.ordner_id === null && r2.ordner_id === null, 'neue Erinnerungen liegen in der Inbox (ordner_id NULL)');
eq(reminderInOrdner(db, r1.id, o1.id).reminder.ordner_id, o1.id, 'in Ordner legen');
eq(reminderInOrdner(db, r1.id, String(o2.id)).reminder.ordner_id, o2.id, 'in anderen Ordner (id als String) legen');
eq(reminderInOrdner(db, r1.id, 999).ok, false, 'unbekannter Ordner wird abgewiesen');
eq(reminderInOrdner(db, 999, o1.id).ok, false, 'unbekannte Erinnerung wird abgewiesen');
eq(reminderInOrdner(db, r1.id, null).reminder.ordner_id, null, 'zurück in die Inbox (null)');
eq(reminderInOrdner(db, r1.id, '').reminder.ordner_id, null, 'zurück in die Inbox (leer)');
reminderInOrdner(db, r1.id, o1.id); reminderInOrdner(db, r2.id, o1.id);
const gel = ordnerLoeschen(db, o1.id);
eq([gel.ok, gel.zurueck], [true, 2], 'Ordner löschen gibt beide Erinnerungen zurück');
ok(reminders(db).every((r) => r.ordner_id === null), 'nach dem Löschen liegt alles in der Inbox');
eq(ordnerAlle(db).length, 1, 'nur noch ein Ordner');
eq(ordnerLoeschen(db, 999).ok, false, 'unbekannten Ordner löschen → sauberer Fehler');

// ── Titel / Notiz ──
eq(reminderTitel(db, r1.id, '  Angebot   nachfassen (Müller) ').titel, 'Angebot nachfassen (Müller)', 'Titel ändern, normalisiert');
eq(reminderTitel(db, r1.id, ''), null, 'leerer Titel wird abgelehnt');
eq(reminderTitel(db, 999, 'x'), null, 'unbekannte Erinnerung → null');
eq(reminderNotiz(db, r1.id, ' Telefon 0151 … ').notiz, 'Telefon 0151 …', 'Notiz setzen');
eq(reminderNotiz(db, r1.id, '').notiz, '', 'Notiz leeren');
ok(reminderNotiz(db, r1.id, 'x'.repeat(3000)).notiz.length === 2000, 'Notiz gedeckelt');

// ── Übergabe ──
const r3 = reminderAnlegen(db, { kanal: 'erinnerungen', titel: 'Website prüfen', notiz: 'Startseite lädt langsam', faellig_am: '2026-10-07T08:00:00.000Z' });
const text = uebergabeText(r3, { zeitText: () => '07.10.2026, 10:00' });
ok(/^📌 Übergabe aus den Erinnerungen: „Website prüfen“/.test(text), 'Übergabe-Text beginnt mit Titel');
ok(/Notiz: Startseite lädt langsam/.test(text) && /Fällig: 07\.10\.2026, 10:00/.test(text), 'Notiz und Fälligkeit stehen drin');
ok(/nimm das Thema ab hier auf/.test(text), 'Aufforderung am Ende');
ok(!/Notiz:/.test(uebergabeText({ titel: 'Nur Titel' })), 'ohne Notiz keine Notiz-Zeile');
const ue = reminderUebergeben(db, r3.id, 'website');
eq([ue.status, ue.uebergeben_an], ['uebergeben', 'website'], 'Status übergeben + Zielfenster');
eq(reminderUebergeben(db, r3.id, ''), null, 'ohne Fenster keine Übergabe');
eq(reminderUebergeben(db, 999, 'x'), null, 'unbekannte Erinnerung → null');
ok(!reminders(db, { status: 'offen' }).some((r) => r.id === r3.id), 'übergebene Erinnerung ist nicht mehr „offen“');
const gefeuert = faelligeFeuern(db, new Date('2026-10-08T00:00:00Z'));
ok(!gefeuert.some((g) => g.reminder.id === r3.id), 'übergebene Erinnerung feuert nicht mehr');
ok(gefeuert.some((g) => g.reminder.id === r1.id), 'offene fällige feuert weiterhin');

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

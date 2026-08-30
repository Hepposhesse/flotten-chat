// test_kern.mjs — Kern-Tests der Datenschicht (Muster: pass/fail-Zähler, letzte Zeile "N passed, M failed").
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, kanalAnlegen, kanaele, senden, nachrichten,
  inviteAnlegen, connect, agentViaToken, presence,
  statusSetzen, stopAnfordern, stopHolenUndQuittieren,
  reminderAnlegen, reminders, reminderErledigt, reminderVerschieben, faelligeFeuern,
} from './server/db.mjs';

let pass = 0, fail = 0;
const ok = (bed, name) => { if (bed) { pass++; } else { fail++; console.log('FAIL:', name); } };

const dir = mkdtempSync(join(tmpdir(), 'fc-test-'));
const db = openDb(dir);

// Kanäle: anlegen ist idempotent + normalisiert
const k1 = kanalAnlegen(db, { name: 'Mein Kanal!', label: 'Mein Kanal' });
ok(k1 && k1.name === 'mein-kanal-', 'Kanalname wird normalisiert');
const k2 = kanalAnlegen(db, { name: 'Mein Kanal!' });
ok(k2.id === k1.id, 'Kanal anlegen ist idempotent');
ok(kanaele(db).length >= 1, 'Kanäle listbar');

// Nachrichten: senden + seit-Cursor
const m1 = senden(db, { kanal: 'test', von: 'simon', inhalt: 'Hallo Flotte' });
ok(m1 && m1.id > 0 && m1.typ === 'fyi', 'Senden liefert Nachricht mit Default-Typ');
const m2 = senden(db, { kanal: 'test', von: 'agent', typ: 'answer', inhalt: 'Hallo zurück', bezug_id: m1.id });
ok(m2.bezug_id === m1.id, 'Bezug/Zitat wird gespeichert');
ok(senden(db, { kanal: 'test', von: 'x', typ: 'quatsch', inhalt: 'y' }).typ === 'fyi', 'Unbekannter Typ fällt auf fyi zurück');
ok(nachrichten(db, { kanal: 'test', seit: 0 }).length === 3, 'Alle Nachrichten ab 0');
ok(nachrichten(db, { kanal: 'test', seit: m1.id }).length === 2, 'seit-Cursor filtert');
ok(senden(db, { kanal: '', von: 'x', inhalt: 'y' }) === null, 'Ohne Kanal kein Senden');

// Self-Connect: Einladung ist EINMALIG
const inv = inviteAnlegen(db, { kanal: 'test' });
const c1 = connect(db, { invite_token: inv, name: 'claude-test' });
ok(c1 && c1.agent_token.startsWith('agt_') && c1.kanal === 'test', 'Connect liefert Agent-Token + Kanal');
ok(c1.cursor === m2.id + 1 || c1.cursor >= m2.id, 'Cursor startet am aktuellen Ende');
ok(connect(db, { invite_token: inv, name: 'zweiter' }) === null, 'Einladung ist nur einmal benutzbar');
ok(connect(db, { invite_token: 'inv_gibtsnicht' }) === null, 'Falsche Einladung wird abgelehnt');
const ag = agentViaToken(db, c1.agent_token);
ok(ag && ag.name === 'claude-test', 'Agent per Token auflösbar');
ok(agentViaToken(db, 'agt_falsch') === null, 'Falscher Agent-Token wird abgelehnt');
ok(presence(db).length === 1, 'Presence listet den Agenten');

// Arbeitsstatus + Stopp (v0.2.0): EINE Presence-Wahrheit, plus einmaliges Stopp-Signal
statusSetzen(db, ag.id, 'busy');
ok(presence(db)[0].status === 'busy', 'Status busy gesetzt + in presence sichtbar');
statusSetzen(db, ag.id, 'wasauchimmer');
ok(presence(db)[0].status === 'idle', 'unbekannter Status fällt auf idle zurück');
stopAnfordern(db, 'claude-test');
ok(presence(db)[0].stop_angefordert === 1, 'Stopp angefordert → Flag steht');
ok(stopHolenUndQuittieren(db, ag.id) === true, 'Stopp wird geholt (true)');
ok(stopHolenUndQuittieren(db, ag.id) === false, 'zweites Holen → false (einmalig quittiert)');

// Erinnerungen: feuern serverseitig, ohne AI
const früher = new Date(Date.now() - 60_000).toISOString();
const später = new Date(Date.now() + 3_600_000).toISOString();
const r1 = reminderAnlegen(db, { kanal: 'test', titel: 'Fällige Erinnerung', faellig_am: früher });
const r2 = reminderAnlegen(db, { kanal: 'test', titel: 'Zukunft', faellig_am: später });
ok(r1 && r2, 'Erinnerungen anlegbar');
ok(reminderAnlegen(db, { kanal: 'test', titel: '' }) === null, 'Ohne Titel keine Erinnerung');
const gefeuert = faelligeFeuern(db);
ok(gefeuert.length === 1 && gefeuert[0].reminder.id === r1.id, 'Nur die fällige feuert');
ok(gefeuert[0].message.typ === 'system' && gefeuert[0].message.inhalt.includes('Fällige Erinnerung'), 'Feuern erzeugt System-Nachricht im Kanal');
ok(faelligeFeuern(db).length === 0, 'Gefeuerte feuert nicht doppelt');
ok(reminderErledigt(db, r2.id).status === 'erledigt', 'Erledigt-Markierung');
ok(reminders(db, { status: 'offen' }).length === 1, 'Status-Filter (r1 offen, r2 erledigt)');

// Verschieben: neu terminieren macht wieder offen + ungefeuert → feuert zur NEUEN Zeit erneut
const v = reminderVerschieben(db, r1.id, später);
ok(v && v.faellig_am === später && v.status === 'offen' && v.gefeuert_am === null, 'Verschieben: neue Zeit + wieder offen/ungefeuert');
ok(faelligeFeuern(db).length === 0, 'In die Zukunft verschoben → feuert (noch) nicht');
reminderVerschieben(db, r1.id, new Date(Date.now() - 120000).toISOString());
ok(faelligeFeuern(db).length === 1, 'In die Vergangenheit verschoben → feuert erneut');
ok(reminderVerschieben(db, r1.id, null) === null, 'Verschieben ohne Zeit → null');

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
import { createLimiter, groesseErlaubt, clientIdSauber } from './server/limits.mjs';

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

// Idempotentes Senden (v0.4.0): gleiche client_id im selben Kanal → dieselbe Nachricht, keine Dublette
const i1 = senden(db, { kanal: 'test', von: 'app', inhalt: 'einmal', client_id: 'abc-1' });
const i2 = senden(db, { kanal: 'test', von: 'app', inhalt: 'einmal (Retry)', client_id: 'abc-1' });
ok(i1 && !i1.dedup, 'Erste Sendung mit client_id ist neu');
ok(i2 && i2.id === i1.id && i2.dedup === true && i2.inhalt === 'einmal', 'Retry mit gleicher client_id liefert dieselbe Nachricht (dedup)');
ok(nachrichten(db, { kanal: 'test', seit: i1.id - 1 }).length === 1, 'Keine Dublette in der Liste');
const i3 = senden(db, { kanal: 'anderer', von: 'app', inhalt: 'gleiche id, anderer kanal', client_id: 'abc-1' });
ok(i3 && !i3.dedup && i3.id !== i1.id, 'client_id ist je Kanal eindeutig, nicht global');
ok(senden(db, { kanal: 'test', von: 'app', inhalt: 'ohne id' }) && senden(db, { kanal: 'test', von: 'app', inhalt: 'ohne id' }), 'Ohne client_id bleibt Senden wie bisher (zwei Nachrichten)');

// Limits (v0.4.0, rein): Sliding Window + Größen-Check + client_id-Säuberung
const lim = createLimiter({ limit: 2, windowMs: 1000 });
ok(lim.check('ip', 1000).ok && lim.check('ip', 1100).ok, 'Zwei Treffer im Fenster erlaubt');
const dritter = lim.check('ip', 1200);
ok(dritter.ok === false && dritter.retryAfterS >= 1, 'Dritter Treffer im Fenster → gesperrt mit retryAfter');
ok(lim.check('andere-ip', 1200).ok, 'Anderer Schlüssel ist unabhängig');
ok(lim.check('ip', 2100).ok, 'Nach Ablauf des Fensters wieder erlaubt');
ok(groesseErlaubt(undefined, 100) && groesseErlaubt(100, 100) && !groesseErlaubt(101, 100), 'Größen-Check: unbekannt/gleich ok, drüber nicht');
ok(clientIdSauber(' abc-1.2:x ') === 'abc-1.2:x' && clientIdSauber('böse id') === null && clientIdSauber('') === null && clientIdSauber('x'.repeat(65)) === null, 'client_id nur [A-Za-z0-9_.:-] ≤64');

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

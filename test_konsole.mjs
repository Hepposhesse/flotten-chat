// test_konsole.mjs — reine Logik der „Konsole im Chat“ (v1.0) + Registry/Board/Login der Datenschicht.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paneZustand, tastenFuerWahl, chatBefehl, dialogText, dialogMeta, protokollNachrichten, spiegelBeitraege, spiegelStart, ganzeZeilen, protokollZuProzess, zustellText, markerAufloesen, medienZerlegen, neueZustellungen, slug, protokollOrdner, werkzeugZeile } from './server/protokoll.mjs';
import { etimeSekunden, startBefehl } from './server/orte.mjs';
import { openDb, fensterAnlegen, fensterHolen, fensterAlle, fensterAendern, fensterLoeschen, karteAnlegen, karteAendern, karteVerlauf, karten, nutzerAnlegen, nutzerAnzahl, nutzerPruefen, sitzungAnlegen, sitzungNutzer, sitzungLoeschen, senden, metaSetzen, kanaele } from './server/db.mjs';

let pass = 0, fail = 0;
const ok = (bed, name) => { if (bed) { pass++; } else { fail++; console.log('FAIL:', name); } };

// ── Terminalbild deuten ──
const prompt = '\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
ok(paneZustand(prompt).modus === 'auto' && paneZustand(prompt).dialog === null, 'Prompt + Auto-Mode erkannt, kein Dialog');
ok(paneZustand('❯ \n shift+tab to cycle').modus === 'default', 'Kein Modus-Marker + Prompt = Manual');
const frage = ' ☐ Farbe\n Welche Farbe soll der Knopf haben?\n\n ❯ 1. Blau\n   2. Grün\n   3. Rot\n   4. Type something.\n\n Enter to confirm\n';
const zf = paneZustand(frage);
ok(zf.dialog && zf.dialog.art === 'frage' && zf.dialog.optionen.length === 4 && zf.dialog.cursor === 1 && /Welche Farbe/.test(zf.dialog.titel), 'Rückfrage mit 4 Optionen, Cursor auf 1');
ok(dialogMeta(zf.dialog).optionen.length === 3, 'dialogMeta lässt „Type something." weg');
const freigabe = ' Bash command\n rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No, and tell Claude what to do differently\n';
const zg = paneZustand(freigabe);
ok(zg.dialog && zg.dialog.art === 'freigabe' && /🔐/.test(dialogText(zg.dialog)), 'Freigabe-Dialog erkannt (Yes/No)');
ok(paneZustand('1. erstens\n2. zweitens\n3. drittens').dialog === null, 'Nummerierte Liste ohne Cursor ist kein Dialog');
ok(paneZustand('✻ Thinking… (12s · ↑ 1.2k tokens)').busy === true && paneZustand(prompt).busy === false, 'Beschäftigt-Erkennung über Klammer-Zeit');

// ── Tasten für Wahl ──
ok(tastenFuerWahl([3], 1, 4).join(',') === 'Down,Down,Enter', 'Von 1 nach 3: Down Down Enter');
ok(tastenFuerWahl([1], 2, 4).join(',') === 'Up,Enter', 'Von 2 nach 1: Up Enter');
ok(tastenFuerWahl([1, 3], 1, 4).join(',') === 'Space,Down,Down,Space,Enter', 'Mehrfachwahl mit Space');
ok(tastenFuerWahl([9], 1, 4).length === 0, 'Nummer außerhalb → keine Tasten');

// ── Chat-Befehl ──
ok(chatBefehl('Bitte weiter machen', {}).art === 'text', 'Ohne Dialog: Text');
ok(chatBefehl('2', { dialog: zf.dialog }).nummern[0] === 2, 'Zahl im Dialog = Wahl');
ok(chatBefehl('1, 3', { dialog: zf.dialog }).nummern.join(',') === '1,3', 'Mehrere Zahlen');
ok(chatBefehl('ja', { dialog: zg.dialog }).nummern[0] === 1, '„ja" = 1');
ok(chatBefehl('nein', { dialog: zg.dialog }).art === 'abbruch', '„nein" = Escape');
ok(chatBefehl('Mach es lieber mit rsync', { dialog: zg.dialog }).art === 'abbruch_text', 'Freitext bei Freigabe = Esc + Text');
ok(chatBefehl('Nimm bitte dunkelblau', { dialog: zf.dialog }).art === 'halten', 'Freitext bei Rückfrage wartet');
ok(chatBefehl('1. und mach die Ecken rund', { dialog: zf.dialog }).nachtext === 'und mach die Ecken rund', 'Wahl + Nachtext');
ok(chatBefehl('manual', {}).ziel === 'default' && chatBefehl('auto', {}).ziel === 'auto' && chatBefehl('plan', {}).ziel === 'plan', 'Modus-Worte');

// ── Protokoll (JSONL) ──
const zeilen = [
  { type: 'user', uuid: 'u1', timestamp: 't', message: { content: [{ type: 'text', text: '📨 Simon · #3: Stell eine Frage' }] } },
  { type: 'user', uuid: 'u2', timestamp: 't', message: { content: [{ type: 'text', text: 'Normale Eingabe im Terminal' }] } },
  { type: 'assistant', uuid: 'a1', timestamp: 't', message: { content: [{ type: 'text', text: 'Hier ist das Bild [Bild: /tmp/x/abc.png] fertig.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf build', description: 'Build löschen' } }] } },
  { type: 'user', uuid: 'u3', timestamp: 't', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Permission denied by the Claude Code auto mode classifier. Reason: destructive command' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: 't', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'AskUserQuestion', input: { questions: [{ question: 'Farbe?', header: 'Farbe', options: [{ label: 'Blau' }, { label: 'Rot' }] }] } }] } },
  { type: 'user', uuid: 'u4', timestamp: 't', toolUseResult: { answers: { 'Farbe?': 'Blau' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: 't', isSidechain: true, message: { content: [{ type: 'text', text: 'Subagent-Text' }] } },
];
const n = protokollNachrichten(zeilen, { ohneZustellung: true });
ok(n.filter((x) => x.rolle === 'du').length === 1 && n.find((x) => x.rolle === 'du').text === 'Normale Eingabe im Terminal', 'Zugestellte Chat-Nachricht wird übersprungen, echte Eingabe bleibt');
const sitz = n.find((x) => x.rolle === 'sitzung');
ok(sitz && sitz.medien.length === 1 && sitz.medien[0].pfad === '/tmp/x/abc.png' && !/\[Bild/.test(sitz.text), 'Antwort mit Medien-Marker: Pfad extrahiert, Marker aus dem Text');
ok(n.some((x) => x.rolle === 'gesperrt' && x.grund === 'destructive command'), 'Auto-Mode-Sperre erkannt mit Grund');
ok(n.some((x) => x.rolle === 'frage' && x.fragen[0].optionen.length === 2), 'AskUserQuestion-Aufruf erkannt');
ok(n.some((x) => x.rolle === 'antwort' && x.antworten['Farbe?'] === 'Blau'), 'Antwort auf Rückfrage erkannt');
ok(!n.some((x) => x.text === 'Subagent-Text'), 'Subagenten-Zweig fällt weg');
const werkzeuge = new Map();
const b = spiegelBeitraege(n, { werkzeuge });
ok(b.some((x) => x.typ === 'answer' && x.medien.length === 1), 'Beitrag: Antwort mit Medium');
ok(b.some((x) => x.typ === 'error' && /Build löschen/.test(x.text)), 'Beitrag: Sperre nennt den Schritt');
ok(b.some((x) => x.typ === 'fyi' && /Im Fenster beantwortet/.test(x.text)), 'Beitrag: im Fenster beantwortet');
ok(werkzeugZeile('Bash', { command: 'ls', description: 'Dateien' }) === 'Dateien' && werkzeugZeile('Read', { file_path: '/a/b' }) === '/a/b', 'Werkzeug-Kurzzeile');

// ── Spiegel-Stand, Zeilen, Zuordnung ──
const s1 = spiegelStart({}, { sitzung: 'S1', groesse: 5000, gestartetMs: 1000 }, { jetztMs: 10 * 60_000 + 1000 });
ok(s1.sitzung === 'S1' && s1.offset === 5000, 'Alte Sitzung: Start am Dateiende (kein Nachliefern)');
const s2 = spiegelStart({}, { sitzung: 'S2', groesse: 5000, gestartetMs: 1000 }, { jetztMs: 2000 });
ok(s2.offset === 0, 'Frische Sitzung: alles zeigen');
ok(spiegelStart({ sitzung: 'S1', offset: 77 }, { sitzung: 'S1', groesse: 9 }).offset === 77, 'Gleiche Sitzung: Stand bleibt');
const gz = ganzeZeilen('{"a":1}\n{"b":2}\n{"c":');
ok(gz.zeilen.length === 2 && gz.verbraucht === 16, 'Nur ganze Zeilen, Rest wartet');
ok(protokollZuProzess(1000, [{ name: 'alt.jsonl', geburtMs: 100 }, { name: 'neu.jsonl', geburtMs: 1200 }]) === 'neu.jsonl', 'Protokoll zum Prozess: erste Datei ab Start');
ok(zustellText({ von: 'Simon', id: 12, inhalt: 'Hallo' }) === '📨 Simon · #12: Hallo', 'Zustell-Text');
ok(markerAufloesen('Schau [bild:abc.png|Foto.png]', '/data/media') === 'Schau [Bild: /data/media/abc.png (Foto.png)]', 'Marker → Pfad');
ok(medienZerlegen('Text [Video: /x/y/v.webm] Ende').medien[0].typ === 'video', 'Medien zerlegen: Video');
const z = neueZustellungen([{ id: 5, von: 'Simon', typ: 'fyi', erstellt_am: new Date(Date.now() - 1000).toISOString() }, { id: 6, von: 'Fenster', typ: 'answer', erstellt_am: new Date().toISOString() }, { id: 7, von: 'Simon', typ: 'fyi', erstellt_am: new Date(Date.now() - 3 * 3600_000).toISOString() }], 4, { jetztMs: Date.now(), eigeneNamen: ['Fenster'] });
ok(z.zustellen.length === 1 && z.zustellen[0].id === 5 && z.uebersprungen.length === 1 && z.cursor === 7, 'Zustellungen: eigene raus, zu alte übersprungen, Cursor = max');
ok(slug('Aron Gutschrift & Zapier → Sales-Engine!') === 'aron-gutschrift-zapier-sales-engine' && slug('Übersicht Öl') === 'uebersicht-oel', 'Slug');
ok(protokollOrdner('/root/.claude', '/root/projekt/x.y') === '/root/.claude/projects/-root-projekt-x-y', 'Protokoll-Ordner-Schema');
ok(etimeSekunden('1-02:03:04') === 93784 && etimeSekunden('05:07') === 307 && etimeSekunden('') === 0, 'ps etime → Sekunden');
const cmd = startBefehl({ ordner: '/tmp/a b', config_dir: '/root/.claude-b', start_modus: 'auto', start_text: 'Hallo "Welt"' });
ok(/cd '\/tmp\/a b'/.test(cmd) && /CLAUDE_CONFIG_DIR='\/root\/.claude-b'/.test(cmd) && /--permission-mode auto 'Hallo "Welt"'/.test(cmd), 'Start-Befehl korrekt gequotet');

// ── Datenschicht: Registry, Board, Login ──
const dir = mkdtempSync(join(tmpdir(), 'fc-konsole-'));
const db = openDb(dir);
const f = fensterAnlegen(db, { name: 'Buchhaltung 2026!', label: 'Buchhaltung', ordner: '/tmp', start_modus: 'quatsch' });
ok(f && f.name === 'buchhaltung-2026' && f.tmux === 'fc-buchhaltung-2026' && f.start_modus === 'auto', 'Fenster: Name normalisiert, tmux-Name, Modus-Fallback');
ok(kanaele(db).some((k) => k.name === 'buchhaltung-2026'), 'Fenster legt seinen Kanal an');
ok(fensterAnlegen(db, { name: 'Buchhaltung 2026!', ordner: '/tmp' }) === null, 'Doppelter Name → null');
ok(fensterAendern(db, f.name, { status: 'laeuft', cursor: 9, spiegel: { sitzung: 'S' } }).cursor === 9 && JSON.parse(fensterHolen(db, f.name).spiegel).sitzung === 'S', 'Fenster ändern (Cursor, Spiegel)');
ok(fensterLoeschen(db, f.name) && fensterAlle(db).length === 0 && kanaele(db).find((k) => k.name === 'buchhaltung-2026').archiviert === 1, 'Löschen archiviert den Kanal');
const k = karteAnlegen(db, { titel: 'Thema A', spalte: 'falsch' });
ok(k && k.spalte === 'ideen', 'Karte: unbekannte Spalte → ideen');
ok(karteAendern(db, k.id, { spalte: 'pruefen', fenster: 'x' }).spalte === 'pruefen', 'Karte verschieben');
ok(karteVerlauf(db, k.id, { von: 'A6', text: 'Stand' }).verlauf.length === 1 && karten(db)[0].verlauf[0].text === 'Stand', 'Karten-Verlauf');
ok(nutzerAnlegen(db, { email: 'kaputt', passwort: 'x' }) === null && nutzerAnlegen(db, { email: 'a@b.de', passwort: 'kurz' }) === null, 'Nutzer: E-Mail/Passwort geprüft');
const u = nutzerAnlegen(db, { email: 'Simon@Example.com', passwort: 'geheim123', name: 'Simon' });
ok(u && u.email === 'simon@example.com' && nutzerAnzahl(db) === 1, 'Nutzer angelegt, E-Mail klein');
ok(nutzerPruefen(db, { email: 'simon@example.com', passwort: 'geheim123' }).id === u.id && nutzerPruefen(db, { email: 'simon@example.com', passwort: 'falsch' }) === null, 'Passwort-Prüfung');
const tok = sitzungAnlegen(db, u.id);
ok(sitzungNutzer(db, tok).email === 'simon@example.com' && sitzungNutzer(db, 'ses_falsch') === null, 'Browser-Sitzung');
sitzungLoeschen(db, tok); ok(sitzungNutzer(db, tok) === null, 'Abmelden löscht die Sitzung');
const m = senden(db, { kanal: 'k', von: 'x', typ: 'question', inhalt: 'Frage?', meta: { dialog: { optionen: [{ nr: 1, label: 'A' }] } } });
ok(m.typ === 'question' && JSON.parse(m.meta).dialog.optionen[0].label === 'A', 'Nachricht mit meta (Knöpfe)');
ok(JSON.parse(metaSetzen(db, m.id, { dialog: { zu: true } }).meta).dialog.zu === true, 'meta nachträglich setzen');
rmSync(dir, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

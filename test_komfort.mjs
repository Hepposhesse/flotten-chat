// test_komfort.mjs — Chat-Komfort (1.2): Markdown wie im Terminal (ui/md-chat.js), Schwarm-Leiste (server/schwarm.mjs),
// Verlauf in Etappen + frischer Verlauf je Fenster (server/verlauf.mjs). Muster: pass/fail-Zähler, letzte Zeile "N passed, M failed".
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './ui/md-chat.js';
import { metaAusSkript, standAusJournal, laufZustand, schwarmZeile, sichtbareLaeufe, aufgabenAusSitzung, schwarmFuerOrdner } from './server/schwarm.mjs';
import { verlaufSchema, verlaufAb, verlaufAbSetzen, etappeGrenzen, nachrichtenEtappe, nurAktuellerVerlauf, ERSTE_LADUNG, MAX_ETAPPE } from './server/verlauf.mjs';
import { openDb, senden, fensterAnlegen, fensterLoeschen, nachrichten } from './server/db.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

// ── Markdown: Tabellen ──
const T = globalThis.FcMd;
const L = T.mdLite;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
ok(T && typeof T.mdLite === 'function' && typeof T.linkify === 'function', 'md-chat.js lädt in Node (FcMd)');
{
  const md = 'Kurz gesagt: zu günstig.\n\n| | Variante A | Variante B |\n|---|---|--:|\n| Preis | 12 × 400 € | 990 € |\n| Aufwand | 23,1 h | 11,2 h |\n\nMein Vorschlag: Rahmen.';
  const h = T.tabellenHtml(md);
  ok(h.startsWith('Kurz gesagt: zu günstig.\n<div class="md-tab" data-spalten="3">'), 'Text davor bleibt, Tabelle beginnt');
  ok(!h.includes('|'), 'keine rohen Pipes mehr');
  ok((h.match(/<th[ >]/g) || []).length === 3 && (h.match(/<tr>/g) || []).length === 3, '3 Kopfzellen, 1 Kopf- + 2 Datenzeilen');
  ok(h.includes('<td style="text-align:right">990 €</td>'), 'Ausrichtung --: → rechts');
  ok(h.includes('md-tab-gross'), 'Fuß mit „Groß ansehen“');
  ok(h.endsWith('</div></div>\nMein Vorschlag: Rahmen.') && L(md).endsWith('</div></div>Mein Vorschlag: Rahmen.'), 'kein Umbruch/Leerzeile hinter der Tabelle (mdLite räumt ihn weg)');
  ok(L(esc('| A |\n|---|\n| 1 |\n\n> Zitat danach')).endsWith('</div></div><blockquote class="md-zitat">Zitat danach</blockquote>'), 'Zitat direkt hinter einer Tabelle');
  ok(L('| A |\n|---|\n| 1 |\n- Punkt danach').endsWith('</div></div><ul class="md-ul"><li>Punkt danach</li></ul>'), 'Liste direkt hinter einer Tabelle');
}
ok(T.tabellenHtml('a | b\nkein Trenner') === 'a | b\nkein Trenner', 'Pipes ohne Trennzeile bleiben Text');
ok(T.tabellenHtml('| a | b |\n| c | d |') === '| a | b |\n| c | d |', 'ohne |---| keine Tabelle');
ok((T.tabellenHtml('| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |').match(/<td/g) || []).length === 6, 'fehlende Zellen aufgefüllt, überzählige abgeschnitten');
ok(T.tabellenHtml('| A \\| B | C |\n|---|---|\n| x | y |').includes('<th>A | B</th>'), 'escaptes \\| bleibt in der Zelle');
ok(T.tabellenHtml('| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |').split('class="md-tab"').length === 3, 'zwei Tabellen hintereinander');
ok(T.alsTsv([['A', 'B'], ['1\n2', ' x ']]) === 'A\tB\n1 2\tx', 'TSV für Kopieren');

// ── Markdown: alles, was Fenster im Terminal schreiben (Text kommt escaped, Links von linkify) ──
const a = (u, text = u) => `<a href="${u}" target="_blank" rel="noopener">${text}</a>`;
ok(L('**fett** und `code`') === '<b>fett</b> und <code>code</code>', 'fett + Code');
ok(L('Text\n- eins\n- zwei\nweiter') === 'Text\n<ul class="md-ul"><li>eins</li><li>zwei</li></ul>weiter', 'Liste');
ok(L('- a\n1. b') === '<ul class="md-ul"><li>a</li></ul><ol class="md-ol"><li>b</li></ol>', 'Wechsel Punkt → Nummer');
ok(L('## Titel') === '<b class="md-h">Titel</b>' && L('#### Klein') === '<b class="md-h">Klein</b>', 'Überschriften 1–6');
ok(L('#marketing ist ein Kanal') === '#marketing ist ein Kanal', 'Kanal-# bleibt');
ok(L('Quellen: [Datenblatt](' + a('https://x.de/a.pdf') + ').') === 'Quellen: ' + a('https://x.de/a.pdf', 'Datenblatt') + '.', 'Link [Text](url) zeigt Text');
ok(L(esc('> **Betreff:** Hallo\n>\n> Zeile zwei\nDanach')) === '<blockquote class="md-zitat"><b>Betreff:</b> Hallo\n\nZeile zwei</blockquote>Danach', 'Zitat-Block');
ok(L(esc('vorher\n```js\nconst x = a**b**c;\n- kein Punkt\n```\nnachher')) === 'vorher\n<pre class="md-pre"><code>const x = a**b**c;\n- kein Punkt</code></pre>nachher', 'Code-Block bleibt unformatiert');
ok(L('die KI *ist* die Einstellung') === 'die KI <i>ist</i> die Einstellung' && L('das _wirklich_ jetzt') === 'das <i>wirklich</i> jetzt', 'kursiv * und _');
ok(L('snake_case_name und 3 * 4 * 5') === 'snake_case_name und 3 * 4 * 5', 'kein Kursiv in Namen/Rechnungen');
ok(L('* Punkt') === '<ul class="md-ul"><li>Punkt</li></ul>', '* als Aufzählung, nicht kursiv');
ok(L('~~alt~~ neu') === '<s>alt</s> neu', 'durchgestrichen');
ok(L('oben\n---\nunten') === 'oben\n<hr class="md-hr">unten', 'Trennlinie');
ok(L('1. a\n   - sub\n2. b') === '<ol class="md-ol"><li>a<ul class="md-ul md-sub"><li class="md-li2">sub</li></ul></li><li>b</li></ol>', 'Unterpunkt, Nummer läuft weiter');
ok(L('3. drei\n4. vier') === '<ol class="md-ol" start="3"><li>drei</li><li>vier</li></ol>', 'Liste ab 3');
ok(L('  - nur eingerückt') === '  - nur eingerückt', 'eingerückt ohne Oberpunkt bleibt Text');
ok(L('__wichtig__ ist das') === '<b>wichtig</b> ist das', '__fett__');
ok(L('| A | B |\n|---|---|\n| **1** | 2 |').includes('<td><b>1</b></td>'), 'Tabelle mit fett in Zelle');
ok(L('Kosten $5 und $10') === 'Kosten $5 und $10', 'Dollar bleibt Text');
ok(L(esc('```\nx\n```\n| A | B |\n|---|---|\n| 1 | 2 |')).startsWith('<pre class="md-pre"><code>x</code></pre><div class="md-tab"'), 'Tabelle direkt nach Code-Block');
ok(L('Absatz\n\n- a\n\nweiter') === 'Absatz\n<ul class="md-ul"><li>a</li></ul>weiter', 'Leerzeilen um Blöcke übernimmt deren Abstand');
// Sicherheit: HTML aus dem Text bleibt Text (mdLite läuft auf escaptem Text und erzeugt nur eigene Tags)
{
  const h = L(T.linkify(esc('<img src=x onerror=alert(1)> **x** [a](javascript:alert(1))')));
  ok(!h.includes('<img') && h.includes('&lt;img') && !/href="javascript/.test(h), 'kein HTML/kein javascript:-Link aus dem Text');
}
// linkify: URL-Satzzeichen, URL in Backticks (verschachtelte <code> schrumpften den Text), Karten-Chips
ok(T.linkify('siehe https://x.de/a, dann') === 'siehe ' + a('https://x.de/a') + ', dann', 'Satzzeichen hinter der URL gehört nicht dazu');
ok(T.linkify(esc('"https://x.de/q?a=1&b=2"')) === '&quot;' + a('https://x.de/q?a=1&amp;b=2') + '&quot;', 'Anführungszeichen um die URL');
{
  const h = L(T.linkify('Login: `https://x.de/meta/callback` und Webhook: `https://x.de/meta/webhook` fertig.'));
  ok(!h.includes('`'), 'URL in Backticks: keine Backticks übrig');
  ok((h.match(/<code>/g) || []).length === 2 && h.indexOf('<code>', h.indexOf('</code>')) > h.indexOf('</code>'), 'zwei getrennte <code>, nicht verschachtelt');
  ok(h.includes('href="https://x.de/meta/callback"') && h.endsWith(' fertig.'), 'Link sauber, Rest normal');
}
ok(T.linkify('Stand an #karte-12 geschrieben.') === 'Stand an <button type="button" class="fc-id" data-karte="12" title="Karte öffnen">#karte-12</button> geschrieben.', '#karte-12 → Karten-Chip');
ok(T.linkify('https://x.de/board#karte-12') === a('https://x.de/board#karte-12'), 'Karten-Kennung in einer URL bleibt Teil des Links');
ok(T.linkify('abc#karte-3 und #karte-x') === 'abc#karte-3 und #karte-x', 'nur echte Kennungen (frei stehend, mit Zahl)');
// Die Seite lädt das Skript wirklich (statisch aus ui/ ausgeliefert)
{
  const html = readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8');
  ok(html.includes('<script src="/md-chat.js"></script>') && existsSync(new URL('./ui/md-chat.js', import.meta.url)), 'index.html lädt /md-chat.js, Datei liegt in ui/');
  ok(/function linkify\(t\)\{const F=window\.FcMd;/.test(html), 'Chat-Text läuft durch FcMd (kein zweites Markdown)');
}

// ── Schwarm-Leiste ──
const skript = "export const meta = {\n  name: 'sendewege-audit',\n  description: 'Audit aller Sendewege; jeder Fund wird \\'adversarial\\' geprüft',\n  phases: [\n    { title: 'Finden', detail: 'ein Agent je Feld' },\n    { title: \"Prüfen\" },\n  ],\n}\n\nconst ROOT = 'x'\n";
const meta = metaAusSkript(skript);
ok(meta.name === 'sendewege-audit' && meta.beschreibung === "Audit aller Sendewege; jeder Fund wird 'adversarial' geprüft" && meta.phasen.join('|') === 'Finden|Prüfen', 'metaAusSkript');
ok(metaAusSkript('').name === '' && metaAusSkript('').phasen.length === 0, 'metaAusSkript leer');
const J = (o) => JSON.stringify(o);
const journal = [J({ type: 'launched' }),
  J({ type: 'started', agentId: 'a1', label: 'finden:mail', phase: 'Finden' }), J({ type: 'started', agentId: 'a2', label: 'finden:wa', phase: 'Finden' }),
  J({ type: 'result', agentId: 'a1', result: { funde: [] } }), 'kaputt{',
  J({ type: 'started', agentId: 'b1', label: 'pruefen:mail', phase: 'Prüfen' })].join('\n');
const t0 = Date.parse('2026-10-08T13:51:00Z');
const st = standAusJournal(journal, { meta, startMs: t0, journalMs: t0 + 6 * 60_000 });
ok(st.gesamt === 3 && st.fertig === 1 && st.laufen === 2 && st.fehler === 0, 'Zähler');
ok(st.phase === 'Prüfen' && st.phase_nr === 2 && st.phasen.length === 2 && st.name === 'sendewege-audit', 'Phase aus letztem laufenden Agenten');
ok(st.lauf === 'laeuft' && st.agenten[0].status === 'fertig' && st.agenten[2].label === 'pruefen:mail', 'Agentenliste');
const jetzt = t0 + 8 * 60_000;
ok(laufZustand(st, jetzt) === 'laeuft', 'läuft');
eq(schwarmZeile(st, jetzt), { zustand: 'laeuft', text: '🐝 Schwarm „sendewege-audit“ · Phase 2/2 Prüfen · 1 von 3 Agenten fertig, 2 arbeiten · 8 Min' }, 'Zeile läuft');
const fertigJ = journal + '\n' + J({ type: 'result', agentId: 'a2' }) + '\n' + J({ type: 'result', agentId: 'b1' }) + '\n' + J({ type: 'finished' });
const st2 = standAusJournal(fertigJ, { meta, startMs: t0, journalMs: t0 + 14 * 60_000 });
ok(st2.lauf === 'fertig' && laufZustand(st2, jetzt) === 'fertig', 'Abschluss-Ereignis');
eq(schwarmZeile(st2, t0 + 20 * 60_000).text, '✅ Schwarm „sendewege-audit“ fertig · 3 Agenten · 14 Min · Ergebnis kommt im Fenster', 'Zeile fertig');
const ohneEnde = standAusJournal(journal + '\n' + J({ type: 'result', agentId: 'a2' }) + '\n' + J({ type: 'result', agentId: 'b1' }), { startMs: t0, journalMs: t0 + 10 * 60_000 });
ok(laufZustand(ohneEnde, t0 + 15 * 60_000) === 'laeuft' && laufZustand(ohneEnde, t0 + 21 * 60_000) === 'fertig', 'ohne Abschluss: 10 Min Ruhe nach letztem Agenten = fertig');
ok(standAusJournal(journal, { aufgabe: { status: 'completed' } }).lauf === 'fertig' && standAusJournal(journal, { aufgabe: { status: 'failed' } }).lauf === 'fehler', 'Abschluss aus task-notification');
ok(laufZustand(standAusJournal(journal, { startMs: t0, journalMs: t0 }), t0 + 3 * 3600_000) === 'abgebrochen', '2 Std Stille = abgebrochen');
const fj = standAusJournal(journal + '\n' + J({ type: 'failed', agentId: 'a2', error: 'x' }), { startMs: t0, journalMs: t0 });
ok(fj.fehler === 1 && schwarmZeile(fj, t0 + 60_000).text.includes('1 Fehler'), 'Agent-Fehler');
eq(schwarmZeile(standAusJournal(J({ type: 'launched' }), { startMs: t0, journalMs: t0 }), t0 + 20_000).text, '🐝 Schwarm · startet … · gerade gestartet', 'ohne Agenten/ohne Meta');
ok(sichtbareLaeufe([st, st2, null], t0 + 40 * 60_000).length === 2, 'sichtbar: laufend + fertig < 30 Min');
ok(sichtbareLaeufe([st2], t0 + 40 * 60_000).length === 1 && sichtbareLaeufe([st2], t0 + 45 * 60_000).length === 0, 'fertiger fällt nach 30 Min raus');
ok(sichtbareLaeufe([], 0).length === 0, 'leer');
{
  const sitz = '{"content":"Workflow launched in background. Task ID: w7qtlnw3d\\nSummary: Audit\\nTranscript dir: /home/u/x/subagents/workflows/wf_cb86546f-ad0\\nScript file: /y"}\n{"content":"<task-notification>\\n<task-id>w7qtlnw3d</task-id>\\n<status>completed</status>"}';
  const auf = aufgabenAusSitzung(sitz);
  ok(auf['wf_cb86546f-ad0'] && auf['wf_cb86546f-ad0'].task === 'w7qtlnw3d' && auf['wf_cb86546f-ad0'].status === 'completed', 'aufgabenAusSitzung');
  ok(Object.keys(aufgabenAusSitzung('')).length === 0, 'aufgaben leer');
}
// Lesen aus einem echten Sitzungsordner (so legt Claude Code ihn ab)
const tmp = mkdtempSync(join(tmpdir(), 'fc-komfort-'));
try {
  const proj = join(tmp, 'projects', '-home-u-repo');
  const wf = join(proj, 'sitz-1', 'subagents', 'workflows', 'wf_abc123');
  mkdirSync(wf, { recursive: true });
  mkdirSync(join(proj, 'sitz-1', 'workflows', 'scripts'), { recursive: true });
  writeFileSync(join(wf, 'journal.jsonl'), journal + '\n');
  writeFileSync(join(proj, 'sitz-1', 'workflows', 'scripts', 'audit-wf_abc123.js'), skript);
  writeFileSync(join(proj, 'sitz-1.jsonl'), '');
  mkdirSync(join(proj, 'sitz-2'), { recursive: true }); // Sitzung ohne Workflows
  const z = schwarmFuerOrdner(proj, { cacheMs: 0 });
  ok(z.length === 1 && z[0].name === 'sendewege-audit' && z[0].gesamt === 3 && z[0].laufen === 2 && z[0].zustand === 'laeuft', 'schwarmFuerOrdner liest Journal + Skript-Meta');
  ok(z[0].text.startsWith('🐝 Schwarm „sendewege-audit“ · Phase 2/2 Prüfen'), 'Zeile aus dem Ordner');
  eq(schwarmFuerOrdner(join(tmp, 'gibt-es-nicht'), { cacheMs: 0 }), [], 'fehlender Ordner → keine Leiste');
  eq(schwarmFuerOrdner('', {}), [], 'ohne Ordner → keine Leiste');
  ok(schwarmFuerOrdner(proj, { cacheMs: 0, jetztMs: Date.now() + 13 * 3600_000 }).length === 0, 'älter als 12 Std → nicht gelesen');
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ── Verlauf in Etappen + frischer Verlauf je Fenster ──
eq(etappeGrenzen({}), { limit: ERSTE_LADUNG, vor: 0, ab: 0 }, 'Grenzen: Standard 25');
eq(etappeGrenzen({ limit: '9999', vor: '-5', ab: 'x' }), { limit: MAX_ETAPPE, vor: 0, ab: 0 }, 'Grenzen: Deckel + Unsinn = 0');
eq(nurAktuellerVerlauf([{ kanal: 'a', id: 3 }, { kanal: 'a', id: 7 }, { kanal: 'b', id: 1 }], { a: 5 }).map((z) => z.id), [7, 1], 'Treffer vor verlauf_ab fallen weg');
const tmp2 = mkdtempSync(join(tmpdir(), 'fc-verlauf-'));
try {
  const db = openDb(tmp2);
  verlaufSchema(db); verlaufSchema(db);
  ok(true, 'verlaufSchema idempotent');
  for (let i = 1; i <= 70; i++) senden(db, { kanal: 'k1', von: 'x', inhalt: 'n' + i });
  const erste = nachrichtenEtappe(db, { kanal: 'k1', limit: 25 });
  ok(erste.length === 25 && erste[0].inhalt === 'n46' && erste[24].inhalt === 'n70', 'erste Ladung = die jüngsten 25, aufsteigend');
  const davor = nachrichtenEtappe(db, { kanal: 'k1', vor: erste[0].id, limit: 60 });
  ok(davor.length === 45 && davor[0].inhalt === 'n1' && davor[44].inhalt === 'n45', 'vor=<id>: die älteren, nahtlos');
  ok(nachrichtenEtappe(db, { kanal: 'k1', vor: davor[0].id, limit: 60 }).length === 0, 'ganz oben: nichts mehr');
  ok(nachrichten(db, { kanal: 'k1', seit: 0, limit: 5 })[0].inhalt === 'n1', 'alter Weg (seit, aufsteigend) unverändert');
  // Fenster mit dem Namen eines geschlossenen Vorgängers: alter Verlauf bleibt in der DB, aber unsichtbar
  fensterAnlegen(db, { name: 'thema', ordner: '/tmp' });
  ok(verlaufAbSetzen(db, 'thema') === 0 && verlaufAb(db, 'thema') === 0, 'neues Fenster ohne Vorgänger: ganzer Verlauf');
  senden(db, { kanal: 'thema', von: 'x', inhalt: 'alt 1' }); const alt2 = senden(db, { kanal: 'thema', von: 'x', inhalt: 'alt 2' });
  fensterLoeschen(db, 'thema');
  fensterAnlegen(db, { name: 'thema', ordner: '/tmp' });
  ok(verlaufAbSetzen(db, 'thema') === alt2.id && verlaufAb(db, 'thema') === alt2.id, 'Nachfolger: verlauf_ab = letzte Nachricht des Vorgängers');
  ok(nachrichtenEtappe(db, { kanal: 'thema', ab: verlaufAb(db, 'thema') }).length === 0, 'Nachfolger startet leer');
  senden(db, { kanal: 'thema', von: 'x', inhalt: 'neu' });
  eq(nachrichtenEtappe(db, { kanal: 'thema', ab: verlaufAb(db, 'thema') }).map((m) => m.inhalt), ['neu'], 'nur Neues sichtbar');
  ok(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kanal = 'thema'").get().n === 3, 'nichts gelöscht');
  ok(verlaufAb(db, 'kein-fenster') === 0, 'normaler Kanal: verlauf_ab 0');
} finally { rmSync(tmp2, { recursive: true, force: true }); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

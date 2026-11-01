// test_konsole.mjs — reine Logik der „Konsole im Chat“ (v1.0/1.1) + Registry/Board/Login der Datenschicht.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paneZustand, tastenFuerWahl, mehrfachSchritte, HINWEIS_MEHRFACH, chatBefehl, dialogText, dialogMeta, fragePasst, dialogAbgeschnitten, textVorDialog, protokollNachrichten, spiegelBeitraege, spiegelStart, ganzeZeilen, protokollZuProzess, zustellText, markerAufloesen, medienZerlegen, neueZustellungen, slug, protokollOrdner, werkzeugZeile } from './server/protokoll.mjs';
import { etimeSekunden, startBefehl } from './server/orte.mjs';
import { openDb, fensterAnlegen, fensterHolen, fensterAlle, fensterAendern, fensterLoeschen, karteAnlegen, karteAendern, karteVerlauf, karten, nutzerAnlegen, nutzerAnzahl, nutzerPruefen, sitzungAnlegen, sitzungNutzer, sitzungLoeschen, senden, metaSetzen, kanaele } from './server/db.mjs';

let pass = 0, fail = 0;
const ok = (bed, name) => { if (bed) { pass++; } else { fail++; console.log('FAIL:', name); } };
const eq = (ist, soll, name) => { const a = JSON.stringify(ist), b = JSON.stringify(soll); if (a === b) pass++; else { fail++; console.log('FAIL:', name, '\n  ist: ', a, '\n  soll:', b); } };

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
ok(JSON.stringify(chatBefehl('Nimm bitte dunkelblau', { dialog: zf.dialog })) === JSON.stringify({ art: 'freitext', nr: 4, text: 'Nimm bitte dunkelblau' }), 'Freitext bei Rückfrage = Antwortfeld „Type something."');
// v1.0: Nachzug aus dem Live-Betrieb (Rückfragen ohne Antwortfeld, Dialoge ohne Nummern, hohe Dialoge, Text vor der Frage)
const mitVorschau = { art: 'frage', cursor: 1, optionen: [{ nr: 1, label: 'Kurz' }, { nr: 2, label: 'Lang' }, { nr: 3, label: 'Chat about this' }] };
const protFrage = { fragen: [{ frage: 'Welche Länge?', kopf: 'Text', optionen: [{ label: 'Kurz', beschreibung: 'zwei Sätze' }, { label: 'Lang', beschreibung: '' }] }] };
const rb = chatBefehl('lass uns erst reden', { dialog: mitVorschau, frage: protFrage });
ok(rb.art === 'wahl' && rb.nummern[0] === 3 && rb.nachtext === 'lass uns erst reden', 'ohne Antwortfeld: „Chat about this" + Text danach');
ok(chatBefehl('egal', { dialog: { ...mitVorschau, optionen: mitVorschau.optionen.slice(0, 2) } }).art === 'halten', 'weder Antwortfeld noch „Chat about this": Text wartet');
const ohneNr = paneZustand('\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n').dialog;
ok(ohneNr && ohneNr.optionen.length === 2 && ohneNr.optionen[1].label === 'Yes, I trust this folder', 'Dialog ohne Nummern erkannt');
ok(paneZustand('❯ hallo\n  zweite Zeile\n').dialog === null, 'Eingabezeile ohne Dialog-Fuß ist kein Dialog');
ok(dialogAbgeschnitten('   3. Drei\n ❯ 4. Vier\n\n Enter to select · Esc to cancel\n'), 'oben abgeschnittener Dialog erkannt');
const dm = dialogMeta(mitVorschau, protFrage);
ok(dm.titel === 'Text: Welche Länge?' && dm.optionen.length === 2 && dm.optionen[0].beschreibung === 'zwei Sätze', 'dialogMeta nimmt Frage + Beschreibung aus dem Protokoll');
ok(/Welche Länge\?/.test(dialogText(mitVorschau, protFrage)) && !/Chat about this/.test(dialogText(mitVorschau, protFrage)), 'dialogText mit ganzer Frage, ohne Hilfsoptionen');
const vorText = '● Ich habe zwei Wege gefunden.\n  Der erste ist schneller.\n\n──────────────\n Welche Länge?\n ❯ 1. Kurz\n   2. Lang\n   3. Type something.\n\n Enter to select · Esc to cancel\n';
ok(textVorDialog(vorText) === 'Ich habe zwei Wege gefunden. Der erste ist schneller.', 'Text über der Rückfrage wird gelesen');
const lang = ' Bash command\n╌╌╌╌╌╌\n curl x\n╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n';
ok(!/╌/.test(paneZustand(lang).dialog.titel), 'Trennlinien nicht im Freigabe-Titel');
const cd = (t) => paneZustand(` Stop\n ⚠ Claude Code will automatically deny this request in ${t}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n`).dialog.kennung;
ok(cd('1:46') === cd('1:45'), 'Countdown ändert die Dialog-Kennung nicht');
const VORSCHAU = ' ☐ Layout\nWelches Layout?\n❯ 1. A                            ┌──────────────────────────────────────────┐\n  2. B                            │ +-------+-----------------+              │\n                                  ├─── ✂ ─── 4 lines hidden ─────────────────┤\n                                  └──────────────────────────────────────────┘\n                                  Notes: press n to add notes\n────────────────────────────────────────────────────────────────────────────────\n  Chat about this\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel\n';
const dv = paneZustand(VORSCHAU).dialog;
ok(dv && dv.optionen.map((o) => o.label).join('|') === 'A|B|Chat about this', 'Vorschau-Rückfrage: „Chat about this" ohne Nummer zählt als Option 3');
ok(dv && !dv.optionen[1].beschreibung, '„Notes: press n …" ist keine Beschreibung');
const cv = chatBefehl('erst reden', { dialog: dv });
ok(cv.art === 'wahl' && cv.nummern[0] === 3 && cv.nachtext === 'erst reden', 'Freitext bei Vorschau-Rückfrage = „Chat about this" (auch ohne Protokoll)');
ok(dialogAbgeschnitten(VORSCHAU), 'gekürzte Vorschau („✂ … lines hidden") = abgeschnitten → vergrößern');
ok(dv && dv.vorschau && !/✂/.test(dv.vorschau.text), 'Kürzungs-Marke nicht im Vorschau-Text');
ok(chatBefehl('1. und mach die Ecken rund', { dialog: zf.dialog }).nachtext === 'und mach die Ecken rund', 'Wahl + Nachtext');
ok(chatBefehl('manual', {}).ziel === 'default' && chatBefehl('auto', {}).ziel === 'auto' && chatBefehl('plan', {}).ziel === 'plan', 'Modus-Worte');

// ── v1.1: Mehrfachauswahl + mehrere Fragen + Absenden-Karte (Bilder aus Claude Code 2.1.289) ──
const MF = (zeilen) => `───────────────────────────────────────────────────────────────────────────
←  ☒ Obst  ☐ Farbe  ✔ Submit  →

Welches Obst magst du?

${zeilen}
───────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const MF1 = MF(`  1. [✔] Apfel
         Süß und knackig
  2. [ ] Birne
         Saftig und mild
❯ 3. [✔] Kirsche
         Kleine süße Früchte
  4. [ ] Type something
     Next`);
const m1 = paneZustand(MF1).dialog;
ok(m1 && m1.mehrfach === true && m1.art === 'frage', 'Mehrfachauswahl erkannt');
eq(m1.optionen.map((o) => [o.nr, o.label, !!o.an]), [[1, 'Apfel', true], [2, 'Birne', false], [3, 'Kirsche', true], [4, 'Type something', false], [5, 'Chat about this', false]], 'Kästchen → an, Label nackt');
ok(!m1.optionen.some((o) => /Next/.test(o.beschreibung || '')), '„Next" ist keine Beschreibung');
eq(m1.reiter, [{ name: 'Obst', fertig: true }, { name: 'Farbe', fertig: false }], 'Reiter-Leiste gelesen');
ok(m1.cursor === 3, 'Cursor auf 3');
ok(paneZustand(MF1.replace('☒ Obst', '☐ Obst')).dialog.kennung === m1.kennung, 'erster Haken (☐→☒ im Reiter) ändert die Kennung nicht');
// Cursor auf „Next", Freitext getippt und umbrochen
const MF2 = MF(`  1. [ ] Apfel
         Süß und knackig
  2. [ ] Birne
         Saftig und mild
  3. [ ] Kirsche
         Kleine süße Früchte
  4. [✔] Wir nehmen alle Kunden der letzten 4
     Monate
❯    Next`);
const m2 = paneZustand(MF2).dialog;
ok(m2 && m2.mehrfach && m2.cursorWeiter, 'Cursor auf Next: trotzdem Dialog, cursorWeiter');
ok(m2.optionen[3].label === 'Wir nehmen alle Kunden der letzten 4 Monate' && m2.optionen[3].an, 'umbrochener Freitext wieder ganz + angehakt');
// Chat-Befehle: die Nachricht ist der ganze Schritt
eq(chatBefehl('1, 3', { dialog: m1 }), { art: 'mehrfach', nummern: [1, 3], text: '' }, '„1, 3" = genau diese');
eq(chatBefehl('2 und 3: Mango', { dialog: m1 }), { art: 'mehrfach', nummern: [2, 3], text: 'Mango' }, '„2 und 3: Mango" = Haken + Freitext');
eq(chatBefehl('1. Mango bitte', { dialog: m1 }), { art: 'mehrfach', nummern: [1], text: 'Mango bitte' }, '„1. Text" = Haken + Freitext');
eq(chatBefehl('Wir nehmen alle mit Rechnung', { dialog: m1 }), { art: 'mehrfach', nummern: [], text: 'Wir nehmen alle mit Rechnung' }, 'reiner Text = nur Freitext');
eq(chatBefehl('10 Kunden reichen', { dialog: m1 }), { art: 'mehrfach', nummern: [], text: '10 Kunden reichen' }, 'Zahl außerhalb der Optionen = Text');
eq(chatBefehl('weiter', { dialog: m1 }), { art: 'mehrfach', nummern: [1, 3], text: null }, '„weiter" = so lassen');
eq(chatBefehl('keine', { dialog: m1 }), { art: 'mehrfach', nummern: [], text: '' }, '„keine" = nichts');
ok(chatBefehl('nein', { dialog: m1 }).art === 'abbruch', '„nein" bricht ab');
// Tasten: Häkchen umschalten, Freitext (ohne Enter) tippen, zu „Next"
eq(mehrfachSchritte(m1, { nummern: [1, 3], text: '' }), [{ tasten: ['Down', 'Down', 'Enter'] }], 'schon richtig: nur zu Next');
eq(mehrfachSchritte(m1, { nummern: [2], text: 'Mango' }), [{ tasten: ['Up', 'Up', 'Space', 'Down', 'Space', 'Down', 'Space', 'Down'] }, { text: 'Mango' }, { tasten: ['Down', 'Enter'] }], 'umhaken, Freitext tippen (ohne Enter), Next');
eq(mehrfachSchritte(m2, { nummern: [1], text: '' }), [{ tasten: ['Up', 'Up', 'Up', 'Up', 'Space', 'Down', 'Down', 'Down', 'C-u', 'Down', 'Enter'] }], 'von Next aus: Freitext leeren (Ctrl+U), 1 anhaken, zurück zu Next');
eq(mehrfachSchritte(m2, { nummern: [], text: 'Neu' }), [{ tasten: ['Up', 'C-u'] }, { text: 'Neu' }, { tasten: ['Down', 'Enter'] }], 'Freitext ersetzen');
eq(mehrfachSchritte(m2, { nummern: [], text: null }), [{ tasten: ['Enter'] }], '„weiter" auf Next = nur Enter');
// Chat-Text + Karte
const dmf = dialogText(m2);
ok(dmf.includes('1) Apfel — Süß und knackig') && !/\d\) Wir nehmen/.test(dmf) && !/Chat about this|Next/.test(dmf), 'Optionen als Knöpfe, Freitext + Hilfsoptionen nicht');
ok(dmf.includes('Eigene Antwort bisher: Wir nehmen alle Kunden der letzten 4 Monate') && dmf.includes(HINWEIS_MEHRFACH), 'Freitext-Vorbelegung + Mehrfach-Hinweis');
ok(dialogText(m1).includes('Schon angehakt: 1, 3'), 'vorab Angehaktes steht drin');
const PF = { frageId: 'x', fragen: [{ frage: 'Welches Obst magst du?', kopf: 'Obst', mehrfach: true, optionen: [{ label: 'Apfel', beschreibung: 'Süß und knackig' }, { label: 'Birne', beschreibung: '' }, { label: 'Kirsche', beschreibung: '' }] }, { frage: 'Welche Farbe?', kopf: 'Farbe', mehrfach: false, optionen: [{ label: 'Rot', beschreibung: '' }, { label: 'Blau', beschreibung: '' }] }] };
ok(fragePasst(m1, PF) && /^❓ Obst: Welches Obst magst du\? \(Frage 1 von 2\)/.test(dialogText(m1, PF)), 'mit Protokoll: Kopf + Frage 1 von 2');
const mm = dialogMeta(m2, PF);
eq(mm.optionen.map((o) => [o.nr, o.label, o.an]), [[1, 'Apfel', false], [2, 'Birne', false], [3, 'Kirsche', false]], 'dialogMeta: nur echte Optionen, mit an');
ok(mm.mehrfach === true && mm.freitext === true && mm.freitextBisher === 'Wir nehmen alle Kunden der letzten 4 Monate', 'dialogMeta: mehrfach, Antwortfeld, Vorbelegung');
ok(dialogMeta(m1).optionen.filter((o) => o.an).map((o) => o.nr).join(',') === '1,3' && dialogMeta(m1).freitextBisher === undefined, 'dialogMeta: angehakt 1,3, leeres Antwortfeld ohne Vorbelegung');
ok(!dialogMeta(zf.dialog).mehrfach, 'Einfachauswahl bleibt ohne mehrfach');
// Absenden-Reiter („Review your answers")
const REVIEW = `───────────────────────────────────────────────────────────────────────────
←  ☒ Obst  ☒ Farbe  ✔ Submit  →

Review your answers

 ● Welches Obst magst du?
   → Apfel, Kirsche, Mango
 ● Welche Farbe bevorzugst du?
   → Blau

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;
const rv = paneZustand(REVIEW).dialog;
ok(rv && rv.art === 'absenden', 'Absenden-Reiter erkannt');
const rt = dialogText(rv);
ok(/^✅/.test(rt) && rt.includes('• Welches Obst magst du?') && rt.includes('→ Apfel, Kirsche, Mango') && rt.includes('1) Absenden') && !/Review your answers|☒/.test(rt), 'Absenden: Antworten lesbar, Knöpfe Absenden/Abbrechen');
eq(chatBefehl('1', { dialog: rv }), { art: 'wahl', nummern: [1] }, 'Absenden mit 1');
ok(chatBefehl('noch was', { dialog: rv }).art === 'halten', 'Freitext beim Absenden wartet');
const rm = dialogMeta(rv);
ok(rm.art === 'absenden' && rm.optionen.map((o) => o.label).join('|') === 'Absenden|Abbrechen' && rm.antworten.length === 4 && rm.antworten[1] === '→ Apfel, Kirsche, Mango', 'dialogMeta: Absenden-Karte mit Übersicht');
// Freitext-Option über zwei Zeilen umbrochen, dann Next + Chat about this → Block hält zusammen
const UMBR_FREI = `←  ☒ Kunden 1  ☐ Kunden 2  ✔ Submit  →

Welche Kunden darf ich mit Logo auf die Startseite nehmen? (Teil 1)

  1. [ ] Alpha
     Beispiel-Kunde A
  2. [ ] Beta
     Beispiel-Kunde B
  3. [ ] Gamma
     Beispiel-Kunde C
  4. [ ] Delta
     Beispiel-Kunde D
  5. [✔] Wir nehmen hier alle Kunden rein, welche in den letzten 4 Monaten
     eine Rechnung von uns bekommen haben.
❯    Next
───────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel`;
const sd = paneZustand(UMBR_FREI).dialog;
ok(sd && sd.mehrfach && sd.optionen.length === 6, 'Dialog mit 6 Optionen trotz umbrochenem Freitext');
ok(sd.optionen[4].label === 'Wir nehmen hier alle Kunden rein, welche in den letzten 4 Monaten eine Rechnung von uns bekommen haben.', 'umbrochener Freitext ganz');
// Keine Doppelkarte: anderer Umbruch / fehlendes „Next" beim Neuzeichnen → dieselbe Kennung, Mehrfach bleibt
ok(paneZustand(MF1.replace('Welches Obst magst du?', 'Welches Obst\nmagst du?')).dialog.kennung === m1.kennung, 'anderer Zeilenumbruch des Titels: gleiche Kennung');
ok(paneZustand(MF1.replace(/\n\s+Next/, '')).dialog.mehrfach === true, 'ohne „Next"-Zeile trotzdem Mehrfachauswahl');

// ── v1.1: lange Rückfrage aus dem Terminalbild — die GANZE Frage, nicht nur die letzten 8 Zeilen ──
const LANG = `

⏺ Ich schaue mir erst den Stand an: Beitrag in der Liste, dann
  Versand-Schalter und offene Antworten.

  Read 1 file, ran 9 shell commands

⏺ Der Browser ist seit gestern abgemeldet – deshalb liefen
  seit dem 05.10. 3 Beiträge ins Leere, 7 Gespräche blieben
  unbeantwortet. Ich fixe jetzt den Pfad und bereite den Text vor.
  · summary

  Ran 3 shell commands
───────────────────────────────────────────────────────────────────────────
←  ☒ Login  ☐ Beitrag  ✔ Submit  →

│ Für den Beitrag (Video mit Stimme, 4.10.) fehlt noch der Text. Mein
│ Entwurf aus deinem gesprochenen Text:
│
│ „Können unsere Mails nicht ein bisschen schöner sein? Gemeint ist nicht
│ die Signatur.
│
│ Bei vielen Systemen war die Antwort bisher: nein. Signatur
│ hübscher machen oder ein Newsletter-Tool nehmen, mehr ging nicht.
│
│ Jetzt schreibst du deine Mails weiter genau da, wo du sie heute
│ schreibst. Der Rest passiert nach dem Senden: Beim Kunden kommt sie
│ gestylt an, mit Logo, mit deinem Bild, auf Wunsch mit Banner. Auf dem
│ Smartphone sieht sie genauso aus.
│
│ Jede Mail, die rausgeht, ist eine Chance, euren Auftritt aufzuwerten.
│
│ Wie sehen eure Mails beim Kunden aus, wenn sie aus dem CRM kommen?“
│
│ Erstkommentar: „So arbeiten wir: beispiel.app. Hängt sich
│ hinter das Postfach, das ihr schon habt, kein neues Tool.“
│
│ So posten?

❯ 1. Ja, so posten
     Text + Erstkommentar setzen, Trockenlauf prüfen, dann live.
  2. Nein, ich sag's frei
     Schreib mir deine Änderung in den Chat.
  3. Type something.
───────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const lz = paneZustand(LANG);
ok(lz.dialog && lz.dialog.art === 'frage' && lz.dialog.optionen.length === 4, 'lange Rückfrage: Dialog mit 4 Optionen');
ok(/^Für den Beitrag/.test(lz.dialog.titel.split('\n').filter((z) => !/[☐☒☑]/.test(z)).join('\n')) && /So posten\?$/.test(lz.dialog.titel), 'Titel = ganze Frage vom Anfang bis „So posten?"');
ok(!/Ran 3 shell commands/.test(lz.dialog.titel), 'Werkzeug-Zusammenfassung über der Trennlinie nicht im Titel');
const lt = dialogText(lz.dialog, null);
ok(/❓ Für den Beitrag/.test(lt) && /Können unsere Mails/.test(lt) && /So posten\?/.test(lt) && !/☐|Submit/.test(lt.split('\n')[0]), 'Chat-Text trägt die ganze Frage, ohne Reiter-Leiste');
ok(/^Für den Beitrag/.test(dialogMeta(lz.dialog).titel), 'dialogMeta: Titel vom Anfang der Frage');
// Kleines Fenster (80×24) zeigt nur das Ende der Frage: gleiche Kennung → keine Doppelkarte nach dem Vergrößern
const kz = paneZustand(LANG.split('\n').slice(-24).join('\n'));
ok(kz.dialog && kz.dialog.kennung === lz.dialog.kennung && kz.dialog.titel.length < lz.dialog.titel.length, 'kleines Fenster (nur Ende der Frage): gleiche Kennung, kürzerer Titel');
// Freigabe-Dialoge bleiben bei den letzten 8 Zeilen (Befehl + Frage)
const FREI = `  Text 1\n  Text 2\n  Text 3\n  Text 4\n  Text 5\n  Text 6\n  Text 7\n  Text 8\n  Text 9\n  Text 10\n  Bash command\n  curl x\n  Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n`;
const fgz = paneZustand(FREI).dialog;
ok(fgz && fgz.art === 'freigabe' && !/Text 5/.test(fgz.titel) && /^Text 6/.test(fgz.titel), 'Freigabe: Titel bleibt bei 8 Zeilen');

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

// ── 1.2 Spiegel: Erkennung (Nachzug aus dem Live-Betrieb) ──
import { paneFingerabdruck as s12Fp, hintergrundAktiv as s12Hg, geheimMaske as s12Maske, nackteZahlOhneDialog as s12Zahl, frageIndex as s12FrageIndex, dialogFussSichtbar as s12Fuss, claudeEigenerDialog as s12Eigen, infoPanel as s12Info, textSchluessel as s12Schluessel, sitzungsIdAus as s12Sid } from './server/protokoll.mjs';
{
  const L = '─'.repeat(75);
  const besch = (n) => Array.from({ length: n }, (_, i) => `     Zeile ${i + 1} einer langen Beschreibung, die im schmalen Fenster umbricht`).join('\n');
  // Lange Options-Beschreibungen (3+ Zeilen) zerlegen den Dialog nicht.
  const lang = `● Kurze Erklärung.\n\n${L}\n ☐ Weg\n\nWie gehen wir vor?\n\n❯ 1. Option A (Recommended)\n${besch(5)}\n  2. Option B\n${besch(4)}\n  3. Option C\n${besch(6)}\n  4. Type something.\n${L}\n  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  const zl = paneZustand(lang);
  ok(zl.dialog && zl.dialog.art === 'frage' && zl.dialog.optionen.length === 5 && zl.dialog.cursor === 1, 'lange Beschreibungen: Rückfrage mit 5 Optionen erkannt');
  ok(zl.dialog && /Zeile 5/.test(zl.dialog.optionen[0].beschreibung || ''), 'lange Beschreibungen: Beschreibung vollständig');
  const aufz = `● Plan:\n  1. erst\n  2. dann\n  3. zuletzt\n\n${L}\nFrage?\n\n❯ 1. Ja\n${besch(4)}\n  2. Nein\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  eq(paneZustand(aufz).dialog && paneZustand(aufz).dialog.optionen.map((o) => o.label), ['Ja', 'Nein'], 'Aufzählung im Text darüber gehört nicht zum Dialog');

  // Fingerabdruck: Reiterwechsel/Cursor ändern ihn, der Countdown nicht.
  const r1 = `← ☒ Kunden 1  ☐ Kunden 2  ✔ Submit →\n\nErste Frage?\n❯ 1. A\n  2. B\nEnter to select · deny in 1:46`;
  const r2 = r1.replace('☒ Kunden 1  ☐ Kunden 2', '☒ Kunden 1  ☒ Kunden 2').replace('Erste Frage?', 'Zweite Frage?');
  ok(s12Fp(r1) !== s12Fp(r2), 'Fingerabdruck: Reiterwechsel ändert ihn');
  ok(s12Fp(r1) === s12Fp(r1.replace('1:46', '1:45')), 'Fingerabdruck: Countdown ändert ihn nicht');
  ok(s12Fp(r1) !== s12Fp(r1.replace('❯ 1. A\n  2. B', '  1. A\n❯ 2. B')), 'Fingerabdruck: Cursorwechsel ändert ihn');

  // „Nou“-Umbruch bleibt Freigabe, Passwörter maskiert.
  const nou = `● Ich lade das hoch.\n\n${L}\n Bash command\n\n   curl -u admin:x https://example.org/wp-json?pwd=Geheim123 --password 'S3cret!'\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and switch to auto mode so I don't ask again for yo\n   3. Nou, and tell Claude what to do differently (esc)\n`;
  const zn = paneZustand(nou);
  ok(zn.dialog && zn.dialog.art === 'freigabe' && /^No,/.test(zn.dialog.optionen[2].label), '„Nou“-Umbruch: trotzdem Freigabe, Label repariert');
  const tn = dialogText(zn.dialog);
  ok(/^🔐/.test(tn) && !/Geheim123|S3cret/.test(tn), 'Freigabe-Text ohne Passwörter');
  ok(!/Geheim123|S3cret/.test(JSON.stringify(dialogMeta(zn.dialog))), 'Freigabe-Knöpfe/Titel ohne Passwörter');
  eq(s12Maske('pwd=geheim'), 'pwd=***', 'Maske: pwd=');
  eq(s12Maske('Authorization: Bearer abcdefghijkl'), 'Authorization: ***', 'Maske: Authorization');
  eq(s12Maske('export API_KEY="sk-1234567890"'), 'export API_KEY="***"', 'Maske: API_KEY in Anführungszeichen');
  eq(s12Maske('DB_PASSWORD=abc123 und Passwort: hunter22'), 'DB_PASSWORD=*** und Passwort: ***', 'Maske: Passwort-Varianten');
  eq(s12Maske('Das passt: gut so. Master-Passwort steht im Tresor.'), 'Das passt: gut so. Master-Passwort steht im Tresor.', 'Maske: normaler Text bleibt');

  // Neue Rückfrage bekommt nie den Titel der vorigen.
  const dn = { art: 'frage', optionen: [{ nr: 1, label: 'Ja, bau es' }, { nr: 2, label: 'Reicht so' }, { nr: 3, label: 'Type something.' }] };
  ok(s12FrageIndex(dn, { fragen: [{ frage: 'Alt?', optionen: [{ label: 'Mobil' }, { label: 'Desktop' }] }] }) === -1, 'alte Protokoll-Frage passt nicht zur neuen Rückfrage');
  ok(s12FrageIndex(dn, { fragen: [{ frage: 'Neu?', optionen: [{ label: 'Ja, bau es' }, { label: 'Reicht so' }] }] }) === 0, 'passende Protokoll-Frage passt');
  ok(s12FrageIndex({ art: 'frage', optionen: [{ nr: 1, label: 'Alles nacheinander bauen und danach' }, { nr: 2, label: 'Nein' }] }, { fragen: [{ frage: 'X?', optionen: [{ label: 'Alles nacheinander bauen und danach testen (Recommended)' }, { label: 'Nein' }] }] }) === 0, 'umgebrochenes Label passt über den Anfang');

  // Nackte Zahl nach geschlossener Rückfrage.
  ok(s12Zahl('1', { dialog: null }, 1000, 5000) === true, '„1“ kurz nach Rückfrage-Ende → nicht ins Fenster');
  ok(s12Zahl('1', { dialog: { art: 'frage' } }, 1000, 5000) === false, 'Dialog offen → normale Wahl');
  ok(s12Zahl('1 und noch was', { dialog: null }, 1000, 5000) === false && s12Zahl('1', { dialog: null }, 0, 5000) === false && s12Zahl('2', { dialog: null }, 1000, 1000 + 16 * 60_000) === false, 'Satz / nie eine Rückfrage / nach 15 min → geht durch');

  // Vortext auch vor Freigaben (über dem Werkzeug-Aufruf) und vor langen Fragen.
  const vf = `● Ich lade jetzt die Datei hoch, damit sie online ist.\n\n● Bash(scp a.pdf server:/x)\n\n${L}\n Bash command\n\n   scp a.pdf server:/x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n`;
  ok(/Ich lade jetzt die Datei hoch/.test(textVorDialog(vf)), 'Vortext vor einer Freigabe');
  const vl = `● Erklärung vor der langen Frage.\n\n${L}\n ☐ Lang\n\n${Array.from({ length: 20 }, (_, i) => `Zeile ${i + 1} der langen Frage.`).join('\n')}\n\n❯ 1. A\n  2. B\n  3. Type something.\n${L}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  ok(/Erklärung vor der langen Frage/.test(textVorDialog(vl)), 'Vortext vor einer langen Frage (20 Titelzeilen)');

  // Doppel-Schutz: Medien und Sprachnachrichten haben eigene Schlüssel.
  eq(s12Schluessel('[Bild: /x/media/abc.png]'), 'medien:abc.png', 'Schlüssel: reiner Medien-Text');
  const sa = s12Schluessel('[Sprachnachricht: /home/u/projekt/data/media/antwort-eins.webm ("Okay, kurz gesagt geht das so.")]');
  const sb = s12Schluessel('[Sprachnachricht: /home/u/projekt/data/media/antwort-zwei.webm ("Okay, ich hab nachgeschaut.")]');
  ok(sa !== sb && sa.startsWith('sprach:antwort-eins.webm:') && sb.startsWith('sprach:antwort-zwei.webm:'), 'Schlüssel: zwei Sprachnachrichten mit gleichem Pfad-Anfang sind kein Doppel');
  eq(s12Schluessel('[Sprachnachricht: /a/b/x.webm]'), 'sprach:x.webm', 'Schlüssel: Sprachnachricht ohne Text');

  // ▔-Systemdialoge: Rahmen (auch mit Effort-Anzeige) nicht im Titel.
  const sys = `${'▔'.repeat(70)}\n Switch format?\n\n ❯ 1. Kurz\n   2. Lang\n\nEnter to confirm · Esc to exit`;
  ok(paneZustand(sys).dialog && !/▔/.test(dialogText(paneZustand(sys).dialog)), '▔-Rahmen nicht im Kartentext');
  const eff = ['▔'.repeat(70) + ' ◐ medium · /effort ▔', ' Welche Variante?', '', ' ❯ 1. A', '   2. B', '', ' Enter to confirm · Esc to cancel'].join('\n');
  ok(paneZustand(eff).dialog && !/▔|effort/.test(paneZustand(eff).dialog.titel), '▔-Rahmen mit Effort-Anzeige nicht im Titel');

  // /status- und /usage-Panel sind keine Rückfrage.
  const status = ['● Fertig', '▔'.repeat(80), '   Settings  Status   Config   Usage   Stats', '', '   Version:           2.1.293', '   Model:             opus', '', '   Esc to cancel'].join('\n');
  const usage = ['   Settings  Status   Config   Usage   Stats', '', '   Usage by model:', '', '   d to day · w to week   Esc to cancel'].join('\n');
  ok(s12Info(status) && !dialogAbgeschnitten(status) && !s12Fuss(status), '/status-Panel: kein Dialog, kein Vergrößern');
  ok(!dialogAbgeschnitten(usage) && !s12Fuss(usage), '/usage-Panel: kein Dialog, kein Vergrößern');
  ok(!s12Info(frage) && !s12Info(freigabe), 'echte Dialoge sind kein Anzeige-Panel');
  const leer = ['● Fertig.', '', '  ◐ medium · /effort', '─'.repeat(80), '❯ ', '─'.repeat(80), '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
  ok(!s12Fuss(leer), 'Leerlauf-Bild: kein Dialog-Fuß');

  // Claude Codes eigene Dialoge (/model, /login, Rewind) — keine Karte. Bypass-Bestätigung bleibt ein Dialog.
  const modell = [' Select model', ' Switch between Claude models.', '', ' ❯ 1. Default (recommended)', '   2. Sonnet', '   3. Haiku', '', ' Enter to confirm · Esc to cancel', ''].join('\n');
  ok(s12Eigen(modell) && paneZustand(modell).dialog === null && !s12Fuss(modell), '/model-Wähler ist kein Fenster-Dialog');
  const login = [' Select login method:', '', ' ❯ 1. Claude account with subscription', '   2. Anthropic Console account', '', ' Enter to select · Esc to cancel', ''].join('\n');
  ok(s12Eigen(login) && paneZustand(login).dialog === null, '/login ist kein Fenster-Dialog');
  const rewind = ['   Rewind', '', '   Restore the code and/or conversation to the point before…', '', '     Erste Nachricht', '     No code changes', '', '   ❯ (current)', '', '   Enter to continue · Esc to cancel', ''].join('\n');
  ok(s12Eigen(rewind) && paneZustand(rewind).dialog === null && !s12Fuss(rewind), 'Rewind-Dialog (Esc Esc) ist kein Fenster-Dialog');
  const bypass = ['  WARNING: Claude Code running in Bypass Permissions mode', '', '  By proceeding, you accept all responsibility.', '', '  ❯ No, exit', '    Yes, I accept', '', '  Enter to confirm · Esc to cancel', ...Array(25).fill('')].join('\n');
  ok(!s12Eigen(bypass) && paneZustand(bypass).dialog && paneZustand(bypass).dialog.optionen.map((o) => o.label).join('|') === 'No, exit|Yes, I accept', 'Bypass-Bestätigung mit Leerzeilen darunter: Dialog ohne Nummern erkannt');
  ok(!dialogAbgeschnitten(bypass), 'Bypass-Bestätigung gilt nicht als abgeschnitten');
  const echt = ['● Welche Variante?', '', ' ❯ 1. Herzschlag', '   2. Flackern', '', ' Enter to confirm · Esc to cancel', ''].join('\n');
  ok(!s12Eigen(echt) && !!paneZustand(echt).dialog && s12Fuss(echt), 'echte Rückfrage bleibt ein Dialog');

  // Hintergrund-Agent/Schwarm zählt als aktiv (Lampe), auch ohne Klammer-Zeit.
  const hgW = `● Workflow(drei Bauer)\n  ⎿  Running in background\n\n✻ Waiting for 1 dynamic workflow to finish\n\n╭────╮\n│ ❯  │\n╰────╯\n  ⏵⏵ auto mode on (shift+tab to cycle)\n  ◯ schwarm  ▱▱▱▱  3m35s · ↓ 467.1k\n`;
  const zw = paneZustand(hgW);
  ok(zw.busy === false && zw.hintergrund === true && !zw.dialog, 'Schwarm läuft: busy false, hintergrund true');
  ok(paneZustand(prompt).hintergrund === false && s12Hg('✻ Waiting for 2 background agents to finish') && s12Hg('  ◯ bauer1  ▱▱▱  12s · ↓ 1.2k') && !s12Hg('◯ nur ein Punkt ohne Zeit'), 'hintergrundAktiv: Varianten');

  // Mehrzeilige Rückfrage behält ihre Zeilen (Listen/Tabellen).
  const zm = paneZustand(' ☐ Zahlungen\n Was sind die Zahlungen?\n\n ❯ 1. Privat\n   2. Geschäft\n   3. Type something.\n\n Enter to confirm\n');
  const tm = dialogText(zm.dialog, { fragen: [{ frage: 'Offen:\n- Posten A   (08.06.)\n- Posten B\n\n\n| Datum | Betrag |\n|---|---|\n| 12.08. | 352,91 |\n\nWas sind die Zahlungen?', kopf: 'Zahlungen', optionen: [{ label: 'Privat' }, { label: 'Geschäft' }] }] });
  ok(/^❓ Zahlungen: Offen:\n- Posten A \(08\.06\.\)\n- Posten B\n\n\| Datum \| Betrag \|\n\|---\|---\|\n\| 12\.08\. \| 352,91 \|\n\nWas sind die Zahlungen\?\n1\) /.test(tm), 'Rückfrage-Text behält Zeilen, Mehrfach-Leerzeilen weg');

  // Protokoll exakt über sessions/<pid>.json.
  eq(s12Sid('{"pid":4711,"sessionId":"0b6f2c1e-1234-4abc-9def-001122334455","cwd":"/x"}'), '0b6f2c1e-1234-4abc-9def-001122334455', 'sessionId aus sessions/<pid>.json');
  ok(s12Sid('kaputt') === '' && s12Sid('{"sessionId":"../../etc/passwd"}') === '', 'sessionId: kaputt/unsicher → leer');
}

// ── 1.2 Spiegel: Runde (Anstoß, Horcher, Zustand), langer Start-Text, Aufräumen ──
import { createAnstoss as s12Anstoss, createHorcher as s12Horcher, zustandsSchluessel as s12ZSchl, NACHLAUF_MS as s12Nachlauf } from './server/konsole.mjs';
import { startTextLang as s12Lang, startTextDatei as s12Datei, START_TEXT_MAX as s12Max } from './server/orte.mjs';
import { createAufraeumen as s12Aufr, aufraeumText as s12AText, kanalHinweis as s12Hinweis, istAufgeraeumt as s12Aufg } from './server/aufraeumen.mjs';
{
  // Anstoß: viele Ereignisse → ein Satz Runden (sofort + Nachlauf), nichts gestapelt.
  const geplant = []; let laeufe = 0;
  const a = s12Anstoss({ lauf: () => laeufe++, setze: (fn, ms) => geplant.push({ fn, ms }) });
  a.anstossen(); a.anstossen(); a.anstossen();
  ok(geplant.length === s12Nachlauf.length && a.anstehend === s12Nachlauf.length, 'Anstoß: drei Ereignisse → ein Satz Nachlauf-Runden');
  geplant.splice(0).forEach((g) => g.fn());
  ok(laeufe === s12Nachlauf.length && a.anstehend === 0, 'Anstoß: alle Stufen gelaufen, nichts mehr offen');
  a.anstossen(); ok(geplant.length === s12Nachlauf.length, 'Anstoß: danach wieder planbar');
  // Horcher: genau ein Watcher je Datei, verschwundene werden geschlossen, Fehler beim Beobachten kein Abbruch.
  const zu = [], neu = []; let cb = null;
  const h = s12Horcher({ beobachte: (d, f) => { if (d === 'kaputt') throw new Error('x'); neu.push(d); cb = f; return { close: () => zu.push(d) }; }, beiAenderung: (d) => zu.push('aenderung:' + d) });
  h.sync(['a.jsonl', 'b.jsonl', null]); h.sync(['a.jsonl', 'b.jsonl']);
  ok(neu.join() === 'a.jsonl,b.jsonl' && h.anzahl === 2, 'Horcher: ein Watcher je Protokoll, keine Doppel');
  h.sync(['b.jsonl', 'kaputt']);
  ok(zu.includes('a.jsonl') && h.anzahl === 2, 'Horcher: verschwundene Datei wird nicht mehr beobachtet, Fehler bricht nichts ab');
  cb(); ok(zu.includes('aenderung:b.jsonl'), 'Horcher: neue Protokollzeile stößt eine Runde an');
  h.stop(); ok(h.anzahl === 0 && zu.includes('b.jsonl'), 'Horcher: stop schließt alle');
  // Zustands-Schlüssel: Dialog auf/zu, Modus, Lampe wecken die Oberfläche; die Uhr nicht.
  const z0 = { modus: 'auto', dialog: null, lebt: true, lampe: 'beschaeftigt', busy_sekunden: 3 };
  ok(s12ZSchl(z0) === s12ZSchl({ ...z0, busy_sekunden: 9 }), 'Zustand: laufende Uhr weckt nicht');
  ok(s12ZSchl(z0) !== s12ZSchl({ ...z0, dialog: { art: 'frage' }, kennung: 'k1' }) && s12ZSchl({ ...z0, dialog: { art: 'frage' }, kennung: 'k1' }) !== s12ZSchl({ ...z0, dialog: { art: 'frage' }, kennung: 'k2' }), 'Zustand: Dialog auf/neu weckt');
  ok(s12ZSchl(z0) !== s12ZSchl({ ...z0, modus: 'default' }) && s12ZSchl(z0) !== s12ZSchl({ ...z0, lampe: 'bereit' }) && s12ZSchl(null) === '', 'Zustand: Modus/Lampe wecken');

  // Langer Start-Text über eine Datei (das Terminal kappt eine getippte Zeile bei 4095 Zeichen).
  const kurzF = { ordner: '/tmp/x', tmux: 'fc-thema', start_text: 'Mach das.' };
  const langF = { ...kurzF, start_text: 'Bericht ' + 'x'.repeat(4200) + " mit 'Quote'" };
  ok(!s12Lang(kurzF) && s12Lang(langF), 'Start-Text: lang erst über ' + s12Max + ' Zeichen');
  ok(startBefehl(langF).length < 300 && startBefehl(langF).endsWith(`"$(cat '/tmp/flottenchat-start-fc-thema.txt')"`), 'Start-Text: lange Zeile wird zu $(cat Datei)');
  ok(startBefehl(kurzF).endsWith(" 'Mach das.'"), 'Start-Text: kurzer bleibt direkt');
  eq(s12Datei({ tmux: 'fc-a/../b' }), '/tmp/flottenchat-start-fc-a____b.txt', 'Start-Text-Datei: keine Pfad-Tricks');

  // Aufräumen vor Neu starten / Löschen / Schließen.
  const welt = ({ lebt = true, dialog = false, aufgeraeumtNach = Infinity, stirbtNach = Infinity } = {}) => {
    let t = 0; const log = [];
    const a = s12Aufr({
      jetzt: () => t, warte: async (ms) => { t += ms; },
      lebt: () => (t === 0 ? lebt : lebt && t < stirbtNach), dialogOffen: () => dialog, escape: () => log.push('esc'),
      textSenden: (f, text) => log.push('text:' + text.slice(0, 20)), letzteId: () => 41,
      aufgeraeumtSeit: (f, id) => { log.push('pruef:' + id); return t >= aufgeraeumtNach; },
      ausfuehren: (f, art, grund) => { log.push(`aus:${art}:${grund}`); return { ok: true }; },
      melden: (f, text) => log.push('meld:' + text.slice(0, 12)),
    });
    return { a, log, zeit: () => t };
  };
  { const { a, log } = welt({ lebt: false }); const r = a.starten({ name: 'w1' }, 'loeschen');
    ok(r.ok && r.sofort && log.join() === 'aus:loeschen:aus' && a.stand('w1') === null, 'Aufräumen: Fenster aus → sofort, ohne Auftrag'); }
  { const { a, log } = welt(); const r = a.starten({ name: 'w1' }, 'schliessen', { sofort: true });
    ok(r.sofort && log.join() === 'aus:schliessen:sofort', 'Aufräumen: „sofort“ überspringt das Warten'); }
  { const { a, log, zeit } = welt({ aufgeraeumtNach: 9_000 }); const r = a.starten({ name: 'w2' }, 'neustart');
    ok(r.ok && r.sofort === false && a.stand('w2').art === 'neustart', 'Aufräumen: läuft → Stand gesetzt („räumt auf …“)');
    ok(a.starten({ name: 'w2' }, 'loeschen').laeuft_schon, 'Aufräumen: zweiter Klick startet nichts Neues');
    const grund = await r.fertig;
    ok(grund === 'aufgeraeumt' && zeit() === 9_000 && a.stand('w2') === null, 'Aufräumen: Aktion nach „aufgeräumt“, nicht länger gewartet');
    ok(log[0].startsWith('meld:') && log[1].startsWith('text:') && log.includes('pruef:41') && log[log.length - 1] === 'aus:neustart:aufgeraeumt', 'Aufräumen: Hinweis, Auftrag, Prüfung ab der Nachricht davor, dann Aktion'); }
  { const { a, log, zeit } = welt(); const grund = await a.starten({ name: 'w3' }, 'loeschen').fertig;
    ok(grund === 'zeit' && zeit() >= 120_000 && zeit() <= 123_000 && log[log.length - 1] === 'aus:loeschen:zeit', 'Aufräumen: höchstens 2 Minuten'); }
  { const { a, log } = welt({ dialog: true, aufgeraeumtNach: 3_000 }); await a.starten({ name: 'w4' }, 'neustart').fertig;
    ok(log.indexOf('esc') >= 0 && log.indexOf('esc') < log.findIndex((x) => x.startsWith('text:')), 'Aufräumen: offene Rückfrage erst mit Esc schließen'); }
  { const { a } = welt({ stirbtNach: 6_000 }); ok(await a.starten({ name: 'w5' }, 'neustart').fertig === 'beendet', 'Aufräumen: Fenster beendet sich → sofort weiter'); }
  { let t = 0; const a = s12Aufr({ jetzt: () => t, warte: async (ms) => { t += ms; }, lebt: () => true, textSenden: () => {}, aufgeraeumtSeit: () => true, ausfuehren: () => { throw new Error('x'); } });
    ok(await a.starten({ name: 'w6' }, 'loeschen').fertig === 'fehler' && a.stand('w6') === null, 'Aufräumen: Fehler in der Aktion blockiert das Fenster nicht'); }
  ok(s12Aufr({ lebt: () => true }).starten(null, 'neustart').ok === false && s12Aufr({ lebt: () => true }).starten({ name: 'x' }, 'boom').ok === false, 'Aufräumen: ohne Fenster / unbekannte Aktion → Fehler');
  ok(/gelöscht/.test(s12AText('loeschen')) && /geschlossen/.test(s12AText('schliessen')) && /neu gestartet/.test(s12AText('neustart')) && /startet/.test(s12Hinweis('neustart')), 'Aufräumen: Wortlaut je Aktion');
  ok(s12Aufg('aufgeräumt') && s12Aufg('Stand steht in der Karte, alles committet. Aufgeräumt.') && !s12Aufg(s12AText('neustart')) && !s12Aufg('räumt noch auf'), 'Aufräumen: „aufgeräumt“ erkannt, der Auftrag selbst zählt nicht');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

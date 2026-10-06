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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

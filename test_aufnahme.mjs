// test_aufnahme.mjs — Aufnahme (v1.3): Weg-Wahl, Filter, Zeitmarken, Stück-Zusammensetzung, Fehlerpfade ohne Schlüssel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  wegeWaehlen, lokalesKommando, kommandoZeile, openaiSchluessel, endungFuerMime, openaiFehler, fremdschriftWeg, erfunden, endeFuellsel,
  stueckSauber, zeitmarke, textMitZeit, teileAusZeitText, createTranskription, OPENAI_MODELL, OPENAI_URL,
} from './server/transkription.mjs';
import {
  kennungGueltig, nrGueltig, sekunden, neueSitzung, stueckAngekommen, stueckErgebnis, abschlussStand, teile, fliesstext, zeittext,
  zwischenstand, transkriptName, createAufnahmeDienst,
} from './server/aufnahme.mjs';
import { chatBefehl, markerAufloesen } from './server/protokoll.mjs';
import { liste as ablageListe, loeschen as ablageLoeschen, istSidecar, transkriptFuer } from './server/ablage.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

// ── Weg-Wahl ──
const K = { art: 'whisper', bin: '/usr/bin/whisper' };
{
  const w = wegeWaehlen({});
  eq(w.wege, [], 'nichts da → keine Wege');
  eq(w.weg, 'aus', 'nichts da → aus');
  ok(/OPENAI_API_KEY/.test(w.hinweis) && /docs\/aufnahme\.md/.test(w.hinweis), 'aus: Hinweis sagt, wie man einschaltet');
}
eq(wegeWaehlen({ OPENAI_API_KEY: 'sk-x' }).wege, ['openai'], 'Schlüssel → openai');
eq(wegeWaehlen({}, { kommando: K }).wege, ['lokal'], 'nur Kommando → lokal');
eq(wegeWaehlen({ OPENAI_API_KEY: 'sk-x' }, { kommando: K }).wege, ['openai', 'lokal'], 'beides → openai, Rückfall lokal');
eq(wegeWaehlen({ OPENAI_API_KEY: 'sk-x', FC_TRANSKRIPTION: 'lokal,openai' }, { kommando: K }).wege, ['lokal', 'openai'], 'Reihenfolge per Env');
eq(wegeWaehlen({ OPENAI_API_KEY: 'sk-x', FC_TRANSKRIPTION: 'aus' }, { kommando: K }).weg, 'aus', 'FC_TRANSKRIPTION=aus schlägt alles');
ok(/ausgeschaltet/.test(wegeWaehlen({ FC_TRANSKRIPTION: 'aus' }).hinweis), 'aus: Hinweis nennt den Schalter');
{
  const w = wegeWaehlen({ FC_TRANSKRIPTION: 'openai' });
  eq(w.weg, 'aus', 'openai gewünscht ohne Schlüssel → aus');
  ok(/kein Schlüssel/.test(w.hinweis), 'Hinweis: kein Schlüssel');
}
{
  const w = wegeWaehlen({ FC_TRANSKRIPTION: 'lokal', OPENAI_API_KEY: 'sk-x' }, { kommandoHinweis: 'whisper gefunden, aber ffmpeg fehlt' });
  eq(w.weg, 'aus', 'lokal gewünscht ohne Kommando → aus (kein heimlicher Wechsel zu OpenAI)');
  ok(/ffmpeg fehlt/.test(w.hinweis), 'Hinweis trägt den Grund des Kommandos');
}
eq(wegeWaehlen({ FC_TRANSKRIPTION: 'openai, quatsch', OPENAI_API_KEY: 'k' }).wege, ['openai'], 'unbekannter Weg wird übergangen');
ok(/unbekannter Weg/.test(wegeWaehlen({ FC_TRANSKRIPTION: 'quatsch' }).hinweis), 'nur unbekannter Weg → aus mit Hinweis');
eq(openaiSchluessel({ OPENAI_API_KEY: 'a', FC_OPENAI_API_KEY: 'b' }), 'b', 'FC_OPENAI_API_KEY schlägt OPENAI_API_KEY');
eq(openaiSchluessel({ OPENAI_API_KEY: '  ' }), '', 'leerer Schlüssel zählt nicht');

// ── lokales Kommando ──
const finde = (vorhanden) => (n) => (vorhanden.includes(n) ? '/usr/bin/' + n : '');
eq(lokalesKommando({ FC_WHISPER_CMD: 'mein-stt --de {datei}' }, { finde: finde([]) }).kommando.art, 'eigen', 'FC_WHISPER_CMD gewinnt immer (auch ohne ffmpeg)');
{
  const r = lokalesKommando({}, { finde: finde(['whisper']), ffmpeg: false });
  eq(r.kommando, null, 'whisper ohne ffmpeg taugt nicht');
  ok(/ffmpeg fehlt/.test(r.hinweis), 'Hinweis: ffmpeg fehlt');
}
eq(lokalesKommando({}, { finde: finde(['whisper']), ffmpeg: true }).kommando.art, 'whisper', 'whisper + ffmpeg → whisper');
{
  const r = lokalesKommando({}, { finde: finde(['whisper-cli', 'whisper']), ffmpeg: true });
  eq(r.kommando.art, 'whisper', 'whisper-cli ohne Modell übersprungen, whisper genommen');
}
eq(lokalesKommando({ FC_WHISPER_MODELL: '/m/ggml-base.bin' }, { finde: finde(['whisper-cli']), ffmpeg: true }).kommando.art, 'whisper-cli', 'whisper-cli mit Modell');
eq(lokalesKommando({}, { finde: finde([]), ffmpeg: true }).kommando, null, 'nichts installiert → null');

// ── Kommandozeile ──
eq(kommandoZeile({ art: 'eigen', vorlage: 'stt --sprache de {datei}' }, '/t/a.wav'), { bin: 'stt', args: ['--sprache', 'de', '/t/a.wav'], ausgabe: 'stdout' }, 'eigen: {datei} ersetzt');
eq(kommandoZeile({ art: 'eigen', vorlage: 'stt' }, '/t/a.wav').args, ['/t/a.wav'], 'eigen ohne Platzhalter: Datei hinten dran');
{
  const z = kommandoZeile(K, '/t/stueck.wav', { ausDir: '/t/aus', sprache: 'de' });
  eq(z.datei, '/t/aus/stueck.txt', 'whisper: Text kommt als Datei');
  ok(z.args.includes('--language') && z.args.includes('de') && z.args.includes('base'), 'whisper: Sprache + Standardmodell');
}
eq(kommandoZeile({ art: 'whisper-cli', bin: 'whisper-cli' }, '/t/a.wav', { modell: '/m.bin' }).args.slice(0, 4), ['-m', '/m.bin', '-f', '/t/a.wav'], 'whisper-cli: Modell + Datei');
eq(kommandoZeile(null, 'x'), null, 'ohne Kommando → null');

// ── MIME / Fehler ──
eq(endungFuerMime('audio/webm;codecs=opus'), 'webm', 'webm');
eq(endungFuerMime('audio/ogg'), 'ogg', 'ogg');
eq(endungFuerMime('audio/mp4'), 'm4a', 'Safari mp4 → m4a');
eq(endungFuerMime(''), 'webm', 'unbekannt → webm');
ok(/OPENAI_API_KEY/.test(openaiFehler(401)), '401 → Schlüssel prüfen');
ok(/Guthaben/.test(openaiFehler(429, '{"error":{"code":"insufficient_quota"}}')), '429 quota → Guthaben');
ok(/bremst/.test(openaiFehler(429, 'rate')), '429 sonst → bremst');

// ── Filter ──
eq(fremdschriftWeg('Hallo お味噌が。 Welt'), 'Hallo Welt', 'Fremdschrift raus');
eq(fremdschriftWeg('Привет мир'), 'Привет мир', 'Kyrillisch bleibt');
ok(erfunden('Untertitel im Auftrag des ZDF, 2021'), 'Untertitel-Abspann ist erfunden');
ok(erfunden('Vielen Dank fürs Zuschauen!'), 'Danke fürs Zuschauen ist erfunden');
ok(!erfunden('Danke, das passt so.'), 'echter Dank bleibt');
eq(stueckSauber('Untertitel von Amara.org'), '', 'Stück: Erfindung → leer');
eq(stueckSauber('Bitte den Knopf お blau machen.'), 'Bitte den Knopf blau machen.', 'Stück: nur Fremdschrift raus');
ok(endeFuellsel('', 'egal'), 'leeres Reststück ist Füllsel');
ok(endeFuellsel('Und schau.', 'Mach den Knopf blau.'), '„Und schau.“ am Ende ist Füllsel');
ok(endeFuellsel("Das war's.", 'Mach den Knopf blau.'), '„Das war’s.“ am Ende ist Füllsel');
ok(endeFuellsel('Findest. Findest', 'ob du das findest'), 'Echo der letzten Worte ist Füllsel');
ok(!endeFuellsel('Tschüss.', ''), '„Tschüss.“ als ganze Nachricht bleibt');
ok(!endeFuellsel('Und dann noch die Farbe ändern bitte', 'Mach den Knopf blau.'), 'echter Satz am Ende bleibt');
ok(!endeFuellsel('Ja genau', 'Mach den Knopf blau.'), 'kurze echte Antwort ohne Echo bleibt');

// ── Zeitmarken ──
eq(zeitmarke(0), '00:00', '0 s');
eq(zeitmarke(75.9), '01:15', 'abgerundet');
eq(zeitmarke(3725), '1:02:05', 'über eine Stunde');
eq(zeitmarke(-3), '00:00', 'negativ → 0');
eq(textMitZeit([{ von: 0, text: 'Hallo' }, { von: 3.4, text: ' Das ist der Knopf. ' }, { von: 9, text: '' }]), '[00:00] Hallo\n[00:03] Das ist der Knopf.', 'Zeilen mit Zeitmarke, leere fallen weg');
eq(teileAusZeitText('[00:00] Hallo\n[01:02:05] Ende\nkaputt'), [{ von: 0, text: 'Hallo' }, { von: 3725, text: 'Ende' }], 'Zeit-Text zurück in Teile');

// ── Sitzung: Stücke zusammensetzen ──
ok(kennungGueltig('abcdef0123456789'), 'Kennung gültig');
ok(!kennungGueltig('../etc') && !kennungGueltig('ABCDEFGH') && !kennungGueltig('abc'), 'Kennung: Ausbrüche/zu kurz abgewiesen');
eq(nrGueltig('3'), 3, 'Nummer 3');
eq(nrGueltig(''), null, 'leere Nummer');
eq(nrGueltig('-1'), null, 'negative Nummer');
eq(nrGueltig('1.5'), null, 'Bruch');
eq(sekunden('4.567'), 4.57, 'Sekunden gerundet');
eq(sekunden('x'), 0, 'Unsinn → 0');
{
  let st = neueSitzung('abcdefgh', { art: 'bildschirm', jetztMs: 1 });
  eq(abschlussStand(st), 'warten', 'leer: warten (letztes Stück fehlt)');
  st = stueckAngekommen(st, 0, { von: 0, bis: 5.2 });
  st = stueckAngekommen(st, 1, { von: 5.2, bis: 12 });
  st = stueckErgebnis(st, 1, 'Und hier der zweite Teil.');
  eq(abschlussStand(st), 'warten', 'Stück 0 läuft noch');
  st = stueckErgebnis(st, 0, 'Das ist お die Startseite.');
  st = stueckAngekommen(st, 2, { von: 12, bis: 14, letztes: true });
  eq(abschlussStand(st), 'warten', 'letztes Stück läuft');
  st = stueckErgebnis(st, 2, 'Und schau.');
  eq(abschlussStand(st), 'fertig', 'alle da → fertig');
  eq(fliesstext(st), 'Das ist die Startseite. Und hier der zweite Teil.', 'Fließtext in Reihenfolge, Fremdschrift + Füllsel am Ende raus');
  eq(zeittext(st), '[00:00] Das ist die Startseite.\n[00:05] Und hier der zweite Teil.', 'Zeitmarken je Stück');
  eq(zwischenstand(st, 1).teile.map((t) => t.nr), [1], 'Zwischenstand ab Nummer');
}
{
  let st = neueSitzung('abcdefgh');
  st = stueckAngekommen(st, 0, { bis: 4 }); st = stueckErgebnis(st, 0, 'Eins');
  st = stueckAngekommen(st, 2, { von: 8, bis: 9, letztes: true }); st = stueckErgebnis(st, 2, 'Drei');
  eq(abschlussStand(st), 'rueckfall', 'Lücke in den Nummern → Rückfall');
}
{
  let st = neueSitzung('abcdefgh');
  st = stueckAngekommen(st, 0, { bis: 4 }); st = stueckErgebnis(st, 0, null, { fehler: 'OpenAI lehnt ab' });
  eq(abschlussStand(st), 'rueckfall', 'gescheitertes Stück → Rückfall, sofort');
  eq(st.fehler, 'OpenAI lehnt ab', 'Fehler gemerkt');
}
{
  let st = neueSitzung('abcdefgh');
  st = stueckAngekommen(st, 0, { bis: 3, letztes: true }); st = stueckErgebnis(st, 0, 'Tschüss.');
  eq(fliesstext(st), 'Tschüss.', 'einziges Stück „Tschüss.“ bleibt');
  st = stueckAngekommen(neueSitzung('abcdefgh'), 0, { bis: 3, letztes: true }); st = stueckErgebnis(st, 0, '');
  eq([abschlussStand(st), fliesstext(st)], ['fertig', ''], 'nur Stille → fertig, leerer Text');
}
eq(transkriptName('2026-11-01-1200-bildschirmaufnahme.webm'), '2026-11-01-1200-bildschirmaufnahme.webm.transkript.txt', 'Transkript-Name neben der Datei');

// ── Dienst mit gespielter Transkription ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-aufn-'));
const gespielt = (antworten, { an = true } = {}) => ({ an, aufrufe: [], async transkribiere(datei, opt) { this.aufrufe.push({ datei, opt, inhalt: fs.existsSync(datei) ? fs.readFileSync(datei, 'utf8') : '' }); const a = antworten.shift(); return typeof a === 'string' ? { ok: true, text: a } : { ok: false, text: '', fehler: 'kaputt' }; } });
const sofort = () => Promise.resolve();
{
  const tr = gespielt(['Erster Satz.', 'Zweiter Satz.']);
  const d = createAufnahmeDienst({ transkription: tr, tmpDir: tmp, warte: sofort });
  const [a, b, c] = await Promise.all([
    d.stueck({ id: 'sitzung01', nr: 0, von: 0, bis: 4, mime: 'audio/webm', daten: Buffer.from('A') }),
    d.stueck({ id: 'sitzung01', nr: 1, von: 4, bis: 9, mime: 'audio/webm', daten: Buffer.from('B') }),
    d.stueck({ id: 'sitzung01', nr: 2, von: 9, bis: 9.5, still: true, letztes: true }),
  ]);
  eq([a.text, b.text, c.text], ['Erster Satz.', 'Zweiter Satz.', ''], 'jedes Stück antwortet mit seinem Text');
  eq(tr.aufrufe.map((x) => x.inhalt), ['A', 'B'], 'genau einmal je Stück transkribiert, stille Stücke nie, in Reihenfolge');
  ok(!fs.readdirSync(tmp).some((n) => n.startsWith('stueck-')), 'Stück-Dateien wieder weg');
  const pfad = path.join(tmp, 'x.webm.transkript.txt');
  const r = await d.abschluss('sitzung01', { video: true, transkriptPfad: pfad });
  eq([r.ok, r.quelle, r.text], [true, 'stuecke', 'Erster Satz. Zweiter Satz.'], 'Abschluss aus den Stücken — kein zweiter Aufruf');
  eq(tr.aufrufe.length, 2, 'Abschluss ruft die Transkription nicht nochmal');
  eq(fs.readFileSync(pfad, 'utf8'), '[00:00] Erster Satz.\n[00:04] Zweiter Satz.\n', 'Bildschirmaufnahme: Transkript mit Zeitmarken neben der Datei');
  eq(d.anzahl, 0, 'Sitzung nach Abschluss weg');
}
{
  const tr = gespielt([null, 'Ganze Datei transkribiert.']);
  const d = createAufnahmeDienst({ transkription: tr, tmpDir: tmp, warte: sofort });
  const s = await d.stueck({ id: 'sitzung02', nr: 0, von: 0, bis: 4, daten: Buffer.from('A'), letztes: true });
  eq(s.ok, false, 'gescheitertes Stück meldet ok:false');
  const datei = path.join(tmp, 'ganz.webm'); fs.writeFileSync(datei, 'GANZ');
  const r = await d.abschluss('sitzung02', { datei, mime: 'audio/webm' });
  eq([r.quelle, r.text], ['datei', 'Ganze Datei transkribiert.'], 'Rückfall: ganze Datei einmal');
  eq(tr.aufrufe[1].inhalt, 'GANZ', 'Rückfall nimmt die fertige Datei');
}
{
  const tr = gespielt(['nie']);
  const d = createAufnahmeDienst({ transkription: tr, tmpDir: tmp, warte: sofort });
  const datei = path.join(tmp, 'ohne.webm'); fs.writeFileSync(datei, 'X');
  const r = await d.abschluss('unbekannt1', { datei });
  eq([r.quelle, r.text], ['datei', 'nie'], 'keine Stücke (Mitschreiben aus) → ganze Datei');
}
{
  const tr = gespielt([], { an: false });
  const d = createAufnahmeDienst({ transkription: tr, tmpDir: tmp, warte: sofort });
  const s = await d.stueck({ id: 'sitzung03', nr: 0, bis: 3, daten: Buffer.from('A'), letztes: true });
  eq([s.ok, s.text, tr.aufrufe.length], [true, '', 0], 'Transkription aus: Stück ok ohne Text, kein Aufruf');
  const r = await d.abschluss('sitzung03', {});
  eq([r.ok, r.text, r.fehler || ''], [true, '', ''], 'Transkription aus: Abschluss ok ohne Text, ohne Fehler');
}
{
  let t = 0;
  const tr = gespielt([]);
  const d = createAufnahmeDienst({ transkription: tr, tmpDir: tmp, jetzt: () => t, warte: async () => { t += 1000; } });
  await d.stueck({ id: 'sitzung04', nr: 0, bis: 3, still: true }); // letztes Stück kommt nie
  const r = await d.abschluss('sitzung04', { maxMs: 5000 });
  ok(r.quelle === 'keine' && t >= 5000, 'Abschluss wartet nicht ewig auf ein verlorenes Stück');
  t = 10 * 3600_000; await d.stueck({ id: 'sitzung05', nr: 0, bis: 1, still: true });
  t += 2 * 3600_000; eq(d.aufraeumen(), 1, 'verwaiste Sitzung nach einer Stunde weg');
}

// ── Transkription: Fehlerpfade ohne Schlüssel, OpenAI per fetch, Rückfall lokal ──
const datei = path.join(tmp, 'ton.webm'); fs.writeFileSync(datei, Buffer.from('ton'));
{
  const t = createTranskription({ env: {}, tmpDir: tmp, finde: () => '', ffmpeg: false, fetchImpl: () => { throw new Error('darf nicht'); } });
  const r = await t.transkribiere(datei);
  eq([r.ok, t.an, t.stand().weg], [false, false, 'aus'], 'ohne Schlüssel und Kommando: aus, kein Aufruf');
  ok(/OPENAI_API_KEY/.test(r.fehler), 'Fehler sagt, wie man einschaltet');
  ok(!('schluessel' in t.stand()) && !JSON.stringify(t.stand()).includes('sk-'), 'Stand verrät keinen Schlüssel');
}
{
  const aufrufe = [];
  const fetchImpl = async (url, o) => { aufrufe.push({ url, o }); return { ok: true, status: 200, json: async () => ({ text: ' Hallo Welt. ' }) }; };
  const t = createTranskription({ env: { OPENAI_API_KEY: 'sk-test-123', FC_TRANSKRIPTION_SPRACHE: 'de' }, tmpDir: tmp, finde: () => '', ffmpeg: false, fetchImpl });
  const r = await t.transkribiere(datei, { mime: 'audio/ogg' });
  eq([r.ok, r.text, r.weg], [true, 'Hallo Welt.', 'openai'], 'OpenAI: Text kommt getrimmt zurück');
  eq(aufrufe[0].url, OPENAI_URL, 'richtige Adresse');
  eq(aufrufe[0].o.headers.authorization, 'Bearer sk-test-123', 'Schlüssel nur im Kopf');
  const f = aufrufe[0].o.body;
  eq([f.get('model'), f.get('language'), f.get('file').name], [OPENAI_MODELL, 'de', 'audio.ogg'], 'Modell, Sprache, Dateiname mit Endung');
  eq(t.stand().modell, 'gpt-4o-mini-transcribe', 'Standardmodell');
}
{
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid key sk-test-999' });
  const t = createTranskription({ env: { OPENAI_API_KEY: 'sk-test-999' }, tmpDir: tmp, finde: () => '', ffmpeg: false, fetchImpl });
  const r = await t.transkribiere(datei);
  ok(!r.ok && /401/.test(r.fehler) && !r.fehler.includes('sk-test-999'), 'falscher Schlüssel: klare Meldung, Schlüssel nie im Fehlertext');
}
{
  const skript = path.join(tmp, 'mein-stt.sh');
  fs.writeFileSync(skript, '#!/bin/sh\necho "Lokal erkannt: $(basename "$1")"\n'); fs.chmodSync(skript, 0o755);
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
  const t = createTranskription({ env: { OPENAI_API_KEY: 'k', FC_WHISPER_CMD: `${skript} {datei}` }, tmpDir: tmp, finde: (n) => (n === skript ? skript : ''), ffmpeg: false, fetchImpl });
  eq(t.stand().wege, ['openai', 'lokal'], 'Schlüssel + eigenes Kommando → beide Wege');
  const r = await t.transkribiere(datei);
  eq([r.ok, r.weg, r.text], [true, 'lokal', 'Lokal erkannt: ton.webm'], 'OpenAI fällt aus → lokal übernimmt (ohne ffmpeg: Originaldatei)');
}
{
  const fetchImpl = async () => { throw new Error('Netz weg'); };
  const t = createTranskription({ env: { OPENAI_API_KEY: 'k' }, tmpDir: tmp, finde: () => '', ffmpeg: false, fetchImpl });
  const r = await t.transkribiere(datei);
  ok(!r.ok && /Netz weg/.test(r.fehler), 'Netzfehler wird gemeldet, nichts wirft');
  const fehlt = await t.transkribiere(path.join(tmp, 'gibtsnicht.webm'));
  ok(!fehlt.ok && /Datei fehlt/.test(fehlt.fehler), 'fehlende Datei wird gemeldet');
}

// ── Ablage: Transkript als Beiwerk ──
{
  const dir = path.join(tmp, 'ablage'); fs.mkdirSync(dir);
  const n = '2026-11-01-1200-bildschirmaufnahme.webm';
  fs.writeFileSync(path.join(dir, n), 'video'); fs.writeFileSync(path.join(dir, n + '.meta'), JSON.stringify({ typ: 'video' }));
  eq(transkriptFuer(n, dir), {}, 'ohne Transkript keine Felder');
  fs.writeFileSync(path.join(dir, transkriptName(n)), '[00:00] Hallo\n');
  ok(istSidecar(transkriptName(n)), 'Transkript ist Beiwerk');
  const l = ablageListe({ ablageDir: dir }).eintraege;
  eq(l.length, 1, 'Transkript erscheint nicht als eigener Eintrag');
  eq(l[0].transkript_url, '/api/ablage/' + n + '.transkript.txt', 'Eintrag trägt den Transkript-Link');
  eq(l[0].transkript_pfad, path.join(dir, transkriptName(n)), 'und den Pfad fürs Fenster');
  ablageLoeschen(n, { ablageDir: dir });
  ok(!fs.existsSync(path.join(dir, transkriptName(n))), 'Löschen nimmt das Transkript mit');
}

// ── Sprachnachricht als Antwort auf eine Rückfrage: das Transkript ist die Antwort, der Pfad steht dahinter ──
{
  const dialog = { art: 'frage', optionen: [{ nr: 1, label: 'Blau' }, { nr: 2, label: 'Rot' }, { nr: 3, label: 'Type something.' }], cursor: 1 };
  const b = chatBefehl('Lieber grün, wie im Logo.', { dialog });
  eq([b.art, b.nr, b.text], ['freitext', 3, 'Lieber grün, wie im Logo.'], 'Transkript als Nachricht → Freitext-Antwort ins Antwortfeld');
  eq(markerAufloesen(b.text + ' [voice:ab12.webm|Sprachnachricht.webm]', '/daten/media'), 'Lieber grün, wie im Logo. [Sprachnachricht: /daten/media/ab12.webm (Sprachnachricht.webm)]', 'im Antwortfeld: erst der Text, dann der Pfad');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

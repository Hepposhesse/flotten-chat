// server/konsole.mjs — „Konsole im Chat“, die Runde (v1.2).
//
// Jede Sekunde je registriertem Fenster (entfernte Orte jede dritte, außer es arbeitet oder ein Dialog ist offen),
// dazu sofort, wenn das Sitzungs-Protokoll eines lokalen Fensters wächst (Protokoll-Horcher) oder eine Nachricht kommt:
//   1. Terminalbild lesen → Modus, Dialog (Freigabe/Rückfrage), beschäftigt?
//   2. Neue Zeilen des Sitzungs-Protokolls → Chat-Beiträge (Antworten, Sperren, „im Fenster beantwortet“)
//   3. Ein neu erschienener Dialog → Chat-Nachricht mit Knöpfen (typ 'question', meta.dialog)
//   4. Neue Chat-Nachrichten des Menschen → ins Fenster tippen (Text), oder als Wahl/Esc/Modus/Mehrfach-Schritt ausführen
// Das Fenster selbst kennt den Chat nicht. Es antwortet im Terminal — wir spiegeln.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { senden, nachrichten, fensterAlle, fensterAendern, metaSetzen, nowIso } from './db.mjs';
import { paneZustand, paneFingerabdruck, dialogFussSichtbar, geheimMaske, nackteZahlOhneDialog, dialogAbgeschnitten, tastenFuerWahl, mehrfachSchritte, tastenZuOption, chatBefehl, spiegelBeitraege, dialogText, dialogMeta, fragePasst, textVorDialog, textSchluessel, medienZerlegen, spiegelStart, ganzeZeilen, protokollNachrichten, zustellText, markerAufloesen, neueZustellungen, MODUS_NAME } from './protokoll.mjs';
import { prozessVon, paneLesen, paneVerlaufLesen, fensterVergroessern, fensterZurueck, tastenSenden, textSenden, textTippen, laufendesProtokoll, dateiAb, istSsh } from './orte.mjs';
import { lampenStand } from './lampen.mjs';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', webm: 'video/webm', mp4: 'video/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf' };

// ── Anstoß + Protokoll-Horcher (1.2) ── Zeitgeber/Watcher injiziert, damit die Logik ohne Dateisystem testbar ist.
/** Nachlauf nach einem Anstoß (ms): sofort, dann noch zweimal — das Terminal zeichnet den Dialog oft erst kurz nach der Protokollzeile. */
export const NACHLAUF_MS = [30, 300, 900];
/** Viele Anstöße kurz hintereinander → nur EIN Satz Runden. lauf() = eine Runde (sperrt selbst). */
export function createAnstoss({ lauf, nachlauf = NACHLAUF_MS, setze = (fn, ms) => setTimeout(fn, ms) }) {
  const offen = new Set();
  return {
    anstossen() {
      for (const ms of nachlauf) {
        if (offen.has(ms)) continue; // diese Stufe steht schon an — nicht stapeln
        offen.add(ms);
        const t = setze(() => { offen.delete(ms); lauf(); }, ms);
        if (t && t.unref) t.unref();
      }
    },
    get anstehend() { return offen.size; },
  };
}
/** Genau ein Watcher je Protokolldatei: sync(dateien) jede Runde — neue bekommen einen, verschwundene verlieren ihn. */
export function createHorcher({ beobachte, beiAenderung }) {
  const aktiv = new Map();
  return {
    sync(dateien = []) {
      const soll = new Set(dateien.filter(Boolean));
      for (const [d, w] of aktiv) if (!soll.has(d)) { try { w.close(); } catch { /* egal */ } aktiv.delete(d); }
      for (const d of soll) {
        if (aktiv.has(d)) continue;
        try { aktiv.set(d, beobachte(d, () => beiAenderung(d))); } catch { aktiv.set(d, { close() {} }); } // nicht jede Runde neu versuchen
      }
    },
    stop() { for (const w of aktiv.values()) { try { w.close(); } catch { /* egal */ } } aktiv.clear(); },
    get anzahl() { return aktiv.size; },
  };
}
/** Was am Fenster-Zustand die Oberfläche sofort wissen muss (Dialog auf/zu, Modus, läuft, Lampe). PURE. */
export const zustandsSchluessel = (z) => (z ? `${z.modus}|${z.dialog ? `${z.dialog.art}:${z.kennung || ''}` : '-'}|${!!z.lebt}|${z.lampe || ''}` : '');

export function starteKonsole({ db, dataDir, broadcast = () => {}, log = console, taktMs = 1000, fernJeder = 3, horchen = true } = {}) {
  const mediaDir = path.join(dataDir, 'media');
  const werkzeuge = new Map();   // fenster → Map(werkzeugId → {werkzeug, text})
  const zustaende = {};          // fenster → {modus, dialog, busy, lebt}
  const gehalten = {};           // fenster → [Nachrichten, die auf einen Dialog warten]
  const fragen = {};             // fenster → Map(frageId → {fragen}) — die offene AskUserQuestion aus dem Protokoll
  const abgeschnitten = {};      // fenster → {zustand, fp, ms, unbekanntFp} — Dialog, der im kleinen Fenster oben abgeschnitten ist
  const lampen = {};             // fenster → Lampen-Stand (1.1): beschaeftigt/bereit/aus/tot + busy-Beginn
  const fragenVon = (f) => fragen[f.name] || (fragen[f.name] = new Map());
  const letzteFrage = (f) => { const m = fragenVon(f); return m.size ? [...m.values()].pop() : null; };
  /** Antwort-Text merken (letzte 12 Schlüssel); false = schon gepostet (z. B. als Text vor einer Rückfrage). */
  function merkeText(sp, text) {
    const k = textSchluessel(text);
    if (!k) return true;
    const liste = Array.isArray(sp.gepostet) ? sp.gepostet : [];
    if (liste.includes(k)) return false;
    sp.gepostet = [...liste, k].slice(-12);
    return true;
  }
  let laeuft = false;
  let nochmal = false;           // Anstoß kam während einer Runde → direkt danach noch eine
  let takte = 0;
  const protokolle = new Map();  // fenster → laufende Protokolldatei (nur lokale Fenster, für den Horcher)

  /** Medien-Marker aus einer Fenster-Antwort ins Chat-Medienarchiv übernehmen (nur lokale Ordner). */
  function medienUebernehmen(f, medien = []) {
    const raus = [];
    for (const m of medien) {
      if (istSsh(f) || !m.pfad || !m.pfad.startsWith('/')) continue;
      try {
        const ext = path.extname(m.pfad).toLowerCase().replace('.', '');
        const id = crypto.randomBytes(9).toString('hex') + (ext ? '.' + ext : '');
        fs.copyFileSync(m.pfad, path.join(mediaDir, id));
        const mime = MIME[ext] || 'application/octet-stream';
        db.prepare('INSERT INTO media (id, name, mime, groesse, erstellt_am) VALUES (?, ?, ?, ?, ?)').run(id, (m.name || path.basename(m.pfad)).slice(0, 200), mime, fs.statSync(path.join(mediaDir, id)).size, nowIso());
        raus.push({ id, url: '/api/media/' + id, name: m.name || path.basename(m.pfad), mime });
      } catch { /* Datei nicht lesbar — Text bleibt */ }
    }
    return raus;
  }

  function chatSchreiben(f, { typ = 'fyi', text, media = null, meta = null, bezug_id = null }) {
    // Nie Passwörter/Token aus dem Terminal in den Chat (Freigaben zeigen den ganzen Befehl).
    const m = senden(db, { kanal: f.name, von: f.label || f.name, typ, inhalt: geheimMaske(text), media, meta, bezug_id });
    if (m) broadcast('message', m);
    return m;
  }

  /** Schritt 2: neue Protokoll-Zeilen spiegeln. */
  function spiegeln(f, sp, jetztMs) {
    const prot = laufendesProtokoll(f);
    if (!prot) return sp;
    if (!istSsh(f)) protokolle.set(f.name, prot.datei);
    const neu = spiegelStart(sp, prot, { jetztMs });
    if (!neu.sitzung) return neu;
    const { roh } = dateiAb(f, prot.datei, neu.offset || 0);
    if (roh) {
      const { zeilen, verbraucht } = ganzeZeilen(roh);
      if (zeilen.length) {
        if (!werkzeuge.has(f.name)) werkzeuge.set(f.name, new Map());
        const beitraege = spiegelBeitraege(protokollNachrichten(zeilen, { ohneZustellung: true }), { werkzeuge: werkzeuge.get(f.name), offeneFragen: fragenVon(f) });
        for (const b of beitraege) {
          if (b.frageId && neu.wahlViaChat) { neu.wahlViaChat = false; continue; }
          if (b.typ === 'answer' && !merkeText(neu, b.text)) continue; // stand schon als Text vor einer Rückfrage im Chat
          const media = b.medien && b.medien.length ? medienUebernehmen(f, b.medien) : null;
          chatSchreiben(f, { typ: b.typ, text: b.text, media: media && media.length ? media : null });
        }
      }
      neu.offset = (neu.offset || 0) + verbraucht;
    }
    return neu;
  }

  /** Karte einer Rückfrage/Freigabe schließen (Knöpfe aus, „✔ beantwortet“). */
  function karteZu(id) {
    if (!id) return;
    try { const alt = db.prepare('SELECT meta FROM messages WHERE id = ?').get(id); const meta = alt && alt.meta ? JSON.parse(alt.meta) : {}; if (meta.dialog && !meta.dialog.zu) { meta.dialog.zu = true; const m = metaSetzen(db, id, meta); broadcast('message_update', m); } } catch { /* egal */ }
  }

  /** Schritt 3: Dialog einmal je Erscheinen in den Chat, mit Knöpfen. */
  function dialogSpiegeln(f, sp, zustand, jetztMs) {
    const d = zustand.dialog;
    if (!d) {
      // Erst nach 1,5 s ohne Dialog als „zu“ werten: ein einzelnes Bild ohne Dialog (Neuzeichnen) machte sonst aus
      // derselben Rückfrage eine zweite Karte.
      if (!sp.ohneDialogSeit) sp.ohneDialogSeit = jetztMs;
      if (jetztMs - sp.ohneDialogSeit < 1500) return;
      karteZu(sp.dialogMsg); // Dialog ist zu → Knöpfe der Karte aus
      if (sp.dialogKennung) sp.letzteFrageZuMs = jetztMs;
      sp.dialogKennung = ''; sp.dialogMsg = 0; sp.halteHinweis = 0; sp.dialogWartet = ''; sp.letzterDialogText = ''; return;
    }
    sp.ohneDialogSeit = 0;
    if (d.kennung === sp.dialogKennung) return;
    // Rückfrage: die ganze Frage steht im Protokoll. Ist sie noch nicht da, EINE Runde warten — danach notfalls
    // das Terminalbild, damit nichts hängt.
    const frage = letzteFrage(f);
    const passt = fragePasst(d, frage);
    if (d.art === 'frage' && !passt && sp.dialogWartet !== d.kennung) { sp.dialogWartet = d.kennung; return; }
    sp.dialogKennung = d.kennung; sp.halteHinweis = 0; sp.dialogWartet = '';
    // Gleicher Kartentext binnen 2 min = dieselbe Rückfrage, nur neu gezeichnet (andere Kennung) → keine zweite Karte.
    const dtRoh = dialogText(d, passt ? frage : null);
    if (sp.letzterDialogText === dtRoh && jetztMs - (sp.letzterDialogMs || 0) < 120_000) return;
    karteZu(sp.dialogMsg); // eine neue Rückfrage schließt die vorige Karte — Knöpfe gibt es nur für den offenen Dialog
    // Der Text über dem Dialog (Erklärung, Bilder) kommt erst nach der Antwort ins Protokoll — also aus dem
    // Terminal mit Verlauf holen und VOR der Karte posten. Auch vor Freigaben (was das Fenster vorhat).
    if (d.art === 'frage' || d.art === 'freigabe') {
      const vorher = textVorDialog(paneVerlaufLesen(f));
      if (vorher && merkeText(sp, vorher)) {
        const z = medienZerlegen(vorher);
        const media = z.medien.length ? medienUebernehmen(f, z.medien) : null;
        chatSchreiben(f, { typ: 'answer', text: z.text || vorher, media: media && media.length ? media : null });
      }
    }
    // Bilder in der Frage („[Bild: …/x.png]“) als Medien an der Karte, nicht als roher Pfad.
    const z = medienZerlegen(dtRoh);
    const media = z.medien.length ? medienUebernehmen(f, z.medien) : null;
    const m = chatSchreiben(f, { typ: 'question', text: z.medien.length ? z.text : dtRoh, media: media && media.length ? media : null, meta: { dialog: dialogMeta(d, passt ? frage : null) } });
    sp.dialogMsg = m ? m.id : 0;
    if (m) { sp.letzterDialogText = dtRoh; sp.letzterDialogMs = jetztMs; }
  }

  const halten = (f, m) => { (gehalten[f.name] = gehalten[f.name] || []).push(m); };
  function nachliefern(f, zustand) {
    const liste = gehalten[f.name];
    if (!liste || !liste.length || zustand.dialog) return;
    while (liste.length) { const m = liste[0]; if (!textSenden(f, zustellText(m)).ok) break; liste.shift(); }
  }

  /** Text einer Nachricht samt Anhängen als lesbare Pfade (lokale Fenster lesen die Datei selbst). */
  function mitAnhaengen(m, text = m.inhalt) {
    let t = String(text || '');
    let liste = []; try { liste = m.media ? (typeof m.media === 'string' ? JSON.parse(m.media) : m.media) : []; } catch { liste = []; }
    for (const x of Array.isArray(liste) ? liste : []) { const art = /^image\//.test(x.mime || '') ? 'bild' : /^video\//.test(x.mime || '') ? 'video' : /^audio\//.test(x.mime || '') ? 'voice' : 'datei'; t += ` [${art}:${x.id}|${x.name || ''}]`; }
    return markerAufloesen(t, mediaDir);
  }
  const hatAnhang = (m) => { try { const l = m.media ? (typeof m.media === 'string' ? JSON.parse(m.media) : m.media) : []; return Array.isArray(l) && l.length > 0; } catch { return false; } };

  /** Schritt 4: eine Chat-Nachricht des Menschen im Fenster ausführen. */
  async function ausfuehren(f, m, zustand, sp) {
    const befehl = chatBefehl(m.inhalt, { ...zustand, frage: letzteFrage(f) });
    // Antwort auf einen Dialog → ein gemerktes (vergrößertes) Bild ist danach veraltet; die nächste Runde liest frisch.
    if (['wahl', 'mehrfach', 'freitext'].includes(befehl.art)) delete abgeschnitten[f.name];
    // Anhänge (Sprachnachricht, Bild) gehen nie verloren: im Antwortfeld, im Zusatz nach der Wahl, im gehaltenen Text —
    // überall mit Pfad. Eine Sprachnachricht als Antwort auf eine Rückfrage kommt so als Datei-Pfad im Antwortfeld an.
    if (hatAnhang(m) && befehl.art === 'wahl' && !befehl.nachtext) befehl.nachtext = ' ';
    if (befehl.art === 'text') {
      // Nackte Zahl kurz nach einer geschlossenen Rückfrage war für die alte Karte gemeint — nicht ins Fenster tippen.
      if (!hatAnhang(m) && nackteZahlOhneDialog(m.inhalt, zustand, sp.letzteFrageZuMs, Date.now())) {
        chatSchreiben(f, { text: `↳ Die Rückfrage ist schon zu — deine „${String(m.inhalt).trim()}“ habe ich nicht ins Fenster getippt. Schreib einen Satz, wenn du etwas sagen willst.`, bezug_id: m.id });
        return true;
      }
      return textSenden(f, zustellText({ ...m, inhalt: mitAnhaengen(m) })).ok;
    }
    if (befehl.art === 'wahl') {
      const tasten = tastenFuerWahl(befehl.nummern, zustand.dialog.cursor, zustand.dialog.optionen.length);
      if (!tastenSenden(f, tasten).ok) return false;
      if (zustand.dialog.art !== 'freigabe') sp.wahlViaChat = true;
      // Absenden-Karte: die Bestätigung auf Deutsch („Absenden" statt „Submit answers").
      const deutsch = zustand.dialog.art === 'absenden' ? { 1: 'Absenden', 2: 'Abbrechen' } : {};
      const labels = befehl.nummern.map((n) => { const o = zustand.dialog.optionen.find((x) => x.nr === n); return o ? `${n} „${deutsch[n] || o.label}"` : String(n); });
      if (befehl.nachtext) halten(f, { ...m, inhalt: mitAnhaengen(m, befehl.nachtext.trim()) });
      chatSchreiben(f, { typ: 'fyi', text: `↳ Auswahl ${labels.join(', ')} ins Fenster gegeben.${befehl.nachtext ? (befehl.nachtext.trim() ? ' Dein Zusatz folgt, sobald der Dialog zu ist.' : ' Dein Anhang folgt, sobald der Dialog zu ist.') : ''}`, bezug_id: m.id });
      return true;
    }
    if (befehl.art === 'mehrfach') {
      // Ein Mehrfachauswahl-Schritt komplett: Haken setzen/wegnehmen, eigene Antwort tippen (ohne Enter), „Next".
      for (const s of mehrfachSchritte(zustand.dialog, befehl)) {
        const r = s.text ? textTippen(f, s.text) : tastenSenden(f, s.tasten);
        if (!r.ok) return false;
        await warte(250);
      }
      sp.wahlViaChat = true;
      const labels = befehl.nummern.map((n) => { const o = zustand.dialog.optionen.find((x) => x.nr === n); return o ? `${n} „${o.label}"` : String(n); });
      const frei = befehl.text ? `eigene Antwort „${String(befehl.text).replace(/\s+/g, ' ').trim().slice(0, 160)}"` : '';
      const was = [labels.join(', '), frei].filter(Boolean).join(' + ');
      chatSchreiben(f, { typ: 'fyi', text: `↳ ${was ? `Angehakt: ${was}` : befehl.text === null ? 'Auswahl wie im Fenster' : 'Nichts angehakt'} — weiter zum nächsten Schritt.`, bezug_id: m.id });
      return true;
    }
    if (befehl.art === 'freitext') {
      // Der Text ist die Antwort: Cursor aufs Antwortfeld („Type something."), Text tippen, Enter.
      const tasten = tastenZuOption(befehl.nr, zustand.dialog.cursor, zustand.dialog.optionen.length);
      if (tasten.length) { if (!tastenSenden(f, tasten).ok) return false; await warte(300); }
      if (!textSenden(f, mitAnhaengen(m, befehl.text)).ok) return false;
      sp.wahlViaChat = true;
      chatSchreiben(f, { text: `↳ Deine Antwort ist im Antwortfeld abgeschickt: „${String(befehl.text).replace(/\s+/g, ' ').trim().slice(0, 160)}"`, bezug_id: m.id });
      return true;
    }
    if (befehl.art === 'abbruch') { const r = tastenSenden(f, ['Escape']); if (r.ok) chatSchreiben(f, { text: '↳ Dialog abgebrochen (Esc).', bezug_id: m.id }); return r.ok; }
    if (befehl.art === 'abbruch_text') {
      if (!tastenSenden(f, ['Escape']).ok) return false;
      await warte(700);
      const s = textSenden(f, zustellText({ ...m, inhalt: mitAnhaengen(m) }));
      if (s.ok) chatSchreiben(f, { text: '↳ Dialog abgebrochen, deine Nachricht ist im Fenster.', bezug_id: m.id });
      return s.ok;
    }
    if (befehl.art === 'halten') {
      halten(f, { ...m, inhalt: mitAnhaengen(m) });
      if (!sp.halteHinweis) { sp.halteHinweis = Number(m.id); chatSchreiben(f, { text: '⏸ Deine Nachricht wartet, bis die Rückfrage beantwortet ist — antworte mit der Nummer oder „nein".', bezug_id: m.id }); }
      return true;
    }
    if (befehl.art === 'modus') {
      let modus = zustand.modus;
      const lesen = () => paneZustand(paneLesen(f)).modus;
      for (let k = 0; k < 5 && modus !== befehl.ziel; k++) {
        const vorher = modus;
        if (!tastenSenden(f, ['BTab']).ok) return false;
        for (let w = 0; w < 6; w++) { await warte(250); modus = lesen(); if (modus !== vorher && modus !== 'unbekannt') break; }
      }
      for (let w = 0; w < 8 && modus !== befehl.ziel; w++) { await warte(250); modus = lesen(); }
      const name = MODUS_NAME[modus] || modus;
      chatSchreiben(f, { text: modus === befehl.ziel ? `↳ Fenster steht jetzt auf ${name}${modus === 'default' ? ' — es fragt bei Freigaben nach.' : '.'}` : `↳ Umschalten hat nicht geklappt, das Fenster steht auf ${name || 'unbekannt'}.`, bezug_id: m.id });
      return true;
    }
    return false;
  }

  async function runde() {
    if (laeuft) { nochmal = true; return; } laeuft = true;
    try {
      const jetztMs = Date.now();
      takte++;
      const alle = fensterAlle(db);
      for (const n of Object.keys(lampen)) if (!alle.some((f) => f.name === n)) delete lampen[n]; // geschlossenes Fenster: kein alter Lampen-Stand für einen neuen Namensvetter
      for (const n of [...protokolle.keys()]) if (!alle.some((f) => f.name === n)) protokolle.delete(n);
      for (const f of alle) {
        // Entfernte Orte (ssh/Gerät) gehen über ssh: nur jede dritte Runde — außer es arbeitet oder ein Dialog ist offen.
        if (istSsh(f) && takte % fernJeder) { const z = zustaende[f.name]; if (!(z && (z.dialog || z.busy))) continue; }
        let sp = {}; try { sp = JSON.parse(f.spiegel || '{}') || {}; } catch { sp = {}; }
        const p = prozessVon(f);
        const pane = p.lebt ? paneLesen(f) : '';
        // Ordner-Vertrauensfrage von Claude Code („Is this a project you trust?“): der Mensch hat das Fenster
        // bewusst hier angelegt — wir bestätigen einmalig und sagen es im Kanal.
        if (p.lebt && /project you created or one you trust/i.test(pane) && /❯\s*No, exit/.test(pane)) {
          tastenSenden(f, ['Down', 'Enter']);
          chatSchreiben(f, { typ: 'system', text: '🔓 Ordner als vertrauenswürdig bestätigt (Claude Code fragt das einmal je Ordner).' });
          continue;
        }
        // Dialog oben abgeschnitten (80×24 ohne angehängten Bildschirm) → kurz vergrößern, lesen, zurück; den
        // gelesenen Dialog merken, solange er im kleinen Fenster abgeschnitten bleibt (höchstens alle 30 s).
        // Der gemerkte Dialog gilt nur, solange das kleine Bild gleich aussieht (Fingerabdruck) — sonst blieb bei einer
        // Rückfrage mit mehreren Reitern Reiter 1 gemerkt und die Zahl im Chat traf alte Optionen.
        let gemerkt = null;
        if (p.lebt && dialogAbgeschnitten(pane)) {
          const fp = paneFingerabdruck(pane);
          let a = abgeschnitten[f.name];
          if (a && a.zustand && a.fp !== fp) { a = abgeschnitten[f.name] = { ms: 0 }; }
          if (a && a.zustand) gemerkt = a.zustand;
          else if (a && a.unbekanntFp === fp) { /* dasselbe unlesbare Bild — nicht alle 30 s neu vergrößern */ }
          else if (!a || jetztMs - a.ms > 30_000) {
            a = abgeschnitten[f.name] = { ms: jetztMs };
            fensterVergroessern(f); await warte(1200);
            const gross = paneLesen(f);
            const z = paneZustand(gross);
            if (z.dialog) { a.zustand = z; a.fp = fp; gemerkt = z; }
            else if (dialogFussSichtbar(gross)) a.unbekanntFp = fp; // auch groß kein lesbarer Dialog: nicht immer wieder versuchen
            fensterZurueck(f);
          }
        } else delete abgeschnitten[f.name];
        const zustand = gemerkt || paneZustand(pane);
        // Ein Hintergrund-Agent/Schwarm zählt als beschäftigt (das Bild zeigt dann keine Klammer-Zeit).
        const lampe = (lampen[f.name] = lampenStand(lampen[f.name], { lebt: p.lebt, busy: zustand.busy || !!zustand.hintergrund, registryStatus: f.status, jetztMs }));
        const altZ = zustaende[f.name];
        zustaende[f.name] = { lebt: p.lebt, gestartetMs: p.gestartetMs, modus: zustand.modus, busy: zustand.busy, hintergrund: !!zustand.hintergrund, lampe: lampe.lampe, busy_sekunden: lampe.busy_sekunden, kennung: (zustand.dialog && zustand.dialog.kennung) || '', dialog: zustand.dialog ? { art: zustand.dialog.art, titel: zustand.dialog.titel, optionen: zustand.dialog.optionen } : null };
        // Dialog auf/zu, Modus, Lampe gewechselt → Oberfläche sofort wecken (Kanal-Kopf, Karten), nicht erst im Takt.
        if (zustandsSchluessel(altZ) !== zustandsSchluessel(zustaende[f.name])) broadcast('presence', { fenster: f.name, zustand: true });
        const status = p.lebt ? 'laeuft' : (f.status === 'schliesst' ? 'schliesst' : 'aus');
        if (status !== f.status || (p.lebt && !f.gestartet_am)) { fensterAendern(db, f.name, { status, gestartet_am: p.lebt ? new Date(p.gestartetMs || jetztMs).toISOString() : null }); broadcast('presence', { fenster: f.name, status }); }
        if (p.lebt) {
          try { sp = spiegeln(f, sp, jetztMs); } catch (e) { log.error(`[konsole] ${f.name} spiegeln:`, e && e.message); }
          try { dialogSpiegeln(f, sp, zustand, jetztMs); } catch (e) { log.error(`[konsole] ${f.name} dialog:`, e && e.message); }
          try { nachliefern(f, zustand); } catch { /* egal */ }
        } else if (sp.dialogMsg) { karteZu(sp.dialogMsg); sp.dialogMsg = 0; sp.dialogKennung = ''; } // Fenster weg → seine Karte hat keine Knöpfe mehr
        // Zustellung: neue Nachrichten des Menschen (nicht die eigenen Spiegel-Beiträge).
        const msgs = nachrichten(db, { kanal: f.name, seit: f.cursor || 0, limit: 50 });
        const r = neueZustellungen(msgs, f.cursor || 0, { jetztMs, eigeneNamen: [f.label || f.name, f.name, 'flottenchat'] });
        let cursor = f.cursor || 0;
        if (!f.cursor && msgs.length) { cursor = r.cursor; } // erster Lauf: Stand einfrieren, nichts nachliefern
        else if (r.zustellen.length && p.lebt) {
          let aktuell = zustand;
          for (const m of r.zustellen) {
            let ok = false;
            try { ok = await ausfuehren(f, m, aktuell, sp); } catch (e) { log.error(`[konsole] ${f.name} #${m.id}:`, e && e.message); }
            if (!ok) break;
            cursor = Number(m.id);
            if (r.zustellen.length > 1) { await warte(600); aktuell = paneZustand(paneLesen(f)); }
          }
          if (cursor === r.zustellen[r.zustellen.length - 1].id) cursor = Math.max(cursor, r.cursor);
        } else if (!r.zustellen.length) cursor = Math.max(cursor, r.cursor);
        fensterAendern(db, f.name, { cursor, spiegel: sp });
      }
      // Protokoll-Horcher: jede neue Zeile im Sitzungs-Protokoll eines lokalen Fensters löst sofort eine Runde aus.
      if (horchen) { try { horcher.sync([...protokolle.values()]); } catch { /* der Takt läuft weiter */ } }
    } finally { laeuft = false; if (nochmal) { nochmal = false; setImmediate(() => runde().catch(() => {})); } }
  }
  const anstoss = createAnstoss({ lauf: () => { runde().catch(() => {}); } });
  const horcher = createHorcher({ beobachte: (d, cb) => fs.watch(d, { persistent: false }, cb), beiAenderung: () => anstoss.anstossen() });
  // Der Takt stapelt nicht: läuft noch eine Runde, fällt er aus (nur Anstöße merken „nochmal“).
  const t = setInterval(() => { if (!laeuft) runde().catch((e) => log.error('[konsole]', e && e.message)); }, taktMs);
  t.unref();
  runde().catch(() => {});
  return {
    stop: () => { clearInterval(t); horcher.stop(); },
    zustand: (name) => zustaende[name] || null,
    runde,
    /** Sofort (+ Nachlauf) eine Runde — z. B. wenn eine Chat-Nachricht für ein Fenster kam. */
    anstossen: () => anstoss.anstossen(),
  };
}

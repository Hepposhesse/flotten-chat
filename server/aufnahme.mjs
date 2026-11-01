// server/aufnahme.mjs — Mitschreiben beim Aufnehmen (v1.3): Sprachnachricht und Bildschirmaufnahme.
//
// Der Browser nimmt wie immer die ganze Datei auf. Daneben läuft ein zweiter, reiner Ton-Rekorder, der an Sprechpausen
// (spätestens alle 15 s, bei ⏸ und beim Stopp) neu ansetzt — jedes Stück ist so eine vollständige kleine Datei, die ohne
// ffmpeg direkt transkribiert werden kann. Die Stücke gehen sofort an POST /api/aufnahme/stueck, jedes wird GENAU EINMAL
// transkribiert; die Antwort trägt den Text gleich mit. Beim Stopp wartet /api/aufnahme/<id>/abschluss nur noch auf die
// offenen Stücke und setzt zusammen: Fließtext für die Sprachnachricht, „[mm:ss] …“-Zeilen für die Bildschirmaufnahme.
// Fehlt ein Stück oder scheitert eins, wird die fertige Datei einmal am Stück transkribiert (Rückfall).
//
// Oben die reinen Regeln (Zustand einer Sitzung, Zusammensetzen), unten der Dienst (Warteschlange, Dateien, Aufräumen).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stueckSauber, endeFuellsel, textMitZeit } from './transkription.mjs';

export const MAX_STUECKE = 2000;           // 2000 × ≤ 20 s ≈ 11 h — mehr nimmt niemand am Stück auf
export const STUECK_MAX_BYTES = 25 * 1024 * 1024;
export const ARTEN = ['sprache', 'bildschirm'];
export const TRANSKRIPT_ENDUNG = '.transkript.txt';

// ── rein ────────────────────────────────────────────────────────────────────
/** Kennung vom Browser: 8–40 Zeichen a–z0–9. PURE. */
export const kennungGueltig = (id) => /^[a-z0-9]{8,40}$/.test(String(id || ''));
/** Stücknummer: ganze Zahl 0…MAX_STUECKE-1, sonst null. PURE. */
export function nrGueltig(nr) { const n = Number(nr); return String(nr ?? '').trim() !== '' && Number.isInteger(n) && n >= 0 && n < MAX_STUECKE ? n : null; }
/** Sekundenangabe aus der URL (≥ 0, auf 1/100 gerundet). PURE. */
export const sekunden = (x) => Math.max(0, Math.round((Number(x) || 0) * 100) / 100);

export function neueSitzung(id, { art = 'sprache', jetztMs = 0 } = {}) {
  return { id: String(id), art: ARTEN.includes(art) ? art : 'sprache', begonnenMs: jetztMs, zuletztMs: jetztMs, stuecke: {}, letzteNr: null, fehler: '' };
}

/** Stück ist angekommen (läuft). `letztes` = das Reststück beim Stopp → legt die letzte Nummer fest. PURE. */
export function stueckAngekommen(st, nr, { von = 0, bis = 0, letztes = false, jetztMs = st.zuletztMs } = {}) {
  return { ...st, zuletztMs: jetztMs, stuecke: { ...st.stuecke, [nr]: { status: 'laeuft', von: sekunden(von), bis: sekunden(bis), text: '' } }, letzteNr: letztes ? nr : st.letzteNr };
}

/** Ergebnis eines Stücks: Text (auch '' = Stille) oder null = fehlgeschlagen. Fremdschrift und Untertitel-Erfindungen fallen raus. PURE. */
export function stueckErgebnis(st, nr, text, { fehler = '', jetztMs = st.zuletztMs } = {}) {
  const alt = st.stuecke[nr] || { von: 0, bis: 0 };
  const ok = typeof text === 'string';
  return { ...st, zuletztMs: jetztMs, fehler: ok ? st.fehler : (fehler || st.fehler || 'Stück fehlgeschlagen'),
    stuecke: { ...st.stuecke, [nr]: { ...alt, status: ok ? 'ok' : 'fehler', text: ok ? stueckSauber(text) : '' } } };
}

/**
 * Stand nach dem Stopp: 'warten' (Stücke laufen noch oder das letzte fehlt noch), 'fertig' (alle 0…letzteNr ok)
 * oder 'rueckfall' (Lücke in den Nummern oder ein Stück gescheitert). PURE.
 */
export function abschlussStand(st) {
  const nummern = Object.keys(st.stuecke).map(Number);
  if (nummern.some((n) => st.stuecke[n].status === 'fehler')) return 'rueckfall';
  if (st.letzteNr === null) return 'warten';
  for (let n = 0; n <= st.letzteNr; n++) {
    const s = st.stuecke[n];
    if (!s) return 'rueckfall';
    if (s.status === 'laeuft') return 'warten';
  }
  return 'fertig';
}

/** Die fertigen Teile in Reihenfolge, das erfundene Reststück am Ende weg. PURE. */
export function teile(st) {
  const aus = [];
  const nummern = Object.keys(st.stuecke).map(Number).sort((a, b) => a - b);
  for (const n of nummern) {
    const s = st.stuecke[n];
    if (s.status !== 'ok' || !s.text) continue;
    if (n === st.letzteNr && endeFuellsel(s.text, aus.map((t) => t.text).join(' '))) continue;
    aus.push({ nr: n, von: s.von, bis: s.bis, text: s.text });
  }
  return aus;
}
/** Fließtext (Sprachnachricht). PURE. */
export const fliesstext = (st) => teile(st).map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
/** Mit Zeitmarken (Bildschirmaufnahme). PURE. */
export const zeittext = (st) => textMitZeit(teile(st));
/** Was der Browser während der Aufnahme sieht: Teile ab Nummer `ab`. PURE. */
export function zwischenstand(st, ab = 0) {
  const a = Math.max(0, Number(ab) || 0);
  return { ok: true, teile: teile(st).filter((t) => t.nr >= a), stand: abschlussStand(st), fehler: st.fehler || '' };
}

/** Name der Transkript-Datei neben einer Ablage-Datei. PURE. */
export const transkriptName = (ablageName) => `${ablageName}${TRANSKRIPT_ENDUNG}`;

// ── Dienst ──────────────────────────────────────────────────────────────────
/**
 * @param {{transkription:{an:boolean, transkribiere:Function}, tmpDir:string, jetzt?:()=>number, warte?:(ms:number)=>Promise<void>, log?:Function}} opt
 */
export function createAufnahmeDienst({ transkription, tmpDir, jetzt = () => Date.now(), warte = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const sitzungen = new Map(); // id → { st, kette }
  const hol = (id, art) => {
    let s = sitzungen.get(id);
    if (!s) { s = { st: neueSitzung(id, { art, jetztMs: jetzt() }), kette: Promise.resolve() }; sitzungen.set(id, s); }
    return s;
  };

  /**
   * Ein Stück annehmen und (in Reihenfolge je Sitzung) transkribieren. Antwort kommt, wenn sein Text da ist.
   * @param {{id:string, nr:number, von:number, bis:number, letztes:boolean, still:boolean, art:string, mime:string, daten:Buffer}} p
   */
  async function stueck({ id, nr, von, bis, letztes = false, still = false, art = 'sprache', mime = '', daten = null }) {
    const s = hol(id, art);
    s.st = stueckAngekommen(s.st, nr, { von, bis, letztes, jetztMs: jetzt() });
    if (still || !daten || !daten.length || !transkription.an) { s.st = stueckErgebnis(s.st, nr, '', { jetztMs: jetzt() }); return { ok: true, nr, text: '' }; }
    fs.mkdirSync(tmpDir, { recursive: true });
    const datei = path.join(tmpDir, `stueck-${id}-${nr}-${crypto.randomBytes(3).toString('hex')}`);
    fs.writeFileSync(datei, daten, { mode: 0o600 });
    const lauf = s.kette.then(async () => {
      let r;
      try { r = await transkription.transkribiere(datei, { mime, timeoutMs: 90_000 }); } catch (e) { r = { ok: false, fehler: e.message }; }
      finally { try { fs.unlinkSync(datei); } catch { /* weg */ } }
      if (!sitzungen.has(id)) return { ok: false, nr, fehler: 'verworfen' };
      s.st = stueckErgebnis(s.st, nr, r.ok ? r.text : null, { fehler: r.fehler, jetztMs: jetzt() });
      if (!r.ok) log(`[aufnahme] Stück ${nr} von ${id}: ${r.fehler}`);
      return r.ok ? { ok: true, nr, text: s.st.stuecke[nr].text } : { ok: false, nr, fehler: r.fehler || 'Transkription fehlgeschlagen' };
    });
    s.kette = lauf.catch(() => {});
    return lauf;
  }

  /**
   * Abschluss: warten, bis alle Stücke durch sind (höchstens `maxMs` ohne Fortschritt), dann zusammensetzen.
   * Rückfall (oder gar keine Stücke): `datei` einmal am Stück transkribieren. Mit `transkriptPfad` landet der Text dort.
   * @returns {Promise<{ok:boolean, text:string, zeittext:string, quelle:'stuecke'|'datei'|'keine', fehler?:string}>}
   */
  async function abschluss(id, { datei = '', mime = '', video = false, transkriptPfad = '', maxMs = 90_000 } = {}) {
    const s = sitzungen.get(id);
    let stand = s ? abschlussStand(s.st) : 'rueckfall';
    let zuletzt = s ? s.st.zuletztMs : 0, ruhe = jetzt();
    while (s && stand === 'warten') {
      if (s.st.zuletztMs !== zuletzt) { zuletzt = s.st.zuletztMs; ruhe = jetzt(); }
      if (jetzt() - ruhe > maxMs) { stand = 'rueckfall'; break; }
      await warte(300);
      stand = abschlussStand(s.st);
    }
    let erg;
    if (s && stand === 'fertig') {
      erg = { ok: true, text: fliesstext(s.st), zeittext: zeittext(s.st), quelle: 'stuecke' };
    } else if (datei && transkription.an && fs.existsSync(datei)) {
      const r = await transkription.transkribiere(datei, { mime, video, timeoutMs: 600_000 });
      const t = r.ok ? stueckSauber(r.text) : '';
      erg = r.ok ? { ok: true, text: t, zeittext: t ? textMitZeit([{ von: 0, text: t }]) : '', quelle: 'datei' } : { ok: false, text: '', zeittext: '', quelle: 'datei', fehler: r.fehler };
    } else {
      erg = { ok: !transkription.an ? true : false, text: '', zeittext: '', quelle: 'keine', fehler: transkription.an ? ((s && s.st.fehler) || 'keine Stücke und keine Datei') : '' };
    }
    sitzungen.delete(id);
    const inhalt = video ? erg.zeittext : erg.text;
    if (transkriptPfad && inhalt) { try { fs.writeFileSync(transkriptPfad, inhalt + '\n', { mode: 0o600 }); } catch (e) { log(`[aufnahme] Transkript schreiben: ${e.message}`); } }
    return erg;
  }

  return {
    stueck,
    abschluss,
    zwischenstand(id, ab = 0) { const s = sitzungen.get(id); return s ? zwischenstand(s.st, ab) : { ok: false, fehler: 'unbekannt' }; },
    verwerfen(id) { sitzungen.delete(id); return { ok: true }; },
    /** Verwaiste Sitzungen (Tab zu, Abbruch ohne Meldung) wegräumen. */
    aufraeumen(maxAlterMs = 60 * 60_000) { const grenze = jetzt() - maxAlterMs; let n = 0; for (const [id, s] of sitzungen) if (s.st.zuletztMs < grenze) { sitzungen.delete(id); n++; } return n; },
    get anzahl() { return sitzungen.size; },
  };
}

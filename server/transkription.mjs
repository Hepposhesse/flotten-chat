// server/transkription.mjs — Transkription als austauschbarer Weg (v1.3).
//
// Drei Wege, gewählt per Umgebung — nie per Einstellungsseite:
//   FC_TRANSKRIPTION=openai   OpenAI (gpt-4o-mini-transcribe), Schlüssel aus FC_OPENAI_API_KEY oder OPENAI_API_KEY, fetch ohne SDK
//   FC_TRANSKRIPTION=lokal    ein installiertes Whisper-Kommando (whisper-cli, whisper, whisper-ctranslate2, faster-whisper)
//                             oder FC_WHISPER_CMD (eigene Kommandozeile, „{datei}“ wird ersetzt, Text kommt auf stdout)
//   FC_TRANSKRIPTION=aus      nichts — Aufnahmen funktionieren weiter, nur ohne Text
// Mehrere Wege mit Komma = Reihenfolge mit Rückfall („openai,lokal“). Ohne Angabe: openai, wenn ein Schlüssel da ist,
// sonst lokal, wenn ein Kommando gefunden wird, sonst aus.
//
// ffmpeg ist Kür: ist es da, werden Stücke für lokale Kommandos in 16-kHz-WAV umgewandelt und aus Videos nur der Ton
// geschickt. Ohne ffmpeg geht das Browser-Format (webm/ogg/m4a) direkt an OpenAI.
//
// Oben die reinen Regeln (Weg-Wahl, Kommandozeile, Filter, Zeitmarken), unten der I/O-Teil (createTranskription).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';

export const WEGE = ['openai', 'lokal', 'aus'];
export const OPENAI_MODELL = 'gpt-4o-mini-transcribe';
export const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_MAX_BYTES = 25 * 1024 * 1024; // Grenze der OpenAI-Schnittstelle je Datei
export const LOKALE_KOMMANDOS = ['whisper-cli', 'whisper', 'whisper-ctranslate2', 'faster-whisper'];
const WHISPER_PY = new Set(['whisper', 'whisper-ctranslate2', 'faster-whisper']); // gleiche Kommandozeile wie openai-whisper

// ── rein: Weg-Wahl ──────────────────────────────────────────────────────────
/** Der OpenAI-Schlüssel aus der Umgebung ('' = keiner). FC_OPENAI_API_KEY schlägt OPENAI_API_KEY. */
export function openaiSchluessel(env = {}) { return String(env.FC_OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim(); }

/**
 * Welches lokale Kommando? `finde(name)` → absoluter Pfad oder ''. FC_WHISPER_CMD gewinnt immer.
 * whisper-cli (whisper.cpp) braucht ein Modell (FC_WHISPER_MODELL) und WAV, also ffmpeg; die Python-Whisper-Kommandos lesen
 * Audio selbst über ffmpeg — ohne ffmpeg taugen sie nicht. → {art, bin, vorlage?} oder null, dazu `hinweis` warum nicht.
 */
export function lokalesKommando(env = {}, { finde = () => '', ffmpeg = false } = {}) {
  const eigen = String(env.FC_WHISPER_CMD || '').trim();
  if (eigen) return { kommando: { art: 'eigen', vorlage: eigen, bin: eigen.split(/\s+/)[0] }, hinweis: '' };
  const hinweise = [];
  for (const name of LOKALE_KOMMANDOS) {
    const bin = finde(name);
    if (!bin) continue;
    if (!ffmpeg) { hinweise.push(`${name} gefunden, aber ffmpeg fehlt`); continue; }
    if (name === 'whisper-cli' && !String(env.FC_WHISPER_MODELL || '').trim()) { hinweise.push('whisper-cli gefunden, aber FC_WHISPER_MODELL (Pfad zur ggml-Modelldatei) fehlt'); continue; }
    return { kommando: { art: name, bin }, hinweis: '' };
  }
  return { kommando: null, hinweis: hinweise.join('; ') };
}

/**
 * Wege in Reihenfolge aus der Umgebung. PURE.
 * @returns {{wege:string[], weg:string, grund:string, hinweis:string}}  weg = erster Weg oder 'aus';
 *          hinweis = Satz für die Oberfläche, wenn kein Text kommt (sonst '').
 */
export function wegeWaehlen(env = {}, { kommando = null, kommandoHinweis = '' } = {}) {
  const schluessel = !!openaiSchluessel(env);
  const wunsch = String(env.FC_TRANSKRIPTION || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const einschalten = 'Einschalten: OPENAI_API_KEY setzen (FC_TRANSKRIPTION=openai) oder whisper installieren (FC_TRANSKRIPTION=lokal) und den Chat neu starten — siehe docs/aufnahme.md.';
  if (wunsch[0] === 'aus') return { wege: [], weg: 'aus', grund: 'FC_TRANSKRIPTION=aus', hinweis: 'Transkription ist ausgeschaltet (FC_TRANSKRIPTION=aus) — Aufnahmen kommen ohne Text.' };
  const fehlt = [];
  let wege;
  if (!wunsch.length) {
    wege = [schluessel && 'openai', kommando && 'lokal'].filter(Boolean);
  } else {
    wege = [];
    for (const w of wunsch) {
      if (w === 'openai') { if (schluessel) wege.push('openai'); else fehlt.push('openai: kein Schlüssel (OPENAI_API_KEY)'); }
      else if (w === 'lokal') { if (kommando) wege.push('lokal'); else fehlt.push(`lokal: ${kommandoHinweis || 'kein whisper-Kommando gefunden'}`); }
      else if (w !== 'aus') fehlt.push(`unbekannter Weg „${w}“`);
    }
    wege = [...new Set(wege)];
  }
  const grund = wunsch.length ? `FC_TRANSKRIPTION=${wunsch.join(',')}${fehlt.length ? ` (${fehlt.join('; ')})` : ''}` : 'automatisch';
  if (!wege.length) {
    const warum = fehlt.length ? fehlt.join('; ') : ['kein OpenAI-Schlüssel', kommandoHinweis || 'kein whisper-Kommando'].join(', ');
    return { wege, weg: 'aus', grund, hinweis: `Aufnahmen kommen ohne Text: ${warum}. ${einschalten}` };
  }
  return { wege, weg: wege[0], grund, hinweis: '' };
}

/**
 * Kommandozeile für das lokale Kommando. PURE.
 * @returns {{bin:string, args:string[], ausgabe:'stdout'|'datei', datei?:string}}
 */
export function kommandoZeile(kommando, datei, { ausDir = '', sprache = '', modell = '' } = {}) {
  if (!kommando) return null;
  if (kommando.art === 'eigen') {
    const teile = String(kommando.vorlage).split(/\s+/).filter(Boolean);
    let ersetzt = false;
    const args = teile.slice(1).map((t) => (t.includes('{datei}') ? (ersetzt = true, t.split('{datei}').join(datei)) : t));
    if (!ersetzt) args.push(datei);
    return { bin: teile[0], args, ausgabe: 'stdout' };
  }
  if (kommando.art === 'whisper-cli') {
    return { bin: kommando.bin, args: ['-m', modell, '-f', datei, '-nt', '-np', ...(sprache ? ['-l', sprache] : [])], ausgabe: 'stdout' };
  }
  const rumpf = path.basename(datei).replace(/\.[^.]+$/, '');
  return { bin: kommando.bin, args: [datei, '--model', modell || 'base', '--output_format', 'txt', '--output_dir', ausDir, '--verbose', 'False', ...(sprache ? ['--language', sprache] : [])],
    ausgabe: 'datei', datei: path.join(ausDir, rumpf + '.txt') };
}

/** Dateiendung, die OpenAI am Namen erkennt, aus dem MIME. PURE. */
export function endungFuerMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

/** Lesbare Fehlermeldung zu einer OpenAI-Antwort (ohne Schlüssel, ohne Rohtext von außen). PURE. */
export function openaiFehler(status, koerper = '') {
  if (status === 401) return 'OpenAI lehnt den Schlüssel ab (401) — OPENAI_API_KEY prüfen.';
  if (status === 429) return /quota|insufficient/i.test(koerper) ? 'OpenAI-Guthaben aufgebraucht (429).' : 'OpenAI bremst gerade (429) — gleich nochmal.';
  if (status === 413) return 'Datei zu groß für OpenAI (max. 25 MB).';
  if (status >= 500) return `OpenAI antwortet nicht (${status}).`;
  return `OpenAI-Fehler ${status}`;
}

// ── rein: Filter ────────────────────────────────────────────────────────────
// Ostasiatische, thailändische und arabische Schrift: Whisper/gpt-4o-mini-transcribe erfinden sie auf Geräuschen
// („お味噌が。“). Lateinisch und Kyrillisch bleiben.
const FREMDSCHRIFT = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯฀-๿؀-ۿ＀-￯]+/g;
/** Fremdschrift aus einem Transkript entfernen. PURE. */
export function fremdschriftWeg(text) {
  return String(text || '').replace(FREMDSCHRIFT, ' ').replace(/\s+([.,!?])/g, '$1').replace(/\s+/g, ' ').trim();
}
const norm = (t) => String(t || '').toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
// Erfindungen auf Stille, die nie echt sind — egal an welcher Stelle (Untertitel-Abspann aus den Trainingsdaten).
const IMMER_ERFUNDEN = /^(untertitel\b.*|.*\bzdf\b.*|.*\bamara\b.*|(vielen )?dank fürs zuschauen|thanks for watching|bis zum nächsten mal)$/;
// Typische Erfindungen am Ende (nach dem letzten Wort noch kurz still): nur als ganzes Reststück, nie mitten im Text.
const ENDE_FUELLSEL = /^(und |oder )?(schau|das war'?s|das wars|tschüss)$/;

/** Ist ein ganzes Stück eine bekannte Erfindung (Untertitel-Abspann u. ä.)? PURE. */
export function erfunden(text) { const t = norm(fremdschriftWeg(text)); return !!t && IMMER_ERFUNDEN.test(t); }

/**
 * Ist das letzte Stück nur Füllsel? — leer, eine typische Erfindung oder bloß ein Echo der letzten Worte davor (≤ 4 Wörter).
 * Ohne Text davor ist das Stück die ganze Nachricht — dann zählt nur die sichere Erfindung („Tschüss.“ allein ist echt). PURE.
 */
export function endeFuellsel(text, davor = '') {
  const t = norm(fremdschriftWeg(text));
  if (!t) return true;
  if (IMMER_ERFUNDEN.test(t)) return true;
  if (!norm(davor)) return false;
  if (ENDE_FUELLSEL.test(t)) return true;
  const w = t.split(' ');
  if (w.length > 4) return false;
  const letzte = new Set(norm(davor).split(' ').slice(-6).filter(Boolean));
  return letzte.size > 0 && w.every((x) => letzte.has(x));
}

/** Ein Stück säubern: Fremdschrift raus, bekannte Erfindung → ''. PURE. */
export function stueckSauber(text) { const t = fremdschriftWeg(text); return erfunden(t) ? '' : t; }

// ── rein: Zeitmarken ────────────────────────────────────────────────────────
/** 75 → „01:15“, 3725 → „1:02:05“. PURE. */
export function zeitmarke(sek) {
  const s = Math.max(0, Math.floor(Number(sek) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const zz = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${zz(m)}:${zz(r)}` : `${zz(m)}:${zz(r)}`;
}
/** Teile [{von, text}] → „[00:00] …\n[00:12] …“. PURE. */
export function textMitZeit(teile) {
  return (teile || []).filter((t) => String(t.text || '').trim()).map((t) => `[${zeitmarke(t.von)}] ${String(t.text).trim()}`).join('\n');
}
/** „[mm:ss] Text“-Zeilen zurück in Teile (für vorhandene Transkripte). PURE. */
export function teileAusZeitText(text) {
  const aus = [];
  for (const z of String(text || '').split('\n')) {
    const m = /^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\s*(.*)$/.exec(z.trim());
    if (!m || !m[4].trim()) continue;
    aus.push({ von: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4].trim() });
  }
  return aus;
}

// ── I/O ─────────────────────────────────────────────────────────────────────
/** Kommando im PATH finden ('' = nicht da). */
export function imPfad(name, env = process.env) {
  if (!name) return '';
  if (name.includes('/')) { try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { return ''; } }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* weiter */ }
  }
  return '';
}

const lauf = (bin, args, timeoutMs) => new Promise((ok, bad) => execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
  (e, stdout, stderr) => (e ? bad(new Error(String(stderr || e.message).trim().split('\n').slice(-2).join(' ').slice(0, 300) || e.message)) : ok(String(stdout || '')))));

/**
 * Der Transkriptions-Dienst. Alles Äußere ist injizierbar (Tests).
 * @param {{env?:object, tmpDir?:string, fetchImpl?:Function, finde?:Function, ffmpeg?:boolean}} opt
 */
export function createTranskription({ env = process.env, tmpDir = os.tmpdir(), fetchImpl = globalThis.fetch, finde, ffmpeg } = {}) {
  const findeK = finde || ((n) => imPfad(n, env));
  const ffmpegDa = typeof ffmpeg === 'boolean' ? ffmpeg : !!findeK('ffmpeg');
  const lk = lokalesKommando(env, { finde: findeK, ffmpeg: ffmpegDa });
  const wahl = wegeWaehlen(env, { kommando: lk.kommando, kommandoHinweis: lk.hinweis });
  const sprache = String(env.FC_TRANSKRIPTION_SPRACHE || '').trim().toLowerCase().slice(0, 5);
  const modell = String(env.FC_TRANSKRIPTION_MODELL || OPENAI_MODELL).trim();
  const whisperModell = String(env.FC_WHISPER_MODELL || '').trim();

  const tmp = (ext) => path.join(tmpDir, `fc-tr-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  const weg = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* egal */ } };
  /** Nur den Ton als 16-kHz-Mono (WAV für lokale Kommandos, Opus/OGG klein für OpenAI). */
  async function tonHeraus(datei, ziel, timeoutMs) {
    const codec = ziel.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libopus', '-b:a', '32k'];
    await lauf('ffmpeg', ['-y', '-v', 'error', '-i', datei, '-vn', '-ac', '1', '-ar', '16000', ...codec, ziel], timeoutMs);
    return ziel;
  }

  async function perOpenai(datei, { mime = '', timeoutMs = 120_000, video = false } = {}) {
    let quelle = datei, ext = endungFuerMime(mime) || 'webm', temp = '';
    let groesse = 0; try { groesse = fs.statSync(datei).size; } catch { throw new Error('Datei fehlt'); }
    if (ffmpegDa && (video || groesse > OPENAI_MAX_BYTES)) { temp = tmp('ogg'); quelle = await tonHeraus(datei, temp, timeoutMs); ext = 'ogg'; groesse = fs.statSync(quelle).size; }
    try {
      if (groesse > OPENAI_MAX_BYTES) throw new Error('Datei zu groß für OpenAI (max. 25 MB) — ffmpeg installieren, dann wird nur der Ton geschickt.');
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(quelle)]), `audio.${ext}`);
      form.append('model', modell);
      form.append('response_format', 'json');
      if (sprache) form.append('language', sprache);
      const r = await fetchImpl(OPENAI_URL, { method: 'POST', headers: { authorization: `Bearer ${openaiSchluessel(env)}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { let k = ''; try { k = await r.text(); } catch { /* egal */ } throw new Error(openaiFehler(r.status, k)); }
      const j = await r.json();
      return String((j && j.text) || '').trim();
    } finally { if (temp) weg(temp); }
  }

  async function perLokal(datei, { timeoutMs = 300_000 } = {}) {
    const k = lk.kommando; if (!k) throw new Error('kein lokales Kommando');
    const ausDir = path.join(tmpDir, `fc-tr-${crypto.randomBytes(6).toString('hex')}`);
    let wav = '';
    try {
      fs.mkdirSync(ausDir, { recursive: true });
      // whisper-cli will WAV; die übrigen lesen selbst — mit ffmpeg trotzdem WAV (kleiner, ohne Bildspur, gleiches Ergebnis)
      let quelle = datei;
      if (ffmpegDa) { wav = path.join(ausDir, 'stueck.wav'); quelle = await tonHeraus(datei, wav, timeoutMs); }
      const z = kommandoZeile(k, quelle, { ausDir, sprache, modell: k.art === 'whisper-cli' ? whisperModell : (whisperModell || 'base') });
      const out = await lauf(z.bin, z.args, timeoutMs);
      const roh = z.ausgabe === 'datei' ? fs.readFileSync(z.datei, 'utf8') : out;
      return roh.replace(/\[[0-9:.]+\s*-->\s*[0-9:.]+\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    } finally { weg(ausDir); }
  }

  return {
    /** Für Oberfläche und /api/aufnahme/stand: kein Schlüssel, keine Pfade. */
    stand() { return { ok: true, weg: wahl.weg, wege: wahl.wege, grund: wahl.grund, hinweis: wahl.hinweis, ffmpeg: ffmpegDa, modell: wahl.weg === 'openai' ? modell : (lk.kommando ? lk.kommando.art : ''), sprache }; },
    get an() { return wahl.wege.length > 0; },
    get ffmpeg() { return ffmpegDa; },
    /**
     * Eine Datei transkribieren — Wege der Reihe nach, der erste mit Erfolg gilt.
     * @returns {Promise<{ok:boolean, text:string, weg?:string, fehler?:string}>}  ok:true mit text '' = Stille
     */
    async transkribiere(datei, { mime = '', timeoutMs, video = false } = {}) {
      if (!wahl.wege.length) return { ok: false, text: '', fehler: wahl.hinweis || 'Transkription aus' };
      const fehler = [];
      for (const w of wahl.wege) {
        try {
          const text = w === 'openai' ? await perOpenai(datei, { mime, video, timeoutMs: timeoutMs || 120_000 }) : await perLokal(datei, { timeoutMs: timeoutMs || 300_000 });
          return { ok: true, text, weg: w };
        } catch (e) { fehler.push(`${w}: ${String((e && e.message) || e).slice(0, 200)}`); }
      }
      return { ok: false, text: '', fehler: fehler.join(' · ') };
    },
  };
}

/** ffmpeg vorhanden? (für Tests und Startmeldung; der Dienst prüft selbst) */
export function ffmpegVorhanden() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } }

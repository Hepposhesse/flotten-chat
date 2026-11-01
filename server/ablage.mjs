// server/ablage.mjs — Ablage-Tresor 🔗 (v1.1): dauerhafte Ablage für Aufnahmen und Dateien.
//
// Chat-Medien (data/media/) heißen nach ihrer Zufallskennung — gut für den Chat, untauglich für „das Video will ich
// später nochmal hergeben“. Die Ablage (data/ablage/) trägt sprechende Namen (Zeit + Name + Endung), wird NIE
// aufgeräumt und liefert zu jeder Datei den absoluten Pfad (fürs Fenster auf demselben Rechner) und die URL.
//
// `.webm` ist bei uns BEIDES — Bildschirmaufnahme oder Sprachnotiz. Ob eine Bildspur drin ist, sagt nur ffprobe;
// die Endung entscheidet nie. Ohne ffprobe bleibt die Endung das Beste, was wir haben (webm → video).
//
// Oben die reinen Regeln (Zeit als Parameter, kein I/O), unten der I/O-Teil (ablegen/liste/loeschen/streamen).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ABLAGE_ROUTE = '/api/ablage/';
export const SIDECARS = ['.meta', '.transkript.txt']; // 1.2.1: Transkript einer Aufnahme liegt als <name>.transkript.txt daneben
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip' };

// ── rein ────────────────────────────────────────────────────────────────────
/** „Rechtes Fenster“ → „rechtes-fenster“: lesbar im Ordner, ungefährlich in der Shell. Umlaute ausgeschrieben. */
export function slug(text) {
  return String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
/** Endung klein, ohne Punkt; '' wenn keine erkennbar. */
export function endungVon(datei) { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(datei || '')); return m ? m[1].toLowerCase() : ''; }
/** Zeitstempel-Rumpf „2026-10-06-1512“ in der Anzeige-Zeitzone (der Name soll zur Uhrzeit der Aufnahme passen, nicht zu UTC). */
export function zeitRumpf(jetzt, zone = 'Europe/Berlin') {
  const t = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(jetzt));
  return t.replace(' ', '-').replace(':', '');
}
/** Der Name in der Ablage: Zeit + sprechender Teil + Endung. Ohne Anzeigenamen bleibt die Art („video“), nie ein nackter Zeitstempel. */
export function ablageName({ datei, anzeige, typ, jetzt, zone }) {
  const ext = endungVon(datei) || 'bin';
  const rumpf = slug(String(anzeige || '').replace(/\.[A-Za-z0-9]{1,5}$/, '')) || slug(typ) || 'aufnahme';
  return `${zeitRumpf(jetzt, zone)}-${rumpf}.${ext}`;
}
/** Vergebenen Namen eindeutig machen: „…-2.webm“, „…-3.webm“. */
export function freierName(name, belegt) {
  if (!belegt(name)) return name;
  const p = name.lastIndexOf('.'); const rumpf = p > 0 ? name.slice(0, p) : name; const ext = p > 0 ? name.slice(p) : '';
  for (let i = 2; i < 1000; i++) { const k = `${rumpf}-${i}${ext}`; if (!belegt(k)) return k; }
  return `${rumpf}-${Date.now()}${ext}`;
}
/** Die Wache vor jedem Dateizugriff: genau die Namen, die ablageName() erzeugt — kein Pfad, kein „..“, kein führender Punkt. */
export function nameGueltig(name) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(String(name || '')) && !String(name).includes('..');
}
export function istSidecar(name) { return SIDECARS.some((e) => String(name || '').endsWith(e)); }
/**
 * Typ: bild | video | audio | datei. `.webm`/`.mp4` nur mit Messung sicher — `gemessen.bildspur` (ffprobe) entscheidet,
 * ohne Messung die Endung (webm → video, die häufigere Aufnahme).
 */
export function typVon(name, gemessen = {}) {
  const e = endungVon(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(e)) return 'bild';
  if (['mp3', 'wav', 'm4a', 'ogg', 'oga', 'opus'].includes(e)) return 'audio';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(e)) return typeof gemessen.bildspur === 'boolean' ? (gemessen.bildspur ? 'video' : 'audio') : 'video';
  return 'datei';
}
/** MIME zum Ausliefern: gemerkter Typ, sonst Endung. Eine Sprachnotiz in .webm wird als audio/webm ausgeliefert. */
export function mimeVon(name, meta = {}) {
  if (meta.mime) return String(meta.mime);
  const e = endungVon(name);
  if (meta.typ === 'audio' && (e === 'webm' || e === 'mp4')) return e === 'webm' ? 'audio/webm' : 'audio/mp4';
  return MIME[e] || 'application/octet-stream';
}
/** Was der 🔗-Knopf zurückgibt: Pfad fürs Fenster (gleicher Rechner), URL für alles andere. */
export function eintragFuer(name, ablageDir) {
  return { name, pfad: path.join(ablageDir, name), url: ABLAGE_ROUTE + encodeURIComponent(name) };
}

// ── I/O ─────────────────────────────────────────────────────────────────────
/** 1.2.1: Transkript-Pfad und -Link einer Aufnahme (nur wenn eins da ist). Das Fenster liest den Pfad, alle anderen den Link. */
export function transkriptFuer(name, ablageDir) {
  const pfad = path.join(ablageDir, name + '.transkript.txt');
  return fs.existsSync(pfad) ? { transkript_pfad: pfad, transkript_url: ABLAGE_ROUTE + encodeURIComponent(name) + '.transkript.txt' } : {};
}

/** Bildspur + Dauer per ffprobe. Fail-soft: ohne ffprobe oder bei kaputter Datei {} — dann zählt die Endung. */
export function messen(pfad) {
  try {
    const aus = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'default=nw=1', pfad], { timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const bildspur = /codec_type=video/.test(aus);
    const m = /duration=([0-9.]+)/.exec(aus); const dauer = m ? Math.round(Number(m[1])) : undefined;
    return Number.isFinite(dauer) ? { bildspur, dauer } : { bildspur };
  } catch { return {}; }
}
function metaLesen(dir, name) { try { return JSON.parse(fs.readFileSync(path.join(dir, name + '.meta'), 'utf8')); } catch { return {}; } }
function metaSchreiben(dir, name, meta) { try { fs.writeFileSync(path.join(dir, name + '.meta'), JSON.stringify(meta)); } catch { /* Komfort */ } }

/**
 * Chat-Medien in die Ablage kopieren (das Original bleibt im Chat).
 * @param {{id:string,name?:string,mime?:string}[]} medien  Zeilen aus der media-Tabelle (id = Dateiname in medienDir)
 * @param {{jetzt:number, medienDir:string, ablageDir:string, zone?:string}} opt
 * @returns {{ok:boolean, eintraege:object[], fehler:string[]}}
 */
export function ablegen(medien, { jetzt, medienDir, ablageDir, zone }) {
  const eintraege = [], fehler = [];
  const posten = (Array.isArray(medien) ? medien : []).slice(0, 20);
  if (!posten.length) return { ok: false, eintraege, fehler: ['nichts angehängt'] };
  try { fs.mkdirSync(ablageDir, { recursive: true }); } catch (e) { return { ok: false, eintraege, fehler: [`Ablage nicht erreichbar: ${e.message}`] }; }
  for (const p of posten) {
    const id = String((p && p.id) || '');
    const quelle = nameGueltig(id) ? path.join(medienDir, id) : '';
    if (!quelle || !quelle.startsWith(medienDir) || !fs.existsSync(quelle)) { fehler.push((p && p.name) || id || 'Anhang'); continue; }
    const mime = String((p && p.mime) || '');
    const typHinweis = /^image\//.test(mime) ? 'bild' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : typVon(id);
    const name = freierName(ablageName({ datei: id, anzeige: (p && p.name) || '', typ: typHinweis, jetzt, zone }), (n) => fs.existsSync(path.join(ablageDir, n)));
    try {
      const ziel = path.join(ablageDir, name);
      fs.copyFileSync(quelle, ziel);
      const gemessen = messen(ziel);
      // Ohne Messung sagt bei .webm das MIME des Uploads mehr als die Endung (Mikrofon lädt audio/webm hoch).
      const typ = typeof gemessen.bildspur === 'boolean' ? typVon(name, gemessen) : typHinweis;
      const meta = { typ, dauer: gemessen.dauer, mime: mime || mimeVon(name, { typ }), anzeige: String((p && p.name) || '') };
      metaSchreiben(ablageDir, name, meta);
      let groesse = 0; try { groesse = fs.statSync(ziel).size; } catch { /* gerade geschrieben */ }
      eintraege.push({ ...eintragFuer(name, ablageDir), typ, dauer: gemessen.dauer, groesse, zeit: new Date(jetzt).toISOString() });
    } catch (e) { fehler.push(`${(p && p.name) || id}: ${e.message}`); }
  }
  return { ok: !!eintraege.length, eintraege, fehler };
}

/** Alles in der Ablage, neueste zuerst. Fehlt das .meta (von Hand hineingelegt), wird einmal gemessen und gemerkt. */
export function liste({ ablageDir, max = 200 } = {}) {
  let namen = []; try { namen = fs.readdirSync(ablageDir); } catch { return { ok: true, eintraege: [] }; }
  const eintraege = [];
  for (const name of namen) {
    if (istSidecar(name) || !nameGueltig(name)) continue;
    const voll = path.join(ablageDir, name);
    let st; try { st = fs.statSync(voll); } catch { continue; }
    if (!st.isFile()) continue;
    let meta = metaLesen(ablageDir, name);
    if (!meta.typ) { const g = messen(voll); meta = { typ: typVon(name, g), dauer: g.dauer }; meta.mime = mimeVon(name, meta); metaSchreiben(ablageDir, name, meta); }
    eintraege.push({ ...eintragFuer(name, ablageDir), typ: meta.typ, dauer: meta.dauer, groesse: st.size, zeit: new Date(st.mtimeMs).toISOString(), zeit_ms: st.mtimeMs, ...transkriptFuer(name, ablageDir) });
  }
  eintraege.sort((a, b) => b.zeit_ms - a.zeit_ms);
  return { ok: true, eintraege: eintraege.slice(0, max) };
}

/** Eine Ablage-Datei samt Beiwerk löschen. */
export function loeschen(name, { ablageDir } = {}) {
  if (!nameGueltig(name)) return { ok: false, fehler: 'ungültiger Name' };
  const voll = path.join(ablageDir, name);
  if (!voll.startsWith(ablageDir) || !fs.existsSync(voll)) return { ok: false, fehler: 'gibt es nicht' };
  try { fs.unlinkSync(voll); for (const e of SIDECARS) { try { fs.unlinkSync(voll + e); } catch { /* keins */ } } return { ok: true }; }
  catch (e) { return { ok: false, fehler: e.message }; }
}

/** Datei aus der Ablage ausliefern — Video/Audio mit Range/206, sonst bleibt der Player schwarz. */
export function streamen(req, res, name, { ablageDir, download = false } = {}) {
  const voll = nameGueltig(name) ? path.join(ablageDir, name) : '';
  if (!voll || !voll.startsWith(ablageDir) || !fs.existsSync(voll) || istSidecar(name)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Diese Datei gibt es in der Ablage nicht (mehr).'); }
  const mime = mimeVon(name, metaLesen(ablageDir, name));
  const groesse = fs.statSync(voll).size;
  const disp = download ? { 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` } : {};
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : 0; const ende = range[2] ? Math.min(Number(range[2]), groesse - 1) : groesse - 1;
    if (start > ende || start >= groesse) { res.writeHead(416, { 'content-range': `bytes */${groesse}` }); return res.end(); }
    res.writeHead(206, { 'content-type': mime, 'content-range': `bytes ${start}-${ende}/${groesse}`, 'accept-ranges': 'bytes', 'content-length': ende - start + 1, 'cache-control': 'no-store', ...disp });
    return fs.createReadStream(voll, { start, end: ende }).pipe(res);
  }
  res.writeHead(200, { 'content-type': mime, 'content-length': groesse, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...disp });
  return fs.createReadStream(voll).pipe(res);
}

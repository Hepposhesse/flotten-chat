// server/schwarm.mjs — Schwarm-Leiste (1.2, Chat-Komfort).
//
// Startet ein Fenster einen Claude-Code-Workflow (viele Agenten im Hintergrund), sieht man im Chat sonst nichts, bis
// das Ergebnis kommt. Die Leiste über dem Eingabefeld zeigt, was läuft: Name, Phase x/y, Agenten fertig/arbeiten,
// Dauer, Fortschrittsbalken; Klick = Agentenliste je Phase. Nach dem Ende bleibt sie 30 Min als „fertig“ stehen.
//
// Quelle (Claude Code legt das im Protokoll-Ordner des Fensters ab, <config>/projects/<cwd>/):
//   <sitzung>/subagents/workflows/wf_*/journal.jsonl   {type: started|result|failed|…, agentId, label, phase}
//   <sitzung>/workflows/scripts/*<wf>*.js               export const meta = {name, description, phases:[{title}]}
//   <sitzung>.jsonl                                     Start („Task ID … Transcript dir …/wf_…“) + <task-notification>
// Oben reine Funktionen (testbar, test_schwarm.mjs), unten das Lesen. Nur lokale Fenster — bei ssh:/geraet: gibt es
// keine Leiste (das Protokoll liegt auf dem anderen Rechner; dafür extra ssh-Runden je 4 s lohnen nicht).
import fs from 'node:fs';
import path from 'node:path';

/** meta-Block eines Workflow-Skripts → {name, beschreibung, phasen:[titel]} (PURE, Regex statt eval). */
export function metaAusSkript(text = '') {
  const s = String(text || '');
  const block = (s.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/) || [])[1] || s.slice(0, 4000);
  const feld = (k) => { const m = block.match(new RegExp(`\\b${k}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`)); return m ? m[2].replace(/\\(['"`\\])/g, '$1') : ''; };
  const phasenTeil = (block.match(/\bphases\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  const phasen = [...phasenTeil.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  return { name: feld('name'), beschreibung: feld('description'), phasen };
}

const ENDE_FEHLER = /fail|error|abort|cancel|kill|timeout/i;
const ENDE_LAUF = /^(finished|completed|complete|done|ended|end|workflow_result|workflow_done|stopped)$/i;

/** journal.jsonl-Text → Stand (PURE). */
export function standAusJournal(text = '', { meta = null, startMs = 0, journalMs = 0, aufgabe = null } = {}) {
  const agenten = new Map(); const phasenGesehen = []; let lauf = 'laeuft', laufFehler = '';
  for (const zeile of String(text || '').split('\n')) {
    if (!zeile.trim()) continue; let e; try { e = JSON.parse(zeile); } catch { continue; }
    const id = e.agentId || e.key || '';
    if (e.type === 'started' && id) {
      agenten.set(id, { id, label: e.label || '', phase: e.phase || '', status: 'laeuft' });
      if (e.phase && !phasenGesehen.includes(e.phase)) phasenGesehen.push(e.phase);
      continue;
    }
    if (e.type === 'result' && id) { const a = agenten.get(id); if (a) a.status = 'fertig'; else agenten.set(id, { id, label: e.label || '', phase: e.phase || '', status: 'fertig' }); continue; }
    if (id && ENDE_FEHLER.test(e.type || '')) { const a = agenten.get(id); if (a) a.status = 'fehler'; continue; }
    if (!id && ENDE_LAUF.test(e.type || '')) { lauf = 'fertig'; continue; }
    if (!id && ENDE_FEHLER.test(e.type || '')) { lauf = 'fehler'; laufFehler = String(e.error || e.message || e.type).slice(0, 160); }
  }
  // Abschluss aus der Hauptsitzung (task-notification) zählt, wenn das Journal selbst keinen Abschluss kennt.
  if (lauf === 'laeuft' && aufgabe && aufgabe.status) lauf = /complet|done|success/i.test(aufgabe.status) ? 'fertig' : (ENDE_FEHLER.test(aufgabe.status) ? 'fehler' : lauf);
  const liste = [...agenten.values()];
  const phasen = (meta && meta.phasen && meta.phasen.length) ? meta.phasen : phasenGesehen;
  const laufend = liste.filter((a) => a.status === 'laeuft');
  const aktPhase = laufend.length ? laufend[laufend.length - 1].phase : (liste.length ? liste[liste.length - 1].phase : '');
  return {
    name: (meta && meta.name) || '', beschreibung: (meta && meta.beschreibung) || '', phasen, phase: aktPhase,
    phase_nr: aktPhase && phasen.includes(aktPhase) ? phasen.indexOf(aktPhase) + 1 : 0,
    gesamt: liste.length, laufen: laufend.length, fertig: liste.filter((a) => a.status === 'fertig').length, fehler: liste.filter((a) => a.status === 'fehler').length,
    agenten: liste.map(({ label, phase, status }) => ({ label, phase, status })),
    lauf, lauf_fehler: laufFehler, start_ms: startMs || 0, letzte_ms: journalMs || 0,
  };
}

/** Läuft er noch? Ohne Abschluss-Ereignis: alle Agenten fertig + 10 Min Ruhe → fertig; 2 Std Stille → abgebrochen (PURE). */
export function laufZustand(st, jetztMs) {
  if (!st) return null;
  if (st.lauf !== 'laeuft') return st.lauf;
  const still = jetztMs - (st.letzte_ms || st.start_ms || jetztMs);
  if (st.gesamt && !st.laufen && still > 10 * 60_000) return 'fertig';
  if (still > 2 * 3600_000) return 'abgebrochen';
  return 'laeuft';
}

const dauerText = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'gerade gestartet' : m < 60 ? `${m} Min` : `${Math.floor(m / 60)} Std ${m % 60} Min`; };
const eng = (s) => s.replace(/\s+/g, ' ').trim();

/** Eine Zeile für die Leiste (PURE). */
export function schwarmZeile(st, jetztMs) {
  const z = laufZustand(st, jetztMs);
  const name = st.name ? `„${st.name}“` : '';
  const dauer = dauerText((z === 'laeuft' ? jetztMs : (st.letzte_ms || jetztMs)) - (st.start_ms || jetztMs));
  if (z === 'laeuft') {
    const phase = st.phase ? ` · ${st.phasen.length > 1 && st.phase_nr ? `Phase ${st.phase_nr}/${st.phasen.length} ` : ''}${st.phase}` : '';
    const ag = st.gesamt ? ` · ${st.fertig} von ${st.gesamt} Agenten fertig${st.laufen ? `, ${st.laufen} arbeiten` : ''}` : ' · startet …';
    return { zustand: z, text: eng(`🐝 Schwarm ${name}${phase}${ag}${st.fehler ? ` · ${st.fehler} Fehler` : ''} · ${dauer}`) };
  }
  if (z === 'fertig') return { zustand: z, text: eng(`✅ Schwarm ${name} fertig · ${st.fertig} Agenten${st.fehler ? `, ${st.fehler} Fehler` : ''} · ${dauer} · Ergebnis kommt im Fenster`) };
  if (z === 'fehler') return { zustand: z, text: eng(`⚠️ Schwarm ${name} abgebrochen${st.lauf_fehler ? ': ' + st.lauf_fehler : ''} · ${st.fertig} von ${st.gesamt} Agenten fertig`) };
  return { zustand: 'abgebrochen', text: eng(`⏸ Schwarm ${name}: seit 2 Std keine Bewegung · ${st.fertig} von ${st.gesamt} Agenten fertig`) };
}

/** Welche Läufe zeigen? Laufende immer, beendete 30 Min nach dem letzten Eintrag; neueste zuerst, höchstens 3 (PURE). */
export function sichtbareLaeufe(staende = [], jetztMs, { nachlaufMs = 30 * 60_000 } = {}) {
  return staende.filter(Boolean)
    .map((st) => ({ st, z: laufZustand(st, jetztMs) }))
    .filter(({ st, z }) => z === 'laeuft' || jetztMs - (st.letzte_ms || st.start_ms) < nachlaufMs)
    .sort((a, b) => (b.st.start_ms || 0) - (a.st.start_ms || 0)).slice(0, 3)
    .map(({ st }) => ({ ...schwarmZeile(st, jetztMs), name: st.name, beschreibung: st.beschreibung, phasen: st.phasen, phase: st.phase, gesamt: st.gesamt, fertig: st.fertig, laufen: st.laufen, fehler: st.fehler, agenten: st.agenten.slice(0, 200), start_ms: st.start_ms }));
}

/** Start + Abschluss aus der Hauptsitzung: „Task ID … Transcript dir …/wf_…“ und <task-notification> (PURE). */
export function aufgabenAusSitzung(text = '') {
  const s = String(text || ''); const out = {};
  for (const m of s.matchAll(/Task ID: ([a-z0-9]+)\\n[\s\S]{0,600}?Transcript dir: [^"\\]*?\/(wf_[A-Za-z0-9_-]+)/g)) out[m[2]] = { task: m[1], status: '' };
  const taskZuWf = Object.fromEntries(Object.entries(out).map(([wf, v]) => [v.task, wf]));
  for (const m of s.matchAll(/<task-id>([a-z0-9]+)<\/task-id>[\s\S]{0,400}?<status>([a-z_-]+)<\/status>/g)) { const wf = taskZuWf[m[1]]; if (wf) out[wf].status = m[2]; }
  return out;
}

// ── Lesen (lokal) ───────────────────────────────────────────────────────────
const cache = new Map();
const SITZUNG_TAIL = 4 * 1024 * 1024;
function tailLesen(datei, bytes) {
  try {
    const st = fs.statSync(datei); const start = Math.max(0, st.size - bytes); const fd = fs.openSync(datei, 'r');
    try { const b = Buffer.alloc(st.size - start); fs.readSync(fd, b, 0, b.length, start); return b.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** Alle Schwarm-Läufe der letzten 12 Std in einem Protokoll-Ordner → sichtbare Zeilen (5 s gemerkt je Ordner). */
export function schwarmFuerOrdner(ordner, { jetztMs = Date.now(), maxAlterMs = 12 * 3600_000, cacheMs = 5000 } = {}) {
  if (!ordner) return [];
  const c = cache.get(ordner); if (c && jetztMs - c.ms < cacheMs) return c.wert;
  const staende = [];
  let sitzungen = [];
  try { sitzungen = fs.readdirSync(ordner, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* Ordner fehlt */ }
  for (const s of sitzungen) {
    const wfOrdner = path.join(ordner, s, 'subagents', 'workflows');
    let laeufe = []; try { laeufe = fs.readdirSync(wfOrdner).filter((n) => n.startsWith('wf_')); } catch { continue; }
    let aufgaben = null;
    for (const wf of laeufe) {
      const journal = path.join(wfOrdner, wf, 'journal.jsonl');
      let st; try { st = fs.statSync(journal); } catch { continue; }
      if (jetztMs - st.mtimeMs > maxAlterMs) continue;
      let startMs = 0; try { startMs = fs.statSync(path.join(wfOrdner, wf)).birthtimeMs || 0; } catch { /* egal */ }
      if (!startMs || startMs > st.mtimeMs) startMs = Math.min(st.birthtimeMs || st.ctimeMs, st.mtimeMs);
      let meta = null;
      try { const dir = path.join(ordner, s, 'workflows', 'scripts'); const sk = fs.readdirSync(dir).find((n) => n.includes(wf)); if (sk) meta = metaAusSkript(fs.readFileSync(path.join(dir, sk), 'utf8')); } catch { /* ohne Meta */ }
      if (aufgaben === null) aufgaben = aufgabenAusSitzung(tailLesen(path.join(ordner, s + '.jsonl'), SITZUNG_TAIL));
      let text = ''; try { text = fs.readFileSync(journal, 'utf8'); } catch { /* leer */ }
      staende.push(standAusJournal(text, { meta, startMs, journalMs: st.mtimeMs, aufgabe: aufgaben[wf] || null }));
    }
  }
  const wert = sichtbareLaeufe(staende, jetztMs);
  cache.set(ordner, { ms: jetztMs, wert });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return wert;
}

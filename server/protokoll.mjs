// server/protokoll.mjs — „Konsole im Chat“, der reine Teil (v1.0).
//
// Ein Claude-Code-Fenster schreibt sein Sitzungs-Protokoll als JSONL auf die Platte und zeigt im
// Terminal Dialoge (Freigaben, Rückfragen) und seinen Modus. Dieser Modul liest beides NUR als Text
// und macht daraus Chat-Beiträge bzw. Tasten — kein I/O, keine Wanduhr, alles testbar.
//
//   protokollNachrichten(zeilen)  JSONL-Zeilen → {rolle:'du'|'sitzung'|'frage'|'antwort'|'schritt'|'gesperrt'}
//   spiegelBeitraege(nachrichten) → Chat-Beiträge {typ, text}
//   paneZustand(terminalbild)     → {modus, dialog, busy}
//   dialogText(dialog)            → Chat-Text mit Optionen
//   chatBefehl(text, zustand)     → was eine Chat-Nachricht im Fenster auslöst (Text, Wahl, Esc, Modus)
//   tastenFuerWahl(ziele, cursor) → tmux-Tasten für eine Dialog-Wahl
//
// Entstanden im Live-Betrieb der Sales-Engine-Flotte (September 2026) und dort täglich im Einsatz.

const MODI = [
  { re: /⏵⏵\s*auto mode on/i, modus: 'auto' },
  { re: /⏵⏵\s*accept edits on/i, modus: 'accept' },
  { re: /⏸\s*plan mode on|plan mode on/i, modus: 'plan' },
  { re: /⏵⏵\s*bypass permissions on/i, modus: 'bypass' },
];
export const MODUS_NAME = { auto: 'Auto', accept: 'Bearbeiten frei', plan: 'Planen', bypass: 'Ohne Nachfragen', default: 'Manual', unbekannt: '' };

const nackt = (zeile) => String(zeile || '').replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, '').trim();
const kurz = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Was zeigt das Terminal gerade? → {modus, dialog, busy}. Dialog = nummerierte Liste mit Cursor (❯). */
export function paneZustand(text) {
  const roh = String(text || '');
  const zeilen = roh.split('\n');
  let modus = 'unbekannt';
  for (const z of zeilen) { const m = MODI.find((x) => x.re.test(z)); if (m) { modus = m.modus; break; } }
  const hatPrompt = zeilen.some((z) => /^\s*[❯>]\s*$/.test(z) || (/^\s*❯\s+\S/.test(z) && !/^\s*❯\s+\d+\./.test(z)));
  if (modus === 'unbekannt' && hatPrompt && zeilen.some((z) => /shift\+tab to cycle/.test(z))) modus = 'default';
  const busy = /\((?:\d+m\s+)?\d+s\s*·/.test(zeilen.filter((l) => !/(⏵⏵|auto mode on|shift\+tab to cycle)/.test(l)).join('\n'));

  const optionen = [];
  let cursor = 0, letzteIdx = -1, block = [];
  zeilen.forEach((z, idx) => {
    const m = /^(❯\s*)?(\d{1,2})\.\s+(.+)$/.exec(nackt(z));
    if (!m) return;
    if (letzteIdx >= 0 && idx - letzteIdx > 3) block = [];
    block.push({ nr: Number(m[2]), label: m[3].trim(), cursor: !!m[1], idx });
    letzteIdx = idx;
  });
  const gueltig = block.length >= 2 && block[0].nr === 1 && block.every((o, k) => o.nr === k + 1) && block.some((o) => o.cursor);
  if (!gueltig) return { modus, dialog: null, busy };
  for (const o of block) { optionen.push({ nr: o.nr, label: o.label }); if (o.cursor) cursor = o.nr; }
  const oben = [];
  for (let k = block[0].idx - 1; k >= 0 && oben.length < 8; k--) {
    const r = String(zeilen[k] || '');
    if (/[╭╰]/.test(r) || /^[\s─┈═]+$/.test(r)) break;
    if (/^\s*[⏺●✻✽✢⎿]/.test(r) || /Allowed by auto mode|auto mode classifier/.test(r)) break;
    const n = nackt(r);
    if (n) oben.unshift(n);
  }
  const titelText = oben.join('\n');
  const labels = optionen.map((o) => o.label);
  const freigabe = labels.some((l) => /^yes\b/i.test(l)) && labels.some((l) => /^no\b/i.test(l));
  return {
    modus, busy,
    dialog: { art: freigabe ? 'freigabe' : 'frage', titel: titelText.slice(0, 600), optionen, cursor: cursor || 1, kennung: (titelText + '|' + optionen.length).slice(0, 400) },
  };
}

/** Tasten (tmux-Namen) für eine Wahl im Dialog: vom Cursor zur Nummer laufen, Enter; Mehrfachwahl mit Space. */
export function tastenFuerWahl(ziele, cursor = 1, anzahl = 99) {
  const liste = (Array.isArray(ziele) ? ziele : [ziele]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= anzahl);
  if (!liste.length) return [];
  const tasten = [];
  let pos = Number(cursor) || 1;
  const laufe = (ziel) => { while (pos < ziel) { tasten.push('Down'); pos++; } while (pos > ziel) { tasten.push('Up'); pos--; } };
  if (liste.length === 1) { laufe(liste[0]); tasten.push('Enter'); return tasten; }
  for (const z of liste) { laufe(z); tasten.push('Space'); }
  tasten.push('Enter');
  return tasten;
}

/**
 * Was bedeutet eine Chat-Nachricht des Menschen für das Fenster?
 *   {art:'wahl', nummern, nachtext?} · {art:'abbruch'} · {art:'abbruch_text', text} · {art:'halten', text} · {art:'modus', ziel} · {art:'text', text}
 */
export function chatBefehl(text, zustand = {}) {
  const t = String(text || '').trim();
  const klein = t.toLowerCase().replace(/[.!]+$/, '').trim();
  const dialog = zustand && zustand.dialog;
  const modusWort = /^(?:auf\s+|modus\s+|mode\s+)?(manual|manuell|default|normal|auto|automode|auto-mode|plan|planen|accept|bearbeiten)(?:\s+(?:mode|modus|bitte))?$/.exec(klein);
  if (modusWort) {
    const w = modusWort[1];
    const ziel = /^(manual|manuell|default|normal)$/.test(w) ? 'default' : /^(plan|planen)$/.test(w) ? 'plan' : /^(accept|bearbeiten)$/.test(w) ? 'accept' : 'auto';
    return { art: 'modus', ziel };
  }
  if (!dialog) return { art: 'text', text: t };
  const anzahl = (dialog.optionen || []).length || 99;
  if (/^\d{1,2}([\s,;und]+\d{1,2})*$/.test(klein)) {
    const nummern = klein.split(/[^\d]+/).filter(Boolean).map(Number).filter((n) => n >= 1 && n <= anzahl);
    if (nummern.length) return { art: 'wahl', nummern: [...new Set(nummern)] };
  }
  const mitText = /^(\d{1,2})[.):,]?\s+(\S[\s\S]{2,})$/.exec(t);
  if (mitText && Number(mitText[1]) >= 1 && Number(mitText[1]) <= anzahl) return { art: 'wahl', nummern: [Number(mitText[1])], nachtext: mitText[2].trim() };
  if (/^(ja|yes|ok|okay|jo|jep|mach|weiter|go)$/.test(klein)) return { art: 'wahl', nummern: [1] };
  if (/^(nein|no|nope|stop|stopp|abbrechen|abbruch|esc|escape|nicht)$/.test(klein)) return { art: 'abbruch' };
  if (dialog.art === 'frage') return { art: 'halten', text: t };
  return { art: 'abbruch_text', text: t };
}

/** Chat-Text eines Dialogs aus dem Terminalbild (Freigabe 🔐 / Rückfrage ❓). */
export function dialogText(dialog) {
  if (!dialog) return '';
  const opts = (dialog.optionen || []).map((o) => `${o.nr}) ${o.label}`);
  const titel = kurz(String(dialog.titel || '').replace(/^[☐☑✓]\s*\S+\s*/, ''), 500);
  if (dialog.art === 'freigabe') {
    return ['🔐 Das Fenster wartet auf deine Freigabe:', titel, ...opts, 'Antworte mit der Nummer; „nein" bricht ab, Freitext = abbrechen + dein Text als Anweisung.'].filter(Boolean).join('\n');
  }
  return [`❓ ${titel || 'Das Fenster hat eine Rückfrage.'}`, ...opts, 'Antworte mit der Nummer (mehrere: „1, 3"); „nein" bricht die Frage ab.'].join('\n');
}

/** Strukturierte Fassung des Dialogs für Knöpfe in der Oberfläche. */
export function dialogMeta(dialog) {
  if (!dialog) return null;
  // Claudes Zusatz-Optionen („Type something.", „Chat about this") sind keine Antworten — Freitext geht ohnehin per Chat.
  const opts = (dialog.optionen || []).filter((o) => !/^(type something|chat about this)/i.test(o.label));
  return { art: dialog.art, titel: kurz(String(dialog.titel || '').replace(/^[☐☑✓]\s*\S+\s*/, ''), 500), optionen: opts.map((o) => ({ nr: o.nr, label: o.label })) };
}

// ── Sitzungs-Protokoll (JSONL) ──────────────────────────────────────────────

/** Kurzzeile eines Werkzeug-Aufrufs („Bash: git status“). */
export function werkzeugZeile(name, eingabe) {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const n = String(name || '');
  const erst = (...keys) => { for (const k of keys) if (e[k] != null && String(e[k]).trim()) return String(e[k]).trim(); return ''; };
  let t = '';
  if (n === 'Bash') t = erst('description', 'command');
  else if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(n)) t = erst('file_path', 'notebook_path');
  else if (['Grep', 'Glob'].includes(n)) t = erst('pattern');
  else if (['WebFetch', 'WebSearch'].includes(n)) t = erst('url', 'query');
  else if (['Agent', 'Task'].includes(n)) t = erst('description', 'prompt');
  else t = erst('description', 'prompt', 'command', 'text', 'query', 'file_path', 'url');
  return kurz(t, 160);
}

/** Medien-Marker („[Bild: /pfad/abc.png]“) aus einem Text ziehen — die UI zeigt die Vorschau. */
const MEDIEN_ART = { Bild: 'bild', Video: 'video', Sprachnachricht: 'voice', Audio: 'audio', Datei: 'datei' };
export function medienZerlegen(text) {
  const medien = [];
  const rest = String(text || '').replace(
    /\[(Bild|Video|Sprachnachricht|Audio|Datei): ([^\]\n]*?\/)?([A-Za-z0-9._-]{1,64}\.[a-z0-9]{2,5})(?: \(([^)\]]{0,120})\))?[^\]\n]*\]/g,
    (_, art, pfad, datei, name) => { medien.push({ typ: MEDIEN_ART[art] || 'datei', datei, pfad: (pfad || '') + datei, name: (name || '').trim() }); return ''; });
  return { text: rest.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), medien };
}

/**
 * JSONL-Zeilen des Protokolls → lesbare Nachrichten.
 *  du        Eingabe des Menschen (ohne die von uns zugestellten Chat-Nachrichten, wenn ohneZustellung)
 *  sitzung   Antwort-Text des Fensters (mit Medien-Markern)
 *  frage     AskUserQuestion-Aufruf (kommt erst NACH der Antwort ins Protokoll — die Frage selbst liefert das Terminalbild)
 *  antwort   die im Fenster gegebene Antwort auf eine Rückfrage
 *  schritt   Werkzeug-Aufruf (nur für den Kontext einer Sperre)
 *  gesperrt  vom Auto-Mode geblockter Schritt
 */
export function protokollNachrichten(zeilen, { seit = -1, maxLaenge = 4000, ohneZustellung = false, zustellMarker = '📨 ' } = {}) {
  const raus = [];
  const liste = Array.isArray(zeilen) ? zeilen : [];
  for (let i = Math.max(0, seit + 1); i < liste.length; i++) {
    const d = liste[i];
    if (!d || typeof d !== 'object' || d.isSidechain) continue;
    const m = d.message;
    if (!m) continue;
    const zeit = String(d.timestamp || '');
    const inhalt = Array.isArray(m.content) ? m.content : (m.content ? [{ type: 'text', text: String(m.content) }] : []);
    if (d.type === 'user') {
      const ergebnisse = inhalt.filter((c) => c && c.type === 'tool_result');
      if (d.toolUseResult || ergebnisse.length) {
        let teil = 0;
        for (const r of ergebnisse) {
          const id = `${String(d.uuid || i)}#${teil++}`;
          const roh = typeof r.content === 'string' ? r.content : (Array.isArray(r.content) ? r.content.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n') : '');
          const tur = d.toolUseResult;
          if (tur && typeof tur === 'object' && tur.answers && typeof tur.answers === 'object') {
            raus.push({ i, id, rolle: 'antwort', zeit, frageId: String(r.tool_use_id || ''), antworten: { ...tur.answers } });
          } else if (/denied by the Claude Code auto mode classifier/.test(roh)) {
            const g = /Reason:\s*([^.\n]{1,120})/.exec(roh);
            raus.push({ i, id, rolle: 'gesperrt', zeit, werkzeugId: String(r.tool_use_id || ''), grund: g ? g[1].trim() : 'Auto-Mode' });
          }
        }
        continue;
      }
      const text = inhalt.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n').trim();
      if (!text || text.startsWith('<')) continue;
      if (ohneZustellung && text.startsWith(zustellMarker)) continue;
      const z = medienZerlegen(text.slice(0, maxLaenge));
      raus.push({ i, id: String(d.uuid || `${i}`), rolle: 'du', zeit, text: z.text || text.slice(0, maxLaenge), medien: z.medien });
      continue;
    }
    if (d.type !== 'assistant') continue;
    let teil = 0;
    for (const c of inhalt) {
      if (!c) continue;
      const id = `${String(d.uuid || i)}#${teil++}`;
      if (c.type === 'text') {
        const text = String(c.text || '').trim();
        if (!text) continue;
        const z = medienZerlegen(text.slice(0, maxLaenge));
        raus.push({ i, id, rolle: 'sitzung', zeit, text: z.text || text.slice(0, maxLaenge), medien: z.medien });
      } else if (c.type === 'tool_use' && c.name === 'AskUserQuestion') {
        const fragen = (c.input && Array.isArray(c.input.questions) ? c.input.questions : []).map((q) => ({
          frage: String((q && q.question) || '').trim(), kopf: String((q && q.header) || '').trim(), mehrfach: !!(q && q.multiSelect),
          optionen: (q && Array.isArray(q.options) ? q.options : []).map((o) => ({ label: String((o && o.label) || '').trim(), beschreibung: String((o && o.description) || '').trim() })),
        })).filter((q) => q.frage);
        raus.push({ i, id, rolle: 'frage', zeit, frageId: String(c.id || ''), fragen });
      } else if (c.type === 'tool_use') {
        raus.push({ i, id, rolle: 'schritt', zeit, werkzeugId: String(c.id || ''), werkzeug: String(c.name || ''), text: werkzeugZeile(c.name, c.input) });
      }
    }
  }
  return raus;
}

/** Protokoll-Nachrichten → Chat-Beiträge {typ, text, medien?, quelle, frageId?}. */
export function spiegelBeitraege(nachrichten = [], { werkzeuge = new Map() } = {}) {
  const raus = [];
  for (const n of Array.isArray(nachrichten) ? nachrichten : []) {
    if (!n) continue;
    if (n.rolle === 'schritt') { if (n.werkzeugId) werkzeuge.set(n.werkzeugId, { werkzeug: n.werkzeug, text: n.text }); continue; }
    if (n.rolle === 'sitzung') {
      const text = String(n.text || '').trim();
      if (text || (n.medien || []).length) raus.push({ typ: 'answer', text: text || '📎', medien: n.medien || [], quelle: n.id });
      continue;
    }
    if (n.rolle === 'frage') continue;
    if (n.rolle === 'antwort') {
      const teile = Object.entries(n.antworten || {}).map(([f, a]) => `${kurz(f, 80)} → ${kurz(a, 120)}`);
      if (teile.length) raus.push({ typ: 'fyi', text: `✔ Im Fenster beantwortet: ${teile.join(' · ')}`, quelle: n.id, frageId: n.frageId });
      continue;
    }
    if (n.rolle === 'gesperrt') {
      const w = werkzeuge.get(n.werkzeugId);
      const was = w ? [w.werkzeug, w.text].filter(Boolean).join(': ') : '';
      raus.push({ typ: 'error', quelle: n.id, text: `⛔ Auto-Mode hat einen Schritt geblockt${n.grund ? ` (${n.grund})` : ''}${was ? `: ${kurz(was, 160)}` : ''}.\nSchreib „manual", dann stelle ich das Fenster um und es fragt dich bei solchen Schritten — oder sag, wie es anders gehen soll.` });
    }
  }
  return raus;
}

/** Nächster Spiegel-Stand: neue Sitzung → ab Dateiende (außer sie ist frisch gestartet → alles). */
export function spiegelStart(alt, prot, { jetztMs = 0, neuAbMs = 5 * 60_000 } = {}) {
  const a = alt && typeof alt === 'object' ? alt : {};
  if (!prot || !prot.sitzung) return { ...a };
  if (a.sitzung === prot.sitzung) return { ...a };
  const frisch = !!(prot.gestartetMs && jetztMs && (jetztMs - prot.gestartetMs) < neuAbMs);
  return { sitzung: prot.sitzung, offset: frisch ? 0 : (prot.groesse || 0), dialogKennung: '' };
}

/** Ganze JSONL-Zeilen aus einem Puffer (die angebrochene letzte Zeile wartet auf die nächste Runde). */
export function ganzeZeilen(text) {
  const s = String(text || '');
  const ende = s.lastIndexOf('\n');
  if (ende < 0) return { zeilen: [], verbraucht: 0 };
  const zeilen = s.slice(0, ende).split('\n').filter(Boolean).map((z) => { try { return JSON.parse(z); } catch { return null; } }).filter(Boolean);
  return { zeilen, verbraucht: Buffer.byteLength(s.slice(0, ende + 1), 'utf8') };
}

/** Welches Protokoll gehört zum Prozess, der zu `prozessStartMs` startete? (jüngste Datei ab Start − Toleranz) */
export function protokollZuProzess(prozessStartMs, dateien, fensterMs = 180_000) {
  const start = Number(prozessStartMs) || 0;
  if (!start) return '';
  const liste = (Array.isArray(dateien) ? dateien : []).filter((d) => d && d.name);
  // Zuerst die früheste Datei, die NACH dem Prozessstart entstand; sonst die jüngste kurz davor (Uhren-Toleranz).
  const danach = liste.filter((d) => (d.geburtMs || 0) >= start).sort((a, b) => (a.geburtMs || 0) - (b.geburtMs || 0));
  if (danach.length) return danach[0].name;
  const davor = liste.filter((d) => (d.geburtMs || 0) >= start - fensterMs).sort((a, b) => (b.geburtMs || 0) - (a.geburtMs || 0));
  return davor.length ? davor[0].name : '';
}

/** Der Text, der im Fenster ankommt, wenn eine Chat-Nachricht zugestellt wird. */
export function zustellText(m = {}, { marker = '📨 ' } = {}) {
  const von = String(m.von || '?').trim();
  const id = Number(m.id) || 0;
  return `${marker}${von} · #${id}: ${String(m.inhalt || '').trim()}`;
}

/** Medien-Marker im Text durch absolute Pfade ersetzen, damit das Fenster die Datei selbst lesen kann. */
export function markerAufloesen(text, medienOrdner) {
  const art = { bild: 'Bild', video: 'Video', voice: 'Sprachnachricht', datei: 'Datei', audio: 'Audio' };
  const weg = String(medienOrdner || '').replace(/\/$/, '');
  return String(text || '').replace(/(?:\p{Extended_Pictographic}️?\s*)?\[(bild|video|voice|datei|audio):([A-Za-z0-9._-]+)(?:\|([^\]]*))?\]/gu,
    (_, typ, datei, name) => `[${art[typ] || 'Datei'}: ${weg}/${datei}${name && name.trim() ? ` (${name.trim()})` : ''}]`);
}

/** Welche Chat-Nachrichten sind zuzustellen: nur neue (jenseits des Cursors), nur vom Menschen, nicht zu alt. */
export function neueZustellungen(msgs = [], cursor = 0, { jetztMs = 0, maxAlterMs = 2 * 3600_000, eigeneNamen = [] } = {}) {
  const alle = (Array.isArray(msgs) ? msgs : []).filter((m) => Number(m.id) > Number(cursor));
  let max = Number(cursor) || 0;
  const zustellen = [], uebersprungen = [];
  for (const m of alle.sort((a, b) => Number(a.id) - Number(b.id))) {
    max = Math.max(max, Number(m.id));
    if (eigeneNamen.includes(String(m.von)) || m.typ === 'system' || m.typ === 'answer' || m.typ === 'question' || m.typ === 'error') continue;
    const alter = jetztMs && m.erstellt_am ? jetztMs - Date.parse(m.erstellt_am) : 0;
    if (alter > maxAlterMs) uebersprungen.push(m); else zustellen.push(m);
  }
  return { zustellen, uebersprungen, cursor: max };
}

/** Slug für Kanal-/Session-Namen aus einem Thema. */
export function slug(text) {
  return String(text || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'thema';
}

/** Projekt-Ordner, in dem Claude Code das Protokoll ablegt: <configDir>/projects/<cwd, alles außer [A-Za-z0-9] → ->. */
export function protokollOrdner(configDir, cwd) {
  return `${String(configDir || '').replace(/\/$/, '')}/projects/${String(cwd || '').replace(/[^A-Za-z0-9]/g, '-')}`;
}

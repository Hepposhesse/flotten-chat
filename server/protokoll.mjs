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

/**
 * Was zeigt das Terminal gerade? PURE.
 *   modus   'auto' | 'accept' | 'plan' | 'bypass' | 'default' | 'unbekannt'
 *   dialog  null | { art:'freigabe'|'frage', titel, optionen:[{nr,label}], cursor, kennung }
 *   busy    laufende Klammer-Zeit („(47s · …)") wie in agents-live.tuiUrteil
 * Ein Dialog ist eine nummerierte Liste („1. Yes", „❯ 2. …") im unteren Teil des Bildes. Freigabe,
 * wenn die Frage „Do you want to proceed?"/„…allow…" dabeisteht, sonst Rückfrage (AskUserQuestion).
 */
/**
 * Vorschau-Kasten einer Rückfrage (AskUserQuestion mit preview) aus dem Terminalbild lösen. PURE.
 * Claude Code zeichnet ihn rechts neben die Optionen („┌──┐ │ Text │ └──┘"); dadurch hingen Rahmen und
 * Mustertext an Labels und Beschreibungen, und im Chat fehlte der Text.
 * Rückgabe: { zeilen } ohne den Kasten (rechts abgeschnitten) und { vorschau } als Fließtext oder ''.
 */
export function vorschauKasten(zeilen) {
  const oben = zeilen.findIndex((z) => /^.{8,}?┌─{5,}┐\s*$/.test(z));
  if (oben < 0) return { zeilen, vorschau: '' };
  const spalte = zeilen[oben].indexOf('┌');
  let unten = -1;
  for (let i = oben + 1; i < zeilen.length && i < oben + 80; i++) { if ((zeilen[i] || '').indexOf('└', spalte - 1) >= 0 && /└─+┘/.test(zeilen[i])) { unten = i; break; } }
  if (unten < 0) return { zeilen, vorschau: '' };
  const innen = [];
  for (let i = oben + 1; i < unten; i++) {
    const rechts = String(zeilen[i] || '').slice(spalte);
    if (/✂\s*─+\s*\d+ lines? hidden/.test(rechts)) continue; // Kürzungs-Marke ist kein Inhalt
    innen.push(rechts.replace(/^[│|]\s?/, '').replace(/\s*[│|]\s*$/, ''));
  }
  // Umbrüche des Kastens zusammenziehen, Leerzeilen bleiben Absätze.
  const absaetze = [];
  let akt = [];
  for (const z of innen) { const t = z.trim(); if (!t) { if (akt.length) absaetze.push(akt.join(' ')); akt = []; } else akt.push(t); }
  if (akt.length) absaetze.push(akt.join(' '));
  const ohne = zeilen.map((z, i) => (i >= oben && i <= unten ? String(z).slice(0, spalte).replace(/\s+$/, '') : z));
  return { zeilen: ohne, vorschau: absaetze.join('\n').trim() };
}

/** Optionen-Block ohne Nummern über einem Dialog-Fuß („Enter to confirm · Esc to cancel"). PURE. */
function ohneNummern(zeilen) {
  let fuss = -1;
  for (let i = zeilen.length - 1; i >= 0 && i >= zeilen.length - 8; i--) { if (/Enter to (?:confirm|select)|Esc to cancel/i.test(zeilen[i] || '')) { fuss = i; break; } }
  if (fuss < 0) return [];
  let i = fuss - 1;
  while (i >= 0 && !nackt(zeilen[i])) i--;
  const roh = [];
  for (; i >= 0; i--) {
    const z = String(zeilen[i] || '');
    const m = /^(\s*)(❯\s+|\s{2})(\S.*)$/.exec(z.replace(/^[│┃|]/, ' '));
    if (!m || !nackt(z)) break;
    roh.unshift({ cursor: m[2].startsWith('❯'), spalte: m[1].length + m[2].length, label: m[3].trim(), idx: i });
  }
  const c = roh.filter((o) => o.cursor);
  if (c.length !== 1) return [];
  const liste = roh.filter((o) => o.spalte === c[0].spalte);
  // Nummerierte Reste (Dialog oben abgeschnitten) sind kein nummernloser Dialog — das regelt dialogAbgeschnitten().
  if (liste.length !== roh.length || liste.some((o) => /^\d{1,2}\.\s/.test(o.label))) return [];
  return liste.map((o, k) => ({ nr: k + 1, label: o.label, cursor: o.cursor, idx: o.idx }));
}

export function paneZustand(text) {
  const roh = String(text || '');
  const kasten = vorschauKasten(roh.split('\n'));
  const zeilen = kasten.zeilen;
  let modus = 'unbekannt';
  for (const z of zeilen) { const m = MODI.find((x) => x.re.test(z)); if (m) { modus = m.modus; break; } }
  const hatPrompt = zeilen.some((z) => /^\s*[❯>]\s*$/.test(z) || /^\s*❯\s+\S/.test(z) && !/^\s*❯\s+\d+\./.test(z));
  if (modus === 'unbekannt' && hatPrompt && zeilen.some((z) => /shift\+tab to cycle/.test(z))) modus = 'default';
  const busy = /\((?:\d+m\s+)?\d+s\s*·/.test(roh.split('\n').filter((l) => !/(⏵⏵|auto mode on|shift\+tab to cycle)/.test(l)).join('\n'));

  // Nummerierte Optionen: nur ein zusammenhängender Block (Lücke von >2 Zeilen ohne Nummer = Ende).
  const optionen = [];
  let cursor = 0, letzteIdx = -1, block = [];
  zeilen.forEach((z, idx) => {
    const n = nackt(z);
    const m = /^(❯\s*)?(\d{1,2})\.\s+(.+)$/.exec(n);
    if (!m) return;
    if (letzteIdx >= 0 && idx - letzteIdx > 3) { block = []; }
    block.push({ nr: Number(m[2]), label: m[3].trim(), cursor: !!m[1], idx });
    letzteIdx = idx;
  });
  // Nur ein Block, der mit 1 beginnt, lückenlos zählt und einen Cursor (❯) trägt, ist ein Dialog —
  // eine nummerierte Aufzählung im Fließtext hat keinen Cursor.
  let gueltig = block.length >= 2 && block[0].nr === 1 && block.every((o, k) => o.nr === k + 1) && block.some((o) => o.cursor);
  // Claude Code zeichnet manche Dialoge ohne Nummern („❯ No, exit" / „  Yes, I trust this folder", 2.1.289) —
  // die kamen nie im Chat an. Erkennung nur mit Dialog-Fuß darunter, sonst wäre jede
  // Eingabezeile „❯ text" ein Dialog. Nummern vergeben wir selbst; gewählt wird ohnehin per Pfeiltasten.
  if (!gueltig) {
    block = ohneNummern(zeilen);
    gueltig = block.length >= 2;
  }
  if (!gueltig) return { modus, dialog: null, busy };
  // Rückfragen mit Vorschau zeichnen „Chat about this" OHNE Nummer unter einer Trennlinie — als letzte Option
  // mitzählen (per Pfeiltaste erreichbar), sonst kann der Chat sie nicht wählen (04.10.2026).
  if (block.length && !/^chat about this$/i.test(block[block.length - 1].label)) {
    const letzte = block[block.length - 1];
    for (let k = letzte.idx + 1; k < zeilen.length && k <= letzte.idx + 10; k++) {
      const m = /^(❯\s*)?Chat about this\s*$/i.exec(nackt(zeilen[k]));
      if (m) { block.push({ nr: letzte.nr + 1, label: 'Chat about this', cursor: !!m[1], idx: k, ohneNr: true }); break; }
    }
  }
  // Beschreibung einer Option = die eingerückten Zeilen bis zur nächsten Option. Die letzte Option bekommt keine —
  // unter ihr steht schon der Fuß des Dialogs.
  block.forEach((o, k) => {
    const opt = { nr: o.nr, label: o.label, ...(o.ohneNr ? { ohneNr: true } : {}) };
    const bis = k + 1 < block.length ? block[k + 1].idx : o.idx + 1;
    const besch = zeilen.slice(o.idx + 1, bis).map(nackt).filter((x) => x && !/^[─━┈═\s]+$/.test(x) && !/^Notes: press n\b/i.test(x)).join(' ').trim();
    if (besch) opt.beschreibung = besch;
    optionen.push(opt); if (o.cursor) cursor = o.nr;
  });
  // Titel: die Zeilen über dem Block bis zum Rahmen-Anfang (max. 8), Leerzeilen weg.
  const oben = [];
  for (let k = block[0].idx - 1; k >= 0 && oben.length < 8; k--) {
    const roh = String(zeilen[k] || '');
    if (/[╭╰]/.test(roh) || /^[\s─┈═]+$/.test(roh)) break;
    if (/^[\s╌]+$/.test(roh)) continue; // Trennlinien um Befehl/Diff (2.1.289) nicht in den Titel
    if (/^\s*[⏺●✻✽✢⎿]/.test(roh) || /Allowed by auto mode|auto mode classifier/.test(roh)) break; // Werkzeug-Ausgabe davor gehört nicht zum Dialog
    const n = nackt(roh);
    if (!n) continue;
    oben.unshift(n);
  }
  const titelText = oben.join('\n');
  // Freigabe-Dialoge erkennt man an ihren Optionen („Yes" / „No, and tell Claude …"); Rückfragen
  // (AskUserQuestion) tragen beliebige Labels plus „Type something." / „Chat about this".
  const labels = optionen.map((o) => o.label);
  const freigabe = labels.some((l) => /^yes\b/i.test(l)) && labels.some((l) => /^no\b/i.test(l));
  const dialog = {
    ...(kasten.vorschau ? { vorschau: { nr: cursor || 1, text: kasten.vorschau.slice(0, 2000) } } : {}),
    art: freigabe ? 'freigabe' : 'frage',
    titel: titelText.slice(0, 600),
    optionen,
    cursor: cursor || 1,
    // Kennung ohne die Labels: tippt jemand im Terminal in „Type something", ändert sich das Label —
    // der Dialog bleibt derselbe (sonst wurde er alle 3 s neu in den Chat gestellt, 16.09. #131847ff).
    // Auch ohne den Countdown („…automatically deny this request in 1:46" zählt jede Sekunde runter —
    // derselbe Freigabe-Dialog stand am 27.09. sechsmal im Chat, #135429ff).
    kennung: (titelText.replace(/\b\d{1,2}:\d{2}\b/g, '') + '|' + optionen.length).slice(0, 400),
  };
  return { modus, dialog, busy };
}

/**
 * Steht ein Dialog im Terminal, der oben abgeschnitten ist? PURE.
 * tmux-Fenster ohne angehängten Bildschirm sind 80×24 groß. Ist eine Rückfrage/Freigabe höher, fällt
 * „❯ 1." oben raus, paneZustand() sieht keinen Dialog und im Chat kam nichts an — der Mensch merkte es nur am
 * Stillstand.
 * Der Scrollback hilft nicht (Ink zeichnet den Dialog neu), nur ein größeres Fenster. Erkennung: Fußzeile
 * eines Dialogs unten im Bild, aber kein gültiger Dialog.
 */
export function dialogAbgeschnitten(text) {
  const unten = String(text || '').split('\n').map(nackt).filter(Boolean).slice(-4).join('\n');
  if (!/Esc to cancel|Enter to select|Enter to confirm/i.test(unten)) return false;
  // Auch ein gekürzter Vorschau-Kasten („├─── ✂ ─── 4 lines hidden ───┤") braucht das größere Fenster.
  return !paneZustand(text).dialog || /✂\s*─+\s*\d+ lines? hidden/.test(String(text));
}

/**
 * Tasten für eine Wahl im Dialog: vom Cursor zur Ziel-Nummer laufen, dann Enter. PURE.
 * Mehrfachauswahl (mehrere Nummern): jede mit Space markieren, am Ende Enter.
 * tmux-Tastennamen: Down/Up/Space/Enter.
 */
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

/** Nur den Cursor auf eine Option stellen (ohne Enter) — fürs Antwortfeld einer Rückfrage. PURE. */
export function tastenZuOption(ziel, cursor = 1, anzahl = 99) {
  const t = tastenFuerWahl(ziel, cursor, anzahl);
  return t.length ? t.slice(0, -1) : [];
}

/**
 * Nummer der Freitext-Option einer Rückfrage („Type something."), sonst 0. PURE.
 * Hat jemand im Terminal schon getippt, trägt die Option seinen Text statt des Labels — dann ist es
 * die Option vor „Chat about this" — außer sie ist eine Option der Protokoll-Frage `frage`.
 */
export function freitextOption(optionen = [], frage = null) {
  const liste = Array.isArray(optionen) ? optionen : [];
  const o = liste.find((x) => /^type something\.?$/i.test(String((x && x.label) || '').trim()));
  if (o) return o.nr;
  const letzte = liste[liste.length - 1];
  if (!(letzte && /^chat about this$/i.test(String(letzte.label || '').trim()) && liste.length >= 2)) return 0;
  if (letzte.ohneNr) return 0; // Vorschau-Rückfrage: hat nie ein Antwortfeld, die Option davor ist eine echte Wahl
  // Rückfragen mit Vorschau haben kein Antwortfeld: die Option davor ist dann eine echte Wahl — ist sie eine
  // Option der Protokoll-Frage, NICHT hineintippen.
  const kandidat = liste[liste.length - 2];
  const fragen = frage && Array.isArray(frage.fragen) ? frage.fragen : [];
  if (fragen.some((q) => (q.optionen || []).some((x) => labelNackt(x.label) === labelNackt(kandidat.label)))) return 0;
  return kandidat.nr;
}

/** Nummer der Option „Chat about this" einer Rückfrage, sonst 0. PURE. */
export function redenOption(optionen = []) {
  const o = (Array.isArray(optionen) ? optionen : []).find((x) => /^chat about this$/i.test(String((x && x.label) || '').trim()));
  return o ? o.nr : 0;
}

/**
 * Was bedeutet eine Chat-Nachricht des Menschen für das Fenster, wenn ein Dialog offen ist (oder nicht)? PURE.
 *   { art:'wahl', nummern:[…], nachtext? }  „2" / „1, 3" / „ja" (=1) im offenen Dialog; „1. und dazu …" = Wahl 1 + Text danach
 *   { art:'abbruch' }                  „nein"/„abbrechen"/„esc" im offenen Dialog → Escape
 *   { art:'abbruch_text', text }       Freitext im offenen Freigabe-Dialog → Escape, dann der Text als Eingabe
 *   { art:'freitext', nr, text }       Freitext bei offener Rückfrage → ins Antwortfeld („Type something.") und abschicken
 *   { art:'halten', text }             Freitext bei offener Rückfrage ohne Antwortfeld → wartet, bis sie beantwortet ist
 *   { art:'modus', ziel }              „manual"/„auto" (auch ohne Dialog) → Shift+Tab bis zum Ziel-Modus
 *   { art:'text', text }               normale Eingabe
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
  // „1. aber bitte mit Knöpfen" = Wahl 1, der Rest folgt als Nachricht, sobald der Dialog zu ist (#131843).
  const mitText = /^(\d{1,2})[.):,]?\s+(\S[\s\S]{2,})$/.exec(t);
  if (mitText && Number(mitText[1]) >= 1 && Number(mitText[1]) <= anzahl) return { art: 'wahl', nummern: [Number(mitText[1])], nachtext: mitText[2].trim() };
  if (/^(ja|yes|ok|okay|jo|jep|mach|weiter|go)$/.test(klein)) return { art: 'wahl', nummern: [1] };
  if (/^(nein|no|nope|stop|stopp|abbrechen|abbruch|esc|escape|nicht)$/.test(klein)) return { art: 'abbruch' };
  // Freitext: bei einer Freigabe heißt das „Nein, und mach es so: …" (Esc + Text, wie in der Konsole).
  // Bei einer Rückfrage ist Freitext die Antwort: Cursor aufs Antwortfeld
  // („Type something."), Text tippen, Enter. Ohne Antwortfeld wartet der Text, bis die Frage beantwortet
  // ist — sonst löscht ein nebenbei geschicktes Bild die Frage (passiert am 16.09., #131839).
  // Ohne Antwortfeld (z. B. Rückfragen mit Vorschau) macht der Chat, was man im Terminal tut: „Chat about this" wählen, der Text folgt, sobald der Dialog zu ist.
  if (dialog.art === 'frage') {
    const nr = freitextOption(dialog.optionen, zustand.frage);
    if (nr) return { art: 'freitext', nr, text: t };
    const reden = redenOption(dialog.optionen);
    return reden ? { art: 'wahl', nummern: [reden], nachtext: t } : { art: 'halten', text: t };
  }
  return { art: 'abbruch_text', text: t };
}


const HINWEIS_FRAGE = 'Antworte mit der Nummer (mehrere: „1, 3") oder schreib deine Antwort als Text; „nein" bricht die Frage ab.';
/** Option-Label ohne Cursor-/Kästchen-Deko und ohne „(Recommended)" — zum Vergleichen Terminal ⇄ Protokoll. PURE. */
const labelNackt = (l) => String(l || '').replace(/^[☐☒☑✓✔\[\]x\s]+/i, '').replace(/\s*\((?:recommended|empfohlen)\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const istHilfsOption = (l) => /^type something\.?$/i.test(l) || /^chat about this$/i.test(l);
/** Titel aus dem Terminalbild ohne Reiter-Leiste („← ☐ Art ☐ Preis ✔ Submit →") und Kästchen-Kopf. PURE. */
function titelOhneReiter(titel) {
  return String(titel || '').split('\n')
    .filter((z) => !/[☐☒☑]/.test(z) && !/✔\s*Submit/.test(z) && !/^[←→\s]*$/.test(z))
    .join('\n').trim();
}

/**
 * Welche Frage des Protokoll-Aufrufs zeigt das Terminal gerade? Index oder -1. PURE.
 * Bei mehreren Fragen (Reiter) die, deren Optionen zu den sichtbaren Labels passen.
 */
export function frageIndex(dialog, frage) {
  const fragen = frage && Array.isArray(frage.fragen) ? frage.fragen.filter((q) => q && q.frage) : [];
  if (!fragen.length || !dialog) return -1;
  const sichtbar = (dialog.optionen || []).map((o) => labelNackt(o.label)).filter((l) => !istHilfsOption(l));
  if (fragen.length === 1) return 0;
  let idx = fragen.findIndex((q) => q.optionen.length && q.optionen.length === sichtbar.length && q.optionen.every((o, k) => labelNackt(o.label) === sichtbar[k]));
  if (idx < 0) idx = fragen.findIndex((q) => q.optionen.some((o) => sichtbar.includes(labelNackt(o.label))));
  return idx;
}

/** Passt die gemerkte Protokoll-Frage zum Dialog im Terminal? PURE. */
export const fragePasst = (dialog, frage) => !!dialog && dialog.art === 'frage' && frageIndex(dialog, frage) >= 0;

/**
 * Bus-Text eines Dialogs: Freigabe (🔐) aus dem Terminalbild; Rückfrage (❓) aus dem Protokoll-Aufruf
 * (ganze Frage, Kopf, Optionen mit Beschreibung, „Frage 2 von 3"), sonst aus dem Terminalbild. PURE.
 * Die Nummern bleiben die des Terminals; „Type something."/„Chat about
 * this" stehen nicht als Knopf da — Freitext im Chat IST die Antwort.
 */
export function dialogText(dialog, frage = null) {
  if (!dialog) return '';
  const opts = (dialog.optionen || []).map((o) => `${o.nr}) ${o.label}`);
  if (dialog.art === 'freigabe') {
    const titel = kurz(titelOhneReiter(dialog.titel), 500);
    return ['🔐 Das Fenster wartet auf deine Freigabe:', titel, ...opts,
      'Antworte mit der Nummer; „nein" bricht ab, Freitext = abbrechen + dein Text als Anweisung.'].filter(Boolean).join('\n');
  }
  const idx = frageIndex(dialog, frage);
  if (idx >= 0) {
    const fragen = frage.fragen.filter((q) => q && q.frage);
    const q = fragen[idx];
    const stand = fragen.length > 1 ? ` (Frage ${idx + 1} von ${fragen.length})` : '';
    const zeilen = [`❓ ${q.kopf ? `${q.kopf}: ` : ''}${kurz(q.frage, 700)}${stand}`];
    for (const o of dialog.optionen || []) {
      const l = labelNackt(o.label);
      if (istHilfsOption(l)) continue;
      const p = (q.optionen || []).find((x) => labelNackt(x.label) === l);
      zeilen.push(`${o.nr}) ${p ? p.label : o.label}${p && p.beschreibung ? ` — ${kurz(p.beschreibung, 220)}` : ''}`);
    }
    if (q.mehrfach) zeilen.push('Mehrfachauswahl möglich („1, 3").');
    zeilen.push(...vorschauZeilen(dialog));
    zeilen.push(HINWEIS_FRAGE);
    return zeilen.join('\n');
  }
  const titel = kurz(titelOhneReiter(dialog.titel), 500);
  const optsB = (dialog.optionen || []).map((o) => `${o.nr}) ${o.label}${o.beschreibung ? ` — ${kurz(o.beschreibung, 220)}` : ''}`);
  return [`❓ ${titel || 'Das Fenster hat eine Rückfrage.'}`, ...optsB.filter((z, k) => !istHilfsOption(labelNackt((dialog.optionen[k] || {}).label))), ...vorschauZeilen(dialog), HINWEIS_FRAGE].join('\n');
}

/** Vorschau-Text (z. B. Mustertext einer Antwort) als Chat-Zeilen — ohne „N)"-Anfang, damit kein Knopf entsteht. */
function vorschauZeilen(dialog) {
  const v = dialog && dialog.vorschau;
  if (!v || !v.text) return [];
  const o = (dialog.optionen || []).find((x) => x.nr === v.nr);
  return ['', `📝 Vorschau zu Option ${v.nr}${o ? ` „${String(o.label).trim()}“` : ''}:`, ...v.text.split('\n').map((z) => `   ${z}`), ''];
}


/** Strukturierte Fassung des Dialogs für Knöpfe in der Oberfläche (Labels/Beschreibungen aus dem Protokoll, wenn bekannt). */
export function dialogMeta(dialog, frage = null) {
  if (!dialog) return null;
  // Claudes Zusatz-Optionen („Type something.", „Chat about this") sind keine Knöpfe — Freitext im Chat IST die Antwort.
  const idx = frageIndex(dialog, frage);
  const q = idx >= 0 ? frage.fragen.filter((x) => x && x.frage)[idx] : null;
  const opts = (dialog.optionen || []).filter((o) => !istHilfsOption(labelNackt(o.label))).map((o) => {
    const p = q && (q.optionen || []).find((x) => labelNackt(x.label) === labelNackt(o.label));
    const beschreibung = (p && p.beschreibung) || o.beschreibung || '';
    return { nr: o.nr, label: p ? p.label : o.label, ...(beschreibung ? { beschreibung: kurz(beschreibung, 220) } : {}) };
  });
  const titel = q ? `${q.kopf ? `${q.kopf}: ` : ''}${kurz(q.frage, 700)}` : kurz(titelOhneReiter(dialog.titel), 500);
  return { art: dialog.art, titel, optionen: opts, ...(q && q.mehrfach ? { mehrfach: true } : {}), ...(dialog.vorschau ? { vorschau: dialog.vorschau } : {}) };
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
 *  frage     AskUserQuestion-Aufruf (ganze Frage mit Optionen; angezeigt wird sie, sobald das Terminalbild den Dialog zeigt)
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
export function spiegelBeitraege(nachrichten = [], { werkzeuge = new Map(), offeneFragen = new Map() } = {}) {
  const raus = [];
  for (const n of Array.isArray(nachrichten) ? nachrichten : []) {
    if (!n) continue;
    if (n.rolle === 'schritt') { if (n.werkzeugId) werkzeuge.set(n.werkzeugId, { werkzeug: n.werkzeug, text: n.text }); continue; }
    if (n.rolle === 'sitzung') {
      const text = String(n.text || '').trim();
      if (text || (n.medien || []).length) raus.push({ typ: 'answer', text: text || '📎', medien: n.medien || [], quelle: n.id });
      continue;
    }
    // Der AskUserQuestion-Aufruf steht im Protokoll, BEVOR geantwortet wird — gepostet wird die Frage aber erst,
    // wenn das Terminalbild den Dialog zeigt (dialogText mit dieser Frage). Hier nur merken; je Fenster höchstens eine.
    if (n.rolle === 'frage') { offeneFragen.clear(); offeneFragen.set(n.frageId, { frageId: n.frageId, fragen: n.fragen || [], zeit: n.zeit }); continue; }
    if (n.rolle === 'antwort') {
      offeneFragen.delete(n.frageId);
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

/**
 * Der Antwort-Text, der im Terminal direkt ÜBER einer Rückfrage steht. PURE.
 * Claude Code schreibt Text + AskUserQuestion erst NACH der Antwort ins Protokoll (geprüft 28.09.2026:
 * Frage 18:48:16 im Chat, Text davor 18:49:55) — der Spiegel holt ihn deshalb aus dem
 * Terminalbild mit Verlauf (capture-pane -S). Gesucht: die Trennlinie über dem Dialog, darüber der
 * letzte „●"-Block. Ist dieser Block ein Werkzeug-Aufruf oder steht Werkzeug-Ausgabe dazwischen → ''.
 * Ink bricht Zeilen selbst um; Absätze werden wieder zusammengezogen, Listenpunkte bleiben Zeilen.
 */
export function textVorDialog(text) {
  const zeilen = String(text || '').split('\n');
  const z = paneZustand(text);
  if (!z.dialog || z.dialog.art !== 'frage') return '';
  let erste = -1;
  for (let i = zeilen.length - 1; i >= 0; i--) { if (/^(❯\s*)?1\.\s+/.test(nackt(zeilen[i]))) { erste = i; break; } }
  if (erste < 0) return '';
  let linie = -1;
  for (let i = erste - 1; i >= Math.max(0, erste - 15); i--) { if (/^\s*[─━]{10,}\s*$/.test(zeilen[i])) { linie = i; break; } }
  if (linie < 0) return '';
  const block = [];
  for (let i = linie - 1; i >= 0 && linie - i < 400; i--) {
    const roh = String(zeilen[i] || '').replace(/\s+$/, '');
    if (/^\s*⎿/.test(roh) || /^\s{2}(Ran|Read|Listed|Searched|Wrote|Updated|Edited|Called)\b.*\d/.test(roh) || /^[✻✽✢✶·]\s/.test(roh)) return '';
    const m = /^[●⏺]\s?(.*)$/.exec(roh);
    if (m) {
      if (/^[A-Z][A-Za-z]+\(/.test(m[1]) || /^Running\b/.test(m[1])) return '';
      block.unshift(m[1]);
      break;
    }
    block.unshift(roh.replace(/^ {2}/, ''));
    if (i === 0) return '';
  }
  // Absätze zusammenziehen
  const out = [];
  let offen = false;
  for (const zeile of block) {
    const t = zeile.trim();
    if (!t) { if (out.length && out[out.length - 1] !== '') out.push(''); offen = false; continue; }
    if (/^(\d{1,2}\.|[-•*])\s/.test(t) || !offen) { out.push(t); offen = true; continue; }
    const vor = out[out.length - 1];
    // Ein umbrochener Pfad in „[Bild: …]" darf kein Leerzeichen bekommen, sonst findet ihn medienZerlegen nicht.
    out[out.length - 1] += ((vor.match(/\[/g) || []).length > (vor.match(/\]/g) || []).length ? '' : ' ') + t;
  }
  return out.join('\n').trim();
}

/** Vergleichs-Schlüssel eines Antwort-Texts (Terminal ohne Markdown ⇄ Protokoll mit Markdown). PURE. */
export function textSchluessel(text) {
  return String(text || '').toLowerCase().replace(/\[bild:[^\]]*\]/g, '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
}

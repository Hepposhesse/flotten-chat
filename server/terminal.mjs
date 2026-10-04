// Live-Terminal im Flotten-Chat: unterwegs, ohne Terminal offen, alle Funktionen
// des Terminals sehen. Der Server liest das tmux-Bild MIT Farben (capture-pane -e) und zeigt es im
// Kanal-Kopf; hier wird aus den ANSI-Folgen sicheres HTML. REIN (kein I/O).

const BASIS = ['#1e1e1e', '#e5534b', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#c9d1d9'];
const HELL = ['#6e7681', '#ff7b72', '#7ee787', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'];

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 256er-Palette → Hex. */
function farbe256(n) {
  if (n < 8) return BASIS[n];
  if (n < 16) return HELL[n - 8];
  if (n < 232) {
    const i = n - 16, st = [0, 95, 135, 175, 215, 255];
    const h = (v) => v.toString(16).padStart(2, '0');
    return '#' + h(st[Math.floor(i / 36)]) + h(st[Math.floor(i / 6) % 6]) + h(st[i % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return '#' + g.toString(16).padStart(2, '0').repeat(3);
}

/** SGR-Parameter auf den Stil anwenden. */
function sgr(stil, params) {
  const p = params.length ? params : [0];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) { stil.fg = null; stil.bg = null; stil.fett = false; stil.blass = false; stil.kursiv = false; stil.unter = false; stil.invers = false; }
    else if (c === 1) stil.fett = true;
    else if (c === 2) stil.blass = true;
    else if (c === 3) stil.kursiv = true;
    else if (c === 4) stil.unter = true;
    else if (c === 7) stil.invers = true;
    else if (c === 22) { stil.fett = false; stil.blass = false; }
    else if (c === 23) stil.kursiv = false;
    else if (c === 24) stil.unter = false;
    else if (c === 27) stil.invers = false;
    else if (c >= 30 && c <= 37) stil.fg = BASIS[c - 30];
    else if (c === 39) stil.fg = null;
    else if (c >= 40 && c <= 47) stil.bg = BASIS[c - 40];
    else if (c === 49) stil.bg = null;
    else if (c >= 90 && c <= 97) stil.fg = HELL[c - 90];
    else if (c >= 100 && c <= 107) stil.bg = HELL[c - 100];
    else if (c === 38 || c === 48) {
      let wert = null;
      if (p[i + 1] === 5 && p[i + 2] != null) { wert = farbe256(p[i + 2] & 255); i += 2; }
      else if (p[i + 1] === 2 && p[i + 4] != null) { wert = '#' + [p[i + 2], p[i + 3], p[i + 4]].map((v) => (v & 255).toString(16).padStart(2, '0')).join(''); i += 4; }
      if (c === 38) stil.fg = wert; else stil.bg = wert;
    }
  }
}

function css(stil) {
  let fg = stil.fg, bg = stil.bg;
  if (stil.invers) { fg = stil.bg || 'var(--term-bg)'; bg = stil.fg || 'var(--term-ink)'; }
  const t = [];
  if (fg) t.push('color:' + fg);
  if (bg) t.push('background:' + bg);
  if (stil.fett) t.push('font-weight:700');
  if (stil.blass) t.push('opacity:.6');
  if (stil.kursiv) t.push('font-style:italic');
  if (stil.unter) t.push('text-decoration:underline');
  return t.join(';');
}

/**
 * ANSI-Text (tmux capture-pane -e) → HTML mit <span style>. Nur SGR-Folgen werden umgesetzt, alle anderen
 * Steuerfolgen entfernt; Text wird escaped. Leere Zeilen am Ende fallen weg. PURE.
 */
export function ansiZuHtml(text) {
  const zeilen = String(text || '').replace(/\r/g, '').split('\n');
  while (zeilen.length && !zeilen[zeilen.length - 1].replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').trim()) zeilen.pop();
  const stil = { fg: null, bg: null, fett: false, blass: false, kursiv: false, unter: false, invers: false };
  const raus = [];
  for (const zeile of zeilen) {
    let html = '', pos = 0;
    const re = /\x1b(?:\[([0-9;:]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|.)/g;
    const stueck = (s) => {
      if (!s) return;
      const c = css(stil);
      html += c ? `<span style="${c}">${esc(s)}</span>` : esc(s);
    };
    let m;
    while ((m = re.exec(zeile))) {
      stueck(zeile.slice(pos, m.index));
      pos = re.lastIndex;
      if (m[2] === 'm') sgr(stil, (m[1] || '').split(/[;:]/).filter((x) => x !== '').map(Number));
    }
    stueck(zeile.slice(pos).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
    raus.push(html);
  }
  return raus.join('\n');
}

/** Erlaubte Tasten der Tastenleiste (tmux-Namen) — nichts anderes kommt vom Client ins Fenster. */
export const TERMINAL_TASTEN = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Up', 'Down', 'Enter', 'Escape', 'Tab', 'BTab', 'Space'];

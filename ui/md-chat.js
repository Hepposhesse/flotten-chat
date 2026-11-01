// ui/md-chat.js — Chat-Markdown wie im Terminal (1.2, Chat-Komfort).
// Fenster antworten in Markdown. Vorher konnte der Chat nur fett/Code/Listen/# — Tabellen, Links [x](url), Zitate,
// Code-Blöcke, Kursiv, Linien und Unterlisten standen roh. `mdLite` ist rein (node-testbar, test_md_chat.mjs) und
// läuft auf ESCAPTEM Text, NACHDEM `linkify` die URLs zu <a> gemacht hat; es erzeugt nur eigene Tags, nie HTML aus
// dem Text. Tabellen: echte Tabelle in der Blase (waagerecht scrollbar, erste Spalte bleibt stehen); „⤢ Groß ansehen“
// öffnet sie als Blatt über dem Chat (volle Breite, Kopieren als TSV, Esc/✕/Klick daneben schließt).
// Styles stehen in ui/index.html (Block „Chat-Komfort (1.2)“), damit alles an den Design-Tokens hängt.
(function (wurzel) {
  var TRENN = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  var ZEILE = /^\s*\|.*\|\s*$/;

  function zellen(z) {
    var t = z.trim().replace(/^\|/, '').replace(/\|$/, '');
    // \| bleibt ein Zeichen in der Zelle, kein Trenner
    return t.split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|'); });
  }
  function ausrichtung(trenn) {
    return zellen(trenn).map(function (c) {
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      return l && r ? 'center' : r ? 'right' : '';
    });
  }
  function zelle(tag, inhalt, ausr) {
    return '<' + tag + (ausr ? ' style="text-align:' + ausr + '"' : '') + '>' + inhalt + '</' + tag + '>';
  }

  /** Jeden Block „Kopfzeile + Trennzeile (|---|) + Zeilen“ durch eine Tabelle ersetzen. Alles andere bleibt. */
  function tabellenHtml(text) {
    var z = String(text).split('\n'), t = '', i = 0;
    // Der Umbruch hinter der Tabelle bleibt hier stehen, damit Zitate/Listen danach noch am Zeilenanfang stehen;
    // mdLite nimmt ihn am Ende weg (Blase ist pre-wrap, sonst Leerzeile).
    var dazu = function (s) { t += (t !== '' ? '\n' : '') + s; };
    while (i < z.length) {
      if (ZEILE.test(z[i]) && i + 1 < z.length && TRENN.test(z[i + 1].trim()) && z[i + 1].indexOf('-') >= 0) {
        var kopf = zellen(z[i]), ausr = ausrichtung(z[i + 1]), n = kopf.length, rows = [];
        i += 2;
        while (i < z.length && ZEILE.test(z[i])) { rows.push(zellen(z[i])); i++; }
        if (/\n$/.test(t)) t = t.slice(0, -1); // Leerzeile davor übernimmt der Abstand der Tabelle
        dazu('<div class="md-tab" data-spalten="' + n + '"><div class="md-tab-scroll"><table><thead><tr>'
          + kopf.map(function (c, k) { return zelle('th', c, ausr[k]); }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) {
            var c = r.slice(0, n); while (c.length < n) c.push('');
            return '<tr>' + c.map(function (x, k) { return zelle('td', x, ausr[k]); }).join('') + '</tr>';
          }).join('')
          + '</tbody></table></div><div class="md-tab-fuss"><button type="button" class="md-tab-gross">⤢ Groß ansehen</button></div></div>');
        if (i < z.length && z[i].trim() === '') i++; // Leerzeile hinter der Tabelle übernimmt der Abstand
        continue;
      }
      dazu(z[i]); i++;
    }
    return t;
  }

  // Listen zeilenweise: -/•/*/+ → <ul>, 1. → <ol> (Nummer läuft weiter, auch nach Unterpunkten); eingerückte
  // Zeilen = Unterliste im vorigen Punkt. Der Umbruch hinter dem Block entfällt (Blase ist pre-wrap).
  var PUNKT = /^([ \t]*)([-•*+]|\d{1,3}\.) (.*)$/;
  function listen(text) {
    var z = String(text).split('\n'), t = '', nachBlock = false, i = 0;
    var dazu = function (s) { t += (t !== '' && !nachBlock ? '\n' : '') + s; };
    var art = function (m) { return /\d/.test(m) ? 'ol' : 'ul'; };
    var auf = function (tag, m) { var n = tag === 'ol' ? parseInt(m, 10) : 1; return '<' + tag + ' class="md-' + tag + '"' + (n > 1 ? ' start="' + n + '"' : '') + '>'; };
    while (i < z.length) {
      var m = PUNKT.exec(z[i]);
      if (!m || m[1].length >= 2) { dazu(z[i]); nachBlock = false; i++; continue; }
      var h = '', oben = null, unten = null;
      while (i < z.length && (m = PUNKT.exec(z[i]))) {
        if (m[1].length >= 2 && oben) {
          var ua = art(m[2]);
          if (unten !== ua) { if (unten) h += '</' + unten + '>'; h += auf(ua, m[2]).replace('">', ' md-sub">'); unten = ua; }
          h += '<li class="md-li2">' + m[3] + '</li>';
        } else {
          if (unten) { h += '</' + unten + '>'; unten = null; }
          if (oben) h += '</li>';
          var oa = art(m[2]);
          if (oben !== oa) { if (oben) h += '</' + oben + '>'; h += auf(oa, m[2]); oben = oa; }
          h += '<li>' + m[3];
        }
        i++;
      }
      if (unten) h += '</' + unten + '>';
      h += '</li></' + oben + '>';
      dazu(h); nachBlock = true;
    }
    return t;
  }

  /** URLs → Links, #karte-<n> → Karten-Chip (escapter Text rein, HTML raus). Backticks gehören nie zur URL. */
  function linkify(escaped) {
    return String(escaped).replace(/(?<!href=")https?:\/\/[^\s<`]+|(?<![\w\/=.-])#karte-(\d{1,9})(?![\w-])/g, function (u, karte) {
      if (karte) return '<button type="button" class="fc-id" data-karte="' + karte + '" title="Karte öffnen">#karte-' + karte + '</button>';
      var rest = '', m = u.match(/((&quot;|&gt;|&#39;|[),.;:!?»])+)$/);
      if (m) { rest = m[1]; u = u.slice(0, u.length - rest.length); }
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>' + rest;
    });
  }

  function mdLite(html) {
    var t = String(html), code = [];
    // Code-Blöcke zuerst heraus: ihr Inhalt wird nicht formatiert.
    t = t.replace(/(^|\n)```[^\n]*\n([\s\S]*?)\n?```[ \t]*(\n|$)/g, function (_, vor, c, nach) { code.push(c); return vor + '\u0000' + (code.length - 1) + '\u0000' + nach; });
    if (t.indexOf('|') >= 0) t = tabellenHtml(t);
    t = t.replace(/(^|\n)(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/g, '$1<hr class="md-hr">');
    t = t.replace(/\*\*([^*\n]{1,200}?)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[\s(„>])__([^_\n]{1,200}?)__(?=[\s.,;:!?)“<]|$)/gm, '$1<b>$2</b>');
    // `Code` — auch um einen schon gesetzten Link herum (URL in Backticks).
    t = t.replace(/(^|[^`])`([^`\n]{1,120}|[^`\n]{0,40}<a [^`\n]{1,900}<\/a>[^`\n]{0,40})`/g, '$1<code>$2</code>');
    t = t.replace(/~~([^~\n]{1,200}?)~~/g, '<s>$1</s>');
    t = t.replace(/(^|[\s(„>])\*(?![\s*])([^*\n]{1,200}?)(?<![\s*])\*(?=[\s.,;:!?)“<]|$)/gm, '$1<i>$2</i>');
    t = t.replace(/(^|[\s(„>])_(?![\s_])([^_\n]{1,200}?)(?<![\s_])_(?=[\s.,;:!?)“<]|$)/gm, '$1<i>$2</i>');
    // [Text](URL): linkify hat die URL schon zum <a> gemacht → Linktext statt URL zeigen.
    t = t.replace(/\[([^\]\n]{1,200})\]\((<a href="[^"]+"[^>]*>)[^<]*<\/a>\)/g, '$2$1</a>');
    t = t.replace(/^#{1,6} (.+)$/gm, '<b class="md-h">$1</b>');
    t = t.replace(/(^|\n)((?:&gt; ?[^\n]*(?:\n|$))+)/g, function (_, vor, b) {
      return vor + '<blockquote class="md-zitat">' + b.replace(/\n$/, '').split('\n').map(function (z) { return z.replace(/^&gt; ?/, ''); }).join('\n') + '</blockquote>';
    });
    t = listen(t);
    t = t.replace(/\u0000(\d+)\u0000\n?/g, function (_, i) { return '<pre class="md-pre"><code>' + code[+i] + '</code></pre>'; });
    // Leerzeilen um Blöcke übernimmt deren Abstand (sonst doppelt: Leerzeile + Rand).
    return t.replace(/\n\n(<(?:ul|ol|blockquote|pre|hr|div) class="md-)/g, '\n$1').replace(/(<\/ul>|<\/ol>|<\/blockquote>|<\/pre>|<hr class="md-hr">|Groß ansehen<\/button><\/div><\/div>)\n/g, '$1');
  }

  /** Tabelle als Text mit Tabulatoren (Kopieren → Tabellenkalkulation fügt es als Tabelle ein). */
  function alsTsv(zeilen) {
    return zeilen.map(function (r) { return r.map(function (c) { return String(c).replace(/[\t\n]+/g, ' ').trim(); }).join('\t'); }).join('\n');
  }

  var api = { mdLite: mdLite, linkify: linkify, tabellenHtml: tabellenHtml, alsTsv: alsTsv };
  wurzel.FcMd = api;
  if (typeof document === 'undefined') return;

  // ── „Groß ansehen“-Blatt ──
  var blatt = null, vorher = null;
  function schliessen() {
    if (!blatt) return;
    var b = blatt; blatt = null;
    b.classList.remove('offen');
    setTimeout(function () { b.remove(); }, 200);
    document.removeEventListener('keydown', taste, true);
    if (vorher && vorher.focus) vorher.focus();
  }
  function taste(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); schliessen(); } }
  function oeffnen(tab, knopf) {
    schliessen();
    vorher = knopf;
    var tabelle = tab.querySelector('table');
    var zeilen = Array.prototype.map.call(tabelle.rows, function (r) { return Array.prototype.map.call(r.cells, function (c) { return c.innerText; }); });
    blatt = document.createElement('div');
    blatt.className = 'md-blatt';
    blatt.innerHTML = '<div class="md-blatt-karte" role="dialog" aria-modal="true" aria-label="Tabelle"><div class="md-blatt-kopf"><strong>Tabelle</strong>'
      + '<button type="button" data-a="kopieren">Kopieren</button><button type="button" data-a="zu" aria-label="Schließen">✕</button></div>'
      + '<div class="md-blatt-inhalt"></div></div>';
    blatt.querySelector('.md-blatt-inhalt').appendChild(tab.cloneNode(true));
    blatt.addEventListener('click', function (e) {
      if (e.target === blatt) return schliessen();
      var a = e.target.closest('button[data-a]'); if (!a) return;
      if (a.dataset.a === 'zu') return schliessen();
      var tsv = alsTsv(zeilen);
      var fertig = function () { a.textContent = '✓ Kopiert'; setTimeout(function () { a.textContent = 'Kopieren'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(fertig, function () { a.textContent = 'Nicht kopiert'; });
      else a.textContent = 'Nicht kopiert';
    });
    document.body.appendChild(blatt);
    document.addEventListener('keydown', taste, true);
    requestAnimationFrame(function () { blatt && blatt.classList.add('offen'); });
    blatt.querySelector('button[data-a="zu"]').focus();
  }
  document.addEventListener('click', function (e) {
    var k = e.target.closest && e.target.closest('.md-tab-gross');
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    oeffnen(k.closest('.md-tab'), k);
  }, true);
})(typeof window !== 'undefined' ? window : globalThis);

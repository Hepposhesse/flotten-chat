// server/aufraeumen.mjs — Aufräumen vor Neu starten / Löschen / Schließen (v1.2).
//
// Bevor ein Fenster neu startet, gelöscht oder geschlossen wird, bekommt es den Auftrag „Stand wegschreiben, committen,
// antworte aufgeräumt“. Erst wenn es „aufgeräumt“ sagt (oder nach höchstens 2 Minuten, oder wenn der Prozess endet)
// passiert die eigentliche Aktion. Läuft im Fenster nichts (aus oder nur die nackte Shell), passiert sie sofort.
// Solange es aufräumt, steht es in stand() — die Oberfläche zeigt daran „räumt auf …“.
// Alle Zugriffe (Zeit, Warten, Terminal, Chat, Aktion) sind injiziert — testbar ohne tmux und Datenbank.

export const MAX_MS = 120_000;
export const TAKT_MS = 3_000;
export const ARTEN = ['neustart', 'loeschen', 'schliessen'];

/** Auftragstext an das Fenster. PURE. */
export function aufraeumText(art) {
  const was = art === 'loeschen' ? 'gelöscht' : art === 'schliessen' ? 'geschlossen' : 'neu gestartet';
  return `Das Fenster wird gleich ${was}: schreib jetzt deinen Stand an die feste Stelle (Verlaufs-Eintrag an der Board-Karte, falls es eine gibt), committe alles auf deinen Branch und antworte danach nur mit „aufgeräumt“.`;
}

/** Hinweis im Kanal. PURE. */
export function kanalHinweis(art) {
  if (art === 'loeschen') return '🧹 Das Fenster räumt auf und wird danach gelöscht (höchstens 2 Min).';
  if (art === 'schliessen') return '🧹 Das Fenster räumt auf und wird danach geschlossen (höchstens 2 Min).';
  return '🧹 Das Fenster räumt auf und startet danach neu (höchstens 2 Min).';
}

/** Hat das Fenster „aufgeräumt“ geantwortet? (eigene Antwort-Nachricht, nicht der Auftrag selbst) PURE. */
export const istAufgeraeumt = (text) => /\baufgeräumt\b/i.test(String(text || '')) && !/antworte danach nur mit/i.test(String(text || ''));

export function createAufraeumen({
  jetzt = () => Date.now(), warte = (ms) => new Promise((r) => setTimeout(r, ms)),
  lebt, dialogOffen = () => false, escape = () => {}, textSenden, letzteId = () => 0, aufgeraeumtSeit,
  ausfuehren, melden = () => {}, geaendert = () => {}, maxMs = MAX_MS, taktMs = TAKT_MS,
} = {}) {
  const laufend = new Map(); // name → { art, seit }

  async function ablauf(f, art) {
    const seitId = letzteId(f);
    if (dialogOffen(f)) { escape(f); await warte(800); } // eine offene Rückfrage würde den Auftrag verschlucken
    textSenden(f, aufraeumText(art));
    const start = jetzt();
    let grund = 'zeit';
    while (jetzt() - start < maxMs) {
      await warte(taktMs);
      if (!lebt(f)) { grund = 'beendet'; break; }
      if (aufgeraeumtSeit(f, seitId)) { grund = 'aufgeraeumt'; break; }
    }
    return grund;
  }

  return {
    /**
     * Aufräumen + Aktion starten. → { ok, sofort, laeuft_schon?, fertig? } — die Aktion läuft im Hintergrund weiter,
     * `fertig` ist ihr Promise (Grund: 'aufgeraeumt' | 'zeit' | 'beendet' | 'fehler').
     */
    starten(f, art, { sofort = false } = {}) {
      if (!f || !f.name) return { ok: false, fehler: 'Fenster unbekannt.' };
      if (!ARTEN.includes(art)) return { ok: false, fehler: 'Unbekannte Aktion.' };
      if (laufend.has(f.name)) return { ok: true, sofort: false, laeuft_schon: true };
      if (sofort || !lebt(f)) { const r = ausfuehren(f, art, sofort ? 'sofort' : 'aus'); return { ...(r || { ok: true }), sofort: true }; }
      laufend.set(f.name, { art, seit: jetzt() });
      try { melden(f, kanalHinweis(art)); } catch { /* Hinweis ist Komfort */ }
      try { geaendert(f); } catch { /* egal */ }
      const ende = () => { laufend.delete(f.name); try { geaendert(f); } catch { /* egal */ } };
      const fertig = ablauf(f, art)
        .then((grund) => { try { ausfuehren(f, art, grund); } finally { ende(); } return grund; })
        .catch(() => { ende(); return 'fehler'; });
      return { ok: true, sofort: false, fertig };
    },
    /** Räumt dieses Fenster gerade auf? → { art, seit } | null */
    stand(name) { return laufend.get(name) || null; },
  };
}

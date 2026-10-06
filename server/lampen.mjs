// server/lampen.mjs — Fenster-Lampen (v1.1): beschäftigt / bereit / aus / tot, plus laufende Uhr.
//
// Die eine Regel (aus dem Live-Betrieb, „Falsch-Grün“-Fixes): ein Fenster ist BESCHÄFTIGT genau dann, wenn
// im Terminalbild eine LAUFENDE Klammer-Zeit steht — „✻ Thinking… (47s · …)“, „(1m 30s · esc to interrupt)“.
// Alles andere ist bereit: Prompt, Hint-Leiste, stehengebliebener Spinner-Glyph, „Cooked for 37s“ (Vergangenheit).
// Das Urteil ist nie null: ein fehlendes Urteil würde den vorherigen Stand stehen lassen = Dauer-Grün.
//
// Farben: grün pulsierend + Uhr = beschäftigt · blau = bereit · grau = aus (vom Menschen gestoppt oder nie
// gestartet) · rot = tot (lief, und der Prozess ist weg, ohne dass jemand „Stop“ gedrückt hat).
// Rein: Zeit kommt als Parameter, kein I/O. Die Busy-Erkennung selbst ist paneZustand() — hier nur der Aufsatz.
import { paneZustand } from './protokoll.mjs';

/** 'busy' | 'idle' — nie null. Baut auf paneZustand() auf (eine Erkennung, nicht zwei). */
export function tuiUrteil(text) {
  return paneZustand(String(text || '')).busy ? 'busy' : 'idle';
}

export const LAMPEN = ['beschaeftigt', 'bereit', 'aus', 'tot'];

/**
 * Lampen-Stand je Fenster fortschreiben (Reducer, rein).
 * @param {object|null} vorher   letzter Stand {lampe, busySeitMs, totSeitMs}
 * @param {object} jetzt         {lebt, busy, registryStatus, jetztMs}
 *   registryStatus = Status aus der Fenster-Registry VOR dieser Runde: 'laeuft' + Prozess weg = tot (von selbst
 *   gestorben); 'aus'/'schliesst' + Prozess weg = aus (der Mensch hat gestoppt oder geschlossen).
 * @returns {{lampe:string, busySeitMs:number, busy_sekunden:number, totSeitMs:number}}
 */
export function lampenStand(vorher, { lebt = false, busy = false, registryStatus = 'aus', jetztMs = 0 } = {}) {
  const v = vorher || {};
  if (lebt) {
    if (busy) {
      const seit = v.busySeitMs || jetztMs;
      return { lampe: 'beschaeftigt', busySeitMs: seit, busy_sekunden: Math.max(0, Math.round((jetztMs - seit) / 1000)), totSeitMs: 0 };
    }
    return { lampe: 'bereit', busySeitMs: 0, busy_sekunden: 0, totSeitMs: 0 };
  }
  // Prozess weg. Tot bleibt tot, bis jemand neu startet (die Konsole zieht die Registry eine Runde später selbst auf
  // „aus“ — das ist kein Stopp des Menschen). Neu tot = Registry sagt noch „laeuft“, also hat niemand Stop gedrückt.
  if (v.lampe === 'tot') return { lampe: 'tot', busySeitMs: 0, busy_sekunden: 0, totSeitMs: v.totSeitMs || jetztMs };
  if (registryStatus === 'laeuft') return { lampe: 'tot', busySeitMs: 0, busy_sekunden: 0, totSeitMs: jetztMs };
  return { lampe: 'aus', busySeitMs: 0, busy_sekunden: 0, totSeitMs: 0 };
}

/** Laufende Uhr „0:47“, „1:30“, „1:02:03“. */
export function uhrText(sekunden) {
  const s = Math.max(0, Math.floor(Number(sekunden) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Kurzer Text für Tooltip/Mobil-Liste. */
export function lampenText(lampe, busySekunden = 0) {
  if (lampe === 'beschaeftigt') return `arbeitet seit ${uhrText(busySekunden)}`;
  if (lampe === 'bereit') return 'bereit';
  if (lampe === 'tot') return 'Fenster ist abgestürzt — neu starten';
  return 'aus';
}

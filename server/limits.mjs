// server/limits.mjs — reine Schutz-Helfer (kein I/O): Rate-Limit + Größen-Check.
// Prinzip wie im Kern: klein, testbar, fail-safe. Zeit wird injiziert (now), nie Date.now() im Kern.
//
//   const lim = createLimiter({ limit: 10, windowMs: 60_000 });
//   lim.check('1.2.3.4', now) → { ok: true } | { ok: false, retryAfterS: 42 }
//
// Sliding Window: je Schlüssel die Zeitstempel der letzten Treffer; alles außerhalb des Fensters
// fällt raus. Speicher bleibt klein: leere Schlüssel werden beim nächsten Check entsorgt.

export function createLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const treffer = new Map(); // key -> number[] (Zeitstempel ms)
  return {
    check(key, now = Date.now()) {
      const k = String(key || 'unbekannt');
      const liste = (treffer.get(k) || []).filter((t) => now - t < windowMs);
      if (liste.length >= limit) {
        treffer.set(k, liste);
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((liste[0] + windowMs - now) / 1000)) };
      }
      liste.push(now);
      treffer.set(k, liste);
      // Aufräumen (fail-safe, günstig): alte Schlüssel ohne aktuelle Treffer entfernen.
      if (treffer.size > 1000) for (const [kk, l] of treffer) if (!l.some((t) => now - t < windowMs)) treffer.delete(kk);
      return { ok: true };
    },
    size() { return treffer.size; },
  };
}

/** Größen-Check für Uploads: contentLength (Header, kann fehlen/0) gegen max Bytes. */
export function groesseErlaubt(contentLength, maxBytes) {
  const n = Number(contentLength);
  if (!Number.isFinite(n) || n <= 0) return true; // unbekannt → beim Streamen zählen
  return n <= maxBytes;
}

/** Client-ID für idempotentes Senden säubern: nur [A-Za-z0-9_.:-], max 64 Zeichen, sonst null. */
export function clientIdSauber(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(s) ? s : null;
}

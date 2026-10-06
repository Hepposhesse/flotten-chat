// test_lampen.mjs — Fenster-Lampen (v1.1): Busy-Urteil nie null, Reducer beschaeftigt/bereit/aus/tot, Uhr.
import { tuiUrteil, lampenStand, uhrText, lampenText, LAMPEN } from './server/lampen.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);

// ── tuiUrteil: busy ⇔ laufende Klammer-Zeit mit „·“ ──
eq(tuiUrteil('✻ Inferring… (1m 30s · ↑ 3.4k tokens · esc to interrupt)'), 'busy', 'Klammer-Zeit mit Minuten');
eq(tuiUrteil('✻ Stillsinking… (47s · thinking)'), 'busy', '47s-Beispiel');
eq(tuiUrteil('Inferring… (12s · esc to interrupt)'), 'busy', 'ohne Glyph');
eq(tuiUrteil('✻ Inferring… (12s · esc to interrupt)\n  ⏵⏵ auto mode on · esc to interrupt'), 'busy', 'busy trotz Hint-Leiste');
eq(tuiUrteil('✻ Cooked for 37s · 1 shell still running'), 'idle', 'Vergangenheit „Cooked for“ ist idle');
eq(tuiUrteil('Worked for 3m 44s'), 'idle', '„Worked for“ ist idle');
eq(tuiUrteil('✻ Reticulating…'), 'idle', 'Glyph ohne Zeit');
eq(tuiUrteil('Inferring… (12s)'), 'idle', 'Klammer ohne · ist kein Zähler');
eq(tuiUrteil('tested for 3 users … esc to interrupt'), 'idle', '„esc to interrupt“ allein');
eq(tuiUrteil('❯ '), 'idle', 'nur Prompt');
eq(tuiUrteil('❯ \n───\n  ⏵⏵ auto mode on (shift+tab to cycle) · gh auth login · esc to interrupt'), 'idle', 'Prompt + Hint-Leiste');
eq(tuiUrteil(''), 'idle', 'leer → idle, nie null');
eq(tuiUrteil(null), 'idle', 'null → idle, nie null');
eq(tuiUrteil('  ⏵⏵ auto mode on (shift+tab to cycle)'), 'idle', 'nur Hint-Leiste → idle, nie null');

// ── lampenStand: Reducer ──
const t0 = 1_000_000;
let st = lampenStand(null, { lebt: false, busy: false, registryStatus: 'aus', jetztMs: t0 });
eq(st.lampe, 'aus', 'nie gestartet → aus');
st = lampenStand(st, { lebt: true, busy: false, registryStatus: 'aus', jetztMs: t0 + 3000 });
eq(st.lampe, 'bereit', 'läuft, Prompt → bereit');
st = lampenStand(st, { lebt: true, busy: true, registryStatus: 'laeuft', jetztMs: t0 + 6000 });
eq([st.lampe, st.busy_sekunden], ['beschaeftigt', 0], 'erste busy-Runde: beschäftigt, Uhr bei 0');
st = lampenStand(st, { lebt: true, busy: true, registryStatus: 'laeuft', jetztMs: t0 + 53_000 });
eq([st.lampe, st.busy_sekunden], ['beschaeftigt', 47], 'Uhr läuft ab busy-Beginn (47 s)');
st = lampenStand(st, { lebt: true, busy: false, registryStatus: 'laeuft', jetztMs: t0 + 56_000 });
eq([st.lampe, st.busy_sekunden, st.busySeitMs], ['bereit', 0, 0], 'wieder Prompt → bereit, Uhr zurück');
st = lampenStand(st, { lebt: true, busy: true, registryStatus: 'laeuft', jetztMs: t0 + 60_000 });
eq(st.busySeitMs, t0 + 60_000, 'neue busy-Phase startet die Uhr neu');
// Prozess stirbt von selbst: Registry sagt noch „laeuft“ → tot
st = lampenStand(st, { lebt: false, busy: false, registryStatus: 'laeuft', jetztMs: t0 + 63_000 });
eq([st.lampe, st.totSeitMs], ['tot', t0 + 63_000], 'Prozess weg, Registry laeuft → tot');
// Die Konsole zieht die Registry eine Runde später auf „aus“ — das ist kein Stopp des Menschen: tot bleibt tot.
st = lampenStand(st, { lebt: false, busy: false, registryStatus: 'aus', jetztMs: t0 + 66_000 });
eq([st.lampe, st.totSeitMs], ['tot', t0 + 63_000], 'Registry nachgezogen auf aus: bleibt tot, Zeitpunkt bleibt');
let tot = lampenStand({ lampe: 'tot', totSeitMs: 5 }, { lebt: false, busy: false, registryStatus: 'laeuft', jetztMs: 9 });
eq([tot.lampe, tot.totSeitMs], ['tot', 5], 'tot bleibt tot mit altem Zeitpunkt');
eq(lampenStand(null, { lebt: false, registryStatus: 'laeuft', jetztMs: 1 }).lampe, 'tot', 'Serverstart: Registry sagt laeuft, Prozess fehlt → tot');
tot = lampenStand(tot, { lebt: true, busy: false, registryStatus: 'laeuft', jetztMs: 12 });
eq(tot.lampe, 'bereit', 'Neustart → bereit');
// Vom Menschen gestoppt: Stop-Route setzt „aus“ VOR der nächsten Runde → aus, nicht tot
eq(lampenStand({ lampe: 'bereit' }, { lebt: false, registryStatus: 'aus', jetztMs: 1 }).lampe, 'aus', 'gestoppt → aus');
eq(lampenStand({ lampe: 'beschaeftigt', busySeitMs: 1 }, { lebt: false, registryStatus: 'schliesst', jetztMs: 2 }).lampe, 'aus', 'wird geschlossen → aus');
ok(LAMPEN.includes(lampenStand(undefined, {}).lampe), 'ohne alles: eine gültige Lampe');

// ── Uhr ──
eq(uhrText(0), '0:00', '0 s');
eq(uhrText(47), '0:47', '47 s');
eq(uhrText(90), '1:30', '90 s');
eq(uhrText(3723), '1:02:03', 'mit Stunden');
eq(uhrText(-5), '0:00', 'negativ wird 0');
eq(uhrText('abc'), '0:00', 'Unsinn wird 0');
ok(/0:47/.test(lampenText('beschaeftigt', 47)), 'Text für beschäftigt trägt die Uhr');
eq(lampenText('tot'), 'Fenster ist abgestürzt — neu starten', 'Text für tot');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

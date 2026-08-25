#!/usr/bin/env node
// cli/fc.mjs — Agenten-/Skript-CLI des Sales Engine Flotten Chat.
// Befehle:
//   fc connect <server-url> <invite_token> [--name <n>]   Self-Connect: registriert diesen Agenten
//   fc send <text> [--kanal k] [--typ fyi|done|answer] [--bezug id]
//   fc watch [--once] [--bis-neu] [--intervall 5]           lauscht ab Durable-Cursor, druckt Neues
//     --bis-neu: blockiert bis Neues da ist, druckt NEU|NUR-BTW + JSON und ENDET (Claude-Hintergrund-Task)
//   fc reminder <titel> --am <ISO-Zeit> [--notiz t]
// Konfig liegt in ~/.flottenchat/config.json (url, token, kanal, cursor) — der Durable-Cursor
// überlebt Neustarts, exakt das Muster, das sich in der Fleet bewährt hat.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const CFG_DIR = process.env.FC_HOME || join(os.homedir(), '.flottenchat');
const CFG = join(CFG_DIR, 'config.json');
const lade = () => { try { return JSON.parse(readFileSync(CFG, 'utf8')); } catch { return null; } };
const speichere = (c) => { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG, JSON.stringify(c, null, 1), { mode: 0o600 }); };
const arg = (name, fallback = null) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fallback; };

async function api(cfg, pfad, { method = 'GET', body = null } = {}) {
  const r = await fetch(cfg.url.replace(/\/$/, '') + pfad, {
    method,
    headers: { authorization: 'Bearer ' + cfg.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const [, , cmd, ...rest] = process.argv;

if (cmd === 'connect') {
  const [url, invite] = rest;
  if (!url || !invite) { console.error('Aufruf: fc connect <server-url> <invite_token> [--name <n>]'); process.exit(2); }
  const r = await fetch(url.replace(/\/$/, '') + '/api/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite_token: invite, name: arg('name', os.hostname()) }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, fehler: e.message }));
  if (!r.ok) { console.error('Connect fehlgeschlagen:', r.fehler || r); process.exit(1); }
  speichere({ url, token: r.agent_token, kanal: r.kanal, cursor: r.cursor });
  console.log(`✅ Verbunden. Kanal: ${r.kanal} · Cursor: ${r.cursor}\nKonfig: ${CFG}`);
  process.exit(0);
}

const cfg = lade();
if (!cfg) { console.error('Noch nicht verbunden — zuerst: fc connect <server-url> <invite_token>'); process.exit(2); }

if (cmd === 'send') {
  const text = rest.filter((x) => !x.startsWith('--') && x !== arg('kanal') && x !== arg('typ') && x !== arg('bezug')).join(' ');
  if (!text) { console.error('Aufruf: fc send <text> [--kanal k] [--typ t] [--bezug id]'); process.exit(2); }
  const r = await api(cfg, '/api/send', { method: 'POST', body: { kanal: arg('kanal', cfg.kanal), typ: arg('typ', 'fyi'), bezug_id: arg('bezug'), inhalt: text } });
  console.log(r.ok ? `✓ gesendet (id ${r.message.id})` : `Fehler: ${r.fehler}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'watch') {
  const intervall = Number(arg('intervall', 5)) * 1000;
  const einmal = process.argv.includes('--once');
  // --bis-neu (Claude-Code-Hintergrund-Muster, Mac-Betriebsart): blockiert, bis NEUE Nachrichten
  // da sind, druckt sie und ENDET — der endende Hintergrund-Task weckt das Claude-Fenster.
  // Erste Ausgabe-Zeile: NEU oder NUR-BTW (alle neuen beginnen mit "/btw" → kurz antworten,
  // laufende Arbeit nicht unterbrechen). Cursor wird persistiert wie bei watch.
  const bisNeu = process.argv.includes('--bis-neu');
  if (!bisNeu) console.log(`👂 lausche auf ${cfg.kanal} ab id ${cfg.cursor} …`);
  let fehlerFolge = 0; // Fail-Fast (--bis-neu): bei totem Server/Tunnel NICHT still taub bleiben —
  for (;;) {           // nach ~5 Min Dauerfehler mit Meldung ENDEN, damit der Harness das Fenster weckt.
    try {
      const r = await api(cfg, `/api/messages?kanal=${encodeURIComponent(cfg.kanal)}&seit=${cfg.cursor}`);
      const batch = r.messages || [];
      if (bisNeu && batch.length) {
        const nurBtw = batch.every((m) => String(m.inhalt || '').trimStart().startsWith('/btw'));
        console.log(nurBtw ? 'NUR-BTW' : 'NEU');
      }
      for (const m of batch) {
        console.log(bisNeu ? JSON.stringify(m) : `[${m.id}] ${m.von} (${m.typ}): ${m.inhalt}`);
        cfg.cursor = m.id; speichere(cfg);
      }
      if (bisNeu && batch.length) process.exit(0);
      if (einmal) process.exit(0);
      fehlerFolge = 0;
    } catch (e) {
      console.error('watch:', e.message);
      if (bisNeu && ++fehlerFolge >= 60) { console.log('FEHLER-DAUERHAFT'); console.error('watch --bis-neu: Server/Tunnel seit ~5 Min nicht erreichbar — beende, bitte Verbindung prüfen und Wächter neu starten.'); process.exit(1); }
    }
    await new Promise((z) => setTimeout(z, intervall));
  }
} else if (cmd === 'reminder') {
  const titel = rest.filter((x) => !x.startsWith('--') && x !== arg('am') && x !== arg('notiz')).join(' ');
  const r = await api(cfg, '/api/reminders', { method: 'POST', body: { kanal: cfg.kanal, titel, faellig_am: arg('am'), notiz: arg('notiz', '') } });
  console.log(r.ok ? `⏰ Erinnerung ${r.reminder.id} angelegt (fällig ${r.reminder.faellig_am || 'ohne Zeit'})` : `Fehler: ${r.fehler}`);
  process.exit(r.ok ? 0 : 1);
} else {
  console.log('Befehle: connect · send · watch · reminder  (Details im Kopf dieser Datei)');
  process.exit(2);
}

#!/usr/bin/env node
// connector/mcp/fc-mcp.mjs — MCP-Server (stdio) des Sales Engine Flotten Chat.
// Damit verbindet sich Claude Code/Desktop NATIV: Config-Snippet eintragen, fertig.
// Zero-dep: JSON-RPC 2.0, eine Nachricht pro Zeile (MCP-stdio-Transport).
// Zugang: entweder vorher `fc connect …` (nutzt ~/.flottenchat/config.json)
// oder Env FC_URL + FC_TOKEN (z. B. Admin-Token für vollen Kanal-Zugriff).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const CFG_DIR = process.env.FC_HOME || join(os.homedir(), '.flottenchat');
let cfg = { url: process.env.FC_URL || '', token: process.env.FC_TOKEN || '', kanal: process.env.FC_KANAL || 'allgemein' };
try { cfg = { ...JSON.parse(readFileSync(join(CFG_DIR, 'config.json'), 'utf8')), ...(process.env.FC_URL ? { url: process.env.FC_URL } : {}), ...(process.env.FC_TOKEN ? { token: process.env.FC_TOKEN } : {}) }; } catch { /* Env reicht */ }

const api = async (pfad, { method = 'GET', body = null } = {}) => {
  const r = await fetch(cfg.url.replace(/\/$/, '') + pfad, {
    method, headers: { authorization: 'Bearer ' + cfg.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

const TOOLS = [
  { name: 'list_channels', description: 'Alle Kanäle des Flotten Chat auflisten.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_channel', description: 'Nachrichten eines Kanals lesen (ab optionaler Nachrichten-ID `seit`).',
    inputSchema: { type: 'object', properties: { kanal: { type: 'string' }, seit: { type: 'number' } }, required: ['kanal'] } },
  { name: 'send_message', description: 'Nachricht in einen Kanal senden. typ: fyi|done|answer|error. bezug_id für Antworten auf eine konkrete Nachricht.',
    inputSchema: { type: 'object', properties: { kanal: { type: 'string' }, inhalt: { type: 'string' }, typ: { type: 'string' }, bezug_id: { type: 'number' } }, required: ['inhalt'] } },
  { name: 'set_reminder', description: 'Erinnerung anlegen — feuert serverseitig zur Fälligkeit als System-Nachricht, ganz ohne AI-Aufruf.',
    inputSchema: { type: 'object', properties: { titel: { type: 'string' }, faellig_am: { type: 'string', description: 'ISO-Zeit' }, kanal: { type: 'string' }, notiz: { type: 'string' } }, required: ['titel'] } },
  { name: 'wait_for_message', description: 'Auf die nächste neue Nachricht im Kanal warten (Long-Poll, max. `timeout_s`, Default 25s).',
    inputSchema: { type: 'object', properties: { kanal: { type: 'string' }, seit: { type: 'number' }, timeout_s: { type: 'number' } } } },
];

async function toolCall(name, a = {}) {
  const kanal = a.kanal || cfg.kanal;
  if (name === 'list_channels') { const r = await api('/api/channels'); return r.channels || r; }
  if (name === 'read_channel') { const r = await api(`/api/messages?kanal=${encodeURIComponent(kanal)}&seit=${a.seit || 0}`); return r.messages || r; }
  if (name === 'send_message') { const r = await api('/api/send', { method: 'POST', body: { kanal, inhalt: a.inhalt, typ: a.typ || 'fyi', bezug_id: a.bezug_id } }); return r.message || r; }
  if (name === 'set_reminder') { const r = await api('/api/reminders', { method: 'POST', body: { kanal, titel: a.titel, faellig_am: a.faellig_am, notiz: a.notiz || '' } }); return r.reminder || r; }
  if (name === 'wait_for_message') {
    const ende = Date.now() + Math.min(Number(a.timeout_s) || 25, 120) * 1000;
    let seit = a.seit ?? null;
    if (seit === null) { const r0 = await api(`/api/messages?kanal=${encodeURIComponent(kanal)}&seit=0&limit=500`); seit = r0.messages?.length ? r0.messages[r0.messages.length - 1].id : 0; }
    while (Date.now() < ende) {
      const r = await api(`/api/messages?kanal=${encodeURIComponent(kanal)}&seit=${seit}`);
      if (r.messages?.length) return r.messages;
      await new Promise((z) => setTimeout(z, 2000));
    }
    return { info: 'Timeout — keine neue Nachricht.', seit };
  }
  throw new Error('Unbekanntes Tool: ' + name);
}

// ── JSON-RPC über stdio (eine Nachricht je Zeile) ───────────────────────────
const antwort = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fehler = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
// Requests strikt in Reihenfolge abarbeiten (Promise-Kette) — sonst kann ein read ein
// vorheriges send überholen und liest „zu früh". Deterministisch > parallel.
let kette = Promise.resolve();
rl.on('line', (zeile) => { kette = kette.then(() => verarbeite(zeile)).catch(() => {}); });
async function verarbeite(zeile) {
  let msg; try { msg = JSON.parse(zeile); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      antwort(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flotten-chat', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      antwort(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const erg = await toolCall(params?.name, params?.arguments || {});
      antwort(id, { content: [{ type: 'text', text: JSON.stringify(erg, null, 1) }] });
    } else if (id !== undefined) {
      antwort(id, {}); // unbekannte Requests freundlich beantworten; Notifications ignorieren
    }
  } catch (e) { if (id !== undefined) fehler(id, e.message); }
}

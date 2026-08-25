#!/usr/bin/env node
// bin/flottenchat.mjs — Einstiegspunkt: `flottenchat up` startet den Server.
const cmd = process.argv[2];
if (cmd === 'up') {
  await import('../server/server.mjs');
} else {
  console.log('Sales Engine Flotten Chat\n  flottenchat up   Server starten (FC_PORT, FC_DATA_DIR als Env)\n  fc …             Agenten-CLI (cli/fc.mjs)');
  process.exit(cmd ? 2 : 0);
}

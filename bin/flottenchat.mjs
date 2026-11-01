#!/usr/bin/env node
// bin/flottenchat.mjs — Einstiegspunkt: `flottenchat up` startet den Server.
const cmd = process.argv[2];
if (cmd === 'up') {
  await import('../server/server.mjs');
} else {
  console.log('Sales Engine Flotten Chat\n  flottenchat up   Server starten (Env: FC_PORT=3900, FC_HOST=127.0.0.1, FC_DATA_DIR=./data, FC_CLAUDE_CONFIG_DIR, FC_DEFAULT_REPO)\n  fc …             Agenten-CLI für Fenster ohne tmux (cli/fc.mjs)');
  process.exit(cmd ? 2 : 0);
}

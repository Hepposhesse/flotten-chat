// test_geraete.mjs — Geräte koppeln (server/geraete.mjs): reine Logik. Muster: pass/fail-Zähler.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PORT_BASIS, geraetSlug, geraeteListe, freierPort, codeAus, codeFormOk, geraetAnlegen, geraetZumCode, pubkeyOk,
  geraetAnmelden, authorizedKeys, knownHosts, sshArgs, geraetOeffentlich, abgelaufeneRaus, einfuegeBlock,
  einrichtungsSkript, tunnelUebergaenge, vorText,
} from './server/geraete.mjs';

let pass = 0, fail = 0;
const ok = (b, m) => { if (b) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`);
const T = new Date('2026-10-04T15:00:00Z');
const BYTES = [1, 2, 3, 4, 5, 6, 7, 8];
const PK = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7bXr0m3JpN0Jd3o4Wm8u0q1L2c3H5f6K7l8M9n0Pq anna@air';
const HK = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9u0v1w';

// ── Slug, Liste, Port, Code ──
eq(geraetSlug('Annas MacBook Air'), 'annas-macbook-air', 'Slug');
eq(geraetSlug('Büro-Rechner Ü'), 'buero-rechner-ue', 'Umlaute');
eq(geraeteListe([{ id: 'air', name: 'Air' }, null, { name: 'ohne id' }, { id: '../x' }]).map((g) => g.id), ['air'], 'kaputte Einträge raus');
eq(freierPort([]), PORT_BASIS, 'erster Port');
eq(freierPort([{ port: PORT_BASIS }, { port: PORT_BASIS + 1 }]), PORT_BASIS + 2, 'nächster freier Port');
eq(freierPort([{ port: PORT_BASIS }], [PORT_BASIS + 1]), PORT_BASIS + 2, 'lauschender fremder Port wird übersprungen');
ok(codeFormOk(codeAus(BYTES)) && codeAus(BYTES).length === 8, 'Code 8 Zeichen, gültige Form');
ok(!codeFormOk('abc') && !codeFormOk('ABCDEFGH') && !codeFormOk('abcdefg0') && !codeFormOk('../etc/p'), 'kaputte Codes abgelehnt');

// ── Anlegen, Code, Anmelden ──
const g = geraetAnlegen([], { name: 'Annas MacBook Air', zufall: BYTES, jetzt: T }).geraet;
ok(g && g.id === 'annas-macbook-air' && g.status === 'wartet' && g.port === PORT_BASIS, 'neues Gerät wartet mit Port');
eq(g.code_bis, '2026-10-04T15:30:00.000Z', 'Code gilt 30 Minuten');
eq(geraetAnlegen([], { name: '', zufall: BYTES, jetzt: T }).fehler, 'Name fehlt.', 'ohne Name');
eq(geraetAnlegen([], { name: 'Lokal', zufall: BYTES, jetzt: T }).geraet.id, 'lokal-geraet', 'reservierte id wird umgangen');
eq(geraetAnlegen([g], { name: 'Annas MacBook Air', zufall: BYTES, jetzt: T }).geraet.id, 'annas-macbook-air-2', 'doppelter Name → -2');
ok(geraetZumCode([g], g.code, T) === g, 'Code findet das Gerät');
ok(geraetZumCode([g], g.code, new Date('2026-10-04T15:31:00Z')) === null, 'abgelaufener Code → null');
ok(geraetZumCode([g], 'zzzzzzzz', T) === null, 'fremder Code → null');
eq(abgelaufeneRaus([g], new Date('2026-10-04T15:31:00Z')), [], 'abgelaufenes Warten fliegt raus');
ok(pubkeyOk(PK) && pubkeyOk(HK) && !pubkeyOk('ssh-rsa AAAAB3') && !pubkeyOk(PK + '\nssh-ed25519 X') && !pubkeyOk('command="x" ' + PK), 'pubkeyOk');
const anm = { pubkey: PK, hostkey: HK + ' root@air', nutzer: 'anna', heimordner: '/Users/anna', tmux: '/opt/homebrew/bin/tmux', system: 'macos' };
const a = geraetAnmelden(g, anm, T).geraet;
ok(a && a.status === 'gekoppelt' && a.ssh_ziel === 'anna@127.0.0.1' && a.system === 'macos', 'Anmeldung koppelt');
eq(a.tunnel_key, PK.split(' ').slice(0, 2).join(' '), 'Kommentar vom Schlüssel abgeschnitten');
eq(a.host_key, HK, 'Host-Schlüssel ohne Kommentar');
eq(geraetAnmelden(g, { ...anm, system: 'linux', heimordner: '/home/anna', tmux: '/usr/bin/tmux' }, T).geraet.system, 'linux', 'Linux-Gerät');
ok(geraetZumCode([a], g.code, T) === null && geraetZumCode([a], g.code, T, { nurWartend: false }) === a, 'Code nach Kopplung nur noch für den Status');
ok(geraetAnmelden(a, anm, T).fehler, 'zweite Anmeldung abgelehnt');
ok(geraetAnmelden(g, { ...anm, pubkey: 'quatsch' }, T).fehler, 'kaputter Schlüssel abgelehnt');
ok(geraetAnmelden(g, { ...anm, hostkey: '' }, T).fehler, 'ohne Host-Schlüssel abgelehnt');
ok(geraetAnmelden(g, { ...anm, nutzer: 'an na;rm' }, T).fehler, 'Nutzer mit Sonderzeichen abgelehnt');
ok(geraetAnmelden(g, { ...anm, heimordner: '/Users/../etc' }, T).fehler, 'Heimordner mit .. abgelehnt');
ok(geraetAnmelden(g, { ...anm, heimordner: "/Users/a'nna" }, T).fehler, 'Heimordner mit Hochkomma abgelehnt');
ok(geraetAnmelden(g, { ...anm, tmux: '' }, T).fehler, 'ohne tmux-Pfad abgelehnt');

// ── Schlüsselzeilen, known_hosts, ssh ──
const zeilen = authorizedKeys([a, g]).split('\n').filter((z) => z && !z.startsWith('#'));
eq(zeilen.length, 1, 'nur gekoppelte Geräte');
ok(zeilen[0].startsWith(`restrict,port-forwarding,permitlisten="127.0.0.1:${PORT_BASIS}",command="/bin/false" ssh-ed25519 `), 'Zeile eng begrenzt auf den eigenen Port');
ok(zeilen[0].endsWith(' fc-geraet-annas-macbook-air'), 'Kommentar = Gerät');
eq(knownHosts([a]).trim(), `[127.0.0.1]:${PORT_BASIS} ${HK}`, 'known_hosts je Tunnel-Port');
const sa = sshArgs(a, { schluessel: '/d/k', knownHostsDatei: '/d/kh' });
ok(sa.includes('StrictHostKeyChecking=yes') && sa.includes('UserKnownHostsFile=/d/kh') && sa[sa.indexOf('-p') + 1] === String(PORT_BASIS) && sa[sa.length - 1] === 'anna@127.0.0.1', 'ssh durch den Tunnel, Host-Schlüssel fest');
const oe = geraetOeffentlich({ ...a, code: 'x' }, { tunnelOffen: true });
ok(oe.offen === true && !('tunnel_key' in oe) && !('code' in oe) && !('host_key' in oe), 'öffentliche Sicht ohne Schlüssel/Code');

// ── Wächter ──
eq(tunnelUebergaenge({}, { [a.id]: false }, [a]).length, 1, 'erster Lauf: geschlossener Tunnel wird gemeldet');
eq(tunnelUebergaenge({}, { [a.id]: true }, [a]).length, 0, 'erster Lauf: offener Tunnel still');
ok(/wieder erreichbar/.test(tunnelUebergaenge({ [a.id]: false }, { [a.id]: true }, [a])[0].text), 'wieder offen → Meldung');
eq(tunnelUebergaenge({ [a.id]: true }, { [a.id]: true }, [a]).length, 0, 'kein Wechsel → still');
eq(vorText('2026-10-04T13:00:00Z', T.getTime()), 'vor 2 h', 'vorText');

// ── Einfüge-Block + Skript ──
const blk = einfuegeBlock({ code: g.code, basisUrl: 'https://chat.example.org', name: 'Air' });
ok(blk.includes(`https://chat.example.org/geraet/${g.code}`) && /30 Minuten/.test(blk), 'Einfüge-Block mit URL und Hinweis');
const sk = einrichtungsSkript({ code: g.code, port: PORT_BASIS, host: 'chat.example.org', basisUrl: 'https://chat.example.org', serverPubKey: PK, serverHostKey: HK, name: 'Air"; rm -rf /', tmuxSocket: 'flottenchat', tunnelNutzer: 'fcgeraet' });
ok(!/rm -rf \//.test(sk.split('\n')[1]), 'Name im Skript entschärft');
ok(sk.includes(`-R "127.0.0.1:$PORT:127.0.0.1:22"`) && sk.includes('"fcgeraet@$HOST"'), 'Rückkanal auf eigenen Port, Tunnel-Nutzer');
ok(sk.includes('from="127.0.0.1,::1"'), 'Server-Schlüssel nur durch den Tunnel');
ok(sk.includes('LaunchAgents') && sk.includes('systemctl --user'), 'macOS und Linux');
ok(einrichtungsSkript({ code: g.code, port: PORT_BASIS, host: 'h', sshPort: 2222, basisUrl: 'https://h', serverPubKey: PK, serverHostKey: HK, name: 'x' }).includes("SERVER_HOSTKEY='[h]:2222 "), 'ssh-Port ≠ 22 im known_hosts-Format');
ok(einrichtungsSkript({ code: g.code, port: PORT_BASIS, host: 'h', basisUrl: 'https://h', serverPubKey: PK, serverHostKey: HK, name: 'x', tunnelNutzer: 'x;y' }).includes('"fcgeraet@$HOST"'), 'ungültiger Tunnel-Nutzer → Standard');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcg-'));
fs.writeFileSync(path.join(dir, 's.sh'), sk);
try { execFileSync('bash', ['-n', path.join(dir, 's.sh')]); ok(true, ''); } catch { ok(false, 'Skript ist gültiges bash'); }
fs.rmSync(dir, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

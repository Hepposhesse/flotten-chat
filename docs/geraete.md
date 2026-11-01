# Geräte koppeln

Fenster laufen nicht nur auf dem Chat-Server: jeder Mac, Linux-Server oder Laptop kann ein **Gerät** werden.
Das Gerät öffnet einen Rückkanal zum Chat-Server — kein offener Port am Gerät, keine VPN-Pflicht, kein
Schlüssel-Hin-und-her von Hand. Danach wählst du es im Bereich (**＋ → Bereich anlegen/✎ → Ort**) oder im einzelnen Fenster wie „Dieser Server“.

## Einmal auf dem Chat-Server (root)

```bash
sudo bash bin/geraete-server-einrichten.sh <datenverzeichnis> <server-nutzer>
```

Legt den Tunnel-Nutzer `fcgeraet` an und sperrt ihn per sshd auf reine Rückkanäle: keine Shell, kein `-L`,
kein Passwort, je Schlüssel nur der eigene Port (`permitlisten`). Die Schlüssel liest sshd per
`AuthorizedKeysCommand` aus `<datenverzeichnis>/geraete-authorized-keys` — der Chat-Server pflegt die Datei
und muss dafür **nicht** als root laufen. Ist `fcgeraet` schon belegt: dritter Parameter (z. B. `fckit`) und
im Chat-Server `FC_GERAETE_NUTZER=fckit`.

Umgebung (optional): `FC_PUBLIC_URL` (Adresse, unter der Geräte den Chat erreichen; sonst aus der Anfrage),
`FC_GERAETE_HOST` (ssh-Host für den Tunnel; sonst der Host aus der Adresse), `FC_GERAETE_SSH_PORT` (Standard 22),
`FC_GERAETE_PORT_BASIS` (erster Tunnel-Port, Standard 22101; Ports, auf denen schon etwas lauscht, werden übersprungen —
wichtig, wenn mehrere Instanzen auf einem Server laufen).

Getestet: Linux-Gerät im Container (inkl. Sperrproben) und ein MacBook mit macOS 15.5 (LaunchAgent, Fenster, Entfernen).
Hinter einem Reverse-Proxy muss `/geraet/` mit durchgereicht werden.

## Ein Gerät koppeln

1. **＋ → „Gerät koppeln …“** (oder im Ort-Feld „＋ Gerät koppeln …“), Namen eingeben → Einmal-Code (30 Minuten) und ein Textblock.
2. Den Textblock **am Gerät in Claude Code einfügen**. Claude lädt das Einrichtungs-Skript, erklärt es, führt
   es aus und führt dich durch fehlende Schritte (macOS: „Entfernte Anmeldung“ einschalten; Linux: sshd).
3. Das Skript prüft tmux/Claude Code/sshd, erzeugt einen Schlüssel, meldet ihn per Code an, trägt den
   Server-Schlüssel mit `from="127.0.0.1,::1"` ein (gilt nur durch den Tunnel) und richtet den Tunnel dauerhaft
   ein: macOS als LaunchAgent, Linux als `systemd --user`-Dienst (für Betrieb ohne Anmeldung einmal
   `sudo loginctl enable-linger <nutzer>`), ohne systemd als Hintergrund-Schleife.
4. Der Dialog meldet „✓ gekoppelt und erreichbar“. Fenster auf dem Gerät arbeiten in `~/fleet-themen/<name>`.

## Betrieb

- **Status** im Ort-Menü: 🟢 erreichbar · 🔴 nicht erreichbar (mit „zuletzt …“), dann ist der Ort gesperrt.
  Geht ein Tunnel zu oder wieder auf, steht es im Kanal **Alarm**.
- **Entfernen** (im Geräte-Dialog): erst die Fenster dort schließen. Der Schlüssel fliegt sofort raus, ein neuer
  Tunnel wird abgewiesen. Den gerade offenen Tunnel kappt der Server nur, wenn er die Rechte dazu hat (root);
  sonst endet er beim nächsten Verbindungsabbruch. Am Gerät räumt `bash /tmp/fleet-geraet.sh --entfernen` auf.
- Der Host-Schlüssel des Geräts wird bei der Kopplung festgehalten (`geraete-known-hosts`) — ein anderer
  Rechner kann sich nicht als das Gerät ausgeben.

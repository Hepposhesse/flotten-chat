# Fernzugriff: Reverse-Proxy mit TLS (Beispiel)

Der Server bindet standardmäßig auf `127.0.0.1:3900`. Für den Zugriff vom Handy oder von anderen
Rechnern gibt es zwei saubere Wege — beide lassen den Server selbst auf localhost:

## A) SSH-Tunnel (kein Proxy nötig)
```bash
ssh -N -L 3900:127.0.0.1:3900 user@server        # danach http://localhost:3900 im Browser
autossh -M 0 -f -N -L 3900:127.0.0.1:3900 user@server   # dauerhaft (macOS: brew install autossh)
```

## B) nginx als TLS-Reverse-Proxy (mit Basic-Auth vor der UI)
```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.org;
  ssl_certificate     /etc/letsencrypt/live/chat.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.org/privkey.pem;

  # Die statische UI zusätzlich hinter Basic-Auth (die API selbst ist token-geschützt).
  location = / { auth_basic "Flotten Chat"; auth_basic_user_file /etc/nginx/.htpasswd-flottenchat; proxy_pass http://127.0.0.1:3900; }

  location / {
    proxy_pass http://127.0.0.1:3900;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    # SSE (/api/events): kein Puffern, lange Verbindungen erlauben
    proxy_buffering off;
    proxy_read_timeout 3600s;
    # Uploads: Größe zum Server-Limit passend (FC_MEDIA_MAX_MB, Default 200)
    client_max_body_size 200m;
  }
}
```
Hinweise: `FC_HOST` bleibt `127.0.0.1` (der Proxy spricht lokal mit dem Server). Das Rate-Limit
je IP auf `/api/connect` sieht hinter dem Proxy die Proxy-Adresse — wer das je Client will,
setzt ein `limit_req` in nginx davor. Für die Handy-Nutzung reicht meist Weg A.

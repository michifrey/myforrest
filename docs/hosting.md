# Eigener Server: VPS, Synology und Render

Drei Wege, MyForrest dauerhaft unter einer eigenen HTTPS-Adresse zu betreiben, damit Handy, Browser und die
[Android-App](android.md) es jederzeit erreichen. Beide nutzen das `Dockerfile` des Repositorys und eine
fertige Vorlage im Repository. Zum blossen Ausprobieren auf dem eigenen PC reicht ein
[Cloudflare Tunnel](installation.md#zum-testen-server-auf-dem-eigenen-pc-mit-cloudflare-tunnel).

| | VPS (gemieteter Server) | Synology NAS | Render (Plattform) |
|---|---|---|---|
| Kosten | ab etwa 5 Franken/Euro im Monat | vorhandenes Gerät | Plan *Starter* plus Disk, nach Preisliste von Render |
| HTTPS | Caddy holt das Zertifikat selbst | Reverse Proxy von DSM mit Let's Encrypt, oder Cloudflare Tunnel | von Render, mit Adresse `….onrender.com` |
| Aktualisieren | `git pull` und neu bauen | ZIP kopieren und neu erstellen | **automatisch bei jedem Push auf `main`** |
| Grenzen | keine | Leistung des NAS | Grösse und Dauer von Uploads nach den Regeln von Render; eine Instanz |
| Vorlage | [`deploy/vps`](https://github.com/michifrey/myforrest/tree/main/deploy/vps) | [`deploy/synology`](https://github.com/michifrey/myforrest/tree/main/deploy/synology) | [`render.yaml`](https://github.com/michifrey/myforrest/blob/main/render.yaml) |

Für eine kleine Instanz genügen **2 CPU-Kerne, 2–4 GB RAM** und Platz für die Fotos (rund 5 GB pro 1000 Fotos,
siehe [Tech-Onboarding](tech-onboarding.md#2-speicherplatz)). Vor einem öffentlichen Betrieb
[Betrieb und Datenschutz](betrieb.md#vor-einem-öffentlichen-betrieb) lesen.

## VPS mit Docker und Caddy

### 1. Server mieten

Einen kleinen Linux-Server (VPS) mit **Ubuntu 24.04** mieten, z. B. bei Infomaniak (Schweiz), Hetzner oder
Exoscale; 2 vCPU, 4 GB RAM und 40 GB Speicher reichen für den Anfang. Beim Anlegen einen SSH-Schlüssel hinterlegen.
Der Anbieter nennt die **IP-Adresse** des Servers.

### 2. Adresse (DNS)

Beim Anbieter der Domain einen **A-Eintrag** anlegen, z. B. `app.example.org` → IP des Servers (bei IPv6 auch
einen AAAA-Eintrag). Ohne eigene Domain geht auch ein kostenloser DNS-Dienst wie
[DuckDNS](https://www.duckdns.org/) (`meinwald.duckdns.org`). Die Adresse muss auf den Server zeigen, bevor
MyForrest startet, sonst kann Caddy kein Zertifikat holen.

### 3. Docker installieren

Auf dem Server anmelden (`ssh root@<IP>`, unter Windows in PowerShell) und:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

### 4. MyForrest holen und einstellen

```bash
git clone https://github.com/michifrey/myforrest.git /opt/myforrest
cd /opt/myforrest/deploy/vps
nano .env
```

In `.env` mindestens die Adresse eintragen:

```ini
DOMAIN=app.example.org
# optional:
ADMIN_EMAIL=du@example.org
SMTP_URL=smtps://user:passwort@smtp.example.org
MAIL_FROM=MyForrest <wald@example.org>
```

Ohne `SMTP_URL` verschickt MyForrest keine E-Mails; die Bestätigungslinks stehen dann im Log (siehe unten). Weitere
Einstellungen stehen unter [Umgebungsvariablen](installation.md#umgebungsvariablen) und gehören in
`docker-compose.yml` unter `environment`.

### 5. Starten

```bash
docker compose up -d --build
```

Der erste Start baut das Image (einige Minuten) und holt das Zertifikat. Danach ist MyForrest unter
`https://app.example.org` erreichbar; HTTP leitet Caddy auf HTTPS um. Die Daten (Datenbank, Fotos) liegen in
`/opt/myforrest/deploy/vps/data`.

```bash
docker compose ps                  # beide Dienste "running"?
docker compose logs -f myforrest   # Log, z. B. für Bestätigungslinks ohne SMTP
docker compose logs caddy          # Zertifikat geholt?
```

Das erste registrierte Konto (oder das mit `ADMIN_EMAIL`) wird Admin.

### 6. Aktualisieren und sichern

```bash
cd /opt/myforrest && git pull && cd deploy/vps && docker compose up -d --build
```

Für ein Backup kurz anhalten und den Ordner `data` kopieren (z. B. mit `restic` oder `rsync` auf einen anderen
Rechner):

```bash
docker compose stop myforrest
tar czf /root/myforrest-$(date +%F).tar.gz data
docker compose start myforrest
```

### Für die Android-App

Die Adresse in der App eingeben, oder sie fest einbauen: auf GitHub die Variable `APP_URL` =
`https://app.example.org` setzen, dann bringt das nächste Release sie mit (siehe
[Android-App → Auf GitHub](android.md#auf-github)).

## Synology NAS mit Container Manager

Geht auf Modellen mit **Container Manager** (DSM 7.2, die meisten „+“-Modelle mit Intel/AMD- oder
ARM64-Prozessor) und mindestens 2 GB RAM, besser 4 GB.

### 1. Container Manager und Ordner

1. *Paket-Zentrum* → **Container Manager** installieren.
2. In der *File Station* im freigegebenen Ordner `docker` den Ordner `myforrest` anlegen.
3. Auf GitHub unter *Code → Download ZIP* den Quellcode laden, entpacken und den Inhalt (der Ordner mit
   `Dockerfile`, `package.json` usw.) als **`docker/myforrest/app`** auf das NAS kopieren.
4. Die Datei [`deploy/synology/docker-compose.yml`](https://github.com/michifrey/myforrest/blob/main/deploy/synology/docker-compose.yml)
   nach `docker/myforrest/docker-compose.yml` kopieren und darin `PUBLIC_URL` auf die spätere Adresse setzen
   (Schritt 3), bei Bedarf `ADMIN_EMAIL` und `SMTP_URL` einkommentieren.

```text
docker/myforrest/
  docker-compose.yml
  app/            der Quellcode (mit Dockerfile)
  data/           entsteht beim ersten Start: Datenbank und Fotos
```

### 2. Projekt starten

*Container Manager → Projekt → Erstellen*: Name `myforrest`, Pfad `docker/myforrest`, Quelle *Vorhandene
docker-compose.yml verwenden* → *Weiter* → *Fertig*. Der Container Manager baut das Image (beim ersten Mal
einige Minuten) und startet es. Im Heimnetz ist MyForrest danach unter `http://<IP des NAS>:3000` erreichbar,
noch ohne HTTPS.

### 3. HTTPS von aussen

Für Handy und App braucht es HTTPS unter einer Adresse, die auch unterwegs geht. Zwei Varianten:

**A. Reverse Proxy von DSM mit Let's Encrypt** (braucht Port-Weiterleitung im Router)

1. *Systemsteuerung → Externer Zugriff → DDNS*: einen Namen bei Synology anlegen, z. B. `meinwald.synology.me`
   (oder die eigene Domain auf die Adresse des Anschlusses zeigen lassen).
2. Im **Router** die Ports **80 und 443** auf das NAS weiterleiten.
3. *Systemsteuerung → Sicherheit → Zertifikat → Hinzufügen*: neues Zertifikat von **Let's Encrypt** für
   `myforrest.meinwald.synology.me` (oder `meinwald.synology.me`).
4. *Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy → Erstellen*:
    - Quelle: Protokoll **HTTPS**, Hostname `myforrest.meinwald.synology.me`, Port **443**
    - Ziel: Protokoll **HTTP**, Hostname `localhost`, Port **3000**
5. *Zertifikat → Einstellungen*: dem neuen Reverse-Proxy-Eintrag das Let's-Encrypt-Zertifikat zuweisen.

`PUBLIC_URL` in der Compose-Datei auf `https://myforrest.meinwald.synology.me` setzen und das Projekt neu
starten (*Projekt → Aktion → Neu erstellen*).

**B. Cloudflare Tunnel** (ohne Port-Weiterleitung, braucht eine Domain bei Cloudflare)

1. Im Cloudflare-Dashboard *Zero Trust → Networks → Tunnels → Create a tunnel* (Typ *Cloudflared*), Namen
   vergeben und das angezeigte **Token** kopieren.
2. Unter *Public Hostname*: `app.example.org` → Service `http://myforrest:3000`.
3. In `docker-compose.yml` einen zweiten Dienst ergänzen und das Projekt neu erstellen:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: "<Token aus Schritt 1>"
```

`PUBLIC_URL` auf `https://app.example.org` setzen. Die Port-Freigabe `3000:3000` kann dann entfallen.

### 4. Aktualisieren und sichern

- **Aktualisieren:** neuen ZIP-Download in `docker/myforrest/app` kopieren (alten Inhalt ersetzen, `data` nicht
  anfassen), dann *Projekt → Aktion → Neu erstellen*.
- **Sichern:** den Ordner `docker/myforrest/data` mit **Hyper Backup** sichern, am besten mit kurz gestopptem
  Projekt (*Aktion → Stoppen*), damit die Datenbank in sich stimmig ist.

## Render mit GitHub

[Render](https://render.com) baut MyForrest aus dem `Dockerfile` direkt aus GitHub und deployt jeden Push auf
`main` neu. Die Vorlage [`render.yaml`](https://github.com/michifrey/myforrest/blob/main/render.yaml) (ein
*Blueprint*) legt alles fest: Docker, Region Frankfurt, Gesundheitsprüfung auf `/api/config` und eine **Disk**
von 10 GB unter `/app/data` für Datenbank und Fotos. Ohne Disk wären die Daten nach jedem Deploy weg; der
kostenlose Plan hat keine, darum steht in der Vorlage der Plan *Starter*.

1. Im [Dashboard von Render](https://dashboard.render.com) **New → Blueprint** wählen.
2. GitHub verbinden (falls noch nicht geschehen) und das Repository **myforrest** auswählen. Render findet
   `render.yaml` und zeigt den Dienst `myforrest` mit Disk an.
3. Die Felder `ADMIN_EMAIL` und `SMTP_URL` ausfüllen oder leer lassen, dann **Apply** (bzw. *Deploy Blueprint*).
4. Der erste Build dauert einige Minuten. Danach ist MyForrest unter `https://myforrest-….onrender.com`
   erreichbar (die Adresse steht oben im Dienst). Diese Adresse übernimmt MyForrest selbst als `PUBLIC_URL`
   (aus `RENDER_EXTERNAL_URL`).
5. Konto anlegen: ohne `SMTP_URL` steht der Bestätigungslink unter **Logs** im Dienst.

Weitere Einstellungen ([Umgebungsvariablen](installation.md#umgebungsvariablen)) im Dienst unter
**Environment**; eine eigene Domain unter **Settings → Custom Domains** (dann `PUBLIC_URL` auf diese Adresse
setzen). Mit vielen Fotos oder Videos ist der Plan *Starter* (512 MB RAM) knapp; im Dienst unter
**Settings → Instance Type** grösser wählen. Für Backups der Disk die Snapshots von Render nutzen (siehe deren Doku zu *Persistent Disks*).

Für die App: die Adresse in der App eingeben oder auf GitHub als Variable `APP_URL` hinterlegen.

## Wenn etwas nicht geht

| Zeichen | Ursache und Abhilfe |
|---------|---------------------|
| Browser: Zertifikatsfehler | Die Adresse zeigt (noch) nicht auf den Server, oder Port 80 ist zu: Caddy bzw. Let's Encrypt kann das Zertifikat nicht holen. DNS und Firewall/Router prüfen, Log von Caddy ansehen. |
| App: „kein MyForrest-Server“ | Die Adresse zeigt auf etwas anderes (z. B. die DSM-Anmeldung). Den Reverse-Proxy-Eintrag und den Hostnamen prüfen; `https://<adresse>/api/config` im Browser muss JSON zeigen. |
| Anmeldung: zu viele Versuche | Alle Anfragen kommen scheinbar von derselben Adresse: `TRUST_PROXY` fehlt oder passt nicht zum Proxy (Vorlagen: `uniquelocal`). |
| Videos brechen beim Hochladen ab | Der Proxy begrenzt die Grösse oder Dauer von Uploads (Videos bis 4 GB, siehe [Ports](tech-onboarding.md#4-ports)). Caddy hat keine Grenze; bei anderen Proxys anpassen. |
| Keine Bestätigungs-E-Mail | Ohne `SMTP_URL` steht der Link im Log des Containers (`docker compose logs myforrest`, auf dem NAS: *Container → myforrest → Protokoll*). |

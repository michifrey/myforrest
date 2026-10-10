# Tech-Onboarding: MyForrest selbst hosten

Kurzüberblick für alle, die eine eigene Instanz betreiben wollen: was es braucht, wie viel Speicher, welche
Lizenzen, Ports, Zertifikate und ausgehenden Verbindungen. Details zu den Umgebungsvariablen stehen unter
[Installation und Konfiguration](installation.md), Datenschutz und Datenquellen unter [Betrieb](betrieb.md).

## 1. Was es braucht

### Minimal: nur die App

| Komponente | Version | Wofür |
|------------|---------|-------|
| Node.js | ≥ 22.5 | Server (Express, eingebautes `node:sqlite`, keine separate Datenbank) |
| ffmpeg | beliebig aktuell | Einzelbilder aus Videos (GoPro, Dashcam, 360°); ohne ffmpeg gehen nur Fotos |
| Reverse Proxy mit TLS | z. B. Caddy, Traefik, nginx | HTTPS (siehe [Zertifikate](#5-zertifikate)) |

Alternativ das `Dockerfile` im Repository (Node 22 + ffmpeg, Daten im Volume `/app/data`).

```bash
docker build -t myforrest .
docker run -d -p 3000:3000 -v myforrest-data:/app/data \
  -e PUBLIC_URL=https://wald.example.ch -e REQUIRE_LOGIN=1 -e TRUST_PROXY=uniquelocal myforrest
```

### Vollausbau: mit Geodiensten und eigenem Routing

Die Vorlagen [`deploy/qgis-server`](https://github.com/michifrey/myforrest/blob/main/deploy/qgis-server/README.md) (Docker Compose) und
[`deploy/k8s`](https://github.com/michifrey/myforrest/blob/main/deploy/k8s/README.md) (Kubernetes) starten zusätzlich:

| Dienst | Image | Wofür | Nötig? |
|--------|-------|-------|--------|
| MyForrest | aus `Dockerfile` | die App | ja |
| nginx | `nginx:1.27-alpine` | verteilt `/ows/` an QGIS Server, alles andere an MyForrest | nur mit QGIS Server |
| QGIS Server | `qgis/qgis-server:ltr` | WMS, WMTS, WFS für Geoportale (map.geo.admin.ch, QGIS, ArcGIS) | optional |
| Export | `curlimages/curl:8.10.1` | holt alle 15 Minuten das GeoPackage für QGIS Server | nur mit QGIS Server |
| BRouter | aus `deploy/brouter` oder `ghcr.io/michifrey/myforrest-brouter` | Wege-Magnet beim Zeichnen von Touren, ohne `brouter.de` | empfohlen für öffentlichen Betrieb |

### Rechenleistung und Arbeitsspeicher

Richtwerte aus den Kubernetes-Manifesten:

| Dienst | CPU (Request) | RAM (Request / Limit) |
|--------|---------------|-----------------------|
| MyForrest | 0,1 | 256 MiB / 1 GiB |
| QGIS Server | 0,1 | 256 MiB / 1 GiB |
| BRouter | 0,1 | 384 MiB / 768 MiB (Java `-Xmx512M` reicht für die Schweiz) |
| nginx, Export | 0,01 | 32 MiB, 16 MiB |

Für eine kleine Instanz genügt also ein Server mit **2 vCPU und 2–4 GB RAM**. Rechenintensiv sind die
Bildanalyse (Ausrichten, Heatmap) und das Zerlegen von Videos; beides läuft bei Bedarf und profitiert von
mehr Kernen.

### Konten und Schlüssel (alle optional)

- **SMTP-Zugang** für Bestätigungs- und Passwort-Links (`SMTP_URL`); ohne ihn stehen die Links im Server-Log.
- **OAuth-/OIDC-Clients** für Google, GitHub, Microsoft, SWITCH edu-ID, AGOV oder einen eigenen Dienst
  ([Anleitung](installation.md#anmelden-über-google-github-microsoft-und-switch-edu-id)).
- **Pl@ntNet-API-Key** (`PLANTNET_API_KEY`) für die Pflanzenbestimmung.
- **VAPID-Schlüssel** für Push: erzeugt der Server selbst und speichert sie in der Datenbank.

## 2. Speicherplatz

### Images und Programm

| Was | Grösse (ungefähr) |
|-----|-------------------|
| MyForrest-Image (Node 22 slim, ffmpeg, `node_modules` ≈ 160 MB) | 0,6–0,8 GB |
| QGIS Server (`qgis/qgis-server:ltr`) | 1,5–2 GB |
| BRouter-Image (Java 17) | 0,3 GB |
| nginx, curl | je < 50 MB |

### Daten (`DATA_DIR`, im Container `/app/data`)

| Ordner / Datei | Inhalt | Wächst mit | Backup? |
|----------------|--------|------------|---------|
| `myforrest.db` (SQLite) | Spots, Fotos (Metadaten), Konten, Wetter- und Satelliten-Cache, Touren | Anzahl Spots und Fotos; typischerweise einige 10–100 MB | **ja** |
| `uploads/` | Originalfotos, unverändert (inkl. EXIF); HEIC als umgewandeltes JPEG; Einzelbilder aus Videos | **hauptsächlich hier** | **ja** |
| `thumbs/` | Vorschaubilder WebP (320 und 1280 px), ca. 0,1–0,3 MB pro Foto | Anzahl Fotos | nein (entstehen neu) |
| `tiles/` | vorberechnete Vektorkacheln, PMTiles/MBTiles-Export | Anzahl Spots | nein (`npm run tiles`) |
| `tmp/` | Videos während der Verarbeitung; werden danach gelöscht | kurzzeitig bis `VIDEO_MAX_MB` (Standard 4 GB) pro Video | nein |

**Faustregel:** rund **4–6 MB pro Foto** (Handyfoto plus Vorschaubilder), HEIC vom iPhone etwas mehr, weil
sie als JPEG gespeichert werden. Videos selbst werden nicht aufbewahrt, nur die daraus gewählten Einzelbilder.

| Nutzung | Fotos | Platz für Daten |
|---------|-------|-----------------|
| Ausprobieren, eine Person | ~1 000 | ~5 GB |
| Verein, Forstrevier | ~10 000 | ~50 GB |
| Öffentliche Instanz | ~100 000 | ~0,5 TB |

Zusätzlich **freien Platz für mindestens zwei gleichzeitige Video-Uploads** (`tmp/`, je bis 4 GB) einplanen.
Die Kubernetes-Vorlage startet mit 5 GiB für die Daten; das reicht nur zum Testen.

### Weitere Volumes

| Volume | Inhalt | Grösse |
|--------|--------|--------|
| `brouter-segments` | Routing-Daten (Segmente 5° × 5°); Schweiz und Liechtenstein = 2 Segmente | ~0,4 GB (k8s: 2 GiB reserviert) |
| `gis-export` | GeoPackage für QGIS Server | ungefähr so gross wie die Datenbank ohne Bilder |

### Backup

Gesichert werden müssen nur `myforrest.db` und `uploads/` (plus private Schlüssel und Secrets, siehe unten).
Die Datenbank im laufenden Betrieb mit `sqlite3 myforrest.db ".backup backup.db"` sichern, nicht per
Dateikopie. Backups enthalten auch gelöschte Konten, bis sie ersetzt werden (siehe [Betrieb](betrieb.md)).

## 3. Lizenzen

### MyForrest selbst

Der Code steht unter der **Apache-Lizenz 2.0** ([`LICENSE`](https://github.com/michifrey/myforrest/blob/main/LICENSE)): Betrieb, Anpassung und kommerzielle
Nutzung sind erlaubt; Lizenztext und Copyright-Hinweise bleiben erhalten, Änderungen werden gekennzeichnet.

### Abhängigkeiten (npm, Produktion)

| Lizenz | Pakete | Bemerkung |
|--------|--------|-----------|
| MIT, ISC, BSD-2/3-Clause, Apache-2.0, CC0, Zlib | ~135 | freizügig, nur Hinweis nötig |
| **LGPL-3.0** | `libvips` (über `sharp`), `libheif-js` (HEIC) | dynamisch genutzt bzw. unverändert mitgeliefert; bei Weitergabe eines Images den Hinweis und den Zugang zum Quelltext der Bibliotheken sicherstellen |
| **SIL OFL 1.1** | Schriften Fraunces und Manrope (`@fontsource-variable`) | frei nutzbar, nicht einzeln verkaufen |

Prüfen lässt sich das jederzeit mit `npx license-checker-rseidelsohn --production --summary`.

### Weitere Software in den Images

| Software | Lizenz |
|----------|--------|
| ffmpeg (Debian-Paket) | LGPL-2.1+ / GPL-2+ (je nach Build); wird als eigenes Programm aufgerufen, nicht gelinkt |
| QGIS Server | GPL-2.0+ (eigener Container, unverändert) |
| BRouter | MIT |
| nginx | BSD-2-Clause |
| Leaflet, OpenLayers / MapLibre GL JS | BSD-2-Clause / BSD-3-Clause |

### Daten

| Quelle | Lizenz / Bedingung |
|--------|--------------------|
| OpenStreetMap (Kartenkacheln, Routing-Daten) | ODbL, Quellenangabe „© OpenStreetMap-Mitwirkende“; [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) beachten, bei viel Verkehr eigener Kachelanbieter |
| swisstopo (Landeskarte, Luftbild, Kantone) | frei nutzbar mit Quellenangabe © swisstopo |
| Open-Meteo (ERA5) | CC BY 4.0; nicht-kommerziell kostenlos, für kommerziellen Betrieb ein [API-Abo](https://open-meteo.com/en/pricing) |
| Copernicus Sentinel-2, Landsat (USGS) | frei, mit Quellenangabe |
| DWD-Phänologie | frei (GeoNutzV), mit Quellenangabe |
| Pl@ntNet | eigene Nutzungsbedingungen, Kontingent je nach API-Key |
| GLAMOS-Gletscherinventare | Nutzungsbedingungen des Inventars |
| Fotos der Nutzenden | Lizenz pro Foto, Standard CC BY-SA 4.0 |

## 4. Ports

### Von aussen (eingehend)

| Port | Protokoll | Wofür |
|------|-----------|-------|
| **443** | HTTPS | die App, OGC API, `/ows/` (QGIS Server) – der einzige Port, den Nutzende brauchen |
| 80 | HTTP | nur für die Weiterleitung auf HTTPS und die Let's-Encrypt-HTTP-Challenge |

Alles andere bleibt intern.

### Intern (zwischen den Diensten)

| Port | Dienst | Bemerkung |
|------|--------|-----------|
| 3000 | MyForrest (HTTP) | `PORT`; nur für den Reverse Proxy |
| 80 (Host: 8080) | nginx der Compose-Vorlage | davor gehört der TLS-Proxy |
| 5555 | QGIS Server (FastCGI) | nur für nginx |
| 17777 | BRouter (HTTP) | nur für MyForrest (`ROUTER_URL`) |
| 30080 | nginx als NodePort (Kubernetes) | nur lokal/zum Testen |

Uploads sind gross (Videos bis 4 GB): Im Proxy die Body-Grösse entsprechend erlauben (nginx:
`client_max_body_size 4g`) und lange Timeouts setzen (`proxy_read_timeout 600s`), siehe
[`deploy/qgis-server/nginx.conf`](https://github.com/michifrey/myforrest/blob/main/deploy/qgis-server/nginx.conf).

## 5. Zertifikate

MyForrest selbst spricht nur HTTP; **TLS beendet der Reverse Proxy**. HTTPS ist für den Betrieb Pflicht, denn
ohne geht Folgendes nicht:

- Kamera-Overlay für Wiederholungsfotos (Browser geben die Kamera nur über HTTPS frei),
- Service Worker, Offline-Karten, Upload-Warteschlange und installierbare App (PWA),
- Push-Nachrichten der Frühwarnung,
- Anmeldung über Google, Microsoft, edu-ID, AGOV (Redirect-URIs nur mit `https://`),
- Einbindung in Geoportale wie map.geo.admin.ch,
- `Secure`-Flag des Sitzungs-Cookies.

Empfehlung: **Let's Encrypt** automatisch über Caddy oder Traefik. Minimal mit Caddy vor der App:

```
wald.example.ch {
  request_body {
    max_size 4GB
  }
  reverse_proxy localhost:3000
}
```

Caddy setzt `X-Forwarded-Proto` und `X-Forwarded-For` von sich aus; bei eigenem nginx
`proxy_set_header X-Forwarded-Proto $scheme;` und `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
setzen (die nginx-Vorlage in `deploy/qgis-server` übernimmt `X-Forwarded-Proto` eines TLS-Proxys davor, statt
es mit `http` zu überschreiben). Dazu `TRUST_PROXY` (hier `loopback`, bei Containern im privaten Netz `uniquelocal`), damit die Rate-Limits
die Adresse der Person sehen und nicht die des Proxys. `PUBLIC_URL` muss die öffentliche HTTPS-Adresse sein (Links in Mails, OAuth-Rücksprung, Kacheln).

Weitere Schlüssel, die keine TLS-Zertifikate sind, aber wie Secrets behandelt werden:

| Schlüssel | Wo | Bemerkung |
|-----------|----|-----------|
| VAPID (Web Push) | Datenbank oder `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` | beim Umzug mitnehmen, sonst müssen alle Geräte Push neu einschalten |
| `…_PRIVATE_KEY_FILE` (AGOV, edu-ID, OIDC) | Datei, z. B. `/run/secrets/agov.pem` | EC P-256 oder RSA; öffentlicher Teil unter `/api/auth/jwks.json` |
| Client-Secrets, `SMTP_URL` | Umgebungsvariablen | in Secrets, nicht ins Repository oder eine ConfigMap |

Ausgehend prüft Node die Zertifikate der Gegenstellen gegen die eingebauten CAs. Steht ein TLS-Proxy mit eigener
CA im Firmennetz dazwischen, diese über `NODE_EXTRA_CA_CERTS=/pfad/ca.pem` bekannt machen.

## 6. Ausgehende Verbindungen

### Vom Server

Alle über **HTTPS (443)**, ausser SMTP. Jeder Dienst lässt sich abschalten oder ersetzen; die App läuft dann
ohne die jeweilige Funktion weiter.

| Host | Wofür | Wann | Abschalten / ersetzen |
|------|-------|------|-----------------------|
| `archive-api.open-meteo.com`, `api.open-meteo.com` | Wetter, Normalwerte, Böen, Geländehöhe | pro Spot (Cache pro ~10-km-Zelle) | – |
| `earth-search.aws.element84.com`, `sentinel-cogs.s3.us-west-2.amazonaws.com` | Sentinel-2 (NDVI/NDMI ab 2017), Frühwarnung | pro Spot, täglich (`SATELLITE_WATCH_HOURS`); ~4,4 MB pro Szene | `SENTINEL_STAC_URL=` |
| `planetarycomputer.microsoft.com`, `landsateuwest.blob.core.windows.net` | Landsat vor 2017 | pro Spot | `LANDSAT_STAC_URL=` |
| `api3.geo.admin.ch` | Kanton eines Spots (Schutzlisten) | einmal pro Spot | `CANTON_LOOKUP_URL=` |
| `api3.geo.admin.ch` | Wildruhezonen (`WILDRUHE_LAYER`) | pro Feld von rund 22 × 15 km, wöchentlich | ohne `WILDRUHE_LAYER` aus |
| `brouter.de` | Wege-Magnet (Standard) bzw. Download der Routing-Segmente für den eigenen BRouter | beim Zeichnen von Touren / alle 30 Tage | `ROUTER_URL=` oder eigener BRouter |
| `my-api.plantnet.org` | Pflanzenbestimmung | auf Knopfdruck | ohne `PLANTNET_API_KEY` aus |
| `opendata.dwd.de` | Phänologie-Referenzdaten | nur bei `POST /api/phenoref/sync` | Dateien manuell importieren |
| `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.notify.windows.com` | Push-Nachrichten | bei Frühwarnungen | `PUSH_HOSTS` erweitert die Liste |
| `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com` | Anmelden mit Google | beim Anmelden | nur mit `GOOGLE_CLIENT_ID` |
| `github.com`, `api.github.com` | Anmelden mit GitHub | beim Anmelden | nur mit `GITHUB_CLIENT_ID` |
| `login.microsoftonline.com` | Anmelden mit Microsoft | beim Anmelden | nur mit `MICROSOFT_CLIENT_ID` |
| `login.eduid.ch` | Anmelden mit SWITCH edu-ID | beim Anmelden | nur mit `EDUID_CLIENT_ID` |
| `AGOV_ISSUER`, `OIDC_ISSUER` | Anmelden mit AGOV / eigenem OIDC-Dienst | beim Anmelden | nur wenn gesetzt |
| SMTP-Server aus `SMTP_URL` | E-Mails | Registrierung, Passwort vergessen | Port **465** (`smtps://`) oder **587** (`smtp://` + STARTTLS) |
| `DETECTOR_URL` | externer Objektdetektor | beim ersten Abruf der Erkennungen eines Fotos | nur wenn gesetzt |
| `WEGNETZ_URL`, z. B. `overpass-api.de` | Wegnetz im Durchgehen (OpenStreetMap) | pro Feld von rund 1 km², alle 30 Tage | nur wenn gesetzt; eigene Overpass-Instanz möglich |
| `graph.mapillary.com` und die Bild-Hosts von Mapillary | Mapillary-Bilder im Durchgehen | pro Feld, eine Woche zwischengespeichert | nur mit `MAPILLARY_TOKEN` |
| Hosts der Bild-Adressen in `ARCHIV_KATALOG` | Archivbild übernehmen | auf Knopfdruck | nur wenn gesetzt |

Beim Bauen der Images zusätzlich: `registry.npmjs.org` (npm), `deb.debian.org` (ffmpeg), Docker Hub bzw.
`ghcr.io` (Basis-Images), `github.com` (BRouter-Release).

### Vom Browser der Nutzenden

Diese Verbindungen gehen nicht vom Server aus, gehören aber in eine Content-Security-Policy oder Firewall-Regel
im Firmennetz:

| Host | Wofür |
|------|-------|
| `tile.openstreetmap.org` | Kartenkacheln der App und Offline-Karten |
| `wmts.geo.admin.ch` | Landeskarte und Luftbild der Vektorkarte LV95 |

Alle JavaScript-Bibliotheken und Schriften liefert der Server selbst aus, ohne CDN.

### Minimal-Konfiguration ohne Fremddienste

Wer möglichst wenig nach aussen geben will (z. B. in einem abgeschotteten Behördennetz):

```bash
SENTINEL_STAC_URL= LANDSAT_STAC_URL= CANTON_LOOKUP_URL= \
ROUTER_URL=http://brouter:17777/brouter ROUTER_PROFILE=myforrest-wald \
npm start
```

Dann bleiben nur Open-Meteo (Wetter) und die Kartenkacheln im Browser; der eigene BRouter braucht
`brouter.de` nur zum Laden seiner Segmente (oder `SEGMENTS_URL` auf einen eigenen Spiegel).

## 7. Checkliste vor dem Livegang

- [ ] Domain und DNS, TLS über den Reverse Proxy, Port 80 leitet auf 443 um
- [ ] `PUBLIC_URL=https://…` gesetzt
- [ ] `TRUST_PROXY` passend zum Reverse Proxy gesetzt (sonst gelten die Anmelde-Sperren für alle gemeinsam)
- [ ] `REQUIRE_LOGIN=1` (besser `REQUIRE_VERIFIED_EMAIL=1`) und `ADMIN_EMAIL` gesetzt
- [ ] `SMTP_URL` und `MAIL_FROM` gesetzt, Testmail angekommen
- [ ] Proxy erlaubt Uploads bis 4 GB und hat lange Timeouts
- [ ] Volume für `DATA_DIR` gross genug (siehe [Speicherplatz](#2-speicherplatz)), Monitoring auf freien Platz
- [ ] Backup von `myforrest.db` und `uploads/`, Wiederherstellung einmal geprüft
- [ ] Secrets (Client-Secrets, private Schlüssel, `SMTP_URL`) nicht im Repository
- [ ] Firewall: eingehend nur 80/443, ausgehend die Hosts aus [Abschnitt 6](#6-ausgehende-verbindungen)
- [ ] Eigener BRouter statt `brouter.de`, bei viel Verkehr eigener Kachelanbieter statt OpenStreetMap
- [ ] Datenschutzerklärung (EXIF in Originalfotos, Backups, externe Dienste), siehe [Betrieb](betrieb.md)

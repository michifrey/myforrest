# Installation und Konfiguration

## Voraussetzungen

Node.js ≥ 22.5 (nutzt das eingebaute `node:sqlite`). Für Videos zusätzlich `ffmpeg`
(z. B. `apt install ffmpeg` oder `brew install ffmpeg`).

## Starten

```bash
npm install
npm start            # http://localhost:3000
npm test
```

## Auf dem Handy

Browser lassen die Kamera für das Live-Overlay nur über HTTPS zu (oder auf `localhost`). Im Heimnetz geht das z. B. mit einem Tunnel (siehe
[unten](#zum-testen-server-auf-dem-eigenen-pc-mit-cloudflare-tunnel)) oder einem Reverse-Proxy wie Caddy. Ohne HTTPS öffnet sich die normale Kamera-App: Das Foto landet
trotzdem am richtigen Spot, nur ohne Overlay.

## Zum Testen: Server auf dem eigenen PC mit Cloudflare Tunnel

Für erste Versuche mit dem Handy oder der [Android-App](android.md) reicht der eigene PC: MyForrest läuft dort,
und [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gibt ihm
eine HTTPS-Adresse, die das Handy von überall erreicht. Kein Router, keine Firewall und kein Zertifikat sind
einzurichten; der Tunnel verbindet von innen nach aussen. Der PC muss dafür laufen (Ruhezustand aus). Für den
Dauerbetrieb ist ein Server besser ([Eigener Server: VPS, Synology und Render](hosting.md)).

### 1. Programme installieren

Unter Windows in PowerShell, danach PowerShell schliessen und neu öffnen:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Cloudflare.cloudflared
winget install Gyan.FFmpeg   # nur für Video-Uploads
```

Unter macOS `brew install node git cloudflared ffmpeg`, unter Linux Node.js ≥ 22.5 und `cloudflared` aus den
[Paketen von Cloudflare](https://pkg.cloudflare.com/).

### 2. MyForrest holen und starten

```powershell
cd $HOME
git clone https://github.com/michifrey/myforrest.git
cd myforrest
npm install
$env:TRUST_PROXY = "loopback"
npm start
```

`TRUST_PROXY=loopback` lässt den Server hinter dem Tunnel die Adresse der Besucher sehen; sonst teilen sich alle
dieselbe Begrenzung für Anmeldungen. (Unter macOS und Linux: `TRUST_PROXY=loopback npm start`.) Steht
`http://localhost:3000` im Fenster, zeigt der Browser auf dem PC die Karte. Das Fenster offen lassen.

### 3. Tunnel öffnen (ohne Konto)

In einem zweiten Fenster:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Nach ein paar Sekunden steht dort eine Adresse wie `https://gentle-forest-example-words.trycloudflare.com`. Sie
im Browser des Handys öffnen oder in der Android-App auf dem Startbildschirm eingeben und *Verbinden*.

Bei jedem Start von `cloudflared` gibt es eine **neue Zufallsadresse**. Die Android-App zeigt dann wieder ihren
Startbildschirm, wo die neue Adresse eingegeben wird (oder lange auf das App-Symbol drücken → *Server
wechseln*). Für eine feste Adresse siehe Schritt 5.

### 4. Konto anlegen

In der App *Anmelden → Registrieren*. Ohne `SMTP_URL` verschickt MyForrest keine E-Mails, sondern schreibt den
Bestätigungslink ins erste Fenster (Server-Log); ihn kopieren und im Browser öffnen. Das erste Konto wird Admin.
Fotos und Datenbank liegen im Ordner `data` (siehe `DATA_DIR`) und bleiben bei jedem Neustart erhalten.

### 5. Feste Adresse mit eigener Domain

Liegt eine Domain bei Cloudflare (z. B. `example.org`), bekommt der Tunnel eine feste Adresse wie
`app.example.org`:

```powershell
cloudflared tunnel login                      # öffnet den Browser, Domain auswählen
cloudflared tunnel create myforrest           # gibt die ID des Tunnels aus
cloudflared tunnel route dns myforrest app.example.org
```

Dazu die Datei `.cloudflared\config.yml` im Benutzerordner (unter macOS/Linux `~/.cloudflared/config.yml`):

```yaml
tunnel: <ID>
credentials-file: C:\Users\<name>\.cloudflared\<ID>.json
ingress:
  - hostname: app.example.org
    service: http://localhost:3000
  - service: http_status:404
```

Starten mit `cloudflared tunnel run myforrest`, MyForrest dazu mit derselben Adresse:

```powershell
$env:PUBLIC_URL = "https://app.example.org"
$env:TRUST_PROXY = "loopback"
npm start
```

Die feste Adresse lässt sich als Variable `APP_URL` in die Android-App bauen, dann fragt sie nicht mehr danach
(siehe [Android-App → Auf GitHub](android.md#auf-github)).

!!! warning "Öffentlich erreichbar"
    Über den Tunnel ist der Server im Internet erreichbar, auch unter der zufälligen Adresse. Nur laufen lassen,
    solange getestet wird, und vor einem echten Betrieb [Betrieb und Datenschutz](betrieb.md#vor-einem-öffentlichen-betrieb)
    lesen.

## Umgebungsvariablen

| Variable           | Standard | Bedeutung                                      |
|--------------------|----------|------------------------------------------------|
| `PORT`             | `3000`   | HTTP-Port                                      |
| `DATA_DIR`         | `./data` | SQLite-Datenbank und hochgeladene Bilder       |
| `SPOT_RADIUS_M`    | `25`     | Radius, in dem Fotos zum selben Spot gehören   |
| `HEADING_TOLERANCE_DEG` | `45` | Abweichung der Blickrichtung (±°), bis zu der Fotos zum selben Spot gehören |
| `PLANTNET_API_KEY` | –        | Aktiviert die Pflanzenbestimmung               |
| `PUBLIC_URL`       | –        | Öffentliche Adresse für Foto-Links im Export (sonst aus der Anfrage); mit ihr werden die Vektorkacheln schon beim Start vorberechnet |
| `TILES_PRECOMPUTE` | `1`      | `0`: Vektorkacheln nicht vorberechnen, jede Kachel bei der Anfrage schneiden |
| `METADATA_ORGANISATION` | `MyForrest` | Verantwortliche Organisation in den Metadaten (geocat.ch) |
| `METADATA_EMAIL`   | `ADMIN_EMAIL` | Kontakt-E-Mail in den Metadaten |
| `METADATA_CITY`, `METADATA_COUNTRY` | –, `CH` | Ort und Land des Kontakts |
| `METADATA_URL`     | App-Adresse | Website der Organisation |
| `METADATA_UUID`    | aus der Adresse abgeleitet | Feste Kennung des Metadatensatzes |
| `OWS_UPSTREAM` | – | Interne Adresse von QGIS Server mit eigenem HTTP (z. B. `http://karten:80`): MyForrest reicht dann `/ows/` dorthin weiter und nennt `https://<PUBLIC_URL>/ows/` in den Metadaten. Für Plattformen ohne eigenes nginx davor, z. B. Render |
| `ROUTER_HOSTPORT`, `OWS_HOSTPORT` | – | Nur `host:port` der privaten Dienste (Render setzt sie aus `render.yaml`); daraus werden `ROUTER_URL` (`http://…/brouter`) und `OWS_UPSTREAM`, wenn diese nicht gesetzt sind |
| `METADATA_OWS_URL` | –        | Adresse von QGIS Server (z. B. `https://…/ows/`): WMS, WMTS und WFS in den Metadaten |
| `METADATA_OPENDATA_TERMS` | – | Nutzungsbedingung von opendata.swiss (`terms_by` usw.): markiert den Eintrag für opendata.swiss |
| `FFMPEG_PATH`      | `ffmpeg` | ffmpeg für die Bilder aus Videos               |
| `VIDEO_MAX_MB`     | `4096`   | Maximale Grösse eines Videos                   |
| `SENTINEL_STAC_URL`| Earth Search | STAC-API für Sentinel-2 L2A; leer = Satellitenkontext aus |
| `LANDSAT_STAC_URL` | Planetary Computer | STAC-API für Landsat Collection 2 (vor 2017); leer = ohne Landsat |
| `LANDSAT_TOKEN_URL`| Planetary Computer | Adresse für das anonyme Token, mit dem die Landsat-Links signiert werden |
| `SATELLITE_WATCH_HOURS` | `24` | Abstand der Frühwarn-Runde über alle Spots in Stunden; `0` = aus |
| `STURM_WARN_HOURS` | `3` | Abstand der Sturmwarn-Runde (Böenprognose, Push vor und nach dem Sturm) in Stunden; `0` = aus |
| `STURM_MODELL` | `icon_seamless` | Wettermodell der Böenprognose bei Open-Meteo (z. B. `icon_d2`, `meteoswiss_icon_ch1`); `best_match` = Auswahl von Open-Meteo |
| `REQUIRE_LOGIN`    | –        | `1`: Uploads und Änderungen nur mit Konto      |
| `TRUST_PROXY`      | –        | Reverse Proxy, dessen `X-Forwarded-For` gilt, damit die Rate-Limits die Adresse der Person sehen statt die des Proxys: Anzahl Proxys (`1`), Adressen oder Netze (`loopback`, `uniquelocal`, `10.0.0.0/8`) oder `true` für alle; leer = keinem Proxy vertrauen (siehe [Betrieb](betrieb.md#vor-einem-öffentlichen-betrieb)) |
| `ADMIN_EMAIL`      | –        | Dieses Konto wird Admin (sonst das erste Konto) |
| `REQUIRE_VERIFIED_EMAIL` | – | `1`: Uploads und Änderungen nur mit bestätigter E-Mail-Adresse (schliesst `REQUIRE_LOGIN` ein) |
| `SMTP_URL`         | –        | Mailserver für Bestätigungslinks, z. B. `smtps://user:passwort@smtp.example.org` (siehe [unten](#e-mail-versand)); ohne ihn stehen die Links im Server-Log |
| `MAIL_FROM`        | `MyForrest <no-reply@…>` | Absender der E-Mails |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | Aktiviert „Mit Google anmelden“ (siehe [unten](#anmelden-über-google-github-microsoft-und-switch-edu-id)) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | – | Aktiviert „Mit GitHub anmelden“ |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | – | Aktiviert „Mit Microsoft anmelden“; `MICROSOFT_TENANT` (Standard `common`) schränkt ein: `consumers` (nur private Konten), `organizations` oder die ID eines Tenants |
| `EDUID_CLIENT_ID`, `EDUID_CLIENT_SECRET` | – | Aktiviert „Mit SWITCH edu-ID anmelden“; `EDUID_ISSUER` (Standard `https://login.eduid.ch/`) für ein Testsystem |
| `AGOV_ISSUER`, `AGOV_CLIENT_ID`, `AGOV_PRIVATE_KEY_FILE` | – | Aktiviert „Mit AGOV anmelden“ (siehe [unten](#agov)); `AGOV_ACR_VALUES` fordert eine Authentifizierungsqualität an |
| `…_PRIVATE_KEY_FILE` | – | Bei allen OpenID-Connect-Diensten (`EDUID_`, `OIDC_`, `AGOV_`): privater Schlüssel (PEM, RSA oder EC P-256) statt Client-Secret, Anmeldung per `private_key_jwt` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL` | – | Ein weiterer OpenID-Connect-Dienst (z. B. Microsoft Entra ID einer Organisation, Keycloak) mit eigener Beschriftung |
| `ROUTER_URL`       | `https://brouter.de/brouter` | Routing-Dienst im Format von [BRouter](https://brouter.de) für den Wege-Magnet beim Zeichnen von Touren; leer (`ROUTER_URL=`) = aus, dann gerade Linien. Für den Betrieb einen [eigenen BRouter](https://github.com/michifrey/myforrest/blob/main/deploy/brouter/README.md) nehmen, z. B. `http://brouter:17777/brouter` |
| `PRO_VALID_DAYS`   | `365`    | Wie lange eine PRO-Verifizierung gilt, bevor sie bestätigt werden muss |
| `CANTON_LOOKUP_URL` | geo.admin.ch | Dienst für den Kanton eines Spots (swisstopo identify); leer = aus, dann zählt jede kantonale Schutzliste |
| `SENSITIVE_SPECIES` | – | Weitere Gattungen oder Arten (kommagetrennt), deren Funde automatisch geschützt werden, z. B. `Trollius,Lilium bulbiferum` |
| `ROUTER_PROFILE`   | `hiking-mountain` | BRouter-Profil für das Routing; mit dem eigenen BRouter `myforrest-wald` (Waldprofil, siehe [deploy/brouter](https://github.com/michifrey/myforrest/blob/main/deploy/brouter/README.md)) |
| `WILDRUHE_GEOJSON` | – | GeoJSON-Datei mit Wildruhezonen (WGS84 oder LV95, z. B. BAFU-Datensatz von geo.admin.ch); der Wege-Magnet führt während der Schutzzeit um sie herum |
| `WILDRUHE_LAYER` | – (in Docker Compose und Kubernetes `ch.bafu.wrz-wildruhezonen_portal`) | Wildruhezonen direkt von geo.admin.ch laden: Id der Ebene im Kartenviewer; die Zonen kommen pro Feld von rund 22 × 15 km und werden gespeichert |
| `WILDRUHE_API` | `https://api3.geo.admin.ch/rest/services/api/MapServer/identify` | Identify-Dienst für `WILDRUHE_LAYER` |
| `WILDRUHE_REFRESH_DAYS` | `7` | Nach so vielen Tagen fragt die App ein Feld wieder an; schlägt das fehl, bleiben die gespeicherten Zonen |
| `HOLZSCHLAG_SPERRE_TAGE` | `42` | So lange sperrt ein Foto mit *Holzschlag / Rodung* die Wege 80 m darum herum für den Wege-Magnet |
| `WILDRUHE_SEASON`  | `12-20/04-30` | Schutzzeit (Monat-Tag/Monat-Tag) für Zonen ohne eigene Angabe; `immer` = ganzjährig |
| `GEBAEUDE_URL` | wie `WEGNETZ_URL` | Overpass-API für die Gebäude aus OpenStreetMap, die ausserhalb der Schweiz Schatten auf die Karte werfen ([Details](funktionen.md#licht-und-schatten-auf-der-karte)); leer gesetzt schaltet das ab |
| `WEGNETZ_URL` | – | Overpass-API für das Wegnetz aus OpenStreetMap (z. B. `https://overpass-api.de/api/interpreter` oder eine eigene Instanz); im Durchgehen führen Pfeile dann entlang der Wege ([Details](funktionen.md#durchgehen-wie-street-view)) |
| `MCH_RADAR_URL` | STAC-Sammlung `ch.meteoschweiz.ogd-radar-precip` bei geo.admin.ch | Niederschlagsradar der MeteoSchweiz im Tab *Wetter* eines Spots ([Details](funktionen.md#wetter-am-spot)); leer = nur das DWD-Radar |
| `KLIMA_MODELS` | sieben Modelle (`CMCC_CM2_VHR4,FGOALS_f3_H,HiRAM_SIT_HR,MRI_AGCM3_2_S,EC_Earth3P_HR,MPI_ESM1_2_XR,NICAM16_8S`) | Klimamodelle der Klima-API von Open-Meteo für den Ausblick bis 2050 in [Klima im Wandel](klimawandel.md), kommagetrennt; leer = kein Ausblick |
| `KLIMA_KARTE_PRO_TAG` | `30` | Neue Felder des Klima-Rasters pro Tag ([Details](klimawandel.md#klima-auf-der-karte)); jedes kostet bei Open-Meteo mehrere hundert Abfragen |
| `KLIMA_KARTE_MODELLE` | `3` | Wie viele der Klimamodelle (die ersten aus `KLIMA_MODELS`) das Klima-Raster für die Szenarien nutzt; `0` = Raster ohne Szenarien |
| `KLIMA_WMS_URL` | `https://wms.geo.admin.ch/` | Kartendienst (WMS) für die offiziellen Klima- und Waldkarten im Panel *Klima auf der Karte*; leer = aus |
| `BAUMINVENTAR_URL` | Bauminventar des Kantons Genf (`https://ge.ch/terags/rest/services/ICA/MapServer/1`) | ArcGIS-Ebene eines Bauminventars für die [Baumart-Vorschläge](funktionen.md#vorschläge-aus-dem-bauminventar); leer = aus |
| `BAUMINVENTAR_BBOX` | Kanton Genf (`5.95,46.12,6.32,46.37`) | Gebiet des Inventars (West, Süd, Ost, Nord in WGS84); nur Spots darin fragen das Inventar ab |
| `BAUMINVENTAR_NAME`, `BAUMINVENTAR_QUELLE` | Genf (SITG) | Name des Inventars und Quellenangabe unter den Vorschlägen |
| `BAUMINVENTAR_RADIUS_M` | `40` | Umkreis um den Spot in Metern |
| `BASISKARTE_STIL` | `https://tiles.openfreemap.org/styles/positron` | Vektorstil der Grundkarte *MyForrest* ([Details](funktionen.md#grundkarte)), wird im Browser in den Farben der App gezeichnet; leer = nur OpenStreetMap |
| `BASISKARTE_QUELLE` | OpenFreeMap, OpenMapTiles, OSM | Quellenangabe der Grundkarte, falls der Stil keine nennt |
| `DOKU_URL` | `https://michifrey.github.io/myforrest/` | Adresse der Doku-Website für die Links auf der Startseite (Navigation, Funktionen, Footer); leer = keine Links |
| `EBENEN_WMS_URL` | `https://wms.geo.admin.ch/` | Kartendienst für die Themen des Panels [Ebenen](funktionen.md#ebenen-karten-aus-offiziellen-quellen); leer = keine Ebenen von geo.admin.ch |
| `ORTSSUCHE_URL` | SearchServer von geo.admin.ch | Ortssuche in [Landschaft im Wandel](landschaft.md) (Namen und Adressen); leer = nur Koordinaten |
| `ZEITREISE_WMTS_URL` | WMTS-Capabilities von geo.admin.ch (EPSG:3857) | Woher die Jahre der *Zeitreise der Landeskarte* und der *historischen Luftbilder* in [Landschaft im Wandel](landschaft.md) kommen (einmal am Tag gelesen); leer = beide aus |
| `EBENEN_IDENTIFY_URL` | Identify-Dienst von geo.admin.ch | Für *Was ist hier?* bei Ebenen von geo.admin.ch |
| `EBENEN_HOEHE_URL` | Höhendienst von geo.admin.ch (`rest/services/height`) | Höhe im Koordinaten-Popup (swissALTI3D); leer = nur das Geländemodell von Open-Meteo |
| `EBENEN_REGIONAL` | Baumkataster Zürich, SITG Genf, EFFIS | Regionale WMS-Dienste als JSON-Liste `[{ "url", "group", "bbox": [W, S, O, N], "attribution" }]`; alle ihre Ebenen erscheinen, wenn die Karte im Gebiet steht |
| `FIRMS_MAP_KEY` | – | Schlüssel von [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/): aktive Feuer (MODIS, VIIRS) als Ebene |
| `BAUMKATASTER_ZUERICH` | WFS des Baumkatasters der Stadt Zürich | Zweites Bauminventar für die [Baumart-Vorschläge](funktionen.md#vorschläge-aus-dem-bauminventar); leer = aus |
| `KLIMA_WMS_GENF` | vier Dienste des SITG (Wärmeinsel, Kronendach 2023 und 2017, Baumstrategie) | WMS-Dienste für Genf, kommagetrennt; ihre Karten erscheinen, wenn die Karte im Kanton Genf steht ([Details](klimawandel.md#klima-auf-der-karte)); leer = keine |
| `TILES3D_GEBAEUDE` | `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json` | 3D Tiles der Gebäude für die [3D-Karte](funktionen.md#gebäude-und-bäume-in-3d); leer = kein Schalter *Gebäude* |
| `TILES3D_VEGETATION` | `https://3d.geo.admin.ch/ch.swisstopo.vegetation.3d/v1/tileset.json` | 3D Tiles der Bäume; leer = kein Schalter *Bäume* |
| `TILES3D_HOEHE` | `-50` | Höhenkorrektur der 3D Tiles in Metern (vom Ellipsoid auf Meereshöhe; in der Schweiz liegt das Geoid rund 50 m über dem Ellipsoid) |
| `TERRAIN_URL` | Terrain Tiles auf AWS | Geländekacheln für die [3D-Karte](funktionen.md#3d-karte), Vorlage mit `{z}`, `{x}`, `{y}` (Terrarium-PNG, z. B. ein eigener Spiegel); leer = keine 3D-Karte |
| `MAPILLARY_TOKEN` | – | Client-Token von [Mapillary](https://www.mapillary.com/dashboard/developers) (`MLY|…`): Mapillary-Bilder im Durchgehen und auf der Karte, wo es keine eigenen gibt ([Details](funktionen.md#mapillary)) |
| `GEBIRGE_AB_M` | `2100` | Ab dieser Höhe (m ü. M.) wird ein Spot ohne Profil, Baumarten und Wald-Beobachtungen ein Gebirge-Spot; `0` = aus |
| `GLAMOS_CSV` | – | Längenänderung der Gletscherzungen von GLAMOS als CSV (mehrere durch Kommas getrennt); zeigt die Kurve im Gletscher-Teil eines Spots ([Details](funktionen.md#längenänderung-glamos)) |
| `WIKIMEDIA` | an | `0` schaltet *Wikipedia, Wikidata & Commons* am Spot ab (Anfragen an Wikidata und Wikimedia Commons; mit `WEGNETZ_URL` auch die OSM-Objekte mit `wikidata`-Tag) ([Details](funktionen.md#wikipedia-wikidata-und-commons)) |
| `ARCHIV_KATALOG` | – | Katalog offener Archivbilder als CSV oder GeoJSON (mehrere durch Kommas getrennt); schlägt Bilder in der Nähe eines Gletscher- oder Gebirge-Spots vor ([Format](funktionen.md#archivfotos)) |
| `GLETSCHER_GEOJSON` | – | Gletscherinventare als GeoJSON (WGS84 oder LV95, mehrere durch Kommas getrennt, z. B. GLAMOS SGI 1850, 1973, 2016); erkennt Gletscher-Spots, zeigt die Umrisse pro Jahr und wo früher Eis lag ([Details](funktionen.md#gletscherumrisse)) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | erzeugt | Schlüssel für Web Push (base64url); ohne sie erzeugt der Server beim ersten Start ein Paar und speichert es in der Datenbank |
| `VAPID_SUBJECT`    | `mailto:ADMIN_EMAIL` | Kontakt für die Push-Dienste (`mailto:` oder `https:`) |
| `PUSH_HOSTS`       | –        | Weitere erlaubte Push-Dienste (Hostnamen, kommagetrennt), zusätzlich zu Google, Mozilla, Apple und Microsoft |
| `DETECTOR_URL`     | –        | Externer Objektdetektor (siehe [unten](#externer-detektor)); ohne ihn laufen die eingebauten Heuristiken |

## E-Mail-Versand

Wer sich mit E-Mail und Passwort registriert, bekommt einen Link zum Bestätigen der Adresse (24 Stunden
gültig, im Konto-Menü neu anforderbar), und wer das Passwort vergessen hat, einen Link zum Zurücksetzen. Verschickt wird über SMTP, ohne zusätzliche Pakete:

```bash
SMTP_URL='smtps://wald%40example.org:passwort@smtp.example.org' \
MAIL_FROM='MyForrest <wald@example.org>' npm start
```

- `smtps://` verbindet direkt über TLS (Port 465), `smtp://` über STARTTLS (Port 587). Ohne STARTTLS
  verweigert die App den Versand, ausser auf `localhost` (lokales Relay). Sonderzeichen in Benutzername und
  Passwort URL-kodieren (`@` → `%40`, `:` → `%3A`).
- Der Link zeigt auf `PUBLIC_URL` (sonst auf die Adresse der Anfrage) – für den Betrieb also `PUBLIC_URL`
  setzen.
- Ohne `SMTP_URL` schreibt die App die E-Mail samt Link ins Server-Log; das reicht zum Ausprobieren.
- Mit `REQUIRE_VERIFIED_EMAIL=1` können nur Konten mit bestätigter Adresse Fotos beitragen und ändern.
  Konten aus der Zeit vor dieser Funktion fordern ihren Link im Konto-Menü an.

## Anmelden über Google, GitHub, Microsoft und SWITCH edu-ID

Neben E-Mail und Passwort kann man sich mit einem Google-, GitHub- oder SWITCH-edu-ID-Konto anmelden oder
registrieren, mit einem Microsoft-Konto, über AGOV (Behörden, siehe [unten](#agov)) und mit einem weiteren
Dienst, der OpenID Connect spricht.
Ein Anbieter erscheint im Anmeldedialog, sobald Client-ID und Secret gesetzt sind. Die Rücksprungadresse
lautet `<PUBLIC_URL>/api/auth/oauth/<anbieter>/callback`; ohne `PUBLIC_URL` wird sie aus der Anfrage
gebildet. Sie muss beim Anbieter genau so eingetragen sein.

- *Google*: In der [Google Cloud Console](https://console.cloud.google.com/apis/credentials) einen
  OAuth-Client vom Typ „Webanwendung“ anlegen, als autorisierte Weiterleitungs-URI
  `https://example.org/api/auth/oauth/google/callback` eintragen. Bereiche: `openid`, `email`, `profile`.
- *GitHub*: Unter *Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers)*
  eine App anlegen, *Authorization callback URL* `https://example.org/api/auth/oauth/github/callback`.
- *Microsoft* (Outlook, Hotmail, Live sowie Arbeits- und Schulkonten): Im
  [Microsoft Entra Admin Center](https://entra.microsoft.com) unter *App-Registrierungen* eine App anlegen,
  Kontotypen „Konten in einem beliebigen Organisationsverzeichnis und persönliche Microsoft-Konten“ (oder enger,
  passend zu `MICROSOFT_TENANT`), Umleitungs-URI (Web) `https://example.org/api/auth/oauth/microsoft/callback`,
  unter *Zertifikate & Geheimnisse* ein Client-Secret. **Wichtig:** Unter *Tokenkonfiguration → Optionalen
  Anspruch hinzufügen → ID* die Ansprüche `email` und `xms_edov` hinzufügen (eine Warnung, `xms_edov` sei
  unbekannt, lässt sich ignorieren). Microsoft liefert kein `email_verified`, und in fremden Tenants kann ein
  Admin beliebige Adressen eintragen („nOAuth“); als bestätigt gilt eine Adresse deshalb nur mit
  `xms_edov`. Ohne diesen Anspruch entsteht über Microsoft kein neues Konto, Verknüpfen geht aber.
- *SWITCH edu-ID* (Hochschulen, Forschung, aber für alle offen): Den Dienst in der
  [SWITCH Resource Registry](https://rr.aai.switch.ch/) als OpenID-Connect-Client registrieren, Redirect-URI
  `https://example.org/api/auth/oauth/eduid/callback`, Claims *E-Mail* (mit `email_verified`) und *Name* als
  benötigt freigeben. Die App liest Adressen der Endpunkte aus `https://login.eduid.ch/.well-known/openid-configuration`
  und meldet sich mit Client-Secret (POST oder HTTP Basic, je nach Angabe des Anbieters) an. Die Kennung
  (`sub`) ist pro Dienst verschieden (pairwise), andere Dienste können Konten also nicht verknüpfen.
- *Weitere Dienste* (`OIDC_…`): `OIDC_ISSUER` ist die Adresse, unter der
  `/.well-known/openid-configuration` liegt; `OIDC_LABEL` steht auf dem Knopf („Mit … anmelden“).
  Redirect-URI `https://example.org/api/auth/oauth/oidc/callback`. Ein neues Konto entsteht nur mit
  `email_verified: true`; Dienste, die das nicht liefern, lassen sich trotzdem mit einem bestehenden Konto
  verknüpfen und dann zum Anmelden nutzen. Für Microsoft den eigenen Anbieter oben nehmen.

```bash
PUBLIC_URL=https://example.org \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… \
MICROSOFT_CLIENT_ID=… MICROSOFT_CLIENT_SECRET=… \
EDUID_CLIENT_ID=… EDUID_CLIENT_SECRET=… npm start
```

Für lokale Versuche geht auch `http://localhost:3000` als Rücksprungadresse.

### AGOV

[AGOV](https://www.agov.admin.ch/de) ist der Anmeldedienst der Schweizer Behörden. **Anschliessen dürfen sich
Behörden und Organisationen, soweit das EMBAG oder ein Spezialgesetz es zulässt** – für MyForrest also etwa,
wenn ein Forstamt, eine kantonale Fachstelle oder eine Hochschule die Instanz betreibt. Den Anschluss richtet
man selbst im Portal *AGOV connect* ein, begleitet von der Bundeskanzlei.

1. Schlüssel erzeugen (EC P-256; RSA geht auch) und als Secret ablegen:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out agov.pem
   ```
2. In AGOV connect einen OIDC-Client anlegen: Redirect-URI `https://example.org/api/auth/oauth/agov/callback`,
   Client-Authentisierung `private_key_jwt`, öffentlicher Schlüssel als JWKS-URL
   `https://example.org/api/auth/jwks.json` (oder deren Inhalt einfügen), Claims E-Mail (mit
   `email_verified`) und Name.
3. Starten:
   ```bash
   AGOV_ISSUER=<Issuer aus AGOV connect> AGOV_CLIENT_ID=… AGOV_PRIVATE_KEY_FILE=/run/secrets/agov.pem \
   AGOV_ACR_VALUES=<gewünschte Qualität> npm start
   ```

Die App liest die Endpunkte aus `<AGOV_ISSUER>/.well-known/openid-configuration`, prüft den Aussteller und
meldet sich am Token-Endpunkt mit einer selbst signierten, 60 Sekunden gültigen Zusicherung an. Bietet ein
Anbieter `private_key_jwt` nicht an, bricht die Anmeldung mit einer Meldung ab.

**Noch offen:** Die technische Spezifikation (agov.ch/spec) und die Liste der Authentifizierungsqualitäten
(agov.ch/aq) waren bei der Umsetzung nicht abrufbar. Issuer, die Werte für `AGOV_ACR_VALUES` und ob AGOV
`email` mit `email_verified` liefert, kommen deshalb aus AGOV connect bzw. der Spezifikation. Liefert AGOV
keine bestätigte Adresse, entsteht über AGOV kein neues Konto (Verknüpfen geht). Die angeforderte Qualität
wird nicht nachgeprüft, weil in MyForrest nichts davon abhängt; wer das braucht, muss das `acr` des ID-Tokens
prüfen. Gegen ein echtes AGOV ist die Anbindung nicht getestet.

## Externer Detektor

Mit `DETECTOR_URL` schickt die App jedes Foto beim ersten Abruf seiner Erkennungen an diesen Dienst:

```
POST $DETECTOR_URL
Content-Type: image/jpeg | image/png | image/webp
<Bilddaten>
```

Antwort (JSON; ein reines Array der Erkennungen geht auch):

```json
{
  "model": "yolo-forest-v3",
  "detections": [
    { "label": "liegender_stamm", "score": 0.87, "box": [0.12, 0.55, 0.81, 0.70] }
  ]
}
```

`box` ist `[x0, y0, x1, y1]`, normiert auf 0–1 im (nach EXIF gedrehten) Bild. Pixelwerte (ein Wert > 1,5)
werden mit der Bildgrösse umgerechnet. Labels: `liegender_stamm`, `wurzelteller`, `totholz`, `holzpolter`,
`rueckegasse`. Gängige englische Namen (`fallen_tree`, `root_plate`, `deadwood`, `log_pile`,
`skid_trail` …) werden übersetzt, unbekannte Labels bleiben, wie sie sind. Ist der Dienst nicht
erreichbar, fallen die Heuristiken ein, und die Antwort enthält einen Hinweis.

## Phänologie-Referenzdaten laden

Die Referenzreihen für den Beginn der Herbstfärbung und den Laubaustrieb (siehe
[Phänologie-Referenzdaten](funktionen.md#phänologie-referenzdaten)) stammen vom Deutschen Wetterdienst
(Open Data, `opendata.dwd.de`, Jahres- und Sofortmelder Wildwachsende Pflanzen) und von MeteoSchweiz (OGD
über `data.geo.admin.ch`). Sie werden nicht automatisch geladen:

- `POST /api/phenoref/sync` lädt die DWD-Daten herunter, samt Sofortmeldern für das laufende Jahr (braucht Zugang
  zu `opendata.dwd.de`); `POST /api/phenoref/sync?source=meteoschweiz` die Daten von MeteoSchweiz über die
  STAC-API (braucht Zugang zu `data.geo.admin.ch`). Für den Austrieb des laufenden Jahres lohnt es sich, im
  Frühling wöchentlich zu synchronisieren, oder
- einzelne Dateien werden importiert, zuerst die Stationen, danach jede Datei
  `PH_Jahresmelder_Wildwachsende_Pflanze_<Art>_….txt` mit `kind=observations&name=<Dateiname>`:

```bash
curl --data-binary @PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt \
  'localhost:3000/api/phenoref/import?format=dwd&kind=stations'
```

Die Dateien von MeteoSchweiz lassen sich ebenso einzeln importieren, zuerst die Parameterbeschreibung, dann
die Stationen, dann die Beobachtungen:

```bash
curl --data-binary @ogd-phenology_meta_parameters.csv 'localhost:3000/api/phenoref/import?format=meteoschweiz&kind=parameters'
curl --data-binary @ogd-phenology_meta_stations.csv   'localhost:3000/api/phenoref/import?format=meteoschweiz&kind=stations'
curl --data-binary @<Beobachtungen>.csv               'localhost:3000/api/phenoref/import?format=meteoschweiz&kind=observations'
```

Andere Quellen lassen sich als generisches CSV importieren (`format=generic`). Es hat die
Spalten `source;station_id;station_name;lat;lon;elevation;species;year;doy`, optional `phase` (lateinischer
Artname, Tag im Jahr; Phase `colour` für die beginnende Blattverfärbung, Standard, oder `leafout` für die
Blattentfaltung).

## Klimadaten laden

Das Dossier [Klima im Wandel](klimawandel.md) holt ERA5 und die Klimamodelle selbst bei Open-Meteo. Die homogenen
Messreihen der MeteoSchweiz (seit 1864) und die Klimaszenarien CH2025 lädt ein Admin dazu: `POST /api/klima/sync`
holt die Messreihen über `data.geo.admin.ch`, `POST /api/klima/import` nimmt Dateien entgegen. Formate und
Beispiele stehen unter [Klima im Wandel → Einrichten](klimawandel.md#einrichten).

## Mit Docker und QGIS Server

`Dockerfile` baut MyForrest samt ffmpeg. Für Karten als WMS/WMTS/WFS (z. B. für map.geo.admin.ch) gibt es
unter [`deploy/qgis-server`](https://github.com/michifrey/myforrest/blob/main/deploy/qgis-server/README.md) eine Vorlage mit Docker Compose: MyForrest,
QGIS Server, nginx und ein Dienst, der das GeoPackage alle 15 Minuten neu exportiert. Das QGIS-Projekt
mit den Stilen liegt bei und wird mit `build-project.py` (PyQGIS) neu erzeugt.

## Eigener Routing-Server

Der Wege-Magnet nutzt ohne Einstellung den öffentlichen Dienst `brouter.de`. Einen eigenen BRouter samt
Routing-Daten für die Schweiz bringt [`deploy/brouter`](https://github.com/michifrey/myforrest/blob/main/deploy/brouter/README.md) mit: In der
Docker-Compose-Vorlage und auf Kubernetes läuft er schon mit; allein startet er mit `docker run` und wird
über `ROUTER_URL=http://localhost:17777/brouter` eingebunden.

## Weiter

- [Tech-Onboarding](tech-onboarding.md): alles fürs Hosten auf einen Blick (Speicher, Lizenzen, Ports, Zertifikate, ausgehende Verbindungen)
- [Betrieb, Datenschutz und Datenquellen](betrieb.md): was vor einem öffentlichen Betrieb zu beachten ist
- [Architektur](architektur.md) und [REST-API](api.md)

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

Browser lassen die Kamera für das Live-Overlay nur über HTTPS zu (oder auf `localhost`). Im Heimnetz geht das z. B. mit einem Tunnel (`cloudflared tunnel --url http://localhost:3000`)
oder einem Reverse-Proxy wie Caddy. Ohne HTTPS öffnet sich die normale Kamera-App: Das Foto landet
trotzdem am richtigen Spot, nur ohne Overlay.

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
| `METADATA_OWS_URL` | –        | Adresse von QGIS Server (z. B. `https://…/ows/`): WMS, WMTS und WFS in den Metadaten |
| `METADATA_OPENDATA_TERMS` | – | Nutzungsbedingung von opendata.swiss (`terms_by` usw.): markiert den Eintrag für opendata.swiss |
| `FFMPEG_PATH`      | `ffmpeg` | ffmpeg für die Bilder aus Videos               |
| `VIDEO_MAX_MB`     | `4096`   | Maximale Grösse eines Videos                   |
| `SENTINEL_STAC_URL`| Earth Search | STAC-API für Sentinel-2 L2A; leer = Satellitenkontext aus |
| `LANDSAT_STAC_URL` | Planetary Computer | STAC-API für Landsat Collection 2 (vor 2017); leer = ohne Landsat |
| `LANDSAT_TOKEN_URL`| Planetary Computer | Adresse für das anonyme Token, mit dem die Landsat-Links signiert werden |
| `SATELLITE_WATCH_HOURS` | `24` | Abstand der Frühwarn-Runde über alle Spots in Stunden; `0` = aus |
| `REQUIRE_LOGIN`    | –        | `1`: Uploads und Änderungen nur mit Konto      |
| `ADMIN_EMAIL`      | –        | Dieses Konto wird Admin (sonst das erste Konto) |
| `REQUIRE_VERIFIED_EMAIL` | – | `1`: Uploads und Änderungen nur mit bestätigter E-Mail-Adresse (schliesst `REQUIRE_LOGIN` ein) |
| `SMTP_URL`         | –        | Mailserver für Bestätigungslinks, z. B. `smtps://user:passwort@smtp.example.org` (siehe [unten](#e-mail-versand)); ohne ihn stehen die Links im Server-Log |
| `MAIL_FROM`        | `MyForrest <no-reply@…>` | Absender der E-Mails |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | Aktiviert „Mit Google anmelden“ (siehe [unten](#anmelden-mit-google-und-github)) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | – | Aktiviert „Mit GitHub anmelden“ |
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

## Anmelden mit Google und GitHub

Neben E-Mail und Passwort kann man sich mit einem Google- oder GitHub-Konto anmelden oder registrieren.
Ein Anbieter erscheint im Anmeldedialog, sobald Client-ID und Secret gesetzt sind. Die Rücksprungadresse
lautet `<PUBLIC_URL>/api/auth/oauth/<anbieter>/callback`; ohne `PUBLIC_URL` wird sie aus der Anfrage
gebildet. Sie muss beim Anbieter genau so eingetragen sein.

- *Google*: In der [Google Cloud Console](https://console.cloud.google.com/apis/credentials) einen
  OAuth-Client vom Typ „Webanwendung“ anlegen, als autorisierte Weiterleitungs-URI
  `https://example.org/api/auth/oauth/google/callback` eintragen. Bereiche: `openid`, `email`, `profile`.
- *GitHub*: Unter *Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers)*
  eine App anlegen, *Authorization callback URL* `https://example.org/api/auth/oauth/github/callback`.

```bash
PUBLIC_URL=https://example.org \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… npm start
```

Für lokale Versuche geht auch `http://localhost:3000` als Rücksprungadresse.

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

Die Referenzreihen für den Beginn der Herbstfärbung (siehe
[Phänologie-Referenzdaten](funktionen.md#phänologie-referenzdaten)) stammen vom Deutschen Wetterdienst
(Open Data, `opendata.dwd.de`, Jahresmelder Wildwachsende Pflanzen). Sie werden nicht automatisch geladen:

- `POST /api/phenoref/sync` lädt sie herunter (braucht Zugang zu `opendata.dwd.de`), oder
- einzelne Dateien werden importiert, zuerst die Stationen, danach jede Datei
  `PH_Jahresmelder_Wildwachsende_Pflanze_<Art>_….txt` mit `kind=observations&name=<Dateiname>`:

```bash
curl --data-binary @PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt \
  'localhost:3000/api/phenoref/import?format=dwd&kind=stations'
```

Andere Quellen wie MeteoSchweiz lassen sich als generisches CSV importieren (`format=generic`). Es hat die
Spalten `source;station_id;station_name;lat;lon;elevation;species;year;doy` (lateinischer Artname, Tag im
Jahr der beginnenden Blattverfärbung).

## Mit Docker und QGIS Server

`Dockerfile` baut MyForrest samt ffmpeg. Für Karten als WMS/WMTS/WFS (z. B. für map.geo.admin.ch) gibt es
unter [`deploy/qgis-server`](../deploy/qgis-server/README.md) eine Vorlage mit Docker Compose: MyForrest,
QGIS Server, nginx und ein Dienst, der das GeoPackage alle 15 Minuten neu exportiert. Das QGIS-Projekt
mit den Stilen liegt bei und wird mit `build-project.py` (PyQGIS) neu erzeugt.

## Weiter

- [Betrieb, Datenschutz und Datenquellen](betrieb.md): was vor einem öffentlichen Betrieb zu beachten ist
- [Architektur](architektur.md) und [REST-API](api.md)

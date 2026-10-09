# Betrieb, Datenschutz und Datenquellen

## Vor einem öffentlichen Betrieb

- Ohne `REQUIRE_LOGIN=1` lassen sich anonym hochgeladene Fotos von allen bearbeiten und löschen, wie bisher
  im Prototyp. Für einen öffentlichen Betrieb `REQUIRE_LOGIN=1` setzen und hinter HTTPS betreiben (das
  Sitzungs-Cookie erhält `Secure`, wenn die Anfrage über HTTPS bzw. `X-Forwarded-Proto: https` kommt).
- Mit Anmeldung über Google, GitHub, Microsoft, SWITCH edu-ID oder einen weiteren Dienst erhalten diese Dienste beim Anmelden die Information, dass sich
  jemand bei dieser Instanz anmeldet; MyForrest speichert vom Anbieter nur die Konto-Kennung, die E-Mail-Adresse
  und den Namen. Client-Secrets, private Schlüssel (`…_PRIVATE_KEY_FILE`) und `SMTP_URL` (enthält das Mail-Passwort) gehören in Secrets, nicht in
  Repository oder ConfigMap.
- Bilder werden unverändert gespeichert und ausgeliefert, **inklusive EXIF-Daten** (GPS,
  Kameramodell). Ausnahmen sind die Vorschaubilder und die aus HEIC umgewandelten JPEGs, die keine
  EXIF-Daten enthalten. Vor einem öffentlichen Betrieb sollten Metadaten entfernt und Personen sowie
  Kennzeichen automatisch verpixelt werden.
- Hinter einem Reverse Proxy `TRUST_PROXY` setzen (z. B. `loopback`, wenn der Proxy auf demselben Rechner läuft,
  `uniquelocal` für Container im privaten Netz). Sonst sieht die App für alle Anfragen die Adresse des Proxys, und
  die Sperren für Anmelden und Registrieren pro IP-Adresse treffen alle Nutzenden gemeinsam. Nur Proxys eintragen,
  die `X-Forwarded-For` selbst setzen bzw. ergänzen; wer `true` setzt, ohne dass ein Proxy davor steht, lässt
  gefälschte Adressen zu. Die Vorlagen für Docker Compose und Kubernetes setzen `uniquelocal`.
- Die Rate-Limits (Tabelle `rate_limits`) speichern IP- und E-Mail-Adressen nur als SHA-256-Hash und
  höchstens 24 Stunden. Das ist eine Pseudonymisierung, keine Anonymisierung: Ein Hash einer IP-Adresse
  lässt sich durch Durchprobieren zurückrechnen, deshalb die kurze Aufbewahrung. Wer eine Sperre von Hand aufheben will: `DELETE FROM rate_limits;` in der Datenbank.
- *Konto löschen* entfernt das Konto sofort aus der Datenbank. Behaltene Fotos sind danach nur noch über
  den Namen „Anonym“ vom Konto getrennt: Ihre EXIF-Daten (siehe oben) können weiterhin etwa Kameramodell
  oder einen in der Kamera eingetragenen Namen enthalten. Backups der Datenbank und von `data/uploads`
  enthalten gelöschte Konten noch, bis sie ersetzt werden; die Aufbewahrungsdauer der Backups gehört in die
  Datenschutzerklärung.
- Ausgeblendete Fotos werden nicht mehr ausgeliefert, können aber noch bis zu 7 Tage im Browser-Cache von
  Personen liegen, die sie vorher gesehen haben.
- Kartendaten © OpenStreetMap-Mitwirkende. Bei stärkerer Nutzung braucht es einen eigenen
  Tile-Anbieter (siehe Tile Usage Policy). Das Offline-Speichern einer Route lädt höchstens 1500 Kacheln
  bis Zoom 16 und nie Zoom 17 und mehr; bei vielen Nutzenden ist auch dafür ein eigener Anbieter angezeigt.

## Vorberechnete Vektorkacheln

Die Kacheln und die PMTiles/MBTiles-Exporte liegen in `data/tiles/` und gehören nicht ins Backup: Sie
entstehen jederzeit neu aus der Datenbank (`npm run tiles`). Weil die Kacheln Links auf die Fotos
enthalten, rechnet der Server pro Adresse, unter der er erreicht wird, einen eigenen Satz.

- **Mit `PUBLIC_URL`**: Der Server rechnet beim Start und nach Änderungen nur für diese Adresse vor. Für
  den öffentlichen Betrieb ist das die empfohlene Einstellung.
- **Ohne `PUBLIC_URL`**: Er rechnet für die Adresse aus der Anfrage vor und behält höchstens die Sätze der
  zwei zuletzt benutzten Adressen. So können erfundene `Host`-Köpfe den Speicher nicht füllen.

Mit `TILES_PRECOMPUTE=0` schneidet der Server jede Kachel bei der Anfrage, wie vor der Vorberechnung.

## Service Worker

Der Service Worker braucht HTTPS (oder `localhost`). Nach Änderungen an der Liste vorgehaltener Dateien
in `public/sw.js` `SHELL_VERSION` erhöhen; alte Caches werden beim Aktivieren gelöscht, offline gespeicherte Routen (`myforrest-offline-*`) nicht. App-Code
(HTML, JS, CSS) wird immer zuerst aus dem Netz geladen, ein Deployment ist also sofort sichtbar.

## Push-Nachrichten

Push braucht HTTPS wie der Service Worker. Die VAPID-Schlüssel liegen in der Datenbank (Tabelle
`push_keys`) oder kommen aus `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`. Wechseln die Schlüssel, werden alle
bestehenden Abos ungültig und müssen auf den Geräten neu eingeschaltet werden; beim Umzug also die
Datenbank mitnehmen oder die Schlüssel als Umgebungsvariablen setzen. Der Server sendet nur an die
Push-Dienste der Browser (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`, erweiterbar mit `PUSH_HOSTS`). Die Nachricht ist Ende-zu-Ende verschlüsselt; der
Push-Dienst sieht nur, dass eine Nachricht an ein Gerät geht.

## Externe Datenquellen und Netzzugang

| Quelle | Wofür | Hosts, die der Server erreichen muss |
|--------|-------|--------------------------------------|
| [Open-Meteo.com](https://open-meteo.com) (ERA5-Reanalyse, CC BY 4.0) | Wetter, Normalwerte, Böen, Geländehöhe | `archive-api.open-meteo.com`, `api.open-meteo.com` |
| Copernicus Sentinel-2 über [Earth Search](https://earth-search.aws.element84.com/v1) (Element 84, AWS Open Data) | Satellitenkontext NDVI/NDMI ab 2017, Frühwarnung | `earth-search.aws.element84.com`, `sentinel-cogs.s3.us-west-2.amazonaws.com` |
| Landsat Collection 2 (USGS) über [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com) | Satellitenkontext vor 2017 und Überlappung 2017–2018 | `planetarycomputer.microsoft.com`, `landsateuwest.blob.core.windows.net` |
| Deutscher Wetterdienst, Open Data | Phänologie-Referenzdaten ([laden](installation.md#phänologie-referenzdaten-laden)) | `opendata.dwd.de` |
| [Pl@ntNet](https://my.plantnet.org) (optional, API-Key) | Pflanzenbestimmung | `my-api.plantnet.org` |
| [BRouter](https://brouter.de) (Standard, `ROUTER_URL`) | Wege-Magnet: gezeichnete Touren folgen den Wegen; der Server schickt nur die Wegpunkte, ohne Konto oder IP der Person. Mit dem [eigenen BRouter](../deploy/brouter/README.md) bleibt das im eigenen Netz; dieser lädt nur seine Routing-Daten (OpenStreetMap, ODbL) | `brouter.de` (öffentlicher Dienst bzw. Download der Segmente) oder Host aus `ROUTER_URL` |
| Push-Dienste der Browser (Google, Mozilla, Apple, Microsoft) | Push-Nachrichten der Frühwarnung | `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.notify.windows.com` |
| OpenStreetMap | Kartenkacheln (im Browser) | – |
| swisstopo (geo.admin.ch) | Landeskarte und Luftbild der Vektorkarte LV95 (im Browser) | – |
| swisstopo (geo.admin.ch), swissBOUNDARIES3D | Kanton eines Spots für die kantonalen Schutzlisten (einmal pro Spot) | `api3.geo.admin.ch` |
| [Mapillary](https://www.mapillary.com) (optional, `MAPILLARY_TOKEN`; Bilder CC BY-SA 4.0) | Bilder im Durchgehen und auf der Karte, wo es keine eigenen gibt; nur der Server fragt an (Ausschnitt um einen Ort bzw. die Karte), der Browser lädt die Bilder von MyForrest | `graph.mapillary.com` und das Bild-CDN von Mapillary (`scontent*.fbcdn.net`) |
| Gletscherinventare, z. B. [GLAMOS](https://www.glamos.ch) (Swiss Glacier Inventory) | Gletscher-Spots, Umrisse pro Jahr (`GLETSCHER_GEOJSON`, lokale Dateien; Quellenangabe und Nutzungsbedingungen des Inventars beachten) | – |

Im Browser laufen [Leaflet](https://leafletjs.com) (BSD-2-Clause) für die App-Karte und
[MapLibre GL JS](https://maplibre.org) (BSD-3-Clause) für die Vektorkarte sowie
[OpenLayers](https://openlayers.org) (BSD-2-Clause) für die Vektorkarte in LV95; alle liefert der Server aus
`node_modules` aus, ohne CDN. Die LV95-Karte lädt ihre Hintergrundkarten im Browser von
`wmts.geo.admin.ch` (© swisstopo, frei nutzbar mit Quellenangabe). Die Vektorkacheln erzeugen [geojson-vt](https://github.com/mapbox/geojson-vt)
(ISC) und [vt-pbf](https://github.com/mapbox/vt-pbf) (MIT).

Die Wetterdaten werden pro ~10-km-Zelle gecacht; die Normalwerte 1991–2020 werden nur einmal pro Zelle
geladen. Die Satellitendaten enthalten modifizierte Copernicus-Sentinel-Daten; Landsat-Daten mit freundlicher
Genehmigung des U.S. Geological Survey. Eine Sentinel-2-Szene kostet pro Spot rund 4,4 MB Download (eine
interne Kachel pro Band); der erste Abruf eines Spots liest bis zu 60 Szenen, danach kommen nur neue
Aufnahmen dazu (die tägliche Frühwarn-Runde liest also wenig).

# Architektur

Server: Node.js mit Express und dem eingebauten `node:sqlite`. Frontend: Leaflet ohne Build-Schritt.
Die Routen sind in der [API-Übersicht](api.md) beschrieben.

## Aufbau

```
server.js            Einstiegspunkt
src/app.js           Express-App und REST-API
src/db.js            SQLite-Schema (spots, photos, photo_tags, identifications, region_labels, detections …)
src/spots.js         Gruppierung von Fotos zu Spots (Ort und Blickrichtung), Aufteilen gemischter Spots
src/thumbs.js        Vorschaubilder (WebP, 320 und 1280 px) in data/thumbs
src/heic.js          HEIC-Erkennung, EXIF aus HEIC, Umwandlung nach JPEG
src/align.js         Bildregistrierung (ORB-Merkmale, Matching, RANSAC); Panoramen über eine Drehung der Kugel
src/homography.js    3×3-Homographien: Verkettung, Inverse
src/sphere.js        360°-Panoramen: Richtungen, Drehung aus Punktpaaren (Horn, RANSAC), Umprojektion über die Naht
src/change.js        Veränderungserkennung und Heatmap (Fotos und Panoramen)
src/classify.js      Einordnung der veränderten Regionen (Regeln, gemischt mit dem gelernten Modell)
src/learn.js         Lernen der Einordnung aus Bestätigungen (Softmax-Regression, Hintergrund-Training)
src/foliage.js       Nadel-/Laubholzanteil (Heuristik) und Zuordnung von Verfärbungen zu Arten
src/detect.js        Objekterkennung: externer Detektor oder Heuristiken (liegende Stämme, Holzpolter)
src/routes/analysis.js  API der automatischen Auswertung
src/vegetation.js    Vegetationsdichte pro Foto (Grünanteil, Kronendach-Deckung, Lücken)
src/sentinel.js      Sentinel-2 NDVI/NDMI: STAC-Suche, COG-Fenster lesen, Wolkenmaske, Monatsreihe, Rückgänge, Frühwarnung
src/landsat.js       Landsat 5/7/8 (Collection 2) über Planetary Computer: signierte Links, QA-Maske, 30-m-Indizes
src/harmonize.js     Angleichung von Landsat an Sentinel-2 aus den Überlappungsmonaten (Theil–Sen, Landsat 5 über 7)
src/calibration.js   Kalibrierung der Frühwarnung und der Rückgänge zwischen Fotos an bestätigten Schäden (Rückrechnung ohne Blick nach vorn, F1, Kreuzvalidierung nach Spots, pro Waldtyp)
src/webpush.js       Web Push ohne Abhängigkeiten: VAPID (RFC 8292) und Verschlüsselung aes128gcm (RFC 8291)
src/routes/push.js   Push-Abos, Spot folgen/stummschalten, Frühwarnungen an regelmässige Besucher
src/canton.js        Kanton eines Spots über geo.admin.ch (für die kantonalen Schutzlisten)
src/forest-type.js   Waldtyp eines Spots (Laub/Nadel/Misch) aus Baumarten, Nadelholzanteil der Fotos oder dem winterlichen NDVI
src/utm.js           Umrechnung WGS84 ↔ UTM (Projektion der Sentinel-2-Kacheln)
src/routes/vegetation.js  API für Vegetationsdichte und NDVI, Hintergrund-Berechnung
src/weather.js       Wetterdaten und Mittel 1991–2020 von Open-Meteo (mit Cache)
src/irregularities.js  Auffälligkeiten (Trockenheit, Wärme, frühe Laubverfärbung …)
src/trees.js         Waldbaumarten mit Phänologie, Trockenheitsempfindlichkeit und Gefahren
src/phenology.js     Korrektur der Herbstfärbung für Höhe, Exposition und Kaltluftseen
src/phenoref.js      Phänologie-Referenzreihen (DWD-Jahresmelder, generisches CSV) und Stationsauswahl
src/storms.js        Sturmereignisse aus Spitzenböen, Verknüpfung mit Windwurf
src/nightcool.js     Nächtliche Abkühlung in Senken aus Wind und Bewölkung
src/openmeteo.js     Zeitreihen aus Archiv und Prognose von Open-Meteo zusammensetzen
src/routes/climate.js  Routen und Analyse-Hooks für Stürme, Phänologie-Referenz und Frostnächte
src/elevation.js     Geländehöhe, Hangneigung, Exposition und Geländeform (Copernicus-DEM über Open-Meteo)
src/exif.js          Aufnahmezeit, GPS und Blickrichtung aus den Bilddaten
src/gpx.js           GPX-Parser
src/mp4.js           MP4-Boxen lesen: Telemetrie-Spur, Startzeit, Dauer, 360°-Metadaten
src/gpmf.js          GoPro-Telemetrie (GPMF): GPS5/GPS9, GPSU, SCAL
src/video.js         Bilder entlang der Strecke planen, Blickrichtung, Schärfe und Wahl des schärfsten Bildes, ffmpeg-Aufruf
src/routes/video.js  Video-Upload und Fortschritt (/api/videos)
src/geo.js           Distanzen und Interpolation auf dem Track
src/plantnet.js      Anbindung an die Pl@ntNet-API
src/neophytes.js     Liste invasiver Neophyten (Schwarze Liste CH / BfN)
src/occurrences.js   Funde aus den Pl@ntNet-Bestimmungen, Filter und Artenübersicht
src/spread.js        Ausbreitungsfronten: Umrisse pro Jahr, Rate und Richtung
src/alphashape.js    Alpha-Shapes: Distanztransformation, Schliessen, Marching Squares, Teilbestände und Lücken
src/export.js        CSV-Export nach Darwin Core und im iNaturalist-Importformat
src/routes/species.js  API-Routen für Arten, Funde, Ausbreitung und Export
src/lv95.js          Schweizer Landeskoordinaten LV95 ↔ WGS84 (Näherungsformeln von swisstopo)
src/geodata.js       Daten als GIS-Collections (Spots, Fotos, Funde, Ausbreitungsfronten)
src/gpkg.js          GeoPackage-Schreiber (OGC GeoPackage 1.3) ohne GDAL
src/routes/ogc.js    OGC API – Features und GeoPackage-Export
src/tiles.js         Vektorkacheln: WebMercatorQuad, Kachelindex (geojson-vt), MVT-Kodierung (vt-pbf)
src/tiles-lv95.js    Vektorkacheln im Schweizer Kachelgitter LV95 (swisstopo): Zuschnitt pro Kachel, MVT-Kodierung
src/tile-cache.js    Vorberechnete Kacheln in data/tiles/tiles.db (pro Datenversion, gzip, Umschalten am Ende)
src/pmtiles.js       PMTiles-v3-Schreiber (Hilbert-Kachel-IDs, Verzeichnisse mit Leaf-Verzeichnissen, Deduplizierung)
src/mbtiles.js       MBTiles-1.3-Schreiber (SQLite)
src/metadata.js      Metadatensatz nach ISO 19139 und GM03 (ISO19139.che) für geocat.ch, viersprachig
src/routes/ogc-tiles.js  OGC API – Tiles (WebMercatorQuad und SwissLV95) und MapLibre-Stil
src/auth.js          Konten, Passwort-Hashing (scrypt), Sitzungen, Rate-Limit
src/orgs.js          Organisationen mit Leitung und Mitgliedern; gelten, solange eine Person der Leitung verifiziert ist
src/oauth.js         Anmelden mit Google und GitHub (OAuth 2.0 mit PKCE), ohne Abhängigkeiten
src/mail.js          E-Mail-Versand über SMTP (TLS/STARTTLS, AUTH PLAIN) für Bestätigungs- und Reset-Links
src/moderation.js    Lizenzen, Meldungen, Ausblenden und Protokoll
src/routes/accounts.js  Routen für Konten und Moderation, CSRF-Schutz, Rechte auf Fotos
src/routes/organizations.js  Mitglieder einer Organisation aufnehmen, Einladungen per E-Mail, Rollen, austreten
src/routes/profile.js   Eigene Profilseite: Zahlen und eigene Fotos (nur für das eigene Konto)
src/trackfile.js     Touren lesen (GPX, TCX, KML, GeoJSON) und als GPX schreiben
src/routegeo.js      Länge, Abstand zur Route und Position entlang der Route, Privatzone an den Enden
src/sensitive.js     Sensible Arten (Orchideen, geschützte Pflanzen), deren Funde automatisch geschützt werden; kantonale Schutzlisten (CSV-Import)
src/routes/protection.js  Geschützte Funde als 5-km-Raster für alle ohne PRO-Status
src/routes/tracks.js Touren, Routing-Proxy, Fotoaufträge (Erfüllung beim Upload) und Vorschläge entlang der Route
deploy/qgis-server/  Vorlage: MyForrest + QGIS Server (WMS/WMTS/WFS) + BRouter + nginx per Docker Compose
deploy/brouter/      Eigener Routing-Server (BRouter) für den Wege-Magnet, lädt seine Routing-Daten selbst
Dockerfile           Container für MyForrest (mit ffmpeg)
docs/                Dokumentation; docs/screenshots/ enthält die Bilder für das README
public/              Frontend (Leaflet, ohne Build-Schritt; forest.js zeichnet die Waldszene,
                     sun.js berechnet Sonnenstand und Einstrahlung, sunmap.js den Kartenmodus „Sonne & Wetter“,
                     hotspots.js den Kartenmodus „Arten & Neophyten“,
                     tours.js den Kartenmodus „Touren & Aufträge“ (Route zeichnen, aufzeichnen, importieren, Fotoaufträge),
                     video.js den Video-Upload und die 360°-Ansicht,
                     vegetation.js die Diagramme zu Vegetationsdichte und NDVI,
                     account.js Konto-Menü, Lizenz, Melden und Moderation;
                     vektorkarte.html zeigt die Vektorkacheln mit MapLibre,
                     vektorkarte-lv95.html im LV95-Gitter mit OpenLayers auf der Landeskarte)
public/sw.js         Service Worker: App-Shell vorhalten, Laufzeit-Caches, Background Sync
public/offline-queue.js  Warteschlange für Uploads ohne Verbindung (IndexedDB, von Seite und Service Worker genutzt)
public/pwa.js        Registrierung, Warteschlangen-Anzeige, Installieren-Knopf, Kamera-Aufnahme im Upload, Erlaubnis für Benachrichtigungen
public/offline-map.js  Karte und Spots entlang einer Route offline speichern (eigener Cache pro Route)
public/manifest.webmanifest, public/icons/  Web-App-Manifest und App-Icons
test/                Tests (`npm test`, Node-Testrunner)
scripts/generate-icons.js  Erzeugt die App-Icons aus dem Logo (`node scripts/generate-icons.js`)
scripts/build-tiles.js     Rechnet alle Vektorkacheln vor und schreibt PMTiles/MBTiles (`npm run tiles`)
```

# REST-API

Alle Routen liefern und erwarten JSON, sofern nicht anders angegeben. Den Aufbau des Codes beschreibt
[Architektur](architektur.md).

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features          |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum, Tags, Blickrichtung (`heading`) und Vorschaubild (`latestThumbUrl`) |
| `GET`    | `/api/spots/:id`             | Ein Spot mit Blickrichtung und allen Fotos chronologisch (jedes Foto mit `url`, `thumbUrl` und `largeUrl`) |
| `GET`    | `/thumbs/:datei`             | Vorschaubilder (WebP)                                    |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]` als JPEG, PNG, WebP oder HEIC, optional `spotId` und `refPhotoId` für Wiederholungsfotos, `license`, `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `utcOffsetMinutes`, `clockShiftSeconds`) |
| `POST`   | `/api/videos`                | Video-Upload (multipart: `video`, optional `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `clockShiftSeconds`, `frameDistanceM`, `frameIntervalS`, `panorama` = `auto`/`1`/`0`, `async=1` für Hintergrundverarbeitung) |
| `GET`    | `/api/videos/jobs/:id`       | Fortschritt und Ergebnis eines Video-Uploads mit `async=1` |
| `GET`    | `/api/videos/config`         | ffmpeg verfügbar? Standardabstand und -intervall         |
| `POST`   | `/api/spots/:id/align`       | Ausrichtung aller Fotos eines Spots neu berechnen        |
| `GET`    | `/api/photos/:id/change?to=` | Veränderte Fläche zwischen zwei ausgerichteten Fotos, mit eingeordneten Regionen |
| `GET`    | `/api/photos/:id/change.png?to=` | Heatmap der Veränderung (PNG, in der Ansicht des ersten Fotos) |
| `GET`    | `/api/weather/day?lat=&lon=&date=` | Stundenwerte eines Tages (Einstrahlung, Regen, Bewölkung, Temperatur): Messung oder Prognose |
| `GET`    | `/api/weather/day/spots?date=` | Tagesniederschlag an allen Spots                       |
| `GET`    | `/api/horizon?lat=&lon=`       | Geländehorizont (36 Richtungen) und Himmelssicht       |
| `GET`    | `/ogc`                         | OGC API – Features: Landing Page, `/ogc/conformance`, `/ogc/api` (OpenAPI) |
| `GET`    | `/ogc/collections[/:id]`       | Collections `spots`, `photos`, `findings`, `spread_fronts` mit Ausdehnung und Koordinatensystemen |
| `GET`    | `/ogc/collections/:id/items[/:fid]` | GeoJSON; `crs` (CRS84 oder `http://www.opengis.net/def/crs/EPSG/0/2056`), `bbox`, `bbox-crs`, `datetime`, `limit`, `offset` |
| `GET`    | `/api/export/myforrest.gpkg`   | Alle Collections als GeoPackage (LV95, `?crs=4326` für WGS84) |
| `GET`    | `/api/export/myforrest.pmtiles` | Vektorkacheln des Datensatzes (WebMercatorQuad, Zoom 0–18) als PMTiles v3; mit Range-Anfragen; 503 während der Berechnung |
| `GET`    | `/api/metadata/geocat.xml`     | Metadaten des Datensatzes nach GM03 (ISO19139.che) für geocat.ch |
| `GET`    | `/api/metadata/iso19139.xml`   | Dieselben Metadaten als reines ISO 19139 |
| `GET`    | `/api/export/myforrest.mbtiles` | Dieselben Kacheln als MBTiles 1.3 (SQLite); 503 während der Berechnung |
| `GET`    | `/ogc/tileMatrixSets[/{tms}]` | Kachelgitter (OGC Two Dimensional Tile Matrix Set): `WebMercatorQuad` und `SwissLV95` (EPSG:2056, Gitter von swisstopo) |
| `GET`    | `/ogc/tiles[/{tms}]` | Vektorkacheln des Datensatzes: Liste und Tileset (für WebMercatorQuad zugleich TileJSON 3.0; für SwissLV95 mit Ausdehnung in LV95) |
| `GET`    | `/ogc/tiles/{tms}/{z}/{y}/{x}` | Kachel (MVT) mit den Ebenen `spread_fronts`, `spots`, `findings`; 204 wenn leer |
| `GET`    | `/ogc/collections/:id/tiles[/{tms}[/{z}/{y}/{x}]]` | Vektorkacheln einer Collection |
| `GET`    | `/ogc/styles/myforrest`        | MapLibre-Stil für die Kacheln (auch für QGIS) |
| `GET`    | `/api/trees`                 | Liste der unterstützten Baumarten mit Steckbrief         |
| `GET`    | `/api/spots/:id/storms`      | Sturmereignisse am Spot (ab 12 Monate vor dem ersten Foto), mit verknüpften Windwurf-Fotos |
| `GET`    | `/api/photos/:id/storm?to=`  | Wahrscheinlichster Sturm zwischen zwei Fotos             |
| `GET`    | `/api/storms/spots`          | Spots mit Sturm seit dem ersten Foto (aus dem Cache; fehlende werden im Hintergrund geladen) |
| `GET`    | `/api/phenoref`              | Geladene Phänologie-Reihen (Stationen, Beobachtungen, Arten) |
| `GET`    | `/api/spots/:id/phenoref`    | Referenz für den Beginn der Herbstfärbung am Spot, pro Art mit Stationen |
| `POST`   | `/api/phenoref/sync`         | DWD-Jahresmelder-Daten herunterladen (braucht Zugang zu `opendata.dwd.de`) |
| `POST`   | `/api/phenoref/import?format=` | Datei als Text importieren: `generic` (CSV) oder `dwd&kind=stations\|plants\|phases\|observations&name=<Dateiname>` |
| `PATCH`  | `/api/spots/:id`             | Höhe (`{ elevation: 950 }`), Exposition (`{ exposition: 'S' }`, auch `'eben'`) und/oder Geländeform (`{ landform: 'senke' }`) von Hand setzen; `null` ermittelt den Wert neu |
| `POST`   | `/api/spots/:id/species`     | Baumart einem Spot zuordnen (`{ scientificName }`)       |
| `DELETE` | `/api/spots/:id/species?name=` | Baumart vom Spot entfernen                             |
| `GET`    | `/api/photos/:id/context`    | Wetter-Kontext und Auffälligkeiten (wird beim ersten Abruf berechnet und gespeichert) |
| `POST`   | `/api/photos/:id/context`    | Wetter-Kontext neu laden                                 |
| `PATCH`  | `/api/photos/:id`            | Tags und Notiz ändern; `license` nur durch den Urheber   |
| `DELETE` | `/api/photos/:id`            | Foto löschen (Urheber oder Moderation; anonyme Fotos ohne `REQUIRE_LOGIN` frei) |
| `GET`    | `/api/auth/me`               | Angemeldetes Konto (mit `identities`, `emailVerified`, `hasPassword`), CSRF-Token, Lizenzen, Meldegründe, `requireLogin`, `requireVerifiedEmail`, `providers` |
| `POST`   | `/api/auth/register`         | Konto anlegen (JSON: `email`, `name`, `password`) und anmelden; schickt den Bestätigungslink (`verification`: `sent`, `logged` oder `failed`) |
| `POST`   | `/api/auth/login`            | Anmelden (JSON: `login` = E-Mail oder Name, `password`)  |
| `POST`   | `/api/auth/logout`           | Abmelden                                                 |
| `GET`    | `/api/auth/verify?token=`    | Link aus der Bestätigungs-E-Mail: bestätigt die Adresse, leitet nach `/?auth=verified` bzw. `/?auth_error=…` |
| `POST`   | `/api/auth/verify/resend`    | Neuen Bestätigungslink senden (angemeldet, Adresse unbestätigt; 3 pro Stunde) |
| `GET`    | `/api/auth/oauth/:provider`  | Anmelden mit `google` oder `github`: leitet zum Anbieter weiter |
| `GET`    | `/api/auth/oauth/:provider/callback` | Rückkehr vom Anbieter: meldet an, legt ein Konto an oder verknüpft (mit Sitzung); leitet nach `/?auth=ok\|created\|linked` bzw. `/?auth_error=…` |
| `DELETE` | `/api/auth/identities/:provider` | Anmeldung über einen Anbieter vom eigenen Konto trennen (nicht die einzige) |
| `POST`   | `/api/photos/:id/report`     | Foto melden (`{ reason, note }`), auch ohne Konto        |
| `GET`    | `/api/moderation/queue`      | Moderation: offene Meldungen pro Foto und ausgeblendete Fotos |
| `POST`   | `/api/moderation/photos/:id/hide` | Foto ausblenden (`{ reason }`), erledigt seine Meldungen |
| `POST`   | `/api/moderation/photos/:id/unhide` | Foto wieder einblenden                           |
| `POST`   | `/api/moderation/photos/:id/dismiss` | Meldungen zu einem Foto verwerfen               |
| `GET`    | `/api/moderation/log`        | Protokoll der Moderation                                 |
| `GET`    | `/api/users`                 | Admin: Konten mit Rolle und Anzahl Fotos                 |
| `PATCH`  | `/api/users/:id`             | Admin: Rolle setzen (`{ role: 'user' \| 'moderator' \| 'admin' }`) |

| `POST`   | `/api/photos/:id/identify`   | Pflanzen bestimmen (Pl@ntNet)                            |
| `GET`    | `/api/species`               | Arten mit Funden: Anzahl, Spots, Jahre, Neophyt ja/nein  |
| `GET`    | `/api/occurrences`           | Funde (bestes Pl@ntNet-Ergebnis pro Foto). Filter für diese und die folgenden Routen: `species`, `neophytes=1`, `minScore` (Standard 0,2), `bbox=west,süd,ost,nord`, `from`/`to` (Datum) |
| `GET`    | `/api/spread?species=`       | Ausbreitungsfronten einer Art: Umriss (`polygons` mit Lücken), Fläche, Teilbestände und Frontabstand pro Jahr, Rate und Richtung, dazu `patches` mit Rate, Richtung, Flächenzuwachs, Sprung und Zusammenwachsen (`until`, `mergedInto`, `absorbed`) pro Teilbestand, Umriss pro Jahr (`buffer` in m, Standard 25; `alpha` in m, Standard automatisch; `shape=convex` für die konvexe Hülle) |
| `GET`    | `/api/export/dwc.csv`        | Funde als Darwin-Core-Occurrence-CSV (Info Flora, GBIF)  |
| `GET`    | `/api/export/inaturalist.csv` | Funde im CSV-Importformat von iNaturalist               |
| `GET`    | `/api/spots/:id/vegetation`  | Grünanteil, Kronendach-Deckung, Lückenanteil und GCC pro Foto (`pending`: noch in Berechnung) |
| `GET`    | `/api/spots/:id/ndvi`        | NDVI und NDMI pro Monat (Sentinel-2, vor 2017 Landsat an Sentinel-2 angeglichen; `sensors`, `adjusted` und die gemessenen Werte `raw` pro Monat), Rückgänge zwischen Fotodaten (`drops`, mit `index`, Belegen aus den Fotos und Sturm), Frühwarnungen (`alerts`); `status`: `ready`, `pending` (wird geladen), `offline` |
| `POST`   | `/api/spots/:id/ndvi`        | Satellitendaten neu laden                                |
| `GET`    | `/api/satellite/calibration` | Schwellen der Frühwarnung pro Index: `kalibriert` oder `standard` (mit `reason`), Kontrollen mit und ohne Schaden, Spots, Kreuzvalidierung an zurückgehaltenen Spots (`cv`), Anfangswert zum Vergleich (`standard`), Treffer und Fehlalarme pro Schwelle (`sweep`) |
| `POST`   | `/api/satellite/calibration` | Sofort neu kalibrieren                                   |
| `GET`    | `/api/satellite/harmonization` | Angleichung von Landsat an Sentinel-2 pro Index und Satellit (Gerade oder Versatz, Monatspaare, Abstand vorher, Restabweichung) |
| `POST`   | `/api/satellite/harmonization` | Sofort neu schätzen |
| `GET`    | `/api/satellite/alerts`      | Frühwarnung: Spots, deren letzte Monate gegenüber derselben Jahreszeit der Vorjahre gefallen sind (Index, seit wann, wie stark, Sturm davor, ob ein Besuch lohnt, `calibration`: verwendete Schwelle) |
| `GET`    | `/api/photos/:id/regions?to=` | Veränderte Regionen mit entscheidender Quelle (Regel/gelernt), Sicherheit, Nadelholzanteil, vermuteter Art und eigener Bestätigung |
| `POST`   | `/api/photos/:id/region-labels` | Region bestätigen oder korrigieren (`{ to, index, class }`, `class: null` entfernt die Bestätigung) |
| `GET`    | `/api/analysis/status`       | Stand des Lernmodells (Beispiele pro Klasse, Genauigkeit) und des Detektors (Bestätigungsquote pro Label) |
| `POST`   | `/api/analysis/retrain`      | Modell sofort neu trainieren (läuft sonst nach neuen Bestätigungen im Hintergrund) |
| `GET`    | `/api/photos/:id/foliage`    | Nadel-/Laubholzanteil des Fotos mit 4×3-Raster (Heuristik) |
| `GET`    | `/api/photos/:id/detections` | Erkannte Objekte (beim ersten Abruf berechnet und gespeichert) |
| `POST`   | `/api/photos/:id/detections` | Erkennung neu laufen lassen; bestätigte und abgelehnte Treffer bleiben |
| `PATCH`  | `/api/detections/:id`        | Treffer bewerten (`{ status: 'bestaetigt' \| 'abgelehnt' \| 'offen' }`) |

Fotos enthalten im JSON zusätzlich `uploader` (`{ id, name }` oder `null`), `license` (`{ id, label, url }`)
und `hidden`. Schreibende Anfragen mit Sitzungs-Cookie brauchen den Header `X-CSRF-Token`.

# REST-API

Alle Routen liefern und erwarten JSON, sofern nicht anders angegeben. Den Aufbau des Codes beschreibt
[Architektur](architektur.md).

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features (u. a. `mapillary`), Landschaftsprofile (`landscapes`: Bezeichnung und Beobachtungen je Profil) und Gletscherinventare (`glaciers.years`, `null` ohne Umrisse) |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum, Tags, Blickrichtung (`heading`), Landschaft (`landscape`) und Vorschaubild (`latestThumbUrl`) |
| `GET`    | `/api/spots/:id`             | Ein Spot mit Blickrichtung, Landschaft (`landscape`, `landscapeSource`: `upload`, `auto`, `manual` oder `null`) und allen Fotos chronologisch (jedes Foto mit `url`, `thumbUrl` und `largeUrl`, `archive` für Archivfotos, `panorama` für 360°-Bilder und `alignment`: bei Fotos die Homographie `h`, bei Panoramen `kind: 'rotation'` mit der Drehung `r`, `yaw` und `tilt`) |
| `GET`    | `/thumbs/:datei`             | Vorschaubilder (WebP)                                    |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]` als JPEG, PNG, WebP oder HEIC, optional `spotId` und `refPhotoId` für Wiederholungsfotos, `requestId` für einen Fotoauftrag, `sequenceId` für Bilder einer Aufnahme (Fahrt, Upload mit mehreren Fotos), `landscape` (`wald`, `gletscher`, `gebirge`, `trocken`) für das Landschaftsprofil eines neuen Spots, `archive=1` mit `spotId` und `takenAt` für ein Archivfoto (Datum von Hand, am Spot verortet), `protected=1` für einen geschützten Fund, `license`, `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity` (`joggen`, `wandern`, `biken`, `fahren`, `sonstiges`), `heading` (Blickrichtung in Grad, wenn das Foto keine im EXIF hat), `note`, `utcOffsetMinutes`, `clockShiftSeconds`). Mit `activity=fahren` (Fahrtmodus) wird pro Konto und Ort innerhalb von 12 Stunden nur ein Bild gespeichert, weitere stehen in `skipped` |
| `POST`   | `/api/videos`                | Video-Upload (GPS aus GoPro-Telemetrie oder der Dashcam: NMEA bzw. Novatek `freeGPS`, sonst `gpx`; `video.track` im Ergebnis: `gpmf`, `nmea`, `novatek`, `gpx` oder `manual`) (multipart: `video`, optional `gpx` (GPX oder NMEA), `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `clockShiftSeconds`, `frameDistanceM`, `frameIntervalS`, `panorama` = `auto`/`1`/`0`, `landscape`, `async=1` für Hintergrundverarbeitung) |
| `GET`    | `/api/videos/jobs/:id`       | Fortschritt und Ergebnis eines Video-Uploads mit `async=1` |
| `GET`    | `/api/videos/config`         | ffmpeg verfügbar? Standardabstand und -intervall         |
| `GET`    | `/api/protected-species`     | Geladene Schutzlisten pro Kanton (`canton`, `entries`, `sources`, `loadedAt`) |
| `GET`    | `/api/protected-species/check?name=&spot=` | Ob eine Art am Spot geschützt ist (`protected`: Liste `eingebaut`, `CH` oder Kanton, Status, Quelle) und der Kanton des Spots |
| `POST`   | `/api/protected-species/import` | Admins: Schutzliste als CSV (`kanton;art;status;quelle`), ersetzt die Listen dieser Kantone; schützt bereits bestimmte Funde (`protectedPhotos`) |
| `DELETE` | `/api/protected-species/:canton` | Admins: Liste eines Kantons entfernen |
| `POST`   | `/api/spots/:id/align`       | Ausrichtung aller Fotos eines Spots neu berechnen        |
| `GET`    | `/api/spots/:id/split`       | Vorschlag zum Aufteilen nach Blickrichtung: `mixed`, `groups` (`heading`, `photoIds`; die grösste Gruppe zuerst, sie behält den Spot) |
| `POST`   | `/api/spots/:id/split`       | Spot aufteilen: ohne Body nach Blickrichtung, mit `{ photoIds }` diese Fotos in einen neuen Spot; Antwort `spots` (alle betroffenen Spots), danach neu ausgerichtet |
| `GET`    | `/api/photos/:id/change?to=` | Veränderte Fläche zwischen zwei ausgerichteten Fotos, mit eingeordneten Regionen |
| `GET`    | `/api/photos/:id/change.png?to=` | Heatmap der Veränderung (PNG, in der Ansicht des ersten Fotos) |
| `GET`    | `/api/walk/:id?at=`          | Durchgehen: das Bild, Wege entlang seiner Reihe (`weg`, vor/zurück, bis 500 m), zu Spots im Umkreis von 80 m (`spot`) und mit `MAPILLARY_TOKEN` zu Mapillary-Bildern in freien Richtungen (`mapillary`, mit `creator`, `license`, `pageUrl`), je mit Richtung und Distanz, die anderen Bilder des Spots (`times`) und der Verlauf der Reihe (`track`); `at` wählt bei Spots das zeitlich nächste Bild |
| `GET`    | `/api/walk/mapillary/:id`    | Durchgehen ab einem Mapillary-Bild (Id ohne `m`): das Bild (`id` = `m<id>`, `source: 'mapillary'`) und Wege entlang seiner Mapillary-Reihe, zu Spots und zu anderen Mapillary-Bildern |
| `GET`    | `/api/mapillary/images?bbox=` | Mapillary-Bilder in einem Ausschnitt (höchstens 0,01° pro Seite) für die Karte; 404 ohne Token, 502 wenn Mapillary nicht erreichbar ist |
| `GET`    | `/api/mapillary/images/:id/file` | Das Mapillary-Bild selbst (2048 px, 360°-Bilder 2:1), vom Server geladen und zwischengespeichert |
| `GET`    | `/api/photos/:id/aligned.jpg?frame=` | 360°-Panorama in die Blickrichtung eines anderen Panoramas desselben Spots gedreht (JPEG 2048 × 1024, mit ETag) |
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
| `GET`    | `/api/export/myforrest-kacheln-lv95.gpkg` | Die Vektorkacheln im LV95-Gitter von swisstopo (Stufen 15–26) als GeoPackage mit der OGC-Erweiterung für Vektorkacheln; 503 während der Berechnung |
| `GET`    | `/ogc/tileMatrixSets[/{tms}]` | Kachelgitter (OGC Two Dimensional Tile Matrix Set): `WebMercatorQuad` und `SwissLV95` (EPSG:2056, Gitter von swisstopo) |
| `GET`    | `/ogc/tiles[/{tms}]` | Vektorkacheln des Datensatzes: Liste und Tileset (für WebMercatorQuad zugleich TileJSON 3.0; für SwissLV95 mit Ausdehnung in LV95) |
| `GET`    | `/ogc/tiles/{tms}/{z}/{y}/{x}` | Kachel (MVT) mit den Ebenen `spread_fronts`, `spots`, `findings`; 204 wenn leer |
| `GET`    | `/ogc/collections/:id/tiles[/{tms}[/{z}/{y}/{x}]]` | Vektorkacheln einer Collection |
| `GET`    | `/ogc/styles/myforrest`        | MapLibre-Stil für die Kacheln (auch für QGIS) |
| `GET`    | `/api/trees`                 | Liste der unterstützten Baumarten mit Steckbrief         |
| `GET`    | `/api/spots/:id/storms`      | Sturmereignisse am Spot (ab 12 Monate vor dem ersten Foto), mit verknüpften Windwurf-Fotos |
| `GET`    | `/api/photos/:id/storm?to=`  | Wahrscheinlichster Sturm zwischen zwei Fotos             |
| `GET`    | `/api/storms/spots`          | Spots mit Sturm seit dem ersten Foto (aus dem Cache; fehlende werden im Hintergrund geladen) |
| `GET`    | `/api/phenoref`              | Geladene Phänologie-Reihen (Stationen, Beobachtungen der Verfärbung, `leafout`: Beobachtungen des Austriebs, Arten) |
| `GET`    | `/api/spots/:id/phenoref`    | Referenz für den Beginn der Herbstfärbung am Spot, pro Art mit Stationen |
| `GET`    | `/api/spots/:id/leafout?year=` | Laubaustrieb am Spot für ein Jahr (Standard: dieses): beobachtet (`year`) oder Mittel der letzten zehn Jahre (`year: null`), mit Stationen und `label` |
| `POST`   | `/api/phenoref/sync`         | DWD-Jahres- und Sofortmelder herunterladen (braucht Zugang zu `opendata.dwd.de`); `?source=meteoschweiz`: Phänologie-OGD von MeteoSchweiz (`data.geo.admin.ch`) |
| `POST`   | `/api/phenoref/import?format=` | Datei als Text importieren: `generic` (CSV), `dwd&kind=stations\|plants\|phases\|observations&name=<Dateiname>` oder `meteoschweiz&kind=parameters\|stations\|observations` |
| `PATCH`  | `/api/spots/:id`             | Höhe (`{ elevation: 950 }`), Exposition (`{ exposition: 'S' }`, auch `'eben'`) und/oder Geländeform (`{ landform: 'senke' }`) von Hand setzen; `null` ermittelt den Wert neu |
| `PUT`    | `/api/spots/:id/landscape`   | Landschaftsprofil von Hand setzen (`{ landscape: 'gletscher' }`); `null` bestimmt es neu (Gletscherumrisse) |
| `GET`    | `/api/spots/:id/glacier`     | Gletscher am Spot: `glacier` (Name, `latestYear`, `distanceM` zum Eis des neusten Inventars, `history` mit `ice` pro Inventarjahr) und `satellite` (Schnee- und Eisanteil: `monthly`, `summers` mit dem Spätsommerwert pro Jahr, `iceFreeSince`, `meltOut` mit dem Monat der Ausaperung pro Jahr, `status`) |
| `GET`    | `/api/glaciers?bbox=&year=`  | Gletscherumrisse als GeoJSON (vereinfacht, `name` und `year` pro Umriss), alle Inventare oder eines; `years` listet die Inventarjahre |
| `POST`   | `/api/spots/:id/species`     | Baumart einem Spot zuordnen (`{ scientificName }`)       |
| `DELETE` | `/api/spots/:id/species?name=` | Baumart vom Spot entfernen                             |
| `GET`    | `/api/photos/:id/context`    | Wetter-Kontext und Auffälligkeiten (wird beim ersten Abruf berechnet und gespeichert) |
| `POST`   | `/api/photos/:id/context`    | Wetter-Kontext neu laden                                 |
| `PATCH`  | `/api/photos/:id`            | Tags und Notiz ändern; `license` nur durch den Urheber; `protected` (true/false) durch den Urheber, PRO-Mitglieder oder Moderation |
| `DELETE` | `/api/photos/:id`            | Foto löschen (Urheber oder Moderation; anonyme Fotos ohne `REQUIRE_LOGIN` frei) |
| `GET`    | `/api/auth/me`               | Angemeldetes Konto (mit `identities`, `emailVerified`, `hasPassword`, `pendingEmail`), CSRF-Token, Lizenzen, Meldegründe, `requireLogin`, `requireVerifiedEmail`, `providers` |
| `POST`   | `/api/auth/register`         | Konto anlegen (JSON: `email`, `name`, `password`, optional `invite` = Token einer Einladung) und anmelden; schickt den Bestätigungslink (`verification`: `sent`, `logged` oder `failed`), ausser die Einladung gilt für diese Adresse (`invite`: Adresse gleich bestätigt) |
| `POST`   | `/api/auth/login`            | Anmelden (JSON: `login` = E-Mail oder Name, `password`)  |
| `POST`   | `/api/auth/logout`           | Abmelden                                                 |
| `GET`    | `/api/auth/verify?token=`    | Link aus der Bestätigungs-E-Mail: bestätigt die Adresse, leitet nach `/?auth=verified` bzw. `/?auth_error=…` |
| `POST`   | `/api/auth/verify/resend`    | Neuen Bestätigungslink senden (angemeldet, Adresse unbestätigt; 3 pro Stunde) |
| `POST`   | `/api/auth/password/forgot`  | Link zum Zurücksetzen an `{ email }` schicken; antwortet immer `{ ok: true }` |
| `GET`    | `/api/profile`               | Eigenes Profil: Fotos (`photoBytes` = Grösse der Originale), Spots, fortgesetzte Zeitreihen (`repeatSpots`), Jahre, Aktivitäten, Touren, Fotoaufträge, gefolgte Spots |
| `GET`    | `/api/profile/photos`        | Eigene Fotos, neueste zuerst (`?offset`, `?limit` bis 200, `?filter=alle\|geschuetzt\|ausgeblendet`); ausgeblendete ohne Bild-URLs |
| `GET`    | `/api/profile/export`        | Eigene Daten als ZIP (`?fotos=0` ohne Originaldateien); höchstens 5 pro Stunde |
| `POST`   | `/api/auth/email`            | Neue E-Mail-Adresse anfordern (`{ email, password }` bzw. `name` ohne Passwort); schickt den Link an die neue Adresse |
| `DELETE` | `/api/auth/email`            | Offene Änderung der E-Mail-Adresse abbrechen |
| `GET`    | `/api/auth/email/confirm?token=` | Link an die neue Adresse: übernimmt sie, leitet nach `/?auth=email-changed` bzw. `/?auth_error=…` |
| `PATCH`  | `/api/auth/me`               | Angemeldet: Anzeigename ändern (`{ name }`); höchstens 3 pro Tag |
| `GET`    | `/api/auth/account`          | Angemeldet: was beim Löschen betroffen wäre (`photos`, `tracks`, `requests`), `confirmWith` (`password` oder `name`), `blocker` |
| `DELETE` | `/api/auth/account`          | Eigenes Konto löschen (`{ photos: delete\|anonymize, password }` bzw. `name` ohne Passwort) |
| `POST`   | `/api/auth/password/change`  | Angemeldet: Passwort ändern (`{ current, password }`); beendet die anderen Sitzungen, Hinweis per E-Mail |
| `GET`    | `/api/auth/password/reset?token=` | Prüft einen Link: `{ name, email }` oder 400 |
| `POST`   | `/api/auth/password/reset`   | Neues Passwort setzen (`{ token, password }`): beendet alle Sitzungen und meldet an |
| `GET`    | `/api/auth/jwks.json`        | Öffentliche Schlüssel der App für `private_key_jwt` (JWKS), zum Hinterlegen bei AGOV o. Ä. |
| `GET`    | `/api/auth/oauth/:provider`  | Anmelden mit `google`, `github`, `microsoft`, `eduid`, `agov` oder `oidc`: leitet zum Anbieter weiter |
| `GET`    | `/api/auth/oauth/:provider/callback` | Rückkehr vom Anbieter: meldet an, legt ein Konto an oder verknüpft (mit Sitzung); leitet nach `/?auth=ok\|created\|linked` bzw. `/?auth_error=…` |
| `DELETE` | `/api/auth/identities/:provider` | Anmeldung über einen Anbieter vom eigenen Konto trennen (nicht die einzige) |
| `POST`   | `/api/tracks/parse`          | GPX, TCX, KML, GeoJSON oder NMEA (`{ text, filename }`) bzw. FIT (`{ base64, filename }`) lesen, ohne zu speichern: Punkte, Name, Format, Länge; Punkte mit Sensorwerten tragen `hr`, `power`, `cadence` bzw. `steps`, `temp`; dazu `sensors` (`[{ key, label, unit, avg, min, max, n }]`, bei FIT auch Developer-Felder als `dev:<Name>`) |
| `POST`   | `/api/route-profile`         | Höhenprofil einer Route (`{ points: [[lat, lon, ele?], …] }`): `samples` (`d`, `ele`), `ascent`, `descent`, `min`, `max`, `source` (`route` = eigene Höhen, `modell` = Höhenmodell) |
| `GET`    | `/api/tracks`                | Öffentliche Touren (Name, Länge, Start nach der 200-m-Privatzone, Besitzer), `?bbox=w,s,e,n`; `?mine=1` die eigenen |
| `POST`   | `/api/tracks`                | Tour speichern (Konto nötig): `{ name, kind: gezeichnet\|aufgezeichnet\|importiert, activity, visibility: privat\|oeffentlich, points: [[lat, lon, ele, time, { hr, power, cadence, steps, temp }?], …], sensors?, shareTemp? }`; unplausible Sensorwerte fallen weg; `sensors` aus `/api/tracks/parse` nur bei `importiert`, zurück nur an den Besitzer |
| `GET`    | `/api/tracks/:id`            | Tour mit Punkten; für andere ohne Zeiten, ohne Sensorwerte und ohne die ersten und letzten 200 m |
| `GET`    | `/api/tracks/:id.gpx`        | Tour als GPX                                             |
| `PATCH`  | `/api/tracks/:id`            | `name`, `activity`, `visibility` (nur Besitzer oder Moderation); `shareTemp` (nur Besitzer, nur bei Touren mit Temperaturen): Temperaturen anonym zur Karte kühler Abschnitte beitragen |
| `DELETE` | `/api/tracks/:id`            | Tour löschen                                             |
| `GET`    | `/api/route?points=lat,lon;lat,lon` | Weg zwischen Wegpunkten vom Routing-Dienst (`ROUTER_URL`, Profil `ROUTER_PROFILE`); 501 ohne Dienst. Wildruhezonen in der Schutzzeit gehen als Sperrflächen mit: `wildlifeZones` (umgangen), `insideWildlifeZones` (ein Wegpunkt liegt darin) |
| `GET`    | `/api/closures?bbox=w,s,e,n` | Sperrungen bei Holzerei (`lat`, `lon`, `radiusM`, `reason`, `until`, `auto` = aus einem Holzschlag-Foto, `removable`) und ob das Konto Sperrungen setzen darf (`mayClose`) |
| `POST`   | `/api/closures`              | PRO-Mitglieder und Moderation: Sperrung setzen (`{ spotId }` oder `{ lat, lon }`, `until` JJJJ-MM-TT bis in 12 Monaten, `radiusM` 20–500, Standard 100, `reason`); `/api/route` führt mit `nogos` darum herum und nennt sie in `closures` bzw. `insideClosures` |
| `DELETE` | `/api/closures/:id`          | Sperrung aufheben (wer sie gesetzt hat, oder Moderation) |
| `GET`    | `/api/cool-cells?bbox=w,s,e,n` | Karte kühler Abschnitte aus geteilten Tour-Temperaturen, optional `season=sommer\|winter` und `daytime=tag\|nacht` (nur Touren dieser Art; Touren, deren Uhr weit neben der Lufttemperatur des Wettermodells lag, zählen nie): `cells` (`lat`, `lon` der Zellmitte, `delta` °C gegenüber dem Rest derselben Touren, `tours`), `cellM`, `minTours`, `minPeople`; höchstens 0,5° × 0,3° |
| `GET`    | `/api/wildlife-zones?bbox=w,s,e,n` | Wildruhezonen in der Schutzzeit als GeoJSON (`name`, `season`), für die Karte; `wildlifeZones` in `/api/config` sagt, ob welche hinterlegt sind |
| `POST`   | `/api/route-suggestions`     | Fotoaufträge, Spots mit Satelliten-Frühwarnung und lange nicht besuchte Spots nahe einer Route (`{ points, maxDistanceM }`), mit Abstand und Kilometer; die Route wird nicht gespeichert |
| `GET`    | `/api/photo-requests`        | Offene, nicht abgelaufene Fotoaufträge (`?status=alle` auch erledigte und abgelaufene, `status: 'abgelaufen'`), mit `expiresAt`, ohne Namen der anfragenden Person |
| `POST`   | `/api/photo-requests`        | Fotoauftrag: `{ lat, lon, heading?, title, note?, expiresInDays? }` oder `{ spotId, title }`; `expiresInDays` 7, 30, 90 oder 365, leer = bis erledigt. Wer ihn erstellt hat, bekommt beim Erledigen eine Push-Nachricht |
| `DELETE` | `/api/photo-requests/:id`    | Auftrag zurückziehen (wer ihn erstellt hat, oder Moderation) |
| `POST`   | `/api/photos/:id/report`     | Foto melden (`{ reason, note }`), auch ohne Konto        |
| `GET`    | `/api/moderation/queue`      | Moderation: offene Meldungen pro Foto und ausgeblendete Fotos |
| `POST`   | `/api/moderation/photos/:id/hide` | Foto ausblenden (`{ reason }`), erledigt seine Meldungen |
| `POST`   | `/api/moderation/photos/:id/unhide` | Foto wieder einblenden                           |
| `POST`   | `/api/moderation/photos/:id/dismiss` | Meldungen zu einem Foto verwerfen               |
| `GET`    | `/api/moderation/log`        | Protokoll der Moderation                                 |
| `GET`    | `/api/users`                 | Admin: Konten mit Rolle, Anzahl Fotos, PRO-Status (`proStatus`, `organization`, `proNote`) und Organisationen (`organizations`: `name`, `role`, `valid`) |
| `POST`   | `/api/auth/pro`              | PRO-Mitgliedschaft beantragen (`{ organization, note }`) |
| `POST`   | `/api/users/:id/pro`         | Admin: PRO-Antrag entscheiden (`{ decision: 'verifiziert' \| 'abgelehnt' \| 'entzogen', organization? }`); verifiziert leitet die Person danach die Organisation |
| `GET`    | `/api/organizations/mine`    | Eigene Organisationen mit Rolle, `validUntil`, `valid` und Mitgliedern (E-Mail-Adressen nur für die Leitung) |
| `GET`    | `/api/organizations`         | Admin: alle Organisationen mit Mitgliedern |
| `POST`   | `/api/organizations/:id/members` | Leitung, Admin: Konto aufnehmen (`{ account: Name oder E-Mail, role?: 'mitglied' \| 'leitung' }`); nur solange die Organisation gilt. 201 für ein Konto mit bestätigter Adresse; 202 mit `invited` für eine E-Mail-Adresse ohne solches Konto (Einladung per E-Mail) |
| `DELETE` | `/api/organizations/:id/invites/:inviteId` | Leitung, Admin: Einladung zurückziehen (offene Einladungen stehen in `invites` der Organisation) |
| `POST`   | `/api/organizations/invites/lookup` | Was hinter einem Einladungslink steht (`{ token }` → `organization`, `email`, `role`, `expiresAt`, `hasAccount`); auch ohne Anmeldung, 30 pro Stunde und IP |
| `POST`   | `/api/organizations/invites/accept` | Einladung annehmen (`{ token }`), angemeldet mit der eingeladenen Adresse (sonst 409); bestätigt die Adresse |
| `PATCH`  | `/api/organizations/:id/members/:userId` | Leitung, Admin: Rolle ändern (`{ role }`); die letzte Person der Leitung bleibt (409) |
| `DELETE` | `/api/organizations/:id/members/:userId` | Leitung, Admin: Mitglied entfernen; das Mitglied selbst: austreten |
| `GET`    | `/api/protected/cells`       | Geschützte Funde, die man nicht sehen darf, als 5-km-Quadrate (`bbox`, `spots`); leer für PRO-Mitglieder |
| `PATCH`  | `/api/users/:id`             | Admin: Rolle setzen (`{ role: 'user' \| 'moderator' \| 'admin' }`) |

| `POST`   | `/api/photos/:id/identify`   | Pflanzen bestimmen (Pl@ntNet)                            |
| `GET`    | `/api/species`               | Arten mit Funden: Anzahl, Spots, Jahre, Neophyt ja/nein  |
| `GET`    | `/api/occurrences`           | Funde (bestes Pl@ntNet-Ergebnis pro Foto). Filter für diese und die folgenden Routen: `species`, `neophytes=1`, `minScore` (Standard 0,2), `bbox=west,süd,ost,nord`, `from`/`to` (Datum), `verified=1` (nur von Menschen geprüfte). Jeder Fund trägt `verification` (`bestaetigt`, `korrigiert` oder `null`); abgelehnte fehlen |
| `GET`    | `/api/spread?species=`       | Ausbreitungsfronten einer Art: Umriss (`polygons` mit Lücken), Fläche, Teilbestände und Frontabstand pro Jahr, Rate und Richtung, dazu `patches` mit Rate, Richtung, Flächenzuwachs, Sprung und Zusammenwachsen (`until`, `mergedInto`, `absorbed`) pro Teilbestand, Umriss pro Jahr (`buffer` in m, Standard 25; `alpha` in m, Standard automatisch; `shape=convex` für die konvexe Hülle) |
| `GET`    | `/api/identifications/review` | Prüfliste (PRO und Moderation): ungeprüfte Funde, neuste zuerst, mit allen Pl@ntNet-Kandidaten und `own` (eigenes Foto) |
| `PUT`    | `/api/photos/:id/identification-review` | Bestimmung prüfen: `{ status: 'bestaetigt' \| 'abgelehnt' }` oder `{ status: 'korrigiert', scientificName }`; nicht das eigene Foto (ausser Moderation) |
| `DELETE` | `/api/photos/:id/identification-review` | Prüfung zurücknehmen (wer geprüft hat oder Moderation) |
| `GET`    | `/api/export/dwc.csv`        | Funde als Darwin-Core-Occurrence-CSV (Info Flora, GBIF)  |
| `GET`    | `/api/export/inaturalist.csv` | Funde im CSV-Importformat von iNaturalist               |
| `GET`    | `/api/spots/:id/vegetation`  | Grünanteil, Kronendach-Deckung, Lückenanteil und GCC pro Foto (`pending`: noch in Berechnung) |
| `GET`    | `/api/spots/:id/ndvi`        | NDVI und NDMI pro Monat (Sentinel-2, vor 2017 Landsat an Sentinel-2 angeglichen; `sensors`, `adjusted` und die gemessenen Werte `raw` pro Monat), Waldtyp des Spots (`forestType`: `laub`, `nadel`, `misch` oder `null`, mit Quelle `arten`, `fotos` oder `satellit`), Rückgänge zwischen Fotodaten (`drops`, mit `index`, Belegen aus den Fotos, Sturm und `calibration`: verwendete Schwelle, `scope` `waldtyp` oder `alle`), Frühwarnungen (`alerts`); `status`: `ready`, `pending` (wird geladen), `offline` |
| `POST`   | `/api/spots/:id/ndvi`        | Satellitendaten neu laden                                |
| `GET`    | `/api/spots/:id/follow`      | Ob das angemeldete Konto Frühwarnungen für den Spot bekommt: `mode` (`folgen`, `stumm` oder `null`), `regular` und `days` (Tage mit Fotos in den letzten drei Jahren), `notified`, Zahl der Push-Abos |
| `PUT`    | `/api/spots/:id/follow`      | Folgen oder stummschalten (JSON: `mode` = `folgen`, `stumm` oder `null`); Konto nötig |
| `GET`    | `/api/push`                  | Öffentlicher VAPID-Schlüssel für `PushManager.subscribe()`, Zahl der Push-Abos des Kontos |
| `POST`   | `/api/push/subscriptions`    | Push-Abo dieses Browsers speichern (JSON wie `PushSubscription.toJSON()`: `endpoint`, `keys.p256dh`, `keys.auth`); nur https-Adressen bekannter Push-Dienste; Konto nötig |
| `DELETE` | `/api/push/subscriptions`    | Push-Abo entfernen (JSON: `endpoint`)                    |
| `POST`   | `/api/push/test`             | Testnachricht an alle Push-Abos des Kontos; Antwort `delivered` |
| `GET`    | `/api/satellite/calibration` | Schwellen pro Index: `ndvi`/`ndmi` für die Frühwarnung, `photos.ndvi`/`photos.ndmi` für Rückgänge zwischen Fotos, `forestTypes.laub`/`forestTypes.nadel` dasselbe pro Waldtyp (gegen die Schwelle aller Spots geprüft). Je Eintrag `kalibriert` oder `standard` (mit `reason`), Kontrollen mit und ohne Schaden, Spots, Kreuzvalidierung an zurückgehaltenen Spots (`cv`), Vergleichswert (`standard`, `baseline`: `anfangswert` oder `alle-spots`), Treffer und Fehlalarme pro Schwelle (`sweep`) |
| `POST`   | `/api/satellite/calibration` | Sofort neu kalibrieren                                   |
| `GET`    | `/api/satellite/harmonization` | Angleichung von Landsat an Sentinel-2 pro Index und Satellit (Gerade oder Versatz, Monatspaare, Abstand vorher, Restabweichung) |
| `POST`   | `/api/satellite/harmonization` | Sofort neu schätzen |
| `GET`    | `/api/satellite/alerts`      | Frühwarnung: Spots, deren letzte Monate gegenüber derselben Jahreszeit der Vorjahre gefallen sind (Index, seit wann, wie stark, Sturm davor, ob ein Besuch lohnt, `calibration`: verwendete Schwelle) |
| `GET`    | `/api/storm-warnings`        | Sturmwarnungen aus der Böenprognose und Stürme der letzten Woche: `warnings` (`cell` 0,1°-Feld, `lat`, `lon`, `date`, `gust` km/h – vor dem Sturm Prognose, danach gemessen –, `from16`, `label`, `phase` `vorher`\|`nachher`), `model`, `threshold` |
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

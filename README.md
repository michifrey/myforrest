# MyForrest – Wald im Wandel

**Street View für die Natur, über die Zeit.**

Beim Joggen, Wandern oder Biken fallen immer wieder Sturmschäden, Borkenkäfernester, neue
Lichtungen oder sich ausbreitende Neophyten auf. MyForrest sammelt Fotos solcher Orte und legt
sie zeitlich übereinander. So wird sichtbar, wie sich der Wald an einem Ort über Monate und Jahre
verändert.

![Startseite von MyForrest](docs/screenshots/hero.jpg)

## Die App im Überblick

Die Idee ist einfach: Wer regelmässig dieselben Wege läuft, kommt immer wieder an denselben Stellen
vorbei. Ein Foto pro Besuch genügt. MyForrest ordnet die Fotos einem Ort zu, richtet sie
deckungsgleich aus und zeigt, was sich verändert hat. So entsteht für jeden Ort eine Zeitreihe, ähnlich
wie bei Street View, nur mit der Zeit als zusätzlicher Achse.

Der Ablauf hat drei Schritte:

1. **Unterwegs fotografieren**: Ein Handyfoto mit GPS oder eine Action-Cam im Intervallmodus mit
   GPX-Track von Uhr, Strava oder Komoot. Die App findet den Ort automatisch.
2. **Am selben Ort wiederkommen**: Beim nächsten Besuch liegt das alte Foto als Overlay über dem
   Kamerabild, damit derselbe Ausschnitt gelingt.
3. **Veränderung sichtbar machen**: Die Fotos werden automatisch ausgerichtet. Zeitraffer,
   Vorher/Nachher-Regler und Heatmap zeigen, was passiert ist.

> Die Screenshots zeigen generierte Demo-Bilder eines fiktiven Waldstücks und eine vereinfachte
> Platzhalter-Karte. Im Betrieb zeigt die App echte Fotos und OpenStreetMap-Kacheln.

### 1. Karte mit Spots

![Karte mit Spots und Übersicht](docs/screenshots/map.jpg)

Jeder Marker ist ein **Spot**, also ein Ort, an dem über die Zeit Fotos entstanden sind. Fotos, die
weniger als 25 m auseinander liegen, landen automatisch im selben Spot. Die Zahl im Marker nennt die
Anzahl Fotos, die Farbe den Befund: grün für unauffällig, orange für Schäden (Sturm, Borkenkäfer,
Trockenheit, Holzschlag, Erosion) und violett für Neophyten. Oben links lässt sich die Karte nach
Beobachtungen filtern. Rechts stehen Kennzahlen und die zuletzt fotografierten Spots.

### 2. Zeitreise an einem Spot

![Spot mit Zeitleiste](docs/screenshots/spot.jpg)

Ein Klick auf einen Spot öffnet seine Geschichte: Koordinaten, Zeitraum, alle Beobachtungen und ein
Hinweis, wie viel sich seit dem ersten Foto verändert hat. Mit dem Zeitregler oder den Vorschaubildern
blättert man durch die Aufnahmen. Ist *Stabilisiert* aktiv, liegen alle Fotos deckungsgleich
übereinander, auch wenn sie bei jedem Besuch etwas anders aufgenommen wurden. Das Ergebnis wirkt wie
ein Zeitraffer:

<p align="center"><img src="docs/screenshots/timelapse.gif" width="480" alt="Zeitraffer eines Spots: Windwurf 2022, danach Totholz und Verjüngung"></p>

Im Beispiel: Sommer 2021 noch intakt, im Februar 2022 wirft ein Sturm zwei Buchen um, ab 2023 wachsen
in der Lücke junge Bäume nach.

Unter dem Bild lassen sich pro Foto Beobachtungen taggen und eine Notiz erfassen. Mit einem
Pl@ntNet-Key bestimmt *Pflanze bestimmen* die Arten auf dem Foto und erkennt invasive Neophyten.

### 3. Vorher / Nachher mit Veränderungs-Heatmap

<p>
  <img src="docs/screenshots/compare.jpg" width="49%" alt="Vorher/Nachher-Vergleich mit Heatmap">
  <img src="docs/screenshots/compare-swipe.jpg" width="49%" alt="Vorher/Nachher-Vergleich mit Wischregler">
</p>

*Vorher / Nachher vergleichen* legt zwei beliebige Aufnahmen übereinander. Mit dem Wischregler
schiebt man die Grenze zwischen den beiden Bildern hin und her. *Automatisch ausrichten* korrigiert
Unterschiede in Standort, Zoom und Neigung. *Veränderungen hervorheben* blendet eine Heatmap ein
(gelb = wenig, rot = stark) und nennt den Anteil der veränderten Bildfläche. Hier sind die
umgestürzten Bäume, die Lücke im Kronendach und der neue Jungwuchs gut zu erkennen. Unterschiede im
Licht werden dabei ausgeglichen.

### 4. Wiederholungsfoto mit Overlay

<p>
  <img src="docs/screenshots/mobile-spot.jpg" width="32%" alt="Spot auf dem Handy">
  <img src="docs/screenshots/mobile-camera.jpg" width="32%" alt="Kamera mit überblendetem Referenzfoto">
  <img src="docs/screenshots/mobile-camera-edges.jpg" width="32%" alt="Kamera mit Konturen des Referenzfotos">
</p>

Auf dem Handy öffnet *Wiederholungsfoto aufnehmen* die Kamera. Das aktuell gewählte Foto dient als
Referenz und liegt entweder halbtransparent (*Überblenden*) oder als gelbe Linien (*Konturen*) über dem
Livebild. Man bewegt sich, bis Bild und Overlay übereinstimmen, und löst aus. Oben stehen die Entfernung
zum Spot und, falls nötig, der Hinweis, das Handy wie beim Referenzfoto zu drehen. Das neue Foto gehört
automatisch zu diesem Spot und öffnet sich gleich im Vorher/Nachher-Vergleich.

### 5. Fotos hochladen

<p align="center"><img src="docs/screenshots/upload.png" width="480" alt="Upload-Dialog"></p>

*Foto beitragen* nimmt beliebig viele Fotos auf einmal entgegen. Ort und Zeit kommen aus den
EXIF-Daten. Fotos ohne GPS lassen sich über einen GPX-Track verorten (dafür gibt es unter
*Zeitabgleich für GPX* Zeitzone und Korrektur für die Kamera-Uhr) oder von Hand auf der Karte bzw. über
den aktuellen Standort. Dazu kommen Aktivität, Beobachtungen und eine Notiz.

## Was der Prototyp heute kann

- **Karte mit Spots**: Fotos, die innerhalb von 25 m aufgenommen wurden, werden automatisch zu
  einem *Spot* zusammengefasst. Die Farbe zeigt Schäden (orange) oder Neophyten (violett).
- **Zeitreise pro Spot**: Mit dem Zeitregler und der Thumbnail-Leiste durch alle Aufnahmen blättern.
- **Vorher/Nachher-Vergleich**: Zwei beliebige Aufnahmen mit einem Wischregler überlagern.
- **Wiederholungsfotos mit Overlay**: Am Spot öffnet *Wiederholungsfoto aufnehmen* die Kamera. Das
  gewählte Referenzfoto liegt halbtransparent oder als Kontur über dem Livebild, sodass sich Ausschnitt
  und Standort genau treffen lassen. Angezeigt werden auch die Entfernung zum Spot und, falls nötig,
  ein Hinweis, das Handy zu drehen. Das Foto wird im Format der Referenz gespeichert, fest diesem
  Spot zugeordnet und direkt im Vorher/Nachher-Vergleich geöffnet.
- **Automatische Feinausrichtung**: Fotos eines Spots werden per Bildregistrierung aufeinander
  ausgerichtet (Merkmalspunkte + RANSAC-Homographie). Im Vorher/Nachher-Vergleich liegen beide Bilder
  dann deckungsgleich übereinander, und mit *Stabilisiert* wirkt das Durchblättern der Zeitleiste
  wie ein Zeitraffer. Die Originalfotos bleiben unverändert, gespeichert wird nur die Transformation.
  Fotos aus einem ganz anderen Blickwinkel werden erkannt und bleiben unausgerichtet.
- **Veränderungs-Heatmap**: Auf zwei ausgerichteten Fotos markiert eine Heatmap, wo sich etwas verändert
  hat (gelb → rot), und nennt den Anteil der veränderten Fläche. Erkannt werden neue oder verschwundene
  Strukturen (umgestürzte Bäume, Lichtungen, Bewuchs) sowie Farbwechsel wie grün → braun. Unterschiedliches
  Licht und kleine Restverschiebungen werden ausgeglichen. Im Kopf jedes Spots steht zudem, wie viel sich
  seit dem ersten Foto verändert hat.
- **Einordnung der Veränderungen**: Veränderte Regionen werden automatisch eingeordnet als
  *Windwurf / liegende Stämme*, *Auflichtung / Holzschlag*, *Verfärbung (grün → gelb/braun)*,
  *neuer Bewuchs* oder *sonstige Veränderung*. Grundlage sind Grünanteil, Helligkeit, Textur,
  Kantenrichtung und Form. Im Vergleich erscheinen sie als beschriftete Rahmen und lassen sich mit
  einem Klick als Beobachtung (Tag) übernehmen. Auf der Karte erscheinen Spots mit starker Veränderung
  im Tooltip, und es gibt einen Filter dafür.
- **Wetter-Kontext und Auffälligkeiten**: Zu jedem Foto werden die Wetterdaten am Standort geladen
  (Open-Meteo, ERA5): Niederschlag, Temperatur, Hitzetage und längste Trockenphase der 90 Tage vor
  der Aufnahme sowie der Niederschlag der letzten 12 Monate, jeweils gegenüber dem Mittel 1991–2020.
  Daraus werden Auffälligkeiten abgeleitet und am Foto festgehalten: Trockenheit, Wärme, Nässe und vor
  allem **frühe Laubverfärbung** mit vermuteter Ursache. Ein Beispiel: Laub verfärbt sich im August
  bei 20 % des üblichen Niederschlags, das deutet auf Trockenstress hin. Bei unauffälligem Wetter
  verweist der Text auf andere Ursachen wie Schädlinge. Jeder Spot hat eine Auffälligkeiten-Chronik
  über die Jahre, und auf der Karte sind betroffene Spots mit „!“ markiert.
- **Baumarten**: Jeder Spot führt einen Artenbestand. Arten kommen automatisch aus der Pl@ntNet-Bestimmung
  (Organ wählbar: Blatt/Nadeln, Rinde, ganzer Baum, Blüte, Frucht) oder werden von Hand aus einer
  Liste von gut 30 mitteleuropäischen Waldbaumarten gewählt. Zu jeder Art gibt es einen Steckbrief: Nadel/Laub,
  typischer Beginn der Herbstfärbung, Trockenheitsempfindlichkeit, worauf zu achten ist. Die Arten machen die
  Auffälligkeiten genauer:
  - „Frühe Verfärbung“ richtet sich nach der am frühesten färbenden Art am Spot (Birke Mitte September,
    Eiche Mitte Oktober).
  - Verfärbte immergrüne Nadelbäume gelten immer als Warnsignal.
  - Fichte bei Trockenheit oder Hitze löst eine Borkenkäfer-Warnung mit Prüfhinweisen aus.
  - Bei Esche mit Auflichtung oder Verfärbung erscheint ein Hinweis auf das Eschentriebsterben.
- **Höhenlage**: Jeder Spot erhält seine Höhe über Meer. Sie kommt aus dem Copernicus-Höhenmodell (über
  Open-Meteo), ersatzweise aus der GPS-Höhe der Fotos, oder wird von Hand eingetragen. Pro 100 m über dem
  Flachland (~400 m) beginnt die Herbstfärbung rund 2,5 Tage früher; die Bewertung „frühe Verfärbung“ und die
  Steckbriefe rechnen damit. Bei Rotbuche auf 1000 m ist das etwa der 15. statt der 30. September.
  Auch die Wetterdaten werden auf die Höhe des Spots heruntergerechnet.
- **Exposition**: Aus dem Höhenmodell (3×3 Messpunkte im Abstand von 90 m, Verfahren nach Horn) werden
  Hangneigung und -richtung des Spots berechnet; von Hand lässt sich die Exposition ebenfalls setzen. Ein
  steiler Südhang ist wärmer und färbt sich einige Tage später, ein Nordhang früher (bis ±4 Tage, gewichtet
  mit der Steilheit). An Südhängen weist der Trockenheitstext zudem darauf hin, dass der Boden schneller
  austrocknet.
- **Kaltluftseen**: Mit dem Topographischen Positionsindex (wie tief liegt der Spot unter dem Mittel seiner
  Umgebung in 300 m und 600 m Umkreis) erkennt die App Senken und Talböden, in denen sich nachts Kaltluft
  sammelt, sowie Kuppen und Rücken. In Senken beginnt die Herbstfärbung bis zu 5 Tage früher. Zeigt das
  Wettermodell nach dem Laubaustrieb Nächte unter 3 °C, wird Spätfrost-Gefahr gemeldet. Braune junge
  Blätter im Frühsommer gelten dann als **Frostschaden** (neuer Tag) statt als frühe Herbstfärbung.
  Auf Kuppen gibt es bei Windwurf einen Hinweis auf die exponierte Lage. Die Geländeform lässt sich auch
  von Hand setzen.
- **Sonne & Wetter auf der Karte**: Ein eigener Kartenmodus zeigt für den gewählten Spot (oder die Kartenmitte)
  und ein beliebiges Datum in Vergangenheit oder Zukunft:
  - Sonnenbahn, Auf- und Untergangsrichtung, Sonnenstand zur gewählten Uhrzeit und den Schatten eines
    25-m-Baums auf der Karte;
  - Sonnenhöhe, Richtung, Tageslänge und die Einstrahlung bei klarem Himmel, auf ebenem Boden und auf dem
    Hang des Spots (Neigung und Exposition), samt Tagessumme in kWh/m²;
  - für vergangene Tage die gemessene Einstrahlung und den Regen pro Stunde (ERA5), für die nächsten
    ~16 Tage die Prognose; die Tagesregenmenge erscheint an jedem Spot auf der Karte.

  Der Tagesverlauf lässt sich mit dem Schieberegler, im Diagramm oder per Abspielen durchgehen. Der
  Sonnenstand wird lokal berechnet (NOAA-Algorithmus) und funktioniert für jedes Datum.
- **Horizontabschattung**: Der Geländehorizont (Copernicus-Höhenmodell über Open-Meteo, 36 Richtungen,
  12 Distanzen von 120 m bis 20 km, mit Erdkrümmung und Refraktion) blockiert die direkte Sonne hinter
  Hügeln und Bergen. Der Anteil des offenen Himmels (Himmelssicht) dämpft das diffuse Licht. Im Kartenmodus
  zeigt das Sonnenbahn-Diagramm die Geländesilhouette, die Bahn ist hinter dem Gelände gestrichelt, und
  Auf- und Untergang werden zu „Sonne ab / Sonne bis“ über dem Grat. Das Panel nennt die Sonnenstunden
  samt Verlust durch das Gelände, die Einstrahlung mit und ohne Gelände, den höchsten Grat und markiert im
  Diagramm die Zeiten, in denen die Sonne hinter dem Gelände steht. Bäume und Gebäude kennt das
  Höhenmodell nicht.
- **Drei Wege, Fotos zu verorten**:
  1. **GPS aus dem Foto** (EXIF), wie bei normalen Handyfotos.
  2. **Automatisch über einen GPX-Track**: Eine Action-Cam im Intervallmodus (z. B. alle 5 s) beim
     Laufen oder Biken, dazu der GPX-Export von Uhr, Strava oder Komoot. Jedes Foto wird über seine
     Aufnahmezeit auf der Strecke verortet. Zeitzone und Abweichung der Kamera-Uhr lassen sich
     korrigieren.
  3. **Manuell**: Standort auf der Karte anklicken oder den aktuellen Standort verwenden.
- **Beobachtungen taggen**: Sturmschaden/Windwurf, Borkenkäfer, Trockenschaden, Totholz,
  Holzschlag, Verjüngung, Neophyt, Weg/Erosion, dazu eine Notiz. Die Karte lässt sich danach filtern.
- **Pflanzenbestimmung (optional)**: Mit einem kostenlosen [Pl@ntNet](https://my.plantnet.org)-API-Key
  werden Pflanzen auf einem Foto bestimmt. Bekannte invasive Neophyten wie Drüsiges Springkraut,
  Japanischer Staudenknöterich, Goldruten oder Götterbaum werden erkannt, und das Foto erhält
  automatisch den Tag *Neophyt*.

## Schnellstart

Voraussetzung: Node.js ≥ 22.5 (nutzt das eingebaute `node:sqlite`).

```bash
npm install
npm start            # http://localhost:3000
npm test
```

**Auf dem Handy:** Browser lassen die Kamera für das Live-Overlay nur über HTTPS zu (oder auf
`localhost`). Im Heimnetz geht das z. B. mit einem Tunnel (`cloudflared tunnel --url http://localhost:3000`)
oder einem Reverse-Proxy wie Caddy. Ohne HTTPS öffnet sich die normale Kamera-App: Das Foto landet
trotzdem am richtigen Spot, nur ohne Overlay.

Konfiguration über Umgebungsvariablen:

| Variable           | Standard | Bedeutung                                      |
|--------------------|----------|------------------------------------------------|
| `PORT`             | `3000`   | HTTP-Port                                      |
| `DATA_DIR`         | `./data` | SQLite-Datenbank und hochgeladene Bilder       |
| `SPOT_RADIUS_M`    | `25`     | Radius, in dem Fotos zum selben Spot gehören   |
| `PLANTNET_API_KEY` | –        | Aktiviert die Pflanzenbestimmung               |

## Aufbau

```
server.js            Einstiegspunkt
src/app.js           Express-App und REST-API
src/db.js            SQLite-Schema (spots, photos, photo_tags, identifications)
src/spots.js         Gruppierung von Fotos zu Spots
src/align.js         Bildregistrierung (ORB-Merkmale, Matching, RANSAC)
src/homography.js    3×3-Homographien: Verkettung, Inverse
src/change.js        Veränderungserkennung und Heatmap
src/classify.js      Einordnung der veränderten Regionen
src/weather.js       Wetterdaten und Mittel 1991–2020 von Open-Meteo (mit Cache)
src/irregularities.js  Auffälligkeiten (Trockenheit, Wärme, frühe Laubverfärbung …)
src/trees.js         Waldbaumarten mit Phänologie, Trockenheitsempfindlichkeit und Gefahren
src/phenology.js     Korrektur der Herbstfärbung für Höhe, Exposition und Kaltluftseen
src/elevation.js     Geländehöhe, Hangneigung, Exposition und Geländeform (Copernicus-DEM über Open-Meteo)
src/exif.js          Aufnahmezeit, GPS und Blickrichtung aus den Bilddaten
src/gpx.js           GPX-Parser
src/geo.js           Distanzen und Interpolation auf dem Track
src/plantnet.js      Anbindung an die Pl@ntNet-API
src/neophytes.js     Liste invasiver Neophyten (Schwarze Liste CH / BfN)
docs/screenshots/    Bilder für dieses README
public/              Frontend (Leaflet, ohne Build-Schritt; forest.js zeichnet die Waldszene,
                     sun.js berechnet Sonnenstand und Einstrahlung, sunmap.js den Kartenmodus „Sonne & Wetter“)
```

### API

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features          |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum und Tags           |
| `GET`    | `/api/spots/:id`             | Ein Spot mit allen Fotos chronologisch                   |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]`, optional `spotId` und `refPhotoId` für Wiederholungsfotos, `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `utcOffsetMinutes`, `clockShiftSeconds`) |
| `POST`   | `/api/spots/:id/align`       | Ausrichtung aller Fotos eines Spots neu berechnen        |
| `GET`    | `/api/photos/:id/change?to=` | Veränderte Fläche zwischen zwei ausgerichteten Fotos, mit eingeordneten Regionen |
| `GET`    | `/api/photos/:id/change.png?to=` | Heatmap der Veränderung (PNG, in der Ansicht des ersten Fotos) |
| `GET`    | `/api/weather/day?lat=&lon=&date=` | Stundenwerte eines Tages (Einstrahlung, Regen, Bewölkung, Temperatur): Messung oder Prognose |
| `GET`    | `/api/weather/day/spots?date=` | Tagesniederschlag an allen Spots                       |
| `GET`    | `/api/horizon?lat=&lon=`       | Geländehorizont (36 Richtungen) und Himmelssicht       |
| `GET`    | `/api/trees`                 | Liste der unterstützten Baumarten mit Steckbrief         |
| `PATCH`  | `/api/spots/:id`             | Höhe (`{ elevation: 950 }`), Exposition (`{ exposition: 'S' }`, auch `'eben'`) und/oder Geländeform (`{ landform: 'senke' }`) von Hand setzen; `null` ermittelt den Wert neu |
| `POST`   | `/api/spots/:id/species`     | Baumart einem Spot zuordnen (`{ scientificName }`)       |
| `DELETE` | `/api/spots/:id/species?name=` | Baumart vom Spot entfernen                             |
| `GET`    | `/api/photos/:id/context`    | Wetter-Kontext und Auffälligkeiten (wird beim ersten Abruf berechnet und gespeichert) |
| `POST`   | `/api/photos/:id/context`    | Wetter-Kontext neu laden                                 |
| `PATCH`  | `/api/photos/:id`            | Tags und Notiz ändern                                    |
| `DELETE` | `/api/photos/:id`            | Foto löschen                                             |
| `POST`   | `/api/photos/:id/identify`   | Pflanzen bestimmen (Pl@ntNet)                            |

## Roadmap

**Phase 2: Mehr und bessere Fotos**
- Video statt Einzelbilder: Frames aus GoPro- und Insta360-Videos extrahieren und die eingebettete
  GPS-Telemetrie (GPMF) direkt nutzen. 360°-Aufnahmen machen es dann wirklich zu Street View.
- Blickrichtung berücksichtigen: Spots zusätzlich nach Himmelsrichtung trennen.
- Vorschaubilder, HEIC-Unterstützung, installierbare PWA mit Offline-Upload.
- Benutzerkonten, Moderation, Lizenz pro Foto (z. B. CC BY-SA).

**Phase 3: Automatische Auswertung**
- Objekterkennung: umgestürzte Bäume, Wurzelteller, Totholz, Holzpolter und Rückegassen,
  z. B. mit einem feinjustierten YOLO- oder Segmentierungsmodell.
- Einordnung lernen statt Regeln: aus den bestätigten Tags ein Modell trainieren; Baumarten auch ohne
  Pl@ntNet direkt im Bild erkennen (z. B. Nadel-/Laubholzanteil pro Region) und Verfärbungen der
  richtigen Art zuordnen.
- Phänologie verfeinern: regionale Beobachtungsreihen (MeteoSchweiz/DWD) statt pauschaler Gradienten
  für Höhe, Exposition und Kaltluft; nächtliche Abkühlung in Senken aus Wind und Bewölkung abschätzen.
- Sturmereignisse aus Winddaten (Böen) mit Windwurf-Funden verknüpfen; Phänologie-Daten
  (z. B. MeteoSchweiz/DWD) als Referenz für den Beginn der Herbstfärbung pro Region und Höhenlage.
- Vegetationsdichte: Grünanteil und Kronendach-Deckung aus den Bildern schätzen und als Zeitreihe
  zeigen.
- Arten und Neophyten: Hotspot-Karten und Ausbreitungsfronten, Export zu Info Flora / iNaturalist.
- Kontext aus Satellitendaten (Sentinel-2-NDVI) und Sturmereignissen (z. B. MeteoSchweiz/DWD).

## Hinweise

- Der Prototyp hat **keine Authentifizierung**. Er sollte nur lokal oder in einem vertrauenswürdigen
  Netz laufen, bis Benutzerkonten umgesetzt sind.
- Bilder werden unverändert gespeichert und ausgeliefert, **inklusive EXIF-Daten** (GPS,
  Kameramodell). Vor einem öffentlichen Betrieb sollten Metadaten entfernt und Personen sowie
  Kennzeichen automatisch verpixelt werden.
- Wetterdaten von [Open-Meteo.com](https://open-meteo.com) (ERA5-Reanalyse, CC BY 4.0). Der Server braucht
  dafür Internetzugang zu `archive-api.open-meteo.com` und, für die Geländehöhe, zu `api.open-meteo.com`. Die Daten werden pro ~10-km-Zelle gecacht; die
  Normalwerte 1991–2020 werden nur einmal pro Zelle geladen.
- Kartendaten © OpenStreetMap-Mitwirkende. Bei stärkerer Nutzung braucht es einen eigenen
  Tile-Anbieter (siehe Tile Usage Policy).

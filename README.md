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
src/exif.js          Aufnahmezeit, GPS und Blickrichtung aus den Bilddaten
src/gpx.js           GPX-Parser
src/geo.js           Distanzen und Interpolation auf dem Track
src/plantnet.js      Anbindung an die Pl@ntNet-API
src/neophytes.js     Liste invasiver Neophyten (Schwarze Liste CH / BfN)
docs/screenshots/    Bilder für dieses README
public/              Frontend (Leaflet, ohne Build-Schritt; forest.js zeichnet die Waldszene)
```

### API

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features          |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum und Tags           |
| `GET`    | `/api/spots/:id`             | Ein Spot mit allen Fotos chronologisch                   |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]`, optional `spotId` und `refPhotoId` für Wiederholungsfotos, `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `utcOffsetMinutes`, `clockShiftSeconds`) |
| `POST`   | `/api/spots/:id/align`       | Ausrichtung aller Fotos eines Spots neu berechnen        |
| `GET`    | `/api/photos/:id/change?to=` | Anteil veränderter Fläche zwischen zwei ausgerichteten Fotos |
| `GET`    | `/api/photos/:id/change.png?to=` | Heatmap der Veränderung (PNG, in der Ansicht des ersten Fotos) |
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
- Veränderungen klassifizieren: die Heatmap-Regionen automatisch als Windwurf, Kahlschlag, Verfärbung
  oder neuer Bewuchs einordnen und Spots mit starker Veränderung auf der Karte hervorheben.
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
- Kartendaten © OpenStreetMap-Mitwirkende. Bei stärkerer Nutzung braucht es einen eigenen
  Tile-Anbieter (siehe Tile Usage Policy).

# MyForrest – Wald im Wandel

**Street View für die Natur, über die Zeit.**

Beim Joggen, Wandern oder Biken fallen immer wieder Sturmschäden, Borkenkäfernester, neue
Lichtungen oder sich ausbreitende Neophyten auf. MyForrest sammelt Fotos solcher Orte und legt
sie zeitlich übereinander. So wird sichtbar, wie sich der Wald an einem Ort über Monate und Jahre
verändert.

## Was der Prototyp heute kann

- **Karte mit Spots**: Fotos, die innerhalb von 25 m aufgenommen wurden, werden automatisch zu
  einem *Spot* zusammengefasst. Die Farbe zeigt Schäden (orange) oder Neophyten (violett).
- **Zeitreise pro Spot**: Mit dem Zeitregler und der Thumbnail-Leiste durch alle Aufnahmen blättern.
- **Vorher/Nachher-Vergleich**: Zwei beliebige Aufnahmen mit einem Wischregler überlagern.
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
src/exif.js          Aufnahmezeit, GPS und Blickrichtung aus den Bilddaten
src/gpx.js           GPX-Parser
src/geo.js           Distanzen und Interpolation auf dem Track
src/plantnet.js      Anbindung an die Pl@ntNet-API
src/neophytes.js     Liste invasiver Neophyten (Schwarze Liste CH / BfN)
public/              Frontend (Leaflet, ohne Build-Schritt)
```

### API

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features          |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum und Tags           |
| `GET`    | `/api/spots/:id`             | Ein Spot mit allen Fotos chronologisch                   |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]`, optional `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `utcOffsetMinutes`, `clockShiftSeconds`) |
| `PATCH`  | `/api/photos/:id`            | Tags und Notiz ändern                                    |
| `DELETE` | `/api/photos/:id`            | Foto löschen                                             |
| `POST`   | `/api/photos/:id/identify`   | Pflanzen bestimmen (Pl@ntNet)                            |

## Roadmap

**Phase 2: Mehr und bessere Fotos**
- Wiederholungsfotos: Am Spot zeigt das Handy das letzte Foto halbtransparent über dem Kamerabild,
  damit neue Aufnahmen denselben Ausschnitt treffen (Rephotografie).
- Video statt Einzelbilder: Frames aus GoPro- und Insta360-Videos extrahieren und die eingebettete
  GPS-Telemetrie (GPMF) direkt nutzen. 360°-Aufnahmen machen es dann wirklich zu Street View.
- Blickrichtung berücksichtigen: Spots zusätzlich nach Himmelsrichtung trennen.
- Vorschaubilder, HEIC-Unterstützung, installierbare PWA mit Offline-Upload.
- Benutzerkonten, Moderation, Lizenz pro Foto (z. B. CC BY-SA).

**Phase 3: Automatische Auswertung**
- Objekterkennung: umgestürzte Bäume, Wurzelteller, Totholz, Holzpolter und Rückegassen,
  z. B. mit einem feinjustierten YOLO- oder Segmentierungsmodell.
- Veränderungserkennung: Aufnahmen eines Spots aufeinander ausrichten (Feature-Matching) und
  Unterschiede automatisch markieren.
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

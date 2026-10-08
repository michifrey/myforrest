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

> Die Screenshots zeigen generierte Demo-Bilder eines fiktiven Waldstücks bei Zürich, eine vereinfachte
> Platzhalter-Karte und synthetische Wetter- und Satellitendaten. Im Betrieb zeigt die App echte Fotos,
> OpenStreetMap- bzw. swisstopo-Kacheln und Daten von Open-Meteo, Sentinel-2 und Landsat. Wie die Bilder
> entstehen, steht unter [`scripts/screenshots`](scripts/screenshots/README.md).

### 1. Karte mit Spots

![Karte mit Spots, Sichtkegeln und Meldungen](docs/screenshots/map.jpg)

Jeder Marker ist ein **Spot**, also ein Ort, an dem über die Zeit Fotos entstanden sind. Fotos, die
weniger als 25 m auseinander liegen und in dieselbe Richtung blicken (±45°), landen automatisch im
selben Spot. Ein goldener Sichtkegel am Marker zeigt die Blickrichtung. Die Zahl im Marker nennt die
Anzahl Fotos, die Farbe den Befund: grün für unauffällig, orange für Schäden (Sturm, Borkenkäfer,
Trockenschaden, Holzschlag, frühe Laubverfärbung, Frost) und violett für Neophyten. Kleine Zeichen am
Marker melden:
- **Rotes Ausrufezeichen:** Auffälligkeiten im Wetter, etwa Trockenheit oder Hitze vor der Aufnahme.
- **Blaues Windsymbol:** Einen Sturm seit dem letzten Besuch.
- **Violetter Satellit:** Einen Rückgang im Satellitenbild, auch ohne neues Foto.

Beim Überfahren eines Markers fasst ein Tooltip alles zusammen: Veränderung, Wetter, Sturm, Satellit,
Baumarten und Blickrichtung. Schraffierte Quadrate stehen für geschützte Funde (Abschnitt 11).
Oben links lässt sich die Karte nach Beobachtungen und Meldungen filtern,
daneben schalten *Sonne & Wetter*, *Arten & Neophyten* und *Touren & Aufträge* die Kartenmodi ein
(Abschnitte 7, 8 und 10). Gelbe Kamera-Pins sind Fotoaufträge.
Rechts stehen Kennzahlen und die zuletzt fotografierten Spots.

### 2. Zeitreise an einem Spot

![Spot mit Gelände, Baumarten und Zeitleiste](docs/screenshots/spot.jpg)

Ein Klick auf einen Spot öffnet seine Geschichte: Koordinaten, Zeitraum und Blickrichtung, dazu Höhe,
Hangneigung, Exposition und Geländeform aus dem Höhenmodell und die erwartete Herbstfärbung an diesem Ort.
Darunter folgen der Anteil der Ansicht, der sich seit dem ersten Foto verändert hat, alle Beobachtungen
und die Baumarten am Spot. Mit dem Zeitregler oder den Vorschaubildern blättert man durch die Aufnahmen.
Ist *Stabilisiert* aktiv, liegen alle Fotos deckungsgleich übereinander, auch wenn sie bei jedem Besuch
etwas anders aufgenommen wurden. Das Ergebnis wirkt wie ein Zeitraffer:

<p align="center"><img src="docs/screenshots/timelapse.gif" width="480" alt="Zeitraffer eines Spots: Windwurf 2022, danach Totholz und Verjüngung"></p>

Im Beispiel: Sommer 2021 noch intakt, im Februar 2022 wirft ein Sturm drei Buchen um, ab 2023 wachsen
in der Lücke junge Bäume nach, und im Frühling 2026 schliesst der Jungwuchs die Lücke.

Unter dem Bild lassen sich pro Foto Beobachtungen taggen und eine Notiz erfassen. Jedes Foto nennt
Urheber und Lizenz und lässt sich melden. Mit einem Pl@ntNet-Key bestimmt *Art bestimmen* die Pflanzen
auf dem Foto und erkennt invasive Neophyten.

### 3. Vorher / Nachher mit Veränderungs-Heatmap

<p>
  <img src="docs/screenshots/compare.jpg" width="49%" alt="Vorher/Nachher-Vergleich mit Heatmap">
  <img src="docs/screenshots/compare-swipe.jpg" width="49%" alt="Vorher/Nachher-Vergleich mit Wischregler">
</p>

*Vorher / Nachher vergleichen* legt zwei beliebige Aufnahmen übereinander. Mit dem Wischregler
schiebt man die Grenze zwischen den beiden Bildern hin und her. *Automatisch ausrichten* korrigiert
Unterschiede in Standort, Zoom und Neigung. *Veränderungen hervorheben* blendet eine Heatmap ein
(gelb = wenig, rot = stark) und nennt den Anteil der veränderten Bildfläche. Unterschiede im Licht werden
dabei ausgeglichen, hier etwa das Abendlicht im Juni 2024 gegenüber dem Vormittag 2021. Die veränderten
Regionen werden eingeordnet (Windwurf, Auflichtung, Verfärbung, neuer Bewuchs); bestätigt oder korrigiert
man die Einordnung, lernt die App daraus.

<p align="center"><img src="docs/screenshots/panorama-compare.jpg" width="420" alt="Vorher/Nachher zweier 360°-Panoramen mit markierter Auflichtung"></p>

Das geht auch mit **360°-Panoramen**, aus Videos wie aus Fotos von 360°-Kameras. Statt einer Homographie
sucht die App die Drehung der Kamera zwischen zwei Besuchen und dreht das spätere Panorama in die
Blickrichtung des früheren; der Bereich unten, wo die Person mit der Kamera steht, zählt nicht. Hier wurde
die Kamera 2025 um 70° anders gehalten, und die Heatmap markiert die neue Lücke im Bestand
(Demo-Panoramen, gerechnet).

### 4. Wiederholungsfoto mit Overlay

<p>
  <img src="docs/screenshots/mobile-spot.jpg" width="32%" alt="Spot auf dem Handy">
  <img src="docs/screenshots/mobile-camera.jpg" width="32%" alt="Kamera mit überblendetem Referenzfoto">
  <img src="docs/screenshots/mobile-camera-edges.jpg" width="32%" alt="Kamera mit Konturen des Referenzfotos">
</p>

Auf dem Handy öffnet *Wiederholungsfoto aufnehmen* die Kamera. Das aktuell gewählte Foto dient als
Referenz und liegt entweder halbtransparent (*Überblenden*) oder als gelbe Linien (*Konturen*) über dem
Livebild. Man bewegt sich, bis Bild und Overlay übereinstimmen, und löst aus. Oben stehen die Entfernung
zum Spot samt GPS-Genauigkeit und, falls nötig, der Hinweis, das Handy wie beim Referenzfoto zu drehen. Das
neue Foto gehört automatisch zu diesem Spot und öffnet sich gleich im Vorher/Nachher-Vergleich.

### 5. Fotos und Videos hochladen

<p align="center"><img src="docs/screenshots/upload.png" width="420" alt="Upload-Dialog"></p>

*Foto beitragen* nimmt beliebig viele Fotos auf einmal entgegen, auch HEIC vom iPhone und Videos von GoPro
oder 360°-Kameras, aus denen entlang der Route Einzelbilder werden. Ort und Zeit kommen aus den EXIF- bzw.
Telemetriedaten. Fotos ohne GPS lassen sich über einen GPX-Track verorten (dafür gibt es unter
*Zeitabgleich für GPX* Zeitzone und Korrektur für die Kamera-Uhr) oder von Hand auf der Karte bzw. über
den aktuellen Standort. Dazu kommen Aktivität, Beobachtungen, eine Notiz und die Lizenz (Standard
CC BY-SA 4.0). Als installierte App landen Uploads ohne Empfang in einer Warteschlange und gehen später raus.

### 6. Wetter, Stürme und Satellit

<p>
  <img src="docs/screenshots/wetter-kontext.jpg" width="49%" alt="Wetter-Kontext einer Aufnahme mit Trockenheit und Hitze">
  <img src="docs/screenshots/satellite.jpg" width="49%" alt="Satelliten-Frühwarnung und NDVI-Rückgang eines Nadelwald-Spots mit geeichter Schwelle">
</p>

*Kontext zur Aufnahme* vergleicht die 90 Tage vor jedem Foto mit dem Mittel 1991–2020: Niederschlag,
Temperatur, Hitzetage, längste Trockenphase und die Niederschläge der letzten zwölf Monate. Daraus
entstehen Hinweise wie *Ausgeprägte Trockenheit*, *Frühe Laubverfärbung*, *Erhöhtes Borkenkäfer-Risiko*
oder *Windwurf nach Sturm*, abgestimmt auf die Baumarten am Spot. Im Beispiel links färben die Buchen
schon Ende August, nach einem Sommer mit 29 % des üblichen Regens.

*Vegetation im Zeitverlauf* (rechts) zeigt den Grünanteil aus den Fotos und den NDVI und Feuchteindex
NDMI aus Sentinel-2, vor 2017 aus Landsat, an Sentinel-2 angeglichen. Fällt ein Index an einem Spot ohne neues Foto deutlich unter
die Werte derselben Jahreszeit in den Vorjahren, meldet die **Frühwarnung**, dass sich ein Besuch lohnt;
fällt er zwischen zwei Fotos, markiert das Diagramm den Zeitraum. Die Schwellen für beides eichen sich an
bestätigten Schäden, getrennt für Laub- und Nadelwald. Hier: ein Fichten-Tannen-Bestand mit Borkenkäfer.
Sein NDVI sank nur um 0,07–0,08; die Nadelwald-Schwelle 0,06 erkennt das, die Schwelle aller Spots (0,18)
hätte an Nadelwald-Spots keinen der bestätigten Schäden gefunden.

<p align="center"><img src="docs/screenshots/push.jpg" width="420" alt="Spotansicht mit Hinweis auf Push-Nachrichten der Frühwarnung"></p>

Wer einen Spot regelmässig besucht (an mindestens zwei Tagen fotografiert) oder ihm folgt, bekommt neue
Frühwarnungen als **Push-Nachricht** aufs Handy; ein Tipp darauf öffnet den Spot. Eingeschaltet wird das
einmal pro Gerät im Kontomenü, stummschalten lässt es sich pro Spot.

### 7. Sonne & Wetter auf der Karte

![Kartenmodus Sonne & Wetter](docs/screenshots/sun.jpg)

Der Kartenmodus *Sonne & Wetter* zeigt für ein beliebiges Datum und eine Uhrzeit die Sonnenbahn, den
Sonnenstand, den Schatten eines 25-m-Baums und die Richtung von Auf- und Untergang. Der Geländehorizont aus
dem Höhenmodell blockiert die Sonne hinter Hügeln (*Sonne ab 05:29*, *Sonne bis 20:36*). Das Panel nennt
Sonnenhöhe, Einstrahlung bei klarem Himmel und gemessen, Himmelssicht, Sonnenstunden und Regen. An jedem
Spot steht die Regenmenge des Tages.

### 8. Arten & Neophyten

<p>
  <img src="docs/screenshots/neophyten-hotspots.jpg" width="49%" alt="Hotspots von Neophyten als Kerndichte-Karte">
  <img src="docs/screenshots/neophyten-ausbreitung.jpg" width="49%" alt="Ausbreitungsfronten des Drüsigen Springkrauts">
</p>

*Arten & Neophyten* wertet die Pflanzenbestimmungen als Funde aus. **Hotspots** (links) zeigen als
Kerndichte-Karte, wo sich Funde aller Neophyten, aller Arten oder einer Art häufen. **Ausbreitung** (rechts)
zeichnet pro Art die besiedelte Fläche Jahr für Jahr, verfolgt einzelne Teilbestände und schätzt Tempo und
Richtung, im Beispiel das Drüsige Springkraut entlang eines Bachs mit ~180 m pro Jahr. Unter *Export*
gehen die Funde als Darwin-Core-CSV an Info Flora und GBIF oder als CSV an iNaturalist.

### 9. Vektorkarten für GIS und Geoportale

<p>
  <img src="docs/screenshots/vektorkarte.jpg" width="49%" alt="Vektorkarte mit MapLibre in Web Mercator">
  <img src="docs/screenshots/vektorkarte-lv95.jpg" width="49%" alt="Vektorkarte mit OpenLayers im Schweizer Kachelgitter LV95">
</p>

Alle Daten stehen auch als offene Geodienste bereit. `/vektorkarte.html` (links) zeigt Spots, Funde und
Ausbreitungsfronten als Vektorkacheln mit MapLibre in Web Mercator, `/vektorkarte-lv95.html` (rechts) mit
OpenLayers im Schweizer Kachelgitter LV95 auf der Landeskarte von swisstopo, deckungsgleich mit
map.geo.admin.ch. Ein Klick auf ein Objekt zeigt seine Angaben.

### 10. Touren und Fotoaufträge

<p>
  <img src="docs/screenshots/touren.jpg" width="49%" alt="Geplante Tour mit Kilometer-Marken und Vorschlägen entlang der Route">
  <img src="docs/screenshots/fotoauftraege.jpg" width="49%" alt="Fotoaufträge auf der Karte und in der Liste">
</p>

*Touren & Aufträge* hält fest, wo man unterwegs ist. Eine Route lässt sich auf der Karte **zeichnen**
(Klick für Klick; der Wege-Magnet zieht die Linie auf Wege und Pfade), mit dem Handy per GPS **aufzeichnen** oder als GPX, TCX, KML
oder GeoJSON **importieren**. Gelbe Kilometer-Marken zeigen den Verlauf, jede Route geht auch als GPX
wieder hinaus. Mit Konto lassen sich Touren speichern und veröffentlichen; andere sehen eine öffentliche
Tour ohne Zeiten und ohne die ersten und letzten 200 m. Über eine Tour mit Zeitstempeln lassen sich im
Upload auch Fotos ohne GPS verorten.

Ein **Fotoauftrag** (rechts) bittet um ein Foto von einem Ort, etwa «Neue Lichtung am Waldweg, Blick nach
Nordost», oder um ein neues Foto eines Spots. Er nennt keine Zeit und keinen Namen. Wer eine Route plant,
sieht unter *Unterwegs fotografieren* (links) in der Reihenfolge der Strecke, was nahe am Weg liegt: offene
Aufträge, Spots mit Satelliten-Frühwarnung und Fotoreihen, die seit über einem Jahr ruhen. Die Route wird
dafür nicht gespeichert. Ein Foto am richtigen Ort erledigt den Auftrag automatisch.

### 11. Geschützte Funde für PRO-Mitglieder

<p>
  <img src="docs/screenshots/schutz-raster.jpg" width="49%" alt="Geschützter Fund öffentlich nur als 5-km-Quadrat">
  <img src="docs/screenshots/schutz-pro.jpg" width="49%" alt="Dieselbe Stelle für ein verifiziertes PRO-Mitglied mit Foto und genauer Lage">
</p>

Seltene Pflanzen, Pilzstellen oder Horste sollen nicht geplündert oder zertrampelt werden. Ein Foto lässt
sich deshalb beim Hochladen als **geschützter Fund** markieren. Erkennt Pl@ntNet eine sensible Art, etwa
eine Orchidee oder einen Enzian, wird es automatisch geschützt. Die Öffentlichkeit sieht davon nur ein
schraffiertes **5-km-Quadrat** (links). Foto, Spot und genaue Lage sehen nur **verifizierte PRO-Mitglieder**
wie Forstdienste oder Naturschutzorganisationen (rechts, mit Schloss am Pin). PRO beantragt man im
Konto-Menü, eine Administratorin oder ein Administrator prüft den Antrag. Geschützte Funde fehlen in allen
offenen Geodaten, Kacheln und Exporten für die Öffentlichkeit.

## Was MyForrest kann

Ein kurzer Überblick. Alle Details, auch zu den verwendeten Verfahren, stehen unter
[Funktionen im Detail](docs/funktionen.md).

- **[Fotos erfassen](docs/funktionen.md#fotos-erfassen-und-verorten)**: Handyfotos (auch HEIC vom iPhone),
  Action-Cam-Serien mit GPX-Track und Videos von GoPro oder 360°-Kameras. Verortung über GPS, GPX oder von
  Hand. Als installierbare App funktioniert der Upload auch ohne Empfang im Wald und wird später gesendet.
- **[Spots und Zeitreise](docs/funktionen.md#spots-und-zeitreise)**: Fotos am selben Ort und mit derselben
  Blickrichtung werden automatisch zu Spots zusammengefasst und lassen sich als Zeitreihe durchblättern.
- **[Bildanalyse](docs/funktionen.md#bildanalyse)**: automatische Ausrichtung, Veränderungs-Heatmap,
  Einordnung der Veränderungen (Windwurf, Auflichtung, Verfärbung, neuer Bewuchs), die aus Bestätigungen
  dazulernt, Objekterkennung für liegende Stämme und Holzpolter sowie Vegetationsdichte pro Foto.
- **[Wetter, Klima und Gelände](docs/funktionen.md#wetter-klima-und-gelände)**: Wetter-Kontext zu jedem
  Foto, Auffälligkeiten wie Trockenheit oder frühe Laubverfärbung, Stürme seit dem letzten Besuch,
  Höhe, Exposition, Kaltluftseen sowie Satellitendaten (NDVI und Feuchteindex NDMI aus Sentinel-2, vor 2017
  Landsat) als unabhängige Bestätigung und als Frühwarnung für Spots ohne neue Fotos, deren Schwellen sich an
  bestätigten Schäden eichen (getrennt für Laub- und Nadelwald) und an zurückgehaltenen Spots geprüft werden,
  als Push-Nachricht an alle, die den Spot regelmässig besuchen.
- **[Kartenmodi](docs/funktionen.md#kartenmodi)**: Sonnenstand, Schatten und Einstrahlung inklusive
  Geländehorizont sowie Hotspots und Ausbreitungsfronten von Neophyten.
- **[Pflanzen und Baumarten](docs/funktionen.md#pflanzen-und-baumarten)**: Pflanzenbestimmung mit Pl@ntNet,
  Erkennung invasiver Neophyten, Artenbestand pro Spot und Export zu Info Flora, GBIF und iNaturalist.
- **[Offene Geodaten](docs/funktionen.md#offene-geodaten-für-gis-und-geoportale)**:
  - Alle Daten als OGC API – Features und GeoPackage, in WGS84 oder den Schweizer Landeskoordinaten LV95
    wie bei swisstopo.
  - Vektorkacheln (OGC API – Tiles, MVT) in Web Mercator und im Schweizer Kachelgitter LV95, vorberechnet
    und als PMTiles/MBTiles zum Herunterladen.
  - Zwei Vektorkarten: MapLibre in Web Mercator, OpenLayers auf der Landeskarte von swisstopo.
  - Metadaten für geocat.ch und opendata.swiss (GM03/ISO 19139).
  - Ein fertiges QGIS-Projekt für QGIS Server (WMS/WMTS/WFS) für Geoportale wie map.geo.admin.ch.
- **[Touren und Fotoaufträge](docs/funktionen.md#touren-und-fotoaufträge)**: Routen zeichnen, per GPS
  aufzeichnen oder importieren (GPX, TCX, KML, GeoJSON), als GPX exportieren und speichern; Fotoaufträge
  ohne Zeit und Namen und Vorschläge entlang der eigenen Route.
- **[Geschützte Funde](docs/funktionen.md#geschützte-funde-und-pro-mitglieder)**: seltene Arten und Pilzstellen
  nur für verifizierte PRO-Mitglieder (Forstdienst, Naturschutz), öffentlich nur als 5-km-Raster.
- **[Konten und Moderation](docs/funktionen.md#konten-moderation-und-lizenzen)**: Konten mit Rollen, Anmeldung mit E-Mail (Bestätigungslink, Passwort ändern und zurücksetzen) oder über Google und GitHub,
  Lizenz pro Foto, Melden und Moderieren.

## Schnellstart

Voraussetzung: Node.js ≥ 22.5, für Videos zusätzlich `ffmpeg`.

```bash
npm install
npm start            # http://localhost:3000
npm test
```

Für das Kamera-Overlay auf dem Handy braucht es HTTPS. Wie das geht und welche Umgebungsvariablen es gibt,
steht unter [Installation und Konfiguration](docs/installation.md).

Mit QGIS Server für Geoportale gibt es zwei fertige Zusammenstellungen: Docker Compose unter
[`deploy/qgis-server`](deploy/qgis-server/README.md) und Kubernetes, etwa ein lokaler Cluster auf podman,
unter [`deploy/k8s`](deploy/k8s/README.md) (`deploy/k8s/start.sh`).

## Dokumentation

| Dokument | Inhalt |
|----------|--------|
| [Funktionen im Detail](docs/funktionen.md) | Alle Funktionen mit Verfahren, Schwellenwerten und Grenzen |
| [Installation und Konfiguration](docs/installation.md) | Voraussetzungen, HTTPS fürs Handy, Umgebungsvariablen, externer Detektor, Phänologie-Daten |
| [Betrieb, Datenschutz und Datenquellen](docs/betrieb.md) | Hinweise für einen öffentlichen Betrieb, externe Dienste und Quellenangaben |
| [Architektur](docs/architektur.md) | Aufbau des Codes, Module im Überblick |
| [REST-API](docs/api.md) | Alle Routen des Servers |
| [Roadmap](docs/roadmap.md) | Was als Nächstes geplant ist |
| [QGIS Server](deploy/qgis-server/README.md) und [Kubernetes](deploy/k8s/README.md) | Betrieb mit Geodiensten per Docker Compose oder Kubernetes |

## Daten und Lizenz

Kartendaten © OpenStreetMap-Mitwirkende, Landeskarte und Luftbild © swisstopo. Wetterdaten von
[Open-Meteo.com](https://open-meteo.com) (ERA5, CC BY 4.0). Enthält modifizierte Copernicus-Sentinel-Daten;
Landsat-Daten mit freundlicher Genehmigung des U.S. Geological Survey. Phänologie-Daten: Deutscher
Wetterdienst. Pflanzenbestimmung mit Pl@ntNet. Details unter [Datenquellen](docs/betrieb.md#externe-datenquellen-und-netzzugang).

Der Code steht unter der [Apache-Lizenz 2.0](LICENSE).

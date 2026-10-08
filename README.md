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
weniger als 25 m auseinander liegen und in dieselbe Richtung blicken (±45°), landen automatisch im
selben Spot. Ein goldener Sichtkegel am Marker zeigt die Blickrichtung. Die Zahl im Marker nennt die
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
  Höhe, Exposition, Kaltluftseen und Sentinel-2-Satellitendaten als unabhängige Bestätigung.
- **[Kartenmodi](docs/funktionen.md#kartenmodi)**: Sonnenstand, Schatten und Einstrahlung inklusive
  Geländehorizont sowie Hotspots und Ausbreitungsfronten von Neophyten.
- **[Pflanzen und Baumarten](docs/funktionen.md#pflanzen-und-baumarten)**: Pflanzenbestimmung mit Pl@ntNet,
  Erkennung invasiver Neophyten, Artenbestand pro Spot und Export zu Info Flora, GBIF und iNaturalist.
- **[Offene Geodaten](docs/funktionen.md#offene-geodaten-für-gis-und-geoportale)**: alle Daten als
  OGC API – Features und GeoPackage, in WGS84 oder den Schweizer Landeskoordinaten LV95 wie bei swisstopo,
  Vektorkacheln (OGC API – Tiles, MVT) mit MapLibre-Stil und Vektorkarte, dazu ein fertiges QGIS-Projekt für
  QGIS Server (WMS/WMTS/WFS) für Geoportale wie map.geo.admin.ch.
- **[Konten und Moderation](docs/funktionen.md#konten-moderation-und-lizenzen)**: Konten mit Rollen,
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

## Dokumentation

| Dokument | Inhalt |
|----------|--------|
| [Funktionen im Detail](docs/funktionen.md) | Alle Funktionen mit Verfahren, Schwellenwerten und Grenzen |
| [Installation und Konfiguration](docs/installation.md) | Voraussetzungen, HTTPS fürs Handy, Umgebungsvariablen, externer Detektor, Phänologie-Daten |
| [Betrieb, Datenschutz und Datenquellen](docs/betrieb.md) | Hinweise für einen öffentlichen Betrieb, externe Dienste und Quellenangaben |
| [Architektur](docs/architektur.md) | Aufbau des Codes, Module im Überblick |
| [REST-API](docs/api.md) | Alle Routen des Servers |
| [Roadmap](docs/roadmap.md) | Was als Nächstes geplant ist |

## Daten und Lizenz

Kartendaten © OpenStreetMap-Mitwirkende. Wetterdaten von [Open-Meteo.com](https://open-meteo.com)
(ERA5, CC BY 4.0). Enthält modifizierte Copernicus-Sentinel-Daten. Phänologie-Daten: Deutscher
Wetterdienst. Details unter [Datenquellen](docs/betrieb.md#externe-datenquellen-und-netzzugang).

Der Code steht unter der [Apache-Lizenz 2.0](LICENSE).

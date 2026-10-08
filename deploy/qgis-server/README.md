# MyForrest mit QGIS Server publizieren

Damit sich die Daten wie die Karten von swisstopo als **WMS**, **WMTS** und **WFS** in Geoportale
(z. B. map.geo.admin.ch), QGIS oder ArcGIS einbinden lassen, publiziert QGIS Server ein QGIS-Projekt,
das auf dem GeoPackage-Export von MyForrest beruht. MyForrest selbst bietet zusätzlich eine
**OGC API – Features** unter `/ogc` (siehe Haupt-README), die ohne QGIS Server auskommt.

```
MyForrest ──/api/export/myforrest.gpkg──▶ GeoPackage (LV95, alle 15 min neu)
                                                │
                                   QGIS-Projekt (Stile, Beschriftung)
                                                │
                                          QGIS Server ──▶ /ows/  WMS · WMTS · WFS
```

## 1. Das QGIS-Projekt

`project/myforrest.qgz` ist fertig und wird mitgeliefert. Es liest `../data/myforrest.gpkg` (im Container
`/io/data/myforrest.gpkg`, vom Export-Dienst alle 15 Minuten erneuert), ist in **LV95 (EPSG:2056)** und enthält:

| Ebene (WMS-Name) | Darstellung |
|------------------|-------------|
| `spread_fronts` – Ausbreitungsfronten | Fläche pro Art und Jahr, violett von hell (früher) bis dunkel (neuer); ältere, kleinere Umrisse liegen oben |
| `spots` – Spots | Kreis nach Anzahl Fotos, grün *ohne Befund*, orange *mit Schäden* (Sturm, Borkenkäfer, Trockenschaden, Holzschlag, frühe Verfärbung, Frost – wie die orangen Marker der App; Attribut `status`), goldener Pfeil in Blickrichtung |
| `findings` – Pflanzenfunde | Neophyten als violette Rauten, andere Pflanzen als grüne Punkte |
| `photos` – Fotos | nur über WFS (keine Kartenebene) |

Dazu die Server-Einstellungen: Titel, Beschreibung, Schlagwörter und Nutzungsbedingungen; WMS in
EPSG:2056, 4326, 3857 und 21781 mit GetFeatureInfo (JSON, mit Geometrie); WFS für alle Ebenen
(2 Dezimalen = cm in LV95); WMTS für die ganze Karte und jede Ebene in den Kachelgittern EPSG:2056 und
EPSG:3857. Die Farben sind die der App.

Das Projekt wird mit [`build-project.py`](build-project.py) (PyQGIS) erzeugt; nach Änderungen an Stilen oder
Ebenen neu bauen, mit einem beliebigen Export als Vorlage:

```sh
curl -o /tmp/myforrest.gpkg https://<dein-server>/api/export/myforrest.gpkg
python3 build-project.py /tmp/myforrest.gpkg     # braucht python3-qgis (QGIS ≥ 3.28)
```

Feinschliff in QGIS Desktop ist jederzeit möglich: `project/myforrest.qgz` öffnen (dafür eine Kopie des
GeoPackages unter `data/myforrest.gpkg` neben den Ordner `project` legen), anpassen, speichern.

Geprüft mit QGIS Server 3.34 LTR gegen einen Export mit Demo-Daten: WMS GetCapabilities, GetMap in LV95,
GetLegendGraphic und GetFeatureInfo, WFS GetFeature (GeoJSON in LV95) sowie WMTS GetCapabilities und
GetTile im LV95-Gitter.

## 2. Starten

```sh
cd deploy/qgis-server
PUBLIC_URL=https://karten.example.ch docker compose up -d
```

- `https://karten.example.ch/` – MyForrest
- `https://karten.example.ch/ogc` – OGC API – Features von MyForrest
- `https://karten.example.ch/ows/?SERVICE=WMS&REQUEST=GetCapabilities` – WMS von QGIS Server
- `https://karten.example.ch/ows/?SERVICE=WMTS&REQUEST=GetCapabilities` – WMTS

Für den Betrieb gehört ein TLS-Zertifikat davor (z. B. Caddy oder Traefik als Reverse Proxy);
Geoportale laden Dienste nur über HTTPS.

BRouter läuft mit (siehe [`deploy/brouter`](../brouter/README.md)): MyForrest nutzt ihn für den Wege-Magnet
statt `brouter.de`. Beim ersten Start lädt er die Routing-Daten für die Schweiz; ein anderes Gebiet mit
`BROUTER_BBOX=West,Süd,Ost,Nord`.

## 3. In Geoportalen zeigen

- **map.geo.admin.ch**: *Erweiterte Werkzeuge → Import* → die WMS- oder WMTS-Capabilities-URL eingeben.
  So lassen sich die Layer über die swisstopo-Karte legen und als Link teilen.
- **QGIS / ArcGIS**: WMS/WMTS-Verbindung mit derselben URL, oder direkt die OGC API – Features
  (`/ogc`) als Vektor-Layer.
- **Offizieller Layer auf geo.admin.ch** oder **Eintrag auf opendata.swiss / geodienste.ch**: Das ist
  ein eigener Prozess mit den Betreibern (Metadaten, Datenmodell, Nachführung, Lizenz) und lässt sich
  nicht technisch erzwingen; die Dienste hier sind die Voraussetzung dafür.

## Hinweise

- Docker Compose selbst wurde ohne laufendes Docker erstellt (QGIS Server und Projekt sind geprüft, siehe
  oben); vor dem Produktivbetrieb einmal durchspielen.
- Ausgeblendete (moderierte) Fotos erscheinen in keinem Dienst. Fotos und Funde tragen ihre Lizenz
  (`license`) und den Namen der Person, die sie hochgeladen hat (`author`), als Attribute mit.
- LV95 wird mit den Näherungsformeln von swisstopo berechnet (Genauigkeit ~1 m), was der
  GPS-Genauigkeit der Fotos entspricht.

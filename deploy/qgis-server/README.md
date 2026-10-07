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

## 1. QGIS-Projekt anlegen (einmalig, in QGIS Desktop)

1. GeoPackage herunterladen: `https://<dein-server>/api/export/myforrest.gpkg` (LV95).
2. In QGIS öffnen; die Layer `spots`, `photos`, `findings` und `spread_fronts` hinzufügen.
3. Projekt-KBS auf **EPSG:2056 (CH1903+ / LV95)** setzen und die Layer gestalten
   (z. B. `spread_fronts` nach `year` abgestuft, `findings` nach `neophyte`).
4. Die Datenquelle auf den Pfad im Container umstellen: Layer → *Datenquelle ändern* →
   `/io/data/myforrest.gpkg` (oder das Projekt mit relativen Pfaden neben einer Kopie der Datei speichern
   und den Pfad danach im Projekt anpassen).
5. *Projekt → Eigenschaften → QGIS Server*:
   - *Service-Fähigkeiten*: Titel, Kurzbeschreibung, Kontakt, Nutzungsbedingungen (Lizenzen der Fotos,
     z. B. CC BY-SA 4.0) ausfüllen.
   - *WMS*: KBS einschränken auf EPSG:2056, EPSG:4326, EPSG:3857; Ausdehnung „Aktuelle Kartenansicht“.
   - *WMTS*: die gewünschten Layer veröffentlichen (Kachelmatrix EPSG:2056 und EPSG:3857).
   - *WFS*: Layer zum Abfragen freigeben, Genauigkeit 2 Dezimalen (cm in LV95).
6. Als `deploy/qgis-server/project/myforrest.qgz` speichern.

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

## 3. In Geoportalen zeigen

- **map.geo.admin.ch**: *Erweiterte Werkzeuge → Import* → die WMS- oder WMTS-Capabilities-URL eingeben.
  So lassen sich die Layer über die swisstopo-Karte legen und als Link teilen.
- **QGIS / ArcGIS**: WMS/WMTS-Verbindung mit derselben URL, oder direkt die OGC API – Features
  (`/ogc`) als Vektor-Layer.
- **Offizieller Layer auf geo.admin.ch** oder **Eintrag auf opendata.swiss / geodienste.ch**: Das ist
  ein eigener Prozess mit den Betreibern (Metadaten, Datenmodell, Nachführung, Lizenz) und lässt sich
  nicht technisch erzwingen; die Dienste hier sind die Voraussetzung dafür.

## Hinweise

- Das Setup ist eine Vorlage und wurde ohne laufendes Docker erstellt; vor dem Produktivbetrieb
  einmal durchspielen.
- Ausgeblendete (moderierte) Fotos erscheinen in keinem Dienst. Fotos und Funde tragen ihre Lizenz
  (`license`) und den Namen der Person, die sie hochgeladen hat (`author`), als Attribute mit.
- LV95 wird mit den Näherungsformeln von swisstopo berechnet (Genauigkeit ~1 m), was der
  GPS-Genauigkeit der Fotos entspricht.

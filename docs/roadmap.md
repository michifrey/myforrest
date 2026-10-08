# Roadmap

Was als Nächstes geplant ist. Was der Prototyp heute schon kann, steht unter
[Funktionen im Detail](funktionen.md).

## Phase 2: Mehr und bessere Fotos

- **Video und 360°**: Insta360-`.insv` direkt lesen (Fischaugen stitchen, GPS aus dem Datei-Trailer),
  360°-Fotos auch beim Foto-Upload erkennen, Ausrichtung und Veränderungserkennung für Panoramen (statt
  Homographie), Bilder unscharfer Frames verwerfen.
- **Spots aufteilen**: Bestehende Spots mit gemischten Blickrichtungen auf Wunsch aufteilen (neue Fotos
  werden bereits nach Richtung getrennt).
- **PWA**: Kartenausschnitt einer geplanten Route gezielt für offline vorladen; Push-Benachrichtigung,
  wenn ein Upload aus der Warteschlange abgelehnt wurde.
- **Konten ausbauen**: Passwort zurücksetzen und E-Mail bestätigen, Profilseite mit eigenen Fotos,
  Konto löschen; Rate-Limits dauerhaft speichern statt im Arbeitsspeicher.

## Phase 3: Automatische Auswertung

- **Objekterkennung**: ein feinjustiertes YOLO- oder Segmentierungsmodell für umgestürzte Bäume,
  Wurzelteller, Totholz, Holzpolter und Rückegassen als Dienst hinter `DETECTOR_URL` betreiben. Die
  Schnittstelle, die Speicherung und die Bewertung der Treffer stehen bereits; die eingebauten Heuristiken
  decken nur liegende Stämme und Holzpolter ab. Die bestätigten und abgelehnten Treffer sind ein Datensatz
  zum Feinjustieren.
- **Einordnung lernen**: Das Modell nutzt bisher die Merkmale der Regeln. Als Nächstes Bildmerkmale direkt
  lernen (z. B. Embeddings eines vortrainierten Netzes pro Region) und abgelehnte Vorschläge als negative
  Beispiele gewichten.
- **Nadel-/Laubholzanteil**: mit Referenzfotos pro Art kalibrieren und Arten direkt im Bild erkennen, auch
  ohne Pl@ntNet.
- **Phänologie**: MeteoSchweiz-Daten direkt lesen (heute über das generische CSV), Referenz auch für den
  Laubaustrieb (Spätfrost erst nach dem tatsächlichen Austrieb der Region) und für das laufende Jahr
  (Sofortmelder) statt nur des Zehnjahresmittels.
- **Stürme genauer**: Böen aus feiner aufgelösten Modellen (z. B. ICON-D2) oder Stationsmessungen,
  Sturmwarnungen aus der Prognose als Hinweis, betroffene Spots nach einem Sturm zu besuchen.
- **Vegetationsdichte verfeinern**: Himmel und Vegetation mit einem Segmentierungsmodell statt Farbregeln
  trennen (Schnee, helle Felsen und Mauern gelten heute teils als Himmel); Kennzahlen nur im Bildteil
  vergleichen, den alle Fotos eines Spots abdecken.
- **Arten und Neophyten**: direkter Upload über die APIs (OAuth-Konto bei iNaturalist bzw. Info Flora),
  Bestätigung der automatischen Bestimmungen durch Menschen vor dem Export und eine Korrektur für
  ungleich verteilten Suchaufwand.

## Phase 4: Betrieb und Geodienste

- **Kubernetes**: Das Startskript gegen einen echten podman-Cluster (kind/minikube) testen; Ingress mit
  HTTPS und ein Helm-Chart für den Betrieb ausserhalb des eigenen Rechners.
- **Metadaten**: Einträge pro Collection und einen Objektkatalog (Feature Catalogue) für geocat.ch; den Weg
  zu opendata.swiss einmal mit einem echten Konto durchspielen.
- **Kacheln**: PMTiles/MBTiles mit streamendem Schreiber für sehr grosse Datenmengen; LV95-Kacheln auch als
  Datei (z. B. GeoPackage-Kacheln mit eigenem Kachelgitter).

## Bereits umgesetzt

Aus früheren Versionen dieser Roadmap:

- Video statt Einzelbilder (GoPro mit GPMF, 360°-MP4, GPX)
- Sturmereignisse aus Böen mit Windwurf-Funden verknüpfen
- DWD-Phänologie als Referenz für den Beginn der Herbstfärbung
- Nächtliche Abkühlung in Senken aus Wind und Bewölkung
- Hotspot-Karten, Ausbreitungsfronten und Datei-Export zu Info Flora / iNaturalist
- Satellitenkontext: NDMI, Frühwarnung ohne neue Fotos, Landsat vor 2017, Sturm als Kontext
- Kalibrierung der Frühwarnung und der Rückgänge zwischen Fotos an bestätigten Schäden, geprüft mit
  Kreuzvalidierung nach Spots, getrennt für Laub- und Nadelwald
- Frühwarnung als Push-Nachricht an Leute, die den Spot regelmässig besuchen oder ihm folgen
- Angleichung von Landsat an Sentinel-2 aus den Überlappungsjahren
- Geodienste: OGC API – Features und Tiles (auch im LV95-Kachelgitter, vorberechnet, PMTiles/MBTiles),
  Vektorkarten, QGIS Server, Metadaten für geocat.ch (GM03)
- Betrieb mit Docker Compose und Kubernetes (podman-Startskript)

# Roadmap

Was als Nächstes geplant ist. Was der Prototyp heute schon kann, steht unter
[Funktionen im Detail](funktionen.md).

## Phase 2: Mehr und bessere Fotos

- **Dashcam ausbauen**: Videos gängiger Dashcams direkt lesen (GPS als NMEA im MP4 bzw. in Begleitdateien,
  z. B. Viofo, BlackVue), damit sie ohne GPX-Track gehen; Fahrtmodus im Hintergrund (braucht eine native
  Hülle); Bilder aus dem Auto in der Zeitreise kennzeichnen und auf Wunsch ausblenden.

- **360°-Rohdateien**: Insta360-`.insv` und GoPro-MAX-`.360` direkt lesen (Fischaugen stitchen, GPS aus dem
  Datei-Trailer). Braucht Beispieldateien der Kameras und deren Objektivdaten; bis dahin über den Export
  als 360°-MP4.
- **Geschützte Funde**: Pilze per Bild erkennen (braucht ein Modell; Pl@ntNet kennt keine Pilze), die
  kantonalen Listen direkt von den Fachstellen bzw. Info Flora beziehen (sobald es dafür eine offene
  Schnittstelle gibt).
- **Eigener Routing-Server**: Image von `deploy/brouter` in einer Registry bauen und gegen echte Routing-Daten
  prüfen, ein eigenes Waldprofil (Forststrassen und Rückegassen bevorzugen, Wildruhezonen meiden).
- **Touren**: FIT-Dateien direkt lesen, Höhenprofil der Route, Abgleich mit Strava/Komoot per OAuth,
  Aufzeichnung im Hintergrund (braucht eine native Hülle, Browser stoppen GPS im Hintergrund),
  Benachrichtigung, wenn ein eigener Fotoauftrag erledigt wurde, Ablaufdatum für Aufträge.
- **Konten ausbauen**: Export der eigenen Daten, Anzeigename ändern, E-Mail-Adresse ändern (mit
  Bestätigung der neuen Adresse); weitere Anmeldedienste wie SwitchEdu-ID oder Microsoft; Rate-Limits
  dauerhaft speichern statt im Arbeitsspeicher.

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

- Fahrtmodus: das Handy als Dashcam im Auto, Route automatisch, Auswahl und Deduplizierung der Bilder auf dem
  Gerät
- Video statt Einzelbilder (GoPro mit GPMF, 360°-MP4, GPX), unscharfe Bilder werden ersetzt oder verworfen
- 360°-Fotos beim Upload erkennen, Panoramen über eine Drehung der Kugel ausrichten und vergleichen
- Spots mit gemischten Blickrichtungen auf Wunsch aufteilen
- Karte und Spots entlang einer Route offline speichern; Benachrichtigung, wenn ein Upload im Hintergrund
  abgelehnt wurde
- Schutzlisten je Kanton laden (Kanton des Spots über geo.admin.ch); PRO-Verifizierung auf ein Jahr befristet,
  mit Erinnerung und Verlängerung
- Organisationen mit mehreren Mitgliedern: die verifizierte Leitung nimmt Kolleginnen und Kollegen auf, auch per
  Einladung an eine E-Mail-Adresse ohne Konto
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
- Konten: Anmelden mit Google und GitHub, E-Mail bestätigen, Passwort zurücksetzen und ändern, Konto löschen, Profilseite mit eigenen Fotos

# Roadmap

Was als Nächstes geplant ist. Was der Prototyp heute schon kann, steht unter
[Funktionen im Detail](funktionen.md).

## Phase 2: Mehr und bessere Fotos

- **Dashcam ausbauen**: Fahrtmodus im Hintergrund (braucht eine native Hülle); das Dashcam-GPS mit echten
  Dateien verschiedener Modelle prüfen (bisher nach den bekannten Formaten mit Testdaten) und weitere Formate
  (z. B. GPS-Spur von Garmin- und Nextbase-Kameras, verschlüsselte Viofo-Daten).

- **Durchgehen ausbauen**: Mapillary-Bilder an einer Stelle als zusätzliche Ansicht zeigen (API-Schlüssel,
  CC BY-SA) und eigene Reihen dorthin hochladen, ohne geschützte Funde; weiche Übergänge zwischen Panoramen
  (Überblenden, Zoom in Gehrichtung); Wege aus dem Wegnetz statt nur aus Reihen und Spots.
- **360°-Rohdateien**: Insta360-`.insv` und GoPro-MAX-`.360` direkt lesen (Fischaugen stitchen, GPS aus dem
  Datei-Trailer). Braucht Beispieldateien der Kameras und deren Objektivdaten; bis dahin über den Export
  als 360°-MP4.
- **Geschützte Funde**: Pilze per Bild erkennen (braucht ein Modell; Pl@ntNet kennt keine Pilze), die
  kantonalen Listen direkt von den Fachstellen bzw. Info Flora beziehen (sobald es dafür eine offene
  Schnittstelle gibt).
- **Eigener Routing-Server**: den ersten Lauf des Image-Workflows und echte Segmente von brouter.de prüfen;
  die Wildruhezonen regelmässig selbst von geo.admin.ch laden statt aus einer Datei; Rückegassen nach
  Holzschlag zeitweise sperren.
- **Touren**: Abgleich mit Strava/Komoot per OAuth (braucht dort registrierte Apps), Aufzeichnung im
  Hintergrund (braucht eine native Hülle, Browser stoppen GPS im Hintergrund); FIT-Dateien mit Developer-
  Feldern (z. B. Laufleistung) auswerten.

- **Landschaften ausbauen**: im Trockengebiet Ausrichtung am Horizont, wo Dünen keine festen Punkte haben,
  und längere Offline-Zeiten; im Gebirge Routing mit SAC-Skala und Gefahrenkarten (Steinschlag, Lawinen);
  ein Name der App für mehr als den Wald.
- **Gletscher ausbauen**: Längenänderung der Zunge aus den GLAMOS-Messreihen am Spot zeigen; schuttbedecktes
  Eis mit einem eigenen Index (z. B. NDSI und Temperatur) erkennen; Archivbilder aus Sammlungen mit offener
  Lizenz (z. B. ETH-Bibliothek) als Vorschlag am passenden Standort anbieten.

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
  Gerät; GPS von Dashcam-Videos (NMEA, Novatek) direkt aus der Datei; Fahrtbilder in der Zeitreise markiert
  und ausblendbar
- Eigener Routing-Server: Waldprofil (Forststrassen und Rückegassen zuerst), Wildruhezonen in der Schutzzeit
  umgehen, BRouter-Image per GitHub-Workflow in der Registry
- Touren: FIT-Dateien direkt lesen, Höhenprofil der Route, Push-Nachricht bei erledigtem Fotoauftrag,
  Ablaufdatum für Aufträge
- Video statt Einzelbilder (GoPro mit GPMF, 360°-MP4, GPX), unscharfe Bilder werden ersetzt oder verworfen
- 360°-Fotos beim Upload erkennen, Panoramen über eine Drehung der Kugel ausrichten und vergleichen
- Durchgehen wie Street View: Pfeile entlang der Aufnahme und zu Spots in der Nähe, Blickrichtung bleibt beim Schritt
- Startseite mit wechselnden Landschaften (Wald, Gletscher, Gebirge, Wüste)
- Landschaftsprofile Gletscher, Gebirge und Trockengebiet: Umrisse aus Gletscherinventaren pro Jahr, Eis im Spätsommer und
  Schneeschmelze aus Sentinel-2, Archivfotos mit Datum von Hand, Beobachtungen und Auswertung je Landschaft
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
- Konten: Anmelden mit Google und GitHub, E-Mail bestätigen, Passwort zurücksetzen und ändern, Konto löschen, Profilseite mit eigenen Fotos, Anzeigename und E-Mail-Adresse ändern, Export der eigenen Daten, Microsoft, SWITCH edu-ID, AGOV und weitere OpenID-Connect-Dienste, dauerhafte Rate-Limits

# Roadmap

Was als Nächstes geplant ist. Was der Prototyp heute schon kann, steht unter
[Funktionen im Detail](funktionen.md).

## Phase 2: Mehr und bessere Fotos

- **Dashcam ausbauen**: Fahrtmodus im Hintergrund (braucht eine native Hülle); das Dashcam-GPS mit echten
  Dateien verschiedener Modelle prüfen (bisher nach den bekannten Formaten mit Testdaten) und weitere Formate
  (z. B. GPS-Spur von Garmin- und Nextbase-Kameras, verschlüsselte Viofo-Daten).

- **Durchgehen ausbauen**: eigene Reihen zu Mapillary hochladen (OAuth bei Mapillary, ohne geschützte Funde);
  Wege aus dem Wegnetz statt nur aus Reihen und Spots; Übergänge mit Tiefe (die Nachbarbilder anhand gemeinsamer
  Bildmerkmale ineinander morphen statt nur zoomen).
- **360°-Rohdateien**: Insta360-`.insv` und GoPro-MAX-`.360` direkt lesen (Fischaugen stitchen, GPS aus dem
  Datei-Trailer). Braucht Beispieldateien der Kameras und deren Objektivdaten; bis dahin über den Export
  als 360°-MP4.
- **Geschützte Funde**: Pilze per Bild erkennen (braucht ein Modell; Pl@ntNet kennt keine Pilze), die
  kantonalen Listen direkt von den Fachstellen bzw. Info Flora beziehen (sobald es dafür eine offene
  Schnittstelle gibt).
- **Eigener Routing-Server**: den ersten Lauf des Image-Workflows und echte Segmente von brouter.de prüfen;
  die Wildruhezonen regelmässig selbst von geo.admin.ch laden statt aus einer Datei; Sperrungen der Forstdienste
  aus ihren eigenen Systemen übernehmen (z. B. Holzschlag-Planung der Kantone).
- **Touren**: Abgleich mit Strava/Komoot per OAuth (braucht dort registrierte Apps), Aufzeichnung im
  Hintergrund (braucht eine native Hülle, Browser stoppen GPS im Hintergrund); die Karte kühler Abschnitte
  mit Messnetzen in der Nähe vergleichen (z. B. Stadtklima-Messnetze), sobald es genug echte Touren gibt.

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
- **Phänologie**: den MeteoSchweiz-Leser mit echten Downloads prüfen; die Stundenwerte der Nächte schon ab
  März laden, damit ein früher Austrieb (warme Jahre, tiefe Lagen) auch frühe Frostnächte zählt; die Herbstfärbung
  des laufenden Jahres aus den Sofortmeldern.
- **Stürme genauer**: auch die vergangenen Stürme aus feiner aufgelösten Daten (Stationsmessungen von
  MeteoSchweiz statt ERA5), Gewitterböen (lokal, im Modell kaum sichtbar) aus Warnungen der Wetterdienste.
- **Vegetationsdichte verfeinern**: Himmel und Vegetation mit einem Segmentierungsmodell statt Farbregeln
  trennen (Schnee, helle Felsen und Mauern gelten heute teils als Himmel); Kennzahlen nur im Bildteil
  vergleichen, den alle Fotos eines Spots abdecken.
- **Arten und Neophyten**: direkter Upload über die APIs (OAuth-Konto bei iNaturalist bzw. Info Flora); den
  Suchaufwand auch aus Touren statt nur aus Fotos schätzen und in den Ausbreitungsfronten berücksichtigen.

## Phase 4: Betrieb und Geodienste

- **Kubernetes**: Das Startskript gegen einen echten podman-Cluster (kind/minikube) testen; Ingress mit
  HTTPS und ein Helm-Chart für den Betrieb ausserhalb des eigenen Rechners.
- **Metadaten**: Einträge pro Collection und einen Objektkatalog (Feature Catalogue) für geocat.ch; den Weg
  zu opendata.swiss einmal mit einem echten Konto durchspielen.
- **Kacheln**: die LV95-Kacheln in einer Form, die QGIS direkt öffnet (GDAL liest Vektorkacheln in GeoPackage noch
  nicht), etwa als gerenderte Rasterkacheln im selben Gitter; den Kachel-Speicher für ganz grosse Datenmengen auf
  mehrere Dateien verteilen.

## Bereits umgesetzt

Aus früheren Versionen dieser Roadmap:

- Doku-Website (Projekt-Wiki) aus `docs/*.md` mit Suche und *Seite bearbeiten*, über GitHub Pages, eigene Domain
  vorbereitet

- Fahrtmodus: das Handy als Dashcam im Auto, Route automatisch, Auswahl und Deduplizierung der Bilder auf dem
  Gerät; GPS von Dashcam-Videos (NMEA, Novatek) direkt aus der Datei; Fahrtbilder in der Zeitreise markiert
  und ausblendbar
- Eigener Routing-Server: Waldprofil (Forststrassen und Rückegassen zuerst), Wildruhezonen in der Schutzzeit
  umgehen, BRouter-Image per GitHub-Workflow in der Registry
- Sperrungen bei Holzerei: automatisch aus Holzschlag-Fotos, von Hand durch den Forstdienst; der Wege-Magnet
  führt darum herum
- Touren: FIT-Dateien direkt lesen, mit Sensorwerten und Developer-Feldern (z. B. Laufleistung), auch aus GPX
  und TCX; Höhenprofil der Route, wahlweise mit Puls, Leistung oder Temperatur entlang der Strecke; Karte kühler
  Abschnitte aus den geteilten Temperaturen vieler Touren, geeicht am Wettermodell und getrennt nach Jahres- und
  Tageszeit; Push-Nachricht bei erledigtem Fotoauftrag, Ablaufdatum
  für Aufträge
- Video statt Einzelbilder (GoPro mit GPMF, 360°-MP4, GPX), unscharfe Bilder werden ersetzt oder verworfen
- 360°-Fotos beim Upload erkennen, Panoramen über eine Drehung der Kugel ausrichten und vergleichen
- Durchgehen wie Street View: Pfeile entlang der Aufnahme und zu Spots in der Nähe, Blickrichtung bleibt beim Schritt
- Startseite mit wechselnden Landschaften (Wald, Gletscher, Gebirge, Wüste)
- Weiche Übergänge im Durchgehen: zum Weg drehen, Zoom in Gehrichtung mit Überblendung
- Mapillary-Bilder im Durchgehen und auf der Karte, wo es keine eigenen gibt (über den Server, mit Urheber und Lizenz)
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
- Sturmwarnung aus der Böenprognose (ICON-D2) per Push, nach dem Sturm die Bitte um ein Foto, wenn er wirklich kam
- DWD-Phänologie als Referenz für den Beginn der Herbstfärbung
- Phänologie von MeteoSchweiz direkt (OGD), Laubaustrieb aus Jahres- und Sofortmeldern; Spätfrost zählt erst nach dem
  Austrieb der Region
- Nächtliche Abkühlung in Senken aus Wind und Bewölkung
- Hotspot-Karten, Ausbreitungsfronten und Datei-Export zu Info Flora / iNaturalist
- Bestimmungen von Fachleuten prüfen lassen (bestätigen, korrigieren, ablehnen), Export nur geprüfter Funde, Hotspots
  pro 100 Fotos gegen ungleichen Suchaufwand
- Satellitenkontext: NDMI, Frühwarnung ohne neue Fotos, Landsat vor 2017, Sturm als Kontext
- Kalibrierung der Frühwarnung und der Rückgänge zwischen Fotos an bestätigten Schäden, geprüft mit
  Kreuzvalidierung nach Spots, getrennt für Laub- und Nadelwald
- Frühwarnung als Push-Nachricht an Leute, die den Spot regelmässig besuchen oder ihm folgen
- Angleichung von Landsat an Sentinel-2 aus den Überlappungsjahren
- PMTiles/MBTiles Kachel für Kachel geschrieben (auch sehr grosse Datenmengen), LV95-Kacheln als GeoPackage mit eigenem
  Kachelgitter
- Geodienste: OGC API – Features und Tiles (auch im LV95-Kachelgitter, vorberechnet, PMTiles/MBTiles),
  Vektorkarten, QGIS Server, Metadaten für geocat.ch (GM03)
- Betrieb mit Docker Compose und Kubernetes (podman-Startskript)
- Konten: Anmelden mit Google und GitHub, E-Mail bestätigen, Passwort zurücksetzen und ändern, Konto löschen, Profilseite mit eigenen Fotos, Anzeigename und E-Mail-Adresse ändern, Export der eigenen Daten, Microsoft, SWITCH edu-ID, AGOV und weitere OpenID-Connect-Dienste, dauerhafte Rate-Limits, auch hinter einem Reverse Proxy (`TRUST_PROXY`)

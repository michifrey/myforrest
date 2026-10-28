# Roadmap

Was als Nächstes geplant ist. Was der Prototyp heute schon kann, steht unter
[Funktionen im Detail](funktionen.md); die ganze Doku auch als Website unter
[michifrey.github.io/myforrest](https://michifrey.github.io/myforrest/).

Stand: Oktober 2026. Viele neue Teile sind mit Testdaten im Format der echten Quellen geprüft, aber noch nicht
mit echten Dateien und Diensten; das steht jeweils als offener Punkt dabei.

## Phase 2: Mehr und bessere Fotos

- **Dashcam ausbauen**: das Dashcam-GPS mit echten
  Dateien verschiedener Modelle prüfen (bisher nach den bekannten Formaten mit Testdaten) und weitere Formate
  (z. B. GPS-Spur von Garmin- und Nextbase-Kameras, verschlüsselte Viofo-Daten).

- **Karte**: die Grundkarte *MyForrest* mit echten Kacheln von OpenFreeMap im Betrieb prüfen (gebaut nach dem
  Schema OpenMapTiles, getestet mit Demo-Kacheln); die Ebenen von geo.admin.ch, des Baumkatasters Zürich und von EFFIS
  gegen die echten Dienste prüfen (Namen der Ebenen, Attribute bei *Was ist hier?*), die Attributnamen in lesbare
  Bezeichnungen übersetzen; Geoportale der Kantone (z. B. Aargau, Zürich) mit ihrem Waldentwicklungsplan und
  Baumkataster als regionale Dienste; Verkehr in Echtzeit, falls ein offener Dienst entsteht.
- **3D-Karte ausbauen**: das Höhenmodell swissALTI3D von swisstopo (2 m) für die Schweiz statt der weltweiten
  Kacheln (braucht einen eigenen Kachel-Dienst, swisstopo liefert keine Terrarium-Kacheln), dann passen auch Gebäude
  und Bäume genauer aufs Gelände; die Höhenkorrektur der 3D Tiles mit dem Geoid-Modell von swisstopo statt fest 50 m;
  die Gebäude und Bäume mit den echten Tilesets prüfen (Adresse der Gebäude nach dem Muster der Dokumentation, getestet
  mit Demo-Tiles im selben Format); beim Abfliegen einer Tour die Fotos am Weg einblenden.
- **Durchgehen ausbauen**: eigene Reihen zu Mapillary hochladen (OAuth bei Mapillary, ohne geschützte Funde);
  Schritte mit echter Parallaxe (Tiefenschätzung statt einer Ebene); das Wegnetz mit einer echten Overpass-Instanz
  im Betrieb prüfen.
- **360°-Rohdateien**: Insta360-`.insv` und GoPro-MAX-`.360` direkt lesen (Fischaugen stitchen, GPS aus dem
  Datei-Trailer). Braucht Beispieldateien der Kameras und deren Objektivdaten; bis dahin über den Export
  als 360°-MP4.
- **Geschützte Funde**: Pilze per Bild erkennen (braucht ein Modell; Pl@ntNet kennt keine Pilze), die
  kantonalen Listen direkt von den Fachstellen bzw. Info Flora beziehen (sobald es dafür eine offene
  Schnittstelle gibt).
- **Eigener Routing-Server**: den ersten Lauf des Image-Workflows und echte Segmente von brouter.de prüfen;
  das Laden der Wildruhezonen von geo.admin.ch gegen den echten Dienst prüfen (Name der Ebene, Attribute der
  Schutzzeit); Sperrungen der Forstdienste aus ihren eigenen Systemen übernehmen (z. B. Holzschlag-Planung der
  Kantone).
- **Touren**: Abgleich mit Strava/Komoot per OAuth (braucht dort registrierte Apps); die Karte kühler Abschnitte
  mit Messnetzen in der Nähe vergleichen (z. B. Stadtklima-Messnetze), sobald es genug echte Touren gibt.
- **Sonne und Schatten unterwegs**: Bewölkung aus der Prognose für die nächsten Tage; den Wege-Magnet auf Wunsch schattige (oder sonnige) Wege
  bevorzugen lassen; mit echten Höhen und Routen prüfen, wie gut Waldwege mit Lücken im Kronendach getroffen werden
  (bisher mit den Demo-Höhen im Format von swisstopo).
- **Wikipedia, Wikidata & Commons**: mit den echten Diensten im Betrieb prüfen (gebaut nach der Dokumentation der
  APIs, getestet mit Antworten im selben Format); die Blickrichtung alter Commons-Fotos aus der Vorlage *Location*
  lesen und wie beim Archiv-Katalog nach Richtung filtern; eigene Fotos (mit Einverständnis) auf Commons hochladen;
  Wikidata-Einträge ohne OSM-Verknüpfung als Liste für Mapper (z. B. über den OSM↔Wikidata-Matcher).

- **Android-App ausbauen**: auf F-Droid bzw. im Play Store veröffentlichen (braucht ein Entwicklerkonto und
  die Begründung für Kamera und Standort im Hintergrund); Downloads (GPX, Datenexport) und Push-Mitteilungen
  in der App; eine iOS-App für die Tour-Aufzeichnung im Hintergrund (braucht einen Mac mit Xcode und ein
  Apple-Entwicklerkonto; den Fahrtmodus mit gesperrtem Bildschirm erlaubt iOS nicht, die Kamera geht dort nur im
  Vordergrund).

- **Landschaften ausbauen**: im Trockengebiet längere Offline-Zeiten und die Ausrichtung am Horizont mit echten
  Wüstenfotos prüfen (auch Drehung und Zoom, nicht nur Verschiebung); im Gebirge Routing mit SAC-Skala und
  Gefahrenkarten (Steinschlag, Lawinen); ein Name der App für mehr als den Wald.
- **Gletscher ausbauen**: schuttbedecktes Eis mit einem eigenen Index (z. B. NDSI und Temperatur) erkennen; die
  GLAMOS-Dateien und einen Archiv-Katalog aus dem Bildarchiv der ETH-Bibliothek mit echten Daten einlesen (bisher
  nur mit Beispieldateien im selben Format geprüft).

- **Wetter am Spot ausbauen**: das Radar der MeteoSchweiz mit echten Dateien prüfen (gebaut nach der
  Dokumentation und mit einer nachgebauten Datei im ODIM-Aufbau);
  Unwetterwarnungen der MeteoSchweiz; Vorhersage und DWD-Radar mit echten Abfragen im Betrieb prüfen.

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
- **Licht, Schatten und Wetterkarten**: die DWD-Karten einmal im Betrieb ansehen (Namen und Zeitformat sind
  mit den veröffentlichten Capabilities abgeglichen, aber noch nicht live abgerufen); die Schatten von Bäumen und Gebäuden gegen die echten Dateien von geo.admin.ch prüfen
  (bisher mit Testdaten im Format des STAC-Katalogs und der COGs); die Gebäude aus OpenStreetMap mit einer echten
  Overpass-Instanz im Betrieb prüfen (bisher mit Testdaten im Format der Overpass-Antwort).
- **Vegetationsdichte verfeinern**: Himmel und Vegetation mit einem Segmentierungsmodell statt Farbregeln
  trennen (Schnee, helle Felsen und Mauern gelten heute teils als Himmel); Kennzahlen nur im Bildteil
  vergleichen, den alle Fotos eines Spots abdecken.
- **Arten und Neophyten**: direkter Upload über die APIs (OAuth-Konto bei iNaturalist bzw. Info Flora); den
  Suchaufwand auch aus Touren statt nur aus Fotos schätzen und in den Ausbreitungsfronten berücksichtigen.

## Phase 4: Betrieb und Geodienste

- **Kubernetes**: Das Startskript gegen einen echten podman-Cluster (kind/minikube) testen; Ingress mit
  HTTPS und ein Helm-Chart für den Betrieb ausserhalb des eigenen Rechners.
- **Render**: die privaten Dienste (Routing- und Kartenserver) auf Render selbst prüfen (hier nur die Images und
  der Weg über `/ows/` lokal mit podman getestet).
- **Metadaten**: Collection-Einträge und Objektkatalog gegen die Schemas und Schematron-Regeln von geocat.ch
  prüfen; den Weg zu opendata.swiss einmal mit einem echten Konto durchspielen.
- **Cloud-native Daten**: den STAC-Ordner regelmässig auf einen echten Objektspeicher legen (Cron-Job nach
  `npm run stac`) und bei Portolan eintragen; das Lesen in Teilen (Bbox-Spalte und Zeilengruppen) mit DuckDB und GDAL
  über HTTP an einer grossen Datei messen.
- **Doku-Website**: die eigene Domain docs.myforrest.xyz einrichten (CNAME und `DOCS_URL`), sobald es die
  Domain gibt.
- **Kacheln**: die LV95-Kacheln in einer Form, die QGIS direkt öffnet (GDAL liest Vektorkacheln in GeoPackage noch
  nicht), etwa als gerenderte Rasterkacheln im selben Gitter; den Kachel-Speicher für ganz grosse Datenmengen auf
  mehrere Dateien verteilen.

## Phase 5: Klima im Wandel

Das Modul [Klima im Wandel](klimawandel.md) zeigt das Klima der Region seit 1940 neben den Beobachtungen der Spots.
Als Nächstes:

- **Mit echten Dateien prüfen**: die homogenen Messreihen der MeteoSchweiz (`ch.meteoschweiz.ogd-nbcn`) gegen die
  echten Dateien und die STAC-Liste prüfen (gebaut nach der Dokumentation, getestet mit nachgebauten Dateien); die
  Klima-API von Open-Meteo im Betrieb prüfen (Namen der Modelle, Antwort mit mehreren Modellen).
- **CH2025 direkt**: die Indikatoren der Klimaszenarien CH2025 pro Station und auf dem 1-km-Gitter direkt von der
  MeteoSchweiz lesen statt als vorbereitetes CSV, für alle drei Erwärmungsstufen.
- **Mehr Messdaten**: Raumanalysen der MeteoSchweiz (Gitter ab 1961) als Gegenprobe zu ERA5, Schneehöhen des SLF,
  Wassertemperaturen des BAFU, Permafrost (PERMOS) an Gebirge-Spots.
- **Neue Verbindungen**: Ausbreitungstempo der Neophyten gegenüber den Wintern; kühle Abschnitte aus Touren an
  Hitzetagen; die Klima-Analoga mit Regen und Hitzetagen statt nur dem Jahresmittel.
- **Wald genauer**: die Wasserspeicherung des Bodens (Bodeneignungskarte) und die Exposition in die Einschätzung
  nehmen; die Empfehlung der Tree-App direkt verlinken, sobald sie Koordinaten in der Adresse annimmt; die Faustregeln
  mit Fachleuten von WSL oder kantonalen Forstdiensten prüfen.
- **Genf**: die Adressen der SITG-Dienste und ihre Ebenen prüfen; die Abfrage des Bauminventars gegen den echten
  Dienst prüfen (gebaut nach der Beschreibung der Ebene, getestet mit Daten im selben Format); einen Link auf die
  Position in Genève 3D, falls das Projekt eine solche Adresse anbietet (Absprache mit dem Autor); weitere
  Bauminventare (z. B. Baumkataster der Städte Zürich, Basel, Bern), sobald mehrere gleichzeitig einstellbar sind.
- **Karte**: die offiziellen Karten von geo.admin.ch mit echten Ebenen prüfen (gefunden über die Namen in den
  Capabilities, bisher mit einem Demo-Dienst getestet); das Klima-Raster mit CH2025 auf dem 1-km-Gitter statt aus
  ERA5 und Modellen.
- **Regionen statt Kreise**: Dossier pro Gemeinde, Bezirk, Kanton oder Waldregion (Grenzen von swisstopo), als Seite
  mit fester Adresse zum Teilen und als PDF.

## Phase 6: Landschaft im Wandel

Die Seite [Landschaft im Wandel](landschaft.md) zeigt amtliche Karten durch die Zeit und einen Bericht pro Ort.
Als Nächstes:

- **Mit dem echten Dienst prüfen**: die Ebenen der Karten und Themen gegen die aktuelle Ebenenliste von geo.admin.ch
  prüfen (gebaut nach den Kennungen von swisstopo und BAFU, getestet mit einer nachgebauten Liste) und die
  Identify-Antworten der Themenkarten im Bericht lesbar beschriften (Codes der Höhenstufen und der Arealstatistik);
  die Kartenausschnitte des PDF-Berichts mit den echten WMS-Karten ansehen (Massstab, Lesbarkeit der Ebenen).
- **Wasser und Landwirtschaft vertiefen**: Abflüsse aus Hydro-CH2018, Bodenfeuchte und Trockenheit aus den Messnetzen,
  Bewässerung.
- **Aus map.geo.admin.ch weiter übernehmen**: den Katalog `layersConfig` von geo.admin.ch statt der Suche in den
  Capabilities (mit den Zeitständen jeder Ebene, für einen Regler bei jeder Ebene mit Zeitreihe); externe WMS/WMTS
  aus der Liste mit den echten Diensten prüfen (welche Anbieter Capabilities aus dem Browser erlauben, CORS); KMZ
  (gezippte KML) als Ebene; Zeichnen auf der Karte mit Export als KML. Die Höhe im Koordinaten-Popup und das Jahr
  (`TIME`) der WMS-Ebenen mit den echten Diensten prüfen.
- **Ortssuche mit dem echten Dienst prüfen** (gebaut nach dem Antwortformat des SearchServers von geo.admin.ch,
  getestet mit nachgebauten Antworten).

## Bereits umgesetzt

Aus früheren Versionen dieser Roadmap, nach Themen:

### Fotos, Videos und Fahrtmodus

- Fahrtmodus: das Handy als Dashcam im Auto, Route automatisch, Auswahl und Deduplizierung der Bilder auf dem
  Gerät; GPS von Dashcam-Videos (NMEA, Novatek) direkt aus der Datei; Fahrtbilder in der Zeitreise markiert
  und ausblendbar
- Video statt Einzelbilder (GoPro mit GPMF, 360°-MP4, GPX), unscharfe Bilder werden ersetzt oder verworfen
- 360°-Fotos beim Upload erkennen, Panoramen über eine Drehung der Kugel ausrichten und vergleichen
- Ganze Ordner hochladen (Browser und `scripts/upload-folder.js`), Ort, Blickrichtung und Zeit aus dem Foto oder
  einer JSON-Beschreibung; API-Schlüssel für Skripte
- Spots mit gemischten Blickrichtungen auf Wunsch aufteilen
- Eigener Standort: Browser und App fragen beim Öffnen danach, die Karte beginnt dort; Knopf «Mein Standort»
- Karte und Spots entlang einer Route offline speichern; Benachrichtigung, wenn ein Upload im Hintergrund
  abgelehnt wurde

### Durchgehen und Startseite

- 3D-Karte: Spots mit Blickrichtung, Route und Gletscherumrisse auf dem Gelände (MapLibre, Terrain Tiles über
  den Server), Karte oder Luftbild, Überhöhung wählbar; aus einem Spot direkt in die 3D-Ansicht seiner Umgebung; Route abfliegen
- Grundkarte *MyForrest* als Vektorkarte in den Farben der App (OpenFreeMap, umgefärbt nach Ebenennamen), Wechsel zu
  OSM, Landeskarte und Luftbild; Panel *Ebenen* mit Wald und Waldbrand, Bevölkerung, Bodennutzung, Verkehr von
  geo.admin.ch, Baumkataster Zürich, SITG Genf, EFFIS und NASA FIRMS, mit *Was ist hier?*; Baumkataster Zürich auch
  als Baumart-Vorschlag
- Landschaft im Wandel: Karte aufgebaut wie map.geo.admin.ch: Menü mit «Aktive Karten» (Ein- und Ausblenden,
  Deckkraft, Reihenfolge, Info mit Legende, Vergleichen, Entfernen) und dem Katalog «Karten anzeigen» in Ordnern,
  beliebig viele Karten übereinander, Hintergrund wählbar (Landeskarte, grau, Luftbild, keiner), Zeitleiste für
  Karten mit Jahren, die ganze Ansicht im Link
- Landschaft im Wandel: Bericht als PDF vom Server (A4, festes Layout, Kartenausschnitte der Lage und pro Thema)
- Landschaft im Wandel: Ortssuche nach Gemeinde, Ort, Adresse oder Koordinaten (WGS84, LV95), Ortsname im Bericht und im Link
- Landschaft im Wandel: Gletscherumrisse der Inventare als Ebene über allen Karten, Fläche pro Inventar im Bericht
- Landschaft im Wandel: zwei Jahre nebeneinander (Zeitreise und Luftbilder), mit verschiebbarer Linie und beiden Jahren im Link
- Landschaft im Wandel: historische Luftbilder von swisstopo (SWISSIMAGE Zeitreise, seit 1926), Flug für Flug mit Regler
- Landschaft im Wandel: Zeitreise der Landeskarte von swisstopo, Jahr für Jahr mit Regler, Abspielen und Jahr im Link
- Landschaft im Wandel: zweite Perspektive aus Sicht der Natur als eigene Seite, mit amtlichen Karten durch die Zeit
  (Eiszeit, Dufour, Siegfried, Landeskarte, Waldhöhenstufen heute und 2085), Themenkarten von geo.admin.ch und einem
  druckbaren Bericht pro Ort (Klima, Gletscher und Wasser, Wald, Landwirtschaft und Boden, Beobachtungen), *Daten holen*;
  auf der Startseite zwei Perspektiven nebeneinander
- Startseite: Abschnitt *Funktionen* mit einer Kachel pro Funktion, die sie direkt öffnet (auch per `/?funktion=…`),
  *Funktionen* und *Doku* in der Navigation, *Fahrtmodus starten* im Upload-Dialog, Footer mit Doku und Quellcode
- 3D-Karte mit Gebäuden (swissBUILDINGS3D) und Bäumen (Vegetation 3D) von swisstopo als 3D Tiles über deck.gl,
  vom Ellipsoid auf Meereshöhe gesenkt
- Explorer aufgeräumt (eine Leiste für Filter und Kartenmodi, schmale Explorer-Karte mit Bildkacheln) und Spots
  als eigene Detailseite: grosses Foto, Tabs, Minikarte und Blättern durch die Spots
- Licht & Wald auf der Spot-Seite: Horizont aus dem Höhenmodell, Sonnenbogen und Sonnenstand, Baumarten in ihrer
  Jahreszeit, Wetter der Stunde (Wolken, Regen, Schneefall, Schneedecke, Glätte), im Stil der Startseite
- Wetter am Spot: Niederschlagsradar der MeteoSchweiz für die ganze Schweiz (sonst DWD) als Film der letzten zwei
  Stunden, Vorhersage für 24 Stunden und sieben Tage; das Radar der MeteoSchweiz auch über der grossen Karte
  (*Sonne & Wetter*, folgt der Uhrzeit über die letzten 24 Stunden)
- Durchgehen wie Street View: Pfeile entlang der Aufnahme und zu Spots in der Nähe, Blickrichtung bleibt beim Schritt
- Startseite mit wechselnden Landschaften (Wald, Gletscher, Gebirge, Wüste)
- Weiche Übergänge im Durchgehen: zum Weg drehen, Zoom in Gehrichtung mit Überblendung
- Durchgehen entlang der Wege aus OpenStreetMap (Overpass), auch von Mapillary-Bildern aus; Schritte mit Tiefe
  zwischen flachen Fotos (Morph über die gemeinsamen Bildmerkmale) und zwischen Panoramen (Drehung der Kugel), auch
  beim Wechsel der Zeit
- Mapillary-Bilder im Durchgehen und auf der Karte, wo es keine eigenen gibt (über den Server, mit Urheber und Lizenz)

### Landschaften und Gletscher

- Landschaftsprofile Gletscher, Gebirge und Trockengebiet: Umrisse aus Gletscherinventaren pro Jahr, Eis im Spätsommer und
  Schneeschmelze aus Sentinel-2, Archivfotos mit Datum von Hand, Beobachtungen und Auswertung je Landschaft
- Gletscher: Längenänderung der Zunge aus den GLAMOS-Messreihen, Archivbilder aus offenen Sammlungen als Vorschlag
  am passenden Standort (Übernahme nur mit passender Lizenz); im Trockengebiet Ausrichtung am Horizont

### Wetter, Klima und Satellit

- Klima im Wandel: Käfergenerationen pro Jahr in der Zeitachse neben den Spots mit Borkenkäfer-Befall; Klima-Analoga
  («wo ist es heute so warm wie hier bei +2 °C?») aus den berechneten Zellen der Klimakarte
- Sturmereignisse aus Böen mit Windwurf-Funden verknüpfen
- Sturmwarnung aus der Böenprognose (ICON, einstellbar) per Push, nach dem Sturm die Bitte um ein Foto, wenn er wirklich kam
- DWD-Phänologie als Referenz für den Beginn der Herbstfärbung
- Phänologie von MeteoSchweiz direkt (OGD), Laubaustrieb aus Jahres- und Sofortmeldern; Spätfrost zählt erst nach dem
  Austrieb der Region
- Nächtliche Abkühlung in Senken aus Wind und Bewölkung
- Satellitenkontext: NDMI, Frühwarnung ohne neue Fotos, Landsat vor 2017, Sturm als Kontext
- Kalibrierung der Frühwarnung und der Rückgänge zwischen Fotos an bestätigten Schäden, geprüft mit
  Kreuzvalidierung nach Spots, getrennt für Laub- und Nadelwald
- Frühwarnung als Push-Nachricht an Leute, die den Spot regelmässig besuchen oder ihm folgen
- Angleichung von Landsat an Sentinel-2 aus den Überlappungsjahren
- Licht und Schatten auf der Karte: Geländeschatten zur gewählten Zeit, auch von fernen Bergen bei tiefer Sonne,
  mit weichem Halbschatten; von Bäumen und Gebäuden (Schweiz: swissSURFACE3D − swissALTI3D, sonst Baumkronen aus
  Metas Kronenhöhenkarte und Gebäude aus OpenStreetMap); steil
  besonnte Hänge, Tag, Nacht und Dämmerung; Niederschlagsradar und Warnungen des DWD einblendbar; gerechnet in
  einem Web Worker, damit die Karte beim Abspielen flüssig bleibt

- Klima im Wandel: Klimastreifen und Kennzahlen seit 1940 (ERA5) am Ort, homogene Messreihen der MeteoSchweiz seit
  1864, Zeitachse mit den Beobachtungen der Spots, Synthese, Ausblick bis 2050 aus Klimamodellen (CMIP6 HighResMIP),
  Import der Klimaszenarien CH2025
- Klima im Wandel: drei Szenarien (+1,5, +2, +3 °C, CH2025 oder Pattern Scaling), was sie für den Wald bedeuten
  (Höhenstufen, Fichte und Borkenkäfer, Trockenheit, Winter, Chancen), Klima-Raster auf der Karte und offizielle
  Karten von geo.admin.ch; in Genf Wärmeinsel und Kronendach des SITG und ein Verweis auf Genève 3D
- Baumart-Vorschläge aus dem Bauminventar des Kantons Genf (Arten im Umkreis von 40 m, mit einem Klick übernehmen)

### Arten und geschützte Funde

- Schutzlisten je Kanton laden (Kanton des Spots über geo.admin.ch); PRO-Verifizierung auf ein Jahr befristet,
  mit Erinnerung und Verlängerung
- Organisationen mit mehreren Mitgliedern: die verifizierte Leitung nimmt Kolleginnen und Kollegen auf, auch per
  Einladung an eine E-Mail-Adresse ohne Konto
- Hotspot-Karten, Ausbreitungsfronten und Datei-Export zu Info Flora / iNaturalist
- Bestimmungen von Fachleuten prüfen lassen (bestätigen, korrigieren, ablehnen), Export nur geprüfter Funde, Hotspots
  pro 100 Fotos gegen ungleichen Suchaufwand

### Touren und Routing

- Sonne und Schatten unterwegs: Tempo nach Steigung (Wanderfunktion nach Tobler) mit den Höhen des Geländes
- Eigener Routing-Server: Waldprofil (Forststrassen und Rückegassen zuerst), Wildruhezonen in der Schutzzeit
  umgehen, BRouter-Image per GitHub-Workflow in der Registry
- Wildruhezonen direkt von geo.admin.ch, pro Feld gespeichert und wöchentlich neu angefragt
- Sperrungen bei Holzerei: automatisch aus Holzschlag-Fotos, von Hand durch den Forstdienst; der Wege-Magnet
  führt darum herum
- Touren: FIT-Dateien direkt lesen, mit Sensorwerten und Developer-Feldern (z. B. Laufleistung), auch aus GPX
  und TCX; Höhenprofil der Route, wahlweise mit Puls, Leistung oder Temperatur entlang der Strecke; Karte kühler
  Abschnitte aus den geteilten Temperaturen vieler Touren, geeicht am Wettermodell und getrennt nach Jahres- und
  Tageszeit; Push-Nachricht bei erledigtem Fotoauftrag, Ablaufdatum für Aufträge

### Geodienste und Betrieb

- Karte wie map.geo.admin.ch: Links mit `layers=…` in beiden Richtungen, Suche über alle Ebenen von geo.admin.ch,
  Ebenen ein/aus, Reihenfolge und Jahr; Koordinaten-Popup (LV95, LV03, WGS 84, UTM, MGRS, Höhe); Messen von
  Strecke, Richtung und Fläche; Koordinatensuche in allen diesen Formaten
- Weitere Karten wie map.geo.admin.ch: andere WMS/WMTS aus einer Liste oder über die Adresse, KML, GPX und GeoJSON als
  Ebene, Vergleich mit Regler für jede Ebene, Kurzlink mit QR-Code
- GeoParquet für grosse Dateien: Zeilen nach Ort sortiert (Hilbert-Kurve) in Zeilengruppen, Spalte `bbox` als
  *covering* mit Minimum und Maximum pro Zeilengruppe
- Doku-Website (Projekt-Wiki) aus `docs/*.md` mit Suche und *Seite bearbeiten*, über GitHub Pages, eigene Domain
  vorbereitet
- PMTiles/MBTiles Kachel für Kachel geschrieben (auch sehr grosse Datenmengen), LV95-Kacheln als GeoPackage mit eigenem
  Kachelgitter
- Geodienste: OGC API – Features und Tiles (auch im LV95-Kachelgitter, vorberechnet, PMTiles/MBTiles),
  Vektorkarten, QGIS Server, Metadaten für geocat.ch (GM03)
- Metadaten pro Collection (Teil des Datensatzes) und Objektkatalog nach ISO 19110
- Cloud-native ohne Server: GeoParquet pro Collection (WGS84 und LV95), STAC-Katalog unter `/stac` und als
  statischer Ordner für einen Objektspeicher (`npm run stac`)
- Betrieb mit Docker Compose und Kubernetes (podman-Startskript)
- Render mit eigenem Routing-Server (BRouter) und Kartenserver (QGIS Server unter `/ows/`) als private Dienste,
  Wildruhezonen und Wegnetz eingeschaltet

### App und Konten

- Android-App: die Web-App in einer schlanken Hülle, Fahrtmodus und Tour-Aufzeichnung laufen im Hintergrund
  weiter (Dienst im Vordergrund mit GPS und Kamera, Auswahl der Fahrtbilder auf dem Gerät mit denselben
  Testfällen wie im Browser); APK per GitHub-Workflow
- Konten: Anmelden mit Google und GitHub, E-Mail bestätigen, Passwort zurücksetzen und ändern, Konto löschen, Profilseite mit eigenen Fotos, Anzeigename und E-Mail-Adresse ändern, Export der eigenen Daten, Microsoft, SWITCH edu-ID, AGOV und weitere OpenID-Connect-Dienste, dauerhafte Rate-Limits, auch hinter einem Reverse Proxy (`TRUST_PROXY`)

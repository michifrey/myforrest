# Funktionen im Detail

Diese Seite beschreibt alle Funktionen des Prototyps ausführlich, inklusive der verwendeten Verfahren.
Einen kürzeren Überblick mit Screenshots gibt das [README](../README.md).

**Inhalt**

- [Fotos erfassen und verorten](#fotos-erfassen-und-verorten)
- [Spots und Zeitreise](#spots-und-zeitreise)
- [Bildanalyse](#bildanalyse)
- [Wetter, Klima und Gelände](#wetter-klima-und-gelände)
- [Kartenmodi](#kartenmodi)
- [Pflanzen und Baumarten](#pflanzen-und-baumarten)
- [Konten, Moderation und Lizenzen](#konten-moderation-und-lizenzen)

## Fotos erfassen und verorten

### Drei Wege, Fotos zu verorten

1. **GPS aus dem Foto** (EXIF), wie bei normalen Handyfotos.
2. **Automatisch über einen GPX-Track**: Eine Action-Cam im Intervallmodus (z. B. alle 5 s) beim
   Laufen oder Biken, dazu der GPX-Export von Uhr, Strava oder Komoot. Jedes Foto wird über seine
   Aufnahmezeit auf der Strecke verortet. Zeitzone und Abweichung der Kamera-Uhr lassen sich
   korrigieren.
3. **Manuell**: Standort auf der Karte anklicken oder den aktuellen Standort verwenden.

### Wiederholungsfotos mit Overlay

Am Spot öffnet *Wiederholungsfoto aufnehmen* die Kamera. Das
gewählte Referenzfoto liegt halbtransparent oder als Kontur über dem Livebild, sodass sich Ausschnitt
und Standort genau treffen lassen. Angezeigt werden auch die Entfernung zum Spot und, falls nötig,
ein Hinweis, das Handy zu drehen. Das Foto wird im Format der Referenz gespeichert, fest diesem
Spot zugeordnet und direkt im Vorher/Nachher-Vergleich geöffnet.

### Videos statt Einzelbilder

*Foto beitragen* nimmt auch Videos an, z. B. von einer GoPro oder ein
360°-Video. Entlang der Strecke wird etwa alle 25 m (Spot-Radius, einstellbar) ein Bild aus dem Video
gezogen, und jedes Bild läuft wie ein normales Foto durch Spot-Zuordnung, Ausrichtung und
Veränderungserkennung. Kommt die Strecke an einem bestehenden Spot vorbei, wird das Bild an der
nächstgelegenen Stelle gezogen. So füllt jede Runde dieselben Spots weiter.

- **GoPro-Telemetrie (GPMF)**: Die GPS-Spur (GPS5 bzw. GPS9 ab HERO11, mit GPSU-Zeit, SCAL-Skalierung
  sowie Fix und Genauigkeit) wird direkt aus der MP4-Datei gelesen, ohne Zusatzprogramm. Daraus ergeben
  sich Position, UTC-Aufnahmezeit, Höhe und Blickrichtung (Fahrtrichtung) jedes Bildes.
- **Ohne Telemetrie** wird das Video über einen mitgeschickten GPX-Track verortet; die Startzeit kommt
  aus dem Video-Header (UTC) oder dem Datumsfeld und lässt sich mit *Kamera-Uhr korrigieren* verschieben.
  Mit einem auf der Karte gewählten Standort wird stattdessen alle N Sekunden ein Bild gezogen.
- **360° wie Street View**: Videos im Seitenverhältnis 2:1 (equirektangulär) oder mit Spherical-Video-
  Metadaten liefern Panoramen. Diese erscheinen im Spot als drehbare 360°-Ansicht (ziehen, Mausrad oder
  Pinch zum Zoomen, Pfeiltasten, Vollbild) mit Himmelsrichtung des Blicks; *Flach* zeigt das ganze Panorama.
- Insta360-Rohdateien (`.insv`, zwei ungestitchte Fischaugen) und GoPro-MAX-Rohdateien (`.360`) werden
  nicht direkt verarbeitet: Sie müssen zuerst in Insta360 Studio bzw. GoPro Player als 360°-MP4
  exportiert werden. Deren GPS steckt nicht im Export, daher den GPX-Track mitschicken.
- Die Bilder zieht das Systemprogramm `ffmpeg` (Pfad über `FFMPEG_PATH`). Fehlt es, meldet die App das
  beim Upload. Fortschritt (Hochladen, Bilder extrahieren) und Ergebnis (Bilder, Strecke, Spots) werden
  im Upload-Dialog angezeigt.

### HEIC-Fotos vom iPhone

`.heic`/`.heif` werden angenommen und als JPEG gespeichert. Die Umwandlung
macht der WebAssembly-Decoder von `heic-convert`, weil sharp HEIC meist nicht lesen kann. Aufnahmezeit,
GPS, Höhe und Blickrichtung werden vorher aus dem EXIF-Block der Originaldatei gelesen. Das gespeicherte
JPEG enthält keine EXIF-Daten.

### Vorschaubilder

Beim Upload entstehen zwei WebP-Vorschaubilder (320 px für Leiste, Listen und
Karten-Tooltip, 1280 px für Betrachter, Vergleich und Kamera-Overlay), richtig gedreht und im
Seitenverhältnis des Originals. Die Ausrichtungen gelten deshalb unverändert. Für ältere Fotos werden
die Vorschaubilder beim Start im Hintergrund nachgerechnet. Bis dahin zeigt die App das Original.
Analyse und Ausrichtung arbeiten weiter mit dem Original.

### Beobachtungen taggen

Sturmschaden/Windwurf, Borkenkäfer, Trockenschaden, Totholz,
Holzschlag, Verjüngung, Neophyt, Weg/Erosion, dazu eine Notiz. Die Karte lässt sich danach filtern.

### Installierbare App mit Offline-Upload

MyForrest lässt sich als App auf den Startbildschirm legen
(dezenter Knopf *App installieren* in der Navigation; auf iPhone/iPad erklärt er den Weg über
*Teilen → Zum Home-Bildschirm*). Ein Service Worker hält die App-Oberfläche, Leaflet und die Schriften
vor, sodass die App auch ohne Netz startet. Zuletzt geladene Spots, Fotos und Kartenkacheln bleiben
offline sichtbar (Kacheln bis ca. 800, Fotos bis 400, jeweils die ältesten werden verdrängt).
Wer im Wald ohne Empfang fotografiert, verliert nichts: Uploads und Wiederholungsfotos ohne Verbindung
landen samt Fotos, GPX und Angaben in einer Warteschlange auf dem Gerät (IndexedDB). In der Navigation
steht dann z. B. „3 Fotos warten auf Verbindung“; ein Klick zeigt die wartenden Uploads, die sich
einzeln oder alle verwerfen lassen. Sobald wieder Netz da ist, werden sie automatisch gesendet: per
Background Sync auch bei geschlossener App (Chrome/Android), sonst beim nächsten Öffnen oder sobald
das Gerät wieder online ist. Auf dem Handy nimmt *Mit Kamera aufnehmen* im Upload-Dialog direkt ein Foto
auf und setzt den aktuellen Standort, falls das Foto kein GPS hat. Ohne Service Worker (z. B. über
http auf einer fremden IP) funktioniert die App wie bisher, nur ohne Offline-Modus.

## Spots und Zeitreise

### Karte mit Spots

Fotos, die innerhalb von 25 m aufgenommen wurden, werden automatisch zu
einem *Spot* zusammengefasst. Die Farbe zeigt Schäden (orange) oder Neophyten (violett).

### Blickrichtung

Spots werden zusätzlich nach Himmelsrichtung getrennt. Die Richtung stammt aus dem
Kompass des Handys (EXIF `GPSImgDirection`). Regel für neue Fotos:

- Foto **mit** Blickrichtung: Es kommt zum nächsten Spot im Umkreis von 25 m, dessen Richtung höchstens
  ±45° abweicht. Gibt es keinen, kommt es zum nächsten Spot ohne Richtung (ältere Spots oder Fotos ohne
  Kompass), der damit eine Richtung erhält. Sonst entsteht ein neuer Spot. Dieselbe Lichtung nach Norden
  und nach Süden fotografiert ergibt also zwei Spots.
- Foto **ohne** Blickrichtung: wie bisher der nächste Spot im Umkreis, egal in welche Richtung er blickt.
- Wiederholungsfotos bleiben immer fest dem gewählten Spot zugeordnet.

Die Richtung eines Spots ist das zirkuläre Mittel seiner Fotos (350° und 10° ergeben 0°). Blicken die
Fotos eines Spots in sehr verschiedene Richtungen, hat der Spot keine Richtung. Bestehende Spots werden
beim Start nur um ihre Richtung ergänzt und nie aufgeteilt. Auf der Karte zeigt ein goldener Sichtkegel
die Richtung. Liegen mehrere Spots am selben Ort, rücken ihre Marker in Blickrichtung auseinander, damit
jeder anklickbar bleibt. Im Kopf des Spots stehen die Richtung („Blick nach NO (45°)“) und Links zu den
anderen Spots am selben Ort.

### Zeitreise pro Spot

Mit dem Zeitregler und der Thumbnail-Leiste durch alle Aufnahmen blättern.

### Vorher/Nachher-Vergleich

Zwei beliebige Aufnahmen mit einem Wischregler überlagern.

## Bildanalyse

### Automatische Feinausrichtung

Fotos eines Spots werden per Bildregistrierung aufeinander
ausgerichtet (Merkmalspunkte + RANSAC-Homographie). Im Vorher/Nachher-Vergleich liegen beide Bilder
dann deckungsgleich übereinander, und mit *Stabilisiert* wirkt das Durchblättern der Zeitleiste
wie ein Zeitraffer. Die Originalfotos bleiben unverändert, gespeichert wird nur die Transformation.
Fotos aus einem ganz anderen Blickwinkel werden erkannt und bleiben unausgerichtet.

### Veränderungs-Heatmap

Auf zwei ausgerichteten Fotos markiert eine Heatmap, wo sich etwas verändert
hat (gelb → rot), und nennt den Anteil der veränderten Fläche. Erkannt werden neue oder verschwundene
Strukturen (umgestürzte Bäume, Lichtungen, Bewuchs) sowie Farbwechsel wie grün → braun. Unterschiedliches
Licht und kleine Restverschiebungen werden ausgeglichen. Im Kopf jedes Spots steht zudem, wie viel sich
seit dem ersten Foto verändert hat.

### Einordnung der Veränderungen

Veränderte Regionen werden automatisch eingeordnet als
*Windwurf / liegende Stämme*, *Auflichtung / Holzschlag*, *Verfärbung (grün → gelb/braun)*,
*neuer Bewuchs* oder *sonstige Veränderung*. Grundlage sind Grünanteil, Helligkeit, Textur,
Kantenrichtung und Form. Im Vergleich erscheinen sie als beschriftete Rahmen und lassen sich mit
einem Klick als Beobachtung (Tag) übernehmen. Auf der Karte erscheinen Spots mit starker Veränderung
im Tooltip, und es gibt einen Filter dafür.

### Einordnung lernt aus Bestätigungen

Im Vorher/Nachher-Vergleich lässt sich jede Region mit *Stimmt*
bestätigen oder einer anderen Klasse zuordnen. Diese Bestätigungen, übernommene Beobachtungen (ein Foto mit
dem Tag *Sturmschaden* bestätigt die als *Windwurf* vorgeschlagene Region) und bestätigte Objekterkennungen
werden zu Trainingsbeispielen. Daraus lernt die App im Hintergrund ein kleines Modell (multinomiale
logistische Regression auf denselben Merkmalen wie die Regeln, in reinem JavaScript, Gewichte in der
Datenbank). Sobald mindestens zwei Klassen je 5 Beispiele haben, wird es mit den Regeln gemischt; sein
Gewicht wächst mit der Zahl der Beispiele (höchstens 85 %). Jede Region zeigt, wer entschieden hat
(„Regel“, „gelernt aus 42 bestätigten Beispielen“ oder beides), mit welcher Sicherheit und was die Regel
allein gesagt hätte. Die Kreuzvalidierung des Modells wird mit angezeigt. Klassen mit zu wenigen
Beispielen entscheiden weiter die Regeln.

### Nadel-/Laubholzanteil und Arten im Bild (Heuristik)

Für jedes Foto und jede veränderte Region
schätzt die App den Anteil von Nadel- und Laubholz aus Farbe und Textur der Vegetation. Nadeln sind
dunkler, bläulicher und feinkörniger, Laub ist heller, gelbgrüner und gröber. Ein kleines Raster zeigt die
Verteilung im Bild. Eine Verfärbung wird anhand des Anteils *vor* der Verfärbung und des Artenbestands am
Spot der plausibelsten Art zugeordnet, also „Verfärbung vermutlich Rotbuche (79 %)“. Dabei zählt auch,
ob die Art zu diesem Datum schon färben dürfte. Die Auffälligkeiten nutzen das: Bei einer Fichte im
Mischbestand wird aus dem Hinweis eine Warnung (Borkenkäfer). Bei einer Lärche gilt deren eigener
Färbebeginn statt dem der am frühesten färbenden Art am Spot. Verfärbte immergrüne Nadeln gelten nicht als
„frühe Laubverfärbung“. Das ist ein Richtwert und keine Artbestimmung: Licht, Weissabgleich, Abstand und
Jahreszeit verschieben die Merkmale.

### Objekterkennung (experimentell)

Jedes Foto wird nach liegenden Stämmen und Holzpoltern durchsucht.
Die Treffer erscheinen als Rahmen im Foto, auch stabilisiert, und lassen sich mit *Stimmt* oder *Falsch*
bewerten. Ein bestätigter Treffer kann als Beobachtung übernommen werden und ist ein Trainingsbeispiel für
die Region, die er überdeckt. Eingebaut sind zwei Heuristiken:

- **Liegende Stämme**: Eine Hough-Transformation sucht lange, gerade, fast waagrechte Kanten (±25°). Zwei
  parallele Kanten mit entgegengesetztem Kontrast, eine Stammbreite auseinander und mit rindenartiger
  Fläche dazwischen (nicht grün, wenig gesättigt) ergeben einen Stamm.
- **Holzpolter**: viele ähnlich grosse, runde, hellbraune Flecken (Schnittflächen) dicht beieinander.

Wurzelteller, Totholz allgemein und Rückegassen erkennen die Heuristiken nicht. Dafür gibt es eine
Schnittstelle für einen externen Detektor (z. B. ein feinjustiertes YOLO-Modell, siehe
[Externer Detektor](installation.md#externer-detektor)).

### Vegetationsdichte

Für jedes Foto schätzt die App aus den Bildfarben den **Grünanteil** (Laub und Nadeln
über den Excess-Green-Index der chromatischen Koordinaten, unabhängig von der Belichtung), die
**Kronendach-Deckung** (Anteil der oberen Bildhälfte ohne sichtbaren Himmel; Himmel = hell und blau oder
fast weiss), den **Lückenanteil** (Himmel im ganzen Bild) und den Grünwert GCC. Ausgerichtete Fotos werden
dafür in den gemeinsamen Bildausschnitt des Spots gelegt, so dass die Werte aller Fotos dieselbe Szene
beschreiben. Die Berechnung läuft nach dem Upload im Hintergrund, bestehende Fotos werden beim Start
nachgerechnet, nach einer neuen Ausrichtung automatisch neu. In der Spot-Ansicht stehen die Werte als
Zeitreihen (kleine Mehrfachdiagramme mit Tooltip; ein Klick springt zum Foto).

## Wetter, Klima und Gelände

### Wetter-Kontext und Auffälligkeiten

Zu jedem Foto werden die Wetterdaten am Standort geladen
(Open-Meteo, ERA5): Niederschlag, Temperatur, Hitzetage und längste Trockenphase der 90 Tage vor
der Aufnahme sowie der Niederschlag der letzten 12 Monate, jeweils gegenüber dem Mittel 1991–2020.
Daraus werden Auffälligkeiten abgeleitet und am Foto festgehalten: Trockenheit, Wärme, Nässe und vor
allem **frühe Laubverfärbung** mit vermuteter Ursache. Ein Beispiel: Laub verfärbt sich im August
bei 20 % des üblichen Niederschlags, das deutet auf Trockenstress hin. Bei unauffälligem Wetter
verweist der Text auf andere Ursachen wie Schädlinge. Jeder Spot hat eine Auffälligkeiten-Chronik
über die Jahre, und auf der Karte sind betroffene Spots mit „!“ markiert.

### Höhenlage

Jeder Spot erhält seine Höhe über Meer. Sie kommt aus dem Copernicus-Höhenmodell (über
Open-Meteo), ersatzweise aus der GPS-Höhe der Fotos, oder wird von Hand eingetragen. Pro 100 m über dem
Flachland (~400 m) beginnt die Herbstfärbung rund 2,5 Tage früher; die Bewertung „frühe Verfärbung“ und die
Steckbriefe rechnen damit. Bei Rotbuche auf 1000 m ist das etwa der 15. statt der 30. September.
Auch die Wetterdaten werden auf die Höhe des Spots heruntergerechnet.

### Exposition

Aus dem Höhenmodell (3×3 Messpunkte im Abstand von 90 m, Verfahren nach Horn) werden
Hangneigung und -richtung des Spots berechnet; von Hand lässt sich die Exposition ebenfalls setzen. Ein
steiler Südhang ist wärmer und färbt sich einige Tage später, ein Nordhang früher (bis ±4 Tage, gewichtet
mit der Steilheit). An Südhängen weist der Trockenheitstext zudem darauf hin, dass der Boden schneller
austrocknet.

### Kaltluftseen

Mit dem Topographischen Positionsindex (wie tief liegt der Spot unter dem Mittel seiner
Umgebung in 300 m und 600 m Umkreis) erkennt die App Senken und Talböden, in denen sich nachts Kaltluft
sammelt, sowie Kuppen und Rücken. In Senken beginnt die Herbstfärbung bis zu 5 Tage früher. Zeigt das
Wettermodell nach dem Laubaustrieb Nächte unter 3 °C, wird Spätfrost-Gefahr gemeldet (genauer: siehe
*Nächtliche Abkühlung*). Braune junge Blätter im Frühsommer gelten dann als **Frostschaden** (neuer Tag) statt als frühe Herbstfärbung.
Auf Kuppen gibt es bei Windwurf einen Hinweis auf die exponierte Lage. Die Geländeform lässt sich auch
von Hand setzen.

### Nächtliche Abkühlung in Senken

Statt der festen 3-°C-Schwelle schätzt die App für jede Nacht nach dem
Laubaustrieb, wie stark sich die Senke abkühlt. Grundlage sind die stündlichen Werte von Wind (10 m) und
Bewölkung aus dem Wettermodell: Windstille (≤ 1,5 m/s) und klarer Himmel (≤ 20 % Bewölkung) ergeben volle
Ausstrahlung, ab 5 m/s Wind oder 80 % Bewölkung keine. Multipliziert mit der Ausprägung der Senke (aus dem
Positionsindex) liegt das Minimum in der Senke bis zu 7 °C unter dem Modellwert. Nur Nächte, die so
geschätzt unter 0 °C fallen, zählen als Spätfrost. Im Kontext des Fotos stehen diese Frostnächte mit
Modellminimum, geschätztem Minimum in der Senke, Wind und Bewölkung. Fehlen Stundenwerte, gilt die alte
3-°C-Regel.

### Sturmereignisse

Für jeden Spot lädt die App die täglichen Spitzenböen und die vorherrschende
Windrichtung (Open-Meteo, ERA5; die letzten Tage aus der Prognose-API). Ein Tag mit Böen ab 75 km/h gilt als
Sturm, aufeinanderfolgende Sturmtage bilden ein Ereignis. Die Stärke folgt der Beaufort-Skala der
DWD-Warnungen (Sturmböen Bft 9, schwere Sturmböen 10, orkanartige Böen 11, Orkanböen 12).

- Zeigt ein Foto Windwurf (eingeordnete Region oder Tag *Sturmschaden*), sucht die App den stärksten Sturm
  seit dem letzten Foto ohne Windwurf und nennt ihn: „vermutlich Sturm am 12.03.2026, Böen 104 km/h aus
  WSW“, samt der Richtung, in die die Bäume vermutlich gefallen sind. Findet sich kein Sturm, weist sie auf
  andere Ursachen hin (Holzschlag, Schneebruch, lokale Gewitterböen).
- Ohne Windwurf erscheint ein Sturm seit dem letzten Besuch als Hinweis, auf Schäden zu achten.
- Stürme stehen in der Chronik des Spots, im Vorher/Nachher-Vergleich bei Windwurf, und auf der Karte
  tragen betroffene Spots ein Wind-Abzeichen; der Filter *Von Sturm betroffen* zeigt nur diese.

ERA5 rechnet auf einem Raster von rund 25 km und glättet Böenspitzen; die Werte sind eher eine untere Grenze.

### Phänologie-Referenzdaten

Statt pauschaler Gradienten kann die App den Beginn der Herbstfärbung aus
regionalen Beobachtungsreihen nehmen. Unterstützt sind die Jahresmelder-Daten des DWD (Phase
*Blattverfärbung* für Rotbuche, Stiel- und Traubeneiche, Hänge-Birke, Rosskastanie, Eberesche, Linden,
Ahorne und weitere) und ein einfaches CSV-Format für andere Quellen wie MeteoSchweiz. Für einen Spot zählen
die Stationen im Umkreis von 60 km (100 m Höhenunterschied wiegen wie 10 km Distanz) mit mindestens fünf
Jahren in den letzten zehn abgeschlossenen Jahren. Bis zu drei Stationen werden gewichtet gemittelt und mit
2,5 Tagen pro 100 m auf die Höhe des Spots umgerechnet. Exposition und Kaltluft kommen wie bisher dazu.
Die Quelle steht im Steckbrief und im Text der Auffälligkeit, z. B. „Referenz: DWD-Station Hinterzarten,
12 km, 880 m, Mittel 2016–2025 (+2 weitere)“. Ohne passende Station gelten die Gradienten.

### Satellitenkontext (Sentinel-2-NDVI)

Zu jedem Spot lädt die App ohne API-Key eine NDVI-Zeitreihe aus
Sentinel-2 L2A (Copernicus, über die offene STAC-API von Earth Search). Gelesen werden nur die wenigen
Bytes um den Spot (HTTP-Range-Requests auf die Cloud-Optimized GeoTIFFs von Rot B04, Nahinfrarot B08 und
der Szenenklassifikation SCL). Wolken, Schatten und Schnee werden pixelweise ausgeblendet, gemittelt wird
ein Fenster von rund 30 × 30 m (3 × 3 Pixel à 10 m), pro Monat der Median der wolkenfreien Szenen. Die
Werte werden gecacht und wöchentlich ergänzt. Fällt der NDVI zwischen zwei Fotodaten deutlich (≥ 0,1
gegenüber derselben Jahreszeit vor dem ersten Foto), erscheint ein Hinweis, zusammen mit dem, was die
Fotos zeigen (*Windwurf*, *Auflichtung* oder passende Beobachtungen), als unabhängige Bestätigung. Wegen
der 10-m-Pixel umfasst der Satellitenwert mehr als den Bildausschnitt. Ohne Internetzugang bleibt der
Bereich leer und wird später erneut versucht.

## Kartenmodi

### Sonne & Wetter auf der Karte

Ein eigener Kartenmodus zeigt für den gewählten Spot (oder die Kartenmitte)
und ein beliebiges Datum in Vergangenheit oder Zukunft:

- Sonnenbahn, Auf- und Untergangsrichtung, Sonnenstand zur gewählten Uhrzeit und den Schatten eines
  25-m-Baums auf der Karte;
- Sonnenhöhe, Richtung, Tageslänge und die Einstrahlung bei klarem Himmel, auf ebenem Boden und auf dem
  Hang des Spots (Neigung und Exposition), samt Tagessumme in kWh/m²;
- für vergangene Tage die gemessene Einstrahlung und den Regen pro Stunde (ERA5), für die nächsten
  ~16 Tage die Prognose; die Tagesregenmenge erscheint an jedem Spot auf der Karte.

Der Tagesverlauf lässt sich mit dem Schieberegler, im Diagramm oder per Abspielen durchgehen. Der
Sonnenstand wird lokal berechnet (NOAA-Algorithmus) und funktioniert für jedes Datum.

### Horizontabschattung

Der Geländehorizont (Copernicus-Höhenmodell über Open-Meteo, 36 Richtungen,
12 Distanzen von 120 m bis 20 km, mit Erdkrümmung und Refraktion) blockiert die direkte Sonne hinter
Hügeln und Bergen. Der Anteil des offenen Himmels (Himmelssicht) dämpft das diffuse Licht. Im Kartenmodus
zeigt das Sonnenbahn-Diagramm die Geländesilhouette, die Bahn ist hinter dem Gelände gestrichelt, und
Auf- und Untergang werden zu „Sonne ab / Sonne bis“ über dem Grat. Das Panel nennt die Sonnenstunden
samt Verlust durch das Gelände, die Einstrahlung mit und ohne Gelände, den höchsten Grat und markiert im
Diagramm die Zeiten, in denen die Sonne hinter dem Gelände steht. Bäume und Gebäude kennt das
Höhenmodell nicht.

### Arten & Neophyten auf der Karte

Der Kartenmodus *Arten & Neophyten* wertet die Pl@ntNet-Bestimmungen
als **Funde** aus (pro Foto die wahrscheinlichste Art, ab einem wählbaren Mindest-Score, Standard 0,2).

- **Hotspots**: Eine Kerndichte-Karte (Gauss-Kern, Radius 30–1000 m einstellbar) zeigt, wo sich Funde aller
  Neophyten, aller Arten oder einer gewählten Art häufen, mit Legende in Funden pro km². Die Spot-Marker
  weichen solange den einzelnen Funden; ein Klick auf einen Fund öffnet sein Foto.
- **Ausbreitungsfronten**: Pro Art die besiedelte Fläche Jahr für Jahr als ineinanderliegende Umrisse
  (Alpha-Shape aller Funde bis zu diesem Jahr, jeder Fund um 25 m gepuffert), eingefärbt nach Jahr, mit
  Zeitregler und Abspielen. Die Alpha-Shape folgt dem tatsächlichen Bestand: Sie zerfällt in
  **Teilbestände**, wo Funde mehr als 2α auseinanderliegen, und lässt fundfreie Flächen breiter als 2α als
  Lücken offen. α ergibt sich automatisch aus den Abständen der Funde (2,5-mal der Abstand, innerhalb dessen
  90 % der Funde einen Nachbarn haben), lässt sich aber auch fest wählen (50 m bis 1 km) oder auf die
  konvexe Hülle umstellen. Fläche und Anzahl Teilbestände stehen pro Jahr in der Tabelle. Technisch ist es
  die α-Hülle als morphologisches Schliessen auf einem Raster (Dilatation um α, Erosion um α − Puffer, mit
  exakten Distanztransformationen), umrandet per Marching Squares.
- **Ausbreitung pro Teilbestand**: Teilbestände werden Jahr für Jahr verfolgt. Weil die Umrisse der Jahre
  ineinanderliegen, führt jeder Teilbestand entweder einen des Vorjahrs fort, ist neu oder entsteht aus
  mehreren, die zusammengewachsen sind; dann behält der älteste seine Nummer, die anderen enden dort
  („2025 mit Teilbestand 1 zusammengewachsen“). Jeder Teilbestand bekommt seine eigene Geschichte:
  seit wann es ihn gibt, Fläche und Frontabstand pro Jahr, Flächenzuwachs pro Jahr und eine eigene Rate
  mit Richtung (gleiche Methode wie für die ganze Art, aber ab seinem ersten Fund und mit dessen Schwerpunkt
  als Ursprung; gezählt werden nur seine eigenen Funde, nicht die der aufgenommenen Teilbestände). Ein
  später entstandener Teilbestand nennt den **Sprung**: den Abstand und die Richtung zum
  nächsten älteren Fund, z. B. „Sprung: 945 m nach NO von Teilbestand 1“ – typisch für Samen, die mit
  Wasser, Erde oder Maschinen verschleppt wurden. Die Liste im Panel hebt den Teilbestand beim Überfahren
  auf der Karte hervor und zoomt per Klick hin; Nummer und Umriss folgen dem gewählten Jahr, und
  Teilbestände, die es da noch nicht oder nicht mehr eigenständig gibt, sind abgeblendet. Dazu eine Schätzung wie „Ausbreitung ~120 m/Jahr nach NO“: Die Rate ist die
  Steigung (kleinste Quadrate) des Abstands vom Schwerpunkt der Erstfunde zum jeweils entferntesten Fund,
  die Richtung das gewichtete Mittel der Funde, die die Front nach aussen geschoben haben. Zeigen diese in
  alle Richtungen, steht „in alle Richtungen“. Die Schätzung hängt stark davon ab, wo gesucht wurde, und ist
  als Hinweis gedacht, nicht als Messung.
- **Export zu Info Flora, GBIF und iNaturalist**: Funde lassen sich als **Darwin-Core-CSV** (das
  Austauschformat von GBIF und Info Flora: `scientificName`, `eventDate`, `decimalLatitude/Longitude`,
  `coordinateUncertaintyInMeters` je nach Verortung, `basisOfRecord=HumanObservation`, Pl@ntNet-Score in
  `identificationRemarks`, Foto-URL in `associatedMedia`, Lizenz pro Foto, sobald es dafür eine Spalte gibt)
  und im **CSV-Importformat von iNaturalist** herunterladen. Filter: Art, nur Neophyten, Mindest-Score,
  Kartenausschnitt, Zeitraum. Direkt zu iNaturalist oder Info Flora hochladen geht nicht, dafür bräuchte es dort
  ein Konto und eine OAuth-Anmeldung. iNaturalist übernimmt beim CSV-Import keine Fotos, deshalb steht der
  Foto-Link in der Beschreibung. Alle Bestimmungen sind automatisch und als `unverified` markiert.

## Offene Geodaten für GIS und Geoportale

MyForrest ist selbst ein Geodienst nach **OGC API – Features** (`/ogc`; Teil 1 Core und GeoJSON, Teil 2
Koordinatensysteme). So lassen sich die Daten wie die Karten von swisstopo in QGIS, ArcGIS oder Geoportale
einbinden.

- **Collections**: `spots` (Orte mit Anzahl Fotos, Zeitraum, Tags, Blickrichtung, Höhe), `photos` (mit Tags,
  Lizenz und Urheber), `findings` (Pflanzenfunde, Neophyten markiert) und `spread_fronts` (besiedelte
  Fläche pro Art und Jahr als Multipolygon mit Lücken).
- **Koordinatensysteme**: WGS84 (CRS84) oder die Schweizer Landeskoordinaten **LV95 (EPSG:2056)**, gewählt
  mit `crs`. Umgerechnet wird mit den Näherungsformeln von swisstopo (Genauigkeit ~1 m, geprüft am
  Referenzpunkt von swisstopo).
- **Filter**: Ausschnitt (`bbox`, auch in LV95 mit `bbox-crs`), Zeit (`datetime`, Zeitpunkt oder Intervall)
  und Seiten (`limit`/`offset` mit `next`-Link).
- **Einbinden**: In QGIS über *Layer → Layer hinzufügen → WFS / OGC API – Features* mit der Adresse
  `https://<server>/ogc`, in GDAL als `OAPIF:https://<server>/ogc`. Die Antworten erlauben CORS, damit
  Webkarten auf anderen Domains sie laden können.
- **GeoPackage**: `/api/export/myforrest.gpkg` liefert alle Collections als eine Datei (LV95, mit
  `?crs=4326` in WGS84), ohne GDAL direkt mit SQLite geschrieben. Die Fusszeile der App verlinkt beides.
- **QGIS Server**: Für WMS, WMTS und WFS mit eigener Gestaltung, wie sie Geoportale wie map.geo.admin.ch
  einbinden, liegt unter [`deploy/qgis-server`](../deploy/qgis-server/README.md) eine Vorlage mit Docker
  Compose: MyForrest, QGIS Server und nginx, dazu ein Dienst, der das GeoPackage alle 15 Minuten neu
  exportiert.

Ausgeblendete (moderierte) Fotos erscheinen in keinem Dienst.

## Pflanzen und Baumarten

### Pflanzenbestimmung (optional)

Mit einem kostenlosen [Pl@ntNet](https://my.plantnet.org)-API-Key
werden Pflanzen auf einem Foto bestimmt. Bekannte invasive Neophyten wie Drüsiges Springkraut,
Japanischer Staudenknöterich, Goldruten oder Götterbaum werden erkannt, und das Foto erhält
automatisch den Tag *Neophyt*.

### Baumarten

Jeder Spot führt einen Artenbestand. Arten kommen automatisch aus der Pl@ntNet-Bestimmung
(Organ wählbar: Blatt/Nadeln, Rinde, ganzer Baum, Blüte, Frucht) oder werden von Hand aus einer
Liste von gut 30 mitteleuropäischen Waldbaumarten gewählt. Zu jeder Art gibt es einen Steckbrief: Nadel/Laub,
typischer Beginn der Herbstfärbung, Trockenheitsempfindlichkeit, worauf zu achten ist. Die Arten machen die
Auffälligkeiten genauer:

- „Frühe Verfärbung“ richtet sich nach der am frühesten färbenden Art am Spot (Birke Mitte September,
  Eiche Mitte Oktober).
- Verfärbte immergrüne Nadelbäume gelten immer als Warnsignal.
- Fichte bei Trockenheit oder Hitze löst eine Borkenkäfer-Warnung mit Prüfhinweisen aus.
- Bei Esche mit Auflichtung oder Verfärbung erscheint ein Hinweis auf das Eschentriebsterben.

## Konten, Moderation und Lizenzen

### Benutzerkonten, Moderation und Lizenz pro Foto

- *Konten*: Registrieren und Anmelden mit E-Mail (oder Name) und Passwort über das Konto-Menü oben rechts.
  Passwörter werden mit scrypt und eigenem Salt pro Konto gespeichert. Die Sitzung liegt in einem
  httpOnly-Cookie (SameSite=Lax, 30 Tage); in der Datenbank steht nur ihr SHA-256-Hash. Fehlversuche beim
  Anmelden werden begrenzt (5 pro Konto und IP, 30 pro IP in 15 Minuten).
- *CSRF-Schutz*: Jede schreibende Anfrage mit Sitzungs-Cookie muss das Token der Sitzung im Header
  `X-CSRF-Token` mitschicken (das Frontend erledigt das automatisch). Einen eigenen Header kann eine fremde
  Seite ohne CORS-Freigabe nicht setzen. Zusätzlich wird ein fremder `Origin` abgewiesen, und Anmeldung
  und Registrierung nehmen nur JSON an.
- *Rollen*: Mitglied, Moderation, Administration. Das erste Konto wird Admin, oder das Konto mit der
  Adresse aus `ADMIN_EMAIL`. Admins vergeben Rollen unter *Konten & Rollen*.
- *Anonym oder mit Konto*: Standardmässig sind Uploads ohne Konto weiterhin möglich. Mit `REQUIRE_LOGIN=1`
  braucht es für Uploads und alle Änderungen ein Konto; Lesen und Melden bleiben offen. Fotos mit Konto
  können nur ihre Urheber bearbeiten und löschen (und die Moderation).
- *Lizenz pro Foto*: Beim Hochladen wählbar: CC BY-SA 4.0 (Standard), CC BY 4.0, CC0, CC BY-NC-SA 4.0 oder
  alle Rechte vorbehalten. Die zuletzt gewählte Lizenz wird zum Standard des Kontos, auch für
  Wiederholungsfotos. Unter jedem Foto stehen Urheber („Anonym“ ohne Konto) und Lizenz mit Link; wer das
  Foto hochgeladen hat, kann die Lizenz dort ändern. Ältere Fotos gelten als CC BY-SA 4.0.
- *Melden und Moderation*: Jede und jeder kann ein Foto melden (z. B. „Personen oder Kennzeichen erkennbar“).
  Die Moderation sieht die Meldungen in einer Warteschlange und kann Fotos ausblenden, wieder einblenden,
  Meldungen verwerfen oder Fotos löschen. Ausgeblendete Fotos verschwinden aus Karte, Spots, Vergleichen und
  `/uploads`, bleiben für die Moderation aber sichtbar (grau markiert). Alle Moderationsschritte landen in
  einem Protokoll.

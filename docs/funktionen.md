# Funktionen im Detail

Diese Seite beschreibt alle Funktionen des Prototyps ausführlich, inklusive der verwendeten Verfahren.
Einen kürzeren Überblick mit Screenshots gibt das [README](../README.md).

**Inhalt**

- [Fotos erfassen und verorten](#fotos-erfassen-und-verorten)
- [Spots und Zeitreise](#spots-und-zeitreise)
- [Bildanalyse](#bildanalyse)
- [Wetter, Klima und Gelände](#wetter-klima-und-gelände)
- [Kartenmodi](#kartenmodi)
- [Touren und Fotoaufträge](#touren-und-fotoaufträge)
- [Pflanzen und Baumarten](#pflanzen-und-baumarten)
- [Geschützte Funde und PRO-Mitglieder](#geschützte-funde-und-pro-mitglieder)
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
  Auch einzelne 360°-Fotos werden erkannt (siehe *360°-Panoramen* unten).
- **Unscharfe Bilder**: Pro Stelle misst die App die Schärfe des Bildes (Varianz des Laplace-Filters).
  Liegt sie unter dem Median der bisherigen Bilder des Videos, probiert sie die Bilder 0,25 s davor und
  danach und nimmt das schärfste. Bleibt es unter 40 % des Medians (Wackler, Bewegungsunschärfe), wird die
  Stelle übersprungen und im Ergebnis als *unscharf* aufgeführt. Die ersten drei Bilder dienen als
  Vergleich und werden immer übernommen.
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
landen samt Fotos, GPX und Angaben in einer Warteschlange auf dem Gerät (IndexedDB). Die installierte App
empfängt auch die Push-Nachrichten der Satelliten-Frühwarnung (siehe Satellitenkontext). In der Navigation
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
beim Start nur um ihre Richtung ergänzt und nie von selbst aufgeteilt. Auf der Karte zeigt ein goldener Sichtkegel
die Richtung. Liegen mehrere Spots am selben Ort, rücken ihre Marker in Blickrichtung auseinander, damit
jeder anklickbar bleibt. Im Kopf des Spots stehen die Richtung („Blick nach NO (45°)“) und Links zu den
anderen Spots am selben Ort.

**Spots aufteilen**: Blicken die Fotos eines Spots in verschiedene Richtungen (Spots von vor der
Richtungstrennung, oder Fotos ohne Kompass kamen zuerst), sagt der Spot das in seinem Kopf, z. B.
„3 Fotos nach O, 2 Fotos nach W“, und bietet zwei Wege an:
- *In N Spots aufteilen*: Die Fotos werden in Aufnahmereihenfolge so gruppiert, wie neue Fotos zugeordnet
  werden (±45° um das Mittel der Gruppe). Die grösste Gruppe behält den Spot, jede weitere wird ein neuer
  Spot am selben Ort. Fotos ohne Richtung und 360°-Panoramen passen zu jeder Richtung und bleiben im
  ursprünglichen Spot.
- *Nur das gezeigte Foto abtrennen*: Das Foto kommt in einen eigenen Spot.

Die neuen Spots übernehmen, was für den Ort gilt: Höhe und Gelände, Baumarten, die Satellitenreihe und wer
dem Spot folgt. Danach wird jeder Spot neu ausgerichtet, und die Veränderung wird gegen sein eigenes erstes
Foto gerechnet. Fotoaufträge für den Spot bleiben beim ursprünglichen Spot.

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

### 360°-Panoramen

Panoramen kommen aus 360°-Videos oder als einzelne Fotos von 360°-Kameras (Ricoh Theta, Insta360,
GoPro MAX, Handy-Apps). Ein Foto gilt als Panorama, wenn es das selbst sagt (XMP `GPano:ProjectionType`
= `equirectangular`, wie es die Kameras schreiben); ohne diese Angabe, wenn es genau 2:1 und mindestens
3000 px breit ist. Die Richtung der Bildmitte kommt aus `GPano:PoseHeadingDegrees`.
- **Spot:** Ein Panorama blickt in alle Richtungen. Es kommt deshalb zum nächsten Spot im Umkreis, egal
  in welche Richtung die Kamera zeigte, und bestimmt die Richtung des Spots nicht mit.
- **Ausrichtung:** Zwei Panoramen am selben Ort unterscheiden sich durch eine Drehung der Kamera (wohin sie
  zeigte, wie schief sie gehalten wurde), nicht durch eine Homographie. Die App sucht dieselben
  Merkmalspunkte, rechnet sie in Richtungen auf der Kugel um und schätzt daraus die Drehung (RANSAC über die
  geschlossene Lösung von Horn). Mehr als 25° Schräglage gilt als Fehltreffer. Panoramen werden nur mit
  Panoramen ausgerichtet und verglichen, Fotos nur mit Fotos, auch wenn beide im selben Spot liegen.
- **Ansicht:** Mit *Stabilisiert* zeigt die App spätere Panoramen in die Blickrichtung des ersten gedreht,
  auch in der 360°-Ansicht: Wer sich umsieht und zum nächsten Jahr blättert, schaut weiter auf dieselbe
  Stelle. Der Server rechnet das gedrehte Bild (2048 × 1024 px).
- **Veränderung:** Die Heatmap vergleicht das ganze Panorama (640 × 320 px), über die Naht hinweg. Die
  untersten 15 % (Nadir: Person, Stativ, Velo) zählen nicht.

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

### Satellitenkontext (Sentinel-2 und Landsat)

Zu jedem Spot lädt die App ohne API-Key Zeitreihen aus Satellitenbildern:

- **NDVI** (Grün der Vegetation) und **NDMI** (Feuchteindex, Wasser in Blättern und Nadeln). Ein sinkender
  NDMI zeigt Trockenstress oft, bevor sich die Kronen verfärben.
- **Sentinel-2 L2A** (Copernicus) ab 2017, über die offene STAC-API von Earth Search.
- **Landsat 5, 7 und 8** (Collection 2, USGS) für die Jahre davor, über Microsoft Planetary Computer. Das
  brauchen Spots, deren Fotos vor 2018 beginnen. Der Zugang ist anonym, die Links werden mit einem
  kostenlosen Token signiert. Landsat wird bis Ende 2018 gelesen, damit es Jahre gibt, in denen beide
  Satelliten dieselben Spots sehen.

**So wird gerechnet**
- Gelesen wird pro Band nur die interne Kachel der Cloud-Optimized GeoTIFFs, in der der Spot liegt
  (HTTP-Range-Requests). Bei Sentinel-2 sind das rund 1,4 MB pro Band, also etwa 4,4 MB pro Szene mit
  Rot, Nahinfrarot, SWIR und Szenenklassifikation.
- Wolken, Schatten und Schnee werden pixelweise ausgeblendet: bei Sentinel-2 mit der
  Szenenklassifikation, bei Landsat mit den QA-Bits. Die Streifen von Landsat 7 nach 2003 fallen wie Wolken
  heraus.
- Gemittelt wird bei Sentinel-2 der NDVI über rund 30 × 30 m (3 × 3 Pixel à 10 m) und der NDMI über
  rund 40 × 40 m (20-m-Pixel von B11, NIR aus B08). Landsat hat 30-m-Pixel.
- Pro Monat zählt der Median der wolkenfreien Szenen, Sentinel-2 vor Landsat. Jeder Monat trägt den
  Satelliten, von dem er stammt. Pro Monat und Landsat-Satellit wird eine eigene Szene gelesen, damit
  Monate mit zwei Satelliten verglichen werden können.

**Angleichung von Landsat an Sentinel-2**: Die Satelliten messen mit verschiedenen Bändern; Landsat
misst den NDVI über Wald meist etwas tiefer, und Landsat 5 und 7 weichen von 8 ab. Damit eine Reihe über
2017 hinweg als eine gelesen werden kann, rechnet der Server Landsat-Werte auf die Skala von Sentinel-2 um.
- **Schätzung:** Aus allen Monaten, in denen an einem Spot beide Satelliten Werte haben, über alle Spots
  zusammen, pro Index und Satellit.
  - Ab 12 Monatspaaren eine robuste Gerade (Theil–Sen), sonst ab 4 Paaren nur ein Versatz.
  - Eine Gerade mit einer Steigung ausserhalb 0,8–1,25 gilt als unzuverlässig, dann zählt nur der Versatz.
- **Landsat 8 und 7** werden direkt an Sentinel-2 angeglichen (Überlappung ab 2017). **Landsat 5** endete
  2011 und hat nie mit Sentinel-2 überlappt; es läuft über Landsat 7 (Überlappung bis 2011).
- **Ohne genug Überlappung** bleibt ein Satellit ungeändert. Das Diagramm zeigt pro Monat, ob angeglichen
  wurde und was gemessen war.
- **Wann:** Die Schätzung wird nach jeder täglichen Runde erneuert, vor der Kalibrierung der Frühwarnung.
- Die Werte werden gecacht und wöchentlich ergänzt. Szenen aus der Zeit vor dem NDMI werden nach und nach
  nachgerechnet.

**Rückgänge zwischen zwei Fotos**: Fällt NDVI oder NDMI zwischen zwei Fotodaten gegenüber derselben
Jahreszeit vor dem ersten Foto, erscheint ein Hinweis. Dazu kommt, was die Fotos zeigen (*Windwurf*,
*Auflichtung* oder passende Beobachtungen), als unabhängige Bestätigung. Die Anfangswerte der Schwellen
sind 0,1 (NDVI) und 0,08 (NDMI), ab 0,2 bzw. 0,15 gilt der Rückgang als stark; geeicht werden sie wie die
der Frühwarnung (siehe unten).

**Frühwarnung ohne neue Fotos**: Einmal täglich aktualisiert der Server die Reihen aller Spots, auch wenn
niemand den Spot öffnet (`SATELLITE_WATCH_HOURS`, 0 = aus). Er vergleicht die letzten ein bis zwei Monate
mit derselben Jahreszeit der bis zu fünf Vorjahre (mindestens zwei Vergleichswerte).
- Liegt ein Index um die oben genannten Schwellen tiefer, bekommt der Spot auf der Karte ein
  Satelliten-Zeichen. Der Filter *Satellit meldet Rückgang* zeigt diese Spots, und die Spotansicht hat
  eine Karte *Frühwarnung*.
- Ist das letzte Foto älter als der Rückgang, schlägt die App vor, den Spot zu besuchen: Ein neues Foto
  zeigt, was dahinter steckt.

**Frühwarnung als Push-Nachricht**: Wer einen Spot regelmässig besucht, erfährt von einer neuen
Frühwarnung auf dem Handy, ohne die App zu öffnen.
- **Wer:** Konten, die den Spot in den letzten drei Jahren an mindestens zwei Tagen fotografiert haben.
  Dazu kommt, wer dem Spot folgt (*Spot folgen* in der Spotansicht), und es fällt weg, wer ihn
  stummgeschaltet hat. Die Spotansicht sagt angemeldeten Personen, ob und warum sie benachrichtigt werden.
- **Einschalten:** Im Kontomenü *Push-Nachrichten einschalten*, einmal pro Gerät. Der Browser fragt
  dann um Erlaubnis. *Testnachricht senden* prüft, ob Nachrichten ankommen. Auf iPhone und iPad geht das
  nur, wenn MyForrest als App auf dem Home-Bildschirm liegt (iOS 16.4 oder neuer).
- **Was:** Pro Frühwarnung eine Nachricht (Spot, Index, wie stark, seit wann); mehrere neue Warnungen für
  dieselbe Person kommen gebündelt. Ein Tipp darauf öffnet den Spot. Gesendet wird nur, wenn seit dem
  Beginn des Rückgangs niemand am Spot fotografiert hat, und jede Warnung nur einmal.
- **Wann:** Nach der täglichen Runde, nach Angleichung und Kalibrierung.
- **Technik:** Web Push mit VAPID und verschlüsselter Nachricht (RFC 8291/8292), ohne Fremddienst ausser
  dem Push-Dienst des Browsers (Google, Mozilla, Apple, Microsoft). Der Server schickt nur an diese
  Dienste; abgelaufene Abos löscht er.

**Kalibrierung an bestätigten Schäden**: Die Schwellen der Frühwarnung und der Rückgänge zwischen zwei
Fotos eicht der Server an dem, was vor Ort bestätigt wurde.
- **Kontrollen:** Jedes Paar aufeinanderfolgender Fotos eines Spots (mindestens 30 Tage auseinander) ist
  eine Kontrolle.
  - *Schaden*, wenn das spätere Foto einen neuen Schadens-Tag trägt (Sturmschaden, Borkenkäfer,
    Trockenschaden, Holzschlag, Frühverfärbung, Frost) oder eine Region darauf als Windwurf, Auflichtung
    oder Verfärbung bestätigt wurde.
  - *Kein Schaden*, wenn beides fehlt.
  - Paare, bei denen derselbe Schadens-Tag schon auf dem früheren Foto stand, sagen nichts über den
    Zeitraum und zählen nicht.
- **Nachgerechnet:** Für jede Kontrolle rechnet der Server zwei Werte aus:
  - Frühwarnung: Monat für Monat, wie stark sie zwischen den beiden Besuchen ausgeschlagen hätte, jeweils
    nur mit den Daten, die damals vorlagen.
  - Zwischen den Fotos: der Rückgang zwischen den beiden Fotodaten, so wie ihn die Spotansicht zeigt.
  Beide werden getrennt geeicht.
- **Wahl der Schwelle:** Gewählt wird pro Index die Schwelle zwischen 0,03 und 0,30 mit dem besten
  Verhältnis aus erkannten Schäden und Fehlalarmen (F1). Bei Gleichstand zählt die höhere, also die mit
  weniger Fehlalarmen. Die Schwelle für „stark“ behält das Verhältnis der Anfangswerte.
- **Kreuzvalidierung:** An denselben Kontrollen gemessen sieht jede gewählte Schwelle zu gut aus. Deshalb
  wird die Wahl an zurückgehaltenen Spots geprüft.
  - Die Spots werden in bis zu 5 Teile aufgeteilt. Fotopaare desselben Spots bleiben zusammen, weil sie
    nicht unabhängig sind.
  - Für jeden Teil wählt der Server die Schwelle nur an den übrigen Teilen und zählt Treffer und
    Fehlalarme am zurückgehaltenen Teil.
  - Die geeichte Schwelle gilt nur, wenn sie dort mindestens so gut abschneidet wie der Anfangswert. Der
    Anfangswert ist nie an die Kontrollen angepasst; seine Zahlen auf allen Kontrollen sind daher schon
    ein fairer Vergleich.
- **Wann der Anfangswert bleibt**, mit Begründung in der Warnkarte:
  - Weniger als 5 bestätigte Schäden oder 5 Kontrollen ohne Schaden.
  - Weniger als die Hälfte der Teile hat für sich allein genug Kontrollen, um eine Schwelle zu wählen.
    Die Prüfung würde dann vor allem den Anfangswert messen.
  - Die Kontrollen stammen von weniger als 3 Spots.
  - Die geeichte Schwelle war an zurückgehaltenen Spots nicht besser.
- **Nach Waldtyp:** Laub- und Nadelwald reagieren verschieden. Laubkronen schwanken stärker übers Jahr;
  Borkenkäfer senken den NDVI von Fichten oft nur wenig, bevor die Bäume absterben. Deshalb wird zusätzlich
  pro Waldtyp geeicht.
  - Der **Waldtyp** eines Spots kommt aus den erfassten Baumarten (ab 60 % Nadelbäume Nadelwald, bis 40 %
    Laubwald, dazwischen Mischwald). Ohne Arten zählt der Nadelholzanteil auf den Fotos. Ohne beides
    schätzt ihn der Satellit: Sinkt der NDVI vom Sommer zum Winter um mindestens 0,25, ist es Laubwald,
    um höchstens 0,12 Nadelwald (je mindestens drei Sommer- und Wintermonate).
  - Ein Waldtyp bekommt seine eigene Schwelle nur, wenn sie an seinen zurückgehaltenen Spots mindestens
    so gut abschneidet wie die Schwelle aller Spots. Sonst gilt diese, mit Begründung.
  - Mischwald und Spots ohne bekannten Waldtyp verwenden immer die Schwelle aller Spots.
- **Wann:** Nach jeder täglichen Runde wird neu kalibriert. Die Karten der Frühwarnung und der Rückgänge
  nennen die Schwelle, den Waldtyp, für den sie gilt, die Zahl der Kontrollen und Spots, die Treffer und
  Fehlalarme an zurückgehaltenen Spots und den Vergleich mit dem Anfangswert bzw. der Schwelle aller
  Spots. Unter den Diagrammen steht, als welcher Waldtyp der Spot gilt und woher das kommt.
- **Grenzen:**
  - Bei wenigen Spots schwanken die Zahlen der Kreuzvalidierung stark.
  - „Kein Schaden“ heisst nur, dass niemand einen Schaden markiert hat.
  - Pro Waldtyp braucht es entsprechend mehr bestätigte Schäden; bis dahin gilt die Schwelle aller Spots.
  - Der Waldtyp aus dem Satelliten erkennt Lärchen (sommergrüne Nadelbäume) als Laubwald.

**Sturm als Kontext**: Rückgänge und Frühwarnungen nennen den stärksten Sturm (Böen ab 75 km/h, siehe
Sturmereignisse) im Zeitraum bzw. in den Monaten davor.

**Grenzen**
- Wegen der Pixelgrösse umfasst der Satellitenwert mehr (und anderes) als den Bildausschnitt.
- Ohne genügend bestätigte Schäden bleiben die Schwellen Anfangswerte.
- Ohne Internetzugang bleibt der Bereich leer und wird später erneut versucht. Fällt nur Landsat aus,
  läuft Sentinel-2 weiter.

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
  einbinden, liegt unter [`deploy/qgis-server`](../deploy/qgis-server/README.md) ein fertiges QGIS-Projekt
  mit Stilen in den Farben der App (Ausbreitungsfronten nach Jahr, Spots nach Befund mit Pfeil in
  Blickrichtung, Neophyten hervorgehoben) und eine Docker-Compose-Vorlage: MyForrest, QGIS Server und
  nginx, dazu ein Dienst, der das GeoPackage alle 15 Minuten neu exportiert.

- **Vektorkacheln**: Dieselben Daten als Mapbox Vector Tiles nach **OGC API – Tiles** im Kachelgitter
  WebMercatorQuad (Zoom 0–20), wie sie Webkarten und die Vektorkarten von swisstopo verwenden. Eine Kachel
  `/ogc/tiles/WebMercatorQuad/{z}/{y}/{x}` enthält die Ebenen `spread_fronts`, `spots` und `findings`;
  jede Collection hat zusätzlich eigene Kacheln (auch `photos`). Die Tileset-Beschreibung ist zugleich
  TileJSON 3.0, leere Kacheln antworten mit 204. Geschnitten und vereinfacht wird pro Zoomstufe
  (geojson-vt), die Kacheln folgen den Daten ohne Neuberechnung von Hand.
- **Kartenstil und Vektorkarte**: `/ogc/styles/myforrest` ist ein MapLibre-Stil in den Farben der App
  (Ausbreitungsfronten von hell = früher bis dunkel = neuer, Spots grün oder orange mit Schäden, Neophyten
  violett). Er beschränkt sich auf Ausdrücke, die auch QGIS beim Import von MapLibre-Stilen versteht, und
  nutzt dafür die Attribute `status` (Spots: `schaden`/`ohne`, wie die orangen Marker der App) und
  `recency_class` (Ausbreitungsfronten: 0–4 vom ersten bis zum neusten Jahr). `/vektorkarte.html` zeigt
  die Kacheln mit MapLibre, mit Legende und Angaben per Klick.
- **Schweizer Kachelgitter LV95**: Dieselben Kacheln gibt es auch im Kachelgitter von swisstopo
  (`/ogc/tiles/SwissLV95/{z}/{y}/{x}`, EPSG:2056): gleicher Ursprung (E 2'420'000 / N 1'350'000) und
  dieselben 29 Auflösungen von 4000 m bis 0,1 m pro Pixel wie die WMTS-Dienste von map.geo.admin.ch. Die
  Kacheln liegen damit deckungsgleich auf der Landeskarte und dem Luftbild, ohne Umprojektion im Browser.
  `/vektorkarte-lv95.html` zeigt sie mit OpenLayers über der grauen oder farbigen Landeskarte oder
  SWISSIMAGE, mit Koordinatenanzeige in LV95. Weil die Auflösungen keine Zweierpotenzen sind, schneidet
  der Server diese Kacheln selbst zu (Rechteck-Clipping mit Rand, Douglas–Peucker, Ringorientierung nach
  MVT-Spezifikation). In GDAL/QGIS liest man sie mit
  `OGCAPI:https://<server>/ogc/collections/<id>` und den Optionen `API=TILES`, `TILEMATRIXSET=SwissLV95`
  sowie dem Ausschnitt in LV95 (`MINX`, `MINY`, `MAXX`, `MAXY`): GDAL nimmt sonst die Ausdehnung der
  Collection in Grad und findet keine Kacheln.
- **Vorberechnete Kacheln**: Nach jeder Änderung der Daten schneidet der Server alle Kachelsätze im
  Hintergrund neu, 10 Sekunden nach der letzten Änderung, damit ein Upload-Stapel nur eine Berechnung
  auslöst. Das sind beide Kachelgitter, der Datensatz und jede Collection, in WebMercatorQuad bis Zoom 18
  (rund 0,4 m pro Pixel) und in LV95 bis Zoom 26 (0,5 m).
  - **Speicher und Auslieferung**: Die Kacheln liegen gzip-komprimiert in `data/tiles/tiles.db`. Eine
    Anfrage liest nur noch eine Zeile und liefert sie komprimiert aus. Leere Kacheln kennt der Speicher
    ebenfalls, sie antworten sofort mit 204.
  - **Live geschnitten** werden nur tiefere Zoomstufen und Kacheln, deren Neuberechnung noch läuft. Der
    Kopf `X-Tile-Source` zeigt, woher eine Kachel kommt.
  - **Ohne Unterbruch**: Eine neue Version wird neben der alten aufgebaut und erst am Ende umgeschaltet.
    Der Server antwortet währenddessen weiter.
  - **Von Hand**: `npm run tiles` rechnet alles sofort vor, etwa nach einem Import oder aus einem
    Cron-Job, auch während der Server läuft.
- **PMTiles und MBTiles**: Der Datensatz in WebMercatorQuad steht nach jeder Berechnung auch als eine Datei
  bereit.
  - `/api/export/myforrest.pmtiles` lässt sich auf jedem statischen Webserver oder Objektspeicher ablegen.
    Webkarten lesen daraus einzelne Kacheln per HTTP-Range-Anfrage, ohne MyForrest-Server. GDAL ab 3.8
    liest PMTiles, QGIS über GDAL als Vektorlayer.
  - `/api/export/myforrest.mbtiles` öffnet QGIS direkt als Vektorkachel-Layer, ebenso GDAL und Kachelserver
    wie tileserver-gl oder martin.
  - Solange die Dateien zur aktuellen Datenversion noch berechnet werden, antworten beide mit 503 und
    `Retry-After`.
- **Metadaten für geocat.ch**: `/api/metadata/geocat.xml` beschreibt den Datensatz nach dem Schweizer
  Metadatenmodell GM03 (ISO19139.che), dem Format von geocat.ch. `/api/metadata/iso19139.xml` liefert
  dasselbe als reines ISO 19139 für andere Kataloge.
  - **Inhalt**:
    - Titel, Kurztitel, Zusammenfassung, Zweck, Schlagwörter und Entstehung (Lineage) auf Deutsch,
      Französisch, Italienisch und Englisch.
    - Ausdehnung und Zeitraum aus den Daten, Erstellungs- und Revisionsdatum aus den Uploads.
    - Bezugssysteme LV95 und WGS84, Lizenz, Kontakt.
    - Alle Zugänge mit den Protokollen von geocat.ch: OGC API (`WWW:LINK`), Downloads (`WWW:DOWNLOAD-URL`),
      Kartenansicht (`MAP:Preview`) und, wenn eingerichtet, WMS/WMTS/WFS von QGIS Server.
  - **Kennung**: Die Kennung des Datensatzes bleibt für eine Adresse gleich, damit ein erneuter Import den
    Eintrag aktualisiert statt einen zweiten anzulegen.
  - **Geprüft** gegen die XML-Schemas von ISO 19139 und ISO19139.che sowie gegen die Schematron-Regeln
    von geocat.ch (ISO, GM03 und die Regeln des Bundes, die Titel und Zusammenfassung auf Deutsch und
    Französisch verlangen).
  - **Einstellungen**: Kontakt und Katalog über die Variablen `METADATA_*`
    (siehe [Installation](installation.md#umgebungsvariablen)).

Ausgeblendete (moderierte) Fotos erscheinen in keinem Dienst.

### Eintrag auf geocat.ch und opendata.swiss

1. **Angaben setzen**: `PUBLIC_URL` (die Links im Datensatz zeigen sonst auf die Adresse der Anfrage),
   `METADATA_ORGANISATION` und `METADATA_EMAIL`, bei QGIS Server auch `METADATA_OWS_URL`.
2. **Konto bei geocat.ch**: Organisationen erhalten ein Konto über das Team von geocat.ch bei swisstopo
   (geocat.ch → Kontakt). Dort `/api/metadata/geocat.xml` als XML importieren. Nach Änderungen denselben
   Datensatz erneut importieren; die gleiche Kennung ersetzt den bestehenden Eintrag.
3. **Weiter auf opendata.swiss**: opendata.swiss übernimmt Einträge aus geocat.ch, die das Schlagwort
   `opendata.swiss` und Nutzungsbedingungen von opendata.swiss tragen. `METADATA_OPENDATA_TERMS` setzt
   beides, mit einem der Werte `terms_open`, `terms_by`, `terms_ask` oder `terms_by_ask`. Die
   Organisation muss auf opendata.swiss eingerichtet sein. Den genauen Ablauf beschreibt das Handbuch von
   opendata.swiss; die Bedingung muss zur Lizenz der Fotos passen (Standard CC BY-SA 4.0, also mindestens
   Quellenangabe).

## Touren und Fotoaufträge

Der Kartenmodus *Touren & Aufträge* verbindet die eigenen Wege mit den Orten, an denen ein Foto gebraucht
wird.

### Route zeichnen, aufzeichnen oder importieren

- **Zeichnen**: Jeder Klick auf die Karte setzt einen Wegpunkt; Wegpunkte lassen sich verschieben.
  *Rückgängig* nimmt den letzten zurück, *Zurück zum Start* schliesst die Runde. Die Länge steht gross im
  Panel, gelbe Kilometer-Marken zeigen den Verlauf (je nach Zoom alle 1, 2, 5 oder 10 km). Der **Wege-Magnet**
  (*Magnet: Wegen folgen*, standardmässig an) zieht die Linie zwischen zwei Klicks auf Wege und Pfade, wie bei
  RunnerMaps. Dafür fragt der Server einen BRouter-Dienst an (Standard `brouter.de`, Profil `hiking-mountain`,
  anpassbar mit `ROUTER_URL` und `ROUTER_PROFILE`, siehe [Installation](installation.md#umgebungsvariablen));
  der Browser spricht ihn nie direkt an. Ohne Magnet oder ohne Dienst entstehen gerade Linien.
- **Aufzeichnen**: Das Handy zeichnet die Strecke per GPS auf (Punkte ab ±40 m Genauigkeit, mindestens 4 m
  auseinander, mit Zeit und Höhe). Der Bildschirm bleibt dabei an (Wake Lock), denn Browser stoppen GPS
  für Seiten im Hintergrund. Die Punkte liegen laufend im Browser; nach einem Neuladen lässt sich die
  Aufzeichnung fortsetzen.
- **Importieren**: GPX (Tracks, Routen oder Wegpunkte), Garmin TCX, KML (LineString und `gx:Track`) und
  GeoJSON (LineString, MultiLineString, mit `coordTimes`), bis 14 MB und 20 000 Punkte. FIT-Dateien bitte in
  Garmin Connect oder Strava als GPX exportieren.
- **Exportieren**: jede Route als GPX, mit Höhe und Zeit, wo vorhanden.

Die aktuelle Route bleibt im Browser, bis sie gespeichert wird. **Speichern** braucht ein Konto; Touren sind
privat, bis man sie veröffentlicht. Andere sehen eine öffentliche Tour ohne Zeiten und ohne die ersten und
letzten 200 m, denn Start und Ziel liegen oft vor der Haustür. *Öffentliche Touren auf der Karte zeigen*
setzt einen Pin an den Anfang jeder öffentlichen Tour; beim Überfahren erscheint die Strecke, ein Klick lädt
sie ins Panel.

### Fotos über eine Tour verorten

Fotos ohne GPS (Action-Cam, Kompaktkamera) bekommen ihren Ort aus einer Tour mit Zeitstempeln: Im
Upload-Dialog steht unter dem GPX-Feld *oder Fotos über eine Tour verorten* mit der aktuellen Route und den
eigenen gespeicherten Touren. Die Zuordnung ist dieselbe wie beim GPX-Track (Aufnahmezeit, Zeitzone,
Uhrkorrektur); *Fotos zuordnen* in *Meine Touren* öffnet den Dialog mit der Tour vorausgewählt.

### Fotoaufträge

Ein **Fotoauftrag** bittet um ein Foto von einem Ort: *Neuer Fotoauftrag* im Tab *Aufträge*, dann den Ort
auf der Karte wählen, beschreiben, was zu sehen sein soll, und optional die Blickrichtung angeben. Im
Spot-Panel bittet *Neues Foto von diesem Spot anfragen* um ein Wiederholungsfoto in der Blickrichtung des
Spots. Aufträge erscheinen für alle als gelbe Kamera-Pins auf der Karte, mit einem Kegel in die gewünschte
Richtung.

Ein Auftrag nennt **keine Zeit und keinen Namen**: Niemand muss sich verabreden oder seinen Weg
preisgeben. Wer ohnehin vorbeikommt, macht das Foto. Erledigt ist ein Auftrag, sobald ein Foto
- innerhalb von 40 m (bzw. dem Spot-Radius) entsteht und, wenn beide eine Richtung haben, höchstens 60°
  davon abweicht,
- zum angefragten Spot gehört, oder
- über *Foto dafür hochladen* im Auftrag hochgeladen wird und höchstens 150 m entfernt liegt.

Wer den Auftrag mit Konto erstellt hat, kann ihn zurückziehen; Moderation ebenso. Pro Konto bzw.
Adresse sind 20 Aufträge pro Stunde möglich.

### Vorschläge entlang der Route

Sobald eine Route steht, listet das Panel unter *Unterwegs fotografieren* in der Reihenfolge der Strecke,
was in ihrer Nähe (50–500 m, Standard 150 m) einen Halt lohnt, mit Kilometer und Abstand zur Route:

- offene **Fotoaufträge**,
- Spots mit einer **Satelliten-Frühwarnung** ([Satellitenkontext](#satellitenkontext-sentinel-2-und-landsat)),
- Spots mit einer Fotoreihe (ab zwei Fotos), die seit über einem Jahr **nicht mehr besucht** wurden.

Die Vorschläge stehen nummeriert auf der Karte. Der Server berechnet sie aus der mitgeschickten Route und
speichert nichts davon.

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

## Geschützte Funde und PRO-Mitglieder

Wer eine Orchideenwiese, eine Pilzstelle oder einen Horst veröffentlicht, lockt auch Sammler und
Neugierige an. Solche **geschützten Funde** sehen deshalb nur **verifizierte PRO-Mitglieder** genau:
Forstdienste, kantonale Fachstellen, Naturschutzorganisationen und ähnliche.

### Was geschützt ist

Ein Foto wird geschützt,
- beim Hochladen mit *Geschützter Fund* (Fotos und Videos),
- automatisch, wenn Pl@ntNet eine sensible Art erkennt (Score ab 0,3): alle einheimischen Orchideen,
  Enziane, Küchenschellen, Edelweiss, Bärlappe, seltene Farne, Türkenbund und weitere (`src/sensitive.js`,
  erweiterbar mit `SENSITIVE_SPECIES`). Pilze erkennt Pl@ntNet nicht; Pilzstellen schützt man beim Hochladen,
- oder nachträglich mit *Schützen* unter dem Foto, durch die Person, die es hochgeladen hat, durch
  PRO-Mitglieder oder die Moderation. *Schutz aufheben* geht ebenso.

### Wer was sieht

| | Öffentlichkeit | Wer hochgeladen hat | PRO-Mitglieder, Moderation |
|---|---|---|---|
| Foto, Spot, genaue Lage | – | ✓ (mit Konto) | ✓ |
| Karte | schraffiertes 5-km-Quadrat mit Anzahl Funde | Pin mit Schloss | Pin mit Schloss |
| Arten, Hotspots, Ausbreitung, Export (Darwin Core, iNaturalist) | ohne den Fund | mit | mit |
| Offene Geodaten (OGC API, Vektorkacheln, GeoPackage, PMTiles) | ohne den Fund | ohne | ohne |
| Fotoaufträge an geschützten Spots, Vorschläge entlang der Route | – | ✓ | ✓ |

Das Raster ist fest (0,045° × 0,065°, rund 5 × 5 km) und verschiebt sich nicht mit den Daten. Ein Spot
mit öffentlichen und geschützten Fotos bleibt sichtbar, zeigt öffentlich aber nur die öffentlichen Fotos,
deren Tags und Veränderungen. Originale und Vorschaubilder geschützter Fotos gehen nur an Berechtigte und
mit `Cache-Control: private, no-store`, ebenso alle API-Antworten an PRO-Mitglieder; der Service Worker
speichert solche Antworten nicht auf dem Gerät. Push-Nachrichten der Frühwarnung erreichen nur Konten, die
den Spot noch sehen dürfen. Ohne Konto hochgeladene geschützte Fotos sieht danach auch die Person nicht
mehr, die sie hochgeladen hat.

### PRO-Mitglied werden

Im Konto-Menü *PRO-Mitgliedschaft beantragen*: Organisation und Angaben für die Prüfung. Admins sehen offene
Anträge zuoberst unter *Konten & Rollen* und können sie verifizieren, ablehnen oder PRO später entziehen;
jede Entscheidung steht im Moderationsprotokoll. PRO ist unabhängig von der Rolle (Mitglied, Moderation,
Administration). PRO-Mitglieder können Fotoaufträge als *nur für PRO* markieren; Aufträge an geschützten
Spots sind das automatisch.

## Konten, Moderation und Lizenzen

### Benutzerkonten, Moderation und Lizenz pro Foto

- *Konten*: Registrieren und Anmelden mit E-Mail (oder Name) und Passwort über das Konto-Menü oben rechts.
  Passwörter werden mit scrypt und eigenem Salt pro Konto gespeichert. Die Sitzung liegt in einem
  httpOnly-Cookie (SameSite=Lax, 30 Tage); in der Datenbank steht nur ihr SHA-256-Hash. Fehlversuche beim
  Anmelden werden begrenzt (5 pro Konto und IP, 30 pro IP in 15 Minuten).
- *E-Mail bestätigen*: Nach der Registrierung mit Passwort kommt ein Link per E-Mail (24 Stunden gültig,
  nur der SHA-256 des Tokens steht in der Datenbank; ein neu angeforderter Link ersetzt den alten, höchstens
  3 pro Stunde). Bis zur Bestätigung zeigt das Konto-Menü „E-Mail-Adresse noch nicht bestätigt“ und
  *Bestätigungslink senden*. Mit `REQUIRE_VERIFIED_EMAIL=1` braucht es eine bestätigte Adresse für Uploads
  und Änderungen. Fällt der Mailserver aus, gelingt die Registrierung trotzdem; der Link lässt sich später
  neu anfordern.
- *Passwort vergessen*: Im Anmeldedialog unter *Passwort vergessen?* die Adresse angeben; es kommt ein Link
  (1 Stunde gültig, nur einmal nutzbar, ein neuer ersetzt den alten). Die Antwort ist dieselbe, ob es ein Konto
  gibt oder nicht, und die E-Mail geht im Hintergrund raus, damit sich so keine Adressen abfragen lassen
  (höchstens 3 Links pro Adresse und 10 Anfragen pro IP in der Stunde). Der Link führt auf `/#reset=…`: Der
  Teil nach `#` geht an keinen Server und in keinen Referer. Mit dem neuen Passwort ist man angemeldet,
  alle anderen Sitzungen des Kontos enden, und die Adresse gilt als bestätigt. So können auch Konten aus
  Google oder GitHub ein Passwort festlegen.
- *Passwort ändern*: Im Konto-Menü unter *Passwort ändern* mit dem aktuellen und einem neuen Passwort.
  Falsche aktuelle Passwörter zählen wie Fehlversuche beim Anmelden. Die eigene Sitzung bleibt, alle anderen
  Geräte werden abgemeldet, offene Links zum Zurücksetzen verfallen, und das Konto bekommt eine Hinweis-E-Mail
  („Warst du das nicht?“). Konten ohne Passwort (aus Google oder GitHub) sehen stattdessen *Passwort
  festlegen*, das einen Link zum Zurücksetzen an die eigene Adresse schickt.
- *Anmelden mit Google oder GitHub*: Ist ein Anbieter eingerichtet (siehe
  [Installation](installation.md#anmelden-mit-google-und-github)), zeigt der Dialog „Mit Google anmelden“
  bzw. „Mit GitHub anmelden“. Der Ablauf ist OAuth 2.0 mit PKCE; `state` und Verifier liegen in einem
  kurzlebigen httpOnly-Cookie, ein fremder oder abgelaufener Rücksprung wird abgewiesen. Beim ersten Mal
  entsteht ein Konto ohne Passwort mit der vom Anbieter **bestätigten** E-Mail-Adresse (ohne bestätigte
  Adresse keine Registrierung); der Name kommt vom Anbieter und lässt sich durch eine Zahl eindeutig machen.
  Gibt es zur Adresse schon ein Konto mit bestätigter Adresse, meldet der Anbieter direkt dort an und
  verknüpft sich. Ist die Adresse des Kontos noch nicht bestätigt, wird es nicht automatisch übernommen (sonst
  könnte, wer ein Konto mit fremder Adresse anlegt, später das Konto der echten Inhaberin mitnutzen): Dann
  den Bestätigungslink nutzen oder mit Passwort anmelden und im Konto-Menü *Mit Google/GitHub verknüpfen*
  wählen. Liefert der Anbieter dabei dieselbe
  Adresse, gilt sie als bestätigt (✓ im Konto-Menü). Verknüpfungen lassen sich wieder trennen, ausser es ist
  die einzige Anmeldung des Kontos.
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

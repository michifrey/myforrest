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

## Was der Prototyp heute kann

- **Karte mit Spots**: Fotos, die innerhalb von 25 m aufgenommen wurden, werden automatisch zu
  einem *Spot* zusammengefasst. Die Farbe zeigt Schäden (orange) oder Neophyten (violett).
- **Zeitreise pro Spot**: Mit dem Zeitregler und der Thumbnail-Leiste durch alle Aufnahmen blättern.
- **Blickrichtung**: Spots werden zusätzlich nach Himmelsrichtung getrennt. Die Richtung stammt aus dem
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
- **Vorschaubilder**: Beim Upload entstehen zwei WebP-Vorschaubilder (320 px für Leiste, Listen und
  Karten-Tooltip, 1280 px für Betrachter, Vergleich und Kamera-Overlay), richtig gedreht und im
  Seitenverhältnis des Originals. Die Ausrichtungen gelten deshalb unverändert. Für ältere Fotos werden
  die Vorschaubilder beim Start im Hintergrund nachgerechnet. Bis dahin zeigt die App das Original.
  Analyse und Ausrichtung arbeiten weiter mit dem Original.
- **HEIC-Fotos vom iPhone**: `.heic`/`.heif` werden angenommen und als JPEG gespeichert. Die Umwandlung
  macht der WebAssembly-Decoder von `heic-convert`, weil sharp HEIC meist nicht lesen kann. Aufnahmezeit,
  GPS, Höhe und Blickrichtung werden vorher aus dem EXIF-Block der Originaldatei gelesen. Das gespeicherte
  JPEG enthält keine EXIF-Daten.
- **Vorher/Nachher-Vergleich**: Zwei beliebige Aufnahmen mit einem Wischregler überlagern.
- **Wiederholungsfotos mit Overlay**: Am Spot öffnet *Wiederholungsfoto aufnehmen* die Kamera. Das
  gewählte Referenzfoto liegt halbtransparent oder als Kontur über dem Livebild, sodass sich Ausschnitt
  und Standort genau treffen lassen. Angezeigt werden auch die Entfernung zum Spot und, falls nötig,
  ein Hinweis, das Handy zu drehen. Das Foto wird im Format der Referenz gespeichert, fest diesem
  Spot zugeordnet und direkt im Vorher/Nachher-Vergleich geöffnet.
- **Automatische Feinausrichtung**: Fotos eines Spots werden per Bildregistrierung aufeinander
  ausgerichtet (Merkmalspunkte + RANSAC-Homographie). Im Vorher/Nachher-Vergleich liegen beide Bilder
  dann deckungsgleich übereinander, und mit *Stabilisiert* wirkt das Durchblättern der Zeitleiste
  wie ein Zeitraffer. Die Originalfotos bleiben unverändert, gespeichert wird nur die Transformation.
  Fotos aus einem ganz anderen Blickwinkel werden erkannt und bleiben unausgerichtet.
- **Veränderungs-Heatmap**: Auf zwei ausgerichteten Fotos markiert eine Heatmap, wo sich etwas verändert
  hat (gelb → rot), und nennt den Anteil der veränderten Fläche. Erkannt werden neue oder verschwundene
  Strukturen (umgestürzte Bäume, Lichtungen, Bewuchs) sowie Farbwechsel wie grün → braun. Unterschiedliches
  Licht und kleine Restverschiebungen werden ausgeglichen. Im Kopf jedes Spots steht zudem, wie viel sich
  seit dem ersten Foto verändert hat.
- **Einordnung der Veränderungen**: Veränderte Regionen werden automatisch eingeordnet als
  *Windwurf / liegende Stämme*, *Auflichtung / Holzschlag*, *Verfärbung (grün → gelb/braun)*,
  *neuer Bewuchs* oder *sonstige Veränderung*. Grundlage sind Grünanteil, Helligkeit, Textur,
  Kantenrichtung und Form. Im Vergleich erscheinen sie als beschriftete Rahmen und lassen sich mit
  einem Klick als Beobachtung (Tag) übernehmen. Auf der Karte erscheinen Spots mit starker Veränderung
  im Tooltip, und es gibt einen Filter dafür.
- **Wetter-Kontext und Auffälligkeiten**: Zu jedem Foto werden die Wetterdaten am Standort geladen
  (Open-Meteo, ERA5): Niederschlag, Temperatur, Hitzetage und längste Trockenphase der 90 Tage vor
  der Aufnahme sowie der Niederschlag der letzten 12 Monate, jeweils gegenüber dem Mittel 1991–2020.
  Daraus werden Auffälligkeiten abgeleitet und am Foto festgehalten: Trockenheit, Wärme, Nässe und vor
  allem **frühe Laubverfärbung** mit vermuteter Ursache. Ein Beispiel: Laub verfärbt sich im August
  bei 20 % des üblichen Niederschlags, das deutet auf Trockenstress hin. Bei unauffälligem Wetter
  verweist der Text auf andere Ursachen wie Schädlinge. Jeder Spot hat eine Auffälligkeiten-Chronik
  über die Jahre, und auf der Karte sind betroffene Spots mit „!“ markiert.
- **Baumarten**: Jeder Spot führt einen Artenbestand. Arten kommen automatisch aus der Pl@ntNet-Bestimmung
  (Organ wählbar: Blatt/Nadeln, Rinde, ganzer Baum, Blüte, Frucht) oder werden von Hand aus einer
  Liste von gut 30 mitteleuropäischen Waldbaumarten gewählt. Zu jeder Art gibt es einen Steckbrief: Nadel/Laub,
  typischer Beginn der Herbstfärbung, Trockenheitsempfindlichkeit, worauf zu achten ist. Die Arten machen die
  Auffälligkeiten genauer:
  - „Frühe Verfärbung“ richtet sich nach der am frühesten färbenden Art am Spot (Birke Mitte September,
    Eiche Mitte Oktober).
  - Verfärbte immergrüne Nadelbäume gelten immer als Warnsignal.
  - Fichte bei Trockenheit oder Hitze löst eine Borkenkäfer-Warnung mit Prüfhinweisen aus.
  - Bei Esche mit Auflichtung oder Verfärbung erscheint ein Hinweis auf das Eschentriebsterben.
- **Höhenlage**: Jeder Spot erhält seine Höhe über Meer. Sie kommt aus dem Copernicus-Höhenmodell (über
  Open-Meteo), ersatzweise aus der GPS-Höhe der Fotos, oder wird von Hand eingetragen. Pro 100 m über dem
  Flachland (~400 m) beginnt die Herbstfärbung rund 2,5 Tage früher; die Bewertung „frühe Verfärbung“ und die
  Steckbriefe rechnen damit. Bei Rotbuche auf 1000 m ist das etwa der 15. statt der 30. September.
  Auch die Wetterdaten werden auf die Höhe des Spots heruntergerechnet.
- **Exposition**: Aus dem Höhenmodell (3×3 Messpunkte im Abstand von 90 m, Verfahren nach Horn) werden
  Hangneigung und -richtung des Spots berechnet; von Hand lässt sich die Exposition ebenfalls setzen. Ein
  steiler Südhang ist wärmer und färbt sich einige Tage später, ein Nordhang früher (bis ±4 Tage, gewichtet
  mit der Steilheit). An Südhängen weist der Trockenheitstext zudem darauf hin, dass der Boden schneller
  austrocknet.
- **Kaltluftseen**: Mit dem Topographischen Positionsindex (wie tief liegt der Spot unter dem Mittel seiner
  Umgebung in 300 m und 600 m Umkreis) erkennt die App Senken und Talböden, in denen sich nachts Kaltluft
  sammelt, sowie Kuppen und Rücken. In Senken beginnt die Herbstfärbung bis zu 5 Tage früher. Zeigt das
  Wettermodell nach dem Laubaustrieb Nächte unter 3 °C, wird Spätfrost-Gefahr gemeldet. Braune junge
  Blätter im Frühsommer gelten dann als **Frostschaden** (neuer Tag) statt als frühe Herbstfärbung.
  Auf Kuppen gibt es bei Windwurf einen Hinweis auf die exponierte Lage. Die Geländeform lässt sich auch
  von Hand setzen.
- **Sonne & Wetter auf der Karte**: Ein eigener Kartenmodus zeigt für den gewählten Spot (oder die Kartenmitte)
  und ein beliebiges Datum in Vergangenheit oder Zukunft:
  - Sonnenbahn, Auf- und Untergangsrichtung, Sonnenstand zur gewählten Uhrzeit und den Schatten eines
    25-m-Baums auf der Karte;
  - Sonnenhöhe, Richtung, Tageslänge und die Einstrahlung bei klarem Himmel, auf ebenem Boden und auf dem
    Hang des Spots (Neigung und Exposition), samt Tagessumme in kWh/m²;
  - für vergangene Tage die gemessene Einstrahlung und den Regen pro Stunde (ERA5), für die nächsten
    ~16 Tage die Prognose; die Tagesregenmenge erscheint an jedem Spot auf der Karte.

  Der Tagesverlauf lässt sich mit dem Schieberegler, im Diagramm oder per Abspielen durchgehen. Der
  Sonnenstand wird lokal berechnet (NOAA-Algorithmus) und funktioniert für jedes Datum.
- **Horizontabschattung**: Der Geländehorizont (Copernicus-Höhenmodell über Open-Meteo, 36 Richtungen,
  12 Distanzen von 120 m bis 20 km, mit Erdkrümmung und Refraktion) blockiert die direkte Sonne hinter
  Hügeln und Bergen. Der Anteil des offenen Himmels (Himmelssicht) dämpft das diffuse Licht. Im Kartenmodus
  zeigt das Sonnenbahn-Diagramm die Geländesilhouette, die Bahn ist hinter dem Gelände gestrichelt, und
  Auf- und Untergang werden zu „Sonne ab / Sonne bis“ über dem Grat. Das Panel nennt die Sonnenstunden
  samt Verlust durch das Gelände, die Einstrahlung mit und ohne Gelände, den höchsten Grat und markiert im
  Diagramm die Zeiten, in denen die Sonne hinter dem Gelände steht. Bäume und Gebäude kennt das
  Höhenmodell nicht.
- **Arten & Neophyten auf der Karte**: Der Kartenmodus *Arten & Neophyten* wertet die Pl@ntNet-Bestimmungen
  als **Funde** aus (pro Foto die wahrscheinlichste Art, ab einem wählbaren Mindest-Score, Standard 0,2).
  - **Hotspots**: Eine Kerndichte-Karte (Gauss-Kern, Radius 30–1000 m einstellbar) zeigt, wo sich Funde aller
    Neophyten, aller Arten oder einer gewählten Art häufen, mit Legende in Funden pro km². Die Spot-Marker
    weichen solange den einzelnen Funden; ein Klick auf einen Fund öffnet sein Foto.
  - **Ausbreitungsfronten**: Pro Art die besiedelte Fläche Jahr für Jahr als ineinanderliegende Umrisse
    (konvexe Hülle aller Funde bis zu diesem Jahr, jeder Fund um 25 m gepuffert), eingefärbt nach Jahr, mit
    Zeitregler und Abspielen. Dazu eine Schätzung wie „Ausbreitung ~120 m/Jahr nach NO“: Die Rate ist die
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
- **Installierbare App mit Offline-Upload**: MyForrest lässt sich als App auf den Startbildschirm legen
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
- **Videos statt Einzelbilder**: *Foto beitragen* nimmt auch Videos an, z. B. von einer GoPro oder ein
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
- **Vegetationsdichte**: Für jedes Foto schätzt die App aus den Bildfarben den **Grünanteil** (Laub und Nadeln
  über den Excess-Green-Index der chromatischen Koordinaten, unabhängig von der Belichtung), die
  **Kronendach-Deckung** (Anteil der oberen Bildhälfte ohne sichtbaren Himmel; Himmel = hell und blau oder
  fast weiss), den **Lückenanteil** (Himmel im ganzen Bild) und den Grünwert GCC. Ausgerichtete Fotos werden
  dafür in den gemeinsamen Bildausschnitt des Spots gelegt, so dass die Werte aller Fotos dieselbe Szene
  beschreiben. Die Berechnung läuft nach dem Upload im Hintergrund, bestehende Fotos werden beim Start
  nachgerechnet, nach einer neuen Ausrichtung automatisch neu. In der Spot-Ansicht stehen die Werte als
  Zeitreihen (kleine Mehrfachdiagramme mit Tooltip; ein Klick springt zum Foto).
- **Satellitenkontext (Sentinel-2-NDVI)**: Zu jedem Spot lädt die App ohne API-Key eine NDVI-Zeitreihe aus
  Sentinel-2 L2A (Copernicus, über die offene STAC-API von Earth Search). Gelesen werden nur die wenigen
  Bytes um den Spot (HTTP-Range-Requests auf die Cloud-Optimized GeoTIFFs von Rot B04, Nahinfrarot B08 und
  der Szenenklassifikation SCL). Wolken, Schatten und Schnee werden pixelweise ausgeblendet, gemittelt wird
  ein Fenster von rund 30 × 30 m (3 × 3 Pixel à 10 m), pro Monat der Median der wolkenfreien Szenen. Die
  Werte werden gecacht und wöchentlich ergänzt. Fällt der NDVI zwischen zwei Fotodaten deutlich (≥ 0,1
  gegenüber derselben Jahreszeit vor dem ersten Foto), erscheint ein Hinweis, zusammen mit dem, was die
  Fotos zeigen (*Windwurf*, *Auflichtung* oder passende Beobachtungen), als unabhängige Bestätigung. Wegen
  der 10-m-Pixel umfasst der Satellitenwert mehr als den Bildausschnitt. Ohne Internetzugang bleibt der
  Bereich leer und wird später erneut versucht.
- **Drei Wege, Fotos zu verorten**:
  1. **GPS aus dem Foto** (EXIF), wie bei normalen Handyfotos.
  2. **Automatisch über einen GPX-Track**: Eine Action-Cam im Intervallmodus (z. B. alle 5 s) beim
     Laufen oder Biken, dazu der GPX-Export von Uhr, Strava oder Komoot. Jedes Foto wird über seine
     Aufnahmezeit auf der Strecke verortet. Zeitzone und Abweichung der Kamera-Uhr lassen sich
     korrigieren.
  3. **Manuell**: Standort auf der Karte anklicken oder den aktuellen Standort verwenden.
- **Beobachtungen taggen**: Sturmschaden/Windwurf, Borkenkäfer, Trockenschaden, Totholz,
  Holzschlag, Verjüngung, Neophyt, Weg/Erosion, dazu eine Notiz. Die Karte lässt sich danach filtern.
- **Benutzerkonten, Moderation und Lizenz pro Foto**:
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
- **Pflanzenbestimmung (optional)**: Mit einem kostenlosen [Pl@ntNet](https://my.plantnet.org)-API-Key
  werden Pflanzen auf einem Foto bestimmt. Bekannte invasive Neophyten wie Drüsiges Springkraut,
  Japanischer Staudenknöterich, Goldruten oder Götterbaum werden erkannt, und das Foto erhält
  automatisch den Tag *Neophyt*.

## Schnellstart

Voraussetzung: Node.js ≥ 22.5 (nutzt das eingebaute `node:sqlite`). Für Videos zusätzlich `ffmpeg`
(z. B. `apt install ffmpeg` oder `brew install ffmpeg`).

```bash
npm install
npm start            # http://localhost:3000
npm test
```

**Auf dem Handy:** Browser lassen die Kamera für das Live-Overlay nur über HTTPS zu (oder auf
`localhost`). Im Heimnetz geht das z. B. mit einem Tunnel (`cloudflared tunnel --url http://localhost:3000`)
oder einem Reverse-Proxy wie Caddy. Ohne HTTPS öffnet sich die normale Kamera-App: Das Foto landet
trotzdem am richtigen Spot, nur ohne Overlay.

Konfiguration über Umgebungsvariablen:

| Variable           | Standard | Bedeutung                                      |
|--------------------|----------|------------------------------------------------|
| `PORT`             | `3000`   | HTTP-Port                                      |
| `DATA_DIR`         | `./data` | SQLite-Datenbank und hochgeladene Bilder       |
| `SPOT_RADIUS_M`    | `25`     | Radius, in dem Fotos zum selben Spot gehören   |
| `HEADING_TOLERANCE_DEG` | `45` | Abweichung der Blickrichtung (±°), bis zu der Fotos zum selben Spot gehören |
| `PLANTNET_API_KEY` | –        | Aktiviert die Pflanzenbestimmung               |
| `PUBLIC_URL`       | –        | Öffentliche Adresse für Foto-Links im Export (sonst aus der Anfrage) |
| `FFMPEG_PATH`      | `ffmpeg` | ffmpeg für die Bilder aus Videos               |
| `VIDEO_MAX_MB`     | `4096`   | Maximale Grösse eines Videos                   |
| `SENTINEL_STAC_URL`| Earth Search | STAC-API für Sentinel-2 L2A; leer = Satellitenkontext aus |
| `REQUIRE_LOGIN`    | –        | `1`: Uploads und Änderungen nur mit Konto      |
| `ADMIN_EMAIL`      | –        | Dieses Konto wird Admin (sonst das erste Konto) |

## Aufbau

```
server.js            Einstiegspunkt
src/app.js           Express-App und REST-API
src/db.js            SQLite-Schema (spots, photos, photo_tags, identifications)
src/spots.js         Gruppierung von Fotos zu Spots (Ort und Blickrichtung)
src/thumbs.js        Vorschaubilder (WebP, 320 und 1280 px) in data/thumbs
src/heic.js          HEIC-Erkennung, EXIF aus HEIC, Umwandlung nach JPEG
src/align.js         Bildregistrierung (ORB-Merkmale, Matching, RANSAC)
src/homography.js    3×3-Homographien: Verkettung, Inverse
src/change.js        Veränderungserkennung und Heatmap
src/classify.js      Einordnung der veränderten Regionen
src/vegetation.js    Vegetationsdichte pro Foto (Grünanteil, Kronendach-Deckung, Lücken)
src/sentinel.js      Sentinel-2-NDVI: STAC-Suche, COG-Fenster lesen, Wolkenmaske, Monatsreihe, Rückgänge
src/utm.js           Umrechnung WGS84 ↔ UTM (Projektion der Sentinel-2-Kacheln)
src/routes/vegetation.js  API für Vegetationsdichte und NDVI, Hintergrund-Berechnung
src/weather.js       Wetterdaten und Mittel 1991–2020 von Open-Meteo (mit Cache)
src/irregularities.js  Auffälligkeiten (Trockenheit, Wärme, frühe Laubverfärbung …)
src/trees.js         Waldbaumarten mit Phänologie, Trockenheitsempfindlichkeit und Gefahren
src/phenology.js     Korrektur der Herbstfärbung für Höhe, Exposition und Kaltluftseen
src/elevation.js     Geländehöhe, Hangneigung, Exposition und Geländeform (Copernicus-DEM über Open-Meteo)
src/exif.js          Aufnahmezeit, GPS und Blickrichtung aus den Bilddaten
src/gpx.js           GPX-Parser
src/mp4.js           MP4-Boxen lesen: Telemetrie-Spur, Startzeit, Dauer, 360°-Metadaten
src/gpmf.js          GoPro-Telemetrie (GPMF): GPS5/GPS9, GPSU, SCAL
src/video.js         Bilder entlang der Strecke planen, Blickrichtung, ffmpeg-Aufruf
src/routes/video.js  Video-Upload und Fortschritt (/api/videos)
src/geo.js           Distanzen und Interpolation auf dem Track
src/plantnet.js      Anbindung an die Pl@ntNet-API
src/neophytes.js     Liste invasiver Neophyten (Schwarze Liste CH / BfN)
src/occurrences.js   Funde aus den Pl@ntNet-Bestimmungen, Filter und Artenübersicht
src/spread.js        Ausbreitungsfronten: Umrisse pro Jahr, Rate und Richtung
src/export.js        CSV-Export nach Darwin Core und im iNaturalist-Importformat
src/routes/species.js  API-Routen für Arten, Funde, Ausbreitung und Export
src/auth.js          Konten, Passwort-Hashing (scrypt), Sitzungen, Rate-Limit
src/moderation.js    Lizenzen, Meldungen, Ausblenden und Protokoll
src/routes/accounts.js  Routen für Konten und Moderation, CSRF-Schutz, Rechte auf Fotos
docs/screenshots/    Bilder für dieses README
public/              Frontend (Leaflet, ohne Build-Schritt; forest.js zeichnet die Waldszene,
                     sun.js berechnet Sonnenstand und Einstrahlung, sunmap.js den Kartenmodus „Sonne & Wetter“,
                     hotspots.js den Kartenmodus „Arten & Neophyten“,
                     video.js den Video-Upload und die 360°-Ansicht,
                     vegetation.js die Diagramme zu Vegetationsdichte und NDVI,
                     account.js Konto-Menü, Lizenz, Melden und Moderation)
public/sw.js         Service Worker: App-Shell vorhalten, Laufzeit-Caches, Background Sync
public/offline-queue.js  Warteschlange für Uploads ohne Verbindung (IndexedDB, von Seite und Service Worker genutzt)
public/pwa.js        Registrierung, Warteschlangen-Anzeige, Installieren-Knopf, Kamera-Aufnahme im Upload
public/manifest.webmanifest, public/icons/  Web-App-Manifest und App-Icons
scripts/generate-icons.js  Erzeugt die App-Icons aus dem Logo (`node scripts/generate-icons.js`)
```

### API

| Methode  | Pfad                         | Zweck                                                    |
|----------|------------------------------|----------------------------------------------------------|
| `GET`    | `/api/config`                | Tag-Vokabular, Aktivitäten, aktivierte Features          |
| `GET`    | `/api/spots?tag=…`           | Alle Spots mit Anzahl Fotos, Zeitraum, Tags, Blickrichtung (`heading`) und Vorschaubild (`latestThumbUrl`) |
| `GET`    | `/api/spots/:id`             | Ein Spot mit Blickrichtung und allen Fotos chronologisch (jedes Foto mit `url`, `thumbUrl` und `largeUrl`) |
| `GET`    | `/thumbs/:datei`             | Vorschaubilder (WebP)                                    |
| `POST`   | `/api/photos`                | Upload (multipart: `photos[]` als JPEG, PNG, WebP oder HEIC, optional `spotId` und `refPhotoId` für Wiederholungsfotos, `license`, `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `utcOffsetMinutes`, `clockShiftSeconds`) |
| `POST`   | `/api/videos`                | Video-Upload (multipart: `video`, optional `gpx`, `lat`/`lon`, `takenAt`, `tags`, `activity`, `note`, `clockShiftSeconds`, `frameDistanceM`, `frameIntervalS`, `panorama` = `auto`/`1`/`0`, `async=1` für Hintergrundverarbeitung) |
| `GET`    | `/api/videos/jobs/:id`       | Fortschritt und Ergebnis eines Video-Uploads mit `async=1` |
| `GET`    | `/api/videos/config`         | ffmpeg verfügbar? Standardabstand und -intervall         |
| `POST`   | `/api/spots/:id/align`       | Ausrichtung aller Fotos eines Spots neu berechnen        |
| `GET`    | `/api/photos/:id/change?to=` | Veränderte Fläche zwischen zwei ausgerichteten Fotos, mit eingeordneten Regionen |
| `GET`    | `/api/photos/:id/change.png?to=` | Heatmap der Veränderung (PNG, in der Ansicht des ersten Fotos) |
| `GET`    | `/api/weather/day?lat=&lon=&date=` | Stundenwerte eines Tages (Einstrahlung, Regen, Bewölkung, Temperatur): Messung oder Prognose |
| `GET`    | `/api/weather/day/spots?date=` | Tagesniederschlag an allen Spots                       |
| `GET`    | `/api/horizon?lat=&lon=`       | Geländehorizont (36 Richtungen) und Himmelssicht       |
| `GET`    | `/api/trees`                 | Liste der unterstützten Baumarten mit Steckbrief         |
| `PATCH`  | `/api/spots/:id`             | Höhe (`{ elevation: 950 }`), Exposition (`{ exposition: 'S' }`, auch `'eben'`) und/oder Geländeform (`{ landform: 'senke' }`) von Hand setzen; `null` ermittelt den Wert neu |
| `POST`   | `/api/spots/:id/species`     | Baumart einem Spot zuordnen (`{ scientificName }`)       |
| `DELETE` | `/api/spots/:id/species?name=` | Baumart vom Spot entfernen                             |
| `GET`    | `/api/photos/:id/context`    | Wetter-Kontext und Auffälligkeiten (wird beim ersten Abruf berechnet und gespeichert) |
| `POST`   | `/api/photos/:id/context`    | Wetter-Kontext neu laden                                 |
| `PATCH`  | `/api/photos/:id`            | Tags und Notiz ändern; `license` nur durch den Urheber   |
| `DELETE` | `/api/photos/:id`            | Foto löschen (Urheber oder Moderation; anonyme Fotos ohne `REQUIRE_LOGIN` frei) |
| `GET`    | `/api/auth/me`               | Angemeldetes Konto, CSRF-Token, Lizenzen, Meldegründe, `requireLogin` |
| `POST`   | `/api/auth/register`         | Konto anlegen (JSON: `email`, `name`, `password`) und anmelden |
| `POST`   | `/api/auth/login`            | Anmelden (JSON: `login` = E-Mail oder Name, `password`)  |
| `POST`   | `/api/auth/logout`           | Abmelden                                                 |
| `POST`   | `/api/photos/:id/report`     | Foto melden (`{ reason, note }`), auch ohne Konto        |
| `GET`    | `/api/moderation/queue`      | Moderation: offene Meldungen pro Foto und ausgeblendete Fotos |
| `POST`   | `/api/moderation/photos/:id/hide` | Foto ausblenden (`{ reason }`), erledigt seine Meldungen |
| `POST`   | `/api/moderation/photos/:id/unhide` | Foto wieder einblenden                           |
| `POST`   | `/api/moderation/photos/:id/dismiss` | Meldungen zu einem Foto verwerfen               |
| `GET`    | `/api/moderation/log`        | Protokoll der Moderation                                 |
| `GET`    | `/api/users`                 | Admin: Konten mit Rolle und Anzahl Fotos                 |
| `PATCH`  | `/api/users/:id`             | Admin: Rolle setzen (`{ role: 'user' \| 'moderator' \| 'admin' }`) |

Fotos enthalten im JSON zusätzlich `uploader` (`{ id, name }` oder `null`), `license` (`{ id, label, url }`)
und `hidden`. Schreibende Anfragen mit Sitzungs-Cookie brauchen den Header `X-CSRF-Token`.
| `POST`   | `/api/photos/:id/identify`   | Pflanzen bestimmen (Pl@ntNet)                            |
| `GET`    | `/api/species`               | Arten mit Funden: Anzahl, Spots, Jahre, Neophyt ja/nein  |
| `GET`    | `/api/occurrences`           | Funde (bestes Pl@ntNet-Ergebnis pro Foto). Filter für diese und die folgenden Routen: `species`, `neophytes=1`, `minScore` (Standard 0,2), `bbox=west,süd,ost,nord`, `from`/`to` (Datum) |
| `GET`    | `/api/spread?species=`       | Ausbreitungsfronten einer Art: Umriss, Fläche und Frontabstand pro Jahr, Rate und Richtung (`buffer` in m, Standard 25) |
| `GET`    | `/api/export/dwc.csv`        | Funde als Darwin-Core-Occurrence-CSV (Info Flora, GBIF)  |
| `GET`    | `/api/export/inaturalist.csv` | Funde im CSV-Importformat von iNaturalist               |
| `GET`    | `/api/spots/:id/vegetation`  | Grünanteil, Kronendach-Deckung, Lückenanteil und GCC pro Foto (`pending`: noch in Berechnung) |
| `GET`    | `/api/spots/:id/ndvi`        | Sentinel-2-NDVI pro Monat, NDVI-Rückgänge zwischen Fotodaten mit Belegen aus den Fotos; `status`: `ready`, `pending` (wird geladen), `offline` |
| `POST`   | `/api/spots/:id/ndvi`        | Satellitendaten neu laden                                |

## Roadmap

**Phase 2: Mehr und bessere Fotos**
- ~~Video statt Einzelbilder~~ (umgesetzt: GoPro mit GPMF, 360°-MP4, GPX). Offen: Insta360-`.insv` direkt
  lesen (Fischaugen stitchen, GPS aus dem Datei-Trailer), 360°-Fotos auch beim Foto-Upload erkennen,
  Ausrichtung und Veränderungserkennung für Panoramen (statt Homographie), Bilder unscharfer Frames
  verwerfen.
- Bestehende Spots mit gemischten Blickrichtungen auf Wunsch aufteilen (neue Fotos werden bereits
  nach Richtung getrennt).
- PWA: Kartenausschnitt einer geplanten Route gezielt für offline vorladen; Push-Benachrichtigung,
  wenn ein Upload aus der Warteschlange abgelehnt wurde.
- Konten ausbauen: Passwort zurücksetzen und E-Mail bestätigen, Profilseite mit eigenen Fotos,
  Konto löschen; Rate-Limits dauerhaft speichern statt im Arbeitsspeicher.

**Phase 3: Automatische Auswertung**
- Objekterkennung: umgestürzte Bäume, Wurzelteller, Totholz, Holzpolter und Rückegassen,
  z. B. mit einem feinjustierten YOLO- oder Segmentierungsmodell.
- Einordnung lernen statt Regeln: aus den bestätigten Tags ein Modell trainieren; Baumarten auch ohne
  Pl@ntNet direkt im Bild erkennen (z. B. Nadel-/Laubholzanteil pro Region) und Verfärbungen der
  richtigen Art zuordnen.
- Phänologie verfeinern: regionale Beobachtungsreihen (MeteoSchweiz/DWD) statt pauschaler Gradienten
  für Höhe, Exposition und Kaltluft; nächtliche Abkühlung in Senken aus Wind und Bewölkung abschätzen.
- Sturmereignisse aus Winddaten (Böen) mit Windwurf-Funden verknüpfen; Phänologie-Daten
  (z. B. MeteoSchweiz/DWD) als Referenz für den Beginn der Herbstfärbung pro Region und Höhenlage.
- Vegetationsdichte verfeinern: Himmel und Vegetation mit einem Segmentierungsmodell statt Farbregeln
  trennen (Schnee, helle Felsen und Mauern gelten heute teils als Himmel); Kennzahlen nur im Bildteil
  vergleichen, den alle Fotos eines Spots abdecken.
- Arten und Neophyten: Hotspot-Karten, Ausbreitungsfronten und Datei-Export zu Info Flora / iNaturalist
  sind umgesetzt. Offen: direkter Upload über die APIs (OAuth-Konto bei iNaturalist bzw. Info Flora),
  Bestätigung der automatischen Bestimmungen durch Menschen vor dem Export, Alpha-Shapes statt konvexer
  Hüllen für zerstückelte Bestände und eine Korrektur für ungleich verteilten Suchaufwand.
- Satellitenkontext ausbauen: NDVI-Rückgänge auch ohne Fotos melden (Frühwarnung für Spots), weitere
  Indizes (z. B. NDMI für Trockenstress, Sentinel-2 B11), Landsat für die Zeit vor 2017; Sturmereignisse
  (z. B. MeteoSchweiz/DWD) als Kontext.

## Hinweise

- Ohne `REQUIRE_LOGIN=1` lassen sich anonym hochgeladene Fotos von allen bearbeiten und löschen, wie bisher
  im Prototyp. Für einen öffentlichen Betrieb `REQUIRE_LOGIN=1` setzen und hinter HTTPS betreiben (das
  Sitzungs-Cookie erhält `Secure`, wenn die Anfrage über HTTPS bzw. `X-Forwarded-Proto: https` kommt).
- Ausgeblendete Fotos werden nicht mehr ausgeliefert, können aber noch bis zu 7 Tage im Browser-Cache von
  Personen liegen, die sie vorher gesehen haben.
- Bilder werden unverändert gespeichert und ausgeliefert, **inklusive EXIF-Daten** (GPS,
  Kameramodell). Ausnahmen sind die Vorschaubilder und die aus HEIC umgewandelten JPEGs, die keine
  EXIF-Daten enthalten. Vor einem öffentlichen Betrieb sollten Metadaten entfernt und Personen sowie
  Kennzeichen automatisch verpixelt werden.
- Wetterdaten von [Open-Meteo.com](https://open-meteo.com) (ERA5-Reanalyse, CC BY 4.0). Der Server braucht
  dafür Internetzugang zu `archive-api.open-meteo.com` und, für die Geländehöhe, zu `api.open-meteo.com`. Die Daten werden pro ~10-km-Zelle gecacht; die
  Normalwerte 1991–2020 werden nur einmal pro Zelle geladen.
- Satellitendaten: enthält modifizierte Copernicus-Sentinel-Daten, bezogen über
  [Earth Search](https://earth-search.aws.element84.com/v1) (Element 84, AWS Open Data). Der Server braucht dafür Zugang zu
  `earth-search.aws.element84.com` und `sentinel-cogs.s3.us-west-2.amazonaws.com`.
- Kartendaten © OpenStreetMap-Mitwirkende. Bei stärkerer Nutzung braucht es einen eigenen
  Tile-Anbieter (siehe Tile Usage Policy).
- Der Service Worker braucht HTTPS (oder `localhost`). Nach Änderungen an der Liste vorgehaltener Dateien
  in `public/sw.js` `SHELL_VERSION` erhöhen; alte Caches werden beim Aktivieren gelöscht. App-Code
  (HTML, JS, CSS) wird immer zuerst aus dem Netz geladen, ein Deployment ist also sofort sichtbar.

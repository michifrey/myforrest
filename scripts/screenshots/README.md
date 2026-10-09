# Screenshots für das README

Die Bilder in [`docs/screenshots`](../../docs/screenshots) entstehen mit diesen Skripten aus einem
Demo-Datensatz. Fotos, Karte, Wetter und Satellitendaten sind dabei generiert, damit die Screenshots
ohne echte Fotos, ohne Netz und ohne API-Schlüssel reproduzierbar sind.

| Datei | Aufgabe |
|-------|---------|
| `scene.js` | Zeichnet Demo-Waldfotos (Windwurf mit Verjüngung, Borkenkäfer, Springkraut, Goldrute, frühe Verfärbung) |
| `demo-server.js` | Startet die echte App mit einem synthetischen Open-Meteo-Ersatz (Wetter, Stürme, Nächte, Höhenmodell) und einem Overpass-Ersatz (Wegnetz am Waldweg) |
| `seed.js` | Lädt die Demo-Fotos über die API hoch und ergänzt Pl@ntNet-Bestimmungen und Sentinel-/Landsat-Szenen direkt in der Datenbank |
| `tiles.js` | Platzhalter-Kacheln für OpenStreetMap (Web Mercator) und die Landeskarte grau (LV95) |
| `shoot.js` | Nimmt mit Playwright alle Screenshots auf und baut das Zeitraffer-GIF und das GIF eines Schritts im Durchgehen (`uebergang`, aus einer Videoaufnahme) |
| `glacier-demo.js` | Der erfundene Demo-Gletscher: Umrisse 1850, 1973 und 2016, heutiges Eis und See, Gelände, GLAMOS-Längenänderung und ein Archiv-Katalog |
| `seed-gletscher.js` | Eigener Datensatz für die Gletscher- und Gebirge-Bilder: Inventare, Fotos seit 2017, zwei Archivfotos, eine Alpweide, Schnee- und Eisanteil |

Voraussetzungen: Node.js ≥ 22.5, `ffmpeg`, ImageMagick (`convert`) und Playwright mit Chromium.

```bash
npm install --no-save playwright          # Chromium ggf. mit: npx playwright install chromium
rm -rf scripts/screenshots/.demo          # frischer Datensatz
node --disable-warning=ExperimentalWarning scripts/screenshots/demo-server.js &   # Port 3123
node --disable-warning=ExperimentalWarning scripts/screenshots/seed.js
node scripts/screenshots/shoot.js         # alle Bilder, oder z. B. «shoot.js map spot»
```

Die Gletscher- und Gebirge-Bilder (`gletscher*.jpg` inkl. `gletscher-archiv.jpg`, `gebirge.jpg`) kommen aus einem zweiten Demo-Server, damit die Wald-Karte unverändert
bleibt:

```bash
rm -rf scripts/screenshots/.demo-gletscher
DEMO_DIR=scripts/screenshots/.demo-gletscher DEMO_GLETSCHER=1 PORT=3124 \
  node --disable-warning=ExperimentalWarning scripts/screenshots/demo-server.js &
DEMO_DIR=scripts/screenshots/.demo-gletscher node --disable-warning=ExperimentalWarning scripts/screenshots/seed-gletscher.js
sleep 15                                      # Höhen der Spots (Gebirge-Erkennung) im Hintergrund
node scripts/screenshots/shoot.js gletscher   # BASE_GLETSCHER, Standard http://localhost:3124
```

Die Mapillary-Bilder (`durchgehen-mapillary.jpg`, `mapillary.jpg`, `mapillary-karte.jpg`) brauchen den Demo-Server
mit `DEMO_MAPILLARY=1`: Er ersetzt die Mapillary-API durch eine Reihe gezeichneter Panoramen quer zum Waldweg.
Danach `node scripts/screenshots/shoot.js mapillary` (nur auf ausdrücklichen Wunsch, nicht bei «alle Bilder»).

Arbeitsdateien (Datenbank, Fotos, Kachel-Cache, GIF-Einzelbilder) liegen in `scripts/screenshots/.demo`
bzw. `.demo-gletscher`.
Umgebungsvariablen: `PORT` bzw. `BASE` (Adresse des Demo-Servers), `OUT` (Zielordner der Bilder),
`DEMO_DIR` (Arbeitsordner), `CHROMIUM_PATH` (eigenes Chromium statt dem von Playwright).

Die Satellitendaten enden im Oktober 2026 und die Frühwarnung schaut auf die letzten drei Monate. Wer
die Bilder später neu aufnimmt, verschiebt deshalb die Daten in `seed.js` entsprechend.

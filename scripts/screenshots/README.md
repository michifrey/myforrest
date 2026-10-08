# Screenshots für das README

Die Bilder in [`docs/screenshots`](../../docs/screenshots) entstehen mit diesen Skripten aus einem
Demo-Datensatz. Fotos, Karte, Wetter und Satellitendaten sind dabei generiert, damit die Screenshots
ohne echte Fotos, ohne Netz und ohne API-Schlüssel reproduzierbar sind.

| Datei | Aufgabe |
|-------|---------|
| `scene.js` | Zeichnet Demo-Waldfotos (Windwurf mit Verjüngung, Borkenkäfer, Springkraut, Goldrute, frühe Verfärbung) |
| `demo-server.js` | Startet die echte App mit einem synthetischen Open-Meteo-Ersatz (Wetter, Stürme, Nächte, Höhenmodell) |
| `seed.js` | Lädt die Demo-Fotos über die API hoch und ergänzt Pl@ntNet-Bestimmungen und Sentinel-/Landsat-Szenen direkt in der Datenbank |
| `tiles.js` | Platzhalter-Kacheln für OpenStreetMap (Web Mercator) und die Landeskarte grau (LV95) |
| `shoot.js` | Nimmt mit Playwright alle Screenshots auf und baut das Zeitraffer-GIF |

Voraussetzungen: Node.js ≥ 22.5, `ffmpeg`, ImageMagick (`convert`) und Playwright mit Chromium.

```bash
npm install --no-save playwright          # Chromium ggf. mit: npx playwright install chromium
rm -rf scripts/screenshots/.demo          # frischer Datensatz
node --disable-warning=ExperimentalWarning scripts/screenshots/demo-server.js &   # Port 3123
node --disable-warning=ExperimentalWarning scripts/screenshots/seed.js
node scripts/screenshots/shoot.js         # alle Bilder, oder z. B. «shoot.js map spot»
```

Arbeitsdateien (Datenbank, Fotos, Kachel-Cache, GIF-Einzelbilder) liegen in `scripts/screenshots/.demo`.
Umgebungsvariablen: `PORT` bzw. `BASE` (Adresse des Demo-Servers), `OUT` (Zielordner der Bilder),
`DEMO_DIR` (Arbeitsordner), `CHROMIUM_PATH` (eigenes Chromium statt dem von Playwright).

Die Satellitendaten enden im Oktober 2026 und die Frühwarnung schaut auf die letzten drei Monate. Wer
die Bilder später neu aufnimmt, verschiebt deshalb die Daten in `seed.js` entsprechend.

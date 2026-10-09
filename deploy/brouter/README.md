# Eigener Routing-Server (BRouter)

Der **Wege-Magnet** beim Zeichnen von Touren fragt einen Routing-Dienst nach dem Weg zwischen zwei
Klicks. Ohne Einstellung ist das der öffentliche Dienst `brouter.de`. Er ist für gelegentliche Nutzung
gedacht; für einen öffentlichen Betrieb gehört ein eigener [BRouter](https://github.com/abrensch/brouter)
daneben. Der eigene Dienst fragt dann niemanden mehr an, ausser beim Laden der Routing-Daten.

```
Browser ──/api/route──▶ MyForrest ──ROUTER_URL──▶ BRouter (Port 17777) ──▶ Segmente (Volume /segments)
```

## Was hier liegt

| Datei | Inhalt |
|-------|--------|
| `Dockerfile` | Java 17 mit BRouter (Release `BROUTER_VERSION`, Standard 1.7.7) und den Standardprofilen (`profiles2`, darunter `hiking-mountain`) |
| `entrypoint.sh` | Lädt beim Start die Routing-Daten für das Gebiet `BBOX`, erneuert sie nach `REFRESH_DAYS` Tagen und startet den Server |
| `profiles/myforrest-wald.brf` | Waldprofil von MyForrest (siehe unten), wird ins Image zu den Standardprofilen kopiert |

Die Routing-Daten sind **Segmente** von 5° × 5° (z. B. `E5_N45.rd5` = 5–10° Ost, 45–50° Nord), gebaut aus
OpenStreetMap und Höhendaten und wöchentlich neu auf `brouter.de/brouter/segments4` bereitgestellt. Für die
Schweiz und Liechtenstein (Standard-`BBOX`) sind es `E5_N45` und `E10_N45`, zusammen einige hundert MB. Sie
liegen auf einem Volume und werden nur geladen, wenn sie fehlen oder älter als `REFRESH_DAYS` sind. Schlägt
eine Erneuerung fehl, läuft der Server mit den vorhandenen Daten weiter.

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `BBOX` | `5.9,45.8,10.5,47.9` | Gebiet (West, Süd, Ost, Nord in Grad), daraus die nötigen Segmente |
| `SEGMENTS` | – | Segmente direkt angeben, z. B. `E5_N45 E10_N45`, statt sie aus `BBOX` zu berechnen |
| `SEGMENTS_URL` | `https://brouter.de/brouter/segments4` | Quelle der Segmente |
| `REFRESH_DAYS` | `30` | Nach so vielen Tagen werden die Segmente neu geladen (beim nächsten Start) |
| `PORT`, `MAX_THREADS` | `17777`, `4` | Port und gleichzeitige Berechnungen |
| `JAVA_OPTS` | `-Xms128M -Xmx512M …` | Speicher; 512 MB reichen für die Schweiz |

## Waldprofil `myforrest-wald`

Für Leute, die im Wald unterwegs sind. Kosten pro Meter (1 = Forststrasse); ein Umweg wird genommen, solange
er höchstens um diesen Faktor länger ist:

| Weg | Faktor |
|-----|--------|
| Forststrasse (`highway=track`) | 1 |
| Rückegasse (`track` mit `tracktype=grade4/5` oder Zufahrt Forst/Landwirtschaft) | 1,1 |
| Pfad, Fussweg, Reitweg, Treppe, Velo- und Fussgängerweg | 1,25 |
| Nebenstrasse (`service`, `residential`, `unclassified`) | 1,6 |
| Strasse mit Verkehr (`tertiary`, `secondary`) | 3 |
| Hauptstrasse (`primary`) | 8 |
| Autobahn, Autostrasse, `foot=no`/`access=no`, Fähre, SAC T5/T6 | gesperrt |

Schwierige Bergwege kosten mehr (T3 × 1,5, T4 × 3), Steigungen zählen mit (wie `hiking-mountain`). MyForrest
nutzt das Profil mit `ROUTER_PROFILE=myforrest-wald`; die Vorlagen für Docker Compose und Kubernetes setzen das.
brouter.de kennt das Profil nicht, dort bleibt `hiking-mountain`.

**Wildruhezonen** stehen nicht verlässlich in OpenStreetMap. MyForrest liest sie aus einer GeoJSON-Datei
(`WILDRUHE_GEOJSON`, z. B. der Datensatz *Wildruhezonen* des BAFU von geo.admin.ch, in WGS84 oder LV95) und
gibt die Zonen in der Nähe einer Anfrage während ihrer Schutzzeit als Sperrflächen mit (`polygons=…`). Die
Schutzzeit kommt aus dem Text einer Zone („20.12. bis 30.4.“, „ganzjährig“), sonst aus `WILDRUHE_SEASON`
(Standard `12-20/04-30`). Liegt ein Wegpunkt selbst in einer Zone, wird diese nicht gesperrt, sondern genannt.

## Fertiges Image

Ein GitHub-Workflow (`.github/workflows/brouter-image.yml`) baut das Image bei jeder Änderung in
`deploy/brouter` auf `main` und veröffentlicht es als `ghcr.io/michifrey/myforrest-brouter:latest` und
`:<BROUTER_VERSION>`; in Pull Requests wird nur gebaut. Danach startet er das Image und prüft, dass BRouter
das Waldprofil fehlerfrei liest. Statt selbst zu bauen:

```sh
docker run -d --name brouter -p 17777:17777 -v brouter-segments:/segments ghcr.io/michifrey/myforrest-brouter:latest
```

Das Paket ist nach dem ersten Lauf privat; unter *Packages → myforrest-brouter → Package settings* lässt es
sich öffentlich schalten.

## Starten

**Mit der Docker-Compose-Vorlage** in [`deploy/qgis-server`](../qgis-server/README.md) läuft BRouter schon mit
und MyForrest nutzt ihn über `ROUTER_URL=http://brouter:17777/brouter`. Ein anderes Gebiet:

```sh
cd deploy/qgis-server
BROUTER_BBOX=5.9,45.8,17.2,49.1 docker compose up -d     # Schweiz und Österreich
```

**Auf Kubernetes** gehört er zu [`deploy/k8s`](../k8s/README.md) (`brouter.yaml`, Volume 2 Gi); `start.sh` baut
und lädt das Image mit.

**Allein**, etwa neben `npm start`:

```sh
docker build -t myforrest-brouter deploy/brouter
docker run -d --name brouter -p 17777:17777 -v brouter-segments:/segments myforrest-brouter
ROUTER_URL=http://localhost:17777/brouter npm start
```

Der erste Start dauert, bis die Segmente geladen sind; bis dahin zeichnet die App gerade Linien und meldet
das. Prüfen lässt sich der Dienst direkt:

```sh
curl 'http://localhost:17777/brouter?lonlats=8.5720,47.3733|8.5826,47.3741&profile=myforrest-wald&alternativeidx=0&format=geojson'
```

BRouters eigener Server schliesst die Kopfzeilen seiner Antworten nur mit `\n` ab statt mit `\r\n`. Curl und
Browser stört das nicht, `fetch` von Node lehnt solche Antworten ab; MyForrest fragt einen Routing-Dienst
über `http://` deshalb mit einem nachsichtigen HTTP-Client an (`src/lenient-fetch.js`).

## Stand

- **Startskript:** mit einem lokalen Testserver geprüft (Gebiet → Segmente, Laden, Wiederverwenden, Fehler bei
  fehlenden Daten).
- **Echter BRouter 1.7.7** (Release-Archiv, ohne Docker) mit Routing-Daten, die aus einem kleinen
  nachgebauten Waldstück erzeugt wurden (OSM → `OsmFastCutter`, `PosUnifier`, `WayLinker` → `E5_N45.rd5`):
  - Das Waldprofil nimmt die Forststrasse statt der kürzeren Strasse.
  - Sperrflächen über der Forststrasse führen auf den Pfad.
  - MyForrest erhält die Antworten über `src/lenient-fetch.js`.
- **Noch offen:**
  - der Lauf mit den echten Segmenten von brouter.de;
  - der erste Lauf des Workflows;
  - der Datensatz der Wildruhezonen selbst (aus der Sandbox gesperrt; Format nach geo.admin.ch, getestet mit
    nachgebauten Zonen).
- **Neue BRouter-Version:** Falls das Release-Archiv anders aufgebaut ist, bricht der Bau mit einer klaren
  Meldung ab; dann `BROUTER_VERSION` anpassen.

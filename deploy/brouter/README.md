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
curl 'http://localhost:17777/brouter?lonlats=8.5720,47.3733|8.5826,47.3741&profile=hiking-mountain&alternativeidx=0&format=geojson'
```

## Stand

Dockerfile und Startskript sind ohne Zugang zu GitHub und brouter.de entstanden: Das Startskript ist mit
einem lokalen Testserver geprüft (Gebiet → Segmente, Laden, Wiederverwenden, Fehler bei fehlenden Daten),
die Anfrage von MyForrest an BRouter mit einem nachgebauten Dienst (`test/tracks.test.js`). Der Bau des
Images und ein echter BRouter-Lauf stehen noch aus. Falls das Release-Archiv einer neuen Version anders
aufgebaut ist, bricht der Bau mit einer klaren Meldung ab; dann `BROUTER_VERSION` anpassen.

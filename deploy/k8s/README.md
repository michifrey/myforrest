# MyForrest auf Kubernetes (lokal mit podman)

Dieselbe Zusammenstellung wie [`deploy/qgis-server`](../qgis-server/README.md), als Kubernetes-Manifeste:

- **MyForrest** mit Volume (5 Gi) für Datenbank und Uploads
- **QGIS Server** mit dem Projekt aus `deploy/qgis-server/project`; ein Begleit-Container holt das
  GeoPackage alle 15 Minuten neu
- **nginx** davor: `/ows/` geht an QGIS Server, alles andere an MyForrest

## Starten

Voraussetzung ist ein lokaler Cluster auf podman (kind mit `KIND_EXPERIMENTAL_PROVIDER=podman` oder
minikube mit `--driver=podman`). `kubectl` muss auf diesen Cluster zeigen.

```sh
deploy/k8s/start.sh          # bauen, ins Cluster laden, einspielen, http://localhost:8080 öffnen
deploy/k8s/start.sh stop     # Namespace myforrest löschen (inklusive Daten)
```

Umgebungsvariablen:

- `PORT`: anderer lokaler Port. Dann auch `PUBLIC_URL` in `kustomization.yaml` anpassen.
- `NO_FORWARD=1`: nur einspielen, ohne Port-Forward.
- `REGISTRY=<registry>`: für andere Cluster. Das Image wird dorthin gepusht statt geladen.

Die Service `nginx` ist zusätzlich als NodePort 30080 erreichbar, wenn der Cluster diesen Port auf den
Host abbildet.

## Ohne Skript

```sh
podman build -t localhost/myforrest:dev .
# Image ins Cluster laden (kind load image-archive / minikube image load), dann:
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s | kubectl apply -f -
```

`--load-restrictor` braucht es, weil `nginx.conf` und das QGIS-Projekt aus `deploy/qgis-server` kommen.

## Stand

Die Manifeste sind gegen das Schema von Kubernetes 1.31 geprüft. `start.sh` ist noch nicht gegen einen
echten Cluster gelaufen. QGIS Server (`qgis/qgis-server:ltr`) ist ein grosses Image, der erste Start
dauert entsprechend.

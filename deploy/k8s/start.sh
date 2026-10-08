#!/usr/bin/env bash
# Starts MyForrest with QGIS Server in a local Kubernetes cluster that runs on
# podman (kind or minikube with the podman provider/driver):
#
#   deploy/k8s/start.sh          build the image, load it, deploy, forward http://localhost:8080
#   deploy/k8s/start.sh stop     remove everything again (namespace myforrest, including the data)
#
# Uses the current kubectl context. Environment: PORT (default 8080),
# REGISTRY (push the image there instead of loading it, for other clusters),
# NO_FORWARD=1 (deploy only, no port-forward).
set -euo pipefail
cd "$(dirname "$0")/../.."

NS=myforrest
IMAGE=localhost/myforrest:dev
PORT=${PORT:-8080}
CONTEXT=$(kubectl config current-context)
say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

if [[ ${1:-} == stop ]]; then
  say "Lösche Namespace $NS im Kontext $CONTEXT (inklusive Daten)"
  kubectl delete namespace "$NS" --ignore-not-found
  exit 0
fi

say "Baue $IMAGE mit podman"
podman build -t "$IMAGE" .

if [[ -n ${REGISTRY:-} ]]; then
  say "Lade das Image nach $REGISTRY hoch"
  podman push "$IMAGE" "$REGISTRY/myforrest:dev"
else
  archive=$(mktemp -t myforrest-image.XXXXXX.tar)
  trap 'rm -f "$archive"' EXIT
  podman save -o "$archive" "$IMAGE"
  case "$CONTEXT" in
    kind-*)
      say "Lade das Image in den kind-Cluster ${CONTEXT#kind-}"
      KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive "$archive" --name "${CONTEXT#kind-}"
      ;;
    minikube | minikube-*)
      say "Lade das Image in minikube ($CONTEXT)"
      minikube -p "$CONTEXT" image load "$archive"
      ;;
    *)
      echo "Kontext '$CONTEXT' ist weder kind noch minikube: das Image mit REGISTRY=<registry> in eine Registry" >&2
      echo "schieben, die der Cluster erreicht, oder den Kontext wechseln (kubectl config use-context …)." >&2
      exit 1
      ;;
  esac
fi

say "Wende deploy/k8s an (Kontext $CONTEXT)"
manifests=$(kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s)
if [[ -n ${REGISTRY:-} ]]; then
  # Pull from the registry instead of using a loaded image.
  manifests=$(sed -e "s#image: $IMAGE#image: $REGISTRY/myforrest:dev#" -e 's#imagePullPolicy: Never#imagePullPolicy: Always#' <<<"$manifests")
fi
kubectl apply -f - <<<"$manifests"
# Same tag, new build: restart so the pod runs the image just loaded.
kubectl -n "$NS" rollout restart deployment/myforrest

say "Warte auf die Pods (QGIS Server lädt beim ersten Mal ein grosses Image)"
for d in myforrest qgis-server nginx; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=15m
done

if [[ ${NO_FORWARD:-} == 1 ]]; then
  say "Fertig. Zugriff z. B. mit: kubectl -n $NS port-forward svc/nginx $PORT:80"
  exit 0
fi
say "MyForrest:     http://localhost:$PORT/"
say "QGIS Server:   http://localhost:$PORT/ows/?SERVICE=WMS&REQUEST=GetCapabilities"
say "Beenden mit Ctrl+C (die Pods laufen weiter; 'deploy/k8s/start.sh stop' räumt auf)"
exec kubectl -n "$NS" port-forward svc/nginx "$PORT:80"

#!/bin/sh
# Fetches MyForrest's GeoPackage export (first one before QGIS Server starts, then every $EXPORT_MINUTES)
# and starts QGIS Server with the nginx of the image (start-xvfb-nginx.sh).
set -eu

if [ -z "${MYFORREST_URL:-}" ] && [ -n "${MYFORREST_HOSTPORT:-}" ]; then MYFORREST_URL="http://$MYFORREST_HOSTPORT"; fi
: "${MYFORREST_URL:?MYFORREST_URL (or MYFORREST_HOSTPORT) fehlt}"
export_url="${MYFORREST_URL%/}/api/export/myforrest.gpkg"
target=/io/data/myforrest.gpkg

fetch() {
  wget -q -T 300 -O "$target.part" "$export_url" && mv "$target.part" "$target" && chmod 644 "$target"
}

until fetch; do
  echo "Kartenserver: warte auf MyForrest ($export_url)"
  rm -f "$target.part"
  sleep 10
done
echo "Kartenserver: GeoPackage geladen, starte QGIS Server"

(
  while true; do
    sleep $((EXPORT_MINUTES * 60))
    fetch || { rm -f "$target.part"; echo "Kartenserver: Export fehlgeschlagen, behalte den letzten" >&2; }
  done
) &

# Without IPv6 in the container nginx would not start on "listen [::]:80".
if [ ! -e /proc/net/if_inet6 ]; then
  sed -i '/listen *\[::\]/d' /etc/nginx/nginx.conf /etc/nginx/sites-enabled/default 2>/dev/null || true
fi

exec /usr/local/bin/start-xvfb-nginx.sh

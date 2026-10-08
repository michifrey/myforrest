#!/bin/sh
# Downloads the BRouter segments covering $BBOX (or the tiles in $SEGMENTS,
# e.g. "E5_N45 E10_N45"), refreshes them after $REFRESH_DAYS days and starts
# the route server on $PORT. A failed refresh keeps the old file.
set -eu

dir=${SEGMENTS_DIR:-/segments}

# Tiles of 5°×5°, named after their south-west corner (E5_N45 = 5–10° E, 45–50° N).
tiles() {
  if [ -n "${SEGMENTS:-}" ]; then
    echo "$SEGMENTS"
    return
  fi
  echo "$BBOX" | awk -F, '
    function floor5(v) { f = int(v / 5) * 5; if (f > v) f -= 5; return f }
    function name(lon, lat) { return (lon < 0 ? "W" (-lon) : "E" lon) "_" (lat < 0 ? "S" (-lat) : "N" lat) }
    { for (lon = floor5($1); lon <= $3; lon += 5) for (lat = floor5($2); lat <= $4; lat += 5) printf "%s ", name(lon, lat) }'
}

for t in $(tiles); do
  file="$dir/$t.rd5"
  if [ -s "$file" ] && [ -z "$(find "$file" -mtime +"$REFRESH_DAYS" 2>/dev/null)" ]; then
    continue
  fi
  echo "BRouter: lade $t.rd5 von $SEGMENTS_URL"
  if curl -fsSL --retry 3 -o "$file.part" "$SEGMENTS_URL/$t.rd5"; then
    mv "$file.part" "$file"
  else
    rm -f "$file.part"
    if [ -s "$file" ]; then
      echo "BRouter: $t.rd5 konnte nicht erneuert werden, behalte die vorhandene Datei" >&2
    else
      echo "BRouter: $t.rd5 fehlt und konnte nicht geladen werden" >&2
      exit 1
    fi
  fi
done

echo "BRouter: starte auf Port $PORT mit $(ls "$dir"/*.rd5 | wc -l) Segmenten"
# Arguments: segment dir, profile dir, custom profile dir, port, max threads, bind address.
# shellcheck disable=SC2086
exec java $JAVA_OPTS -cp /opt/brouter/brouter.jar btools.server.RouteServer \
  "$dir" /opt/brouter/profiles2 /customprofiles "$PORT" "$MAX_THREADS" 0.0.0.0

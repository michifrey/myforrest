# QGIS Server with the MyForrest project for Render (render.yaml, private service "myforrest-karten").
# Unlike Docker Compose there is no shared volume: the container fetches the GeoPackage export from MyForrest
# itself (MYFORREST_URL, every EXPORT_MINUTES) and serves WMS/WMTS/WFS with the nginx of the image on port 80.
# MyForrest passes /ows/ on to it (OWS_UPSTREAM), so the services appear under MyForrest's address.
# Build context: the repository root.
FROM docker.io/qgis/qgis-server:ltr
COPY deploy/qgis-server/project /io/project
COPY deploy/render/karten/start.sh /usr/local/bin/myforrest-karten
RUN chmod 755 /usr/local/bin/myforrest-karten && mkdir -p /io/data
ENV QGIS_PROJECT_FILE=/io/project/myforrest.qgz \
    QGIS_SERVER_LOG_LEVEL=1 \
    EXPORT_MINUTES=15
EXPOSE 80
CMD ["/usr/local/bin/myforrest-karten"]

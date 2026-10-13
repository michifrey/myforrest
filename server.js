'use strict';

// On Render the public address comes as RENDER_EXTERNAL_URL (render.yaml); PUBLIC_URL wins when set.
if (!process.env.PUBLIC_URL && process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;
// Private services on Render come as host:port (render.yaml, fromService … hostport): the own BRouter and QGIS Server.
if (!process.env.ROUTER_URL && process.env.ROUTER_HOSTPORT) process.env.ROUTER_URL = `http://${process.env.ROUTER_HOSTPORT}/brouter`;
if (!process.env.OWS_UPSTREAM && process.env.OWS_HOSTPORT) process.env.OWS_UPSTREAM = `http://${process.env.OWS_HOSTPORT}`;
// With QGIS Server behind /ows/ the metadata record names its WMS, WMTS and WFS.
if (!process.env.METADATA_OWS_URL && process.env.OWS_UPSTREAM && process.env.PUBLIC_URL) {
  process.env.METADATA_OWS_URL = `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/ows/`;
}

const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const app = createApp({
  dataDir: process.env.DATA_DIR || undefined,
  spotRadiusM: Number(process.env.SPOT_RADIUS_M) || undefined,
  headingToleranceDeg: Number(process.env.HEADING_TOLERANCE_DEG) || undefined,
});

app.listen(port, () => {
  console.log(`MyForrest läuft auf http://localhost:${port}`);
});

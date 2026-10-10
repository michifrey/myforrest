'use strict';

// On Render the public address comes as RENDER_EXTERNAL_URL (render.yaml); PUBLIC_URL wins when set.
if (!process.env.PUBLIC_URL && process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;

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

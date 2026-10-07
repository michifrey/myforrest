'use strict';

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

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { openDb, transaction } = require('./db');
const { distanceM, isValidCoord, positionAt } = require('./geo');
const { lenientFetch } = require('./lenient-fetch');
const { createWildlife } = require('./wildlife');
const { createGlaciers } = require('./glaciers');
const { createGlamos } = require('./glamos');
const { createArchives } = require('./archives');
const { createMapillary } = require('./mapillary');
const { createWaynet } = require('./waynet');
const { LANDSCAPES, ICE_LANDSCAPES, MOUNTAIN_MIN_M, FOREST_ONLY_TAGS, isLandscape, landscapeOf } = require('./landscapes');
const { parseTrackPoints } = require('./gpx');
const { readPhotoMeta, imageExtension } = require('./exif');
const { assignSpot, refreshSpot, backfillSpotHeadings, planSplit, splitSpot, HEADING_TOLERANCE_DEG } = require('./spots');
const { isHeic, heicExif, heicToJpeg } = require('./heic');
const { createThumbnails } = require('./thumbs');
const sharp = require('sharp');
const { TAGS, parseTags } = require('./tags');
const { identifyPlant } = require('./plantnet');
const { alignImages, alignPanoramas, extractFeatures } = require('./align');
const { alignOnHorizon } = require('./horizon-align');
const sphere = require('./sphere');
const { IDENTITY, multiply, invert } = require('./homography');
const { computeChange, renderHeatmap } = require('./change');
const { classifyChange, unclassified } = require('./classify');
const { createWeather } = require('./weather');
const { assess } = require('./irregularities');
const { TREES, treeInfo, treeJson } = require('./trees');
const { createElevation } = require('./elevation');
const registerAccounts = require('./routes/accounts');
const { createOAuth, providersFromEnv } = require('./oauth');
const { createMailer } = require('./mail');
const { createSensitiveLists } = require('./sensitive');
const { createCantons } = require('./canton');
const { createStorms } = require('./storms');
const { createStormWatch } = require('./stormwatch');
const {
  altitudeShift, aspectShift, coldPoolShift, expectedColourDoy, aspectLabel, aspectFromCompass, COMPASS, LANDFORMS, landform,
} = require('./phenology');

const ACTIVITIES = ['joggen', 'wandern', 'biken', 'fahren', 'sonstiges'];
// Irregularities that concern any landscape (src/irregularities.js, src/storms.js); the others are about trees.
const WEATHER_IRREGULARITIES = new Set(['trockenheit', 'naesse', 'waerme', 'sturm']);
// Drive mode (dashcam): at most one picture per account and place within this time.
const DRIVE_REPEAT_MS = 12 * 3600 * 1000;
/** Without GPano metadata: exactly 2:1 and at least this wide (360° cameras: 5376 px and more). */
const PANORAMA_MIN_WIDTH = 3000;
const isPanoramaSize = (w, h) => w >= PANORAMA_MIN_WIDTH && Math.abs(w / h - 2) < 0.02;
const NEOPHYTE_MIN_SCORE = 0.3;
const TREE_MIN_SCORE = 0.25;

/**
 * TRUST_PROXY as Express takes it: a number of proxy hops ("1"), "true" for all, or addresses and
 * subnets ("loopback", "10.0.0.0/8, 172.16.0.0/12"). Unset or empty = trust no proxy.
 */
function parseTrustProxy(value) {
  const v = (value ?? '').trim();
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function createApp({
  dataDir = path.join(__dirname, '..', 'data'),
  spotRadiusM = 25,
  headingToleranceDeg = HEADING_TOLERANCE_DEG,
  plantnetKey = process.env.PLANTNET_API_KEY,
  fetchImpl = fetch,
  weatherFetch = fetch,
  requireLogin = process.env.REQUIRE_LOGIN === '1',
  requireVerifiedEmail = process.env.REQUIRE_VERIFIED_EMAIL === '1',
  adminEmail = process.env.ADMIN_EMAIL || null,
  rateLimits,
  // Sign-in with Google/GitHub (src/oauth.js): { google: { clientId, clientSecret }, github: { … } }.
  oauthProviders = providersFromEnv(), oauthFetch = fetch,
  // E-mail for confirmation links (src/mail.js): { send({ to, subject, text }) }; default from SMTP_URL.
  mailer = createMailer(),
  detectorUrl = process.env.DETECTOR_URL || null, detectorFetch = fetch,
  // Routing along paths for drawn tours (BRouter-compatible, e.g. https://brouter.de/brouter); off when unset.
  // Public BRouter by default (only waypoints are sent, by the server); ROUTER_URL= (empty) turns it off.
  routerUrl = (process.env.ROUTER_URL ?? 'https://brouter.de/brouter') || null, routerFetch = lenientFetch,
  routerProfile = process.env.ROUTER_PROFILE || 'hiking-mountain',
  // Vector tile precomputation (routes/ogc-tiles.js): { precompute, delayMs }.
  tileOptions = { precompute: process.env.TILES_PRECOMPUTE !== '0' },
  // Push messages (routes/push.js): { fetchImpl, allowedHosts, allowHttp } for tests.
  pushOptions = {},
  // Glacier outlines (src/glaciers.js): GeoJSON files of glacier inventories, comma-separated.
  glacierFiles = process.env.GLETSCHER_GEOJSON || '',
  // Length change series of glacier tongues (src/glamos.js): GLAMOS CSV files, comma-separated.
  glamosFiles = process.env.GLAMOS_CSV || '',
  // Catalogue of openly licensed archive pictures (src/archives.js): CSV/GeoJSON files, comma-separated; and how to fetch them.
  archiveFiles = process.env.ARCHIV_KATALOG || '', archiveFetch = fetch,
  // Spots without a profile above this height become mountain spots (src/landscapes.js); 0 = off.
  mountainMinM = MOUNTAIN_MIN_M,
  // Storm warnings from the forecast (src/stormwatch.js): hours between checks, 0 = off.
  stormWarnHours = Number(process.env.STURM_WARN_HOURS ?? 3),
  // Mapillary pictures in the walk-through and on the map (src/mapillary.js); off without a token.
  mapillaryToken = process.env.MAPILLARY_TOKEN || '', mapillaryFetch = fetch,
  waynetUrl = process.env.WEGNETZ_URL || '', waynetFetch = fetch,
  // Reverse proxies whose X-Forwarded-For counts (Express 'trust proxy'), so rate limits see the client's
  // address instead of the proxy's. Off by default: otherwise anyone could fake the header.
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY),
} = {}) {
  const uploadDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'myforrest.db'));
  backfillSpotHeadings(db);
  const thumbs = createThumbnails({ db, uploadDir, thumbDir: path.join(dataDir, 'thumbs') });
  const weather = createWeather({ db, fetchImpl: weatherFetch });
  const elevationService = createElevation({ db, fetchImpl: weatherFetch });

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 40 * 1024 * 1024, files: 201 },
  }).fields([{ name: 'photos', maxCount: 200 }, { name: 'gpx', maxCount: 1 }]);

  const app = express();
  if (trustProxy !== false) app.set('trust proxy', trustProxy);
  app.locals.db = db;
  // Tracks (src/routes/tracks.js) carry up to 20 000 points; everything else stays small.
  const smallJson = express.json({ limit: '100kb' });
  const trackJson = express.json({ limit: '15mb' });
  app.use((req, res, next) => (/^\/api\/(tracks|route-suggestions)\b/.test(req.path) ? trackJson : smallJson)(req, res, next));
  // Accounts, CSRF, moderation (src/routes/accounts.js); must precede the routes below and /uploads.
  const oauth = createOAuth({ providers: oauthProviders, publicUrl: process.env.PUBLIC_URL || null, fetchImpl: oauthFetch });
  const accountsCtx = {
    db, requireLogin, requireVerifiedEmail, adminEmail, rateLimits, oauth, mailer, publicUrl: process.env.PUBLIC_URL || null,
  };
  const accounts = registerAccounts(app, accountsCtx);
  // Wildlife rest areas (WILDRUHE_GEOJSON): the path magnet routes around them in their protection period.
  const wildlife = createWildlife();
  // Glacier inventories (GLETSCHER_GEOJSON): glacier spots, the outlines on the map, where the ice was.
  const glaciers = createGlaciers({ files: glacierFiles });
  const mapillary = createMapillary({ db, dataDir, token: mapillaryToken, fetchImpl: mapillaryFetch });
  const waynet = createWaynet({ db, url: waynetUrl, fetchImpl: waynetFetch });
  app.locals.remindPro = accounts.remindPro;
  // Protection lists per canton (src/sensitive.js) and the canton of each spot (src/canton.js).
  const sensitiveLists = createSensitiveLists(db);
  const cantons = createCantons({ db, fetchImpl: weatherFetch });

  /**
   * Protects unprotected photos whose identifications name a sensitive species
   * there (after a new protection list); photos released by hand stay released.
   * Returns how many were protected.
   */
  function reprotect() {
    const rows = db.prepare(`SELECT DISTINCT p.id, s.canton, i.scientific_name FROM photos p
      JOIN spots s ON s.id = p.spot_id JOIN identifications i ON i.photo_id = p.id
      WHERE COALESCE(p.protected, 0) = 0 AND p.protected_reason IS NULL AND i.score >= ?`).all(NEOPHYTE_MIN_SCORE);
    const ids = new Set(rows.filter((r) => sensitiveLists.isSensitive(r.scientific_name, r.canton)).map((r) => r.id));
    const set = db.prepare("UPDATE photos SET protected = 1, protected_reason = 'art' WHERE id = ?");
    for (const id of ids) set.run(id);
    return ids.size;
  }
  // The service worker must never be served stale from the HTTP cache, or app updates would stall.
  app.get('/sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));
  app.use('/vendor/maplibre', express.static(path.dirname(require.resolve('maplibre-gl/dist/maplibre-gl.js')), { maxAge: '30d' }));
  // OpenLayers for the LV95 map (vektorkarte-lv95.html): the full build plus its stylesheet.
  const olDir = path.dirname(require.resolve('ol/package.json'));
  app.get('/vendor/ol/ol.css', (req, res) => res.sendFile(path.join(olDir, 'ol.css'), { maxAge: '30d' }));
  app.use('/vendor/ol', express.static(path.join(olDir, 'dist'), { maxAge: '30d' }));
  for (const font of ['fraunces', 'manrope']) {
    const dir = path.dirname(require.resolve(`@fontsource-variable/${font}/package.json`));
    app.use(`/vendor/fonts/${font}`, express.static(dir, { maxAge: '30d' }));
  }
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', immutable: true }));
  app.use('/thumbs', express.static(path.join(dataDir, 'thumbs'), { maxAge: '7d', immutable: true }));

  const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');
  const idsOf = db.prepare(
    'SELECT scientific_name, common_name, score, neophyte FROM identifications WHERE photo_id = ? ORDER BY score DESC',
  );
  const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');

  const photoJson = (p) => ({
    id: p.id,
    spotId: p.spot_id,
    url: `/uploads/${p.file}`,
    ...thumbs.urls(p),
    originalName: p.original_name,
    takenAt: new Date(p.taken_at).toISOString(),
    lat: p.lat,
    lon: p.lon,
    heading: p.heading,
    locationSource: p.location_source,
    panorama: Boolean(p.panorama),
    videoTime: p.video_time ?? null,
    sequenceId: p.sequence_id ?? null,
    archive: Boolean(p.archive),
    activity: p.activity,
    note: p.note,
    tags: tagsOf.all(p.id).map((r) => r.tag),
    // Photos: a homography onto the spot's frame. 360° panoramas: a rotation of the sphere (`kind`, with yaw and tilt).
    alignment: p.align_h ? (p.panorama
      ? { kind: 'rotation', r: JSON.parse(p.align_h), inliers: p.align_inliers, ...sphere.describe(JSON.parse(p.align_h)) }
      : { h: JSON.parse(p.align_h), inliers: p.align_inliers }) : null,
    change: p.change_json ? JSON.parse(p.change_json) : null,
    context: p.context_json ? JSON.parse(p.context_json) : null,
    ...accounts.photoExtras(p), // uploader, license, hidden
    identifications: idsOf.all(p.id).map((r) => {
      const tree = treeInfo(r.scientific_name);
      return {
        scientificName: r.scientific_name,
        commonName: r.common_name,
        score: r.score,
        neophyte: r.neophyte,
        tree: tree ? treeJson(tree) : null,
      };
    }),
  });
  accountsCtx.photoJson = photoJson;

  const setTags = (photoId, tags) => {
    db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(photoId);
    const ins = db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(photoId, t);
  };

  /* ---------- Alignment of photos within a spot ---------- */

  // Small cache so aligning against the same reference does not re-extract features.
  const featureCache = new Map();
  const cachedFeatures = async (file) => {
    if (featureCache.has(file)) return featureCache.get(file);
    const f = extractFeatures(file);
    featureCache.set(file, f);
    if (featureCache.size > 40) featureCache.delete(featureCache.keys().next().value);
    f.catch(() => featureCache.delete(file));
    return f;
  };
  const setAlignment = db.prepare('UPDATE photos SET align_h = ?, align_inliers = ? WHERE id = ?');

  /** Photos and 360° panoramas of a spot are aligned (and compared) only among their own kind. */
  const SAME_KIND = 'COALESCE(panorama, 0) = ?';
  const kindOf = (p) => (p.panorama ? 1 : 0);

  /**
   * Aligns a photo into its spot's common frame (that of the first aligned
   * photo of the same kind). Tries the reference photo first, then aligned
   * photos closest in time, and chains the transforms. Leaves the photo
   * unaligned on failure. Panoramas are aligned by a rotation (sphere.js);
   * photos in arid spots fall back to the skyline (horizon-align.js).
   */
  async function alignPhoto(photoId, refPhotoId = null) {
    const photo = getPhoto.get(photoId);
    if (!photo) return;
    const aligned = db.prepare(
      `SELECT * FROM photos WHERE spot_id = ? AND id != ? AND align_h IS NOT NULL AND ${SAME_KIND}`,
    ).all(photo.spot_id, photo.id, kindOf(photo));
    if (!aligned.length) {
      setAlignment.run(JSON.stringify(IDENTITY), null, photo.id);
      return;
    }
    aligned.sort((a, b) =>
      (b.id === refPhotoId) - (a.id === refPhotoId) ||
      Math.abs(a.taken_at - photo.taken_at) - Math.abs(b.taken_at - photo.taken_at));
    for (const ref of aligned.slice(0, 3)) {
      const files = [path.join(uploadDir, photo.file), path.join(uploadDir, ref.file)];
      if (photo.panorama) {
        const r = await alignPanoramas(...files, { getFeatures: cachedFeatures });
        if (r) {
          setAlignment.run(JSON.stringify(sphere.multiply(JSON.parse(ref.align_h), r.r).map((v) => Math.round(v * 1e9) / 1e9)), r.inliers, photo.id);
          return;
        }
        continue;
      }
      const r = await alignImages(...files, { getFeatures: cachedFeatures });
      if (r) {
        setAlignment.run(JSON.stringify(multiply(JSON.parse(ref.align_h), r.h)), r.inliers, photo.id);
        return;
      }
    }
    // In a dune field nothing stays in place but the skyline (src/horizon-align.js).
    if (!photo.panorama && db.prepare('SELECT landscape FROM spots WHERE id = ?').get(photo.spot_id)?.landscape === 'trocken') {
      for (const ref of aligned.slice(0, 3)) {
        const r = await alignOnHorizon(path.join(uploadDir, photo.file), path.join(uploadDir, ref.file)).catch(() => null);
        if (r) {
          setAlignment.run(JSON.stringify(multiply(JSON.parse(ref.align_h), r.h)), r.columns, photo.id);
          return;
        }
      }
    }
    setAlignment.run(null, null, photo.id);
  }

  async function realignSpot(spotId) {
    db.prepare('UPDATE photos SET align_h = NULL, align_inliers = NULL WHERE spot_id = ?').run(spotId);
    const ids = db.prepare('SELECT id FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(spotId);
    for (const { id } of ids) await alignPhoto(id);
    for (const { id } of ids) {
      await analyzeChange(id);
      refreshIrregularities(id);
    }
  }

  /* ---------- Analysis per photo: classified change and weather context ---------- */

  const setChange = db.prepare('UPDATE photos SET change_json = ? WHERE id = ?');
  const setContext = db.prepare('UPDATE photos SET context_json = ? WHERE id = ?');

  /** Classifies the change of a photo against the spot's first aligned photo of the same kind. */
  async function analyzeChange(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo) return;
    const base = db.prepare(
      `SELECT * FROM photos WHERE spot_id = ? AND align_h IS NOT NULL AND ${SAME_KIND} ORDER BY taken_at, id LIMIT 1`,
    ).get(photo.spot_id, kindOf(photo));
    if (!photo.align_h || !base || base.id === photo.id || base.taken_at > photo.taken_at) {
      setChange.run(null, photoId);
      return;
    }
    const c = changeBetween(base.id, photo.id);
    if (c.error) return setChange.run(null, photoId);
    const r = await c.job;
    setChange.run(JSON.stringify({
      base: base.id,
      baseTakenAt: new Date(base.taken_at).toISOString(),
      fraction: Math.round(r.changedFraction * 1000) / 1000,
      summary: r.summary,
      regions: r.regions,
    }), photoId);
  }

  /* ---------- Tree species per spot ---------- */

  const speciesRows = db.prepare(
    'SELECT scientific_name, source, score, photo_id FROM spot_species WHERE spot_id = ? ORDER BY created_at, id',
  );
  /** Tree species known at a spot, merged across sources (manual and Pl@ntNet). */
  function spotSpecies(spotId) {
    const merged = new Map();
    const terrain = terrainOf(spotId);
    for (const r of speciesRows.all(spotId)) {
      const t = treeInfo(r.scientific_name);
      if (!t) continue;
      const e = merged.get(t.sci) || {
        ...treeJson(t),
        // Expected start of colouring at this spot: regional reference series if loaded, else gradients.
        ...((here) => ({ colourDoyHere: here?.doy ?? expectedColourDoy(t.colourDoy, terrain), colourRef: here?.ref.label ?? null }))(climate.colourHere(spotId, t, terrain)),
        sources: [],
        score: null,
      };
      e.sources.push(r.source);
      if (r.score !== null) e.score = Math.max(e.score ?? 0, r.score);
      merged.set(t.sci, e);
    }
    return [...merged.values()];
  }
  const spotTrees = (spotId) => spotSpecies(spotId).map((s) => treeInfo(s.scientificName));
  const addSpecies = db.prepare(`
    INSERT INTO spot_species (spot_id, scientific_name, source, photo_id, score, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (spot_id, scientific_name, source)
    DO UPDATE SET score = MAX(COALESCE(score, 0), COALESCE(excluded.score, 0)), photo_id = excluded.photo_id
  `);

  /** Elevation, slope and aspect of a spot (each may be null). */
  function terrainOf(spotId) {
    const t = db.prepare('SELECT elevation, slope, aspect, landform, tpi600 FROM spots WHERE id = ?').get(spotId) || {};
    return {
      elevation: t.elevation ?? null,
      slope: t.slope ?? null,
      aspect: t.aspect ?? null,
      landform: t.landform ?? null,
      tpi600: t.tpi600 ?? null,
    };
  }

  /**
   * Makes sure a spot has terrain data. The terrain model gives elevation,
   * slope and aspect in one go; without it the median GPS altitude of the
   * photos stands in for the elevation. Manual values are never overwritten.
   */
  async function ensureElevation(spotId) {
    const spot = db.prepare(
      'SELECT lat, lon, elevation, elevation_source, terrain_source, landform_source, tpi600 FROM spots WHERE id = ?',
    ).get(spotId);
    if (!spot) return null;
    // Also refetch spots analysed before the landform existed.
    if (spot.terrain_source === null || (spot.landform_source === null && spot.tpi600 === null)) {
      try {
        const t = await elevationService.terrain(spot.lat, spot.lon);
        db.prepare("UPDATE spots SET slope = ?, aspect = ?, terrain_source = 'dem' WHERE id = ? AND (terrain_source IS NULL OR terrain_source = 'dem')")
          .run(t.slope, t.aspect, spotId);
        const slope = db.prepare('SELECT slope FROM spots WHERE id = ?').get(spotId).slope;
        db.prepare("UPDATE spots SET tpi300 = ?, tpi600 = ?, landform = ?, landform_source = 'dem' WHERE id = ? AND (landform_source IS NULL OR landform_source = 'dem')")
          .run(t.tpi300, t.tpi600, landform({ tpi300: t.tpi300, tpi600: t.tpi600, slope }), spotId);
        db.prepare("UPDATE spots SET elevation = ?, elevation_source = 'dem' WHERE id = ? AND (elevation IS NULL OR elevation_source = 'gps')")
          .run(t.elevation, spotId);
      } catch {
        // Terrain service unavailable: fall back below and retry next time.
      }
    }
    // With the height known, a spot high above the forest becomes a mountain spot (classifySpot).
    const known = () => { classifySpot(spotId); return terrainOf(spotId).elevation; };
    if (terrainOf(spotId).elevation !== null) return known();
    let value = null;
    let source = null;
    try {
      value = await elevationService.lookup(spot.lat, spot.lon);
      source = 'dem';
    } catch {
      const alts = db.prepare('SELECT altitude FROM photos WHERE spot_id = ? AND altitude IS NOT NULL ORDER BY altitude')
        .all(spotId).map((r) => r.altitude);
      if (alts.length) {
        value = Math.round(alts[Math.floor(alts.length / 2)]);
        source = 'gps';
      }
    }
    if (value !== null) {
      db.prepare('UPDATE spots SET elevation = ?, elevation_source = ? WHERE id = ? AND elevation IS NULL').run(value, source, spotId);
    }
    return known();
  }

  const irregularitiesOf = (photo, ctx) => {
    const species = spotTrees(photo.spot_id);
    const terrain = terrainOf(photo.spot_id);
    // Storm link, frost nights in hollows and phenology references (routes/climate.js).
    const extra = climate.decorate(photo, ctx, terrain, species);
    const found = [...assess({
      takenAt: photo.taken_at,
      tags: tagsOf.all(photo.id).map((t) => t.tag),
      change: photo.change_json ? JSON.parse(photo.change_json) : null,
      weather: ctx.weather,
      species,
      ...terrain,
      nightFrost: extra.nightFrost,
      leafOut: extra.leafOut,
      phenoRef: extra.phenoRef,
    }), ...extra.irregularities];
    // Outside the forest only the weather counts (drought, heat, wet, storms), not leaves, frost on shoots or beetles.
    const landscape = landscapeOf(db.prepare('SELECT landscape FROM spots WHERE id = ?').get(photo.spot_id)?.landscape);
    return landscape === 'wald' ? found : found.filter((i) => WEATHER_IRREGULARITIES.has(i.type));
  };

  /** Species changed: re-evaluate every photo of the spot. */
  function reassessSpot(spotId) {
    for (const { id } of db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(spotId)) refreshIrregularities(id);
  }

  /** Fetches weather for the photo's place and date and records the irregularities. */
  async function analyzeContext(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo) return null;
    let weatherCtx = null;
    let weatherError = null;
    try {
      const elevation = await ensureElevation(photo.spot_id);
      weatherCtx = await weather.context(photo.lat, photo.lon, photo.taken_at, { elevation });
    } catch (err) {
      weatherError = err.message;
    }
    const ctx = {
      computedAt: new Date().toISOString(),
      weather: weatherCtx,
      weatherError,
    };
    await climate.enrich(photo, ctx, { elevation: terrainOf(photo.spot_id).elevation });
    ctx.irregularities = irregularitiesOf(photo, ctx);
    setContext.run(JSON.stringify(ctx), photoId);
    return ctx;
  }

  /** Re-evaluates the irregularities (after tag or change updates) without refetching weather. */
  function refreshIrregularities(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo?.context_json) return;
    const ctx = JSON.parse(photo.context_json);
    ctx.irregularities = irregularitiesOf(photo, ctx);
    setContext.run(JSON.stringify(ctx), photoId);
  }

  // Tours and photo requests (src/routes/tracks.js), registered further down.
  const tours = {};
  // Background work (weather lookups) is tracked so tests and shutdown can wait for it.
  const pending = new Set();
  const background = (promise) => {
    const p = promise.catch((err) => console.error('Hintergrundanalyse fehlgeschlagen:', err.message))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  app.locals.idle = () => Promise.all([...pending]);
  // Previews for photos uploaded before they existed.
  background(thumbs.backfill());
  // Panoramas were once aligned by a homography; their transform is now a rotation. Spots holding a
  // panorama whose stored matrix is no rotation are aligned again.
  const isRotation = (m) => m.length === 9 && sphere.multiply(m, sphere.transpose(m)).every((v, i) => Math.abs(v - sphere.IDENTITY[i]) < 1e-6);
  const staleSpots = [...new Set(db.prepare('SELECT spot_id, align_h FROM photos WHERE panorama = 1 AND align_h IS NOT NULL').all()
    .filter((r) => !isRotation(JSON.parse(r.align_h))).map((r) => r.spot_id))];
  if (staleSpots.length) background((async () => { for (const id of staleSpots) await realignSpot(id); })());

  const safeAlign = (fn) => fn.catch((err) => console.error('Ausrichtung fehlgeschlagen:', err.message));

  const idParam = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Ungültige ID' });
      return null;
    }
    return id;
  };

  const climate = require('./routes/climate')(app, { db, weatherFetch, getPhoto, terrainOf, background, reassessSpot, visibleSpotIds: accounts.visibleSpotIds });

  app.get('/api/config', (req, res) => {
    res.json({
      tags: TAGS, activities: ACTIVITIES, plantnet: Boolean(plantnetKey), spotRadiusM, routing: Boolean(routerUrl), wildlifeZones: wildlife.enabled(),
      landscapes: LANDSCAPES, glaciers: glaciers.enabled() ? { years: glaciers.years() } : null, mapillary: mapillary.enabled(),
    });
  });

  app.get('/api/spots', (req, res) => {
    const tag = req.query.tag ? String(req.query.tag) : null;
    const vis = (alias) => accounts.visibleSql(req, alias); // hidden photos: moderators only
    const rows = db.prepare(`
      SELECT s.id, s.lat, s.lon, s.elevation, s.heading, s.landscape,
             COUNT(DISTINCT p.id) AS photo_count,
             MIN(p.taken_at) AS first_taken,
             MAX(p.taken_at) AS last_taken,
             SUM(COALESCE(p.protected, 0)) AS protected_count,
             GROUP_CONCAT(DISTINCT t.tag) AS tags,
             (SELECT file FROM photos WHERE spot_id = s.id AND ${vis('photos')} ORDER BY taken_at DESC LIMIT 1) AS latest_file,
             (SELECT thumb_file FROM photos WHERE spot_id = s.id AND ${vis('photos')} ORDER BY taken_at DESC LIMIT 1) AS latest_thumb,
             (SELECT change_json FROM photos WHERE spot_id = s.id AND ${vis('photos')} ORDER BY taken_at DESC LIMIT 1) AS latest_change,
             (SELECT context_json FROM photos WHERE spot_id = s.id AND ${vis('photos')} ORDER BY taken_at DESC LIMIT 1) AS latest_context
      FROM spots s
      JOIN photos p ON p.spot_id = s.id AND ${vis('p')}
      LEFT JOIN photo_tags t ON t.photo_id = p.id
      GROUP BY s.id
      HAVING ? IS NULL OR SUM(t.tag = ?) > 0
      ORDER BY s.id
    `).all(tag, tag);
    res.json(rows.map((r) => ({
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      elevation: r.elevation,
      heading: r.heading,
      landscape: landscapeOf(r.landscape),
      photoCount: r.photo_count,
      firstTaken: new Date(r.first_taken).toISOString(),
      lastTaken: new Date(r.last_taken).toISOString(),
      protectedPhotos: r.protected_count || 0,
      tags: r.tags ? r.tags.split(',').sort() : [],
      latestUrl: `/uploads/${r.latest_file}`,
      latestThumbUrl: r.latest_thumb ? `/thumbs/${r.latest_thumb}` : `/uploads/${r.latest_file}`,
      change: r.latest_change ? (({ fraction, summary }) => ({ fraction, top: summary[0]?.label || null }))(JSON.parse(r.latest_change)) : null,
      species: spotSpecies(r.id).map((t) => t.name),
      irregularities: r.latest_context
        ? JSON.parse(r.latest_context).irregularities.filter((i) => i.severity !== 'hinweis').map((i) => i.title)
        : [],
    })));
  });

  /** The spot with the photos `req` may see (without a request: what the public sees). */
  const spotJson = (id, req = null) => {
    const spot = db.prepare(`
      SELECT id, lat, lon, heading, elevation, elevation_source, slope, aspect, terrain_source,
             tpi300, tpi600, landform, landform_source, landscape, landscape_source
      FROM spots WHERE id = ?`).get(id);
    if (!spot) return null;
    const photos = db.prepare(`SELECT * FROM photos p WHERE spot_id = ? AND ${req ? accounts.visibleSql(req, 'p') : accounts.publicSql('p')} ORDER BY taken_at, id`).all(id);
    return {
      id: spot.id,
      lat: spot.lat,
      lon: spot.lon,
      heading: spot.heading,
      landscape: landscapeOf(spot.landscape),
      landscapeSource: spot.landscape_source,
      elevation: spot.elevation,
      elevationSource: spot.elevation_source,
      slope: spot.slope,
      aspect: spot.aspect,
      exposition: spot.terrain_source ? aspectLabel(spot.aspect, spot.slope ?? 0) : null,
      terrainSource: spot.terrain_source,
      landform: spot.landform,
      landformLabel: spot.landform ? LANDFORMS[spot.landform] : null,
      landformSource: spot.landform_source,
      tpi300: spot.tpi300,
      tpi600: spot.tpi600,
      colourShift: {
        altitude: spot.elevation === null ? 0 : altitudeShift(spot.elevation),
        exposition: aspectShift(spot.aspect, spot.slope),
        coldPool: coldPoolShift(spot.landform, spot.tpi600),
      },
      colourShiftDays: spot.elevation === null && spot.terrain_source === null && spot.landform === null ? null
        : altitudeShift(spot.elevation) + aspectShift(spot.aspect, spot.slope) + coldPoolShift(spot.landform, spot.tpi600),
      species: spotSpecies(id),
      photos: photos.map(photoJson),
    };
  };

  app.get('/api/spots/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = spotJson(id, req);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    res.json(spot);
  });

  app.post('/api/spots/:id/align', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!spotJson(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    try {
      await realignSpot(id);
      res.json(spotJson(id, req));
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Splitting a spot with mixed viewing directions ---------- */

  /** The automatic split of a spot by viewing direction (all its photos, hidden ones too). */
  const splitPlan = (id) => planSplit(db.prepare('SELECT id, heading, panorama, taken_at FROM photos WHERE spot_id = ?').all(id)
    .map((p) => ({ id: p.id, heading: p.heading, panorama: Boolean(p.panorama), takenAt: p.taken_at })), headingToleranceDeg);

  /** Proposed groups, as far as `req` may see the photos. */
  app.get('/api/spots/:id/split', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const visible = new Set(db.prepare(`SELECT id FROM photos p WHERE spot_id = ? AND ${accounts.visibleSql(req, 'p')}`).all(id).map((r) => r.id));
    const plan = splitPlan(id);
    res.json({
      mixed: plan.mixed,
      toleranceDeg: headingToleranceDeg,
      groups: plan.groups.map((g) => ({ heading: g.heading, photoIds: g.photoIds.filter((pid) => visible.has(pid)) })),
    });
  });

  /**
   * Splits the spot: by viewing direction (no body), or `{ photoIds }` move
   * into a new spot. The spots are aligned and compared again afterwards.
   */
  app.post('/api/spots/:id/split', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const all = db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(id).map((r) => r.id);
    let groups;
    if (req.body?.photoIds !== undefined) {
      const chosen = [...new Set(Array.isArray(req.body.photoIds) ? req.body.photoIds.map(Number) : [])];
      if (!chosen.length || !chosen.every((pid) => all.includes(pid))) return res.status(400).json({ error: 'photoIds: Fotos dieses Spots angeben' });
      if (chosen.length === all.length) return res.status(400).json({ error: 'Mindestens ein Foto muss im Spot bleiben' });
      groups = [all.filter((pid) => !chosen.includes(pid)), chosen];
    } else {
      const plan = splitPlan(id);
      if (!plan.mixed) return res.status(422).json({ error: 'Die Fotos dieses Spots blicken alle in dieselbe Richtung' });
      groups = plan.groups.map((g) => g.photoIds);
    }
    try {
      const ids = transaction(db, () => splitSpot(db, id, groups));
      // Each spot gets its own frame for alignment and change detection.
      for (const sid of ids) await realignSpot(sid);
      res.json({ spots: ids.map((sid) => spotJson(sid, req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return res.status(400).json({ error: `Upload fehlgeschlagen: ${err.message}` });
      handleUpload(req, res).catch(next);
    });
  });

  async function handleUpload(req, res) {
    const files = req.files?.photos || [];
    const gpxFile = req.files?.gpx?.[0];
    let status;
    let body;
    try {
      [status, body] = await processUpload(files, gpxFile, req.body || {}, req);
    } finally {
      // Temp files of skipped photos (and the GPX) are removed before answering.
      await Promise.all([...files, ...(gpxFile ? [gpxFile] : [])].map((f) => fsp.rm(f.path, { force: true })));
    }
    res.status(status).json(body);
  }

  /**
   * Sets the landscape profile of a spot: `chosen` (from an upload, or by hand
   * with source 'manual') when the spot has none yet or only a guessed one;
   * without a choice a spot on or near a glacier becomes a glacier spot, one
   * above `mountainMinM` (once its height is known) a mountain spot.
   * A profile set by hand is only changed by hand. Runs inside a transaction.
   */
  /** Tree species or forest observations at a spot: a larch wood at 2200 m stays forest. */
  const forestSigns = (spotId) => Boolean(db.prepare('SELECT 1 FROM spot_species WHERE spot_id = ? LIMIT 1').get(spotId)
    || db.prepare(`SELECT 1 FROM photo_tags t JOIN photos p ON p.id = t.photo_id WHERE p.spot_id = ? AND t.tag IN (${FOREST_ONLY_TAGS.map(() => '?').join(',')}) LIMIT 1`)
      .get(spotId, ...FOREST_ONLY_TAGS));

  function classifySpot(spotId, chosen = null, source = 'upload') {
    const spot = db.prepare('SELECT lat, lon, elevation, landscape, landscape_source FROM spots WHERE id = ?').get(spotId);
    if (!spot) return;
    let next = null;
    if (chosen && (source === 'manual' || spot.landscape === null || spot.landscape_source === 'auto')) next = [chosen, source];
    else if (!chosen && spot.landscape === null && glaciers.isGlacierPlace(spot.lat, spot.lon)) next = ['gletscher', 'auto'];
    else if (!chosen && spot.landscape === null && mountainMinM > 0 && spot.elevation >= mountainMinM && !forestSigns(spotId)) next = ['gebirge', 'auto'];
    if (!next || (next[0] === spot.landscape && next[1] === spot.landscape_source)) return;
    db.prepare('UPDATE spots SET landscape = ?, landscape_source = ? WHERE id = ?').run(next[0], next[1], spotId);
    // A glacier spot needs the snow and ice share of its satellite scenes.
    if (ICE_LANDSCAPES.has(next[0]) && !ICE_LANDSCAPES.has(spot.landscape)) vegetation.satelliteDue(spotId);
    // Changes are classified per landscape (forest classes only in the forest): evaluate the photos again.
    if (landscapeOf(next[0]) !== landscapeOf(spot.landscape)) {
      const photos = db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(spotId);
      if (photos.length) {
        background((async () => {
          for (const { id } of photos) {
            await analyzeChange(id);
            refreshIrregularities(id);
          }
        })());
      }
    }
  }

  /** A drive picture by the same account near this place within DRIVE_REPEAT_MS? */
  function driveRepeat(userId, pos, takenAt) {
    const dLat = spotRadiusM / 111320;
    const dLon = dLat / Math.cos((pos.lat * Math.PI) / 180);
    return Boolean(db.prepare(`SELECT 1 FROM photos WHERE activity = 'fahren' AND uploader_id = ?
      AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND taken_at BETWEEN ? AND ? LIMIT 1`)
      .get(userId, pos.lat - dLat, pos.lat + dLat, pos.lon - dLon, pos.lon + dLon, takenAt - DRIVE_REPEAT_MS, takenAt + DRIVE_REPEAT_MS));
  }

  async function processUpload(files, gpxFile, b, req) {
    if (!files.length) return [400, { error: 'Keine Fotos übermittelt' }];
    const owner = accounts.uploadOwner(req); // uploader and licence
    if (owner.error) return [400, { error: owner.error }];

    const offsetMin = Number.isFinite(Number(b.utcOffsetMinutes)) ? Number(b.utcOffsetMinutes) : 0;
    const clockShiftMs = (Number(b.clockShiftSeconds) || 0) * 1000;
    const manual = b.lat !== undefined && b.lat !== '' ? { lat: Number(b.lat), lon: Number(b.lon) } : null;
    if (manual && !isValidCoord(manual.lat, manual.lon)) {
      return [400, { error: 'Ungültige Koordinaten' }];
    }
    const fallbackTime = b.takenAt ? Date.parse(b.takenAt) : NaN;
    const activity = ACTIVITIES.includes(b.activity) ? b.activity : null;
    const note = b.note ? String(b.note).slice(0, 2000) : null;
    // Photos of one recording (drive, upload batch) form a sequence for the walk-through.
    const sequenceId = /^[A-Za-z0-9-]{8,64}$/.test(String(b.sequenceId || '')) ? String(b.sequenceId) : null;
    const tags = parseTags(b.tags);
    const landscape = isLandscape(b.landscape) ? b.landscape : null;
    // Archive pictures (old photos, scanned) for a spot: dated by hand, placed at the spot.
    const archive = ['1', 'true', 'on'].includes(String(b.archive));
    if (archive && (!Number.isFinite(fallbackTime) || b.spotId === undefined || b.spotId === '')) {
      return [400, { error: 'Archivfoto: spotId und takenAt angeben' }];
    }
    const protect = ['1', 'true', 'on'].includes(String(b.protected));
    // Repeat photos taken at a known spot (rephotography) are pinned to that spot.
    let targetSpot = null;
    if (b.spotId !== undefined && b.spotId !== '') {
      const sid = Number(b.spotId);
      targetSpot = Number.isSafeInteger(sid) && sid > 0
        ? db.prepare('SELECT id, lat, lon FROM spots WHERE id = ?').get(sid)
        : null;
      if (!targetSpot) return [400, { error: 'Spot nicht gefunden' }];
    }
    const refPhotoId = Number.isSafeInteger(Number(b.refPhotoId)) ? Number(b.refPhotoId) : null;
    // View direction from the device (drive mode: the course) when the picture has none in its EXIF.
    const sentHeading = b.heading !== undefined && b.heading !== '' && Number.isFinite(Number(b.heading)) ? ((Number(b.heading) % 360) + 360) % 360 : null;
    const nearSpot = (p) => distanceM(p, targetSpot) <= Math.max(4 * spotRadiusM, 100);
    const track = gpxFile ? parseTrackPoints(await fsp.readFile(gpxFile.path)) : [];
    if (gpxFile && !track.length) {
      return [400, { error: 'GPX-Datei enthält keine Punkte mit Zeitstempel' }];
    }

    const created = [];
    const skipped = [];
    const touchedSpots = new Set();
    const requestsDone = new Set();
    for (const f of files) {
      const buf = await fsp.readFile(f.path);
      // iPhone photos (HEIC) are stored as JPEG; their EXIF is read from the original.
      const heic = isHeic(buf);
      const ext = heic ? 'jpg' : imageExtension(buf);
      if (!ext) {
        skipped.push({ name: f.originalname, reason: 'Kein unterstütztes Bildformat (JPEG, PNG, WebP, HEIC)' });
        continue;
      }
      const meta = await readPhotoMeta(heic ? heicExif(buf) || buf : buf, offsetMin);
      let takenAt = meta.takenAt !== null ? meta.takenAt + clockShiftMs : null;
      // An archive picture (a scan of an old photo): its EXIF date is the scan's, the given date counts.
      if (archive) takenAt = fallbackTime;
      if (takenAt === null) takenAt = Number.isFinite(fallbackTime) ? fallbackTime : Date.now();

      let pos = null;
      let source = null;
      const exifPos = isValidCoord(meta.lat, meta.lon) ? { lat: meta.lat, lon: meta.lon } : null;
      if (targetSpot) {
        // Keep the device position when it is plausible, otherwise use the spot centre.
        if (archive) [pos, source] = [{ lat: targetSpot.lat, lon: targetSpot.lon }, 'spot'];
        else if (exifPos && nearSpot(exifPos)) [pos, source] = [exifPos, 'exif'];
        else if (manual && nearSpot(manual)) [pos, source] = [manual, 'spot'];
        else [pos, source] = [{ lat: targetSpot.lat, lon: targetSpot.lon }, 'spot'];
      } else if (exifPos) {
        pos = exifPos;
        source = 'exif';
      } else if (track.length && meta.takenAt !== null && (pos = positionAt(track, takenAt))) {
        source = 'gpx';
      } else if (manual) {
        pos = manual;
        source = 'manual';
      }
      if (!pos) {
        skipped.push({
          name: f.originalname,
          reason: track.length
            ? 'Aufnahmezeit liegt ausserhalb des GPX-Tracks und kein Standort gewählt'
            : 'Kein GPS im Foto – bitte GPX-Track hochladen oder Standort auf der Karte wählen',
        });
        continue;
      }

      let jpeg = null;
      if (heic) {
        try {
          jpeg = await heicToJpeg(buf);
        } catch (err) {
          skipped.push({ name: f.originalname, reason: `HEIC-Datei konnte nicht gelesen werden (${err.message})` });
          continue;
        }
      }
      // 360° panorama: as the camera declares it (GPano), else a large 2:1 image.
      const dims = await sharp(jpeg || buf).metadata().catch(() => ({}));
      const panorama = meta.projection ? meta.projection === 'equirectangular' : isPanoramaSize(dims.width, dims.height);
      // A panorama looks everywhere: its heading (centre of the image) says nothing about which spot it belongs to.
      const heading = panorama ? (meta.poseHeading ?? meta.heading) : (meta.heading ?? sentHeading);
      // Drive mode picks its pictures on the device; this catches what still repeats
      // (a second device, a resent queue): one picture per account, place and half day.
      if (activity === 'fahren' && owner.userId && driveRepeat(owner.userId, pos, takenAt)) {
        skipped.push({ name: f.originalname, reason: 'Fahrt: hier gibt es von dir schon ein Bild aus den letzten Stunden' });
        continue;
      }
      const file = `${crypto.randomUUID()}.${ext}`;
      if (jpeg) await fsp.writeFile(path.join(uploadDir, file), jpeg);
      else await fsp.rename(f.path, path.join(uploadDir, file));
      const photoId = transaction(db, () => {
        const spotId = targetSpot ? targetSpot.id
          : assignSpot(db, pos.lat, pos.lon, spotRadiusM, panorama ? null : heading, headingToleranceDeg);
        const id = Number(db.prepare(`
          INSERT INTO photos (spot_id, file, original_name, taken_at, lat, lon, heading, altitude,
                              location_source, activity, note, created_at, panorama, sequence_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(spotId, file, f.originalname.slice(0, 255), takenAt, pos.lat, pos.lon, heading, meta.altitude,
          source, activity, note, Date.now(), panorama ? 1 : 0, sequenceId).lastInsertRowid);
        setTags(id, tags);
        accounts.stampPhoto(id, owner);
        if (protect) db.prepare("UPDATE photos SET protected = 1, protected_reason = 'upload' WHERE id = ?").run(id);
        if (archive) db.prepare('UPDATE photos SET archive = 1 WHERE id = ?').run(id);
        refreshSpot(db, spotId);
        classifySpot(spotId, landscape, 'upload');
        touchedSpots.add(spotId);
        return id;
      });
      await thumbs.ensure(getPhoto.get(photoId));
      await safeAlign(alignPhoto(photoId, refPhotoId));
      await safeAlign(analyzeChange(photoId));
      background(analyzeContext(photoId));
      vegetation.backfill(null, [photoId]);
      for (const r of tours.fulfil(photoId, b.requestId)) requestsDone.add(r);
      created.push(photoJson(getPhoto.get(photoId)));
    }
    return [created.length ? 201 : 422, { created, skipped, spots: [...touchedSpots], requestsDone: [...requestsDone] }];
  }

  app.patch('/api/photos/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    const body = req.body || {};
    transaction(db, () => {
      if (body.tags !== undefined) setTags(id, parseTags(body.tags));
      if (body.note !== undefined) {
        db.prepare('UPDATE photos SET note = ? WHERE id = ?').run(body.note ? String(body.note).slice(0, 2000) : null, id);
      }
    });
    refreshIrregularities(id);
    res.json(photoJson(getPhoto.get(id)));
  });

  /** Deletes a photo with its files and re-evaluates the rest of its spot. */
  async function removePhoto(photo) {
    transaction(db, () => {
      db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
      refreshSpot(db, photo.spot_id);
    });
    await fsp.rm(path.join(uploadDir, photo.file), { force: true });
    await thumbs.remove(photo);
    // The spot's first photo may have gone: re-evaluate the others' change.
    const rest = db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(photo.spot_id);
    background((async () => {
      for (const { id: other } of rest) {
        await analyzeChange(other);
        refreshIrregularities(other);
      }
    })());
  }
  accountsCtx.removePhoto = removePhoto; // deleting an account with its photos

  app.delete('/api/photos/:id', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    await removePhoto(photo);
    res.status(204).end();
  });

  /* ---------- Weather of a single day (sun & weather map mode) ---------- */

  const parseDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

  app.get('/api/weather/day', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const date = parseDate(req.query.date);
    if (!isValidCoord(lat, lon) || !date) return res.status(400).json({ error: 'lat, lon und date (JJJJ-MM-TT) angeben' });
    const elevation = req.query.elevation !== undefined && req.query.elevation !== '' ? Number(req.query.elevation) : null;
    try {
      res.json(await weather.day(lat, lon, date, { elevation: Number.isFinite(elevation) ? elevation : null }));
    } catch (err) {
      res.json({ date, source: null, hourly: [], totals: null, error: err.message });
    }
  });

  /** Daily precipitation at every spot for a date; spots in one ~10 km cell share a lookup. */
  app.get('/api/weather/day/spots', async (req, res) => {
    const date = parseDate(req.query.date);
    if (!date) return res.status(400).json({ error: 'date (JJJJ-MM-TT) angeben' });
    const spots = db.prepare(`SELECT id, lat, lon FROM spots s WHERE EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${accounts.visibleSql(req, 'p')})`).all();
    const byCell = new Map();
    for (const s of spots) {
      const key = `${s.lat.toFixed(1)},${s.lon.toFixed(1)}`;
      if (!byCell.has(key)) byCell.set(key, { lat: s.lat, lon: s.lon, ids: [] });
      byCell.get(key).ids.push(s.id);
    }
    const out = [];
    let source = null;
    for (const c of byCell.values()) {
      let precip = null;
      try {
        const d = await weather.day(c.lat, c.lon, date);
        precip = d.totals?.precip ?? null;
        source = source || d.source;
      } catch {
        // Leave this cell without a value.
      }
      for (const id of c.ids) out.push({ spotId: id, precip });
    }
    res.json({ date, source, spots: out });
  });

  /** Terrain horizon (36 directions) and sky view factor around a place; `{ angles: null, error }` when unavailable. */
  app.get('/api/horizon', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!isValidCoord(lat, lon)) return res.status(400).json({ error: 'lat und lon angeben' });
    try {
      res.json({ source: 'dem', ...(await elevationService.horizon(lat, lon)) });
    } catch (err) {
      res.json({ source: null, angles: null, error: err.message });
    }
  });

  app.get('/api/trees', (req, res) => {
    res.json(TREES.map(treeJson).sort((a, b) => a.name.localeCompare(b.name, 'de')));
  });

  /** Sets the spot's elevation by hand (`{ elevation: 950 }`), or `null` to determine it again. */
  app.patch('/api/spots/:id', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const body = req.body || {};
    const hasElevation = Object.prototype.hasOwnProperty.call(body, 'elevation');
    const hasExposition = Object.prototype.hasOwnProperty.call(body, 'exposition');
    const value = body.elevation;
    if (hasElevation && value !== null && !(Number.isFinite(value) && value > -500 && value < 5000)) {
      return res.status(400).json({ error: 'Höhe muss eine Zahl zwischen -500 und 5000 m sein' });
    }
    const expo = body.exposition;
    if (hasExposition && expo !== null && expo !== 'eben' && !COMPASS.includes(expo)) {
      return res.status(400).json({ error: `Exposition muss eben, ${COMPASS.join(', ')} oder null sein` });
    }
    const hasLandform = Object.prototype.hasOwnProperty.call(body, 'landform');
    const form = body.landform;
    if (hasLandform && form !== null && !Object.hasOwn(LANDFORMS, form)) {
      return res.status(400).json({ error: `Geländeform muss ${Object.keys(LANDFORMS).join(', ')} oder null sein` });
    }
    if (!hasElevation && !hasExposition && !hasLandform) {
      return res.status(400).json({ error: 'elevation, exposition oder landform angeben' });
    }
    try {
      if (hasElevation) {
        db.prepare('UPDATE spots SET elevation = ?, elevation_source = ? WHERE id = ?')
          .run(value === null ? null : Math.round(value), value === null ? null : 'manual', id);
      }
      if (hasExposition) {
        // A chosen exposition stands for a clearly inclined slope (20°); "eben" for flat ground.
        if (expo === null) db.prepare('UPDATE spots SET slope = NULL, aspect = NULL, terrain_source = NULL WHERE id = ?').run(id);
        else db.prepare("UPDATE spots SET slope = ?, aspect = ?, terrain_source = 'manual' WHERE id = ?")
          .run(expo === 'eben' ? 0 : 20, expo === 'eben' ? null : aspectFromCompass(expo), id);
      }
      if (hasLandform) {
        // A hand-set landform has no measured TPI; the cold-pool shift then uses a typical value.
        if (form === null) db.prepare('UPDATE spots SET tpi300 = NULL, tpi600 = NULL, landform = NULL, landform_source = NULL WHERE id = ?').run(id);
        else db.prepare("UPDATE spots SET landform = ?, landform_source = 'manual', tpi600 = NULL, tpi300 = NULL WHERE id = ?").run(form, id);
      }
      if (value === null || expo === null || form === null) await ensureElevation(id);
      else classifySpot(id); // a height set by hand may make it a mountain spot
      reassessSpot(id);
      // Weather is downscaled to the altitude: refresh the spot's contexts in the background.
      for (const { id: photoId } of db.prepare('SELECT id FROM photos WHERE spot_id = ? AND context_json IS NOT NULL').all(id)) {
        background(analyzeContext(photoId));
      }
      res.json(spotJson(id, req));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/spots/:id/species', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const tree = treeInfo(req.body?.scientificName);
    if (!tree) return res.status(400).json({ error: 'Unbekannte Baumart' });
    addSpecies.run(id, tree.sci, 'manual', null, null, Date.now());
    reassessSpot(id);
    res.status(201).json(spotSpecies(id));
  });

  app.delete('/api/spots/:id/species', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const tree = treeInfo(req.query.name);
    if (!tree) return res.status(400).json({ error: 'Unbekannte Baumart' });
    db.prepare('DELETE FROM spot_species WHERE spot_id = ? AND scientific_name = ?').run(id, tree.sci);
    reassessSpot(id);
    res.json(spotSpecies(id));
  });

  app.get('/api/photos/:id/context', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const stored = photo.context_json ? JSON.parse(photo.context_json) : null;
      // Retry missing weather after an hour; recent periods may still have been incomplete.
      const stale = !stored || (!stored.weather && Date.now() - Date.parse(stored.computedAt) > 3600000);
      res.json(stale ? await analyzeContext(id) : stored);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos/:id/context', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!getPhoto.get(id)) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      res.json(await analyzeContext(id));
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Change detection between two aligned photos ---------- */

  const changeCache = new Map();
  /** Change between photo `fromId` (before, defines the view) and `toId`. */
  function changeBetween(fromId, toId) {
    const a = getPhoto.get(fromId);
    const b = getPhoto.get(toId);
    if (!a || !b) return { status: 404, error: 'Foto nicht gefunden' };
    if (a.spot_id !== b.spot_id) return { status: 422, error: 'Fotos gehören zu verschiedenen Spots' };
    if (kindOf(a) !== kindOf(b)) return { status: 422, error: 'Ein 360°-Panorama lässt sich nicht mit einem normalen Foto vergleichen' };
    if (!a.align_h || !b.align_h) return { status: 422, error: 'Mindestens eines der Fotos ist nicht ausgerichtet' };
    // The forest classes only apply in the forest (src/landscapes.js).
    const forest = landscapeOf(db.prepare('SELECT landscape FROM spots WHERE id = ?').get(a.spot_id)?.landscape) === 'wald';
    const key = `${a.id}:${b.id}:${a.align_h}:${b.align_h}:${app.locals.learner?.version() ?? ''}:${forest}`;
    if (!changeCache.has(key)) {
      const panorama = Boolean(a.panorama);
      // B onto A: through the spot's frame (rotations invert by transposing).
      const hBtoA = panorama
        ? sphere.multiply(sphere.transpose(JSON.parse(a.align_h)), JSON.parse(b.align_h))
        : (invert(JSON.parse(a.align_h)) && multiply(invert(JSON.parse(a.align_h)), JSON.parse(b.align_h)));
      const job = (async () => {
        if (!hBtoA) throw new Error('Ausrichtung nicht invertierbar');
        const result = await computeChange(path.join(uploadDir, a.file), path.join(uploadDir, b.file), hBtoA, { panorama });
        // Keep only what the routes need; the per-pixel scores are large.
        return {
          changedFraction: result.changedFraction,
          coverage: result.coverage,
          ...(forest ? (c) => c : unclassified)(classifyChange(result, { model: app.locals.learner?.current() })),
          png: await renderHeatmap(result),
        };
      })();
      job.catch(() => changeCache.delete(key));
      changeCache.set(key, job);
      if (changeCache.size > 30) changeCache.delete(changeCache.keys().next().value);
    }
    return { job: changeCache.get(key) };
  }

  const changeRoute = (handler) => async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const to = Number(req.query.to);
    if (!Number.isSafeInteger(to) || to <= 0) return res.status(400).json({ error: 'Parameter "to" fehlt' });
    const c = changeBetween(id, to);
    if (c.error) return res.status(c.status).json({ error: c.error });
    try {
      handler(res, await c.job, id, to);
    } catch (err) {
      next(err);
    }
  };

  app.get('/api/photos/:id/change', changeRoute((res, r, id, to) => {
    res.json({
      from: id,
      to,
      changedFraction: Math.round(r.changedFraction * 1000) / 1000,
      coverage: Math.round(r.coverage * 1000) / 1000,
      heatmap: `/api/photos/${id}/change.png?to=${to}`,
      summary: r.summary,
      regions: r.regions,
    });
  }));

  app.get('/api/photos/:id/change.png', changeRoute((res, r) => {
    if (!/no-store/.test(res.get('Cache-Control') || '')) res.set('Cache-Control', 'private, max-age=300');
    res.type('png').send(r.png);
  }));

  /*
   * A 360° panorama turned into the orientation of another panorama of the
   * spot (`frame`), so both look in the same direction: what the viewer, the
   * comparison and "stabilise" show instead of a CSS homography.
   */
  const alignedCache = new Map();
  const PANO_VIEW = [2048, 1024];
  app.get('/api/photos/:id/aligned.jpg', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    const frame = getPhoto.get(Number(req.query.frame));
    if (!photo || !frame) return res.status(404).json({ error: 'Foto nicht gefunden' });
    if (!photo.panorama || !frame.panorama || photo.spot_id !== frame.spot_id) {
      return res.status(422).json({ error: 'Nur für 360°-Panoramen desselben Spots' });
    }
    if (!photo.align_h || !frame.align_h) return res.status(422).json({ error: 'Mindestens eines der Panoramen ist nicht ausgerichtet' });
    const key = `${photo.id}:${frame.id}:${photo.align_h}:${frame.align_h}`;
    const etag = `"${crypto.createHash('sha1').update(key).digest('base64url')}"`;
    res.set({ 'Cache-Control': 'private, max-age=86400', ETag: etag });
    if (req.get('if-none-match') === etag) return res.status(304).end();
    try {
      if (!alignedCache.has(key)) {
        const job = (async () => {
          const [w, h] = PANO_VIEW;
          const { data } = await sharp(path.join(uploadDir, photo.file)).rotate().resize(w, h, { fit: 'fill' })
            .removeAlpha().raw().toBuffer({ resolveWithObject: true });
          // Frame direction d → frame onto the spot frame → back into the photo: Rphotoᵀ · Rframe.
          const rFrameToPhoto = sphere.multiply(sphere.transpose(JSON.parse(photo.align_h)), JSON.parse(frame.align_h));
          return sharp(sphere.remap({ data, width: w, height: h }, rFrameToPhoto, w, h), { raw: { width: w, height: h, channels: 3 } })
            .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        })();
        job.catch(() => alignedCache.delete(key));
        alignedCache.set(key, job);
        if (alignedCache.size > 8) alignedCache.delete(alignedCache.keys().next().value);
      }
      res.type('jpeg').send(await alignedCache.get(key));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos/:id/identify', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!plantnetKey) return res.status(501).json({ error: 'Pflanzenerkennung nicht konfiguriert (PLANTNET_API_KEY)' });
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const organ = ['leaf', 'flower', 'fruit', 'bark', 'habit', 'auto'].includes(req.body?.organ) ? req.body.organ : 'auto';
      const results = await identifyPlant(path.join(uploadDir, photo.file), { apiKey: plantnetKey, organ, fetchImpl });
      // Cantonal protection lists apply where the spot is (unknown canton: any canton's list counts).
      const canton = await cantons.ofSpot(photo.spot_id);
      transaction(db, () => {
        db.prepare('DELETE FROM identifications WHERE photo_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const r of results) ins.run(id, r.scientificName, r.commonName, r.score, r.neophyte, Date.now());
        if (results.some((r) => r.neophyte && r.score >= NEOPHYTE_MIN_SCORE)) {
          db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(id, 'neophyt');
        }
        // Rare and collected species: the find is protected (src/sensitive.js), unless released by hand before.
        if (results.some((r) => sensitiveLists.isSensitive(r.scientificName, canton) && r.score >= NEOPHYTE_MIN_SCORE)) {
          db.prepare("UPDATE photos SET protected = 1, protected_reason = 'art' WHERE id = ? AND protected = 0 AND protected_reason IS NULL").run(id);
        }
        // Confidently recognised trees join the spot's species inventory.
        for (const r of results) {
          const tree = treeInfo(r.scientificName);
          if (tree && r.score >= TREE_MIN_SCORE) addSpecies.run(photo.spot_id, tree.sci, 'plantnet', id, r.score, Date.now());
        }
      });
      reassessSpot(photo.spot_id);
      res.json(photoJson(getPhoto.get(id)));
    } catch (err) {
      next(err);
    }
  });

  require('./routes/species')(app, { db, spotRadiusM, visibleSql: accounts.visibleSql });
  require('./routes/profile')(app, { db, thumbs, accounts, uploadDir, rateLimits });
  require('./routes/protection')(app, { db, accounts, sensitiveLists, cantons, reprotect });
  /**
   * How photo `a` lies in photo `b` for a walk step with depth: between flat photos a normalised homography
   * a → b, between panoramas the rotation of the sphere taking a's directions onto b's. From the alignment when
   * both are aligned in the same spot's frame, else by matching their features.
   */
  async function photoTransition(a, b) {
    if (a.panorama && b.panorama) {
      const frame = a.spot_id === b.spot_id && a.align_h && b.align_h;
      if (frame) return { h: sphere.multiply(sphere.transpose(JSON.parse(b.align_h)), JSON.parse(a.align_h)).map((v) => Math.round(v * 1e9) / 1e9), inliers: null };
      const r = await alignPanoramas(path.join(uploadDir, a.file), path.join(uploadDir, b.file), { getFeatures: cachedFeatures });
      return r ? { h: r.r, inliers: r.inliers } : null;
    }
    const back = a.spot_id === b.spot_id && a.align_h && b.align_h ? invert(JSON.parse(b.align_h)) : null;
    if (back) return { h: multiply(back, JSON.parse(a.align_h)).map((v) => Math.round(v * 1e9) / 1e9), inliers: null };
    return alignImages(path.join(uploadDir, a.file), path.join(uploadDir, b.file), { getFeatures: cachedFeatures });
  }
  require('./routes/walk')(app, { db, accounts, thumbs, mapillary, waynet, transition: photoTransition });
  require('./routes/ogc')(app, { db, spotRadiusM, dataDir, background, tiles: tileOptions });
  require('./routes/video')(app, { db, uploadDir, tmpDir, spotRadiusM, activities: ACTIVITIES, photoJson, getPhoto, setTags, alignPhoto, analyzeChange, analyzeContext, background, safeAlign, classifySpot });
  const push = require('./routes/push')(app, { db, idParam, adminEmail, ...pushOptions });
  app.locals.push = push;
  const vegetation = require('./routes/vegetation')(app, { db, uploadDir, background, fetchImpl: weatherFetch, push, accounts });
  // Storm warnings from the forecast and "visit after the storm" (push to followers and regular visitors).
  const stormWatch = createStormWatch({ db, fetchImpl: weatherFetch, push, storms: createStorms({ db, fetchImpl: weatherFetch }) });
  app.locals.stormWatch = () => stormWatch.run();
  app.get('/api/storm-warnings', (req, res) => {
    res.json({ model: stormWatch.model, threshold: stormWatch.threshold, warnings: stormWatch.list() });
  });
  if (stormWarnHours > 0) {
    const tick = () => stormWatch.run().catch((err) => console.error('Sturmwarnungen:', err.message));
    setTimeout(tick, 5 * 60000).unref?.();
    setInterval(tick, stormWarnHours * 3600000).unref?.();
  }
  // Spots from before the profiles (or the glacier outlines) existed.
  for (const { id } of db.prepare('SELECT id FROM spots WHERE landscape IS NULL AND (? OR elevation >= ?)').all(glaciers.enabled() ? 1 : 0, mountainMinM > 0 ? mountainMinM : 1e9)) {
    classifySpot(id);
  }
  require('./routes/landscapes')(app, {
    db, glaciers, glamos: createGlamos({ files: glamosFiles }), archives: createArchives({ files: archiveFiles, fetchImpl: archiveFetch }),
    processUpload, tmpDir, vegetation, accounts, classifySpot, spotJson, idParam,
  });
  Object.assign(tours, require('./routes/tracks')(app, {
    db, spotRadiusM, satelliteAlerts: vegetation.alerts, routerUrl, routerFetch, routerProfile, accounts, wildlife, elevation: elevationService, push,
    weather,
  }));
  require('./routes/analysis')(app, {
    db, uploadDir, getPhoto, idParam, background, changeBetween, spotTrees, terrainOf, refreshIrregularities, detectorUrl, detectorFetch,
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Interner Fehler' });
  });

  return app;
}

module.exports = { createApp, parseTrustProxy };

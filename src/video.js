'use strict';

const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { distanceM } = require('./geo');

/**
 * Video → photos: decides which moments of a video become photos (every N
 * metres travelled, or every N seconds without a track), works out their
 * position, time and viewing direction, and extracts the frames with ffmpeg.
 */

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Initial compass bearing (° from north) from a to b. */
function bearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Averages a dense track ([{ t, lat, lon, alt? }], t in seconds) into one point
 * per `stepS` seconds. GoPro records GPS at 10–18 Hz; averaging removes most
 * of the jitter that would otherwise add up to phantom distance when standing.
 */
function resample(points, stepS = 1) {
  const buckets = new Map();
  for (const p of points) {
    const k = Math.floor(p.t / stepS);
    const b = buckets.get(k) || { t: 0, lat: 0, lon: 0, alt: 0, nAlt: 0, n: 0 };
    b.t += p.t; b.lat += p.lat; b.lon += p.lon; b.n++;
    if (Number.isFinite(p.alt)) { b.alt += p.alt; b.nAlt++; }
    buckets.set(k, b);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => {
    const b = buckets.get(k);
    return { t: b.t / b.n, lat: b.lat / b.n, lon: b.lon / b.n, alt: b.nAlt ? b.alt / b.nAlt : null };
  });
}

/** Adds the cumulative distance `d` (m) to each track point. */
function withDistance(track) {
  let d = 0;
  return track.map((p, i) => {
    if (i) d += distanceM(track[i - 1], p);
    return { ...p, d };
  });
}

/** Interpolates a track (with `d`) at distance `dist`: { t, lat, lon, alt }. */
function atDistance(track, dist) {
  if (dist <= track[0].d) return track[0];
  const last = track[track.length - 1];
  if (dist >= last.d) return last;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].d <= dist) lo = mid; else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = b.d > a.d ? (dist - a.d) / (b.d - a.d) : 0;
  const lerp = (x, y) => (x === null || y === null ? x ?? y : x + (y - x) * f);
  return { t: lerp(a.t, b.t), lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), alt: lerp(a.alt ?? null, b.alt ?? null) };
}

/**
 * Plans frames along a track. Existing spots the track passes within
 * `radiusM` (`anchors`, [{ lat, lon }]) get a frame at the closest approach,
 * so repeated runs keep feeding the same spots. In between, a frame is taken
 * every `everyM` metres travelled, skipping places closer than `radiusM` to
 * a frame already planned, so each frame starts or joins a spot of its own.
 * Each frame gets the video time `t`, position, altitude and the direction
 * of travel (bearing over ±`headingSpanM`). `duration` (s) bounds the times.
 */
function planByDistance(points, {
  everyM = 25, radiusM = everyM, anchors = [], maxFrames = 300, duration = Infinity, headingSpanM = 8,
} = {}) {
  const track = withDistance(resample(points).filter((p) => p.t >= 0 && p.t <= duration));
  if (track.length < 2) return [];
  const total = track[track.length - 1].d;
  const chosen = [];

  for (const a of anchors) {
    let best = null;
    for (const p of track) {
      const d = distanceM(p, a);
      if (!best || d < best.dist) best = { dist: d, at: p.d };
    }
    if (best && best.dist <= radiusM) chosen.push({ d: best.at, ...atDistance(track, best.at), anchor: true });
  }
  const conflicts = (p) => chosen.some((c) => distanceM(c, p) <= radiusM + 1);
  for (let dist = 0; dist <= total && chosen.length < maxFrames;) {
    const p = atDistance(track, dist);
    if (conflicts(p)) {
      dist += 2;
      continue;
    }
    chosen.push({ d: dist, ...p, anchor: false });
    dist += everyM;
  }

  return chosen.sort((a, b) => a.t - b.t).slice(0, maxFrames).map((c) => {
    const before = atDistance(track, Math.max(0, c.d - headingSpanM));
    const after = atDistance(track, Math.min(total, c.d + headingSpanM));
    const moved = distanceM(before, after) >= 2;
    return {
      t: Math.min(Math.max(c.t, 0), Math.max(duration - 0.05, 0)),
      lat: c.lat,
      lon: c.lon,
      alt: c.alt ?? null,
      heading: moved ? Math.round(bearing(before, after) * 10) / 10 : null,
      distanceM: Math.round(c.d),
      atSpot: c.anchor,
    };
  });
}

/** Plans frames every `everyS` seconds (no track): only times. */
function planByTime(duration, { everyS = 10, maxFrames = 300 } = {}) {
  const frames = [];
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  for (let t = 0; (t < end || t === 0) && frames.length < maxFrames; t += everyS) {
    frames.push({ t: Math.min(t, Math.max(end - 0.05, 0)), lat: null, lon: null, alt: null, heading: null, distanceM: null });
  }
  return frames;
}

/** Equirectangular 360° frames are exactly 2:1. */
const isEquirectangular = (w, h) => w > 0 && h > 0 && Math.abs(w / h - 2) < 0.02;

/* ---------- Sharpness of frames ---------- */

/**
 * Sharpness of an image: the variance of the Laplacian of its grey values
 * (512 px wide). Motion blur and missed focus smooth edges and lower it. The
 * value depends on the scene, so it is only compared within one video.
 */
async function sharpness(file) {
  const { data, info } = await sharp(file).greyscale().resize(512, 512, { fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  return n ? Math.round((sum2 / n - (sum / n) ** 2) * 10) / 10 : 0;
}

/**
 * Picks the sharpest frame around each planned moment. `measure(t)` extracts
 * the frame at `t` and resolves to { sharpness, ... }; `discard(c)` throws a
 * candidate away. Frames as sharp as the median so far are kept at once;
 * blurrier ones get `offsets` tried as well. A frame still below `ratio` ×
 * the median is unusable (resolves to { blurry: true, best }). The median
 * needs `warmup` frames; before that every frame is kept.
 */
function createFramePicker({ offsets = [-0.25, 0.25], ratio = 0.4, warmup = 3, duration = Infinity } = {}) {
  const seen = [];
  const median = () => {
    const s = [...seen].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    async pick(t, measure, discard = async () => {}) {
      let best = { ...(await measure(t)), t };
      const med = seen.length >= warmup ? median() : null;
      if (med !== null && best.sharpness < med) {
        for (const dt of offsets) {
          const t2 = Math.min(Math.max(0, t + dt), duration);
          if (t2 === best.t) continue;
          const c = { ...(await measure(t2)), t: t2 };
          const worse = c.sharpness > best.sharpness ? best : c;
          if (worse === best) best = c;
          await discard(worse);
        }
      }
      seen.push(best.sharpness);
      return { ...best, blurry: med !== null && best.sharpness < ratio * med, median: med };
    },
  };
}

/* ---------- ffmpeg ---------- */

class FfmpegMissingError extends Error {
  constructor(bin) {
    super(`ffmpeg wurde nicht gefunden (${bin}). Bitte ffmpeg installieren oder den Pfad über FFMPEG_PATH angeben.`);
    this.code = 'FFMPEG_MISSING';
  }
}

function run(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err.code === 'ENOENT' || err.code === 'EACCES' ? new FfmpegMissingError(bin) : err);
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' || err.code === 'EACCES' ? new FfmpegMissingError(bin) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg beendet mit Code ${code}: ${stderr.trim().split('\n').pop() || 'unbekannter Fehler'}`));
    });
  });
}

function createFfmpeg(bin = process.env.FFMPEG_PATH || 'ffmpeg') {
  let available = null;
  return {
    bin,
    /** Resolves to true/false; cached after the first successful check. */
    async available() {
      if (available) return true;
      try {
        await run(bin, ['-hide_banner', '-version'], { timeoutMs: 10000 });
        available = true;
      } catch {
        return false;
      }
      return true;
    },
    /** Writes the frame at `t` seconds as JPEG (at most `maxWidth` px wide). */
    extractFrame(input, t, output, { maxWidth = 4096 } = {}) {
      return run(bin, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', t.toFixed(3), '-i', input,
        '-frames:v', '1', '-an', '-sn', '-dn',
        '-vf', `scale='min(${maxWidth},iw)':-2`,
        '-q:v', '3', '-y', output,
      ]);
    },
  };
}

module.exports = {
  bearing, resample, withDistance, atDistance, planByDistance, planByTime, isEquirectangular,
  sharpness, createFramePicker, createFfmpeg, FfmpegMissingError,
};

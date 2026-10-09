'use strict';

/*
 * Drive mode (dashcam): which of the pictures taken every few seconds while
 * driving are worth keeping. A day in the car gives thousands of nearly equal
 * pictures; the device decides before anything is stored or uploaded:
 *
 *   - no GPS or an imprecise one, standing still, blurred      → dropped
 *   - at a known spot, looking its way                          → the picture closest to the spot is kept
 *                                                                  (once per spot and drive)
 *   - otherwise one picture every `everyM` metres along the road → kept, unless it looks the same as the last one
 *   - everything in between                                     → dropped (the road is kept as the route)
 *
 * Every picture offered gets exactly one decision; a candidate at a spot is
 * held until the car has passed the spot (or `finish()`).
 *
 * Also the image measures used for it: `dhash` (64-bit difference hash of a
 * 9×8 grey image) and `sharpness` (variance of the Laplacian).
 *
 * Global `driveSelect`: createSelector(options), dhash(grey9x8), sharpness(grey, w, h), hamming(a, b), distanceM(a, b).
 */
(function driveSelectModule(root) {
  const DEFAULTS = {
    everyM: 150, // a picture along the road every … metres
    spotRadiusM: 40, // a known spot counts as reached within … metres
    headingTolDeg: 60, // and when driving towards its view within …°
    minSpeedMs: 1, // slower than this is standing (3.6 km/h)
    maxAccuracyM: 50,
    dupBits: 6, // pictures whose hashes differ in at most … of 64 bits look the same
    blurRatio: 0.35, // sharpness below … × the running median is blurred
    onlySpots: false, // keep pictures at known spots only
  };
  const REASONS = {
    spot: 'am Spot', abstand: 'entlang der Strecke',
    'kein-gps': 'kein genaues GPS', stillstand: 'Stillstand', unscharf: 'unscharf', doppelt: 'gleich wie das letzte',
    zwischen: 'zwischen zwei Bildern', 'spot-besser': 'am Spot gibt es ein näheres',
  };

  const toRad = (d) => (d * Math.PI) / 180;
  function distanceM(a, b) {
    const x = toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
    const y = toRad(b.lat - a.lat);
    return Math.hypot(x, y) * 6371000;
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  /** 64-bit difference hash (16 hex digits) of a 9×8 grey image (row by row, 72 values). */
  function dhash(grey) {
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1 : 0);
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }

  /** Bits in which two hashes differ (64 when one is missing). */
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      let v = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (v) { n += v & 1; v >>= 1; }
    }
    return n;
  }

  /** Variance of the Laplacian of a grey image (w × h): low for blurred pictures. */
  function sharpness(grey, w, h) {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = grey[i - w] + grey[i + w] + grey[i - 1] + grey[i + 1] - 4 * grey[i];
        sum += l;
        sq += l * l;
        n++;
      }
    }
    return n ? sq / n - (sum / n) ** 2 : 0;
  }

  /**
   * A selector for one drive. `spots`: the known spots ({ id, lat, lon, heading? }).
   * offer(frame) with frame { id, time, lat, lon, accuracy?, speed? (m/s), heading?, hash?, sharpness? }
   * returns the decisions made now: [{ id, keep, reason, spotId? }].
   */
  function createSelector(spots = [], options = {}) {
    const o = { ...DEFAULTS, ...options };
    const counts = Object.fromEntries(Object.keys(REASONS).map((k) => [k, 0]));
    const done = new Set(); // spots photographed on this drive
    const sharpSeen = [];
    let prev = null; // last frame with a position
    let lastKept = null; // for the spacing and the duplicate test
    let sinceKeptM = Infinity; // road since the last picture along it
    let pending = null; // { frame, spot, dist }: best candidate at a spot
    let distanceTotal = 0;

    const decide = (frame, keep, reason, spotId) => {
      counts[reason]++;
      if (keep) { lastKept = frame; if (reason === 'abstand') sinceKeptM = 0; }
      return { id: frame.id, keep, reason, ...(spotId !== undefined ? { spotId } : {}) };
    };
    const median = () => {
      const s = [...sharpSeen].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };

    /** The spot the frame looks at, with its distance, or null. */
    function spotAhead(f) {
      let best = null;
      for (const s of spots) {
        if (done.has(s.id)) continue;
        const d = distanceM(f, s);
        if (d > o.spotRadiusM) continue;
        // A spot with a view direction: only when driving roughly that way.
        if (Number.isFinite(s.heading) && Number.isFinite(f.heading) && angleDiff(s.heading, f.heading) > o.headingTolDeg) continue;
        if (!best || d < best.dist) best = { spot: s, dist: d };
      }
      return best;
    }

    function flushPending(out) {
      if (!pending) return;
      done.add(pending.spot.id);
      out.push(decide(pending.frame, true, 'spot', pending.spot.id));
      pending = null;
    }

    function offer(input) {
      const f = { ...input };
      const out = [];
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || (Number.isFinite(f.accuracy) && f.accuracy > o.maxAccuracyM)) {
        out.push(decide(f, false, 'kein-gps'));
        return out;
      }
      // Speed and heading from the previous position when the device does not give them.
      const step = prev ? distanceM(prev, f) : 0;
      const dt = prev && Number.isFinite(f.time) && Number.isFinite(prev.time) ? (f.time - prev.time) / 1000 : NaN;
      if (!Number.isFinite(f.speed) || f.speed < 0) f.speed = dt > 0 ? step / dt : (prev ? 0 : o.minSpeedMs);
      if (!Number.isFinite(f.heading) && prev && step > 3) f.heading = bearing(prev, f);
      if (!Number.isFinite(f.heading) && prev) f.heading = prev.heading;
      prev = f;
      distanceTotal += step;
      sinceKeptM += step;

      // Leaving the spot of the held candidate: it is the one.
      if (pending && distanceM(f, pending.spot) > o.spotRadiusM) flushPending(out);

      if (f.speed < o.minSpeedMs) {
        out.push(decide(f, false, 'stillstand'));
        return out;
      }
      if (Number.isFinite(f.sharpness)) {
        const m = median();
        sharpSeen.push(f.sharpness);
        if (sharpSeen.length > 60) sharpSeen.shift();
        if (sharpSeen.length >= 5 && f.sharpness < o.blurRatio * m) {
          out.push(decide(f, false, 'unscharf'));
          return out;
        }
      }
      const at = spotAhead(f);
      if (at) {
        if (pending && pending.spot.id === at.spot.id) {
          if (at.dist < pending.dist) {
            out.push(decide(pending.frame, false, 'spot-besser'));
            pending = { frame: f, ...at };
          } else {
            out.push(decide(f, false, 'spot-besser'));
          }
          return out;
        }
        flushPending(out);
        pending = { frame: f, ...at };
        return out;
      }
      if (!o.onlySpots && sinceKeptM >= o.everyM) {
        if (lastKept && hamming(f.hash, lastKept.hash) <= o.dupBits) {
          out.push(decide(f, false, 'doppelt'));
          return out;
        }
        out.push(decide(f, true, 'abstand'));
        return out;
      }
      out.push(decide(f, false, 'zwischen'));
      return out;
    }

    /** End of the drive: decides a held candidate. */
    function finish() {
      const out = [];
      flushPending(out);
      return out;
    }

    const stats = () => {
      const kept = counts.spot + counts.abstand;
      const total = Object.values(counts).reduce((a, b) => a + b, 0) + (pending ? 1 : 0);
      return { total, kept, dropped: total - kept - (pending ? 1 : 0), counts: { ...counts }, distanceM: distanceTotal, spots: done.size };
    };

    return { offer, finish, stats, options: o };
  }

  root.driveSelect = { createSelector, dhash, hamming, sharpness, distanceM, bearing, REASONS, DEFAULTS };
}(typeof self !== 'undefined' ? self : this));

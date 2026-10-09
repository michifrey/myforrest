package xyz.myforrest.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Drive mode (dashcam): which of the pictures taken every few seconds are worth keeping.
 *
 * <p>The same rules as public/drive-select.js, for the background service of the app (the web page may be
 * asleep while the screen is off). Both are checked against test/fixtures/drive-select-cases.json, so a
 * change here belongs into drive-select.js too, and the other way round:
 *
 * <ul>
 *   <li>no GPS or an imprecise one, standing still, blurred → dropped
 *   <li>at a known spot, looking its way → the picture closest to the spot is kept (once per spot and drive)
 *   <li>otherwise one picture every {@code everyM} metres along the road → kept, unless it looks the same as the last one
 *   <li>everything in between → dropped
 * </ul>
 *
 * <p>Plain Java without Android classes, so it runs in the unit tests on the JVM.
 */
public final class DriveSelector {

  /** Settings, with the defaults of drive-select.js. */
  public static final class Options {
    public double everyM = 150;
    public double spotRadiusM = 40;
    public double headingTolDeg = 60;
    public double minSpeedMs = 1;
    public double maxAccuracyM = 50;
    public int dupBits = 6;
    public double blurRatio = 0.35;
    public boolean onlySpots = false;
  }

  /** A known spot; heading NaN when it has no view direction. */
  public static final class Spot {
    public final String id;
    public final double lat;
    public final double lon;
    public final double heading;

    public Spot(String id, double lat, double lon, double heading) {
      this.id = id;
      this.lat = lat;
      this.lon = lon;
      this.heading = heading;
    }
  }

  /** A picture with the GPS fix of its moment. Missing values are NaN (hash: null). */
  public static final class Frame {
    public final long id;
    public final double time;
    public final double lat;
    public final double lon;
    public final double accuracy;
    double speed;
    double heading;
    public final String hash;
    public final double sharpness;

    public Frame(long id, double time, double lat, double lon, double accuracy, double speed, double heading, String hash, double sharpness) {
      this.id = id;
      this.time = time;
      this.lat = lat;
      this.lon = lon;
      this.accuracy = accuracy;
      this.speed = speed;
      this.heading = heading;
      this.hash = hash;
      this.sharpness = sharpness;
    }

    /** Heading as used for the decision (from the previous position when the device gave none). */
    public double heading() {
      return heading;
    }
  }

  /** One decision: keep or drop, why, and the spot for a picture kept there (else null). */
  public static final class Decision {
    public final Frame frame;
    public final boolean keep;
    public final String reason;
    public final String spotId;

    Decision(Frame frame, boolean keep, String reason, String spotId) {
      this.frame = frame;
      this.keep = keep;
      this.reason = reason;
      this.spotId = spotId;
    }
  }

  public static final List<String> REASONS = Arrays.asList(
      "spot", "abstand", "kein-gps", "stillstand", "unscharf", "doppelt", "zwischen", "spot-besser");

  private final List<Spot> spots;
  private final Options o;
  private final Map<String, Integer> counts = new LinkedHashMap<>();
  private final Set<String> done = new HashSet<>();
  private final ArrayList<Double> sharpSeen = new ArrayList<>();
  private Frame prev;
  private Frame lastKept;
  private double sinceKeptM = Double.POSITIVE_INFINITY;
  private Frame pendingFrame;
  private Spot pendingSpot;
  private double pendingDist;
  private double distanceTotal;

  public DriveSelector(List<Spot> spots, Options options) {
    this.spots = spots;
    this.o = options;
    for (String r : REASONS) counts.put(r, 0);
  }

  /* ---------- Geometry and image measures ---------- */

  private static double toRad(double d) {
    return d * Math.PI / 180;
  }

  public static double distanceM(double lat1, double lon1, double lat2, double lon2) {
    double x = toRad(lon2 - lon1) * Math.cos(toRad((lat1 + lat2) / 2));
    double y = toRad(lat2 - lat1);
    return Math.hypot(x, y) * 6371000;
  }

  public static double bearing(double lat1, double lon1, double lat2, double lon2) {
    double y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    double x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private static double angleDiff(double a, double b) {
    // JS % keeps the sign of the dividend, like Java's.
    return Math.abs(((a - b + 540) % 360) - 180);
  }

  /** 64-bit difference hash (16 hex digits) of a 9×8 grey image (row by row, 72 values). */
  public static String dhash(double[] grey) {
    StringBuilder hex = new StringBuilder();
    for (int y = 0; y < 8; y++) {
      int b = 0;
      for (int x = 0; x < 8; x++) b = (b << 1) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1 : 0);
      hex.append(String.format("%02x", b));
    }
    return hex.toString();
  }

  /** Bits in which two hashes differ (64 when one is missing). */
  public static int hamming(String a, String b) {
    if (a == null || b == null || a.length() != b.length()) return 64;
    int n = 0;
    for (int i = 0; i < a.length(); i++) {
      n += Integer.bitCount(Character.digit(a.charAt(i), 16) ^ Character.digit(b.charAt(i), 16));
    }
    return n;
  }

  /** Variance of the Laplacian of a grey image (w × h): low for blurred pictures. */
  public static double sharpness(double[] grey, int w, int h) {
    double sum = 0;
    double sq = 0;
    int n = 0;
    for (int y = 1; y < h - 1; y++) {
      for (int x = 1; x < w - 1; x++) {
        int i = y * w + x;
        double l = grey[i - w] + grey[i + w] + grey[i - 1] + grey[i + 1] - 4 * grey[i];
        sum += l;
        sq += l * l;
        n++;
      }
    }
    return n > 0 ? sq / n - Math.pow(sum / n, 2) : 0;
  }

  /* ---------- Selection ---------- */

  private Decision decide(Frame f, boolean keep, String reason, String spotId) {
    counts.put(reason, counts.get(reason) + 1);
    if (keep) {
      lastKept = f;
      if (reason.equals("abstand")) sinceKeptM = 0;
    }
    return new Decision(f, keep, reason, spotId);
  }

  private double median() {
    if (sharpSeen.isEmpty()) return 0;
    ArrayList<Double> s = new ArrayList<>(sharpSeen);
    s.sort(null);
    return s.get(s.size() / 2);
  }

  private void flushPending(List<Decision> out) {
    if (pendingFrame == null) return;
    done.add(pendingSpot.id);
    out.add(decide(pendingFrame, true, "spot", pendingSpot.id));
    pendingFrame = null;
    pendingSpot = null;
  }

  /** Offers a picture; returns the decisions made now (a candidate at a spot waits until the spot is passed). */
  public List<Decision> offer(Frame f) {
    List<Decision> out = new ArrayList<>();
    if (!Double.isFinite(f.lat) || !Double.isFinite(f.lon) || (Double.isFinite(f.accuracy) && f.accuracy > o.maxAccuracyM)) {
      out.add(decide(f, false, "kein-gps", null));
      return out;
    }
    // Speed and heading from the previous position when the device does not give them.
    double step = prev != null ? distanceM(prev.lat, prev.lon, f.lat, f.lon) : 0;
    double dt = prev != null && Double.isFinite(f.time) && Double.isFinite(prev.time) ? (f.time - prev.time) / 1000 : Double.NaN;
    if (!Double.isFinite(f.speed) || f.speed < 0) f.speed = dt > 0 ? step / dt : (prev != null ? 0 : o.minSpeedMs);
    if (!Double.isFinite(f.heading) && prev != null && step > 3) f.heading = bearing(prev.lat, prev.lon, f.lat, f.lon);
    if (!Double.isFinite(f.heading) && prev != null) f.heading = prev.heading;
    prev = f;
    distanceTotal += step;
    sinceKeptM += step;

    // Leaving the spot of the held candidate: it is the one.
    if (pendingFrame != null && distanceM(f.lat, f.lon, pendingSpot.lat, pendingSpot.lon) > o.spotRadiusM) flushPending(out);

    if (f.speed < o.minSpeedMs) {
      out.add(decide(f, false, "stillstand", null));
      return out;
    }
    if (Double.isFinite(f.sharpness)) {
      double m = median();
      sharpSeen.add(f.sharpness);
      if (sharpSeen.size() > 60) sharpSeen.remove(0);
      if (sharpSeen.size() >= 5 && f.sharpness < o.blurRatio * m) {
        out.add(decide(f, false, "unscharf", null));
        return out;
      }
    }
    // The spot the frame looks at, the closest one.
    Spot at = null;
    double atDist = 0;
    for (Spot s : spots) {
      if (done.contains(s.id)) continue;
      double d = distanceM(f.lat, f.lon, s.lat, s.lon);
      if (d > o.spotRadiusM) continue;
      if (Double.isFinite(s.heading) && Double.isFinite(f.heading) && angleDiff(s.heading, f.heading) > o.headingTolDeg) continue;
      if (at == null || d < atDist) {
        at = s;
        atDist = d;
      }
    }
    if (at != null) {
      if (pendingFrame != null && pendingSpot.id.equals(at.id)) {
        if (atDist < pendingDist) {
          out.add(decide(pendingFrame, false, "spot-besser", null));
          pendingFrame = f;
          pendingDist = atDist;
        } else {
          out.add(decide(f, false, "spot-besser", null));
        }
        return out;
      }
      flushPending(out);
      pendingFrame = f;
      pendingSpot = at;
      pendingDist = atDist;
      return out;
    }
    if (!o.onlySpots && sinceKeptM >= o.everyM) {
      if (lastKept != null && hamming(f.hash, lastKept.hash) <= o.dupBits) {
        out.add(decide(f, false, "doppelt", null));
        return out;
      }
      out.add(decide(f, true, "abstand", null));
      return out;
    }
    out.add(decide(f, false, "zwischen", null));
    return out;
  }

  /** End of the drive: decides a held candidate. */
  public List<Decision> finish() {
    List<Decision> out = new ArrayList<>();
    flushPending(out);
    return out;
  }

  /** Decisions per reason (a copy). */
  public Map<String, Integer> counts() {
    return new LinkedHashMap<>(counts);
  }

  public int kept() {
    return counts.get("spot") + counts.get("abstand");
  }

  public int total() {
    int t = pendingFrame != null ? 1 : 0;
    for (int c : counts.values()) t += c;
    return t;
  }

  public int spotsDone() {
    return done.size();
  }

  public double distanceM() {
    return distanceTotal;
  }
}

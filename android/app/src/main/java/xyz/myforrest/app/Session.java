package xyz.myforrest.app;

import android.content.Context;
import android.util.Base64;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The recording in progress (a tour or a drive), on disk in files/session so that nothing is lost when
 * the app or the page is closed:
 *
 * <pre>
 *   meta.json    mode, settings, counters, last GPS fix, running/finished
 *   route.jsonl  one point per line: {lat, lon, time, ele?}
 *   spots.json   the known spots for the drive mode
 *   held/        pictures waiting for their decision (a candidate at a spot)
 *   kept/        kept pictures until the page has put them into its upload queue: id.jpg + id.json
 * </pre>
 *
 * Shared by the service and the bridge to the page (different threads), hence synchronized.
 */
final class Session {
  private static Session instance;

  private final File dir;
  private final File held;
  private final File kept;
  private JSONObject meta;
  private final List<JSONObject> route = new ArrayList<>();

  static synchronized Session get(Context context) {
    if (instance == null) instance = new Session(new File(context.getFilesDir(), "session"));
    return instance;
  }

  private Session(File dir) {
    this.dir = dir;
    this.held = new File(dir, "held");
    this.kept = new File(dir, "kept");
    load();
  }

  private void load() {
    meta = new JSONObject();
    route.clear();
    try {
      File m = new File(dir, "meta.json");
      if (m.exists()) meta = new JSONObject(read(m));
      File r = new File(dir, "route.jsonl");
      if (r.exists()) {
        try (BufferedReader in = new BufferedReader(new FileReader(r))) {
          for (String line; (line = in.readLine()) != null; ) {
            if (!line.isEmpty()) route.add(new JSONObject(line));
          }
        }
      }
    } catch (IOException | JSONException e) {
      // A broken file (power off while writing): start empty rather than not at all.
      meta = new JSONObject();
    }
  }

  /* ---------- Lifecycle ---------- */

  /**
   * Between the start on the page and the service running (permission dialogs): a new, empty recording
   * that already counts as running.
   */
  synchronized void prepare(String mode) {
    wipe();
    meta = new JSONObject();
    put("mode", mode);
    put("running", true);
    put("starting", System.currentTimeMillis());
  }

  /**
   * Starts the recording (permissions granted). Options: drive: interval, everyM, trip, spots (stored in
   * spots.json); tour: points, the track so far (when an interrupted recording is continued).
   */
  synchronized void begin(String mode, JSONObject options) throws JSONException, IOException {
    wipe();
    held.mkdirs();
    kept.mkdirs();
    JSONArray spots = options.optJSONArray("spots");
    options.remove("spots");
    if (spots != null) writeFile(new File(dir, "spots.json"), spots.toString().getBytes(StandardCharsets.UTF_8));
    meta = new JSONObject();
    meta.put("started", System.currentTimeMillis());
    meta.put("mode", mode);
    meta.put("running", true);
    meta.put("finished", false);
    JSONArray points = options.optJSONArray("points");
    options.remove("points");
    meta.put("options", options);
    if (points != null) {
      for (int i = 0; i < points.length(); i++) {
        JSONObject p = points.optJSONObject(i);
        if (p != null) addPoint(p);
      }
      if (points.length() > 0 && points.optJSONObject(0) != null) meta.put("started", points.getJSONObject(0).optLong("time", meta.getLong("started")));
    }
    save();
  }

  synchronized void finish() {
    try {
      meta.put("running", false);
      meta.put("finished", true);
    } catch (JSONException ignored) {
      // put with a plain key and value does not fail
    }
    save();
  }

  /** Removes everything (after the page saved the route and queued the pictures). */
  synchronized void clear() {
    wipe();
    meta = new JSONObject();
  }

  private void wipe() {
    route.clear();
    deleteTree(dir);
  }

  private static void deleteTree(File f) {
    File[] children = f.listFiles();
    if (children != null) for (File c : children) deleteTree(c);
    f.delete();
  }

  /* ---------- State ---------- */

  synchronized JSONObject meta() {
    return meta;
  }

  synchronized String mode() {
    return meta.optString("mode", "");
  }

  synchronized boolean running() {
    return meta.optBoolean("running", false);
  }

  synchronized JSONObject options() {
    JSONObject o = meta.optJSONObject("options");
    return o != null ? o : new JSONObject();
  }

  synchronized void put(String key, Object value) {
    try {
      meta.put(key, value);
    } catch (JSONException ignored) {
      // only for NaN, which callers do not pass
    }
  }

  synchronized void setError(String message) {
    put("error", message);
    put("running", false);
    save();
  }

  synchronized void save() {
    dir.mkdirs();
    try {
      writeFile(new File(dir, "meta.json"), meta.toString().getBytes(StandardCharsets.UTF_8));
    } catch (IOException ignored) {
      // disk full: the counters are lost, the pictures and the route are not
    }
  }

  /** The state for the page: meta plus the number of route points and kept pictures. */
  synchronized String stateJson(boolean serviceAlive) {
    try {
      JSONObject s = new JSONObject(meta.toString());
      s.put("points", route.size());
      String[] k = kept.list((d, name) -> name.endsWith(".json"));
      s.put("waiting", k == null ? 0 : k.length);
      // Marked running but the service is gone (the system ended the app): interrupted. Not while the
      // permissions are asked for (at most a few minutes).
      boolean starting = System.currentTimeMillis() - meta.optLong("starting", 0) < 5 * 60 * 1000;
      if (meta.optBoolean("running") && !serviceAlive && !starting) {
        s.put("running", false);
        s.put("interrupted", true);
      }
      return s.toString();
    } catch (JSONException e) {
      return "{}";
    }
  }

  /* ---------- Route ---------- */

  synchronized void addPoint(JSONObject p) {
    route.add(p);
    dir.mkdirs();
    try (OutputStream out = new FileOutputStream(new File(dir, "route.jsonl"), true)) {
      out.write((p.toString() + "\n").getBytes(StandardCharsets.UTF_8));
    } catch (IOException ignored) {
      // kept in memory at least
    }
  }

  synchronized JSONObject lastPoint() {
    return route.isEmpty() ? null : route.get(route.size() - 1);
  }

  synchronized int pointCount() {
    return route.size();
  }

  /** The route from point `from` on, as a JSON array. */
  synchronized String routeJson(int from) {
    JSONArray a = new JSONArray();
    for (int i = Math.max(0, from); i < route.size(); i++) a.put(route.get(i));
    return a.toString();
  }

  synchronized JSONArray spots() {
    try {
      File f = new File(dir, "spots.json");
      return f.exists() ? new JSONArray(read(f)) : new JSONArray();
    } catch (IOException | JSONException e) {
      return new JSONArray();
    }
  }

  /* ---------- Pictures ---------- */

  synchronized void hold(long id, byte[] jpeg) throws IOException {
    held.mkdirs();
    writeFile(new File(held, id + ".jpg"), jpeg);
  }

  synchronized void drop(long id) {
    new File(held, id + ".jpg").delete();
  }

  /** A held picture becomes a kept one, with what the page needs for the upload. */
  synchronized boolean keep(long id, JSONObject info) {
    kept.mkdirs();
    File from = new File(held, id + ".jpg");
    if (!from.exists() || !from.renameTo(new File(kept, id + ".jpg"))) return false;
    try {
      writeFile(new File(kept, id + ".json"), info.toString().getBytes(StandardCharsets.UTF_8));
      return true;
    } catch (IOException e) {
      return false;
    }
  }

  /** The kept pictures not yet taken by the page (without the image data), oldest first. */
  synchronized String keptJson() {
    JSONArray a = new JSONArray();
    File[] files = kept.listFiles((d, name) -> name.endsWith(".json"));
    if (files == null) return a.toString();
    Arrays.sort(files, (x, y) -> Long.compare(idOf(x), idOf(y)));
    for (File f : files) {
      try {
        a.put(new JSONObject(read(f)));
      } catch (IOException | JSONException e) {
        f.delete();
      }
    }
    return a.toString();
  }

  private static long idOf(File f) {
    try {
      return Long.parseLong(f.getName().replaceAll("\\..*$", ""));
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  /** A kept picture as base64 JPEG ("" when it is gone). */
  synchronized String frameBase64(long id) {
    File f = new File(kept, id + ".jpg");
    if (!f.exists()) return "";
    try {
      return Base64.encodeToString(readBytes(f), Base64.NO_WRAP);
    } catch (IOException e) {
      return "";
    }
  }

  /** The page has the picture in its upload queue: removed here. */
  synchronized void ack(long id) {
    new File(kept, id + ".jpg").delete();
    new File(kept, id + ".json").delete();
  }

  /* ---------- Files ---------- */

  private static void writeFile(File f, byte[] data) throws IOException {
    f.getParentFile().mkdirs();
    File tmp = new File(f.getPath() + ".tmp");
    try (OutputStream out = new FileOutputStream(tmp)) {
      out.write(data);
    }
    if (!tmp.renameTo(f)) throw new IOException("rename " + f);
  }

  private static byte[] readBytes(File f) throws IOException {
    try (InputStream in = new FileInputStream(f)) {
      byte[] data = new byte[(int) f.length()];
      int off = 0;
      for (int n; off < data.length && (n = in.read(data, off, data.length - off)) > 0; ) off += n;
      return off == data.length ? data : Arrays.copyOf(data, off);
    }
  }

  private static String read(File f) throws IOException {
    return new String(readBytes(f), StandardCharsets.UTF_8);
  }
}

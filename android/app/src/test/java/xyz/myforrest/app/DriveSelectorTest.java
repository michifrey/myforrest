package xyz.myforrest.app;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * The selection of the background service decides exactly like public/drive-select.js: both run the cases
 * in test/fixtures/drive-select-cases.json (written by test/drive.test.js with UPDATE_FIXTURES=1).
 */
public class DriveSelectorTest {

  private static Path fixture() {
    // Gradle runs the tests in android/app; the file lies in the test folder of the web app.
    for (Path p = Paths.get("").toAbsolutePath(); p != null; p = p.getParent()) {
      Path f = p.resolve("test/fixtures/drive-select-cases.json");
      if (Files.exists(f)) return f;
    }
    throw new IllegalStateException("test/fixtures/drive-select-cases.json not found");
  }

  private static double num(JSONObject o, String key) {
    return o.isNull(key) || !o.has(key) ? Double.NaN : o.getDouble(key);
  }

  @Test
  public void sameDecisionsAsTheWebApp() throws Exception {
    JSONArray cases = new JSONArray(new String(Files.readAllBytes(fixture()), StandardCharsets.UTF_8));
    assertEquals(4, cases.length());
    for (int c = 0; c < cases.length(); c++) {
      JSONObject k = cases.getJSONObject(c);
      String name = k.getString("name");
      List<DriveSelector.Spot> spots = new ArrayList<>();
      JSONArray s = k.getJSONArray("spots");
      for (int i = 0; i < s.length(); i++) {
        JSONObject o = s.getJSONObject(i);
        spots.add(new DriveSelector.Spot(String.valueOf(o.get("id")), o.getDouble("lat"), o.getDouble("lon"), num(o, "heading")));
      }
      JSONObject opt = k.getJSONObject("options");
      DriveSelector.Options options = new DriveSelector.Options();
      if (opt.has("everyM")) options.everyM = opt.getDouble("everyM");
      options.onlySpots = opt.optBoolean("onlySpots", false);
      DriveSelector sel = new DriveSelector(spots, options);

      List<DriveSelector.Decision> got = new ArrayList<>();
      JSONArray frames = k.getJSONArray("frames");
      for (int i = 0; i < frames.length(); i++) {
        JSONObject f = frames.getJSONObject(i);
        got.addAll(sel.offer(new DriveSelector.Frame(f.getLong("id"), num(f, "time"), num(f, "lat"), num(f, "lon"),
            num(f, "accuracy"), num(f, "speed"), num(f, "heading"), f.optString("hash", null), num(f, "sharpness"))));
      }
      got.addAll(sel.finish());

      JSONArray want = k.getJSONArray("decisions");
      assertEquals(name + ": number of decisions", want.length(), got.size());
      for (int i = 0; i < want.length(); i++) {
        JSONObject w = want.getJSONObject(i);
        DriveSelector.Decision d = got.get(i);
        String at = name + " #" + i;
        assertEquals(at + " id", w.getLong("id"), d.frame.id);
        assertEquals(at + " keep", w.getBoolean("keep"), d.keep);
        assertEquals(at + " reason", w.getString("reason"), d.reason);
        assertEquals(at + " spot", w.has("spotId") ? String.valueOf(w.get("spotId")) : null, d.spotId);
      }
      JSONObject stats = k.getJSONObject("stats");
      assertEquals(name + " kept", stats.getInt("kept"), sel.kept());
      assertEquals(name + " total", stats.getInt("total"), sel.total());
      assertEquals(name + " spots", stats.getInt("spots"), sel.spotsDone());
      assertEquals(name + " distance", stats.getLong("distanceM"), Math.round(sel.distanceM()));
      JSONObject counts = stats.getJSONObject("counts");
      for (String r : DriveSelector.REASONS) assertEquals(name + " " + r, counts.getInt(r), (int) sel.counts().get(r));
    }
  }

  @Test
  public void imageMeasures() {
    double[] ramp = new double[72];
    for (int i = 0; i < 72; i++) ramp[i] = i % 9;
    assertEquals("0000000000000000", DriveSelector.dhash(ramp));
    for (int i = 0; i < 72; i++) ramp[i] = -ramp[i];
    assertEquals("ffffffffffffffff", DriveSelector.dhash(ramp));
    assertEquals(8, DriveSelector.hamming("ff00", "f0f0"));
    assertEquals(64, DriveSelector.hamming("ff", null));
    int w = 40;
    double[] sharp = new double[w * w];
    double[] flat = new double[w * w];
    for (int i = 0; i < w * w; i++) {
      sharp[i] = ((i % w) + i / w) % 2 == 1 ? 255 : 0;
      flat[i] = (i % w) * 6;
    }
    org.junit.Assert.assertTrue(DriveSelector.sharpness(sharp, w, w) > 100 * DriveSelector.sharpness(flat, w, w) + 1);
  }
}

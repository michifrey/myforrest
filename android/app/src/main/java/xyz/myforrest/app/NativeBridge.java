package xyz.myforrest.app;

import android.webkit.JavascriptInterface;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the page sees as {@code window.MyForrestNative} (wrapped by public/native.js). All answers are
 * strings (JSON where structured); the methods run on a background thread of the WebView. Only the
 * MyForrest server gets answers: while a sign-in page of another site is shown, the bridge stays silent.
 */
final class NativeBridge {
  private final MainActivity activity;

  NativeBridge(MainActivity activity) {
    this.activity = activity;
  }

  @JavascriptInterface
  public String info() {
    try {
      return new JSONObject()
          .put("platform", "android")
          .put("version", BuildConfig.VERSION_NAME)
          .put("features", new org.json.JSONArray().put("tour").put("drive"))
          .toString();
    } catch (JSONException e) {
      return "{}";
    }
  }

  /**
   * Starts recording in the background: mode "tour" or "drive", options as JSON (drive: interval, everyM,
   * spots, trip; tour: points so far). Asks for the permissions first, so the answer comes with {@link #state()}:
   * "ok" (started or asking), else the reason why not.
   */
  @JavascriptInterface
  public String start(String mode, String optionsJson) {
    if (!activity.trusted()) return "Nicht erlaubt";
    if (!"tour".equals(mode) && !"drive".equals(mode)) return "Unbekannter Modus";
    Session s = Session.get(activity);
    if (TrackingService.current != null && s.running()) {
      return mode.equals(s.mode()) ? "ok" : "drive".equals(s.mode()) ? "Der Fahrtmodus läuft schon." : "Eine Aufzeichnung läuft schon.";
    }
    JSONObject options;
    try {
      options = new JSONObject(optionsJson == null || optionsJson.isEmpty() ? "{}" : optionsJson);
    } catch (JSONException e) {
      return "Ungültige Einstellungen";
    }
    s.prepare(mode);
    activity.runOnUiThread(() -> activity.startRecording(mode, options));
    return "ok";
  }

  /** Ends the recording and waits (up to 8 s) until the last picture is decided; returns the state. */
  @JavascriptInterface
  public String stop() {
    if (!activity.trusted()) return "{}";
    Session s = Session.get(activity);
    activity.runOnUiThread(activity::stopRecording);
    for (int i = 0; i < 80 && TrackingService.current != null; i++) {
      try {
        Thread.sleep(100);
      } catch (InterruptedException e) {
        break;
      }
    }
    if (TrackingService.current == null && s.running()) s.finish();
    return state();
  }

  /** Mode, counters, last fix, running/finished/interrupted, number of route points and waiting pictures. */
  @JavascriptInterface
  public String state() {
    if (!activity.trusted()) return "{}";
    return Session.get(activity).stateJson(TrackingService.current != null);
  }

  /** The route from point `from` on (JSON array of {lat, lon, time, ele?}). */
  @JavascriptInterface
  public String route(int from) {
    if (!activity.trusted()) return "[]";
    return Session.get(activity).routeJson(from);
  }

  /** The kept pictures waiting for the upload queue (without image data). */
  @JavascriptInterface
  public String kept() {
    if (!activity.trusted()) return "[]";
    return Session.get(activity).keptJson();
  }

  /** One kept picture as base64 JPEG. */
  @JavascriptInterface
  public String frame(String id) {
    if (!activity.trusted()) return "";
    try {
      return Session.get(activity).frameBase64(Long.parseLong(id));
    } catch (NumberFormatException e) {
      return "";
    }
  }

  /** The page has the picture in its queue: removed from the device storage of the app. */
  @JavascriptInterface
  public void ack(String id) {
    if (!activity.trusted()) return;
    try {
      Session.get(activity).ack(Long.parseLong(id));
    } catch (NumberFormatException ignored) {
      // not one of ours
    }
  }

  /** Removes the finished recording (after the page saved the route). Not while it is running. */
  @JavascriptInterface
  public boolean clear() {
    if (!activity.trusted()) return false;
    Session s = Session.get(activity);
    if (TrackingService.current != null) return false;
    s.clear();
    return true;
  }

  /** Lets the user choose another server address. */
  @JavascriptInterface
  public void chooseServer() {
    if (!activity.trusted()) return;
    activity.runOnUiThread(activity::askServer);
  }
}

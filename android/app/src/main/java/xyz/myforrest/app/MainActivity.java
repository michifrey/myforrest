package xyz.myforrest.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.Gravity;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.FrameLayout;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * The MyForrest web app in a WebView, plus what a browser cannot do: recording GPS and pictures with the
 * screen off ({@link TrackingService}, reached by the page through {@link NativeBridge}).
 */
public class MainActivity extends Activity {
  private static final String PREFS = "myforrest";
  private static final String KEY_SERVER = "server";
  private static final int REQ_RECORD = 1;
  private static final int REQ_WEB = 2;
  private static final int REQ_FILE = 3;

  private static WeakReference<MainActivity> visible = new WeakReference<>(null);

  private WebView web;
  private StartScreen start;
  private ProgressBar progress;
  private String server;
  private volatile String pageOrigin = "";
  private volatile String serverOrigin = "";

  // Waiting for permissions
  private String pendingMode;
  private JSONObject pendingOptions;
  private PermissionRequest pendingWeb;
  private GeolocationPermissions.Callback pendingGeo;
  private String pendingGeoOrigin;
  private ValueCallback<Uri[]> pendingFiles;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    visible = new WeakReference<>(this);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    web = new WebView(this);
    FrameLayout root = new FrameLayout(this);
    root.addView(web);
    // A thin bar at the top while a page loads, so a slow server does not look like an empty app.
    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(100);
    progress.setVisibility(View.GONE);
    root.addView(progress, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
        Math.round(4 * getResources().getDisplayMetrics().density), Gravity.TOP));
    start = new StartScreen(this, this::connected, () -> {
      start.hide();
      load(getIntent());
    });
    root.addView(start.view());
    setContentView(root);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setGeolocationEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setUserAgentString(s.getUserAgentString() + " MyForrestAndroid/" + BuildConfig.VERSION_NAME);
    // The page keeps running in the background while a recording runs (it takes the pictures for its upload queue).
    web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    web.addJavascriptInterface(new NativeBridge(this), "MyForrestNative");
    web.setWebViewClient(new Client());
    web.setWebChromeClient(new Chrome());

    server = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, BuildConfig.SERVER_URL);
    // With a saved server the start screen checks it first: a server that is gone or a wrong address
    // otherwise only gives a white page.
    boolean change = "server".equals(getIntent().getStringExtra("action"));
    if (server == null || server.isEmpty() || change) start.show(server, null);
    else start.connect(server);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (intent.getData() != null || intent.hasExtra("action")) load(intent);
  }

  /** The start page, or the path of a launcher shortcut (e.g. /?action=fahrt). */
  private void load(Intent intent) {
    if (intent != null && "server".equals(intent.getStringExtra("action"))) {
      askServer();
      return;
    }
    Uri base = Uri.parse(server);
    serverOrigin = origin(base);
    String url = server;
    if (intent != null && intent.getStringExtra("action") != null) {
      url = base.buildUpon().clearQuery().appendQueryParameter("action", intent.getStringExtra("action")).build().toString();
    } else if (intent != null && intent.getData() != null && origin(intent.getData()).equals(serverOrigin)) {
      url = intent.getData().toString();
    }
    web.loadUrl(url);
  }

  private static String origin(Uri u) {
    if (u == null || u.getScheme() == null || u.getHost() == null) return "";
    return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
  }

  /** Whether the page shown is the MyForrest server (for the bridge). */
  boolean trusted() {
    return !serverOrigin.isEmpty() && serverOrigin.equals(pageOrigin);
  }

  /** The start screen with the address (shortcut "Server wechseln", or from the page). */
  void askServer() {
    start.show(server, null);
  }

  /** The start screen checked the address: remembered, and the page is loaded (with a shortcut's action). */
  private void connected(String address) {
    server = address;
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, server).apply();
    start.hide();
    Intent i = getIntent();
    load(i != null && "server".equals(i.getStringExtra("action")) ? null : i);
  }

  /* ---------- Recording ---------- */

  /** From the bridge: asks for the permissions, then starts the service. */
  void startRecording(String mode, JSONObject options) {
    pendingMode = mode;
    pendingOptions = options;
    List<String> need = new ArrayList<>();
    need.add(Manifest.permission.ACCESS_FINE_LOCATION);
    if ("drive".equals(mode)) need.add(Manifest.permission.CAMERA);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) need.add(Manifest.permission.POST_NOTIFICATIONS);
    List<String> missing = new ArrayList<>();
    for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
    if (missing.isEmpty()) startService();
    else requestPermissions(missing.toArray(new String[0]), REQ_RECORD);
  }

  private void startService() {
    String mode = pendingMode;
    if (mode == null) return;
    pendingMode = null;
    Session s = Session.get(this);
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      s.put("mode", mode);
      s.setError("Ohne Erlaubnis für den genauen Standort kann die App nichts aufzeichnen.");
      return;
    }
    try {
      s.begin(mode, pendingOptions);
    } catch (org.json.JSONException | java.io.IOException e) {
      s.setError("Aufzeichnung konnte nicht starten: " + e.getMessage());
      return;
    }
    if ("drive".equals(mode) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      s.put("status", "Ohne Kamera-Erlaubnis wird nur die Route aufgezeichnet.");
    }
    Intent i = new Intent(this, TrackingService.class).setAction(TrackingService.ACTION_START);
    startForegroundService(i);
  }

  void stopRecording() {
    if (TrackingService.current != null) {
      startService(new Intent(this, TrackingService.class).setAction(TrackingService.ACTION_STOP));
    }
  }

  /** Tells the page that the recording changed (e.g. ended from the notification); it also polls. */
  static void notifyPage() {
    MainActivity a = visible.get();
    if (a != null && a.web != null) {
      a.runOnUiThread(() -> a.web.evaluateJavascript("window.dispatchEvent(new Event('myforrest-native'))", null));
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode == REQ_RECORD) {
      startService();
    } else if (requestCode == REQ_WEB) {
      grantWeb();
    }
  }

  /* ---------- Web page ---------- */

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
    web.resumeTimers();
    notifyPage();
  }

  @Override
  protected void onPause() {
    super.onPause();
    // While a recording runs the page keeps going (upload queue); otherwise it sleeps like in a browser.
    if (TrackingService.current == null) web.onPause();
  }

  @Override
  @SuppressWarnings("deprecation") // still called without predictive back (targetSdk 35)
  public void onBackPressed() {
    if (start.shown() && server != null && !server.isEmpty() && web.getUrl() != null) start.hide();
    else if (!start.shown() && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQ_FILE || pendingFiles == null) return;
    pendingFiles.onReceiveValue(filesOf(resultCode, data));
    pendingFiles = null;
  }

  /** Several files (multiple in the file input) come as clip data. */
  private static Uri[] filesOf(int resultCode, Intent data) {
    if (resultCode == RESULT_OK && data != null && data.getClipData() != null) {
      Uri[] u = new Uri[data.getClipData().getItemCount()];
      for (int i = 0; i < u.length; i++) u[i] = data.getClipData().getItemAt(i).getUri();
      return u;
    }
    return WebChromeClient.FileChooserParams.parseResult(resultCode, data);
  }

  private void grantWeb() {
    if (pendingWeb != null) {
      List<String> ok = new ArrayList<>();
      for (String r : pendingWeb.getResources()) {
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) ok.add(r);
      }
      if (ok.isEmpty()) pendingWeb.deny();
      else pendingWeb.grant(ok.toArray(new String[0]));
      pendingWeb = null;
    }
    if (pendingGeo != null) {
      boolean ok = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
          || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
      pendingGeo.invoke(pendingGeoOrigin, ok, false);
      pendingGeo = null;
    }
  }

  private final class Client extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      Uri u = request.getUrl();
      String scheme = u.getScheme() == null ? "" : u.getScheme();
      // Pages of the server stay in the app, and so does a sign-in (e.g. GitHub, Microsoft): the redirect
      // there and every step on the pages of the provider. Links from MyForrest to other sites open outside.
      boolean web = scheme.equals("https") || scheme.equals("http");
      if (web && (origin(u).equals(serverOrigin) || request.isRedirect() || !serverOrigin.equals(pageOrigin))) return false;
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, u));
      } catch (ActivityNotFoundException ignored) {
        // nothing to open it with
      }
      return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
      pageOrigin = origin(Uri.parse(url));
    }

    @Override
    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
      pageOrigin = origin(Uri.parse(url));
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
      if (!request.isForMainFrame() || response.getStatusCode() < 500) return;
      start.show(server, "Der Server antwortet mit einem Fehler (HTTP " + response.getStatusCode() + ").");
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      if (!request.isForMainFrame()) return;
      // Offline the service worker of the page answers; this is only reached without one (first start, or
      // the server is gone): back to the start screen, which tries again with "Verbinden".
      start.show(server, "Keine Verbindung zu " + server + " (" + error.getDescription() + "). "
          + "Ist der Server gestartet und das Handy online?");
    }
  }

  private final class Chrome extends WebChromeClient {
    /** Camera for the overlay when photographing a spot again (getUserMedia). */
    @Override
    public void onPermissionRequest(PermissionRequest request) {
      if (!origin(request.getOrigin()).equals(serverOrigin)) {
        request.deny();
        return;
      }
      pendingWeb = request;
      if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) grantWeb();
      else requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_WEB);
    }

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
      if (!origin(Uri.parse(origin)).equals(serverOrigin)) {
        callback.invoke(origin, false, false);
        return;
      }
      pendingGeo = callback;
      pendingGeoOrigin = origin;
      if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) grantWeb();
      else requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_WEB);
    }

    /** Photos and GPX/FIT files for "Foto beitragen" and the tour import. */
    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
      if (pendingFiles != null) pendingFiles.onReceiveValue(null);
      pendingFiles = callback;
      Intent i = params.createIntent();
      if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
      try {
        startActivityForResult(i, REQ_FILE);
        return true;
      } catch (ActivityNotFoundException e) {
        pendingFiles = null;
        return false;
      }
    }

    @Override
    public void onProgressChanged(WebView view, int percent) {
      progress.setProgress(percent);
      progress.setVisibility(percent < 100 ? View.VISIBLE : View.GONE);
    }

    @Override
    public void onReceivedTitle(WebView view, String title) {
      setTitle(title);
    }
  }

  @Override
  protected void onDestroy() {
    if (visible.get() == this) visible = new WeakReference<>(null);
    web.removeJavascriptInterface("MyForrestNative");
    web.destroy();
    super.onDestroy();
  }
}

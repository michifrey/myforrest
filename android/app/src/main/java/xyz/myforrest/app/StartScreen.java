package xyz.myforrest.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.function.Consumer;

/**
 * The screen of the app itself, shown instead of the web page when there is no server yet (first start,
 * "Server wechseln") or when it cannot be reached: what the app needs, the address, and a test of the
 * connection before the page is loaded. Built in code (no layout files), like the rest of the app.
 */
final class StartScreen {
  static final String DOCS = "https://michifrey.github.io/myforrest/android/";
  private static final int GREEN = 0xff2f5d3a;
  private static final int INK = 0xff1f2a20;
  private static final int MUTED = 0xff5d6b5e;
  private static final int ERROR = 0xffb3261e;

  private final Activity activity;
  private final Consumer<String> onConnected;
  private final ScrollView view;
  private final EditText address;
  private final TextView message;
  private final Button connect;
  private final ProgressBar busy;

  /** onConnected gets the checked address (with a trailing slash). */
  StartScreen(Activity activity, Consumer<String> onConnected) {
    this.activity = activity;
    this.onConnected = onConnected;

    LinearLayout box = new LinearLayout(activity);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_HORIZONTAL);
    int pad = dp(24);
    box.setPadding(pad, dp(48), pad, pad);

    ImageView logo = new ImageView(activity);
    logo.setImageResource(R.mipmap.ic_launcher);
    box.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(88)));

    TextView title = text("MyForrest", 30, INK);
    title.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));
    title.setPadding(0, dp(12), 0, dp(4));
    box.addView(title);
    TextView claim = text("Wald im Wandel – Fotos von unterwegs, über die Zeit", 15, MUTED);
    claim.setGravity(Gravity.CENTER);
    box.addView(claim);

    TextView explain = text("Die App zeigt die Karte, die Spots und deine Fotos von einem MyForrest-Server und "
        + "zeichnet Fahrten und Touren auch mit gesperrtem Bildschirm auf. Gib die Adresse deines Servers ein "
        + "(HTTPS, damit Kamera und Standort gehen).", 15, INK);
    explain.setPadding(0, dp(28), 0, dp(12));
    explain.setLineSpacing(0, 1.2f);
    box.addView(explain, full());

    address = new EditText(activity);
    address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    address.setHint("https://myforrest.example.org");
    address.setSingleLine(true);
    address.setImeOptions(EditorInfo.IME_ACTION_GO);
    address.setOnEditorActionListener((v, id, e) -> {
      check();
      return true;
    });
    box.addView(address, full());

    message = text("", 14, ERROR);
    message.setPadding(0, dp(8), 0, dp(8));
    box.addView(message, full());

    connect = new Button(activity);
    connect.setText("Verbinden");
    connect.setTextColor(Color.WHITE);
    connect.setAllCaps(false);
    connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(GREEN);
    bg.setCornerRadius(dp(24));
    connect.setBackground(bg);
    connect.setOnClickListener(v -> check());
    LinearLayout.LayoutParams lp = full();
    lp.height = dp(52);
    box.addView(connect, lp);

    busy = new ProgressBar(activity);
    busy.setIndeterminate(true);
    busy.setVisibility(View.GONE);
    box.addView(busy, new LinearLayout.LayoutParams(dp(36), dp(36)));

    TextView help = text("Noch kein Server? So richtest du einen ein", 15, GREEN);
    help.setPaintFlags(help.getPaintFlags() | android.graphics.Paint.UNDERLINE_TEXT_FLAG);
    help.setPadding(0, dp(24), 0, dp(8));
    help.setOnClickListener(v -> open(DOCS));
    box.addView(help);
    TextView version = text("Version " + BuildConfig.VERSION_NAME, 12, MUTED);
    box.addView(version);

    view = new ScrollView(activity);
    view.setFillViewport(true);
    view.setBackgroundColor(0xfff4f1e8);
    view.addView(box);
    view.setVisibility(View.GONE);
  }

  View view() {
    return view;
  }

  boolean shown() {
    return view.getVisibility() == View.VISIBLE;
  }

  /** Shows the screen with the address so far and, if any, why the last attempt failed. */
  void show(String server, String error) {
    if (server != null && !server.isEmpty()) address.setText(server.replaceAll("/$", ""));
    message.setText(error == null ? "" : error);
    setBusy(false);
    view.setVisibility(View.VISIBLE);
    view.bringToFront();
  }

  void hide() {
    view.setVisibility(View.GONE);
  }

  /** Normalises the address and asks the server for /api/config before the page is loaded. */
  private void check() {
    String v = address.getText().toString().trim();
    if (v.isEmpty()) {
      message.setText("Bitte die Adresse des Servers eingeben.");
      return;
    }
    if (!v.matches("(?i)^https?://.*")) v = "https://" + v;
    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
    String server = v + "/";
    message.setText("");
    setBusy(true);
    new Thread(() -> {
      String error = probe(server);
      activity.runOnUiThread(() -> {
        setBusy(false);
        if (error == null) onConnected.accept(server);
        else message.setText(error);
      });
    }, "server-check").start();
  }

  /** Null when a MyForrest server answers at the address, else what went wrong (in German, for the screen). */
  static String probe(String server) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) URI.create(server + "api/config").toURL().openConnection();
      c.setConnectTimeout(8000);
      c.setReadTimeout(8000);
      c.setRequestProperty("Accept", "application/json");
      int code = c.getResponseCode();
      String type = c.getContentType() == null ? "" : c.getContentType();
      if (code == 200 && type.contains("json")) {
        try (InputStream in = c.getInputStream()) {
          while (in.read() >= 0) { /* drain */ }
        }
        return null;
      }
      return "Unter dieser Adresse antwortet kein MyForrest-Server (HTTP " + code + ").";
    } catch (java.net.UnknownHostException e) {
      return "Adresse nicht gefunden. Stimmt sie, und ist das Handy online?";
    } catch (javax.net.ssl.SSLException e) {
      return "Keine sichere Verbindung (Zertifikat): " + e.getMessage();
    } catch (IOException | IllegalArgumentException e) {
      return "Server nicht erreichbar: " + e.getMessage();
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private void setBusy(boolean on) {
    busy.setVisibility(on ? View.VISIBLE : View.GONE);
    connect.setEnabled(!on);
    connect.setText(on ? "Verbinde …" : "Verbinden");
  }

  private void open(String url) {
    try {
      activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (android.content.ActivityNotFoundException ignored) {
      // no browser
    }
  }

  private TextView text(String s, int sp, int color) {
    TextView t = new TextView(activity);
    t.setText(s);
    t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
    t.setTextColor(color);
    return t;
  }

  private static LinearLayout.LayoutParams full() {
    return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
  }

  private int dp(int v) {
    return Math.round(v * activity.getResources().getDisplayMetrics().density);
  }
}

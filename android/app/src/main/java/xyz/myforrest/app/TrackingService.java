package xyz.myforrest.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Size;
import android.view.OrientationEventListener;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Records in the background, also with the screen off or another app in front (what a browser cannot):
 *
 * <ul>
 *   <li><b>tour</b>: the GPS track, filtered like the recording in public/tours.js.
 *   <li><b>drive</b> (dashcam): the route (a point every 25 m) and a picture every few seconds with the
 *       back camera; {@link DriveSelector} decides on the device which pictures are kept.
 * </ul>
 *
 * Everything goes to the {@link Session} on disk; the page (drive.js, tours.js) takes the route and the kept
 * pictures from there through {@link NativeBridge}, saves the tour and uploads the pictures.
 */
public class TrackingService extends Service {
  static final String ACTION_START = "xyz.myforrest.app.START";
  static final String ACTION_STOP = "xyz.myforrest.app.STOP";
  private static final String CHANNEL = "aufzeichnung";
  private static final int NOTIFICATION_ID = 1;
  private static final long FIX_MAX_AGE_MS = 10000;

  /** The running service, for the bridge (same process); null when none runs. */
  static volatile TrackingService current;

  private Session session;
  private String mode = "";
  private PowerManager.WakeLock wakeLock;
  private LocationManager locationManager;
  private Location fix;
  private final Handler main = new Handler(Looper.getMainLooper());

  // Drive mode
  private DriveSelector selector;
  private HandlerThread cameraThread;
  private Handler camera;
  private CameraDevice device;
  private CameraCaptureSession captureSession;
  private ImageReader stillReader;
  private ImageReader previewReader;
  private int sensorOrientation;
  private int deviceOrientation;
  private OrientationEventListener orientation;
  private long intervalMs = 3000;
  private boolean shooting;
  private long seq;
  private int shots;
  private long bytesSeen;
  private long bytesKept;
  private final int[] keptBy = new int[2]; // spot, abstand
  private long lastNotified;

  private final LocationListener locationListener = new LocationListener() {
    @Override
    public void onLocationChanged(Location location) {
      onFix(location);
    }

    @Override
    @SuppressWarnings("deprecation") // still called below API 29
    public void onStatusChanged(String provider, int status, Bundle extras) {
      // needed below API 29
    }

    @Override
    public void onProviderEnabled(String provider) {
      status("GPS ist wieder an.");
    }

    @Override
    public void onProviderDisabled(String provider) {
      status("GPS ist ausgeschaltet – bitte in den Einstellungen einschalten.");
    }
  };

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    session = Session.get(this);
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      stopRecording();
      return START_NOT_STICKY;
    }
    if (current == this && !mode.isEmpty()) return START_STICKY; // already running
    mode = session.mode();
    if (!session.running() || mode.isEmpty()) {
      stopSelf();
      return START_NOT_STICKY;
    }
    boolean drive = "drive".equals(mode);
    try {
      startForegroundTyped(drive);
    } catch (RuntimeException e) {
      // Restarted by the system while the app is in the background: Android does not allow the camera
      // (and on newer versions not the location) to start from there. The recording counts as interrupted.
      session.setError("Die Aufzeichnung wurde vom System unterbrochen. Bitte in der App neu starten.");
      stopSelf();
      return START_NOT_STICKY;
    }
    current = this;
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "myforrest:aufzeichnung");
    wakeLock.acquire(16 * 60 * 60 * 1000L); // a long day at most
    startLocation();
    if (drive) startDrive();
    status(drive ? "Fahrt läuft – warte auf GPS …" : "Aufzeichnung läuft – warte auf GPS …");
    return START_STICKY;
  }

  private void startForegroundTyped(boolean drive) {
    Notification n = notification(drive ? "Fahrtmodus läuft" : "Aufzeichnung läuft", "Warte auf GPS …");
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
      // Without the camera permission Android refuses the camera type; the drive then records the route only.
      boolean cam = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
      if (drive && cam && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
      startForeground(NOTIFICATION_ID, n, type);
    } else {
      startForeground(NOTIFICATION_ID, n);
    }
  }

  @Override
  public void onDestroy() {
    release();
    if (current == this) current = null;
    super.onDestroy();
  }

  /* ---------- Notification ---------- */

  private Notification notification(String title, String text) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "Aufzeichnung und Fahrtmodus", NotificationManager.IMPORTANCE_LOW);
      ch.setDescription("Zeigt an, solange GPS oder Kamera im Hintergrund aufzeichnen.");
      nm.createNotificationChannel(ch);
    }
    int immutable = PendingIntent.FLAG_IMMUTABLE;
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), immutable);
    PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TrackingService.class).setAction(ACTION_STOP), immutable);
    return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open)
        .addAction(new Notification.Action.Builder(null, "Beenden", stop).build())
        .build();
  }

  private void status(String text) {
    session.put("status", text);
    session.save();
    long now = SystemClock.elapsedRealtime();
    if (now - lastNotified < 2000) return; // the notification at most every 2 s
    lastNotified = now;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    nm.notify(NOTIFICATION_ID, notification("drive".equals(mode) ? "Fahrtmodus läuft" : "Aufzeichnung läuft", text));
  }

  /* ---------- GPS ---------- */

  @SuppressLint("MissingPermission") // checked before the service is started (MainActivity)
  private void startLocation() {
    locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      status("Ohne Erlaubnis für den Standort kann nichts aufgezeichnet werden.");
      return;
    }
    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, locationListener, Looper.getMainLooper());
  }

  private boolean fresh(Location l) {
    return l != null && (SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos()) / 1_000_000 < FIX_MAX_AGE_MS;
  }

  private void onFix(Location l) {
    fix = l;
    double acc = l.hasAccuracy() ? l.getAccuracy() : Double.NaN;
    try {
      JSONObject f = new JSONObject().put("lat", l.getLatitude()).put("lon", l.getLongitude()).put("time", l.getTime());
      if (l.hasAccuracy()) f.put("accuracy", Math.round(acc));
      if (l.hasSpeed()) f.put("speed", l.getSpeed());
      session.put("fix", f);
    } catch (JSONException ignored) {
      // finite numbers only
    }
    if (acc > 40) {
      status(String.format(Locale.ROOT, "Warte auf genaueres GPS (±%d m) …", Math.round(acc)));
      return;
    }
    JSONObject last = session.lastPoint();
    double d = last == null ? Double.POSITIVE_INFINITY
        : DriveSelector.distanceM(last.optDouble("lat"), last.optDouble("lon"), l.getLatitude(), l.getLongitude());
    // As in tours.js (a point when it moved more than half the accuracy) and drive.js (every 25 m).
    double minStep = "drive".equals(mode) ? 25 : Math.max(4, (Double.isNaN(acc) ? 0 : acc) / 2);
    if (d >= minStep) {
      try {
        JSONObject p = new JSONObject().put("lat", l.getLatitude()).put("lon", l.getLongitude()).put("time", l.getTime());
        if (!"drive".equals(mode) && l.hasAltitude()) p.put("ele", Math.round(l.getAltitude() * 10) / 10.0);
        session.addPoint(p);
      } catch (JSONException ignored) {
        // finite numbers only
      }
    }
    String speed = l.hasSpeed() ? String.format(Locale.ROOT, " · %d km/h", Math.round(l.getSpeed() * 3.6)) : "";
    if ("drive".equals(mode)) {
      status(String.format(Locale.ROOT, "%d Bilder · %d behalten · %.1f km%s", shots, keptBy[0] + keptBy[1],
          selector == null ? 0 : selector.distanceM() / 1000, speed));
    } else {
      status(String.format(Locale.ROOT, "%d Punkte · GPS ±%d m%s", session.pointCount(), Math.round(acc), speed));
    }
  }

  /* ---------- Drive mode: camera ---------- */

  private void startDrive() {
    JSONObject o = session.options();
    intervalMs = Math.max(1000, o.optLong("interval", 3) * 1000);
    DriveSelector.Options opt = new DriveSelector.Options();
    double everyM = o.optDouble("everyM", 150);
    if (everyM > 0) opt.everyM = everyM;
    else opt.onlySpots = true;
    List<DriveSelector.Spot> spots = new ArrayList<>();
    JSONArray s = session.spots();
    for (int i = 0; i < s.length(); i++) {
      JSONObject sp = s.optJSONObject(i);
      if (sp == null) continue;
      spots.add(new DriveSelector.Spot(String.valueOf(sp.opt("id")), sp.optDouble("lat"), sp.optDouble("lon"),
          sp.isNull("heading") ? Double.NaN : sp.optDouble("heading")));
    }
    selector = new DriveSelector(spots, opt);
    JSONObject m = session.meta();
    shots = m.optInt("shots");
    bytesSeen = m.optLong("bytesSeen");
    bytesKept = m.optLong("bytesKept");
    JSONObject k = m.optJSONObject("kept");
    if (k != null) {
      keptBy[0] = k.optInt("spot");
      keptBy[1] = k.optInt("abstand");
    }
    seq = Math.max(System.currentTimeMillis(), m.optLong("seq")); // ids stay unique across a restart

    orientation = new OrientationEventListener(this) {
      @Override
      public void onOrientationChanged(int degrees) {
        if (degrees != ORIENTATION_UNKNOWN) deviceOrientation = ((degrees + 45) / 90 * 90) % 360;
      }
    };
    if (orientation.canDetectOrientation()) orientation.enable();

    cameraThread = new HandlerThread("kamera");
    cameraThread.start();
    camera = new Handler(cameraThread.getLooper());
    camera.post(this::openCamera);
  }

  @SuppressLint("MissingPermission") // checked before the service is started (MainActivity)
  private void openCamera() {
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      status("Ohne Erlaubnis für die Kamera wird nur die Route aufgezeichnet.");
      return;
    }
    CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
    try {
      String id = null;
      for (String c : cm.getCameraIdList()) {
        Integer facing = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
        if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
          id = c;
          break;
        }
      }
      if (id == null) {
        status("Keine Kamera auf der Rückseite gefunden.");
        return;
      }
      CameraCharacteristics ch = cm.getCameraCharacteristics(id);
      Integer so = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
      sensorOrientation = so == null ? 90 : so;
      StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
      Size still = pick(map.getOutputSizes(ImageFormat.JPEG), 1920 * 1080);
      Size preview = pick(map.getOutputSizes(ImageFormat.YUV_420_888), 640 * 480);
      stillReader = ImageReader.newInstance(still.getWidth(), still.getHeight(), ImageFormat.JPEG, 2);
      stillReader.setOnImageAvailableListener(this::onStill, camera);
      // A small stream that runs all the time keeps exposure and focus right; its frames are thrown away.
      previewReader = ImageReader.newInstance(preview.getWidth(), preview.getHeight(), ImageFormat.YUV_420_888, 2);
      previewReader.setOnImageAvailableListener(r -> {
        Image i = r.acquireLatestImage();
        if (i != null) i.close();
      }, camera);
      cm.openCamera(id, new CameraDevice.StateCallback() {
        @Override
        public void onOpened(CameraDevice d) {
          device = d;
          createSession();
        }

        @Override
        public void onDisconnected(CameraDevice d) {
          d.close();
          device = null;
          cameraLost();
        }

        @Override
        public void onError(CameraDevice d, int error) {
          d.close();
          device = null;
          cameraLost();
        }
      }, camera);
    } catch (CameraAccessException | RuntimeException e) {
      status("Kamera nicht verfügbar: " + e.getMessage());
      cameraLost();
    }
  }

  /** Another app took the camera, or it failed: try again in a while; the route goes on meanwhile. */
  private void cameraLost() {
    status("Kamera unterbrochen – neuer Versuch in 10 s. Die Route läuft weiter.");
    closeCamera();
    if (camera != null) camera.postDelayed(this::openCamera, 10000);
  }

  /** The size closest to the wanted number of pixels (not above, when possible). */
  private static Size pick(Size[] sizes, int pixels) {
    List<Size> all = new ArrayList<>(Arrays.asList(sizes));
    Size best = null;
    for (Size s : all) {
      int p = s.getWidth() * s.getHeight();
      if (p <= pixels && (best == null || p > best.getWidth() * best.getHeight())) best = s;
    }
    if (best != null) return best;
    for (Size s : all) if (best == null || s.getWidth() * s.getHeight() < best.getWidth() * best.getHeight()) best = s;
    return best;
  }

  @SuppressWarnings("deprecation") // createCaptureSession(List, …): the variant that exists since API 21
  private void createSession() {
    try {
      device.createCaptureSession(Arrays.asList(stillReader.getSurface(), previewReader.getSurface()), new CameraCaptureSession.StateCallback() {
        @Override
        public void onConfigured(CameraCaptureSession s) {
          captureSession = s;
          try {
            CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(previewReader.getSurface());
            b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            s.setRepeatingRequest(b.build(), null, camera);
            status("Kamera bereit.");
            camera.postDelayed(TrackingService.this::shoot, intervalMs);
          } catch (CameraAccessException | RuntimeException e) {
            cameraLost();
          }
        }

        @Override
        public void onConfigureFailed(CameraCaptureSession s) {
          cameraLost();
        }
      }, camera);
    } catch (CameraAccessException | RuntimeException e) {
      cameraLost();
    }
  }

  /** Every `interval`: one picture (skipped while the last one is still being handled). */
  private void shoot() {
    if (captureSession == null || device == null) return;
    camera.postDelayed(this::shoot, intervalMs);
    if (shooting) return;
    try {
      CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
      b.addTarget(stillReader.getSurface());
      b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
      b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
      b.set(CaptureRequest.JPEG_QUALITY, (byte) 85);
      // Upright as the phone is held (in the mount usually across); the server also reads the EXIF orientation.
      b.set(CaptureRequest.JPEG_ORIENTATION, (sensorOrientation + deviceOrientation + 360) % 360);
      shooting = true;
      captureSession.capture(b.build(), null, camera);
    } catch (CameraAccessException | RuntimeException e) {
      shooting = false;
      cameraLost();
    }
  }

  private void onStill(ImageReader r) {
    byte[] jpeg;
    Image image = r.acquireLatestImage();
    if (image == null) {
      shooting = false;
      return;
    }
    try {
      ByteBuffer buf = image.getPlanes()[0].getBuffer();
      jpeg = new byte[buf.remaining()];
      buf.get(jpeg);
    } finally {
      image.close();
    }
    try {
      handle(jpeg);
    } catch (RuntimeException e) {
      status("Bild konnte nicht verarbeitet werden: " + e.getMessage());
    } finally {
      shooting = false;
    }
  }

  /** Measures the picture, lets the selector decide and keeps or drops (on the camera thread). */
  private void handle(byte[] jpeg) {
    long id = ++seq;
    double time = System.currentTimeMillis();
    Location l = fresh(fix) ? fix : null;
    double[] measures = measure(jpeg);
    shots++;
    // Fix-less pictures are not stored at all (as in drive.js).
    if (l != null) {
      bytesSeen += jpeg.length;
      try {
        session.hold(id, jpeg);
      } catch (java.io.IOException e) {
        status("Kein Platz für das Bild: " + e.getMessage());
        l = null;
      }
    } else if (shots > 1) {
      bytesSeen += bytesSeen / (shots - 1);
    }
    double heading = l != null && l.hasBearing() && l.hasSpeed() && l.getSpeed() > 1 ? l.getBearing() : Double.NaN;
    DriveSelector.Frame f = new DriveSelector.Frame(id, time,
        l == null ? Double.NaN : l.getLatitude(), l == null ? Double.NaN : l.getLongitude(),
        l != null && l.hasAccuracy() ? l.getAccuracy() : Double.NaN,
        l != null && l.hasSpeed() ? l.getSpeed() : Double.NaN, heading,
        measures == null ? null : DriveSelector.dhash(Arrays.copyOfRange(measures, 0, 72)),
        measures == null ? Double.NaN : measures[72]);
    apply(selector.offer(f));
  }

  private void apply(List<DriveSelector.Decision> decisions) {
    for (DriveSelector.Decision d : decisions) {
      DriveSelector.Frame f = d.frame;
      if (!d.keep) {
        session.drop(f.id);
        continue;
      }
      try {
        JSONObject info = new JSONObject().put("id", f.id).put("time", (long) f.time).put("lat", f.lat).put("lon", f.lon)
            .put("reason", d.reason);
        if (Double.isFinite(f.heading())) info.put("heading", Math.round(f.heading()));
        if (d.spotId != null) info.put("spotId", d.spotId);
        long size = new java.io.File(new java.io.File(getFilesDir(), "session/held"), f.id + ".jpg").length();
        if (session.keep(f.id, info.put("size", size))) {
          bytesKept += size;
          keptBy["spot".equals(d.reason) ? 0 : 1]++;
        }
      } catch (JSONException ignored) {
        // finite numbers only
      }
    }
    saveCounters();
  }

  private void saveCounters() {
    try {
      session.put("shots", shots);
      session.put("seq", seq);
      session.put("bytesSeen", bytesSeen);
      session.put("bytesKept", bytesKept);
      session.put("kept", new JSONObject().put("spot", keptBy[0]).put("abstand", keptBy[1]));
      session.put("counts", new JSONObject(selector.counts()));
      session.put("distanceM", Math.round(selector.distanceM()));
      session.put("spotsDone", selector.spotsDone());
      session.save();
    } catch (JSONException ignored) {
      // finite numbers only
    }
  }

  /**
   * Grey values of the picture at 9×8 (for the hash) and the sharpness at 160×120, as drive.js measures
   * them on the video: 72 values + 1. Null when the JPEG cannot be read.
   */
  private static double[] measure(byte[] jpeg) {
    BitmapFactory.Options o = new BitmapFactory.Options();
    o.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
    o.inJustDecodeBounds = false;
    o.inSampleSize = 1;
    while (o.outWidth / (o.inSampleSize * 2) >= 320) o.inSampleSize *= 2;
    Bitmap full = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
    if (full == null) return null;
    double[] out = new double[73];
    double[] g9 = grey(Bitmap.createScaledBitmap(full, 9, 8, true));
    System.arraycopy(g9, 0, out, 0, 72);
    out[72] = DriveSelector.sharpness(grey(Bitmap.createScaledBitmap(full, 160, 120, true)), 160, 120);
    full.recycle();
    return out;
  }

  private static double[] grey(Bitmap b) {
    int w = b.getWidth();
    int h = b.getHeight();
    int[] px = new int[w * h];
    b.getPixels(px, 0, w, 0, 0, w, h);
    double[] g = new double[px.length];
    for (int i = 0; i < px.length; i++) {
      int c = px[i];
      g[i] = 0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);
    }
    b.recycle();
    return g;
  }

  private void closeCamera() {
    if (captureSession != null) {
      try {
        captureSession.close();
      } catch (RuntimeException ignored) {
        // already closed
      }
      captureSession = null;
    }
    if (device != null) {
      device.close();
      device = null;
    }
  }

  /* ---------- Stop ---------- */

  /** Ends the recording: decides a held candidate, marks the session finished and ends the service. */
  void stopRecording() {
    if (camera != null) {
      // On the camera thread, after a picture being handled.
      camera.removeCallbacksAndMessages(null);
      camera.post(() -> {
        if (selector != null) apply(selector.finish());
        main.post(this::finishAndStop);
      });
    } else {
      finishAndStop();
    }
  }

  private void finishAndStop() {
    release();
    if (session == null) session = Session.get(this);
    if (session.running()) session.finish();
    current = null;
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
    MainActivity.notifyPage();
  }

  private void release() {
    if (locationManager != null) {
      locationManager.removeUpdates(locationListener);
      locationManager = null;
    }
    if (orientation != null) {
      orientation.disable();
      orientation = null;
    }
    if (camera != null) {
      Handler h = camera;
      camera = null;
      h.removeCallbacksAndMessages(null);
      h.post(() -> {
        closeCamera();
        if (stillReader != null) stillReader.close();
        if (previewReader != null) previewReader.close();
        cameraThread.quitSafely();
      });
    }
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    wakeLock = null;
  }
}

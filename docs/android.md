# Android-App

MyForrest läuft im Browser und lässt sich als Web-App installieren. Eines kann ein Browser aber nicht:
**im Hintergrund aufzeichnen**. Sobald der Bildschirm aus ist oder eine andere App vorne liegt, halten Browser
Kamera und GPS einer Seite an. Darum gibt es zusätzlich eine kleine Android-App (Ordner
[`android/`](https://github.com/michifrey/myforrest/tree/main/android)). Sie zeigt dieselbe Web-App und
übernimmt die zwei Aufgaben, die im Hintergrund weiterlaufen müssen:

- **Fahrtmodus** (Dashcam im Auto): Kamera, GPS und die Auswahl der Bilder laufen in der App, auch mit
  gesperrtem Bildschirm oder mit der Navigation im Vordergrund.
- **Touren aufzeichnen**: Die GPS-Spur läuft weiter, wenn das Handy in der Tasche ist.

![Fahrtmodus in der Android-App](screenshots/android-fahrtmodus.jpg){ width="320" }

Alles andere (Karte, Zeitreise, Fotos beitragen, Wiederholungsfoto mit Overlay, Offline-Modus) ist die Web-App
wie im Browser. Neue Funktionen kommen deshalb ohne neue App-Version: Die App lädt die Seiten vom Server.

## Installieren

1. Die APK herunterladen: *Actions → Android-App →* letzter Lauf auf `main` *→ Artifacts*
   (`myforrest-release-apk`, oder `myforrest-debug-apk` zum Ausprobieren). Wer selbst baut, siehe unten.
2. Auf dem Handy öffnen und die Installation aus dieser Quelle erlauben.
3. Beim ersten Start fragt die App nach der **Adresse des Servers** (z. B. `https://myforrest.example.org`),
   ausser sie wurde beim Bauen fest eingetragen. Wechseln lässt sie sich später über die Verknüpfung
   *Server wechseln* (lange auf das App-Symbol drücken).

Voraussetzung: Android 8.0 oder neuer. Der Server braucht HTTPS, sonst geben WebView und Browser Kamera und
Standort nicht frei.

## Fahrtmodus im Hintergrund

*Touren & Aufträge → Fahrtmodus* (oder lange auf das App-Symbol drücken → *Fahrtmodus*) sieht aus wie im
Browser. Mit *Fahrt starten* fragt die App einmal nach Standort, Kamera und Benachrichtigungen. Dann:

- Ein **Dienst im Vordergrund** fotografiert mit der Kamera auf der Rückseite alle 2, 3, 5 oder 10 Sekunden und
  zeichnet die Strecke auf (ein Punkt alle 25 m). Eine Benachrichtigung zeigt, dass er läuft, mit den
  Zählern und dem Knopf *Beenden*. Der Bildschirm darf aus sein; die Ansicht der App braucht keine Vorschau.
- **Die Auswahl** trifft die App selbst, mit denselben Regeln wie im Browser (an Spots, alle 150 m, Stillstand,
  unscharf, doppelt; siehe [Fahrtmodus](funktionen.md#fahrtmodus-dashcam-im-auto)). Sie ist in Java
  nachgebaut (`DriveSelector.java`) und wird gegen dieselben Testfälle geprüft wie `public/drive-select.js`
  (`test/fixtures/drive-select-cases.json`); beide entscheiden Bild für Bild gleich.
- **Behaltene Bilder** legt die App in ihrem eigenen Speicher ab. Die Seite holt sie alle 2 Sekunden ab und
  stellt sie in die Upload-Warteschlange, die sie wie gewohnt sendet, auch nach einem Funkloch. Ist die Seite
  zu (App aus der Übersicht geschoben), warten die Bilder in der App bis zum nächsten Öffnen.
- **Beenden** geht in der App oder in der Benachrichtigung. Die Seite speichert danach die Strecke als Tour
  *Fahrt …* (offline später) und meldet, wie viele Bilder behalten wurden. Wurde die App während der Fahrt
  vom System beendet, gilt die Fahrt beim nächsten Öffnen als unterbrochen; Strecke und behaltene Bilder
  bleiben erhalten.
- Nimmt eine andere App die Kamera (z. B. ein Videoanruf), versucht es die App alle 10 Sekunden wieder; die
  Strecke läuft weiter. Ohne Kamera-Erlaubnis zeichnet sie nur die Strecke auf.

## Touren im Hintergrund aufzeichnen

*Touren & Aufträge → Aufzeichnen* startet in der App denselben Dienst ohne Kamera. Die GPS-Spur wird gefiltert
wie im Browser (nur Punkte mit ±40 m oder besser, ein neuer Punkt, wenn man sich um mehr als die halbe
Genauigkeit bewegt hat, mit Höhe). Die Seite zeigt die Linie live, solange sie offen ist. Wird die App
geschlossen, läuft die Aufzeichnung weiter; beim nächsten Öffnen erscheint die Tour mit allen Punkten, beendet
oder noch laufend.

## Was die App sonst anders macht

- **Kamera und Standort der Seite** (Wiederholungsfoto mit Overlay, Standort auf der Karte) gibt die App nach
  der Android-Erlaubnis frei, aber nur für den eingestellten Server.
- **Links auf andere Seiten** öffnen sich im Browser. Die Anmeldung über GitHub, Microsoft, SWITCH edu-ID und
  andere OpenID-Connect-Dienste bleibt in der App. **Google** erlaubt die Anmeldung nicht in eingebetteten
  Ansichten; in der App deshalb mit E-Mail und Passwort oder einem der anderen Dienste anmelden.
- **Push-Mitteilungen** und Benachrichtigungen über Uploads im Hintergrund kennt die WebView nicht; dafür
  bleibt die installierte Web-App im Browser.
- **Dateien herunterladen** (GPX-Export, Datenexport) geht in der App nicht; dafür den Browser nehmen.

## Wie es gebaut ist

```text
android/app/src/main/java/xyz/myforrest/app/
  MainActivity.java     WebView mit der Web-App, Erlaubnisse, Dateiauswahl, Serveradresse
  NativeBridge.java     window.MyForrestNative für die Seite (nur für den eingestellten Server)
  TrackingService.java  Dienst im Vordergrund: GPS (LocationManager), Kamera (Camera2), Auswahl
  Session.java          die laufende Aufzeichnung auf dem Gerät: meta.json, route.jsonl, held/, kept/
  DriveSelector.java    die Auswahl der Fahrtbilder, wie public/drive-select.js
public/native.js        nativeApp: die Brücke für drive.js und tours.js, null im Browser
```

Die App hat keine Bibliotheken ausser dem Android-SDK (WebView, Camera2, LocationManager), damit sie klein
bleibt und ohne Google-Dienste läuft. Die Seite erkennt die App an `window.MyForrestNative`; im Browser ändert
sich nichts.

Die Brücke liefert nur Text (JSON):

| Aufruf | Antwort |
|--------|---------|
| `info()` | Plattform, Version, Funktionen (`tour`, `drive`) |
| `start(mode, options)` | `ok` oder der Grund, warum nicht; fragt zuerst nach den Erlaubnissen |
| `state()` | Modus, läuft/beendet/unterbrochen, Fehler, Status, letzter GPS-Punkt, Zähler, Anzahl Punkte und wartende Bilder |
| `route(from)` | Punkte der Strecke ab Index `from` |
| `kept()`, `frame(id)`, `ack(id)` | behaltene Bilder (Ort, Zeit, Richtung, Spot), ein Bild als Base64, Bild ist in der Warteschlange |
| `stop()`, `clear()` | beenden (wartet auf das letzte Bild), Aufzeichnung löschen, wenn die Seite alles übernommen hat |

## Selbst bauen

Mit Android Studio den Ordner `android/` öffnen, oder auf der Kommandozeile (JDK 17 und Android-SDK nötig):

```bash
cd android
./gradlew test                     # Auswahl wie drive-select.js (gemeinsame Testfälle)
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease -PmyforrestUrl=https://myforrest.example.org
```

Die Serveradresse lässt sich mit `-PmyforrestUrl=…` oder der Umgebungsvariable `MYFORREST_URL` fest eintragen.
Eine signierte Release-APK braucht einen Schlüssel: `ANDROID_KEYSTORE` (Pfad), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Ohne sie ist die Release-APK unsigniert.

Ändert sich die Auswahl der Fahrtbilder, gehört die Änderung in `public/drive-select.js` **und**
`DriveSelector.java`. Danach die Testfälle neu schreiben und beide Tests laufen lassen:

```bash
UPDATE_FIXTURES=1 node --test test/drive.test.js
cd android && ./gradlew test
```

### Auf GitHub

Der Workflow *Android-App* (`.github/workflows/android.yml`) läuft bei Änderungen an `android/`, an
`public/drive-select.js` oder an den Testfällen: Tests, Debug-APK als Artifact. Auf `main` baut er zusätzlich
eine signierte Release-APK, wenn diese Einstellungen gesetzt sind (*Settings → Secrets and variables →
Actions*):

| Name | Art | Inhalt |
|------|-----|--------|
| `APP_URL` | Variable | Adresse des Servers, fest in der App (sonst fragt sie beim ersten Start) |
| `ANDROID_KEYSTORE_BASE64` | Secret | Schlüsselbund, `base64 -w0 release.jks` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Secret | Passwort, Alias und Schlüsselpasswort |

Einen Schlüssel erzeugt `keytool -genkeypair -v -keystore release.jks -alias myforrest -keyalg RSA -keysize 4096
-validity 10000`. Gut aufbewahren: Updates einer installierten App müssen mit demselben Schlüssel signiert sein.

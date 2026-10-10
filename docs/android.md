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

1. Auf dem Handy die neueste Version laden:
   **[myforrest.apk](https://github.com/michifrey/myforrest/releases/latest/download/myforrest.apk)**
   (alle Versionen unter [Releases](https://github.com/michifrey/myforrest/releases)). Wer selbst baut, siehe unten.
2. Die Datei öffnen und die Installation aus dieser Quelle erlauben. Steht im Release *Testversion
   (Debug-Signatur)*, vor einem Update die alte Version deinstallieren (siehe [Auf GitHub](#auf-github)).
3. Beim ersten Start zeigt die App ihren **Startbildschirm** und fragt nach der Adresse des Servers (z. B.
   `https://myforrest.example.org`), ausser sie wurde beim Bauen fest eingetragen. *Verbinden* prüft zuerst,
   ob dort ein MyForrest-Server antwortet (`/api/config`), und sagt sonst, was nicht stimmt (Adresse nicht
   gefunden, Zertifikat, kein MyForrest-Server). Auch bei jedem weiteren Start prüft die App den
   gespeicherten Server zuerst und zeigt so lange den Startbildschirm. Antwortet er nicht, bleibt sie dort,
   mit *Trotzdem öffnen* für die offline gespeicherten Seiten (z. B. im Wald ohne Empfang). Wechseln lässt
   sich die Adresse dort oder über die Verknüpfung *Server wechseln* (lange auf das App-Symbol drücken).

Die App braucht einen laufenden MyForrest-Server; ohne ihn zeigt sie nur den Startbildschirm. Wie man einen
einrichtet: [Eigener Server: VPS, Synology und Render](hosting.md); zum Ausprobieren
reicht der eigene PC mit einem [Cloudflare Tunnel](installation.md#zum-testen-server-auf-dem-eigenen-pc-mit-cloudflare-tunnel).

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
  der Android-Erlaubnis frei, aber nur für den eingestellten Server. Beim ersten Start fragt Android deshalb nach
  dem Standort, sobald die Karte ihn wissen will ([Eigener Standort](funktionen.md#eigener-standort)).
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
  StartScreen.java      Startbildschirm ohne Server: Adresse eingeben, Verbindung prüfen
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
`public/drive-select.js` oder an den Testfällen (und von Hand: *Actions → Android-App → Run workflow*):

- **Pull Request**: Tests, Debug-APK als Artifact zum Ausprobieren.
- **`main`**: zusätzlich ein **Release** auf der Seite [Releases](https://github.com/michifrey/myforrest/releases)
  mit der Datei `myforrest.apk`, Version `1.0.<Laufnummer>`, Tag `android-1.0.<Laufnummer>`. Die neueste ist
  immer unter `…/releases/latest/download/myforrest.apk` zu haben.

Ohne eigenen Schlüssel enthält das Release die Debug-APK. Die ist bei jedem Lauf mit einem anderen Schlüssel
signiert, Android lehnt ein Update darüber deshalb ab: erst deinstallieren, dann die neue installieren (die
Aufzeichnungen auf dem Gerät gehen dabei verloren, hochgeladene Fotos und gespeicherte Touren nicht). Mit
eigenem Schlüssel ist es eine signierte Release-APK, und Updates gehen direkt. Die Einstellungen dafür
(*Settings → Secrets and variables → Actions*):

| Name | Art | Inhalt |
|------|-----|--------|
| `APP_URL` | Variable | Adresse des Servers, fest in der App (sonst fragt sie beim ersten Start) |
| `ANDROID_KEYSTORE_BASE64` | Secret | Schlüsselbund, `base64 -w0 release.jks` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Secret | Passwort, Alias und Schlüsselpasswort |

Einen Schlüssel erzeugt `keytool -genkeypair -v -keystore release.jks -alias myforrest -keyalg RSA -keysize 4096
-validity 10000`. Gut aufbewahren: Updates einer installierten App müssen mit demselben Schlüssel signiert sein.

## Und das iPhone?

Auf dem iPhone bleibt MyForrest vorerst die Web-App: in Safari öffnen, *Teilen → Zum Home-Bildschirm*. Eine
App zum Herunterladen von GitHub gibt es dort nicht, und auch eine eigene App würde nicht alles lösen:

- **Installieren**: iOS installiert Apps nur aus dem App Store, über TestFlight oder für einzeln
  eingetragene Geräte. Alle Wege brauchen ein Apple-Entwicklerkonto (99 US-Dollar im Jahr) und einen Mac mit
  Xcode zum Signieren; eine Datei auf der Releases-Seite lässt sich nicht einfach öffnen und installieren.
- **Fahrtmodus**: iOS erlaubt einer App die Kamera nur, solange sie im Vordergrund ist. Fotografieren mit
  gesperrtem Bildschirm geht auf dem iPhone grundsätzlich nicht, auch nicht mit einer eigenen App.
- **Touren aufzeichnen**: Das ginge mit einer App (Standort im Hintergrund ist erlaubt).

Eine iOS-App mit Aufzeichnung im Hintergrund steht in der [Roadmap](roadmap.md).

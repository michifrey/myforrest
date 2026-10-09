# MyForrest – Wald im Wandel

**Street View für die Natur, über die Zeit.** MyForrest sammelt Fotos von Orten im Wald, an Gletschern und im
Gebirge, legt sie zeitlich übereinander und zeigt, was sich verändert hat: Sturmschäden, Borkenkäfernester,
neue Lichtungen, Neophyten, schmelzendes Eis.

![Startseite von MyForrest](screenshots/hero.jpg)

Dies ist die Doku des Projekts. Sie entsteht aus den Dateien in [`docs/`](https://github.com/michifrey/myforrest/tree/main/docs)
im Repository und wird bei jeder Änderung neu veröffentlicht. Fehler gefunden oder etwas fehlt? Oben rechts auf
jeder Seite führt *Diese Seite bearbeiten* direkt zur Datei auf GitHub; daraus wird ein Pull Request.

## Wo anfangen?

<div class="grid cards" markdown>

-   **Die App kennenlernen**

    ---

    Was MyForrest kann, mit Screenshots und den Verfahren dahinter: Spots, Zeitreise, Vorher/Nachher,
    Wiederholungsfotos, Wetter und Satellit, Arten, Touren, Gletscher.

    [Funktionen im Detail](funktionen.md) · [Android-App](android.md)

-   **Selbst hosten**

    ---

    Was eine eigene Instanz braucht, Speicher, Ports, Zertifikate und Lizenzen, dann alle Umgebungsvariablen
    und der Betrieb mit Datenschutz und Datenquellen.

    [Tech-Onboarding](tech-onboarding.md) · [Installation](installation.md) · [Betrieb](betrieb.md)

-   **Mitentwickeln**

    ---

    Aufbau des Codes (Node.js, Express, `node:sqlite`, Leaflet ohne Build-Schritt) und alle Routen der
    REST-API.

    [Architektur](architektur.md) · [REST-API](api.md)

-   **Was als Nächstes kommt**

    ---

    Geplante Funktionen nach Phasen, und was schon umgesetzt ist.

    [Roadmap](roadmap.md)

</div>

## In drei Schritten

1. **Unterwegs fotografieren**: Ein Handyfoto mit GPS, ein Video oder eine Action-Cam mit GPX-Track. Die App
   findet den Ort automatisch.
2. **Am selben Ort wiederkommen**: Beim nächsten Besuch liegt das alte Foto als Overlay über dem Kamerabild.
3. **Veränderung sichtbar machen**: Die Fotos werden ausgerichtet; Zeitraffer, Vorher/Nachher-Regler und
   Heatmap zeigen, was passiert ist.

Den Code, den Schnellstart und die Lizenz gibt es im [Repository auf GitHub](https://github.com/michifrey/myforrest).

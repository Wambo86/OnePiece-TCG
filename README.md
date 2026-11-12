# Logbuch – One Piece TCG Karten-App

Web-App fürs iPhone (läuft in Safari, per „Zum Home-Bildschirm“ wie eine App installierbar):

- **Scannen** – die Kamera liest die Kartennummer unten rechts (z. B. `OP01-001`); alternativ Foto oder Nummer eintippen
- **Besitz** – gescannte Karten mit Anzahl, Suche, Filter und Gesamtwert
- **Decks** – Decks aus dem eigenen Besitz bauen (1 Leader, 50 Karten, max. 4 je Nummer, Leader-Farbe)
- **Preise** – Cardmarket-Preistrend je Karte, mit Link zur Karte auf Cardmarket

Besitz und Decks werden nur auf dem Gerät gespeichert (unter „Besitz → Sicherung“ als Datei exportierbar).

## Daten

`scripts/build-data.mjs` erzeugt `data/cards.json` (Karten und Bild-Adressen von optcgapi.com) und
`data/prices.json` (öffentliche tägliche Preisdatei von Cardmarket). Der Workflow
`.github/workflows/pages.yml` führt das täglich aus und veröffentlicht die App auf GitHub Pages.
Die erzeugten Dateien unter `data/` werden nicht ins Repository eingecheckt.

```bash
node scripts/build-data.mjs
```

## Lokal starten

```bash
python3 -m http.server 8000
```

Die Kamera funktioniert nur über HTTPS oder `localhost`.

## Fremdkomponenten

Texterkennung: [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), liegt unter `vendor/tesseract`.
Inoffizielles Fan-Projekt, nicht verbunden mit Bandai oder Cardmarket.

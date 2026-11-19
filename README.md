# Logbuch – One Piece TCG Karten-App

Web-App fürs iPhone (läuft in Safari, per „Zum Home-Bildschirm“ wie eine App installierbar):

- **Scannen** – die Kamera liest die Kartennummer unten rechts (z. B. `OP01-001`); alternativ Foto oder Nummer eintippen
- **Besitz** – gescannte Karten mit Anzahl, Suche, Filter und Gesamtwert
- **Decks** – Decks aus dem eigenen Besitz bauen (1 Leader, 50 Karten, max. 4 je Nummer, Leader-Farbe)
- **Preise** – Cardmarket-Preistrend je Karte, mit Link zur Karte auf Cardmarket

Besitz und Decks werden nur auf dem Gerät gespeichert (unter „Besitz → Sicherung“ als Datei exportierbar).

## Kartentresor – Pokémon (`pokemon/`)

Zweite App im selben Projekt, erreichbar unter `…/pokemon/` (eigenes Icon, separat am Home-Bildschirm installierbar):

- **Scannen** – die Kamera liest die Nummer unten auf der Karte (z. B. `MEW 025/165`, `TG05/TG30`, `SVP 085`); bei mehrdeutigen Nummern zeigt die App die passenden Karten zur Auswahl. Optional ein Set festlegen, dann reicht die Nummer. Schnell-Scan zählt jede erkannte Karte automatisch +1.
- **Sammlung** – Karten mit Anzahl (normal / Reverse Holo), optionalem Einkaufspreis, Gesamtwert, Gewinn/Verlust, Wertverlauf, größten Gewinnern/Verlierern seit dem letzten Preisstand, Raster- oder Listenansicht, Set-Fortschritt mit Checkliste
- **Preise** – Cardmarket-Preistrend, ab-Preis, Ø 1/7/30 Tage und Reverse-Holo-Preise, Link direkt zum Cardmarket-Produkt
- **Preis-Alarm** – Grenzen je Karte („über/unter X €“, auch für Karten, die man noch nicht besitzt), Überwachung der ganzen Sammlung (± 20/30/50/100 %), Gerätemeldung beim Öffnen der App
- Deutsche Pokémon-Namen in Suche und Anzeige, CSV-Export, Sicherung als Datei

`scripts/build-pokemon-data.mjs` erzeugt `pokemon/data/cards.json` (Karten aus
[PokemonTCG/pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data), deutsche Namen aus
[PokeAPI](https://github.com/PokeAPI/pokeapi)) und `pokemon/data/prices.json` (öffentliche Cardmarket-Preisdatei für Pokémon).
Cardmarket-Produkte tragen keine Kartennummer; das Skript ordnet sie über Name, Attacken und Erweiterung den Karten zu (rund 97 % der Karten bekommen einen Preis).

```bash
node scripts/build-pokemon-data.mjs
```

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
Inoffizielles Fan-Projekt, nicht verbunden mit Bandai, Nintendo, The Pokémon Company oder Cardmarket.

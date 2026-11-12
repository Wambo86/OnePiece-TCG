#!/usr/bin/env node
// Baut data/cards.json (Kartendatenbank von optcgapi.com) und
// data/prices.json (öffentliche Cardmarket-Preisdatei) für die App.
// Aufruf: node scripts/build-data.mjs
// Schlägt eine Quelle fehl, bleibt die vorhandene Datei unverändert.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data');

const CARD_SOURCES = [
  'https://optcgapi.com/api/allSetCards/',
  'https://optcgapi.com/api/allSTCards/',
  'https://optcgapi.com/api/allPromos/',
];
const CM_PRODUCTS = 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_18.json';
const CM_PRICES = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_18.json';

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'optcg-collection-app' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const NUM_RE = /^(OP|ST|EB|PRB)\d{2}-\d{3}|^P-\d{3}/;

async function buildCards() {
  const lists = await Promise.all(CARD_SOURCES.map(getJson));
  const seen = new Map();
  for (const c of lists.flat()) {
    const m = String(c.card_set_id || '').match(NUM_RE);
    if (!m) continue;
    const num = m[0];
    const img = c.card_image || '';
    // Schlüssel = Bild-Dateiname: eindeutig pro Artwork und stabil über Aktualisierungen.
    const key = img ? decodeURIComponent(img.split('/').pop().replace(/\.[a-z]+$/i, '')) : `${c.card_image_id || num}~noimg`;
    if (seen.has(key)) continue;
    const rawName = String(c.card_name || '').trim();
    seen.set(key, {
      k: key,
      n: num,
      name: rawName.replace(/\s*\([^)]*\)/g, '').replace(/\s*-\s*((OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})\s*$/, '').trim() || rawName,
      v: [...rawName.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]).filter((x) => !/^\d{3}$/.test(x) && !NUM_RE.test(x)).join(', '),
      set: c.set_name || '',
      sid: c.set_id || '',
      r: c.rarity || '',
      col: ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'].filter((x) => String(c.card_color || '').includes(x)),
      t: c.card_type || '',
      cost: c.card_cost ?? null,
      pow: c.card_power ?? null,
      cnt: c.counter_amount || null,
      life: c.life ?? null,
      attr: c.attribute || '',
      sub: c.sub_types || '',
      txt: c.card_text || '',
      img,
    });
  }
  const cards = [...seen.values()].sort((a, b) => a.n.localeCompare(b.n) || a.k.localeCompare(b.k));
  if (cards.length < 1000) throw new Error(`nur ${cards.length} Karten – Quelle wirkt unvollständig`);
  return { updated: new Date().toISOString(), cards };
}

async function buildPrices() {
  const [prod, guide] = await Promise.all([getJson(CM_PRODUCTS), getJson(CM_PRICES)]);
  const byId = new Map(guide.priceGuides.map((g) => [g.idProduct, g]));
  const p = {};
  let n = 0;
  for (const pr of prod.products) {
    const m = pr.name.match(/\(((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})\)/);
    if (!m) continue;
    const g = byId.get(pr.idProduct);
    if (!g || (g.trend == null && g.low == null && g.avg == null)) continue;
    // [idProduct, ab-Preis, Trend, 30-Tage-Schnitt]
    (p[m[1]] ||= []).push([pr.idProduct, g.low ?? null, g.trend || null, g.avg30 ?? g.avg ?? null]);
    n++;
  }
  if (n < 1000) throw new Error(`nur ${n} Preise – Quelle wirkt unvollständig`);
  for (const list of Object.values(p)) list.sort((a, b) => (a[2] ?? a[1] ?? 1e9) - (b[2] ?? b[1] ?? 1e9));
  return { updated: guide.createdAt, p };
}

await mkdir(OUT, { recursive: true });
let failed = false;
for (const [file, fn] of [['cards.json', buildCards], ['prices.json', buildPrices]]) {
  try {
    const data = await fn();
    await writeFile(path.join(OUT, file), JSON.stringify(data));
    console.log(`${file}: ok (${Object.keys(data.cards || data.p).length} Einträge)`);
  } catch (err) {
    failed = true;
    console.error(`${file}: FEHLER – ${err.message} (alte Datei bleibt bestehen)`);
  }
}
process.exit(failed ? 1 : 0);

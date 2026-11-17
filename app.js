'use strict';
/* Logbuch – One Piece TCG: Scannen, Besitz, Decks, Cardmarket-Preise.
   Daten: data/cards.json + data/prices.json (siehe scripts/build-data.mjs).
   Besitz und Decks liegen nur auf diesem Gerät (localStorage). */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => (v == null ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
const COLOR_DE = { Red: 'Rot', Green: 'Grün', Blue: 'Blau', Purple: 'Lila', Black: 'Schwarz', Yellow: 'Gelb' };
const TYPE_DE = { Leader: 'Leader', Character: 'Charaktere', Event: 'Events', Stage: 'Stages' };
const TYPE_ORDER = ['Leader', 'Character', 'Event', 'Stage'];

/* ---------- Daten ---------- */
const DB = { cards: [], byKey: new Map(), byNum: new Map(), updated: '' };
const PR = { p: {}, updated: '' };

async function loadData() {
  const [c, p] = await Promise.all([
    fetch('data/cards.json').then((r) => { if (!r.ok) throw new Error('cards'); return r.json(); }),
    fetch('data/prices.json').then((r) => (r.ok ? r.json() : { p: {}, updated: '' })).catch(() => ({ p: {}, updated: '' })),
  ]);
  DB.cards = c.cards; DB.updated = c.updated;
  for (const card of c.cards) {
    DB.byKey.set(card.k, card);
    if (!DB.byNum.has(card.n)) DB.byNum.set(card.n, []);
    DB.byNum.get(card.n).push(card);
  }
  // Standard-Motiv (Schlüssel = Nummer) zuerst
  for (const list of DB.byNum.values()) list.sort((a, b) => (b.k === b.n) - (a.k === a.n));
  PR.p = p.p || {}; PR.updated = p.updated || '';
}

/* ---------- Speicher ---------- */
const STORE_KEY = 'optcg.logbuch.v1';
let store = { own: {}, decks: [], pick: {}, base: {}, notify: false, notifiedFor: '' };
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && typeof raw === 'object') store = { own: raw.own || {}, decks: Array.isArray(raw.decks) ? raw.decks : [], pick: raw.pick || {}, base: raw.base || {}, notify: !!raw.notify, notifiedFor: raw.notifiedFor || '' };
  } catch { /* leerer Start */ }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch { toast('Speichern fehlgeschlagen – Speicher des Geräts ist voll oder gesperrt.'); }
}
const owned = (k) => store.own[k] || 0;
function setOwned(k, n) {
  if (n <= 0) delete store.own[k]; else store.own[k] = n;
  // Decks dürfen nie mehr Exemplare enthalten, als im Besitz sind
  for (const d of store.decks) {
    if (d.cards[k] > n) { if (n <= 0) delete d.cards[k]; else d.cards[k] = n; }
  }
  // Merkpreis für den Preis-Alarm: beim ersten Exemplar festhalten, beim letzten löschen
  if (n <= 0) delete store.base[k];
  else if (!store.base[k]) { const v = valueOf(DB.byKey.get(k)); if (v > 0) store.base[k] = { p: v, t: DB.updated || new Date().toISOString() }; }
  saveStore();
}

/* ---------- Preise ---------- */
function priceOf(card) {
  const list = PR.p[card.n];
  if (!list || !list.length) return null;
  const pickId = store.pick[card.k];
  const row = list.find((r) => r[0] === pickId) || list[0];
  return { id: row[0], low: row[1], trend: row[2], avg: row[3], value: row[2] ?? row[3] ?? row[1], picked: row[0] === pickId, versions: list };
}
const valueOf = (card) => priceOf(card)?.value ?? 0;
const cmSearch = (num) => `https://www.cardmarket.com/de/OnePiece/Products/Search?searchString=${encodeURIComponent(num)}`;
const cmProduct = (id) => `https://www.cardmarket.com/de/OnePiece/Products?idProduct=${id}`;

/* ---------- Preis-Alarm ---------- */
// Meldet Karten im Besitz, deren Cardmarket-Wert seit dem gemerkten Preis mindestens so stark gestiegen ist.
const ALERT_FACTOR = 2;
function ensureBaselines() {
  // Für jede besessene Karte einen Merkpreis anlegen, falls noch keiner da ist (z. B. nach dem Update).
  let changed = false;
  for (const k of Object.keys(store.own)) {
    if (store.base[k]) continue;
    const card = DB.byKey.get(k); if (!card) continue;
    const v = valueOf(card);
    if (v > 0) { store.base[k] = { p: v, t: DB.updated || new Date().toISOString() }; changed = true; }
  }
  if (changed) saveStore();
}
function priceAlerts() {
  const out = [];
  for (const k of Object.keys(store.own)) {
    const card = DB.byKey.get(k), b = store.base[k];
    if (!card || !b || !b.p) continue;
    const v = valueOf(card);
    if (v >= b.p * ALERT_FACTOR) out.push({ card, from: b.p, to: v, since: b.t });
  }
  return out.sort((a, b) => b.to / b.from - a.to / a.from);
}
// „Erledigt": Merkpreis auf den aktuellen Wert setzen, damit die Karte erst bei erneuter Verdopplung wieder meldet.
function ackAlerts(keys) {
  for (const k of keys) { const card = DB.byKey.get(k); if (card) store.base[k] = { p: valueOf(card), t: DB.updated || new Date().toISOString() }; }
  saveStore();
}
async function enableNotifications() {
  if (!('Notification' in window)) { toast('Dieses Gerät zeigt hier keine Benachrichtigungen an.'); return; }
  let perm = Notification.permission;
  if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
  store.notify = perm === 'granted';
  saveStore();
  toast(store.notify ? 'Preis-Alarm aktiv. Tipp: die App am Home-Bildschirm installieren, damit Meldungen zuverlässig kommen.' : 'Benachrichtigungen wurden nicht erlaubt.');
  if (store.notify) maybeNotify(true);
  rerender();
}
// Zeigt eine Gerätemeldung, sobald sich beim aktuellen Datenstand etwas verdoppelt hat – höchstens einmal pro Preis-Stand.
function maybeNotify(force) {
  if (!store.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const alerts = priceAlerts();
  if (!alerts.length) { return; }
  if (!force && store.notifiedFor === PR.updated) return;
  store.notifiedFor = PR.updated; saveStore();
  const top = alerts[0];
  const body = alerts.length === 1
    ? `${top.card.name} (${top.card.n}): ${eur(top.from)} → ${eur(top.to)}`
    : `${alerts.length} Karten haben sich mindestens verdoppelt, u. a. ${top.card.name}.`;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'preis-alarm' };
  try {
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg && reg.showNotification) reg.showNotification('Preis-Alarm', opts);
      else new Notification('Preis-Alarm', opts);
    }).catch(() => { try { new Notification('Preis-Alarm', opts); } catch { /* ignorieren */ } });
    else new Notification('Preis-Alarm', opts);
  } catch { /* ignorieren */ }
}
function alertBanner() {
  const alerts = priceAlerts();
  if (!alerts.length) return '';
  return `<div class="alarm">
    <div class="alarm-head"><b>Preis-Alarm</b><button class="btn small" data-act="alert-ack-all">Alle erledigt</button></div>
    <p class="hint">Mindestens ${ALERT_FACTOR}× so teuer wie bei deinem gemerkten Preis:</p>
    ${alerts.map((a) => `<div class="alarm-row">
      <button class="open" data-act="open" data-k="${esc(a.card.k)}">${art(a.card)}
        <span class="nm"><b>${esc(a.card.name)}</b><span>${esc(a.card.n)} · ${eur(a.from)} → <b class="up">${eur(a.to)}</b> (×${(a.to / a.from).toFixed(1)})</span></span></button>
      <button class="btn small" data-act="alert-ack" data-k="${esc(a.card.k)}">Erledigt</button>
    </div>`).join('')}
  </div>`;
}

/* ---------- Bausteine ---------- */
function art(card, eager) {
  return card.img
    ? `<div class="art"><img src="${esc(card.img)}" alt="${esc(card.name)}" ${eager ? '' : 'loading="lazy"'} decoding="async"></div>`
    : `<div class="art"><span class="noimg">${esc(card.name)}<br>${esc(card.n)}</span></div>`;
}
const dots = (card) => `<span class="dots">${card.col.map((c) => `<i class="dot ${c}" title="${COLOR_DE[c]}"></i>`).join('')}</span>`;
function tile(card, { qty, qtyClass = '', disabled = false, act = 'open' } = {}) {
  const p = priceOf(card);
  return `<button class="tile" data-act="${act}" data-k="${esc(card.k)}" ${disabled ? 'disabled' : ''}>
    ${art(card)}${qty != null ? `<span class="qty ${qtyClass}">${qty}</span>` : ''}
    <span class="meta"><span>${esc(card.n)}</span><span class="p">${p ? eur(p.value) : ''}</span></span>
  </button>`;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function matches(card, q) {
  if (!q) return true;
  const hay = `${card.name} ${card.n} ${card.v} ${card.sub} ${card.set}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
function sortCards(list, mode) {
  const by = {
    num: (a, b) => a.n.localeCompare(b.n) || a.k.localeCompare(b.k),
    name: (a, b) => a.name.localeCompare(b.name) || a.n.localeCompare(b.n),
    price: (a, b) => valueOf(b) - valueOf(a),
    qty: (a, b) => owned(b.k) - owned(a.k) || a.n.localeCompare(b.n),
    cost: (a, b) => (Number(a.cost) || 0) - (Number(b.cost) || 0) || a.n.localeCompare(b.n),
  };
  return list.sort(by[mode] || by.num);
}
function setOptions() {
  const sets = new Map();
  for (const c of DB.cards) { const p = c.n.split('-')[0]; if (!sets.has(p)) sets.set(p, c.n.startsWith('P-') ? 'Promos' : c.set); }
  return [...sets.keys()].sort().map((p) => `<option value="${p}">${p}</option>`).join('');
}
const colorOptions = () => COLORS.map((c) => `<option value="${c}">${COLOR_DE[c]}</option>`).join('');

/* ---------- Router ---------- */
const view = $('#view');
const ui = { besitz: { q: '', sort: 'num', color: '', set: '' }, alle: { q: '', set: '', color: '', limit: 60 } };
function route() {
  const hash = location.hash.replace('#', '') || (Object.keys(store.own).length ? 'besitz' : 'scan');
  const [name, arg] = hash.startsWith('deck-') ? ['deck', hash.slice(5)] : [hash, null];
  if (name !== 'scan') Scanner.stop();
  document.querySelectorAll('.tabs a').forEach((a) => {
    const on = a.dataset.tab === name || (name === 'deck' && a.dataset.tab === 'decks');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#top-actions').innerHTML = '';
  ({ scan: viewScan, besitz: viewBesitz, decks: viewDecks, deck: viewDeck, alle: viewAlle }[name] || viewBesitz)(arg);
  window.scrollTo(0, 0);
}
const rerender = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };

/* ---------- Besitz ---------- */
function viewBesitz() {
  $('#title').textContent = 'Besitz';
  $('#top-actions').innerHTML = ('Notification' in window) ? `<button class="btn small" data-act="notify-enable">${store.notify ? 'Alarm an' : 'Alarm aus'}</button>` : '';
  const all = Object.keys(store.own).map((k) => DB.byKey.get(k)).filter(Boolean);
  if (!all.length) {
    view.innerHTML = `<div class="empty"><strong>Noch keine Karten im Besitz</strong>Scanne deine erste Karte oder suche sie unter „Alle Karten“.<br><a class="btn primary" href="#scan">Karte scannen</a></div>${backupBox()}`;
    return;
  }
  const total = all.reduce((s, c) => s + owned(c.k), 0);
  const worth = all.reduce((s, c) => s + owned(c.k) * valueOf(c), 0);
  const s = ui.besitz;
  view.innerHTML = `
    ${alertBanner()}
    <div class="stats">
      <div class="stat"><b>${total}</b><span>Karten</span></div>
      <div class="stat"><b>${all.length}</b><span>verschiedene</span></div>
      <div class="stat price"><b>${eur(worth)}</b><span>Cardmarket-Wert</span></div>
    </div>
    <div class="row">
      <input class="field grow" id="besitz-q" type="search" placeholder="Name oder Nummer suchen" value="${esc(s.q)}" autocomplete="off">
      <select class="field" id="besitz-color" style="width:auto" aria-label="Farbe"><option value="">Alle Farben</option>${colorOptions()}</select>
      <select class="field" id="besitz-sort" style="width:auto" aria-label="Sortierung">
        <option value="num">Nummer</option><option value="name">Name</option><option value="price">Preis</option><option value="qty">Anzahl</option>
      </select>
    </div>
    <div class="grid" id="besitz-grid"></div>
    ${backupBox()}`;
  $('#besitz-color').value = s.color; $('#besitz-sort').value = s.sort;
  const draw = () => {
    const list = sortCards(all.filter((c) => matches(c, s.q) && (!s.color || c.col.includes(s.color))), s.sort);
    $('#besitz-grid').innerHTML = list.map((c) => tile(c, { qty: `×${owned(c.k)}` })).join('') || '<p class="hint">Keine Karte passt zu dieser Suche.</p>';
  };
  draw();
  $('#besitz-q').oninput = (e) => { s.q = e.target.value; draw(); };
  $('#besitz-color').onchange = (e) => { s.color = e.target.value; draw(); };
  $('#besitz-sort').onchange = (e) => { s.sort = e.target.value; draw(); };
}
function backupBox() {
  const prDate = PR.updated ? new Date(PR.updated).toLocaleDateString('de-DE') : 'unbekannt';
  return `<details class="box"><summary>Sicherung &amp; Datenstand</summary><div class="body">
    <p class="hint">Besitz und Decks liegen nur auf diesem Gerät. Sichere sie als Datei, bevor du das Gerät wechselst oder Safari-Daten löschst.</p>
    <div class="row"><button class="btn small" data-act="export">Sicherung speichern</button>
    <label class="btn small">Sicherung laden<input type="file" id="import-file" accept="application/json,.json" hidden></label></div>
    <p class="hint">${DB.cards.length.toLocaleString('de-DE')} Kartenmotive · Cardmarket-Preise vom ${prDate} (Preistrend, wird täglich aktualisiert).</p>
    <p class="hint">Preis-Alarm: Sobald eine Karte im Besitz mindestens doppelt so teuer ist wie beim ersten Hinzufügen, erscheint sie oben in „Besitz“. Mit „Alarm an“ bekommst du zusätzlich eine Gerätemeldung – dafür muss die App am Home-Bildschirm installiert und eine Weile geöffnet worden sein; bei geschlossener App sind Meldungen auf dem iPhone nicht garantiert.</p>
  </div></details>`;
}
function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'logbuch', version: 1, exported: new Date().toISOString(), ...store }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `logbuch-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.own !== 'object') throw new Error();
    store = { own: data.own || {}, decks: Array.isArray(data.decks) ? data.decks : [], pick: data.pick || {}, base: data.base || {}, notify: !!data.notify, notifiedFor: data.notifiedFor || '' };
    saveStore(); toast('Sicherung geladen.'); rerender();
  } catch { toast('Diese Datei ist keine gültige Sicherung.'); }
}

/* ---------- Alle Karten ---------- */
function viewAlle() {
  $('#title').textContent = 'Alle Karten';
  const s = ui.alle;
  view.innerHTML = `
    <div class="row">
      <input class="field grow" id="alle-q" type="search" placeholder="Name oder Nummer, z. B. Zoro oder OP01-001" value="${esc(s.q)}" autocomplete="off">
      <select class="field" id="alle-set" style="width:auto" aria-label="Set"><option value="">Alle Sets</option>${setOptions()}</select>
      <select class="field" id="alle-color" style="width:auto" aria-label="Farbe"><option value="">Alle Farben</option>${colorOptions()}</select>
    </div>
    <p class="hint" id="alle-count"></p>
    <div class="grid" id="alle-grid"></div>
    <button class="btn" id="alle-more" hidden>Mehr anzeigen</button>`;
  $('#alle-set').value = s.set; $('#alle-color').value = s.color;
  const draw = () => {
    const list = DB.cards.filter((c) => (!s.set || c.n.startsWith(s.set + '-')) && (!s.color || c.col.includes(s.color)) && matches(c, s.q));
    $('#alle-count').textContent = `${list.length.toLocaleString('de-DE')} Karten`;
    $('#alle-grid').innerHTML = list.slice(0, s.limit).map((c) => tile(c, { qty: owned(c.k) ? `×${owned(c.k)}` : null })).join('');
    $('#alle-more').hidden = list.length <= s.limit;
  };
  draw();
  $('#alle-q').oninput = (e) => { s.q = e.target.value; s.limit = 60; draw(); };
  $('#alle-set').onchange = (e) => { s.set = e.target.value; s.limit = 60; draw(); };
  $('#alle-color').onchange = (e) => { s.color = e.target.value; s.limit = 60; draw(); };
  $('#alle-more').onclick = () => { s.limit += 120; draw(); };
}

/* ---------- Kartendetails ---------- */
const sheet = $('#sheet');
let sheetKey = null;
function openCard(k) {
  const card = DB.byKey.get(k);
  if (!card) return;
  sheetKey = k;
  const p = priceOf(card);
  const sibs = DB.byNum.get(card.n) || [];
  const stat = (label, val) => (val != null && val !== '' ? `<dt>${label}</dt><dd>${esc(val)}</dd>` : '');
  sheet.innerHTML = `
    <div class="sheet-bar"><h2>${esc(card.name)}</h2><button class="btn small" data-act="close-sheet">Schließen</button></div>
    <div class="sheet-inner">
      <div class="detail-top">${art(card, true)}
        <div class="info">
          <dl class="kv">
            ${stat('Nummer', card.n)}${stat('Motiv', card.v || 'Standard')}${stat('Seltenheit', card.r)}${stat('Typ', card.t)}
            <dt>Farbe</dt><dd>${dots(card)} ${esc(card.col.map((c) => COLOR_DE[c]).join(' / '))}</dd>
            ${stat('Kosten', card.cost)}${stat('Leben', card.life)}${stat('Power', card.pow)}${stat('Counter', card.cnt)}${stat('Attribut', card.attr)}${stat('Set', card.set)}
          </dl>
        </div>
      </div>
      <div class="own-row"><span><b>Im Besitz</b></span>
        <span class="stepper"><button data-act="own-dec" aria-label="Eine weniger" ${owned(k) ? '' : 'disabled'}>−</button><output>${owned(k)}</output><button data-act="own-inc" aria-label="Eine mehr">+</button></span>
      </div>
      ${sibs.length > 1 ? `<p class="section-title">Motive dieser Karte (${sibs.length})</p>
        <div class="variants">${sibs.map((c) => `<button data-act="open" data-k="${esc(c.k)}" aria-pressed="${c.k === k}">${art(c)}<small>${owned(c.k) ? `×${owned(c.k)} · ` : ''}${esc(c.v || 'Standard')}</small></button>`).join('')}</div>` : ''}
      <p class="section-title">Cardmarket</p>
      ${p ? `<div class="cm">
        <div class="cm-main"><b>${eur(p.value)}</b><span>Preistrend${p.low != null ? ` · ab ${eur(p.low)}` : ''}${p.avg != null ? ` · 30 Tage ⌀ ${eur(p.avg)}` : ''}</span></div>
        ${p.versions.length > 1 ? `<p class="hint">Cardmarket führt ${p.versions.length} Versionen dieser Nummer${p.picked ? '' : ' – angezeigt wird die günstigste'}. Wähle die Version, die zu deinem Motiv gehört:</p>
        <ul class="cm-versions">${p.versions.map((v, i) => `<li><label><input type="radio" name="cmv" value="${v[0]}" ${v[0] === p.id ? 'checked' : ''}> Version ${i + 1}</label><span class="lo">ab ${eur(v[1])}</span><span class="tr">${eur(v[2] ?? v[3])}</span><a href="${cmProduct(v[0])}" target="_blank" rel="noopener">ansehen</a></li>`).join('')}</ul>` : ''}
        <a class="link" href="${cmSearch(card.n)}" target="_blank" rel="noopener">${esc(card.n)} auf Cardmarket öffnen ↗</a>
      </div>` : `<div class="cm"><p class="hint">Für ${esc(card.n)} liegt kein Cardmarket-Preis vor.</p><a class="link" href="${cmSearch(card.n)}" target="_blank" rel="noopener">Auf Cardmarket suchen ↗</a></div>`}
      ${card.txt ? `<p class="section-title">Kartentext</p><p class="cardtext">${esc(card.txt)}</p>` : ''}
    </div>`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
sheet.addEventListener('change', (e) => {
  if (e.target.name === 'cmv' && sheetKey) { store.pick[sheetKey] = Number(e.target.value); saveStore(); openCard(sheetKey); }
});
sheet.addEventListener('close', () => { sheetKey = null; rerender(); });

/* ---------- Decks ---------- */
const deckById = (id) => store.decks.find((d) => d.id === id);
function deckInfo(deck) {
  const entries = Object.entries(deck.cards).map(([k, n]) => ({ card: DB.byKey.get(k), n })).filter((e) => e.card && e.n > 0);
  const leaders = entries.filter((e) => e.card.t === 'Leader');
  const main = entries.filter((e) => e.card.t !== 'Leader');
  const mainCount = main.reduce((s, e) => s + e.n, 0);
  const leaderCount = leaders.reduce((s, e) => s + e.n, 0);
  const leader = leaders[0]?.card || null;
  const perNum = {};
  for (const e of main) perNum[e.card.n] = (perNum[e.card.n] || 0) + e.n;
  const over = Object.entries(perNum).filter(([, n]) => n > 4).map(([num]) => num);
  const offColor = leader ? main.filter((e) => !e.card.col.some((c) => leader.col.includes(c))) : [];
  const checks = [
    { ok: leaderCount === 1, text: leaderCount === 1 ? `Leader: ${leader.name}` : leaderCount ? 'Nur 1 Leader erlaubt' : 'Leader fehlt' },
    { ok: mainCount === 50, text: `${mainCount} / 50 Karten im Deck` },
    { ok: !over.length, text: over.length ? `Mehr als 4 Exemplare: ${over.join(', ')}` : 'Höchstens 4 Exemplare je Kartennummer' },
  ];
  if (leader) checks.push({ ok: !offColor.length, text: offColor.length ? `${offColor.reduce((s, e) => s + e.n, 0)} Karten passen nicht zur Leader-Farbe` : 'Alle Karten passen zur Leader-Farbe' });
  const worth = entries.reduce((s, e) => s + e.n * valueOf(e.card), 0);
  return { entries, leader, mainCount, checks, worth, perNum, valid: checks.every((c) => c.ok) };
}
function viewDecks() {
  $('#title').textContent = 'Decks';
  $('#top-actions').innerHTML = '<button class="btn small primary" data-act="deck-new">Neues Deck</button>';
  if (!store.decks.length) {
    view.innerHTML = `<div class="empty"><strong>Noch kein Deck</strong>Stelle ein Deck aus den Karten in deinem Besitz zusammen: 1 Leader und 50 Karten.<br><button class="btn primary" data-act="deck-new">Neues Deck anlegen</button></div>`;
    return;
  }
  view.innerHTML = `<div class="decklist">${store.decks.map((d) => {
    const i = deckInfo(d);
    return `<a class="deckcard" href="#deck-${esc(d.id)}">${i.leader ? art(i.leader) : '<div class="art"><span class="noimg">kein Leader</span></div>'}
      <div class="info"><h3>${esc(d.name)}</h3><p>${i.leader ? `${dots(i.leader)} ${esc(i.leader.name)} · ` : ''}${i.mainCount} / 50 Karten${i.valid ? ' · spielbereit' : ''}</p></div>
      <span class="val">${eur(i.worth)}</span></a>`;
  }).join('')}</div>`;
}
function newDeck() {
  const deck = { id: Date.now().toString(36), name: `Deck ${store.decks.length + 1}`, cards: {} };
  store.decks.push(deck); saveStore();
  location.hash = `deck-${deck.id}`;
}
function viewDeck(id) {
  const deck = deckById(id);
  if (!deck) { location.hash = 'decks'; return; }
  $('#title').textContent = deck.name;
  $('#top-actions').innerHTML = '<a class="btn small" href="#decks">Alle Decks</a>';
  const i = deckInfo(deck);
  const groups = TYPE_ORDER.map((t) => [t, sortCards(i.entries.filter((e) => e.card.t === t).map((e) => e.card), 'cost')]).filter(([, l]) => l.length);
  view.innerHTML = `
    <div class="row"><input class="field grow" id="deck-name" value="${esc(deck.name)}" aria-label="Deckname" maxlength="40">
      <button class="btn primary" data-act="deck-add" data-id="${esc(id)}">Karten hinzufügen</button></div>
    <div class="stats">
      <div class="stat"><b>${i.mainCount} / 50</b><span>Karten</span></div>
      <div class="stat"><b>${i.leader ? esc(i.leader.col.map((c) => COLOR_DE[c]).join('/')) : '–'}</b><span>Leader-Farbe</span></div>
      <div class="stat price"><b>${eur(i.worth)}</b><span>Cardmarket-Wert</span></div>
    </div>
    <ul class="checks">${i.checks.map((c) => `<li class="${c.ok ? '' : 'bad'}">${esc(c.text)}</li>`).join('')}</ul>
    ${groups.length ? groups.map(([t, list]) => `<p class="section-title">${TYPE_DE[t]} (${list.reduce((s, c) => s + deck.cards[c.k], 0)})</p>
      <div class="dlist">${list.map((c) => {
        const n = deck.cards[c.k];
        const max = c.t === 'Leader' ? 1 : owned(c.k);
        return `<div class="drow"><button class="open" data-act="open" data-k="${esc(c.k)}">${art(c)}${c.cost != null ? `<span class="cost">${esc(c.cost)}</span>` : ''}
          <span class="nm"><b>${esc(c.name)}</b><span>${esc(c.n)}${c.v ? ` · ${esc(c.v)}` : ''} · ${eur(valueOf(c))}</span></span></button>
          <span class="stepper small"><button data-act="deck-dec" data-id="${esc(id)}" data-k="${esc(c.k)}" aria-label="Eine weniger">−</button><output>${n}</output><button data-act="deck-inc" data-id="${esc(id)}" data-k="${esc(c.k)}" aria-label="Eine mehr" ${n >= max || (c.t !== 'Leader' && i.perNum[c.n] >= 4) ? 'disabled' : ''}>+</button></span></div>`;
      }).join('')}</div>`).join('') : '<p class="empty"><strong>Das Deck ist leer</strong>Füge Karten aus deinem Besitz hinzu.</p>'}
    <div class="row"><button class="btn small danger" data-act="deck-del" data-id="${esc(id)}">Deck löschen</button></div>`;
  $('#deck-name').onchange = (e) => { deck.name = e.target.value.trim() || 'Deck'; saveStore(); $('#title').textContent = deck.name; };
}
function deckChange(id, k, delta) {
  const deck = deckById(id); const card = DB.byKey.get(k);
  if (!deck || !card) return false;
  const cur = deck.cards[k] || 0;
  const max = card.t === 'Leader' ? Math.min(1, owned(k)) : owned(k);
  const next = Math.max(0, Math.min(max, cur + delta));
  if (next === cur) return false;
  if (next) deck.cards[k] = next; else delete deck.cards[k];
  saveStore();
  return true;
}

/* Auswahl aus dem Besitz */
const picker = $('#picker');
const pick = { id: null, q: '', onlyColor: true };
function openPicker(id) {
  pick.id = id; pick.q = '';
  drawPicker();
  if (!picker.open) picker.showModal();
}
function drawPicker() {
  const deck = deckById(pick.id);
  if (!deck) return;
  const i = deckInfo(deck);
  const all = Object.keys(store.own).map((k) => DB.byKey.get(k)).filter(Boolean);
  const list = sortCards(all.filter((c) => matches(c, pick.q) && (c.t === 'Leader' ? !i.leader || c.k === i.leader.k : (!pick.onlyColor || !i.leader || c.col.some((x) => i.leader.col.includes(x))))), 'cost')
    .sort((a, b) => TYPE_ORDER.indexOf(a.t) - TYPE_ORDER.indexOf(b.t));
  const keepFocus = document.activeElement?.id === 'pick-q';
  picker.innerHTML = `
    <div class="sheet-bar"><h2>Aus Besitz hinzufügen · ${i.mainCount} / 50</h2><button class="btn small primary" data-act="close-picker">Fertig</button></div>
    <div class="sheet-inner">
      ${all.length ? `<div class="row"><input class="field grow" id="pick-q" type="search" placeholder="Suchen" value="${esc(pick.q)}" autocomplete="off">
        ${i.leader ? `<label class="btn small"><input type="checkbox" id="pick-color" ${pick.onlyColor ? 'checked' : ''}> nur Leader-Farbe</label>` : ''}</div>
      <p class="hint">${i.leader ? 'Tippe eine Karte an, um ein Exemplar ins Deck zu legen. Die grüne Zahl zeigt, wie viele noch frei sind.' : 'Wähle zuerst einen Leader aus deinem Besitz.'}</p>
      <div class="grid">${list.map((c) => {
        const inDeck = deck.cards[c.k] || 0;
        const free = (c.t === 'Leader' ? Math.min(1, owned(c.k)) : owned(c.k)) - inDeck;
        const capped = c.t !== 'Leader' && (i.perNum[c.n] || 0) >= 4;
        return tile(c, { act: 'pick-add', qty: inDeck ? `${inDeck} im Deck` : `${free} frei`, qtyClass: inDeck ? '' : 'free', disabled: free <= 0 || capped });
      }).join('') || '<p class="hint">Keine passende Karte im Besitz.</p>'}</div>`
      : '<p class="empty"><strong>Dein Besitz ist leer</strong>Scanne zuerst Karten – ein Deck entsteht aus den Karten, die du besitzt.</p>'}
    </div>`;
  const q = $('#pick-q', picker);
  if (q) {
    q.oninput = (e) => { pick.q = e.target.value; drawPicker(); };
    if (keepFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }
  const cb = $('#pick-color', picker);
  if (cb) cb.onchange = (e) => { pick.onlyColor = e.target.checked; drawPicker(); };
}
picker.addEventListener('close', () => rerender());

/* ---------- Scanner ---------- */
const DIGIT_FIX = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
const fixDigits = (s) => s.replace(/[OQDILSBZ]/g, (c) => DIGIT_FIX[c]);
/** Sucht gültige Kartennummern in OCR-Text und gleicht sie mit der Datenbank ab. */
function findNumbers(text) {
  const t = String(text).toUpperCase().replace(/[—–_~]/g, '-');
  const out = [];
  // Hinter der Nummer steht das Seltenheits-Kästchen; es klebt im OCR-Text oft direkt an, deshalb zählen nur die ersten 3 Ziffern.
  const re = /([A-Z0-9]{2,3})\s?([0-9OQDILSBZ]{2})\s?[-.:]?\s?([0-9OQDILSBZ]{3})/g;
  let m;
  while ((m = re.exec(t))) {
    // Präfix: Ziffern, die wie Buchstaben aussehen, zurückübersetzen (5101 → ST01, 0P → OP, E8 → EB)
    const pre = m[1].replace(/[05818QD]/g, (c) => ({ 0: 'O', Q: 'O', D: 'O', 5: 'S', 8: 'B', 1: 'T' }[c]));
    if (/^(OP|ST|EB|PRB)$/.test(pre)) out.push(`${pre}${fixDigits(m[2])}-${fixDigits(m[3])}`);
    re.lastIndex = m.index + 1; // überlappende Treffer zulassen
  }
  const rp = /(?:^|[^A-Z0-9])P\s?-\s?([0-9OQDILSBZ]{3})(?![0-9])/g;
  while ((m = rp.exec(t))) out.push(`P-${fixDigits(m[1])}`);
  return [...new Set(out)].filter((n) => DB.byNum.has(n));
}

const Scanner = {
  stream: null, worker: null, workerPromise: null, timer: null, busy: false, round: 0, recent: [], liveLast: null, current: null, sel: null,

  async getWorker() {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const w = await Tesseract.createWorker('eng', 1, {
          workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract/', langPath: 'vendor/tesseract/lang',
          workerBlobURL: false, gzip: true,
        });
        await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-', tessedit_pageseg_mode: '11' });
        return w;
      })();
      this.workerPromise.catch(() => { this.workerPromise = null; });
    }
    return this.workerPromise;
  },

  /** Schneidet einen Bereich aus, vergrößert ihn und macht daraus ein kontrastreiches Graustufenbild.
      mode: 'luma' (Helligkeit), 'max'/'min' (hellster/dunkelster Farbkanal – hilft bei farbiger Schrift), thr: schwarz-weiß (Otsu). */
  prep(src, sx, sy, sw, sh, outW, mode, thr) {
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = Math.max(8, Math.round(outW * sh / sw));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const im = ctx.getImageData(0, 0, cv.width, cv.height), d = im.data;
    const g = new Uint8ClampedArray(d.length / 4);
    let lo = 255, hi = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], gr = d[i + 1], b = d[i + 2];
      const v = mode === 'max' ? Math.max(r, gr, b) : mode === 'min' ? Math.min(r, gr, b) : r * 0.3 + gr * 0.59 + b * 0.11;
      g[j] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const span = Math.max(1, hi - lo);
    for (let j = 0; j < g.length; j++) g[j] = (g[j] - lo) * 255 / span;
    let t = -1;
    if (thr) {
      const hist = new Uint32Array(256);
      for (let j = 0; j < g.length; j++) hist[g[j]]++;
      let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sb = 0, wb = 0, best = 0;
      for (let i = 0; i < 256; i++) {
        wb += hist[i]; if (!wb) continue;
        const wf = g.length - wb; if (!wf) break;
        sb += i * hist[i];
        const diff = sb / wb - (sum - sb) / wf, score = wb * wf * diff * diff;
        if (score > best) { best = score; t = i; }
      }
    }
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = t < 0 ? g[j] : (g[j] > t ? 255 : 0); d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(im, 0, 0);
    return cv;
  },

  VARIANTS: [['luma', false], ['min', true], ['max', false], ['luma', true]],

  /** Liest einen Bereich in einer Bildvariante und gibt die erkannten Kartennummern zurück. */
  async read(src, region, variant) {
    const worker = await this.getWorker();
    const [x, y, w, h, outW] = region;
    const { data } = await worker.recognize(this.prep(src, x, y, w, h, outW, ...this.VARIANTS[variant % this.VARIANTS.length]));
    return findNumbers(data.text);
  },

  /** Foto: Bereiche der Reihe nach, je Bereich stimmen die Bildvarianten ab (2 gleiche Lesungen genügen). */
  async recognize(src, regions) {
    const votes = new Map();
    for (const region of regions) {
      for (let v = 0; v < this.VARIANTS.length; v++) {
        for (const num of await this.read(src, region, v)) {
          votes.set(num, (votes.get(num) || 0) + 1);
          if (votes.get(num) >= 2) return num;
        }
      }
    }
    return null; // eine einzelne Lesung ist zu unsicher – lieber keine Karte als die falsche
  },

  async start() {
    const video = $('#scan-video');
    if (!video) return;
    if (!navigator.mediaDevices?.getUserMedia) { this.status('Dieses Gerät gibt die Kamera hier nicht frei. Nutze „Foto aufnehmen“.'); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (err) {
      this.status(err.name === 'NotAllowedError' ? 'Kamerazugriff wurde abgelehnt. Erlaube ihn in den Safari-Einstellungen oder nutze „Foto aufnehmen“.' : 'Kamera konnte nicht gestartet werden. Nutze „Foto aufnehmen“.');
      return;
    }
    if (!$('#scan-video')) { this.stop(); return; }
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    $('#scan-idle').hidden = true; $('#scan-guide').hidden = false; $('#scan-stop').hidden = false;
    this.status('Texterkennung wird geladen …');
    try { await this.getWorker(); } catch { this.status('Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung.'); return; }
    this.status('Halte die Karte in den Rahmen – die Nummer steht unten rechts.');
    this.recent = [];
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 450);
  },

  stop() {
    clearInterval(this.timer); this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const idle = $('#scan-idle');
    if (idle) { idle.hidden = false; $('#scan-guide').hidden = true; $('#scan-stop').hidden = true; }
  },

  async tick() {
    const video = $('#scan-video'), guide = $('#scan-guide');
    if (this.busy || !video || !this.stream || video.readyState < 2 || document.hidden) return;
    this.busy = true;
    try {
      // Rahmen (Bildschirm) → Videopixel umrechnen; das Video füllt die Fläche per object-fit: cover
      const vr = video.getBoundingClientRect(), gr = guide.getBoundingClientRect();
      const scale = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight);
      const offX = (video.videoWidth * scale - vr.width) / 2, offY = (video.videoHeight * scale - vr.height) / 2;
      const gx = (gr.left - vr.left + offX) / scale, gy = (gr.top - vr.top + offY) / scale, gw = gr.width / scale, gh = gr.height / scale;
      // Jede Runde eine andere Bildvariante; Treffer erst, wenn dieselbe Nummer zweimal kurz nacheinander gelesen wurde
      const nums = await this.read(video, [gx + gw * 0.44, gy + gh * 0.87, gw * 0.56, gh * 0.125, 1000], this.round++);
      const seen = this.recent.flat();
      const num = nums.find((n) => seen.includes(n));
      this.recent.push(nums); if (this.recent.length > 3) this.recent.shift();
      // Liegt dieselbe Karte noch unter der Kamera, überschreibt sie keine Nummer, die inzwischen von Hand oder per Foto gewählt wurde
      if (num && !(num === this.liveLast && this.current !== num)) { this.liveLast = num; this.hit(num); }
    } catch { /* nächster Durchlauf */ } finally { this.busy = false; }
  },

  async photo(file) {
    this.status('Foto wird ausgewertet …');
    try {
      const bmp = await createImageBitmap(file);
      const W = bmp.width, H = bmp.height;
      const num = await this.recognize(bmp, [
        [W * 0.5, H * 0.915, W * 0.44, H * 0.06, 900],  // Karte füllt das Foto: nur die Nummernzeile
        [W * 0.4, H * 0.84, W * 0.6, H * 0.16, 1100],
        [W * 0.25, H * 0.6, W * 0.75, H * 0.4, 1500],   // Karte mit Rand fotografiert
        [0, H * 0.4, W, H * 0.6, 1800],
      ]);
      // Liegt dieselbe Karte noch unter der Kamera, überschreibt sie keine Nummer, die inzwischen von Hand oder per Foto gewählt wurde
      if (num && !(num === this.liveLast && this.current !== num)) { this.liveLast = num; this.hit(num); } else this.status('Keine Kartennummer erkannt. Fotografiere die Karte näher und gerade oder gib die Nummer ein.');
    } catch { this.status('Das Foto konnte nicht gelesen werden.'); }
  },

  hit(num) {
    if (this.current !== num) {
      this.current = num;
      this.sel = DB.byNum.get(num)[0].k;
      navigator.vibrate?.(40);
    }
    this.status(`${num} erkannt`, true);
    this.drawResult();
  },

  status(msg, hit) { const el = $('#scan-status'); if (el) { el.textContent = msg; el.classList.toggle('hit', !!hit); } },

  drawResult() {
    const box = $('#scan-result');
    if (!box) return;
    if (!this.current) { box.hidden = true; return; }
    const list = DB.byNum.get(this.current);
    const card = DB.byKey.get(this.sel) || list[0];
    const p = priceOf(card);
    box.hidden = false;
    box.innerHTML = `
      <div class="result-head">${art(card, true)}
        <div class="info"><h2>${esc(card.name)}</h2>
          <p class="sub">${esc(card.n)} · ${esc(card.r)} · ${esc(card.v || 'Standard')}</p>
          <p class="sub">${dots(card)} ${esc(card.t)} · ${esc(card.set)}</p>
          <p class="price">${p ? `${eur(p.value)} <span class="hint">Cardmarket-Trend</span>` : '<span class="hint">kein Cardmarket-Preis</span>'}</p>
        </div></div>
      ${list.length > 1 ? `<p class="hint">Diese Nummer gibt es in ${list.length} Motiven – wähle deines:</p>
        <div class="variants">${list.map((c) => `<button data-act="scan-sel" data-k="${esc(c.k)}" aria-pressed="${c.k === card.k}">${art(c)}<small>${esc(c.v || 'Standard')}</small></button>`).join('')}</div>` : ''}
      <div class="row"><button class="btn primary grow" data-act="scan-add">+1 in den Besitz</button>
        <span class="hint">im Besitz: <b>${owned(card.k)}</b></span>
        <button class="btn small" data-act="open" data-k="${esc(card.k)}">Details</button></div>`;
  },
};

function viewScan() {
  $('#title').textContent = 'Scannen';
  view.innerHTML = `
    <div class="scanner">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="guide" id="scan-guide" hidden></div>
      <div class="idle" id="scan-idle"><p>Die App liest die Kartennummer unten rechts auf der Karte, z. B. OP01-001.</p><button class="btn primary" data-act="scan-start">Kamera starten</button></div>
    </div>
    <p class="scan-status" id="scan-status"></p>
    <div class="result" id="scan-result" hidden></div>
    <div class="row">
      <label class="btn grow">Foto aufnehmen<input type="file" id="scan-file" accept="image/*" capture="environment" hidden></label>
      <button class="btn" id="scan-stop" data-act="scan-stop" hidden>Kamera aus</button>
    </div>
    <form class="row" id="scan-manual">
      <input class="field grow" id="scan-num" placeholder="Nummer, z. B. OP01-001" autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="btn" type="submit">Suchen</button>
    </form>`;
  Scanner.drawResult();
  $('#scan-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) Scanner.photo(f); };
  $('#scan-manual').onsubmit = (e) => {
    e.preventDefault();
    const raw = $('#scan-num').value.trim();
    const num = findNumbers(raw)[0];
    if (num) { Scanner.hit(num); $('#scan-num').value = ''; }
    else Scanner.status(`„${raw}“ ist keine bekannte Kartennummer.`);
  };
}

/* ---------- Aktionen ---------- */
let delArmed = null;
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, k, id } = el.dataset;
  if (act !== 'deck-del') delArmed = null;
  switch (act) {
    case 'open': openCard(k); break;
    case 'close-sheet': sheet.close(); break;
    case 'close-picker': picker.close(); break;
    case 'own-inc': setOwned(sheetKey, owned(sheetKey) + 1); openCard(sheetKey); break;
    case 'own-dec': setOwned(sheetKey, owned(sheetKey) - 1); openCard(sheetKey); break;
    case 'export': exportBackup(); break;
    case 'notify-enable': enableNotifications(); break;
    case 'alert-ack': ackAlerts([k]); rerender(); break;
    case 'alert-ack-all': ackAlerts(priceAlerts().map((a) => a.card.k)); rerender(); break;
    case 'deck-new': newDeck(); break;
    case 'deck-add': openPicker(id); break;
    case 'deck-inc': if (deckChange(id, k, 1)) rerender(); break;
    case 'deck-dec': if (deckChange(id, k, -1)) rerender(); break;
    case 'deck-del':
      if (delArmed === id) { store.decks = store.decks.filter((d) => d.id !== id); saveStore(); delArmed = null; location.hash = 'decks'; }
      else { delArmed = id; el.textContent = 'Wirklich löschen? Nochmal tippen'; }
      break;
    case 'pick-add': if (deckChange(pick.id, k, 1)) drawPicker(); break;
    case 'scan-start': Scanner.start(); break;
    case 'scan-stop': Scanner.stop(); Scanner.status(''); break;
    case 'scan-sel': Scanner.sel = k; Scanner.drawResult(); break;
    case 'scan-add': {
      const card = DB.byKey.get(Scanner.sel);
      if (card) { setOwned(card.k, owned(card.k) + 1); Scanner.drawResult(); toast(`${card.name} – jetzt ${owned(card.k)}× im Besitz`); }
      break;
    }
  }
});
document.addEventListener('change', (e) => { if (e.target.id === 'import-file' && e.target.files[0]) importBackup(e.target.files[0]); });
// Tipp auf den abgedunkelten Hintergrund schließt das Blatt
for (const dlg of [sheet, picker]) dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) Scanner.stop(); });
window.addEventListener('hashchange', route);

/* ---------- Start ---------- */
(async function init() {
  loadStore();
  try { await loadData(); }
  catch { view.innerHTML = '<p class="empty"><strong>Kartendatenbank nicht erreichbar</strong>Prüfe die Internetverbindung und lade die Seite neu.</p>'; return; }
  ensureBaselines();
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  maybeNotify(false);
})();

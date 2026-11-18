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
let store = { own: {}, decks: [], pick: {}, base: {}, notify: false, notifiedFor: '', want: {}, fast: false };
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && typeof raw === 'object') store = { own: raw.own || {}, decks: Array.isArray(raw.decks) ? raw.decks : [], pick: raw.pick || {}, base: raw.base || {}, notify: !!raw.notify, notifiedFor: raw.notifiedFor || '', want: raw.want || {}, fast: !!raw.fast };
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

/* ---------- Wunschliste ---------- */
const wanted = (k) => !!store.want[k];
function setWant(k, on) { if (on) store.want[k] = 1; else delete store.want[k]; saveStore(); }

/* ---------- Serien-Fortschritt ---------- */
// Besitzt du irgendein Motiv einer Kartennummer, zählt die Nummer als vorhanden.
const hasNumber = (n) => (DB.byNum.get(n) || []).some((c) => owned(c.k));
function setStats() {
  const sets = new Map();
  for (const c of DB.cards) {
    const prefix = c.n.split('-')[0];
    let e = sets.get(prefix);
    if (!e) { e = { prefix, name: c.n.startsWith('P-') ? 'Promos' : c.set, named: false, nums: new Set(), owned: new Set() }; sets.set(prefix, e); }
    // Serienname vom Standard-Druck (k === n) nehmen, nicht von einem Promo-Nachdruck
    if (!e.named && !c.n.startsWith('P-') && c.k === c.n) { e.name = c.set; e.named = true; }
    e.nums.add(c.n);
    if (owned(c.k)) e.owned.add(c.n);
  }
  return [...sets.values()]
    .map((e) => ({ prefix: e.prefix, name: e.name, total: e.nums.size, have: e.owned.size }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}
// Fehlende Nummern einer Serie und die Kosten, sie (als Standard-Druck) zu vervollständigen.
function setMissing(prefix) {
  const nums = new Set();
  for (const c of DB.cards) if (c.n.split('-')[0] === prefix) nums.add(c.n);
  let missing = 0, cost = 0;
  for (const n of nums) if (!hasNumber(n)) { missing++; cost += valueOf(DB.byNum.get(n)[0]); }
  return { missing, cost };
}

/* ---------- Router ---------- */
const view = $('#view');
const ui = { besitz: { q: '', sort: 'num', color: '', set: '' }, alle: { q: '', set: '', color: '', limit: 60, onlyMissing: false } };
function route() {
  const hash = location.hash.replace('#', '') || (Object.keys(store.own).length ? 'besitz' : 'scan');
  const [name, arg] = hash.startsWith('deck-') ? ['deck', hash.slice(5)] : [hash, null];
  if (name !== 'scan') Scanner.stop();
  if (name !== 'spielen') Game.match = null;
  document.querySelectorAll('.tabs a').forEach((a) => {
    const on = a.dataset.tab === name || (name === 'deck' && a.dataset.tab === 'decks');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#top-actions').innerHTML = '';
  ({ scan: viewScan, besitz: viewBesitz, decks: viewDecks, deck: viewDeck, alle: viewAlle, serien: viewSerien, wunsch: viewWunsch, spielen: viewPlay }[name] || viewBesitz)(arg);
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
    <div class="subnav">
      <a href="#serien">Serien-Fortschritt</a>
      <a href="#wunsch">Wunschliste${Object.keys(store.want).length ? ` · ${Object.keys(store.want).length}` : ''}</a>
    </div>
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
    store = { own: data.own || {}, decks: Array.isArray(data.decks) ? data.decks : [], pick: data.pick || {}, base: data.base || {}, notify: !!data.notify, notifiedFor: data.notifiedFor || '', want: data.want || {}, fast: !!data.fast };
    saveStore(); toast('Sicherung geladen.'); rerender();
  } catch { toast('Diese Datei ist keine gültige Sicherung.'); }
}

/* ---------- Alle Karten ---------- */
function viewSerien() {
  $('#title').textContent = 'Serien';
  $('#top-actions').innerHTML = '<a class="btn small" href="#besitz">Zurück</a>';
  const stats = setStats();
  const have = stats.reduce((s, e) => s + e.have, 0);
  const all = stats.reduce((s, e) => s + e.total, 0);
  const pctAll = all ? Math.round(have / all * 100) : 0;
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${have} / ${all}</b><span>Karten gesamt</span></div>
      <div class="stat"><b>${pctAll}%</b><span>Sammlung komplett</span></div>
      <div class="stat"><b>${stats.filter((e) => e.have === e.total && e.total).length}</b><span>Serien komplett</span></div>
    </div>
    <p class="hint">Eine Karte zählt als vorhanden, sobald du irgendein Motiv davon besitzt. Tippe eine Serie an, um die fehlenden Karten zu sehen.</p>
    <div class="setlist">${stats.map((e) => {
      const pct = e.total ? Math.round(e.have / e.total * 100) : 0;
      const done = e.have === e.total && e.total;
      return `<button class="setrow" data-act="open-set" data-set="${esc(e.prefix)}">
        <div class="setrow-top"><b>${esc(e.prefix)}</b><span class="nm">${esc(e.name)}</span><span class="n">${e.have} / ${e.total}${done ? ' ✓' : ''}</span></div>
        <div class="bar"><i style="width:${pct}%" class="${done ? 'done' : ''}"></i></div></button>`;
    }).join('')}</div>`;
}

function viewWunsch() {
  $('#title').textContent = 'Wunschliste';
  $('#top-actions').innerHTML = '<a class="btn small" href="#besitz">Zurück</a>';
  const all = Object.keys(store.want).map((k) => DB.byKey.get(k)).filter(Boolean);
  if (!all.length) {
    view.innerHTML = `<div class="empty"><strong>Wunschliste ist leer</strong>Öffne eine Karte und tippe „Auf Wunschliste“, um sie hier zu sammeln. So siehst du, was dir noch fehlt und was es kostet.<br><a class="btn primary" href="#alle">Karten durchsuchen</a></div>`;
    return;
  }
  const cost = all.reduce((s, c) => s + valueOf(c), 0);
  const haveAlready = all.filter((c) => owned(c.k)).length;
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${all.length}</b><span>auf der Liste</span></div>
      <div class="stat price"><b>${eur(cost)}</b><span>Summe (Cardmarket)</span></div>
      <div class="stat"><b>${haveAlready}</b><span>schon im Besitz</span></div>
    </div>
    <p class="hint">Tippe eine Karte an, um sie zu öffnen oder wieder von der Liste zu nehmen.</p>
    <div class="grid">${sortCards(all, 'num').map((c) => tile(c, { qty: owned(c.k) ? `×${owned(c.k)}` : null })).join('')}</div>`;
}

function viewAlle() {
  $('#title').textContent = 'Alle Karten';
  const s = ui.alle;
  view.innerHTML = `
    <div class="row">
      <input class="field grow" id="alle-q" type="search" placeholder="Name oder Nummer, z. B. Zoro oder OP01-001" value="${esc(s.q)}" autocomplete="off">
      <select class="field" id="alle-set" style="width:auto" aria-label="Set"><option value="">Alle Sets</option>${setOptions()}</select>
      <select class="field" id="alle-color" style="width:auto" aria-label="Farbe"><option value="">Alle Farben</option>${colorOptions()}</select>
    </div>
    <div id="alle-progress"></div>
    <div class="row" style="justify-content:space-between">
      <p class="hint" id="alle-count" style="margin:0"></p>
      <label class="chk"><input type="checkbox" id="alle-missing" ${s.onlyMissing ? 'checked' : ''}> nur fehlende</label>
    </div>
    <div class="grid" id="alle-grid"></div>
    <button class="btn" id="alle-more" hidden>Mehr anzeigen</button>`;
  $('#alle-set').value = s.set; $('#alle-color').value = s.color;
  const draw = () => {
    let list = DB.cards.filter((c) => (!s.set || c.n.startsWith(s.set + '-')) && (!s.color || c.col.includes(s.color)) && matches(c, s.q));
    if (s.onlyMissing) {
      // Eine Zeile je fehlender Nummer (Standard-Motiv), nicht jede Variante einzeln
      const seen = new Set();
      list = list.filter((c) => !hasNumber(c.n) && !seen.has(c.n) && seen.add(c.n));
    }
    // Fortschritt der gewählten Serie
    const prog = $('#alle-progress');
    if (s.set) {
      const st = setStats().find((e) => e.prefix === s.set);
      const m = setMissing(s.set);
      const pct = st && st.total ? Math.round(st.have / st.total * 100) : 0;
      prog.innerHTML = st ? `<div class="setrow static"><div class="setrow-top"><b>${esc(s.set)}</b><span class="n">${st.have} / ${st.total} · ${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div><p class="hint" style="margin:6px 0 0">${m.missing ? `${m.missing} fehlen · ca. ${eur(m.cost)} zum Vervollständigen` : 'Serie komplett ✓'}</p></div>` : '';
    } else prog.innerHTML = '';
    $('#alle-count').textContent = `${list.length.toLocaleString('de-DE')} ${s.onlyMissing ? 'fehlende' : 'Karten'}`;
    $('#alle-grid').innerHTML = list.slice(0, s.limit).map((c) => tile(c, { qty: owned(c.k) ? `×${owned(c.k)}` : null })).join('') || '<p class="hint">Nichts gefunden.</p>';
    $('#alle-more').hidden = list.length <= s.limit;
  };
  draw();
  $('#alle-q').oninput = (e) => { s.q = e.target.value; s.limit = 60; draw(); };
  $('#alle-set').onchange = (e) => { s.set = e.target.value; s.limit = 60; draw(); };
  $('#alle-color').onchange = (e) => { s.color = e.target.value; s.limit = 60; draw(); };
  $('#alle-more').onclick = () => { s.limit += 120; draw(); };
  $('#alle-missing').onchange = (e) => { s.onlyMissing = e.target.checked; s.limit = 60; draw(); };
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
      <div class="own-row"><span><b>Wunschliste</b></span>
        <button class="btn small ${wanted(k) ? 'primary' : ''}" data-act="want-toggle">${wanted(k) ? 'Auf der Liste ✓' : 'Auf Wunschliste'}</button>
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
    <button class="btn" data-act="deck-play" data-id="${esc(id)}" style="width:100%">Gegen Computer üben ▶</button>
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
    <details class="box"><summary>Deckliste teilen</summary><div class="body">
      <p class="hint">Kopiere die Liste und schick sie mir im Chat – dann baue ich die Karteneffekte für genau dieses Deck.</p>
      <button class="btn small" data-act="deck-copy" data-id="${esc(id)}">Deckliste kopieren</button>
      <pre class="decklist" id="decklist">${esc(deckListText(deck))}</pre>
    </div></details>
    <div class="row"><button class="btn small danger" data-act="deck-del" data-id="${esc(id)}">Deck löschen</button></div>`;
  $('#deck-name').onchange = (e) => { deck.name = e.target.value.trim() || 'Deck'; saveStore(); $('#title').textContent = deck.name; };
}
function deckListText(deck) {
  const lines = [];
  const leader = Object.keys(deck.cards).map((k) => DB.byKey.get(k)).find((c) => c && c.t === 'Leader');
  lines.push(deck.name);
  if (leader) lines.push(`Leader: ${leader.n} ${leader.name}${leader.v ? ` (${leader.v})` : ''}`);
  const main = Object.entries(deck.cards).map(([k, n]) => ({ c: DB.byKey.get(k), n })).filter((e) => e.c && e.c.t !== 'Leader');
  main.sort((a, b) => a.c.n.localeCompare(b.c.n) || a.c.k.localeCompare(b.c.k));
  for (const e of main) lines.push(`${e.n}x ${e.c.n} ${e.c.name}${e.c.v ? ` (${e.c.v})` : ''}`);
  const total = main.reduce((s, e) => s + e.n, 0);
  lines.push(`(${total} Karten${leader ? ' + Leader' : ''})`);
  return lines.join('\n');
}
async function copyDeckList(id) {
  const deck = deckById(id);
  if (!deck) return;
  const text = deckListText(deck);
  try { await navigator.clipboard.writeText(text); toast('Deckliste kopiert – im Chat einfügen.'); return; }
  catch { /* Fallback: Text markieren */ }
  const pre = $('#decklist');
  if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); toast('Deckliste kopiert.'); } catch { toast('Bitte den Text oben markieren und kopieren.'); } }
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
  fastLog: [], fastSeen: {},

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
    if (store.fast) { this.fastAdd(num); return; }
    this.status(`${num} erkannt`, true);
    this.drawResult();
  },
  // Schnell-Scan: dieselbe Nummer wird erst wieder gezählt, wenn sie ~3,5 s nicht mehr gesehen wurde.
  fastAdd(num) {
    const now = Date.now(), prev = this.fastSeen[num] || 0;
    this.fastSeen[num] = now;
    if (now - prev < 3500) { this.status(`${num} erfasst – nächste Karte hinhalten`, true); return; }
    const card = DB.byNum.get(num)[0];
    setOwned(card.k, owned(card.k) + 1);
    this.fastLog.unshift({ k: card.k, at: now });
    if (this.fastLog.length > 40) this.fastLog.pop();
    navigator.vibrate?.(30);
    this.status(`${card.name} +1 · jetzt ${owned(card.k)}×`, true);
    this.drawFastLog();
  },
  undoFast() {
    const last = this.fastLog.shift();
    if (!last) return;
    setOwned(last.k, Math.max(0, owned(last.k) - 1));
    const c = DB.byKey.get(last.k); if (c) this.fastSeen[c.n] = 0;
    this.drawFastLog();
    toast('Letzte Karte zurückgenommen.');
  },
  drawFastLog() {
    const box = $('#scan-fastlog');
    if (!box) return;
    if (!store.fast) { box.hidden = true; return; }
    box.hidden = false;
    const n = this.fastLog.length;
    box.innerHTML = `
      <div class="fastlog-head"><b>Schnell-Scan</b><span class="hint">${n ? `${n} in dieser Sitzung` : 'bereit – Karten nacheinander hinhalten'}</span>${n ? '<button class="btn small" data-act="scan-undo">Rückgängig</button>' : ''}</div>
      ${n ? '<p class="hint">Es wird das Standard-Motiv erfasst. Andere Motive kannst du später in „Besitz“ anpassen.</p>' : ''}
      ${this.fastLog.slice(0, 12).map((e) => { const c = DB.byKey.get(e.k); return c ? `<button class="fastlog-row open" data-act="open" data-k="${esc(c.k)}">${art(c)}<span class="nm"><b>${esc(c.name)}</b><span>${esc(c.n)} · jetzt ${owned(c.k)}×</span></span></button>` : ''; }).join('')}`;
  },

  status(msg, hit) { const el = $('#scan-status'); if (el) { el.textContent = msg; el.classList.toggle('hit', !!hit); } },

  drawResult() {
    const box = $('#scan-result');
    if (!box) return;
    if (store.fast || !this.current) { box.hidden = true; return; }
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
    <label class="chk fast"><input type="checkbox" id="scan-fast" ${store.fast ? 'checked' : ''}> Schnell-Scan: jede erkannte Karte automatisch +1</label>
    <p class="scan-status" id="scan-status"></p>
    <div class="result" id="scan-result" hidden></div>
    <div class="fastlog" id="scan-fastlog" hidden></div>
    <div class="row">
      <label class="btn grow">Foto aufnehmen<input type="file" id="scan-file" accept="image/*" capture="environment" hidden></label>
      <button class="btn" id="scan-stop" data-act="scan-stop" hidden>Kamera aus</button>
    </div>
    <form class="row" id="scan-manual">
      <input class="field grow" id="scan-num" placeholder="Nummer, z. B. OP01-001" autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="btn" type="submit">Suchen</button>
    </form>`;
  Scanner.drawResult();
  Scanner.drawFastLog();
  $('#scan-fast').onchange = (e) => { store.fast = e.target.checked; saveStore(); Scanner.current = null; Scanner.drawResult(); Scanner.drawFastLog(); Scanner.status(store.fast ? 'Schnell-Scan an – Karten nacheinander hinhalten.' : ''); };
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
  if (gameClick(el)) return;
  const { act, k, id } = el.dataset;
  if (act !== 'deck-del') delArmed = null;
  switch (act) {
    case 'open': openCard(k); break;
    case 'close-sheet': sheet.close(); break;
    case 'close-picker': picker.close(); break;
    case 'own-inc': setOwned(sheetKey, owned(sheetKey) + 1); openCard(sheetKey); break;
    case 'own-dec': setOwned(sheetKey, owned(sheetKey) - 1); openCard(sheetKey); break;
    case 'want-toggle': setWant(sheetKey, !wanted(sheetKey)); openCard(sheetKey); break;
    case 'open-set': ui.alle.set = el.dataset.set; ui.alle.q = ''; ui.alle.color = ''; ui.alle.onlyMissing = true; ui.alle.limit = 60; location.hash = 'alle'; break;
    case 'export': exportBackup(); break;
    case 'notify-enable': enableNotifications(); break;
    case 'alert-ack': ackAlerts([k]); rerender(); break;
    case 'alert-ack-all': ackAlerts(priceAlerts().map((a) => a.card.k)); rerender(); break;
    case 'deck-new': newDeck(); break;
    case 'deck-copy': copyDeckList(id); break;
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
    case 'scan-undo': Scanner.undoFast(); break;
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

/* ---------- Übungs-Modus (Oberfläche) ---------- */
const Game = {
  match: null,
  cfg: { deckId: null, difficulty: 'mittel', cpu: 0 },
  attachMode: false,
  selAttacker: null,
  preview: null,
  def: { blocker: null, counters: [] },
};

function deckLeader(deck) {
  for (const k of Object.keys(deck.cards)) { const c = DB.byKey.get(k); if (c && c.t === 'Leader') return c; }
  return null;
}
function deckCheck(deck) {
  const leader = deckLeader(deck);
  const main = Object.entries(deck.cards).reduce((s, [k, n]) => s + (DB.byKey.get(k) && DB.byKey.get(k).t !== 'Leader' ? n : 0), 0);
  return { leader, main, ok: !!leader && main === 50 };
}

function viewPlay() {
  $('#title').textContent = 'Üben';
  $('#top-actions').innerHTML = '<a class="btn small" href="#decks">Decks</a>';
  if (!Game.match) { renderSetup(); return; }
  renderBoard();
}

function renderSetup() {
  const decks = store.decks.map((d) => ({ d, c: deckCheck(d) }));
  const cfg = Game.cfg;
  if (!cfg.deckId && decks.length) cfg.deckId = decks[0].d.id;
  const cpuList = (window.OPGame ? OPGame.cpuDecks(DB) : []);
  view.innerHTML = `
    <p class="hint">Übe mit deinem eigenen Deck gegen den Computer. Es gelten die Kernregeln; Schlüsselwort-Effekte (Blocker, Rush, Konter, DON!!) wirken, besondere Karteneffekte kommen nach und nach dazu.</p>
    ${decks.length ? `
    <label class="section-title">Dein Deck</label>
    <select class="field" id="g-deck">${decks.map(({ d, c }) => `<option value="${esc(d.id)}" ${d.id === cfg.deckId ? 'selected' : ''}>${esc(d.name)} ${c.ok ? '✓' : `(${c.main}/50${c.leader ? '' : ', kein Leader'})`}</option>`).join('')}</select>
    <label class="section-title">Gegner</label>
    <select class="field" id="g-cpu">${cpuList.map((d, i) => `<option value="${i}" ${i === cfg.cpu ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    <label class="section-title">Schwierigkeit</label>
    <div class="row" id="g-diff">${['leicht', 'mittel', 'schwer'].map((x) => `<button class="btn small ${cfg.difficulty === x ? 'primary' : ''}" data-act="g-diff" data-v="${x}">${x}</button>`).join('')}</div>
    <div id="g-deckwarn"></div>
    <button class="btn primary" data-act="g-start" style="width:100%;margin-top:6px">Spiel starten ▶</button>
    ` : `<div class="empty"><strong>Noch kein Deck</strong>Baue zuerst ein Deck, dann kannst du damit üben.<br><a class="btn primary" href="#decks">Zu den Decks</a></div>`}`;
  const warn = $('#g-deckwarn');
  const upd = () => {
    const d = store.decks.find((x) => x.id === cfg.deckId);
    const c = d ? deckCheck(d) : null;
    warn.innerHTML = c && !c.ok ? `<p class="hint" style="color:var(--warn)">Dieses Deck ist noch nicht vollständig (${c.main}/50${c.leader ? '' : ', Leader fehlt'}). Du kannst trotzdem üben, aber ein echtes Deck hat 1 Leader und 50 Karten.</p>` : '';
  };
  upd();
  if ($('#g-deck')) $('#g-deck').onchange = (e) => { cfg.deckId = e.target.value; upd(); };
  if ($('#g-cpu')) $('#g-cpu').onchange = (e) => { cfg.cpu = +e.target.value; };
}

function startMatch() {
  const deck = store.decks.find((d) => d.id === Game.cfg.deckId);
  if (!deck || !window.OPGame) { toast('Kein Deck gewählt.'); return; }
  const leader = deckLeader(deck);
  if (!leader) { toast('Dein Deck hat keinen Leader.'); return; }
  const playerDeck = { name: deck.name, leader, cards: deck.cards, lookup: (k) => DB.byKey.get(k) };
  const cpuDeck = OPGame.cpuDecks(DB)[Game.cfg.cpu] || OPGame.cpuDecks(DB)[0];
  Game.selAttacker = null; Game.attachMode = false; Game.preview = null; Game.def = { blocker: null, counters: [] };
  Game.match = OPGame.createMatch({ playerDeck, cpuDeck, difficulty: Game.cfg.difficulty, delay: 500, onUpdate: () => { if (location.hash.replace('#', '') === 'spielen') renderBoard(); } });
  Game.match.start();
  renderBoard();
}

// Mini-Karte auf dem Spielfeld
function gUnit(p, c, side, { sel = false, targetable = false } = {}) {
  const pw = Game.match.power(p, c);
  const act = targetable ? 'g-target' : 'g-view';
  const tgt = c === p.leader ? 'leader' : c.uid;
  return `<button class="gunit${c.rested ? ' rested' : ''}${sel ? ' sel' : ''}${targetable ? ' targetable' : ''}" data-act="${act}" data-uid="${c.uid}" data-target="${tgt}" data-side="${side}">
    ${art(c.card)}
    <span class="gpow">${pw}</span>
    ${c.don ? `<span class="gdon">▲${c.don}</span>` : ''}
    ${isGBlocker(c) ? '<span class="gkw">B</span>' : ''}
    <span class="guname">${esc(c.card.name)}</span>
  </button>`;
}
const isGBlocker = (c) => window.OPGame && OPGame.isBlocker(c.card);

function renderBoard() {
  const m = Game.match; if (!m) return;
  const me = m.players[0], cpu = m.players[1];
  const myTurn = m.active === 0 && !m.pending && m.phase === 'main';
  const defending = m.pending && m.pending.type === 'defense';
  const over = m.winner !== null;

  if (m.pending && m.pending.type === 'mulligan') { renderMulligan(); return; }

  const sel = Game.selAttacker;
  const canTargetCpuLeader = myTurn && sel != null;
  // Gegnerische Charaktere sind nur als Ziel wählbar, wenn sie gerastet sind
  const cpuCharTargetable = (c) => myTurn && sel != null && c.rested;
  const myAttackable = (c) => myTurn && m.canAttack(me, c);

  view.innerHTML = `
    <div class="board">
      <div class="side cpu">
        <div class="pinfo"><b>${esc(cpu.name)}</b>
          <span class="life">❤ ${cpu.life.length}</span>
          <span class="chip">Hand ${cpu.hand.length}</span>
          <span class="chip">DON!! ${cpu.donAvail}/${cpu.don}</span>
          <span class="chip">Deck ${cpu.deck.length}</span>
        </div>
        <div class="units">${gUnit(cpu, cpu.leader, 'cpu', { targetable: canTargetCpuLeader })}
          ${cpu.chars.map((c) => gUnit(cpu, c, 'cpu', { targetable: cpuCharTargetable(c) })).join('')}</div>
      </div>

      <div class="center">
        <div class="phase">${over ? (m.winner === 0 ? '🏆 Du hast gewonnen!' : 'Der Computer gewinnt.') : (myTurn ? 'Dein Zug' : (defending ? 'Verteidige dich!' : 'Computer ist am Zug …'))}</div>
        <div class="glog" id="glog">${m.log.slice(-6).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        ${over ? '' : myTurn ? `<div class="row gactions">
          <button class="btn small" data-act="g-endturn">Zug beenden</button>
        </div>${sel != null ? '<p class="hint">Angreifer gewählt – tippe ein grün umrandetes Ziel. Zum Abwählen den Angreifer erneut tippen.</p>' : '<p class="hint">Tippe eine Karte, um sie groß zu sehen – dort kannst du ausspielen, DON!! geben/zurücknehmen oder angreifen.</p>'}` : ''}
      </div>

      <div class="side me">
        <div class="units">${gUnit(me, me.leader, 'me', { sel: sel === me.leader.uid })}
          ${me.chars.map((c) => gUnit(me, c, 'me', { sel: sel === c.uid })).join('')}</div>
        <div class="pinfo"><b>Du</b>
          <span class="life">❤ ${me.life.length}</span>
          <span class="chip">DON!! ${me.donAvail}/${me.don}</span>
          <span class="chip">Deck ${me.deck.length}</span>
        </div>
        <div class="hand">${me.hand.map((c) => gHandCard(me, c, myTurn)).join('') || '<p class="hint">Hand leer.</p>'}</div>
      </div>
    </div>
    ${defending ? defenseOverlay() : ''}
    ${Game.preview != null ? previewOverlay() : ''}
    ${over ? `<div class="row" style="margin-top:10px"><button class="btn primary" data-act="g-restart">Nochmal</button><button class="btn" data-act="g-exit">Beenden</button></div>` : ''}`;
  const lg = $('#glog'); if (lg) lg.scrollTop = lg.scrollHeight;
}

function gHandCard(p, c, myTurn) {
  const cost = OPGame._pint(c.card.cost);
  const playable = myTurn && cost <= p.donAvail && !(c.card.t === 'Character' && p.chars.length >= 5);
  return `<button class="ghand${playable ? '' : ' dim'}" data-act="g-view" data-uid="${c.uid}" data-side="hand">
    ${art(c.card)}
    <span class="gcost">${cost}</span>
    <span class="gname">${esc(c.card.name)}</span>
    ${OPGame.counterVal(c.card) ? `<span class="gctr">+${OPGame.counterVal(c.card)}</span>` : ''}
  </button>`;
}

function renderMulligan() {
  const m = Game.match, me = m.players[0];
  view.innerHTML = `
    <div class="center" style="gap:12px">
      <div class="phase">Starthand</div>
      <p class="hint">Behalte deine Hand oder ziehe einmal komplett neu.</p>
      <div class="hand">${me.hand.map((c) => `<div class="ghand">${art(c.card)}<span class="gcost">${OPGame._pint(c.card.cost)}</span><span class="gname">${esc(c.card.name)}</span></div>`).join('')}</div>
      <div class="row"><button class="btn primary" data-act="g-mull-keep">Behalten</button><button class="btn" data-act="g-mull-new">Neu ziehen</button></div>
    </div>`;
}

function defenseOverlay() {
  const m = Game.match, me = m.players[0];
  const battle = m.pending.battle;
  const atk = m.players[battle.atkIdx];
  const a = battle.aUid === atk.leader.uid ? atk.leader : atk.chars.find((c) => c.uid === battle.aUid);
  const target = battle.targetIsLeader ? me.leader : me.chars.find((c) => c.uid === battle.targetUid);
  const ap = a ? m.power(atk, a) : 0;
  const addCounter = Game.def.counters.reduce((s, uid) => { const h = me.hand.find((c) => c.uid === uid); return s + (h ? OPGame.counterVal(h.card) : 0); }, 0);
  const tp = (target ? m.power(me, target) : 0) + addCounter;
  const blockers = m.availableBlockers();
  const counterCards = me.hand.filter((c) => OPGame.counterVal(c.card) > 0);
  return `<div class="defense">
    <div class="dbox">
      <b>Angriff: ${esc(a ? a.card.name : '')} (${ap})</b>
      <p class="hint">Ziel: ${battle.targetIsLeader ? 'dein Leader' : esc(target ? target.card.name : '')} — Stärke ${tp}${tp > ap ? ' (hält)' : ' (wird getroffen)'}</p>
      ${blockers.length ? `<p class="section-title">Blocken</p><div class="row">${blockers.map((b) => `<button class="btn small ${Game.def.blocker === b.uid ? 'primary' : ''}" data-act="g-def-block" data-uid="${b.uid}">${esc(b.card.name)} (${m.power(me, b)})</button>`).join('')}</div>` : ''}
      ${counterCards.length ? `<p class="section-title">Konter von der Hand</p><div class="row">${counterCards.map((c) => `<button class="btn small ${Game.def.counters.includes(c.uid) ? 'primary' : ''}" data-act="g-def-counter" data-uid="${c.uid}">${esc(c.card.name)} +${OPGame.counterVal(c.card)}</button>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="g-def-confirm">Bestätigen</button></div>
    </div>
  </div>`;
}

// Karte im Spiel finden (Hand, Charaktere, Leader beider Seiten)
function findUnit(uid) {
  const m = Game.match; if (!m) return null;
  const me = m.players[0], cpu = m.players[1];
  if (me.leader.uid === uid) return { inst: me.leader, owner: 'me', where: 'leader' };
  if (cpu.leader.uid === uid) return { inst: cpu.leader, owner: 'cpu', where: 'leader' };
  let c = me.chars.find((x) => x.uid === uid); if (c) return { inst: c, owner: 'me', where: 'char' };
  c = cpu.chars.find((x) => x.uid === uid); if (c) return { inst: c, owner: 'cpu', where: 'char' };
  c = me.hand.find((x) => x.uid === uid); if (c) return { inst: c, owner: 'me', where: 'hand' };
  return null;
}

// Große Kartenansicht mit Effekttext und passenden Aktionen
function previewOverlay() {
  const m = Game.match; const uid = Game.preview;
  const f = findUnit(uid); if (!f) { Game.preview = null; return ''; }
  const c = f.inst, card = c.card, mine = f.owner === 'me';
  const myTurn = m.active === 0 && !m.pending && m.phase === 'main';
  const p = m.players[mine ? 0 : 1];
  const pw = f.where === 'hand' ? OPGame._pint(card.pow) : m.power(p, c);
  const cost = OPGame._pint(card.cost);
  const canPlay = mine && f.where === 'hand' && myTurn && cost <= p.donAvail && !(card.t === 'Character' && p.chars.length >= 5);
  const canAtk = mine && f.where !== 'hand' && myTurn && m.canAttack(p, c);
  const canDonAdd = mine && f.where !== 'hand' && myTurn && p.donAvail > 0;
  const canDonSub = mine && f.where !== 'hand' && myTurn && c.don > 0;
  const isSel = Game.selAttacker === uid;
  const hasActivate = mine && f.where !== 'hand' && /\[Activate/i.test(card.txt || '');
  return `<div class="preview" data-act="g-pv-close">
    <div class="pvcard" data-act="g-pv-noop">
      <div class="pvimg">${art(card, true)}</div>
      <div class="pvinfo">
        <h2>${esc(card.name)}</h2>
        <p class="sub">${esc(card.n)} · ${esc(card.r || '')} · ${esc(card.t)}${card.v ? ` · ${esc(card.v)}` : ''}</p>
        <div class="pvstats">
          ${cost ? `<span>Kosten ${cost}</span>` : ''}
          ${card.pow != null ? `<span>Power ${pw}${c.don ? ` (+${c.don * 1000})` : ''}</span>` : ''}
          ${OPGame.counterVal(card) ? `<span>Konter +${OPGame.counterVal(card)}</span>` : ''}
          ${card.life != null ? `<span>Leben ${card.life}</span>` : ''}
          ${card.attr ? `<span>${esc(card.attr)}</span>` : ''}
          ${card.sub ? `<span>${esc(card.sub)}</span>` : ''}
        </div>
        ${card.txt ? `<p class="pvtext">${esc(card.txt)}</p>` : '<p class="pvtext muted">Diese Karte hat keinen Effekttext.</p>'}
        <div class="pvactions">
          ${canPlay ? `<button class="btn primary" data-act="g-pv-play" data-uid="${uid}">Ausspielen</button>` : ''}
          ${canAtk ? `<button class="btn primary" data-act="g-pv-attack" data-uid="${uid}">Angreifen</button>` : ''}
          ${isSel ? `<button class="btn" data-act="g-pv-deselect">Auswahl aufheben</button>` : ''}
          ${canDonAdd ? `<button class="btn small" data-act="g-pv-don-add" data-uid="${uid}">DON!! +1</button>` : ''}
          ${canDonSub ? `<button class="btn small" data-act="g-pv-don-sub" data-uid="${uid}">DON!! −1</button>` : ''}
          ${hasActivate ? `<button class="btn small" ${m.canActivate(uid) ? `data-act="g-pv-effect" data-uid="${uid}"` : 'disabled'}>Effekt</button>` : ''}
          <button class="btn small" data-act="g-pv-close">Schließen</button>
        </div>
        ${hasActivate && !m.canActivate(uid) ? '<p class="hint">Diesen Effekt kann ich nach deiner Deckliste einbauen – aktuell wirkt er noch nicht.</p>' : ''}
      </div>
    </div>
  </div>`;
}

// Klick-Steuerung für den Spielbereich
function gameClick(el) {
  const m = Game.match;
  const act = el.dataset.act;
  if (act === 'deck-play') { Game.cfg.deckId = el.dataset.id; Game.match = null; location.hash = 'spielen'; return true; }
  if (!act || !act.startsWith('g-')) return false;
  if (act === 'g-diff') { Game.cfg.difficulty = el.dataset.v; renderSetup(); return true; }
  if (act === 'g-start') { startMatch(); return true; }
  if (!m) return true;
  if (act === 'g-mull-keep') { m.doMulligan(true); return true; }
  if (act === 'g-mull-new') { m.doMulligan(false); return true; }
  if (act === 'g-endturn') { Game.selAttacker = null; Game.preview = null; m.playerEndTurn(); return true; }
  if (act === 'g-view') {
    const uid = +el.dataset.uid;
    if (Game.selAttacker === uid) { Game.selAttacker = null; renderBoard(); return true; } // Angreifer abwählen
    Game.preview = uid; renderBoard(); return true;
  }
  if (act === 'g-target') {
    if (Game.selAttacker == null) { Game.preview = +el.dataset.uid; renderBoard(); return true; }
    const target = el.dataset.target === 'leader' ? 'leader' : +el.dataset.uid;
    const a = Game.selAttacker; Game.selAttacker = null;
    m.playerAttack(a, target); return true;
  }
  if (act === 'g-pv-noop') { return true; }
  if (act === 'g-pv-close') { Game.preview = null; renderBoard(); return true; }
  if (act === 'g-pv-play') { Game.preview = null; m.playerPlay(+el.dataset.uid); return true; }
  if (act === 'g-pv-attack') { Game.selAttacker = +el.dataset.uid; Game.preview = null; renderBoard(); return true; }
  if (act === 'g-pv-deselect') { Game.selAttacker = null; Game.preview = null; renderBoard(); return true; }
  if (act === 'g-pv-don-add') { m.playerAttach(+el.dataset.uid, 1); return true; }
  if (act === 'g-pv-don-sub') { m.playerUnattach(+el.dataset.uid); return true; }
  if (act === 'g-pv-effect') { m.activate(+el.dataset.uid); return true; }
  if (act === 'g-def-block') { Game.def.blocker = (Game.def.blocker === +el.dataset.uid) ? null : +el.dataset.uid; renderBoard(); return true; }
  if (act === 'g-def-counter') { const u = +el.dataset.uid; const i = Game.def.counters.indexOf(u); if (i < 0) Game.def.counters.push(u); else Game.def.counters.splice(i, 1); renderBoard(); return true; }
  if (act === 'g-def-confirm') { const d = Game.def; Game.def = { blocker: null, counters: [] }; m.resolveDefense({ blockerUid: d.blocker, counterUids: d.counters }); return true; }
  if (act === 'g-restart') { Game.preview = null; startMatch(); return true; }
  if (act === 'g-exit') { Game.match = null; Game.preview = null; location.hash = 'decks'; return true; }
  return true;
}


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

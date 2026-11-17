'use strict';
/* Übungs-Modus: One Piece TCG gegen den Computer.
   Die Engine (OPGame) ist bewusst ohne Oberfläche gehalten, damit sie testbar ist.
   Umgesetzt sind die Kernregeln und Schlüsselwort-Effekte; besondere Karteneffekte
   werden pro Deck ergänzt (siehe SPECIAL). Vereinfachungen sind im Code vermerkt. */

const OPGame = (function () {
  // ---- Hilfen ----
  const pint = (x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; };
  function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const shuffle = (arr, rng) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  // ---- Karteneigenschaften ----
  const kw = (card, re) => re.test(card.txt || '');
  const isBlocker = (c) => kw(c, /\[Blocker\]/);
  const isRush = (c) => kw(c, /\[Rush\]/);
  const isDoubleAttack = (c) => kw(c, /\[Double Attack\]/);
  const isBanish = (c) => kw(c, /\[Banish\]/);
  const counterVal = (c) => pint(c.cnt);

  let UID = 1;
  const inst = (card) => ({ uid: UID++, k: card.k, card, rested: false, don: 0, summonedTurn: -1 });

  // ---- Besondere Effekte je Kartennummer (wächst pro Deck) ----
  // Jeder Handler bekommt (m = Match, p = Spieler-Objekt, self = Karteninstanz).
  // Rückgabe/Seiteneffekte wirken sofort. Nur eindeutige, sichere Effekte.
  const SPECIAL = {
    // [On Play] Ziehe 1 Karte. (Beispielhafte, häufige Vorlage)
    draw1: { onPlay: (m, p) => m.draw(p, 1) },
  };
  // Zuordnung Kartennummer -> Effekt-Schlüssel. Wird für die CPU-Decks gepflegt.
  const EFFECT_MAP = {};
  const effectOf = (card) => EFFECT_MAP[card.n] ? SPECIAL[EFFECT_MAP[card.n]] : null;
  // Hat die Karte überhaupt einen von der Engine umgesetzten Effekt (Schlüsselwort oder speziell)?
  const hasEffect = (card) => isBlocker(card) || isRush(card) || isDoubleAttack(card) || isBanish(card) || counterVal(card) > 0 || !!effectOf(card);

  // ---- Spielerzustand ----
  function makePlayer(idx, deck, rng) {
    const leaderCard = deck.leader;
    const mainCards = [];
    for (const [k, n] of Object.entries(deck.cards)) {
      const card = deck.lookup(k);
      if (!card || card.t === 'Leader') continue;
      for (let i = 0; i < n; i++) mainCards.push(inst(card));
    }
    shuffle(mainCards, rng);
    const leader = inst(leaderCard);
    const lifeCount = Math.max(1, pint(leaderCard.life) || 4);
    return {
      idx, name: deck.name || (idx === 0 ? 'Du' : 'Computer'),
      leader, life: [], deck: mainCards, hand: [], trash: [], chars: [], stage: null,
      don: 0, donAvail: 0, lifeTarget: lifeCount,
    };
  }

  // ---- Match ----
  function createMatch({ playerDeck, cpuDeck, difficulty = 'mittel', seed = (Math.random() * 1e9) | 0, onUpdate = () => {}, onLog = () => {}, delay = 350 }) {
    const rng = mulberry32(seed);
    const players = [makePlayer(0, playerDeck, rng), makePlayer(1, cpuDeck, rng)];
    const m = {
      players, rng, difficulty, onUpdate, onLog,
      turn: 0, active: 0, first: 0, phase: 'setup', winner: null, pending: null, log: [],
      HUMAN: 0, CPU: 1, delay,
    };

    const other = (i) => i ^ 1;
    const logLine = (s) => { m.log.push(s); if (m.log.length > 120) m.log.shift(); m.onLog(s); };

    // Leben = oberste Karten des Decks (verdeckt)
    function setupLife(p) { for (let i = 0; i < p.lifeTarget && p.deck.length; i++) p.life.push(p.deck.shift()); }
    function drawCards(p, n) { const got = []; for (let i = 0; i < n; i++) { if (!p.deck.length) { return { deckout: true, got }; } got.push(p.deck.shift()); } p.hand.push(...got); return { deckout: false, got }; }
    m.draw = (p, n) => drawCards(p, n);

    function startGame() {
      // Startspieler zufällig
      m.first = rng() < 0.5 ? 0 : 1;
      m.active = m.first;
      for (const p of players) { shuffle(p.deck, rng); drawCards(p, 5); }
      setupLife(players[0]); setupLife(players[1]);
      m.phase = 'mulligan';
      m.pending = { type: 'mulligan' };
      logLine(`Spielbeginn. ${players[m.first].name} beginnt.`);
      m.onUpdate();
    }

    // Mulligan: Hand einmal komplett neu ziehen
    function mulligan(p, keep) {
      if (!keep) {
        p.deck.push(...p.hand); p.hand = [];
        shuffle(p.deck, rng); drawCards(p, 5);
        logLine(`${p.name} nimmt eine neue Starthand.`);
      } else logLine(`${p.name} behält die Starthand.`);
    }

    function beginTurn(i) {
      m.turn++;
      m.active = i;
      if (m.turn > 220) { return endGame(players[0].life.length >= players[1].life.length ? 0 : 1, 'Zuglimit'); }
      const p = players[i];
      // Refresh: DON!! zurück, alles aktiv, gegebene DON!! zurück
      for (const c of p.chars) { c.rested = false; c.don = 0; }
      p.leader.don = 0; p.leader.rested = false;
      // DON!! erhalten: 1 im allerersten Zug des Startspielers, sonst 2 (max 10)
      const firstTurnOfStarter = (m.turn === 1);
      p.don = Math.min(10, p.don + (firstTurnOfStarter ? 1 : 2));
      p.donAvail = p.don;
      // Ziehen: der allererste Zug des Startspielers zieht nicht
      if (!firstTurnOfStarter) { const r = drawCards(p, 1); if (r.deckout) return endGame(other(i), 'Deck leer'); }
      m.phase = 'main';
      logLine(`— Zug ${m.turn}: ${p.name} (DON!! ${p.don}) —`);
      m.pending = null; m.onUpdate();
      if (i === m.CPU) setTimeout(runCpuTurn, m.delay);
    }

    // ---- Kampfwerte ----
    function power(p, c, ctx) {
      let v = pint(c.card.pow) + c.don * 1000 + (ctx && ctx.buff ? ctx.buff : 0);
      return v;
    }
    const canAttack = (p, c) => !c.rested && (c === p.leader || c.summonedTurn !== m.turn || isRush(c.card));

    // ---- Karten spielen ----
    function playFromHand(i, uid) {
      const p = players[i];
      const idx = p.hand.findIndex((c) => c.uid === uid);
      if (idx < 0) return false;
      const c = p.hand[idx];
      const cost = pint(c.card.cost);
      if (p.donAvail < cost) return false;
      if (c.card.t === 'Character' && p.chars.length >= 5) return false; // max 5 Charaktere
      p.donAvail -= cost;
      p.hand.splice(idx, 1);
      if (c.card.t === 'Character') { c.summonedTurn = m.turn; c.rested = false; p.chars.push(c); }
      else if (c.card.t === 'Stage') { if (p.stage) p.trash.push(p.stage); p.stage = c; }
      else { p.trash.push(c); } // Events: hier nur als „gespielt" (Effekt via SPECIAL)
      logLine(`${p.name} spielt ${c.card.name}${cost ? ` (${cost} DON!!)` : ''}.`);
      const eff = effectOf(c.card);
      if (eff && eff.onPlay) eff.onPlay(m, p, c);
      return true;
    }

    // DON!! an Leader/Charakter geben (+1000 bis Zugende)
    function attachDon(i, uid, count = 1) {
      const p = players[i];
      const t = uid === p.leader.uid ? p.leader : p.chars.find((c) => c.uid === uid);
      if (!t) return false;
      const give = Math.min(count, p.donAvail);
      if (give <= 0) return false;
      p.donAvail -= give; t.don += give;
      logLine(`${p.name} gibt ${t.card.name} ${give} DON!!.`);
      return true;
    }

    // ---- Angriff ----
    // Gibt { needHumanDefense:true } zurück, wenn der Mensch verteidigen muss.
    function startAttack(i, attackerUid, targetSel) {
      const atk = players[i], def = players[other(i)];
      const a = attackerUid === atk.leader.uid ? atk.leader : atk.chars.find((c) => c.uid === attackerUid);
      if (!a || !canAttack(atk, a)) return { ok: false };
      // Ziel: gegnerischer Leader oder ein gerasteter Charakter
      let target;
      if (targetSel === 'leader') target = def.leader;
      else target = def.chars.find((c) => c.uid === targetSel && c.rested);
      if (!target) return { ok: false };
      if (m.turn === 1) return { ok: false }; // im ersten Zug darf nicht angegriffen werden
      a.rested = true;
      const battle = { atkIdx: i, aUid: a.uid, targetUid: target.uid, targetIsLeader: target === def.leader, defBuff: 0, blockerUid: null };
      logLine(`${atk.name}: ${a.card.name} greift ${target === def.leader ? def.name + ' (Leader)' : target.card.name} an.`);
      if (other(i) === m.HUMAN) { m.pending = { type: 'defense', battle }; m.onUpdate(); return { needHumanDefense: true }; }
      // CPU verteidigt automatisch
      cpuDefend(battle);
      resolveBattle(battle);
      return { ok: true };
    }

    function availableBlockers(def, battle) {
      if (battle.blockerUid || battle.targetIsLeader === false) {
        // Blocker nur sinnvoll, wenn Leader angegriffen wird? Blocker leitet jeden Angriff um.
      }
      return def.chars.filter((c) => !c.rested && isBlocker(c.card) && c.uid !== battle.targetUid);
    }
    function applyBlocker(battle, blockerUid) {
      const def = players[other(battle.atkIdx)];
      const b = def.chars.find((c) => c.uid === blockerUid && !c.rested && isBlocker(c.card));
      if (!b) return false;
      b.rested = true; battle.targetUid = b.uid; battle.targetIsLeader = false;
      logLine(`${def.name}: ${b.card.name} blockt.`);
      return true;
    }
    function playCounters(battle, counterUids) {
      const def = players[other(battle.atkIdx)];
      for (const uid of counterUids || []) {
        const idx = def.hand.findIndex((c) => c.uid === uid);
        if (idx < 0) continue;
        const c = def.hand[idx];
        const cv = counterVal(c.card);
        if (cv <= 0) continue;
        battle.defBuff += cv; def.hand.splice(idx, 1); def.trash.push(c);
        logLine(`${def.name} countert mit ${c.card.name} (+${cv}).`);
      }
    }

    function resolveBattle(battle) {
      const atk = players[battle.atkIdx], def = players[other(battle.atkIdx)];
      const a = battle.aUid === atk.leader.uid ? atk.leader : atk.chars.find((c) => c.uid === battle.aUid);
      const ap = a ? power(atk, a) : 0;
      let tp, target;
      if (battle.targetIsLeader) { target = def.leader; tp = power(def, def.leader) + battle.defBuff; }
      else { target = def.chars.find((c) => c.uid === battle.targetUid); tp = target ? power(def, target) + battle.defBuff : 0; }
      m.pending = null;
      if (!target) { m.onUpdate(); return; }
      const hit = ap >= tp;
      if (!hit) { logLine(`Angriff pariert (${ap} < ${tp}).`); afterBattle(); return; }
      if (battle.targetIsLeader) {
        const dmg = isDoubleAttack(a.card) ? 2 : 1;
        for (let d = 0; d < dmg; d++) {
          if (def.life.length === 0) { return endGame(battle.atkIdx, 'Leader getroffen ohne Leben'); }
          const lifeCard = def.life.shift();
          if (isBanish(a.card)) { def.trash.push(lifeCard); logLine(`${def.name} verliert 1 Leben (gebannt).`); }
          else { def.hand.push(lifeCard); logLine(`${def.name} verliert 1 Leben (auf die Hand).`); }
        }
      } else {
        const ci = def.chars.findIndex((c) => c.uid === target.uid);
        if (ci >= 0) { const [ko] = def.chars.splice(ci, 1); def.trash.push(ko); logLine(`${target.card.name} wird K.O. geschlagen.`); }
      }
      afterBattle();
    }

    function afterBattle() { m.onUpdate(); }

    // Mensch verteidigt: Auswahl aus der Oberfläche
    function resolveHumanDefense({ blockerUid = null, counterUids = [] }) {
      if (!m.pending || m.pending.type !== 'defense') return;
      const battle = m.pending.battle;
      if (blockerUid) applyBlocker(battle, blockerUid);
      playCounters(battle, counterUids);
      resolveBattle(battle);
      if (m.winner === null && m.active === m.CPU && !m.pending) setTimeout(runCpuTurn, m.delay);
    }

    // CPU verteidigt (einfach): blockt tödliche/teure Angriffe, countert bei Bedarf
    function cpuDefend(battle) {
      const def = players[other(battle.atkIdx)], atk = players[battle.atkIdx];
      const a = battle.aUid === atk.leader.uid ? atk.leader : atk.chars.find((c) => c.uid === battle.aUid);
      const ap = a ? power(atk, a) : 0;
      // Blocken, wenn Leader angegriffen wird und wir einen Blocker haben, der nicht sofort stirbt (oder zum Schutz von Leben)
      if (battle.targetIsLeader && def.life.length <= 1) {
        const blockers = def.chars.filter((c) => !c.rested && isBlocker(c.card));
        if (blockers.length) { blockers.sort((x, y) => power(def, y) - power(def, x)); applyBlocker(battle, blockers[0].uid); }
      }
      // Countern, um einen Treffer (bei wenig Leben) oder einen eigenen Charakter zu retten
      const target = battle.targetIsLeader ? def.leader : def.chars.find((c) => c.uid === battle.targetUid);
      let tp = target ? power(def, target) : 0;
      const wantSave = battle.targetIsLeader ? def.life.length <= 1 : true;
      if (wantSave && ap >= tp) {
        const counters = def.hand.filter((c) => counterVal(c.card) > 0).sort((x, y) => counterVal(y.card) - counterVal(x.card));
        const use = [];
        for (const c of counters) { if (tp + battle.defBuff > ap) break; battle.defBuff += 0; use.push(c.uid); tp += counterVal(c.card); }
        if (tp > ap) playCounters(battle, use); // nur countern, wenn es den Treffer wirklich verhindert
      }
    }

    // ---- CPU-Zug: synchroner Lauf, hält nur an, wenn der Mensch verteidigen muss ----
    function runCpuTurn() {
      let guard = 0;
      while (m.winner === null && m.active === m.CPU && !m.pending) {
        if (++guard > 400) { endTurn(); return; } // Sicherheitsnetz gegen Endlosschleifen
        const a = chooseCpuAction();
        if (!a) { endTurn(); return; }
        if (a.type === 'play') { if (!playFromHand(m.CPU, a.uid)) return endTurn(); m.onUpdate(); continue; }
        if (a.type === 'attach') { if (!attachDon(m.CPU, a.uid, a.count)) return endTurn(); m.onUpdate(); continue; }
        if (a.type === 'attack') {
          const r = startAttack(m.CPU, a.aUid, a.target);
          if (m.pending) return;        // Mensch muss verteidigen; danach geht es über resolveDefense weiter
          if (!r.ok) return endTurn();   // kein gültiger Angriff mehr -> Zug beenden
          m.onUpdate();
          continue;
        }
        endTurn(); return;
      }
    }

    // Einfache KI mit drei Stufen
    function chooseCpuAction() {
      const p = players[m.CPU], opp = players[m.HUMAN];
      const diff = m.difficulty;
      // 1) Charaktere spielen (teuerste bezahlbare zuerst), Platz beachten
      if (p.chars.length < 5) {
        const playable = p.hand.filter((c) => c.card.t === 'Character' && pint(c.card.cost) <= p.donAvail)
          .sort((x, y) => pint(y.card.cost) - pint(x.card.cost));
        if (playable.length) return { type: 'play', uid: playable[0].uid };
      }
      // Events mit umgesetztem Effekt spielen (sonst zurückhalten)
      const playableEv = p.hand.filter((c) => c.card.t === 'Event' && effectOf(c.card) && pint(c.card.cost) <= p.donAvail);
      if (playableEv.length) return { type: 'play', uid: playableEv[0].uid };
      // 2) Nur im Zug nach dem ersten darf angegriffen werden
      if (m.turn > 1) {
        const attackers = [p.leader, ...p.chars].filter((c) => canAttack(p, c));
        if (attackers.length) {
          // DON!! auf den stärksten Angreifer geben (schwer: aggressiver)
          if (p.donAvail > 0 && diff !== 'leicht') {
            const best = attackers.slice().sort((x, y) => power(p, y) - power(p, x))[0];
            const give = diff === 'schwer' ? p.donAvail : 1;
            if (best) return { type: 'attach', uid: best.uid, count: give };
          }
          // Ziel wählen: gerastete Charaktere, die wir K.O. schlagen können; sonst Leader
          const atkr = attackers.sort((x, y) => power(p, y) - power(p, x))[0];
          const ap = power(p, atkr);
          const koTargets = opp.chars.filter((c) => c.rested && power(opp, c) <= ap).sort((x, y) => power(opp, y) - power(opp, x));
          if (diff !== 'leicht' && koTargets.length && opp.life.length > 1) return { type: 'attack', aUid: atkr.uid, target: koTargets[0].uid };
          return { type: 'attack', aUid: atkr.uid, target: 'leader' };
        }
      }
      return null; // Zug beenden
    }

    function endTurn() {
      if (m.winner !== null) return;
      const p = players[m.active];
      // Zugende-Aufräumen: gegebene DON!! bleiben bis zum eigenen Refresh; nichts weiter
      logLine(`${p.name} beendet den Zug.`);
      beginTurn(other(m.active));
    }

    function endGame(winnerIdx, reason) {
      if (m.winner !== null) return;
      m.winner = winnerIdx; m.phase = 'over'; m.pending = null;
      logLine(`Spiel vorbei: ${players[winnerIdx].name} gewinnt (${reason}).`);
      m.onUpdate();
    }

    // ---- Öffentliche Aktionen für die Oberfläche ----
    m.start = startGame;
    m.doMulligan = (keep) => { mulligan(players[0], keep); // CPU entscheidet simpel
      mulligan(players[1], players[1].hand.filter((c) => pint(c.card.cost) <= 2).length >= 2); m.pending = null; beginTurn(m.first); };
    m.playerPlay = (uid) => { if (m.active === m.HUMAN && !m.pending) { if (playFromHand(m.HUMAN, uid)) m.onUpdate(); } };
    m.playerAttach = (uid, n) => { if (m.active === m.HUMAN && !m.pending) { if (attachDon(m.HUMAN, uid, n)) m.onUpdate(); } };
    m.playerAttack = (aUid, target) => { if (m.active === m.HUMAN && !m.pending) startAttack(m.HUMAN, aUid, target); };
    m.playerEndTurn = () => { if (m.active === m.HUMAN && !m.pending) endTurn(); };
    m.resolveDefense = resolveHumanDefense;
    m.availableBlockers = () => (m.pending && m.pending.type === 'defense') ? availableBlockers(players[0], m.pending.battle) : [];
    m.power = (p, c) => power(p, c);
    m.canAttack = (p, c) => canAttack(p, c);
    return m;
  }

  // ---- CPU-Decks aus der Kartendatenbank bauen ----
  // Baut ein legales 1-Leader+50-Karten-Deck einer Farbe, bevorzugt Karten mit umgesetztem Effekt/Keyword.
  function buildDeck(DB, color, name) {
    const leader = DB.cards.find((c) => c.t === 'Leader' && c.col.length === 1 && c.col[0] === color && c.k === c.n)
      || DB.cards.find((c) => c.t === 'Leader' && c.col.includes(color));
    const pool = DB.cards.filter((c) => c.t !== 'Leader' && c.k === c.n && c.col.includes(color) && (c.t === 'Character' || c.t === 'Event'));
    // Nach Kosten sortieren für eine brauchbare Kurve; Blocker/Counter bevorzugen
    const score = (c) => (isBlocker(c) ? 2 : 0) + (counterVal(c) > 0 ? 1 : 0);
    pool.sort((a, b) => pint(a.cost) - pint(b.cost) || score(b) - score(a));
    const cards = {}; let total = 0;
    // Kostenkurve grob: viele 1-4 Kosten
    const want = pool.filter((c) => c.t === 'Character');
    for (const c of want) { if (total >= 50) break; const take = Math.min(4, 50 - total); cards[c.k] = take; total += take; }
    // Falls zu wenig, mit allem auffüllen
    for (const c of pool) { if (total >= 50) break; if (cards[c.k]) continue; const take = Math.min(4, 50 - total); cards[c.k] = take; total += take; }
    return { leader, name, cards, lookup: (k) => DB.byKey.get(k) };
  }
  function cpuDecks(DB) {
    return [
      buildDeck(DB, 'Red', 'Rote Angreifer'),
      buildDeck(DB, 'Green', 'Grüne Kontrolle'),
      buildDeck(DB, 'Blue', 'Blaue Rückkehr'),
      buildDeck(DB, 'Purple', 'Lila DON!!'),
      buildDeck(DB, 'Black', 'Schwarze Kosten'),
    ].filter((d) => d.leader);
  }

  return { createMatch, cpuDecks, buildDeck, hasEffect, isBlocker, isRush, counterVal, EFFECT_MAP, SPECIAL, _pint: pint };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OPGame;
if (typeof window !== 'undefined') window.OPGame = OPGame;

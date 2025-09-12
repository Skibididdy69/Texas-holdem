/**
 * server.js
 *
 * Express + Socket.io-server för multiplayer Texas Hold’em lobby.
 * Uppdaterad: stöd för "call" (syna) knapp, reveal på showdown,
 * och rounds = 0 (oändligt tills en spelare har alla pengar).
 *
 * Struktur:
 * - Skapar och hanterar lobbys i minnet (Map)
 * - Hanterar spel-flödet: deal, blinds, preflop -> flop -> turn -> river -> showdown
 * - Vid showdown: skickar ut reveal (alla kort + vinnare), väntar några sekunder och
 *   delar sedan ut potten och går vidare (nästa hand eller game over).
 *
 * Render-kompatibelt: använder process.env.PORT
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

/* ======== Statisk frontend ======== */
app.use(express.static(path.join(__dirname, "public")));

/* ======== In-memory lagring av lobbies ======== */
const lobbies = new Map();

/* ======== Kortlek & utvärdering ======== */
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2..14

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s, code: r + s });
  return deck;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateLobbyId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

/* ======== Hand-utvärdering (5-korts ranking från 7-korts) ========
   Vi använder en förenklad men robust evaluator: kombinera 7->alla 5-korts,
   ranka med array där första elementet är kategori (8 SF ... 0 High card).
*/
function combinations(arr, k) {
  const res = [];
  const choose = (start, picked) => {
    if (picked.length === k) return res.push(picked.slice());
    for (let i = start; i < arr.length; i++) {
      picked.push(arr[i]);
      choose(i + 1, picked);
      picked.pop();
    }
  };
  choose(0, []);
  return res;
}

function evaluateBestOfSeven(cards7) {
  const combos = combinations(cards7, 5);
  let best = null;
  for (const combo of combos) {
    const rank = rank5(combo);
    if (!best || compareRanks(rank, best) > 0) best = rank;
  }
  return best;
}

function rank5(cards) {
  const ranks = cards.map(c => RANK_VAL[c.r]).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const counts = new Map();
  ranks.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const byCountDesc = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const isFlush = suits.every(s => s === suits[0]);

  // Straight detection (inklusive A-2-3-4-5)
  let unique = [...new Set(ranks)];
  let straightHigh = getStraightHigh(unique);
  const isStraight = straightHigh > 0;

  if (isFlush && isStraight) return [8, straightHigh];           // Straight Flush
  if (byCountDesc[0][1] === 4) return [7, byCountDesc[0][0], byCountDesc.find(([v,c])=>c===1)[0]]; // Quads
  if (byCountDesc[0][1] === 3 && byCountDesc[1] && byCountDesc[1][1] === 2) return [6, byCountDesc[0][0], byCountDesc[1][0]]; // Full house
  if (isFlush) return [5, ...ranks];                             // Flush
  if (isStraight) return [4, straightHigh];                      // Straight
  if (byCountDesc[0][1] === 3) return [3, byCountDesc[0][0], ...byCountDesc.filter(([,c])=>c===1).map(([v])=>v).sort((a,b)=>b-a)]; // Trips
  if (byCountDesc[0][1] === 2 && byCountDesc[1] && byCountDesc[1][1] === 2) {
    const p1 = Math.max(byCountDesc[0][0], byCountDesc[1][0]);
    const p2 = Math.min(byCountDesc[0][0], byCountDesc[1][0]);
    const kicker = byCountDesc.find(([,c])=>c===1)[0];
    return [2, p1, p2, kicker]; // Two pair
  }
  if (byCountDesc[0][1] === 2) return [1, byCountDesc[0][0], ...byCountDesc.filter(([,c])=>c===1).map(([v])=>v).sort((a,b)=>b-a)]; // Pair
  return [0, ...ranks]; // High card
}

function getStraightHigh(vals) {
  if (vals.includes(14)) vals = [14, ...vals.filter(v => v !== 14)];
  let run = 1;
  let best = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i > 0) {
      if (vals[i] === vals[i - 1] - 1) run++;
      else if (vals[i] !== vals[i - 1]) run = 1;
    }
    if (run >= 5) { best = vals[i - 4]; break; }
  }
  const set = new Set(vals);
  if (!best && set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2)) best = 5;
  return best;
}

function compareRanks(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function rankCategoryName(rank) {
  const cat = rank[0];
  switch (cat) {
    case 8: return "Straight Flush";
    case 7: return "Fyra i rad";
    case 6: return "Full House";
    case 5: return "Flush";
    case 4: return "Straight";
    case 3: return "Triss";
    case 2: return "Tvåpar";
    case 1: return "Par";
    case 0: return "High Card";
    default: return "Okänt";
  }
}

/* ======== Hjälp: public state (göm kort för andra spelare) ======== */
function publicLobbyState(lobby, forSocketId) {
  return {
    id: lobby.id,
    status: lobby.status,
    settings: lobby.settings,
    roundNumber: lobby.roundNumber,
    phase: lobby.phase || null,
    pot: lobby.pot || 0,
    community: lobby.community || [],
    currentBet: lobby.currentBet || 0,
    currentPlayerSocketId: lobby.players[lobby.currentPlayerIndex]?.socketId ?? null,
    dealerSocketId: lobby.players[lobby.dealerIndex]?.socketId ?? null,
    smallBlindSocketId: lobby.players[lobby.smallBlindIndex]?.socketId ?? null,
    bigBlindSocketId: lobby.players[lobby.bigBlindIndex]?.socketId ?? null,
    players: lobby.players.map(p => ({
      id: p.id,
      name: p.name,
      socketId: p.socketId,
      isHost: p.isHost,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      // Visa hålkort bara för ägaren; annars dolda placeholders
      hand: p.socketId === forSocketId ? p.hand : (p.hand?.length ? [{ hidden: true }, { hidden: true }] : [])
    }))
  };
}

/* ======== Starta ny hand ======== */
function initHand(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.community = [];
  lobby.pot = 0;
  lobby.phase = "preflop";
  lobby.currentBet = 0;

  // Nollställ spelare
  lobby.players.forEach(p => {
    p.folded = false;
    p.bet = 0;
    p.hasActed = false;
    p.hand = [lobby.deck.pop(), lobby.deck.pop()];
  });

  // Rotera dealer
  if (typeof lobby.dealerIndex !== "number") lobby.dealerIndex = 0;
  else lobby.dealerIndex = (lobby.dealerIndex + 1) % lobby.players.length;

  lobby.smallBlindIndex = (lobby.dealerIndex + 1) % lobby.players.length;
  lobby.bigBlindIndex = (lobby.dealerIndex + 2) % lobby.players.length;

  // Applicera blinds (tar från respektives chips, lägger i p.bet och pot)
  applyBlind(lobby, lobby.smallBlindIndex, lobby.settings.smallBlind);
  applyBlind(lobby, lobby.bigBlindIndex, lobby.settings.bigBlind);
  lobby.currentBet = Math.max(lobby.currentBet, lobby.settings.bigBlind);

  // Starta action på spelaren efter big blind
  lobby.currentPlayerIndex = nextActiveIndex(lobby, (lobby.bigBlindIndex + 1) % lobby.players.length);

  broadcastState(lobby);
}

function applyBlind(lobby, idx, amount) {
  const p = lobby.players[idx];
  const pay = Math.max(0, Math.min(p.chips, amount));
  p.chips -= pay;
  p.bet += pay;
  lobby.pot += pay;
}

/* ======== Hjälpfunktioner för att hitta nästa aktiva spelare ======== */
function nextActiveIndex(lobby, start) {
  if (!lobby.players.length) return -1;
  let i = start % lobby.players.length;
  for (let step = 0; step < lobby.players.length; step++) {
    const p = lobby.players[i];
    if (p && !p.folded && (p.chips > 0 || p.bet > 0)) return i; // aktiv spelare (har chips eller bet)
    // If player has zero chips but not folded, still treat as active (all-in); allow skipping in some contexts
    if (p && !p.folded && p.chips === 0) return i;
    i = (i + 1) % lobby.players.length;
  }
  return -1;
}

/* ======== Betting-logik ========
   allOthersCalledOrFolded: returnerar true om varje icke-foldade spelare antingen
   - har chips === 0 (all-in)
   - eller har p.bet === lobby.currentBet (har synat/current)
*/
function allOthersCalledOrFolded(lobby) {
  return lobby.players.every(p => p.folded || p.chips === 0 || p.bet === lobby.currentBet);
}

function onlyOneLeft(lobby) {
  return lobby.players.filter(p => !p.folded).length === 1;
}

/* ======== Advance phase (flop/turn/river) ======== */
function advancePhase(lobby) {
  // Nollställ per bettingrunda (behåller chips/bets i pot tills distribution vid showdown)
  lobby.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  lobby.currentBet = 0;

  if (lobby.phase === "preflop") {
    // Flop - tre kort
    lobby.community.push(lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop());
    lobby.phase = "flop";
  } else if (lobby.phase === "flop") {
    lobby.community.push(lobby.deck.pop());
    lobby.phase = "turn";
  } else if (lobby.phase === "turn") {
    lobby.community.push(lobby.deck.pop());
    lobby.phase = "river";
  } else if (lobby.phase === "river") {
    lobby.phase = "showdown";
    return showdown(lobby);
  }

  // Action börjar på spelaren efter dealer (standard)
  lobby.currentPlayerIndex = nextActiveIndex(lobby, (lobby.dealerIndex + 1) % lobby.players.length);
  broadcastState(lobby);
}

/* ======== Showdown: reveal -> delay -> dela ut pot -> next hand / game over ======== */
const REVEAL_DELAY_MS = 6000; // visa reveal i 6 sekunder

function showdown(lobby) {
  // Samla aktiva (ej foldade)
  const active = lobby.players.filter(p => !p.folded);
  if (active.length === 0) {
    // extremfall: ingen kvar -> ge potten till dealer
    const dealer = lobby.players[lobby.dealerIndex] || lobby.players[0];
    const revealPayload = makeRevealPayload(lobby, [], [{ socketId: dealer.socketId, name: dealer.name, reason: "Inga aktiva" }]);
    io.to(lobby.id).emit("reveal", revealPayload);
    // Vänta och ge potten
    setTimeout(() => {
      dealer.chips += lobby.pot;
      lobby.pot = 0;
      proceedAfterHand(lobby);
    }, REVEAL_DELAY_MS);
    return;
  }

  if (active.length === 1) {
    // Automatisk vinnare utan showdown (alla andra foldade)
    const winner = active[0];
    const revealPayload = makeRevealPayload(lobby, [winner], [{ socketId: winner.socketId, name: winner.name, reason: "Sista spelaren" }]);
    io.to(lobby.id).emit("reveal", revealPayload);
    setTimeout(() => {
      winner.chips += lobby.pot;
      lobby.pot = 0;
      proceedAfterHand(lobby);
    }, REVEAL_DELAY_MS);
    return;
  }

  // Vanlig showdown: utvärdera alla aktiva
  const results = active.map(p => ({
    p,
    rank: evaluateBestOfSeven([...p.hand, ...lobby.community])
  }));
  // Hitta bästa ranken
  let best = results[0].rank;
  results.forEach(r => { if (compareRanks(r.rank, best) > 0) best = r.rank; });
  const winners = results.filter(r => compareRanks(r.rank, best) === 0).map(r => r.p);

  // Skapa reveal payload (alla spelare med händer + vinnare info)
  const revealPayload = makeRevealPayload(lobby, winners, winners.map(w => ({
    socketId: w.socketId,
    name: w.name,
    rank: evaluateBestOfSeven([...w.hand, ...lobby.community]),
    rankDesc: rankCategoryName(evaluateBestOfSeven([...w.hand, ...lobby.community]))
  })));
  // Skicka reveal (alla kort + vem vann vilken hand)
  io.to(lobby.id).emit("reveal", revealPayload);

  // Vänta en stund (visa alla kort) och dela sedan ut potten enligt winners
  setTimeout(() => {
    if (winners.length === 1) {
      winners[0].chips += lobby.pot;
      lobby.pot = 0;
    } else {
      // dela pott lika (enkel split, ingen side-pot hantering)
      const share = Math.floor(lobby.pot / winners.length);
      let remainder = lobby.pot - share * winners.length;
      winners.forEach((w, idx) => {
        w.chips += share + (idx === 0 ? remainder : 0);
      });
      lobby.pot = 0;
    }
    proceedAfterHand(lobby);
  }, REVEAL_DELAY_MS);
}

function makeRevealPayload(lobby, winners, winnersInfo) {
  return {
    players: lobby.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      chips: p.chips,
      folded: p.folded,
      hand: p.hand // visa riktiga kort för alla i reveal-payload
    })),
    community: lobby.community,
    pot: lobby.pot,
    winners: winnersInfo // [{socketId, name, rank?, rankDesc?}]
  };
}

function proceedAfterHand(lobby) {
  // Öka roundNumber (om rounds > 0)
  if (typeof lobby.roundNumber !== "number") lobby.roundNumber = 0;
  lobby.roundNumber += 1;

  // Kontrollera slutvillkor:
  // - Om host satte rounds > 0: stoppa när rounds är uppnått.
  // - If rounds === 0: oändligt tills en spelare äger alla chips (alla andra har 0).
  const activeChipPlayers = lobby.players.filter(p => p.chips > 0);
  const onlyOneHasChips = activeChipPlayers.length === 1;

  const roundsLimitReached = (lobby.settings.rounds > 0 && lobby.roundNumber >= lobby.settings.rounds);

  if (roundsLimitReached || onlyOneHasChips) {
    lobby.status = "finished";
    // Skicka gameOver med slutstate
    io.to(lobby.id).emit("gameOver", publicLobbyState(lobby));
  } else {
    // Starta nästa hand
    initHand(lobby);
  }
}

/* ======== Broadcast (skickar personlig vy till varje spelare) ======== */
function broadcastState(lobby) {
  lobby.players.forEach(p => {
    io.to(p.socketId).emit("gameUpdate", publicLobbyState(lobby, p.socketId));
  });
  io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby)); // synlig för alla i rummet (lobbyöversikt)
}

/* ======== Socket.io-events ======== */
io.on("connection", (socket) => {
  // Hjälp: hitta lobby för denna socket
  const findLobbyBySocket = () => {
    for (const lobby of lobbies.values()) {
      if (lobby.players.find(p => p.socketId === socket.id)) return lobby;
    }
    return null;
  };

  // Skapa lobby (host)
  socket.on("createLobby", ({ name, settings }, ack) => {
    try {
      const lobbyId = generateLobbyId();
      // Accept rounds = 0 (meaning infinite). Validate inputs.
      const parsedRounds = (() => {
        const v = parseInt(settings.rounds, 10);
        if (Number.isNaN(v)) return 5;
        // allow 0..100000
        return Math.max(0, Math.min(100000, v));
      })();

      const lobby = {
        id: lobbyId,
        hostId: socket.id,
        status: "lobby",
        settings: {
          startChips: clampInt(settings.startChips ?? 1000, 100, 1000000),
          rounds: parsedRounds,
          smallBlind: clampInt(settings.smallBlind ?? 5, 1, 100000),
          bigBlind: clampInt(settings.bigBlind ?? 10, 2, 200000)
        },
        players: [],
        roundNumber: 0
      };
      const player = makePlayer(socket.id, (name || "Host"), true, lobby.settings.startChips);
      lobby.players.push(player);
      lobbies.set(lobbyId, lobby);

      socket.join(lobbyId);
      ack?.({ ok: true, lobbyId, me: player, lobby: publicLobbyState(lobby, socket.id) });
      io.to(lobbyId).emit("lobbyUpdate", publicLobbyState(lobby));
    } catch (e) {
      ack?.({ ok: false, error: "Misslyckades att skapa lobby." });
    }
  });

  socket.on("joinLobby", ({ lobbyId, name }, ack) => {
    const lobby = lobbies.get((lobbyId || "").toUpperCase());
    if (!lobby) return ack?.({ ok: false, error: "Lobby hittades inte." });
    if (lobby.status !== "lobby") return ack?.({ ok: false, error: "Spelet har redan startat." });
    if (lobby.players.length >= 4) return ack?.({ ok: false, error: "Lobbyn är full (max 4)." });

    const player = makePlayer(socket.id, (name || "Spelare"), false, lobby.settings.startChips);
    lobby.players.push(player);
    socket.join(lobby.id);
    ack?.({ ok: true, me: player, lobby: publicLobbyState(lobby, socket.id) });
    io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
  });

  socket.on("leaveLobby", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    removePlayerFromLobby(lobby, socket.id);
  });

  socket.on("startGame", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    if (socket.id !== lobby.hostId) return socket.emit("errorMessage", "Endast host kan starta spelet.");
    if (lobby.players.length < 2) return socket.emit("errorMessage", "Minst 2 spelare krävs för att starta.");

    lobby.status = "playing";
    lobby.roundNumber = 0;
    // Säkra att alla har startpengar (om någon joinat sent)
    lobby.players.forEach(p => { if (p.chips <= 0) p.chips = lobby.settings.startChips; });
    initHand(lobby);
  });

  /**
   * playerAction: { type: 'check'|'bet'|'call'|'fold', amount? }
   * - call: syna aktuell bet (eller all-in om ej tillräckligt)
   * - bet: kan vara öppning eller raise; server validerar
   */
  socket.on("playerAction", ({ type, amount }) => {
    const lobby = findLobbyBySocket();
    if (!lobby || lobby.status !== "playing") return;
    const idx = lobby.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return;
    if (idx !== lobby.currentPlayerIndex) return socket.emit("errorMessage", "Det är inte din tur.");

    const me = lobby.players[idx];
    if (me.folded) return socket.emit("errorMessage", "Du har redan foldat.");

    if (type === "fold") {
      me.folded = true;
      me.hasActed = true;
      // Om bara en spelare kvar -> vinnaren tar potten direkt
      if (onlyOneLeft(lobby)) {
        const winner = lobby.players.find(p => !p.folded);
        const revealPayload = makeRevealPayload(lobby, [winner], [{ socketId: winner.socketId, name: winner.name, reason: "Sista spelaren kvar" }]);
        io.to(lobby.id).emit("reveal", revealPayload);
        setTimeout(() => {
          winner.chips += lobby.pot;
          lobby.pot = 0;
          proceedAfterHand(lobby);
        }, REVEAL_DELAY_MS);
        return;
      }
      moveToNextTurn(lobby);
      return;
    }

    if (type === "check") {
      if (lobby.currentBet > 0 && me.bet < lobby.currentBet) {
        return socket.emit("errorMessage", "Det finns ett bet att syna; du kan inte checka.");
      }
      me.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }

    if (type === "call") {
      const needed = Math.max(0, lobby.currentBet - me.bet);
      const pay = Math.min(needed, me.chips);
      me.chips -= pay;
      me.bet += pay;
      lobby.pot += pay;
      me.hasActed = true;
      // If pay < needed, player är all-in men kunde inte matcha fullt; treat as all-in
      moveToNextTurn(lobby);
      return;
    }

    if (type === "bet") {
      const raw = Math.floor(Number(amount) || 0);
      if (raw <= 0) return socket.emit("errorMessage", "Ange ett giltigt belopp att betta.");

      const minOpen = lobby.settings.bigBlind;
      const minCall = Math.max(0, lobby.currentBet - me.bet);

      // Två scenarion:
      // - Om currentBet === 0: detta är en öppning/raise, måste vara minst bigBlind
      // - Om currentBet > 0: belopp måste åtminstone täcka minCall; belopp > minCall = raise
      if (lobby.currentBet === 0 && raw < minOpen) {
        return socket.emit("errorMessage", `Minsta öppningsbet är ${minOpen}.`);
      }
      if (lobby.currentBet > 0 && raw < minCall) {
        return socket.emit("errorMessage", `Du måste minst syna ${minCall}.`);
      }

      const betAmount = Math.min(raw, me.chips);
      me.chips -= betAmount;
      me.bet += betAmount;
      lobby.pot += betAmount;

      if (me.bet > lobby.currentBet) {
        // Raise: uppdatera currentBet och låt andra agera på nytt
        lobby.currentBet = me.bet;
        lobby.players.forEach((p, i) => {
          if (!p.folded && i !== idx) p.hasActed = false;
        });
      }

      me.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }

    socket.emit("errorMessage", "Ogiltig action.");
  });

  socket.on("disconnect", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    removePlayerFromLobby(lobby, socket.id);
  });

  /* ======== Hjälp: ta bort spelare från lobby (hantera host leave etc) ======== */
  function removePlayerFromLobby(lobby, socketId) {
    const i = lobby.players.findIndex(p => p.socketId === socketId);
    if (i === -1) return;
    const wasHost = (lobby.players[i].socketId === lobby.hostId);
    lobby.players.splice(i, 1);

    if (lobby.players.length === 0) {
      lobbies.delete(lobby.id);
      return;
    }

    // Om host lämnade -> överför host till första kvarvarande spelare
    if (wasHost) {
      lobby.hostId = lobby.players[0].socketId;
      lobby.players[0].isHost = true;
    }

    // Anpassa indexer försiktigt
    if (typeof lobby.dealerIndex === "number") lobby.dealerIndex = lobby.dealerIndex % lobby.players.length;
    if (typeof lobby.smallBlindIndex === "number") lobby.smallBlindIndex = lobby.smallBlindIndex % lobby.players.length;
    if (typeof lobby.bigBlindIndex === "number") lobby.bigBlindIndex = lobby.bigBlindIndex % lobby.players.length;
    if (typeof lobby.currentPlayerIndex === "number") lobby.currentPlayerIndex = lobby.currentPlayerIndex % lobby.players.length;

    io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
    broadcastState(lobby);
  }

  function moveToNextTurn(lobby) {
    // Om alla har kallat eller är all-in -> gå vidare till nästa fas eller showdown
    if (allOthersCalledOrFolded(lobby)) {
      if (lobby.phase === "river") {
        lobby.phase = "showdown";
        return showdown(lobby);
      }
      return advancePhase(lobby);
    }

    // Annars hitta nästa aktiva spelare (som inte foldat)
    let next = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    next = nextActiveIndex(lobby, next);
    lobby.currentPlayerIndex = next;
    broadcastState(lobby);
  }
});

/* ======== Hjälp: skapa spelare-objekt ======== */
function makePlayer(socketId, name, isHost = false, startChips = 1000) {
  return {
    id: socketId,
    name: String(name).slice(0, 20),
    socketId,
    isHost,
    chips: startChips,
    folded: false,
    bet: 0,
    hasActed: false,
    hand: []
  };
}

/* ======== Hjälp: clamp int ======== */
function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (Number.isNaN(v)) v = min;
  return Math.max(min, Math.min(max, v));
}

/* ======== Starta server ======== */
server.listen(PORT, () => console.log(`Server körs på port ${PORT}`));

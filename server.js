/**
 * server.js
 *
 * Fullständig, robust Express + Socket.io-server för multiplayer Texas Hold'em-lobbyer.
 *
 * Funktioner:
 *  - Lobbys med 2–4 spelare.
 *  - Host kan ställa: startChips, rounds (0 = oändligt), smallBlind, bigBlind.
 *  - Realtid via Socket.io: lobbyUpdate, gameUpdate, reveal, gameOver, errorMessage.
 *  - Texas Hold'em-flow: preflop -> flop -> turn -> river -> showdown.
 *  - Betting: check, call (syna), bet (open/raise), fold.
 *  - Blinds dras automatiskt, dealer roterar.
 *  - Reveal: server skickar alla kort + vinnare-info, väntar REVEAL_DELAY_MS, delar potten och startar nästa hand.
 *  - Säkra, defensiva kontroller för ogiltiga anrop.
 *
 * Kommentarer på svenska för att göra det enkelt att följa logiken.
 *
 * OBS:
 *  - Detta är en "baseline" som prioriterar korrekt flöde och tydlighet.
 *  - Side-pot (komplex all-in/side-pot) hanteras enkelt: pot delas lika mellan vinnare.
 *    Vill du ha korrekt side-pot-hantering (per insatsnivå) så kan vi implementera det senare.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // För utveckling / Render: tillåt enkel CORS (i produktion begränsa domän)
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

/* ---------------------------
   Statisk frontend
   --------------------------- */
app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------
   In-memory lobbys
   --------------------------- */
/**
 * Struktur (lobby):
 * {
 *   id: string,
 *   hostId: socketId,
 *   status: 'lobby'|'playing'|'finished',
 *   settings: { startChips, rounds, smallBlind, bigBlind },
 *   players: [ { id, name, socketId, isHost, chips, folded, bet, hasActed, hand: [{r,s}] } ],
 *   roundNumber: number,
 *   dealerIndex, smallBlindIndex, bigBlindIndex, currentPlayerIndex,
 *   deck: [card], community: [card], pot: number, currentBet: number, phase: 'preflop'|'flop'|'turn'|'river'|'showdown'
 * }
 */
const lobbies = new Map();

/* ---------------------------
   Kortlek & utvärdering (enkelt men robust)
   --------------------------- */
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i + 2])); // 2..14

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s, code: r + s });
  return deck;
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function generateLobbyId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

/* ---------- Hand evaluator (rank 5-kort från 7-kort) ----------
   Vi utvärderar bästa 5-korts kombination av 7 kort (2 hål + 5 community).
   Returnerar en array som kan jämföras lexikografiskt (större = bättre).
   Structure: [category, tiebreakers...], category: 8=SF,7=Quads,6=FH,5=Flush,4=Straight,3=Trips,2=TwoPair,1=Pair,0=High
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
  // cards: [{r,s}, ...] length 5
  const ranks = cards.map(c => RANK_VAL[c.r]).sort((a,b) => b - a);
  const suits = cards.map(c => c.s);
  const counts = new Map();
  ranks.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const byCountDesc = Array.from(counts.entries()).sort((a,b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const isFlush = suits.every(s => s === suits[0]);
  let unique = [...new Set(ranks)];
  let straightHigh = getStraightHigh(unique);
  const isStraight = straightHigh > 0;

  if (isFlush && isStraight) return [8, straightHigh];
  if (byCountDesc[0][1] === 4) return [7, byCountDesc[0][0], byCountDesc.find(([v,c]) => c === 1)[0]];
  if (byCountDesc[0][1] === 3 && byCountDesc[1] && byCountDesc[1][1] === 2) return [6, byCountDesc[0][0], byCountDesc[1][0]];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (byCountDesc[0][1] === 3) return [3, byCountDesc[0][0], ...byCountDesc.filter(([,c]) => c === 1).map(([v])=>v).sort((a,b)=>b-a)];
  if (byCountDesc[0][1] === 2 && byCountDesc[1] && byCountDesc[1][1] === 2) {
    const p1 = Math.max(byCountDesc[0][0], byCountDesc[1][0]);
    const p2 = Math.min(byCountDesc[0][0], byCountDesc[1][0]);
    const kicker = byCountDesc.find(([,c]) => c === 1)[0];
    return [2, p1, p2, kicker];
  }
  if (byCountDesc[0][1] === 2) return [1, byCountDesc[0][0], ...byCountDesc.filter(([,c]) => c === 1).map(([v])=>v).sort((a,b)=>b-a)];
  return [0, ...ranks];
}

function getStraightHigh(vals) {
  // vals: descending unique rank values
  if (vals.includes(14)) vals = [14, ...vals.filter(v => v !== 14)];
  let run = 1, best = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i > 0) {
      if (vals[i] === vals[i - 1] - 1) run++;
      else if (vals[i] !== vals[i - 1]) run = 1;
    }
    if (run >= 5) { best = vals[i - 4]; break; }
  }
  const set = new Set(vals);
  if (!best && set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2)) best = 5; // wheel
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

/* ---------------------------
   Hjälp: public state (göm hålkort för andra)
   --------------------------- */
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
      // Visa hålkort bara för ägaren
      hand: p.socketId === forSocketId ? p.hand : (p.hand?.length ? [{ hidden: true }, { hidden: true }] : [])
    }))
  };
}

/* ---------------------------
   Starta hand / blinds / deal
   --------------------------- */
function initHand(lobby) {
  // Förbered ny hand - defensiv funktion
  lobby.deck = shuffle(createDeck());
  lobby.community = [];
  lobby.phase = "preflop";
  lobby.pot = 0;
  lobby.currentBet = 0;

  // Ge varje spelare två kort; nollställ vars som behövs
  lobby.players.forEach(p => {
    p.folded = false;
    p.bet = 0;
    p.hasActed = false;
    p.hand = [lobby.deck.pop(), lobby.deck.pop()];
  });

  // Rotera dealer (första handen: dealerIndex = 0)
  if (typeof lobby.dealerIndex !== "number") lobby.dealerIndex = 0;
  else lobby.dealerIndex = (lobby.dealerIndex + 1) % lobby.players.length;

  // Bestäm small/big blind index (i relation till dealer)
  lobby.smallBlindIndex = (lobby.dealerIndex + 1) % lobby.players.length;
  lobby.bigBlindIndex = (lobby.dealerIndex + 2) % lobby.players.length;

  // Applicera blinds (bet tas direkt från chips -> p.bet + lobby.pot)
  applyBlind(lobby, lobby.smallBlindIndex, lobby.settings.smallBlind);
  applyBlind(lobby, lobby.bigBlindIndex, lobby.settings.bigBlind);

  // currentBet startar som big blind
  lobby.currentBet = Math.max(lobby.currentBet, lobby.settings.bigBlind);

  // Starta action på spelaren efter big blind
  lobby.currentPlayerIndex = nextActiveIndex(lobby, (lobby.bigBlindIndex + 1) % lobby.players.length);

  broadcastState(lobby);
}

function applyBlind(lobby, idx, amount) {
  const p = lobby.players[idx];
  if (!p) return;
  const pay = Math.max(0, Math.min(p.chips, amount));
  p.chips -= pay;
  p.bet += pay;
  lobby.pot += pay;
  // Notera: om spelaren går all-in via blind så hanteras det naturligt (chips may be 0)
}

/* ---------------------------
   Hjälp för att hitta nästa aktiva spelare
   --------------------------- */
function nextActiveIndex(lobby, start) {
  if (!lobby.players.length) return -1;
  let i = start % lobby.players.length;
  for (let step = 0; step < lobby.players.length; step++) {
    const p = lobby.players[i];
    if (p && !p.folded) return i;
    i = (i + 1) % lobby.players.length;
  }
  return -1;
}

/* ---------------------------
   Betting-runds-klar-check
   - Bettingrundan är klar när varje icke-foldade spelare antingen:
     * är all-in (chips === 0), ELLER
     * har p.bet === lobby.currentBet OCH p.hasActed === true
   Detta garanterar att alla får agera efter en raise.
   --------------------------- */
function bettingRoundComplete(lobby) {
  const active = lobby.players.filter(p => !p.folded);
  if (active.length <= 1) return true; // trivialt klar
  return active.every(p => {
    if (p.chips === 0) return true; // all-in -> kan inte agera mer
    return (p.bet === lobby.currentBet) && !!p.hasActed;
  });
}

/* ---------------------------
   Advance phase (flop -> turn -> river -> showdown)
   --------------------------- */
function advancePhase(lobby) {
  // Nollställ per bettingrunda (bets kvar i pot tills distribution vid showdown)
  lobby.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  lobby.currentBet = 0;

  if (lobby.phase === "preflop") {
    // Flop (3 kort)
    // Burn card (ej modellerat separat) -> vi poppar tre kort
    lobby.community.push(lobby.deck.pop(), lobby.deck.pop(), lobby.deck.pop());
    lobby.phase = "flop";
  } else if (lobby.phase === "flop") {
    // Turn (1 kort)
    lobby.community.push(lobby.deck.pop());
    lobby.phase = "turn";
  } else if (lobby.phase === "turn") {
    // River (1 kort)
    lobby.community.push(lobby.deck.pop());
    lobby.phase = "river";
  } else if (lobby.phase === "river") {
    // Gå till showdown
    lobby.phase = "showdown";
    return showdown(lobby);
  }

  // Efter ny fas: action börjar hos spelaren efter dealer (standard)
  lobby.currentPlayerIndex = nextActiveIndex(lobby, (lobby.dealerIndex + 1) % lobby.players.length);
  broadcastState(lobby);
}

/* ---------------------------
   Move to next turn / kontrollera om vi ska gå vidare
   --------------------------- */
function moveToNextTurn(lobby) {
  // Om bettingrundan är klar -> nästa fas eller showdown
  if (bettingRoundComplete(lobby)) {
    if (lobby.phase === "river") {
      lobby.phase = "showdown";
      return showdown(lobby);
    }
    return advancePhase(lobby);
  }

  // Annars: hitta nästa aktiva spelare som inte foldat
  let next = (lobby.currentPlayerIndex + 1) % lobby.players.length;
  next = nextActiveIndex(lobby, next);
  if (next === -1) {
    // Fallback: börja efter dealer
    next = nextActiveIndex(lobby, (lobby.dealerIndex + 1) % lobby.players.length);
  }
  lobby.currentPlayerIndex = next;
  broadcastState(lobby);
}

/* ---------------------------
   Showdown: evaluera händer och reveal
   - Skapar reveal-payload och skickar till rummet
   - Väntar REVEAL_DELAY_MS och delar potten (enkelt split)
   --------------------------- */
const REVEAL_DELAY_MS = 6000;

function showdown(lobby) {
  // Samla aktiva spelare (ej foldade)
  const active = lobby.players.filter(p => !p.folded);
  if (active.length === 0) {
    // Ingen kvar (extremfall) -> ge potten till dealer (fallback)
    const dealer = lobby.players[lobby.dealerIndex] || lobby.players[0];
    const revealPayload = makeRevealPayload(lobby, [], [{ socketId: dealer.socketId, name: dealer.name, reason: "Inga aktiva spelare" }]);
    io.to(lobby.id).emit("reveal", revealPayload);
    setTimeout(() => {
      dealer.chips += lobby.pot;
      lobby.pot = 0;
      proceedAfterHand(lobby);
    }, REVEAL_DELAY_MS);
    return;
  }

  if (active.length === 1) {
    // Endast en spelare kvar: automatisk vinnare
    const winner = active[0];
    const revealPayload = makeRevealPayload(lobby, [winner], [{ socketId: winner.socketId, name: winner.name, reason: "Sista spelaren kvar" }]);
    io.to(lobby.id).emit("reveal", revealPayload);
    setTimeout(() => {
      winner.chips += lobby.pot;
      lobby.pot = 0;
      proceedAfterHand(lobby);
    }, REVEAL_DELAY_MS);
    return;
  }

  // Utvärdera bästa hand bland aktiva
  const results = active.map(p => ({
    player: p,
    rank: evaluateBestOfSeven([...p.hand, ...lobby.community])
  }));

  // Hitta bästa rank (lexicografiskt)
  let bestRank = results[0].rank;
  for (const r of results) {
    if (compareRanks(r.rank, bestRank) > 0) bestRank = r.rank;
  }
  const winners = results.filter(r => compareRanks(r.rank, bestRank) === 0).map(r => r.player);

  // Bygg reveal payload (alla spelarhänder + winners info)
  const winnersInfo = winners.map(w => ({
    socketId: w.socketId,
    name: w.name,
    rank: evaluateBestOfSeven([...w.hand, ...lobby.community]),
    rankDesc: rankCategoryName(evaluateBestOfSeven([...w.hand, ...lobby.community]))
  }));
  const revealPayload = makeRevealPayload(lobby, winners, winnersInfo);

  // Skicka reveal (alla klienter visar kort och vinnare)
  io.to(lobby.id).emit("reveal", revealPayload);

  // Vänta och dela potten (enkelt split mellan winners)
  setTimeout(() => {
    if (winners.length === 1) {
      winners[0].chips += lobby.pot;
      lobby.pot = 0;
    } else {
      // Enkelt split: dela pott lika (ingen side-pot-hantering här)
      const share = Math.floor(lobby.pot / winners.length);
      let remainder = lobby.pot - share * winners.length;
      winners.forEach((p, idx) => {
        p.chips += share + (idx === 0 ? remainder : 0);
      });
      lobby.pot = 0;
    }
    proceedAfterHand(lobby);
  }, REVEAL_DELAY_MS);
}

/* ---------------------------
   Hjälp: bygg reveal-payload
   --------------------------- */
function makeRevealPayload(lobby, winners, winnersInfo) {
  // Returnerar objekt med alla spelare (inkl. riktiga händer), community, pot och winners
  return {
    players: lobby.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      chips: p.chips,
      folded: p.folded,
      hand: p.hand
    })),
    community: lobby.community,
    pot: lobby.pot,
    winners: winnersInfo
  };
}

/* ---------------------------
   Efter hand: öka roundNumber, kolla slutvillkor, starta nästa hand eller gameOver
   --------------------------- */
function proceedAfterHand(lobby) {
  if (typeof lobby.roundNumber !== "number") lobby.roundNumber = 0;
  lobby.roundNumber += 1;

  // Kolla om någon har alla chips (dvs en vinnare) eller om rounds-limit nåtts
  const playersWithChips = lobby.players.filter(p => p.chips > 0);
  const onlyOneHasChips = playersWithChips.length === 1;
  const roundsLimitReached = (lobby.settings.rounds > 0 && lobby.roundNumber >= lobby.settings.rounds);

  if (roundsLimitReached || onlyOneHasChips) {
    lobby.status = "finished";
    io.to(lobby.id).emit("gameOver", publicLobbyState(lobby));
    return;
  }

  // Annars starta nästa hand
  initHand(lobby);
}

/* ---------------------------
   Hjälp: rank-kategori namn (för UI)
   --------------------------- */
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

/* ---------------------------
   Broadcast helper (personlig + lobby)
   --------------------------- */
function broadcastState(lobby) {
  if (!lobby) return;
  // Skicka personlig gameUpdate till varje spelare (så de ser sina kort)
  lobby.players.forEach(p => {
    io.to(p.socketId).emit("gameUpdate", publicLobbyState(lobby, p.socketId));
  });
  // Skicka lobbyUpdate (översikt) till hela rummet
  io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
}

/* ---------------------------
   Socket.io events
   --------------------------- */
io.on("connection", (socket) => {
  console.log(`[Socket] ansluten: ${socket.id}`);

  // Hjälp: hitta lobby där socket är med
  const findLobbyBySocket = () => {
    for (const lobby of lobbies.values()) {
      if (lobby.players.find(p => p.socketId === socket.id)) return lobby;
    }
    return null;
  };

  /* ---------------------------
     createLobby
     payload: { name, settings }
     ack: { ok, lobbyId, me, lobby }
  */
  socket.on("createLobby", ({ name, settings } = {}, ack) => {
    try {
      const lobbyId = generateLobbyId();
      const parsedRounds = (() => {
        const v = parseInt(settings?.rounds, 10);
        if (Number.isNaN(v)) return 5;
        return Math.max(0, Math.min(100000, v));
      })();

      const lobby = {
        id: lobbyId,
        hostId: socket.id,
        status: "lobby",
        settings: {
          startChips: clampInt(settings?.startChips ?? 1000, 100, 1000000),
          rounds: parsedRounds,
          smallBlind: clampInt(settings?.smallBlind ?? 5, 1, 100000),
          bigBlind: clampInt(settings?.bigBlind ?? 10, 2, 200000)
        },
        players: [],
        roundNumber: 0
      };

      const player = makePlayer(socket.id, (name || "Host"), true, lobby.settings.startChips);
      lobby.players.push(player);
      lobbies.set(lobbyId, lobby);

      socket.join(lobbyId);
      const payload = { ok: true, lobbyId, me: player, lobby: publicLobbyState(lobby, socket.id) };
      ack?.(payload);
      io.to(lobbyId).emit("lobbyUpdate", publicLobbyState(lobby));
      console.log(`[Lobby] skapad: ${lobbyId} av ${socket.id}`);
    } catch (e) {
      console.error("createLobby error:", e);
      ack?.({ ok: false, error: "Misslyckades skapa lobby." });
    }
  });

  /* ---------------------------
     joinLobby
     payload: { lobbyId, name }
  */
  socket.on("joinLobby", ({ lobbyId, name } = {}, ack) => {
    try {
      if (!lobbyId) return ack?.({ ok: false, error: "LobbyId krävs." });
      const lobby = lobbies.get((lobbyId || "").toUpperCase());
      if (!lobby) return ack?.({ ok: false, error: "Lobby hittades inte." });
      if (lobby.status !== "lobby") return ack?.({ ok: false, error: "Spelet har redan startat i denna lobby." });
      if (lobby.players.length >= 4) return ack?.({ ok: false, error: "Lobbyn är full (max 4 spelare)." });

      const player = makePlayer(socket.id, (name || "Spelare"), false, lobby.settings.startChips);
      lobby.players.push(player);
      socket.join(lobby.id);
      ack?.({ ok: true, me: player, lobby: publicLobbyState(lobby, socket.id) });
      io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
      console.log(`[Lobby] ${socket.id} gick med i ${lobby.id}`);
    } catch (e) {
      console.error("joinLobby error:", e);
      ack?.({ ok: false, error: "Misslyckades gå med i lobby." });
    }
  });

  /* ---------------------------
     leaveLobby
  */
  socket.on("leaveLobby", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    removePlayerFromLobby(lobby, socket.id);
  });

  /* ---------------------------
     startGame (host)
  */
  socket.on("startGame", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return socket.emit("errorMessage", "Ingen lobby hittad.");
    if (socket.id !== lobby.hostId) return socket.emit("errorMessage", "Endast host kan starta spelet.");
    if (lobby.players.length < 2) return socket.emit("errorMessage", "Minst 2 spelare krävs.");

    lobby.status = "playing";
    lobby.roundNumber = 0;
    // Säkerställ att alla har minst startchips
    lobby.players.forEach(p => { if (p.chips <= 0) p.chips = lobby.settings.startChips; });
    initHand(lobby);
  });

  /**
   * playerAction: { type: 'check'|'call'|'bet'|'fold', amount? }
   */
  socket.on("playerAction", ({ type, amount } = {}) => {
    const lobby = findLobbyBySocket();
    if (!lobby) return socket.emit("errorMessage", "Du är inte i någon lobby.");
    if (lobby.status !== "playing") return socket.emit("errorMessage", "Spelet har inte startat.");

    const idx = lobby.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return socket.emit("errorMessage", "Spelare ej hittad i lobby.");
    if (idx !== lobby.currentPlayerIndex) return socket.emit("errorMessage", "Det är inte din tur.");

    const player = lobby.players[idx];
    if (player.folded) return socket.emit("errorMessage", "Du har redan foldat.");

    // --- FÖR ALLA ACTIONS: defensiva kontroller och set hasActed när relevant ---
    if (type === "fold") {
      player.folded = true;
      player.hasActed = true;
      // Om endast en spelare kvar -> vinnaren tar potten via showdown-path
      if (lobby.players.filter(p => !p.folded).length <= 1) {
        // Vi går direkt till showdown för att visa reveal och dela pot
        lobby.phase = "showdown";
        return showdown(lobby);
      }
      moveToNextTurn(lobby);
      return;
    }

    if (type === "check") {
      // Check allowed endast om spelarens bet >= currentBet
      if (lobby.currentBet > 0 && player.bet < lobby.currentBet) {
        return socket.emit("errorMessage", "Du kan inte checka, du måste syna eller höja.");
      }
      player.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }

    if (type === "call") {
      const needed = Math.max(0, (lobby.currentBet || 0) - player.bet);
      if (needed <= 0) {
        // Inget att syna
        player.hasActed = true;
        return moveToNextTurn(lobby);
      }
      const pay = Math.min(needed, player.chips);
      player.chips -= pay;
      player.bet += pay;
      lobby.pot += pay;
      player.hasActed = true;
      // Om bet < needed (all-in) så lämnar spelaren med 0 chips men bet kan vara mindre än currentBet
      moveToNextTurn(lobby);
      return;
    }

    if (type === "bet") {
      const raw = Math.floor(Number(amount) || 0);
      if (raw <= 0) return socket.emit("errorMessage", "Ange ett positivt belopp att betta.");
      const minOpen = lobby.settings.bigBlind;
      const minCall = Math.max(0, (lobby.currentBet || 0) - player.bet);

      // Om ingen nuvarande bet => detta är en öppning/raise och måste vara minst big blind
      if ((lobby.currentBet || 0) === 0 && raw < minOpen) {
        return socket.emit("errorMessage", `Minsta öppningsbet är ${minOpen}.`);
      }
      // Om det redan finns currentBet måste man minst syna
      if ((lobby.currentBet || 0) > 0 && raw < minCall) {
        return socket.emit("errorMessage", `Du måste minst syna ${minCall}.`);
      }

      const betAmount = Math.min(raw, player.chips);
      player.chips -= betAmount;
      player.bet += betAmount;
      lobby.pot += betAmount;

      // Om spelaren nu har högre bet än previous currentBet -> raise
      if (player.bet > lobby.currentBet) {
        lobby.currentBet = player.bet;
        // Efter en raise måste andra aktiva spelare få möjlighet att agera på nytt
        lobby.players.forEach((p, i) => {
          if (!p.folded && i !== idx) p.hasActed = false;
        });
      }

      player.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }

    // Ogiltig action
    socket.emit("errorMessage", "Ogiltig action.");
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`[Socket] disconnect: ${socket.id}`);
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    removePlayerFromLobby(lobby, socket.id);
  });

  /* ---------------------------
     Hjälp: ta bort spelare (hantera host leave, avsluta lobby etc.)
     --------------------------- */
  function removePlayerFromLobby(lobby, socketId) {
    const i = lobby.players.findIndex(p => p.socketId === socketId);
    if (i === -1) return;
    const wasHost = (lobby.players[i].socketId === lobby.hostId);
    lobby.players.splice(i, 1);

    if (lobby.players.length === 0) {
      // Inga kvar - ta bort lobby helt
      lobbies.delete(lobby.id);
      console.log(`[Lobby] raderad: ${lobby.id} (tom)`); 
      return;
    }

    // Om host lämnade -> överför host till första kvarvarande spelaren
    if (wasHost) {
      lobby.hostId = lobby.players[0].socketId;
      lobby.players[0].isHost = true;
    }

    // Om spel pågick och färre än 2 spelare kvar -> avsluta hand
    if (lobby.status === "playing" && lobby.players.filter(p => !p.folded).length <= 1) {
      const winner = lobby.players.find(p => !p.folded) || lobby.players[0];
      // Ge potten direkt
      winner.chips += lobby.pot;
      lobby.pot = 0;
      // Gå vidare / avsluta
      proceedAfterHand(lobby);
    }

    // Anpassa indexer (försiktigt)
    if (typeof lobby.dealerIndex === "number") lobby.dealerIndex = lobby.dealerIndex % lobby.players.length;
    if (typeof lobby.smallBlindIndex === "number") lobby.smallBlindIndex = lobby.smallBlindIndex % lobby.players.length;
    if (typeof lobby.bigBlindIndex === "number") lobby.bigBlindIndex = lobby.bigBlindIndex % lobby.players.length;
    if (typeof lobby.currentPlayerIndex === "number") lobby.currentPlayerIndex = lobby.currentPlayerIndex % lobby.players.length;

    io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
    broadcastState(lobby);
  }
});

/* ---------------------------
   Hjälpfunktion: skapa spelareobjekt
   --------------------------- */
function makePlayer(socketId, name, isHost = false, startChips = 1000) {
  return {
    id: socketId,
    name: String(name).slice(0, 30),
    socketId,
    isHost,
    chips: startChips,
    folded: false,
    bet: 0,
    hasActed: false,
    hand: []
  };
}

/* ---------------------------
   Små hjälpfunktioner
   --------------------------- */
function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (Number.isNaN(v)) v = min;
  return Math.max(min, Math.min(max, v));
}

/* ---------------------------
   Start server
   --------------------------- */
server.listen(PORT, () => {
  console.log(`Server lyssnar på port ${PORT}`);
});

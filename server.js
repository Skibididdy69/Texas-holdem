/**
 * server.js
 * Express + Socket.io-server för Texas Hold'em-lobbyer.
 * - Skapar och hanterar lobbies (2–4 spelare)
 * - Host sätter startpengar, antal rundor, blinds
 * - Realtime-uppdateringar via Socket.io
 * - Grundläggande Texas Hold'em-flöde (deal, flop, turn, river, showdown)
 * - Enkel betting per runda (check, bet, fold)
 * - Render-kompatibel (process.env.PORT)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Tillåt CORS för enkel Render/GitHub-setup
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Servera frontend
app.use(express.static(path.join(__dirname, "public")));

// ======== Spel-/Lobby-modeller (minne) ========

/**
 * Lobby-struktur:
 * {
 *   id, hostId, status: 'lobby'|'playing'|'finished',
 *   settings: { startChips, rounds, smallBlind, bigBlind },
 *   players: [ { id, name, socketId, isHost, chips, folded, bet, hasActed, hand: [card, card] } ],
 *   roundNumber, dealerIndex, smallBlindIndex, bigBlindIndex,
 *   deck: [cards], community: [], pot, currentBet, currentPlayerIndex, phase
 * }
 */
const lobbies = new Map();

// ======== Hjälpfunktioner: kortlek & hands ========

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2..14

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ r, s, code: r + s }); // code = "A♠", etc
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function generateLobbyId() {
  // 5-teckens lobby-ID, lätt att skriva
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[(Math.random() * chars.length) | 0];
  return id;
}

// ======== Handutvärdering (5-korts jämförelse över 7-korts kombinationer) ========
// Kategorier: 8 SF, 7 Quads, 6 Full House, 5 Flush, 4 Straight, 3 Trips, 2 Two Pair, 1 Pair, 0 High
function evaluateBestOfSeven(cards7) {
  const combos = combinations(cards7, 5);
  let best = null;
  for (const combo of combos) {
    const rank = rank5(combo);
    if (!best || compareRanks(rank, best) > 0) best = rank;
  }
  return best;
}

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

function rank5(cards) {
  // cards: [{r,s}]
  const ranks = cards.map(c => RANK_VAL[c.r]).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const counts = new Map();
  ranks.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));

  const byCountDesc = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const isFlush = suits.every(s => s === suits[0]);

  // Straight (hantera wheel A-5)
  let unique = [...new Set(ranks)];
  let straightHigh = getStraightHigh(unique);
  let isStraight = straightHigh > 0;

  if (isFlush && isStraight) {
    return [8, straightHigh]; // Straight Flush
  }

  if (byCountDesc[0][1] === 4) {
    // Four of a kind
    const quad = byCountDesc[0][0];
    const kicker = byCountDesc.find(([v, c]) => c === 1)[0];
    return [7, quad, kicker];
  }

  if (byCountDesc[0][1] === 3 && byCountDesc[1][1] === 2) {
    // Full house
    return [6, byCountDesc[0][0], byCountDesc[1][0]];
  }

  if (isFlush) {
    return [5, ...ranks];
  }

  if (isStraight) {
    return [4, straightHigh];
  }

  if (byCountDesc[0][1] === 3) {
    // Trips + kickers
    const trip = byCountDesc[0][0];
    const kickers = byCountDesc.filter(([, c]) => c === 1).map(([v]) => v).sort((a, b) => b - a);
    return [3, trip, ...kickers];
  }

  if (byCountDesc[0][1] === 2 && byCountDesc[1][1] === 2) {
    // Two pair + kicker
    const p1 = Math.max(byCountDesc[0][0], byCountDesc[1][0]);
    const p2 = Math.min(byCountDesc[0][0], byCountDesc[1][0]);
    const kicker = byCountDesc.find(([, c]) => c === 1)[0];
    return [2, p1, p2, kicker];
  }

  if (byCountDesc[0][1] === 2) {
    // Pair + 3 kickers
    const pair = byCountDesc[0][0];
    const kickers = byCountDesc.filter(([, c]) => c === 1).map(([v]) => v).sort((a, b) => b - a);
    return [1, pair, ...kickers];
  }

  return [0, ...ranks];
}

function getStraightHigh(vals) {
  // Hantera A-5
  if (vals.includes(14)) vals = [14, ...vals.filter(v => v !== 14)];
  let run = 1;
  let best = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i > 0) {
      if (vals[i] === vals[i - 1] - 1) {
        run++;
      } else if (vals[i] !== vals[i - 1]) {
        run = 1;
      }
    }
    if (run >= 5) {
      best = vals[i - 4]; // högsta kortet i str8
      break;
    }
  }
  // Specialfall 5-4-3-2-A (wheel), hög = 5
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

// ======== Lobby- och spelhantering ========

function publicLobbyState(lobby, forSocketId) {
  // Skicka endast nödvändiga fält + göm andras hålkort
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

function initHand(lobby) {
  lobby.deck = shuffle(createDeck());
  lobby.community = [];
  lobby.pot = 0;
  lobby.phase = "preflop";
  lobby.currentBet = 0;

  // Nollställ spelare för ny hand
  lobby.players.forEach(p => {
    p.folded = false;
    p.bet = 0;
    p.hasActed = false;
    p.hand = [lobby.deck.pop(), lobby.deck.pop()];
  });

  // Roterande dealer
  if (typeof lobby.dealerIndex !== "number") lobby.dealerIndex = 0;
  else lobby.dealerIndex = (lobby.dealerIndex + 1) % lobby.players.length;

  // Blinds
  lobby.smallBlindIndex = (lobby.dealerIndex + 1) % lobby.players.length;
  lobby.bigBlindIndex = (lobby.dealerIndex + 2) % lobby.players.length;

  applyBlind(lobby, lobby.smallBlindIndex, lobby.settings.smallBlind);
  applyBlind(lobby, lobby.bigBlindIndex, lobby.settings.bigBlind);
  lobby.currentBet = lobby.settings.bigBlind;

  // Första action: spelaren efter big blind
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

function nextActiveIndex(lobby, start) {
  let i = start;
  for (let step = 0; step < lobby.players.length; step++) {
    const p = lobby.players[i];
    if (p && !p.folded && p.chips >= 0) return i;
    i = (i + 1) % lobby.players.length;
  }
  return -1;
}

function allOthersCalledOrFolded(lobby) {
  // Alla aktiva spelare har minst currentBet i p.bet (eller har foldat)
  return lobby.players.every(p => p.folded || p.bet === lobby.currentBet);
}

function onlyOneLeft(lobby) {
  return lobby.players.filter(p => !p.folded).length === 1;
}

function advancePhase(lobby) {
  // Nollställ per bettingrunda
  lobby.players.forEach(p => {
    p.bet = 0;
    p.hasActed = false;
  });
  lobby.currentBet = 0;

  if (lobby.phase === "preflop") {
    // Flop (3 kort)
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

  // Efter flop/turn/river börjar action från spelaren efter dealern
  lobby.currentPlayerIndex = nextActiveIndex(lobby, (lobby.dealerIndex + 1) % lobby.players.length);
  broadcastState(lobby);
}

function showdown(lobby) {
  const active = lobby.players.filter(p => !p.folded);
  if (active.length === 0) {
    // Ingen kvar? potten blir kvar (extremfall) – ge dealern potten
    lobby.players[lobby.dealerIndex].chips += lobby.pot;
    lobby.pot = 0;
  } else if (active.length === 1) {
    active[0].chips += lobby.pot;
    lobby.pot = 0;
  } else {
    // Utvärdera bästa 5 av 7
    const results = active.map(p => ({
      p,
      rank: evaluateBestOfSeven([...p.hand, ...lobby.community])
    }));
    results.sort((a, b) => compareRanks(a.rank, b.rank)); // stigande
    const best = results[results.length - 1].rank;
    const winners = results.filter(r => compareRanks(r.rank, best) === 0).map(r => r.p);
    const share = Math.floor(lobby.pot / winners.length);
    let remainder = lobby.pot - share * winners.length;
    winners.forEach((p, idx) => {
      p.chips += share + (idx === 0 ? remainder : 0); // ev. rest till första
    });
    lobby.pot = 0;
  }

  // Nästa hand eller spel slut
  lobby.roundNumber += 1;
  if (lobby.roundNumber >= lobby.settings.rounds) {
    lobby.status = "finished";
    io.to(lobby.id).emit("gameOver", publicLobbyState(lobby)); // Skicka slutställning
  } else {
    initHand(lobby);
  }
  broadcastState(lobby);
}

function broadcastState(lobby) {
  // Skicka personlig vy till varje spelare (så endast egna hålkort syns)
  lobby.players.forEach(p => {
    io.to(p.socketId).emit("gameUpdate", publicLobbyState(lobby, p.socketId));
  });
  // Och en lobbyUpdate för UI som visar lobbyinfo (även under spel)
  io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
}

// ======== Socket.io events ========

io.on("connection", (socket) => {
  // Hjälp: hitta lobby och spelare för en socket
  const findLobbyBySocket = () => {
    for (const lobby of lobbies.values()) {
      if (lobby.players.find(p => p.socketId === socket.id)) return lobby;
    }
    return null;
  };

  socket.on("createLobby", ({ name, settings }, ack) => {
    try {
      const lobbyId = generateLobbyId();
      const lobby = {
        id: lobbyId,
        hostId: socket.id,
        status: "lobby",
        settings: {
          startChips: clampInt(settings.startChips ?? 1000, 100, 1000000),
          rounds: clampInt(settings.rounds ?? 5, 1, 1000),
          smallBlind: clampInt(settings.smallBlind ?? 5, 1, 100000),
          bigBlind: clampInt(settings.bigBlind ?? 10, 2, 200000)
        },
        players: [],
        roundNumber: 0
      };
      const player = {
        id: socket.id, // använd socketId som spelar-ID
        name: (name || "Host").slice(0, 20),
        socketId: socket.id,
        isHost: true,
        chips: lobby.settings.startChips,
        folded: false,
        bet: 0,
        hasActed: false,
        hand: []
      };
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

    const player = {
      id: socket.id,
      name: (name || "Spelare").slice(0, 20),
      socketId: socket.id,
      isHost: false,
      chips: lobby.settings.startChips,
      folded: false,
      bet: 0,
      hasActed: false,
      hand: []
    };
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
    if (socket.id !== lobby.hostId) return socket.emit("errorMessage", "Endast host kan starta.");
    if (lobby.players.length < 2) return socket.emit("errorMessage", "Minst 2 spelare krävs.");
    if (lobby.players.length > 4) return socket.emit("errorMessage", "Max 4 spelare.");

    lobby.status = "playing";
    lobby.roundNumber = 0;
    // Säkerställ att alla har startpengar (om någon joinat sent)
    lobby.players.forEach(p => {
      if (p.chips <= 0) p.chips = lobby.settings.startChips;
    });
    initHand(lobby);
  });

  socket.on("playerAction", ({ type, amount }) => {
    // type: 'check' | 'bet' | 'fold'
    const lobby = findLobbyBySocket();
    if (!lobby || lobby.status !== "playing") return;
    const idx = lobby.players.findIndex(p => p.socketId === socket.id);
    if (idx !== lobby.currentPlayerIndex) return socket.emit("errorMessage", "Inte din tur.");
    const me = lobby.players[idx];

    if (me.folded) return socket.emit("errorMessage", "Du har redan foldat.");

    if (type === "fold") {
      me.folded = true;
      me.hasActed = true;
      if (onlyOneLeft(lobby)) {
        // Ge potten till sista spelaren
        const winner = lobby.players.find(p => !p.folded) || me;
        winner.chips += lobby.pot;
        lobby.pot = 0;
        lobby.roundNumber += 1;
        if (lobby.roundNumber >= lobby.settings.rounds) {
          lobby.status = "finished";
          io.to(lobby.id).emit("gameOver", publicLobbyState(lobby));
        } else {
          initHand(lobby);
        }
        return;
      }
      moveToNextTurn(lobby);
      return;
    }

    if (type === "check") {
      if (lobby.currentBet > 0 && me.bet < lobby.currentBet) {
        return socket.emit("errorMessage", "Du kan inte checka – det finns en bet att syna.");
      }
      me.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }

    if (type === "bet") {
      const minCall = lobby.currentBet - me.bet;
      const minOpen = lobby.settings.bigBlind;
      let betAmount = Math.floor(Number(amount) || 0);

      if (lobby.currentBet === 0) {
        // Öppningsbet måste vara minst big blind
        if (betAmount < minOpen) {
          return socket.emit("errorMessage", `Minsta bet är ${minOpen}.`);
        }
      } else {
        // Om bet finns måste minst synas
        if (betAmount < minCall) {
          return socket.emit("errorMessage", `Du måste minst syna ${minCall}.`);
        }
      }

      betAmount = Math.max(0, Math.min(betAmount, me.chips)); // kan inte betta mer än man har
      me.chips -= betAmount;
      me.bet += betAmount;
      lobby.pot += betAmount;

      if (me.bet > lobby.currentBet) {
        lobby.currentBet = me.bet; // raise
        // Nollställ andras hasActed så de får chans att svara på höjningen
        lobby.players.forEach((p, i) => {
          if (!p.folded && i !== idx) p.hasActed = false;
        });
      }

      me.hasActed = true;
      moveToNextTurn(lobby);
      return;
    }
  });

  socket.on("disconnect", () => {
    const lobby = findLobbyBySocket();
    if (!lobby) return;
    removePlayerFromLobby(lobby, socket.id);
  });

  function removePlayerFromLobby(lobby, socketId) {
    const i = lobby.players.findIndex(p => p.socketId === socketId);
    if (i === -1) return;
    const wasHost = lobby.players[i].socketId === lobby.hostId;
    lobby.players.splice(i, 1);

    if (lobby.players.length === 0) {
      lobbies.delete(lobby.id);
      return;
    }

    // Vid spel: om bara en kvar -> den vinner potten och handen avslutas
    if (lobby.status === "playing" && lobby.players.filter(p => !p.folded).length <= 1) {
      const winner = lobby.players.find(p => !p.folded) || lobby.players[0];
      winner.chips += lobby.pot;
      lobby.pot = 0;
      lobby.roundNumber += 1;
      if (lobby.roundNumber >= lobby.settings.rounds) {
        lobby.status = "finished";
        io.to(lobby.id).emit("gameOver", publicLobbyState(lobby));
      } else {
        initHand(lobby);
      }
    }

    // Om host lämnar: överför host till första spelaren
    if (wasHost) {
      lobby.hostId = lobby.players[0].socketId;
      lobby.players[0].isHost = true;
    }

    // Anpassa index om nödvändigt
    lobby.dealerIndex = lobby.dealerIndex % lobby.players.length;
    lobby.smallBlindIndex = lobby.smallBlindIndex % lobby.players.length;
    lobby.bigBlindIndex = lobby.bigBlindIndex % lobby.players.length;
    lobby.currentPlayerIndex = lobby.currentPlayerIndex % lobby.players.length;

    io.to(lobby.id).emit("lobbyUpdate", publicLobbyState(lobby));
    broadcastState(lobby);
  }

  function moveToNextTurn(lobby) {
    // Om alla kallat/checkat -> nästa fas
    if (allOthersCalledOrFolded(lobby)) {
      if (lobby.phase === "river") {
        lobby.phase = "showdown";
        return showdown(lobby);
      }
      return advancePhase(lobby);
    }

    // Annars hitta nästa aktiva som inte har foldat
    let next = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    next = nextActiveIndex(lobby, next);
    lobby.currentPlayerIndex = next;
    broadcastState(lobby);
  }
});

function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (Number.isNaN(v)) v = min;
  return Math.max(min, Math.min(max, v));
}

server.listen(PORT, () => {
  console.log(`Server lyssnar på port ${PORT}`);
});


/**
 * client.js
 * Frontend-klient för lobby och spelvy.
 * - Hanterar Socket.io-anslutning
 * - Skapa/join-lobby
 * - Realtidsuppdatering av lobby- och speldata
 * - Visa community cards, egna hålkort och chipcounts
 * - Betting-knappar (check, bet/syna, fold)
 */

const socket = io();

let me = null;           // { id, name, socketId, isHost, chips, ... }
let currentLobby = null; // public lobby state (sanitiserad)
let mySocketId = null;

socket.on("connect", () => {
  mySocketId = socket.id;
});

// ======= UI Helpers =======
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function show(el, flag) { el.hidden = !flag; }
function text(el, t) { el.textContent = t; }
function html(el, h) { el.innerHTML = h; }
function fmtChips(n) { return Number(n || 0).toLocaleString("sv-SE"); }

function toast(msg, type = "") {
  const t = $("#toast");
  t.className = `toast ${type}`;
  t.textContent = msg;
  show(t, true);
  setTimeout(() => show(t, false), 2500);
}

// ======= Auth/Create/Join =======
$("#createLobbyBtn").addEventListener("click", () => {
  const name = $("#hostName").value.trim() || "Host";
  const settings = {
    startChips: Number($("#startChips").value) || 1000,
    rounds: Number($("#rounds").value) || 5,
    smallBlind: Number($("#smallBlind").value) || 5,
    bigBlind: Number($("#bigBlind").value) || 10
  };

  socket.emit("createLobby", { name, settings }, (res) => {
    if (!res?.ok) return toast(res?.error || "Kunde inte skapa lobby.", "error");
    me = res.me;
    currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(currentLobby.id);
  });
});

$("#joinLobbyBtn").addEventListener("click", () => {
  const name = $("#joinName").value.trim() || "Spelare";
  const lobbyId = ($("#joinLobbyId").value || "").toUpperCase().trim();
  if (!lobbyId) return toast("Ange ett lobby-ID.", "error");

  socket.emit("joinLobby", { lobbyId, name }, (res) => {
    if (!res?.ok) return toast(res?.error || "Kunde inte gå med i lobby.", "error");
    me = res.me;
    currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(currentLobby.id);
  });
});

$("#leaveLobbyBtn").addEventListener("click", () => {
  socket.emit("leaveLobby");
  location.reload();
});

$("#backToLobbyBtn").addEventListener("click", () => {
  show($("#gameView"), false);
  show($("#lobbyView"), true);
});

$("#copyLobbyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#lobbyIdText").textContent);
    toast("Lobby-ID kopierat!");
  } catch {
    toast("Kunde inte kopiera.", "error");
  }
});

// ======= Lobby rendering & events =======
socket.on("lobbyUpdate", (lobby) => {
  currentLobby = lobby;
  renderLobby(lobby);
});

function enterLobby(lobbyId) {
  show($("#authView"), false);
  show($("#lobbyView"), true);
  show($("#lobbyIdBadge"), true);
  text($("#lobbyIdText"), lobbyId);
}

function renderLobby(l) {
  // Inställningar
  text($("#sStart"), fmtChips(l.settings.startChips));
  text($("#sRounds"), l.settings.rounds);
  text($("#sSB"), fmtChips(l.settings.smallBlind));
  text($("#sBB"), fmtChips(l.settings.bigBlind));

  // Spelare
  const items = l.players.map(p => `
    <li class="player">
      <div class="avatar">${p.name[0]?.toUpperCase() || "?"}</div>
      <div class="info">
        <div class="name">${p.name} ${p.socketId === l.dealerSocketId ? '<span class="tag">D</span>' : ''}</div>
        <div class="chips">${fmtChips(p.chips)} chips</div>
      </div>
      ${p.isHost ? '<div class="badge">Host</div>' : ''}
    </li>
  `).join("");
  html($("#playerList"), items);

  // Host UI
  const isMeHost = l.players.find(p => p.socketId === mySocketId)?.isHost;
  show($("#hostBadge"), !!isMeHost);
  show($("#startGameBtn"), !!isMeHost && l.status === "lobby" && l.players.length >= 2);

  // Om spelet redan är igång, gå till spelvy
  if (l.status === "playing" || l.status === "finished") {
    show($("#lobbyView"), false);
    show($("#gameView"), true);
  }
}

$("#startGameBtn").addEventListener("click", () => {
  socket.emit("startGame");
});

// ======= Spelrendering & handling =======
socket.on("gameUpdate", (state) => {
  currentLobby = state;
  renderGame(state);
});

socket.on("errorMessage", (msg) => {
  toast(msg, "error");
});

socket.on("gameOver", (state) => {
  // Visa slutlig lobby/spelstatus
  currentLobby = state;
  renderGame(state);
  toast("Spelet är slut!", "success");
});

function renderGame(state) {
  // Visa vyer
  show($("#gameView"), true);
  show($("#lobbyView"), false);

  // Community cards
  renderCards($("#communityCards"), state.community);

  // Pot/phase/round
  text($("#potValue"), fmtChips(state.pot));
  text($("#phaseText"), state.phase ? `– ${state.phase.toUpperCase()}` : "");
  text($("#roundText"), `Runda ${state.roundNumber + 1} / ${state.settings.rounds}`);

  // Spelare runt bordet
  const pHtml = state.players.map(p => {
    const turn = state.currentPlayerSocketId === p.socketId ? "turn" : "";
    const folded = p.folded ? "folded" : "";
    const blind =
      (state.smallBlindSocketId === p.socketId ? '<span class="tag">SB</span>' : '') +
      (state.bigBlindSocketId === p.socketId ? '<span class="tag">BB</span>' : '') +
      (state.dealerSocketId === p.socketId ? '<span class="tag">D</span>' : '');
    return `
      <div class="seat ${turn} ${folded}">
        <div class="seat-header">
          <div class="name">${p.name} ${blind}</div>
          <div class="chips">${fmtChips(p.chips)} chips</div>
        </div>
        <div class="hand small">${renderCardsHtml(p.hand, true)}</div>
        <div class="bet">Bet: ${fmtChips(p.bet || 0)}</div>
      </div>
    `;
  }).join("");
  html($("#playersArea"), pHtml);

  // Min egen hand
  const meP = state.players.find(p => p.socketId === mySocketId);
  if (meP) {
    renderCards($("#myHand"), meP.hand);
    text($("#myChipsText"), fmtChips(meP.chips));
  }

  // Actionbar synlig endast om det är min tur och spelet pågår
  const myTurn = state.currentPlayerSocketId === mySocketId && state.status === "playing" && state.phase !== "showdown";
  show($("#actionBar"), !!myTurn);

  text($("#currentBetText"), fmtChips(state.currentBet));

  // Prefill betAmount: syna eller öppna med BB
  const minCall = Math.max(0, (state.currentBet || 0) - (meP?.bet || 0));
  const minOpen = state.settings.bigBlind || 10;
  $("#betAmount").value = Math.max(minCall, minOpen);
}

// Render cards helpers
function renderCards(container, cards) {
  container.innerHTML = renderCardsHtml(cards);
}
function renderCardsHtml(cards, allowHidden = false) {
  if (!cards) return "";
  return cards.map(c => {
    if (c.hidden && allowHidden) return `<div class="playing-card back"></div>`;
    if (c.hidden && !allowHidden) return "";
    return `<div class="playing-card rank-${c.r} suit-${suitClass(c.s)}">
      <div class="corner tl">${c.r}<span>${c.s}</span></div>
      <div class="pip">${c.r}${c.s}</div>
      <div class="corner br">${c.r}<span>${c.s}</span></div>
    </div>`;
  }).join("");
}
function suitClass(s) {
  return s === "♥" ? "h" : s === "♦" ? "d" : s === "♣" ? "c" : "s";
}

// ======= Action buttons =======
$("#checkBtn").addEventListener("click", () => {
  socket.emit("playerAction", { type: "check" });
});

$("#betBtn").addEventListener("click", () => {
  const amount = Number($("#betAmount").value) || 0;
  socket.emit("playerAction", { type: "bet", amount });
});

$("#foldBtn").addEventListener("click", () => {
  socket.emit("playerAction", { type: "fold" });
});

/**
 * client.js
 * Frontend-logik för lobby & spel.
 * - Hanterar Socket.io-anslutning
 * - Skapa / gå med i lobby
 * - Realtidsuppdatering av lobby & spel
 * - Syna-knapp (call), separat bet-input, fold & check
 * - Visar reveal-overlay på showdown (alla kort + vinnare)
 */

/* ======= Setup socket ======= */
const socket = io();
let mySocketId = null;
let me = null;
let currentLobby = null;
let revealData = null; // när server skickar 'reveal', lagras här temporärt

socket.on("connect", () => { mySocketId = socket.id; });

/* ======= DOM-helpers ======= */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const show = (el, flag) => { if (!el) return; el.hidden = !flag; };
const text = (el, t) => { if (!el) return; el.textContent = t; };
const html = (el, h) => { if (!el) return; el.innerHTML = h; };
const fmtChips = n => Number(n || 0).toLocaleString("sv-SE");

/* ======= UI element bind ======= */
$("#createLobbyBtn").addEventListener("click", () => {
  const name = ($("#hostName").value || "Host").trim();
  const settings = {
    startChips: Number($("#startChips").value) || 1000,
    rounds: Number($("#rounds").value) || 0,
    smallBlind: Number($("#smallBlind").value) || 5,
    bigBlind: Number($("#bigBlind").value) || 10
  };
  socket.emit("createLobby", { name, settings }, (res) => {
    if (!res?.ok) return toast(res?.error || "Kunde inte skapa lobby.", "error");
    me = res.me; currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(res.lobbyId);
  });
});

$("#joinLobbyBtn").addEventListener("click", () => {
  const name = ($("#joinName").value || "Spelare").trim();
  const lobbyId = ($("#joinLobbyId").value || "").toUpperCase().trim();
  if (!lobbyId) return toast("Ange ett lobby-ID.", "error");
  socket.emit("joinLobby", { lobbyId, name }, (res) => {
    if (!res?.ok) return toast(res?.error || "Kunde inte gå med i lobby.", "error");
    me = res.me; currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(lobbyId);
  });
});

$("#leaveLobbyBtn").addEventListener("click", () => {
  socket.emit("leaveLobby");
  location.reload();
});

$("#copyLobbyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#lobbyIdText").textContent); toast("Lobby-ID kopierat!"); }
  catch { toast("Kunde inte kopiera.", "error"); }
});

$("#startGameBtn").addEventListener("click", () => socket.emit("startGame"));

$("#backToLobbyBtn").addEventListener("click", () => {
  show($("#gameView"), false); show($("#lobbyView"), true);
});

/* Action buttons */
$("#checkBtn").addEventListener("click", () => socket.emit("playerAction", { type: "check" }));
$("#callBtn").addEventListener("click", () => socket.emit("playerAction", { type: "call" }));
$("#betBtn").addEventListener("click", () => {
  const amount = Number($("#betAmount").value) || 0;
  socket.emit("playerAction", { type: "bet", amount });
});
$("#foldBtn").addEventListener("click", () => socket.emit("playerAction", { type: "fold" }));

/* ======= Socket event listeners ======= */
socket.on("lobbyUpdate", (lobby) => {
  currentLobby = lobby;
  renderLobby(lobby);
});
socket.on("gameUpdate", (state) => {
  currentLobby = state;
  renderGame(state);
});
socket.on("errorMessage", (msg) => toast(msg, "error"));

/* Reveal (server skickar alla kort + vinnare-info innan potten delas ut) */
socket.on("reveal", (payload) => {
  // payload: { players: [{socketId,name,chips,folded,hand}], community, pot, winners: [{socketId,name,rankDesc}] }
  revealData = payload;
  renderGame(currentLobby); // rendera med revealData så alla kort visas
  showRevealOverlay(payload);
});

/* Game over */
socket.on("gameOver", (state) => {
  currentLobby = state;
  renderGame(state);
  // Visa slutmeddelande
  const alive = state.players.filter(p => p.chips > 0);
  if (alive.length === 1) {
    showOverlayMessage(`${alive[0].name} vann hela spelet!`);
  } else {
    showOverlayMessage(`Spelet slut — se slutlig ställning.`);
  }
});

/* ======= Rendering: lobby ======= */
function enterLobby(lobbyId) {
  show($("#authView"), false);
  show($("#lobbyView"), true);
  show($("#lobbyIdBadge"), true);
  text($("#lobbyIdText"), lobbyId);
}

function renderLobby(l) {
  if (!l) return;
  text($("#sStart"), fmtChips(l.settings.startChips));
  text($("#sRounds"), l.settings.rounds === 0 ? "Oändligt (0)" : l.settings.rounds);
  text($("#sSB"), fmtChips(l.settings.smallBlind));
  text($("#sBB"), fmtChips(l.settings.bigBlind));

  const htmlPlayers = l.players.map(p => `
    <li class="player">
      <div class="avatar">${(p.name[0]||"?").toUpperCase()}</div>
      <div class="info">
        <div class="name">${p.name} ${p.socketId === l.dealerSocketId ? '<span class="tag">D</span>' : ''}</div>
        <div class="chips">${fmtChips(p.chips)} chips</div>
      </div>
      ${p.isHost ? '<div class="badge">Host</div>' : ''}
    </li>
  `).join("");
  html($("#playerList"), htmlPlayers);

  const isMeHost = l.players.find(p => p.socketId === mySocketId)?.isHost;
  show($("#hostBadge"), !!isMeHost);
  show($("#startGameBtn"), !!isMeHost && l.status === "lobby" && l.players.length >= 2);

  if (l.status === "playing" || l.status === "finished") {
    show($("#lobbyView"), false);
    show($("#gameView"), true);
  }
}

/* ======= Rendering: game ======= */
function renderGame(state) {
  if (!state) return;
  show($("#gameView"), true);
  show($("#lobbyView"), false);

  // Community cards: från revealData om den finns (visar alltid community)
  const community = revealData?.community ?? state.community ?? [];
  renderCards($("#communityCards"), community);

  text($("#potValue"), fmtChips(state.pot));
  text($("#phaseText"), state.phase ? `– ${state.phase.toUpperCase()}` : "");
  text($("#roundText"), `Runda ${state.roundNumber + 1} / ${state.settings.rounds === 0 ? "∞" : state.settings.rounds}`);

  // Rendera spelare: om revealData finns, använd revealData.players (alla kort) för att visa faktiska händer
  const playersToRender = revealData ? revealData.players : state.players;
  const pHtml = playersToRender.map(p => {
    const original = (state.players.find(sp => sp.socketId === p.socketId) || {});
    const isTurn = state.currentPlayerSocketId === p.socketId ? "turn" : "";
    const folded = p.folded ? "folded" : "";
    const blindTags =
      (state.smallBlindSocketId === p.socketId ? '<span class="tag">SB</span>' : '') +
      (state.bigBlindSocketId === p.socketId ? '<span class="tag">BB</span>' : '') +
      (state.dealerSocketId === p.socketId ? '<span class="tag">D</span>' : '');
    const handHtml = renderCardsHtml(p.hand || [], true); // när revealData finns visar vi alla; annars backend styr dolda kort
    return `
      <div class="seat ${isTurn} ${folded}">
        <div class="seat-header">
          <div class="name">${p.name} ${blindTags}</div>
          <div class="chips">${fmtChips(original.chips ?? p.chips)} chips</div>
        </div>
        <div class="hand small">${handHtml}</div>
        <div class="bet">Bet: ${fmtChips(original.bet ?? 0)}</div>
      </div>
    `;
  }).join("");
  html($("#playersArea"), pHtml);

  // Min hand (visa riktiga kort om revealData finns, annars server skickar egna kort i state.players)
  const meP = (revealData ? revealData.players.find(p => p.socketId === mySocketId) : state.players.find(p => p.socketId === mySocketId));
  if (meP) {
    renderCards($("#myHand"), meP.hand || []);
    text($("#myChipsText"), fmtChips(meP.chips ?? 0));
  }

  // Actionbar: synlig enbart om det är min tur och spelet pågår
  const isMyTurn = state.currentPlayerSocketId === mySocketId && state.status === "playing" && state.phase !== "showdown";
  show($("#actionBar"), !!isMyTurn);

  // Show/hide call vs check:
  const myStatePlayer = state.players.find(p => p.socketId === mySocketId) || { bet: 0, chips: 0 };
  const minCall = Math.max(0, (state.currentBet || 0) - (myStatePlayer.bet || 0));
  if (minCall > 0) {
    text($("#callBtn"), `Syna ${fmtChips(minCall)}`);
    show($("#callBtn"), true);
    show($("#checkBtn"), false);
  } else {
    show($("#callBtn"), false);
    show($("#checkBtn"), true);
  }

  // Prefill bet amount: föreslå minst big blind eller minCall beroende
  const minOpen = state.settings.bigBlind || 10;
  $("#betAmount").value = Math.max(minOpen, minCall || 0);
  text($("#currentBetText"), fmtChips(state.currentBet || 0));
}

/* ======= Renderkort-helpers ======= */
function renderCards(container, cards) { if (!container) return; container.innerHTML = renderCardsHtml(cards); }
function renderCardsHtml(cards, allowHidden = false) {
  if (!cards || !cards.length) return "";
  return cards.map(c => {
    if (c?.hidden) return `<div class="playing-card back"></div>`;
    if (!c) return "";
    return `<div class="playing-card rank-${c.r} suit-${suitClass(c.s)}">
      <div class="corner tl">${c.r}<span>${c.s}</span></div>
      <div class="pip">${c.r}${c.s}</div>
      <div class="corner br">${c.r}<span>${c.s}</span></div>
    </div>`;
  }).join("");
}
function suitClass(s) { return s === "♥" ? "h" : s === "♦" ? "d" : s === "♣" ? "c" : "s"; }

/* ======= Reveal-overlay ======= */
function showRevealOverlay(payload) {
  const overlay = $("#revealOverlay");
  const title = $("#revealTitle");
  const content = $("#revealContent");
  show(overlay, true);

  // Bygg innehåll: visa vinnare först
  const winners = payload.winners || [];
  let htmlParts = "";

  if (winners.length) {
    htmlParts += `<div class="winners">`;
    htmlParts += `<h3>Vinnare:</h3>`;
    winners.forEach(w => {
      const rankDesc = w.rankDesc ? ` (${w.rankDesc})` : "";
      htmlParts += `<div class="winner-line"><strong>${w.name}</strong>${rankDesc}</div>`;
    });
    htmlParts += `</div>`;
  }

  // Lista alla spelare med deras kort
  htmlParts += `<div class="reveal-players">`;
  payload.players.forEach(p => {
    htmlParts += `<div class="reveal-player">
      <div class="reveal-name">${p.name} — ${fmtChips(p.chips)} chips ${p.folded ? "(folded)" : ""}</div>
      <div class="reveal-hand">${renderCardsHtml(p.hand || [], true)}</div>
    </div>`;
  });
  htmlParts += `</div>`;

  html(content, htmlParts);

  // Overlay döljs automatiskt när servern skickar nästa state (efter REVEAL_DELAY_MS)
  setTimeout(() => {
    show(overlay, false);
    revealData = null;
  }, 6100);
}

function showOverlayMessage(msg) {
  const overlay = $("#revealOverlay");
  show(overlay, true);
  html($("#revealTitle"), msg);
  html($("#revealContent"), "<div style='margin-top:1rem;color:#fff;'>Spelet är över.</div>");
}

/* ======= Toast (notiser) ======= */
function toast(msg, type = "") {
  const t = $("#toast");
  t.className = `toast ${type}`;
  t.textContent = msg;
  show(t, true);
  setTimeout(() => show(t, false), 2500);
}

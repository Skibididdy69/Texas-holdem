/**
 * client.js
 * Frontend-klient för lobby & spel
 * - Socket.io-anslutning
 * - Skapa/gå med i lobby
 * - Realtidsuppdatering: lobbyUpdate, gameUpdate, reveal, gameOver
 * - Betting: check, call (syna), bet (input), fold
 * - Reveal-overlay visas vid showdown; döljs efter serverns delay
 */

const socket = io();

let mySocketId = null;
let me = null;
let currentLobby = null;
let revealData = null;

socket.on("connect", () => { mySocketId = socket.id; });

/* ---------- DOM helpers ---------- */
const $ = sel => document.querySelector(sel);
const show = (el, flag) => { if (!el) return; el.hidden = !flag; };
const text = (el, t) => { if (!el) return; el.textContent = t; };
const html = (el, h) => { if (!el) return; el.innerHTML = h; };
const fmt = n => Number(n || 0).toLocaleString("sv-SE");

/* ---------- Auth: skapa / join ---------- */
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

/* Starta spel (host) */
$("#startGameBtn").addEventListener("click", () => socket.emit("startGame"));

/* Back to lobby */
$("#backToLobbyBtn").addEventListener("click", () => {
  show($("#gameView"), false); show($("#lobbyView"), true);
});

/* ---------- Action buttons ---------- */
$("#checkBtn").addEventListener("click", () => socket.emit("playerAction", { type: "check" }));
$("#callBtn").addEventListener("click", () => socket.emit("playerAction", { type: "call" }));
$("#betBtn").addEventListener("click", () => {
  const amount = Number($("#betAmount").value) || 0;
  socket.emit("playerAction", { type: "bet", amount });
});
$("#foldBtn").addEventListener("click", () => socket.emit("playerAction", { type: "fold" }));

/* ---------- Socket listeners ---------- */
socket.on("lobbyUpdate", (lobby) => {
  currentLobby = lobby;
  renderLobby(lobby);
});

socket.on("gameUpdate", (state) => {
  currentLobby = state;
  renderGame(state);
});

socket.on("reveal", (payload) => {
  revealData = payload;
  renderGame(currentLobby);
  showRevealOverlay(payload);
});

socket.on("gameOver", (state) => {
  currentLobby = state;
  renderGame(state);
  // visa en kort overlay
  const alive = state.players.filter(p => p.chips > 0);
  if (alive.length === 1) {
    showOverlayMessage(`${alive[0].name} vann hela spelet!`);
  } else {
    showOverlayMessage(`Spelet slut — se slutlig ställning.`);
  }
});

socket.on("errorMessage", (msg) => toast(msg, "error"));

/* ---------- Render lobby ---------- */
function enterLobby(lobbyId) {
  show($("#authView"), false);
  show($("#lobbyView"), true);
  show($("#lobbyIdBadge"), true);
  text($("#lobbyIdText"), lobbyId);
}

function renderLobby(l) {
  if (!l) return;
  text($("#sStart"), fmt(l.settings.startChips));
  text($("#sRounds"), l.settings.rounds === 0 ? "Oändligt (0)" : l.settings.rounds);
  text($("#sSB"), fmt(l.settings.smallBlind));
  text($("#sBB"), fmt(l.settings.bigBlind));

  const items = l.players.map(p => `
    <li class="player">
      <div class="avatar">${p.name[0]?.toUpperCase() || "?"}</div>
      <div class="info">
        <div class="name">${p.name} ${p.socketId === l.dealerSocketId ? '<span class="tag">D</span>' : ''}</div>
        <div class="chips">${fmt(p.chips)} chips</div>
      </div>
      ${p.isHost ? '<div class="badge">Host</div>' : ''}
    </li>
  `).join("");
  html($("#playerList"), items);

  const isMeHost = l.players.find(p => p.socketId === mySocketId)?.isHost;
  show($("#hostBadge"), !!isMeHost);
  show($("#startGameBtn"), !!isMeHost && l.status === "lobby" && l.players.length >= 2);

  // Om spelet redan startat — visa gameView
  if (l.status === "playing" || l.status === "finished") {
    show($("#lobbyView"), false);
    show($("#gameView"), true);
  }
}

/* ---------- Render game ---------- */
function renderGame(state) {
  if (!state) return;
  show($("#gameView"), true);
  show($("#lobbyView"), false);

  // Community cards — använd revealData om present (visar alltid community)
  const community = revealData?.community ?? state.community ?? [];
  renderCards($("#communityCards"), community);
  text($("#potValue"), fmt(state.pot));
  text($("#phaseText"), state.phase ? `– ${state.phase.toUpperCase()}` : "");
  text($("#roundText"), `Runda ${state.roundNumber + 1} / ${state.settings.rounds === 0 ? "∞" : state.settings.rounds}`);

  // Players: om revealData finns, visa revealData.players (alla kort), annars serverns state.players (med dolda kort för andra spelare)
  const playersToRender = revealData ? revealData.players : state.players;
  const pHtml = playersToRender.map(p => {
    const original = state.players.find(sp => sp.socketId === p.socketId) || {};
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
          <div class="chips">${fmt(original.chips ?? p.chips)} chips</div>
        </div>
        <div class="hand small">${renderCardsHtml(p.hand || [], true)}</div>
        <div class="bet">Bet: ${fmt(original.bet ?? 0)}</div>
      </div>
    `;
  }).join("");
  html($("#playersArea"), pHtml);

  // Min hand (välj från revealData om present, annars servern skickar egna kort i state.players)
  const myP = (revealData ? revealData.players.find(p => p.socketId === mySocketId) : state.players.find(p => p.socketId === mySocketId));
  if (myP) {
    renderCards($("#myHand"), myP.hand || []);
    text($("#myChipsText"), fmt(myP.chips ?? 0));
  }

  // Actionbar visas bara om det är min tur och spelet pågår
  const myTurn = state.currentPlayerSocketId === mySocketId && state.status === "playing" && state.phase !== "showdown";
  show($("#actionBar"), !!myTurn);

  // Hantera call vs check UI
  const myState = state.players.find(p => p.socketId === mySocketId) || { bet: 0, chips: 0 };
  const minCall = Math.max(0, (state.currentBet || 0) - (myState.bet || 0));
  if (minCall > 0) {
    text($("#callBtn"), `Syna ${fmt(minCall)}`);
    show($("#callBtn"), true);
    show($("#checkBtn"), false);
  } else {
    show($("#callBtn"), false);
    show($("#checkBtn"), true);
  }

  // Prefill betAmount som minOpen eller minCall beroende
  const minOpen = state.settings.bigBlind || 10;
  $("#betAmount").value = Math.max(minOpen, minCall || 0);
  text($("#currentBetText"), fmt(state.currentBet || 0));
}

/* ---------- Kort-rendering ---------- */
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

/* ---------- Reveal-overlay ---------- */
function showRevealOverlay(payload) {
  const overlay = $("#revealOverlay");
  const title = $("#revealTitle");
  const content = $("#revealContent");
  show(overlay, true);

  const winners = payload.winners || [];
  title.textContent = winners.length ? (winners.map(w => w.name).join(", ") + " vann!") : "Vinnare";

  // Bygg content: vinnare + praktisk info + alla spelarhänder
  let htmlParts = "";
  if (winners.length) {
    htmlParts += `<div class="winners">`;
    winners.forEach(w => {
      htmlParts += `<div class="winner-line"><strong>${w.name}</strong>${w.rankDesc ? ` — ${w.rankDesc}` : ""}</div>`;
    });
    htmlParts += `</div>`;
  }

  htmlParts += `<div class="reveal-players">`;
  payload.players.forEach(p => {
    htmlParts += `<div class="reveal-player">
      <div class="reveal-name">${p.name} — ${fmt(p.chips)} chips ${p.folded ? "(folded)" : ""}</div>
      <div class="reveal-hand">${renderCardsHtml(p.hand || [], true)}</div>
    </div>`;
  });
  htmlParts += `</div>`;

  html(content, htmlParts);
  // Overlay döljs av servern när nästa hand börjar; men vi sätter en fallback-hide efter REVEAL_DELAY_MS+100
  setTimeout(() => {
    show(overlay, false);
    revealData = null;
  }, 6500);
}

function showOverlayMessage(msg) {
  const overlay = $("#revealOverlay");
  show(overlay, true);
  html($("#revealTitle"), msg);
  html($("#revealContent"), `<div style="margin-top:1rem;color:#fff;">Spelet är över.</div>`);
}

/* ---------- Toast ---------- */
function toast(msg, type = "") {
  const t = $("#toast");
  t.className = `toast ${type}`;
  t.textContent = msg;
  show(t, true);
  setTimeout(() => show(t, false), 2500);
}

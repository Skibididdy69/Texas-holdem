/**
 * public/client.js
 *
 * Fullständig frontend-klient för Texas Hold'em-lobbyn.
 * - Mycket detaljerad, defensiv och kommenterad på svenska.
 * - Ser till att reveal-overlay är gömd från start och visas ENDAST vid giltig reveal från servern.
 * - Hanterar: create/join lobby, lobbyUpdate, gameUpdate, reveal, gameOver, errorMessage
 * - Betting: check, call (syna), bet (input), fold
 *
 * OBS:
 * - Servern förväntas skicka: 'lobbyUpdate', 'gameUpdate', 'reveal', 'gameOver', 'errorMessage'
 * - När klienten vill agera skickas 'createLobby', 'joinLobby', 'startGame' och 'playerAction'
 *
 * Kommentar: denna fil är medvetet defensiv (många null-kontroller och "do nothing" fallback-paths)
 * så att UI inte visar overlay/text av misstag.
 */

const socket = io();

// Lokala state-variabler
let mySocketId = null;      // socket.id för den här klienten
let me = null;              // spelarobjekt som mottagits från server (när man skapar/går med)
let currentLobby = null;    // senaste lobby/game-state vi fått från server (publicLobbyState)
let revealData = null;      // payload som server skickar vid 'reveal' (visas i overlay)

/* ==========================
   DOM-helpers (små, återanvändbara)
   ========================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function safeShow(element, shouldShow) {
  if (!element) return;
  element.hidden = !shouldShow;
  if (shouldShow) element.classList?.add("show");
  else element.classList?.remove("show");
}
function safeText(element, txt) {
  if (!element) return;
  element.textContent = txt ?? "";
}
function safeHtml(element, htmlStr) {
  if (!element) return;
  element.innerHTML = htmlStr ?? "";
}
function fmt(n) { return Number(n || 0).toLocaleString("sv-SE"); }

/* ==========================
   Init: Se till att overlay och "vinnare"-element är gömda från start
   ========================== */
document.addEventListener("DOMContentLoaded", () => {
  // Defensive: göm reveal-overlay på load oavsett tidigare tillstånd i DOM/CSS
  const overlay = $("#revealOverlay");
  if (overlay) {
    overlay.hidden = true;
    overlay.classList.remove("show");
    // I vissa miljöer kan CSS visa element även med hidden=false om det finns override,
    // därför lägger vi också till inline-style display none som sista försvar.
    overlay.style.display = "none";
  }

  // Ta bort ev. statiska winnerMessage-texter om någon sådan existerar
  const winnerMessage = $("#winnerMessage");
  if (winnerMessage) {
    winnerMessage.textContent = "";
    winnerMessage.hidden = true;
  }

  // Hämta och dölj game/lobby vyer (säkert)
  safeShow($("#lobbyView"), false);
  safeShow($("#gameView"), false);
});

/* ==========================
   Socket: connect
   ========================== */
socket.on("connect", () => {
  mySocketId = socket.id;
});

/* ==========================
   UI: Event-bindningar (knappar/input)
   ========================== */

// Create lobby
$("#createLobbyBtn")?.addEventListener("click", () => {
  const name = ($("#hostName").value || "Host").trim();
  const settings = {
    startChips: Number($("#startChips").value) || 1000,
    rounds: Number($("#rounds").value) || 0, // 0 = oändligt
    smallBlind: Number($("#smallBlind").value) || 5,
    bigBlind: Number($("#bigBlind").value) || 10
  };

  // Emit med ack (server svarar via callback)
  socket.emit("createLobby", { name, settings }, (res) => {
    if (!res) return toast("Ingen respons från servern.", "error");
    if (!res.ok) return toast(res.error || "Kunde inte skapa lobby.", "error");

    // spara "me" och visa lobby
    me = res.me;
    currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(currentLobby.id);
  });
});

// Join lobby
$("#joinLobbyBtn")?.addEventListener("click", () => {
  const name = ($("#joinName").value || "Spelare").trim();
  const lobbyId = ($("#joinLobbyId").value || "").toUpperCase().trim();
  if (!lobbyId) return toast("Ange ett lobby-ID.", "error");

  socket.emit("joinLobby", { lobbyId, name }, (res) => {
    if (!res) return toast("Ingen respons från servern.", "error");
    if (!res.ok) return toast(res.error || "Kunde inte gå med i lobby.", "error");

    me = res.me;
    currentLobby = res.lobby;
    renderLobby(currentLobby);
    enterLobby(currentLobby.id);
  });
});

// Leave lobby
$("#leaveLobbyBtn")?.addEventListener("click", () => {
  socket.emit("leaveLobby");
  // reload är ett enkelt sätt att "resetta" client-state; alternativt kan vi rensa UI
  location.reload();
});

// Copy lobby ID
$("#copyLobbyBtn")?.addEventListener("click", async () => {
  const el = $("#lobbyIdText");
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent || "");
    toast("Lobby-ID kopierat!");
  } catch (e) {
    toast("Kunde inte kopiera lobby-ID.", "error");
  }
});

// Start game (host)
$("#startGameBtn")?.addEventListener("click", () => {
  socket.emit("startGame");
});

// Betting actions
$("#checkBtn")?.addEventListener("click", () => {
  socket.emit("playerAction", { type: "check" });
});
$("#callBtn")?.addEventListener("click", () => {
  socket.emit("playerAction", { type: "call" });
});
$("#betBtn")?.addEventListener("click", () => {
  const amount = Math.floor(Number($("#betAmount").value) || 0);
  socket.emit("playerAction", { type: "bet", amount });
});
$("#foldBtn")?.addEventListener("click", () => {
  socket.emit("playerAction", { type: "fold" });
});

// Back to lobby
$("#backToLobbyBtn")?.addEventListener("click", () => {
  safeShow($("#gameView"), false);
  safeShow($("#lobbyView"), true);
});

/* ==========================
   Socket: Server events
   ========================== */

/**
 * Lobby update: mottar public-lobby-state (använd för både lobby och under spel)
 * Vi uppdaterar lobby-listor och UI. Server skickar personlig vy via publicLobbyState()
 */
socket.on("lobbyUpdate", (lobby) => {
  if (!lobby) return;
  currentLobby = lobby;
  renderLobby(lobby);
});

/**
 * Game update: uppdatera spelvy (kort, pot, bets etc.)
 * Server skickar per-spelare-version (egna hålkort syns bara för ägaren).
 */
socket.on("gameUpdate", (state) => {
  if (!state) return;
  currentLobby = state;
  // Om overlay syns pga fallback, göm den — servern styr reveal via 'reveal' event
  hideRevealOverlayIfVisible();
  renderGame(state);
});

/**
 * Reveal: server vill visa ALLA kort + vinnare för en showdown.
 * Payload-format (server): { players: [...], community: [...], pot, winners: [...] }
 * Vi visar overlay ENDAST om payload är giltig.
 */
socket.on("reveal", (payload) => {
  if (!payload || !Array.isArray(payload.players) || payload.players.length === 0) {
    // ogiltigt payload -> ignorera (defensivt)
    return;
  }
  revealData = payload;
  // renderGame baserat på revealData så att vi visar faktiska kort (inklusive andra spelare)
  renderGame(currentLobby);
  showRevealOverlay(payload);
});

/**
 * Game over: slutligt state (t.ex. rounds uppnått eller en spelare har alla chips).
 * Vi visar en overlay-meddelande med vinnare.
 */
socket.on("gameOver", (state) => {
  if (!state) return;
  currentLobby = state;
  renderGame(state);
  // Hitta sista spelaren med chips (om sådan finns)
  const alive = (state.players || []).filter(p => p.chips > 0);
  if (alive.length === 1) {
    showOverlayMessage(`${alive[0].name} vann hela spelet!`);
  } else {
    showOverlayMessage("Spelet slut — se slutlig ställning.");
  }
});

/**
 * Felmeddelanden från servern — visa som toast
 */
socket.on("errorMessage", (msg) => {
  if (!msg) return;
  toast(msg, "error");
});

/* ==========================
   Rendering: Lobby
   ========================== */

/**
 * enterLobby: byter UI till lobby och visar lobby-ID
 */
function enterLobby(lobbyId) {
  safeShow($("#authView"), false);
  safeShow($("#lobbyView"), true);
  safeShow($("#lobbyIdBadge"), true);
  safeText($("#lobbyIdText"), lobbyId || "");
}

/**
 * renderLobby: uppdaterar spelare-lista och inställningar
 */
function renderLobby(lobby) {
  if (!lobby) return;

  // Inställningar
  safeText($("#sStart"), fmt(lobby.settings.startChips));
  safeText($("#sRounds"), lobby.settings.rounds === 0 ? "Oändligt (0)" : lobby.settings.rounds);
  safeText($("#sSB"), fmt(lobby.settings.smallBlind));
  safeText($("#sBB"), fmt(lobby.settings.bigBlind));

  // Spelare-lista
  const items = (lobby.players || []).map(p => `
    <li class="player">
      <div class="avatar">${(p.name || "?")[0]?.toUpperCase() || "?"}</div>
      <div class="info">
        <div class="name">${escapeHtml(p.name)} ${p.socketId === lobby.dealerSocketId ? '<span class="tag">D</span>' : ''}</div>
        <div class="chips">${fmt(p.chips)} chips</div>
      </div>
      ${p.isHost ? '<div class="badge">Host</div>' : ''}
    </li>
  `).join("");
  safeHtml($("#playerList"), items);

  // Host UI: visa startknapp endast för host i lobby-läge
  const iAmHost = (lobby.hostId === mySocketId);
  safeShow($("#hostBadge"), !!iAmHost);
  safeShow($("#startGameBtn"), !!iAmHost && lobby.status === "lobby" && (lobby.players?.length || 0) >= 2);

  // Om spelet redan är igång, visa gameView
  if (lobby.status === "playing" || lobby.status === "finished") {
    safeShow($("#lobbyView"), false);
    safeShow($("#gameView"), true);
  }
}

/* ==========================
   Rendering: Game
   ========================== */

/**
 * renderGame: central funktion som uppdaterar spelvyn baserat på 'state' från servern.
 * - Om revealData finns, används revealData för att visa faktiska händer (alla spelare).
 * - Annars används state.players, som redan är "sanitiserad" (servern skickar egna kort).
 */
function renderGame(state) {
  if (!state) return;

  safeShow($("#gameView"), true);
  safeShow($("#lobbyView"), false);

  // Community cards (om reveal present, använd revealData.community)
  const communityCards = (revealData && revealData.community) ? revealData.community : (state.community || []);
  renderCards($("#communityCards"), communityCards);

  // Pot / phase / round
  safeText($("#potValue"), fmt(state.pot));
  safeText($("#phaseText"), state.phase ? `– ${state.phase.toUpperCase()}` : "");
  safeText($("#roundText"), `Runda ${ (state.roundNumber || 0) + 1 } / ${state.settings && state.settings.rounds === 0 ? "∞" : (state.settings ? state.settings.rounds : "?")}`);

  // Spelare: om revealData finns, visa revealData.players (alla kort); annars state.players
  const playersToShow = (revealData && revealData.players) ? revealData.players : (state.players || []);
  const playersHtml = (playersToShow || []).map(p => {
    // försöka hitta motsvarande "state"-spelare för chip/bet info när reveal saknar chips uppdaterat
    const stateP = (state.players || []).find(sp => sp.socketId === p.socketId) || {};
    const isTurn = state.currentPlayerSocketId === p.socketId ? "turn" : "";
    const folded = p.folded ? "folded" : "";
    const blindTags = `${state.smallBlindSocketId === p.socketId ? '<span class="tag">SB</span>' : ''}${state.bigBlindSocketId === p.socketId ? '<span class="tag">BB</span>' : ''}${state.dealerSocketId === p.socketId ? '<span class="tag">D</span>' : ''}`;
    return `
      <div class="seat ${isTurn} ${folded}">
        <div class="seat-header">
          <div class="name">${escapeHtml(p.name)} ${blindTags}</div>
          <div class="chips">${fmt(stateP.chips ?? p.chips)} chips</div>
        </div>
        <div class="hand small">${renderCardsHtml(p.hand || [], true)}</div>
        <div class="bet">Bet: ${fmt(stateP.bet ?? 0)}</div>
      </div>
    `;
  }).join("");
  safeHtml($("#playersArea"), playersHtml);

  // Min egen hand: välj från revealData (om reveal) annars från state.players (server skickar full hand för ägaren)
  const myP = (revealData ? (revealData.players || []).find(p => p.socketId === mySocketId) : (state.players || []).find(p => p.socketId === mySocketId));
  if (myP) {
    renderCards($("#myHand"), myP.hand || []);
    safeText($("#myChipsText"), fmt(myP.chips ?? 0));
  } else {
    // om ingen myP finns, rensa min hand
    safeHtml($("#myHand"), "");
    safeText($("#myChipsText"), "0");
  }

  // Actionbar synlig endast om det är min tur och spelet pågår
  const isMyTurn = state.currentPlayerSocketId === mySocketId && state.status === "playing" && state.phase !== "showdown";
  safeShow($("#actionBar"), !!isMyTurn);

  // Hantera Call vs Check UI:
  const myStatePlayer = (state.players || []).find(p => p.socketId === mySocketId) || { bet: 0, chips: 0 };
  const minCall = Math.max(0, (state.currentBet || 0) - (myStatePlayer.bet || 0));
  if (minCall > 0) {
    safeText($("#callBtn"), `Syna ${fmt(minCall)}`);
    safeShow($("#callBtn"), true);
    safeShow($("#checkBtn"), false);
  } else {
    safeShow($("#callBtn"), false);
    safeShow($("#checkBtn"), true);
  }

  // Prefill betAmount med åtminstone big blind eller minCall
  const minOpen = (state.settings && state.settings.bigBlind) ? state.settings.bigBlind : 10;
  const suggested = Math.max(minOpen, minCall || 0);
  const betInput = $("#betAmount");
  if (betInput) betInput.value = suggested;

  // När revealData finns, visa även overlay (server kan ha skickat reveal INNAN vi renderar)
  if (revealData) {
    showRevealOverlay(revealData);
  }
}

/* ==========================
   Rendering: kort-komponenter
   ========================== */

/**
 * renderCards(container, cards)
 * - container: DOM-element
 * - cards: array av kort-objekt { r: 'A', s: '♠' } eller { hidden: true }
 */
function renderCards(container, cards) {
  if (!container) return;
  safeHtml(container, renderCardsHtml(cards));
}

/**
 * renderCardsHtml(cards, allowHidden)
 * Returnerar HTML för en rad kort.
 * - allowHidden true: vi ritar dolda kort som backsiders.
 * - kortobjektet kan innehålla .hidden för att visa baksida.
 */
function renderCardsHtml(cards, allowHidden = false) {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  return cards.map(c => {
    if (c && c.hidden) return `<div class="playing-card back"></div>`;
    if (!c) return "";
    // Sanitize rank/suit för HTML (enkelt)
    const r = escapeHtml(String(c.r || ""));
    const s = escapeHtml(String(c.s || ""));
    const suitClass = suitToClass(c.s);
    return `<div class="playing-card rank-${r} suit-${suitClass}">
      <div class="corner tl">${r}<span>${s}</span></div>
      <div class="pip">${r}${s}</div>
      <div class="corner br">${r}<span>${s}</span></div>
    </div>`;
  }).join("");
}
function suitToClass(s) {
  if (s === "♥") return "h";
  if (s === "♦") return "d";
  if (s === "♣") return "c";
  return "s";
}

/* ==========================
   Reveal-overlay / vinnare
   ========================== */

/**
 * showRevealOverlay(payload)
 * - Visar overlay med payload (players, community, pot, winners).
 * - Är defensiv: gör ingenting om payload ogiltig.
 */
function showRevealOverlay(payload) {
  if (!payload || !Array.isArray(payload.players) || payload.players.length === 0) return;
  const overlay = $("#revealOverlay");
  const titleEl = $("#revealTitle");
  const contentEl = $("#revealContent");
  if (!overlay || !titleEl || !contentEl) return;

  // Bygg titel utifrån winners (om finns)
  const winners = Array.isArray(payload.winners) ? payload.winners : [];
  if (winners.length > 0) {
    titleEl.textContent = winners.map(w => w.name).join(", ") + " vann!";
  } else {
    titleEl.textContent = "Vinnare";
  }

  // Bygg content: vinnare + varje spelares hand
  let inner = "";
  if (winners.length > 0) {
    inner += `<div class="winners">`;
    winners.forEach(w => {
      inner += `<div class="winner-line"><strong>${escapeHtml(w.name)}</strong>${w.rankDesc ? ` — ${escapeHtml(w.rankDesc)}` : ""}</div>`;
    });
    inner += `</div>`;
  }

  inner += `<div class="reveal-players">`;
  payload.players.forEach(p => {
    inner += `<div class="reveal-player">
      <div class="reveal-name">${escapeHtml(p.name)} — ${fmt(p.chips)} chips ${p.folded ? "(folded)" : ""}</div>
      <div class="reveal-hand">${renderCardsHtml(p.hand || [], true)}</div>
    </div>`;
  });
  inner += `</div>`;

  contentEl.innerHTML = inner;

  // Visa overlay: använd inline style + hidden flag + klass (defensivt)
  overlay.style.display = "grid";
  overlay.hidden = false;
  overlay.classList.add("show");

  // Sätt en Fallback-timer som döljer overlay om servern av någon anledning inte gör det
  const FALLBACK_MS = 7000; // bör matcha serverns REVEAL_DELAY_MS (ungefär)
  setTimeout(() => {
    // Dölj endast om overlay fortfarande syns (annars låt server styra)
    if (!overlay.hidden) {
      overlay.hidden = true;
      overlay.classList.remove("show");
      overlay.style.display = "none";
      revealData = null;
    }
  }, FALLBACK_MS);
}

/**
 * hideRevealOverlayIfVisible()
 * - Döljer overlay om den är synlig (anropas t.ex. när ny gameUpdate anländer)
 */
function hideRevealOverlayIfVisible() {
  const overlay = $("#revealOverlay");
  if (!overlay) return;
  if (!overlay.hidden) {
    overlay.hidden = true;
    overlay.classList.remove("show");
    overlay.style.display = "none";
    revealData = null;
  }
}

/**
 * showOverlayMessage(msg)
 * - Visar overlay med ett enkelt meddelande (t.ex. gameOver)
 */
function showOverlayMessage(msg) {
  const overlay = $("#revealOverlay");
  if (!overlay) return;
  $("#revealTitle").textContent = msg || "Meddelande";
  $("#revealContent").innerHTML = `<div style="margin-top:1rem;color:#fff;">Spelet är över.</div>`;
  overlay.style.display = "grid";
  overlay.hidden = false;
  overlay.classList.add("show");
}

/* ==========================
   Utils / små hjälpfunktioner
   ========================== */

/**
 * toast(msg, type) - visar kort toast-meddelande
 * - type kan vara "" eller "error" (styling i CSS)
 */
function toast(msg, type = "") {
  const t = $("#toast");
  if (!t) {
    console.log("TOAST:", msg);
    return;
  }
  t.className = `toast ${type}`;
  t.textContent = msg;
  safeShow(t, true);
  setTimeout(() => safeShow(t, false), 2500);
}

/**
 * escapeHtml - enkel sanitiseringshjälp (undvik XSS i dynamisk HTML)
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ==========================
   Slut på fil
   ========================== */

/* NOTE:
 * - Den här klienten är designad för att fungera ihop med server.js som skickar
 *   publicLobbyState / gameUpdate / reveal enligt tidigare specifikationer.
 * - Om du vill ha loggning av inkommande payloads (för debugging), lägg till t.ex.:
 *     socket.on('gameUpdate', s => { console.debug('gameUpdate', s); renderGame(s); });
 * - Om overlay fortfarande visas vid load: kontrollera att du uppdaterat index.html
 *   så att #revealOverlay finns och att det inte finns någon separat winnerMessage med text.
 */

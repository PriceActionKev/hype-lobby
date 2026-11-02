// This page connects to the app and redraws the bars whenever votes change.
const segmentsElement = document.querySelector("#segments");
const totalElement = document.querySelector("#total-votes");
const connectionElement = document.querySelector("#connection");
const countdownElement = document.querySelector("#countdown");
const winnerScreen = document.querySelector("#winner-screen");

function connectToLobby() {
  // Use the same computer name and port as this page, but switch HTTP to WebSocket.
  const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${socketProtocol}//${window.location.host}/live`);

  socket.addEventListener("open", () => {
    connectionElement.textContent = "LIVE VOTE IN PROGRESS";
  });

  socket.addEventListener("message", (event) => {
    try {
      drawVotes(JSON.parse(event.data));
    } catch (error) {
      console.error("Could not read the latest vote totals:", error);
    }
  });

  socket.addEventListener("close", () => {
    connectionElement.textContent = "RECONNECTING…";
    // Try again after a short pause if the server restarts or briefly disconnects.
    window.setTimeout(connectToLobby, 2000);
  });

  socket.addEventListener("error", () => {
    connectionElement.textContent = "CONNECTING TO LOBBY";
  });
}

function drawVotes(state) {
  const segments = state.segments || [];
  const largestCount = Math.max(1, ...segments.map((segment) => segment.votes || 0));
  totalElement.textContent = state.totalVotes ?? 0;
  if (state.phase === "active") {
    connectionElement.textContent = "VOTE LIVE · CAST YOUR CHOICE";
    countdownElement.textContent = formatTime(state.secondsRemaining || 0);
  } else if (state.phase === "ended") {
    connectionElement.textContent = "VOTING CLOSED · WINNER REVEALED";
    countdownElement.textContent = "00:00";
  } else {
    connectionElement.textContent = "WAITING FOR THE STREAMER TO START";
    countdownElement.textContent = "--:--";
  }

  if (state.phase === "ended") {
    const winner = state.winner;
    document.querySelector("#winner-name").textContent = winner?.name || "No votes this round";
    document.querySelector("#winner-votes").textContent = winner
      ? `${winner.votes} ${winner.votes === 1 ? "vote" : "votes"}`
      : "The lobby is ready for another round!";
    document.querySelector("#winner-total").textContent = state.totalVotes ?? 0;
    document.querySelector("#winner-bits").textContent = state.bitsSpent ?? 0;
    document.querySelector("#winner-points").textContent = state.pointsSpent ?? 0;
    winnerScreen.classList.remove("hidden");
  } else {
    winnerScreen.classList.add("hidden");
  }

  segmentsElement.innerHTML = segments.map((segment) => {
    const votes = segment.votes || 0;
    const barWidth = Math.max(votes > 0 ? 4 : 0, (votes / largestCount) * 100);
    return `<article class="segment">
      <div class="segment-head">
        <span class="number">${escapeHtml(segment.id)}</span>
        <span class="name">${escapeHtml(segment.name)}</span>
        <span class="vote-count">${votes} ${votes === 1 ? "VOTE" : "VOTES"}</span>
      </div>
      <div class="track"><div class="bar" style="width:${barWidth}%"></div></div>
    </article>`;
  }).join("");
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Segment names are streamer-entered later, so show them as text, never HTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

connectToLobby();

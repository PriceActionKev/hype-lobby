const summaryElement = document.querySelector("#summary");

async function loadSummary() {
  try {
    const response = await fetch("/api/summary");
    const state = await response.json();
    if (state.phase === "active") {
      summaryElement.innerHTML = `<div class="waiting"><span class="spinner"></span><h2>Vote in progress</h2><p>Results will appear here when the countdown ends.</p><strong>${formatTime(state.secondsRemaining)} remaining</strong></div>`;
      window.setTimeout(loadSummary, 1000);
      return;
    }
    if (!state.lastSummary) {
      summaryElement.innerHTML = `<div class="waiting"><span class="waiting-star">✦</span><h2>No round completed yet</h2><p>Set up your segments and press Start Vote to begin.</p><a class="inline-link" href="/setup">Open setup →</a></div>`;
      return;
    }
    renderResults(state.lastSummary);
  } catch (error) {
    summaryElement.innerHTML = `<div class="waiting"><h2>Could not load the results</h2><p>${escapeHtml(error.message)}. Check that Hype Lobby is running and refresh this page.</p></div>`;
  }
}

function renderResults(state) {
  const maxVotes = Math.max(1, ...state.segments.map((segment) => segment.votes || 0));
  const rows = state.segments.map((segment) => {
    const votes = segment.votes || 0;
    const width = votes > 0 ? Math.max(3, votes / maxVotes * 100) : 0;
    const winnerClass = segment.id === state.winner?.id ? " result-row winner-row" : " result-row";
    return `<div class="${winnerClass}">
      <div class="result-label"><span>${escapeHtml(segment.name)}</span><strong>${votes}</strong></div>
      <div class="result-track"><div class="result-bar" style="width:${width}%"></div></div>
    </div>`;
  }).join("");

  summaryElement.innerHTML = `
    <div class="winner-banner"><span class="trophy">🏆</span><div><p class="winner-caption">WINNING SEGMENT</p><h2>${escapeHtml(state.winner?.name || "No votes this round")}</h2></div></div>
    <div class="totals-grid">
      <div class="metric"><strong>${state.totalVotes || 0}</strong><span>TOTAL VOTES</span></div>
      <div class="metric bits"><strong>${state.bitsSpent || 0}</strong><span>BITS SPENT</span></div>
      <div class="metric points"><strong>${state.pointsSpent || 0}</strong><span>POINTS SPENT</span></div>
    </div>
    <div class="vote-breakdown">
      <h3>Vote breakdown</h3>
      <div class="source-totals"><span>Free chat <strong>${state.totalFreeVotes || 0}</strong></span><span>Bits bonus <strong>${state.bitsVotes || 0}</strong></span><span>Points bonus <strong>${state.pointsVotes || 0}</strong></span></div>
      <div class="result-list">${rows}</div>
    </div>
  `;
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

loadSummary();

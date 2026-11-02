// Load saved settings from the server and fill in the form.
const form = document.querySelector("#setup-form");
const countSelect = document.querySelector("#segment-count");
const fieldsElement = document.querySelector("#segment-fields");
const countdownInput = document.querySelector("#countdown-seconds");
const messageElement = document.querySelector("#message");
const statusElement = document.querySelector("#round-status");
const saveButton = document.querySelector("#save-button");
const startButton = document.querySelector("#start-button");
let savedNames = [];
let isRoundActive = false;

function renderSegmentFields() {
  const count = Number(countSelect.value);
  fieldsElement.innerHTML = Array.from({ length: count }, (_unused, index) => `
    <label class="field segment-field">
      <span class="segment-number">${index + 1}</span>
      Segment ${index + 1} name
      <input class="segment-name" maxlength="40" required value="${escapeHtml(savedNames[index] || `Segment ${index + 1}`)}" placeholder="For example: Cozy Chat">
    </label>
  `).join("");
}

async function loadSetup() {
  try {
    const response = await fetch("/api/setup");
    const setup = await response.json();
    savedNames = (setup.segments || []).map((segment) => segment.name);
    countSelect.value = String(savedNames.length || 4);
    countdownInput.value = setup.countdownSeconds || 30;
    renderSegmentFields();
    await refreshRoundStatus();
  } catch (error) {
    showMessage(`Could not load setup: ${error.message}`, true);
  }
}

async function saveSetup() {
  const segments = [...document.querySelectorAll(".segment-name")].map((input) => input.value.trim());
  const countdownSeconds = Number(countdownInput.value);
  const response = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments, countdownSeconds })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not save setup.");
  savedNames = result.segments.map((segment) => segment.name);
  showMessage("Setup saved. You’re ready to start a vote!");
  return true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveSetup();
  } catch (error) {
    showMessage(error.message, true);
  }
});

countSelect.addEventListener("change", renderSegmentFields);

startButton.addEventListener("click", async () => {
  try {
    await saveSetup();
    const response = await fetch("/api/start-vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not start the vote.");
    showMessage("The vote is live! Your OBS overlay is counting down.");
    await refreshRoundStatus();
  } catch (error) {
    showMessage(error.message, true);
  }
});

async function refreshRoundStatus() {
  try {
    const response = await fetch("/api/state");
    const state = await response.json();
    isRoundActive = state.phase === "active";
    saveButton.disabled = isRoundActive;
    startButton.disabled = isRoundActive;
    if (isRoundActive) {
      statusElement.textContent = `Vote is live · ${state.secondsRemaining}s remaining`;
      statusElement.className = "round-status active";
    } else if (state.phase === "ended") {
      statusElement.textContent = state.winner
        ? `Last winner: ${state.winner.name} · Open the summary for results.`
        : "Last vote ended without votes · Ready for another round.";
      statusElement.className = "round-status ended";
    } else {
      statusElement.textContent = "Ready when you are · Save your segments, then start the vote.";
      statusElement.className = "round-status";
    }
  } catch {
    statusElement.textContent = "Could not check the vote status. Is the app running?";
    statusElement.className = "round-status error";
  }
}

function showMessage(text, isError = false) {
  messageElement.textContent = text;
  messageElement.className = isError ? "message error" : "message success";
}

// Names are typed by the streamer; escape them before inserting them in a field.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

loadSetup();
window.setInterval(refreshRoundStatus, 1000);

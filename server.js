// Hype Lobby's small Express server. Step 1 sets up Twitch login;
// later steps will add voting, EventSub, and the overlay.
import express from "express";
import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const app = express();
const server = createServer(app);
const overlaySockets = new WebSocketServer({ server, path: "/live" });
const port = Number(process.env.PORT || 3000);
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_REDIRECT_URI || "http://localhost:3000/auth/callback";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This prototype keeps login in memory. Restarting the app logs you out.
let twitchUser = null;
let accessToken = null;
let refreshToken = null;
let pendingState = null;
let eventSocket = null;
let eventSubStatus = "Not connected";
let eventSubWanted = false;
let eventReconnectTimer = null;
let eventReconnectAttempts = 0;

// Temporary choices for this step. The setup page will let the streamer rename
// these later; votes reset whenever this server is restarted.
const voteState = {
  segments: [
    { id: "1", name: "Segment 1" },
    { id: "2", name: "Segment 2" },
    { id: "3", name: "Segment 3" },
    { id: "4", name: "Segment 4" }
  ],
  freeVotesByUser: new Map(),
  bitsVotesBySegment: new Map(),
  pointsVotesBySegment: new Map(),
  bitsSpent: 0,
  pointsSpent: 0,
  processedChatMessageIds: new Set(),
  processedEventIds: new Set(),
  phase: "waiting",
  countdownSeconds: 30,
  secondsRemaining: 30,
  endsAt: null,
  winner: null,
  lastSummary: null,
  timer: null
};

// Scopes needed for chat, Bits, and channel point events in later steps.
const scopes = ["user:read:chat", "channel:bot", "bits:read", "channel:read:redemptions"];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Give OBS a short, friendly URL while the HTML file stays in public/.
app.get("/overlay", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "overlay.html"));
});

app.get("/setup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/summary", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "summary.html"));
});

// Each browser overlay gets the latest vote totals as soon as it connects.
overlaySockets.on("connection", (socket) => {
  socket.send(JSON.stringify(makeOverlayState()));
});

// A simple read-only view of the current vote totals, useful while testing.
app.get("/api/state", (_req, res) => {
  const counts = getVoteCounts();
  res.json({
    segments: voteState.segments.map((segment) => ({ ...segment, votes: counts[segment.id] || 0 })),
    totalFreeVotes: voteState.freeVotesByUser.size,
    totalVotes: Object.values(counts).reduce((sum, count) => sum + count, 0),
    bitsVotes: sumMapValues(voteState.bitsVotesBySegment),
    pointsVotes: sumMapValues(voteState.pointsVotesBySegment),
    bitsSpent: voteState.bitsSpent,
    pointsSpent: voteState.pointsSpent,
    phase: voteState.phase,
    countdownSeconds: voteState.countdownSeconds,
    secondsRemaining: getSecondsRemaining(),
    winner: voteState.winner
  });
});

app.get("/api/summary", (_req, res) => {
  res.json({
    phase: voteState.phase,
    secondsRemaining: getSecondsRemaining(),
    lastSummary: voteState.lastSummary
  });
});

app.get("/api/setup", (_req, res) => {
  res.json({ segments: voteState.segments, countdownSeconds: voteState.countdownSeconds });
});

app.post("/api/setup", (req, res) => {
  if (voteState.phase === "active") {
    return res.status(409).json({ error: "Wait for the current vote to finish before changing setup." });
  }

  const names = req.body?.segments;
  const seconds = Number(req.body?.countdownSeconds);
  if (!Array.isArray(names) || names.length < 3 || names.length > 4) {
    return res.status(400).json({ error: "Choose 3 or 4 segments." });
  }
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    return res.status(400).json({ error: "Countdown must be a whole number from 5 to 3600 seconds." });
  }
  const cleanNames = names.map((name) => String(name).trim());
  if (cleanNames.some((name) => !name || name.length > 40)) {
    return res.status(400).json({ error: "Each segment needs a name from 1 to 40 characters." });
  }

  voteState.segments = cleanNames.map((name, index) => ({ id: String(index + 1), name }));
  voteState.countdownSeconds = seconds;
  voteState.secondsRemaining = seconds;
  voteState.winner = null;
  broadcastOverlayState();
  res.json({ ok: true, segments: voteState.segments, countdownSeconds: seconds });
});

// The setup page uses this endpoint after saving the streamer's settings.
app.post("/api/start-vote", (req, res) => {
  if (voteState.phase === "active") {
    return res.status(409).json({ error: "A vote is already running.", state: makeOverlayState() });
  }

  const seconds = Number(req.body?.seconds ?? voteState.countdownSeconds);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    return res.status(400).json({ error: "Countdown must be a whole number from 5 to 3600 seconds." });
  }

  startVote(seconds);
  res.json({ ok: true, state: makeOverlayState() });
});

// This lets you demo free chat votes while the Twitch CLI mock server is active.
// It is deliberately unavailable when the app is connected to real Twitch.
app.post("/api/test-vote", (req, res) => {
  if (!isLocalMockEventSub()) {
    return res.status(404).json({ error: "Test votes are only enabled with the local Twitch CLI mock server." });
  }
  if (voteState.phase !== "active") {
    return res.status(409).json({ error: "Start the countdown before sending test votes." });
  }

  const messageText = String(req.body?.message || "").trim();
  const command = messageText.match(/^!vote\s+(\d+)$/i);
  if (!command) return res.status(400).json({ error: "Send a message like !vote 2." });

  const segment = voteState.segments.find((item) => item.id === command[1]);
  if (!segment) return res.status(400).json({ error: `Choose a segment number from 1 to ${voteState.segments.length}.` });

  const viewerName = String(req.body?.viewer || "Mock Viewer").slice(0, 40);
  countFreeVote({
    message_id: `mock-${randomBytes(12).toString("hex")}`,
    chatter_user_id: `mock-test-${viewerName.toLowerCase()}`,
    chatter_user_name: viewerName,
    message: { text: messageText }
  });
  res.json({ ok: true, state: makeOverlayState() });
});

app.get("/", (_req, res) => {
  const loginArea = twitchUser
    ? `<p>Connected as <strong>${escapeHtml(twitchUser.login)}</strong>.</p>
       <p>EventSub: <strong>${escapeHtml(eventSubStatus)}</strong></p>
       <form action="/eventsub/connect" method="post"><button>Connect to Twitch events</button></form>
       <form action="/eventsub/disconnect" method="post"><button class="secondary">Disconnect chat events</button></form>
       <form action="/auth/logout" method="post"><button class="secondary">Disconnect Twitch</button></form>`
    : `<p>Connect Twitch to authorize Hype Lobby.</p><a class="button" href="/auth/twitch">Connect with Twitch</a>`;

  res.type("html").send(`<!doctype html>
    <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hype Lobby setup</title>
    <style>body{font:18px system-ui;background:#101326;color:#fff;max-width:650px;margin:12vh auto;padding:24px}a.button,button{display:inline-block;background:#ff4fd8;color:#101326;border:0;border-radius:12px;padding:14px 20px;margin:4px 0;font-weight:700;font-size:17px;text-decoration:none;cursor:pointer}.secondary{background:#333954;color:#fff}</style>
    <h1>🎉 Hype Lobby</h1><p>This is the project setup and Twitch login check.</p>${loginArea}
    <p><a href="/setup">Open streamer setup</a> · <a href="/overlay">Preview overlay</a> · <a href="/summary">View summary</a></p></html>`);
});

app.get("/auth/twitch", (_req, res) => {
  if (!clientId || clientId === "put_your_client_id_here" || !clientSecret || clientSecret === "put_your_client_secret_here") {
    return res.status(500).type("text").send("Add your Twitch Client ID and Client Secret to the .env file, then restart the app.");
  }

  // Twitch sends this random value back after login; matching it prevents forged callbacks.
  pendingState = randomBytes(24).toString("hex");
  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: pendingState
  }).toString();
  res.redirect(authorizeUrl.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return res.status(400).type("text").send(`Twitch login was not approved: ${errorDescription || error}`);
  if (!code || !state || !pendingState || state !== pendingState) {
    pendingState = null;
    return res.status(400).type("text").send("Login could not be verified. Go back and try Connect with Twitch again.");
  }
  pendingState = null;

  try {
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Twitch token exchange failed:", tokenData);
      return res.status(502).type("text").send("Twitch did not complete login. Check your app settings and try again.");
    }

    accessToken = tokenData.access_token;
    refreshToken = tokenData.refresh_token || null;
    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${accessToken}` }
    });
    const validation = await validateResponse.json();
    if (!validateResponse.ok || validation.client_id !== clientId) {
      accessToken = null;
      refreshToken = null;
      return res.status(502).type("text").send("Twitch returned a token that could not be verified. Please try again.");
    }
    twitchUser = { login: validation.login, id: validation.user_id };
    console.log(`Twitch login connected: ${twitchUser.login}`);
    res.redirect("/");
  } catch (error) {
    console.error("Could not finish Twitch login:", error.message);
    res.status(502).type("text").send("Could not reach Twitch to finish login. Check your internet connection and try again.");
  }
});

app.post("/auth/logout", (_req, res) => {
  stopEventSub();
  twitchUser = null;
  accessToken = null;
  refreshToken = null;
  res.redirect("/");
});

// Open EventSub, then subscribe as soon as Twitch sends the welcome message.
app.post("/eventsub/connect", (_req, res) => {
  if (!accessToken || !twitchUser) return res.status(401).type("text").send("Connect with Twitch first, then try connecting to chat events.");
  if (eventSocket?.readyState === WebSocket.OPEN || eventSocket?.readyState === WebSocket.CONNECTING) {
    return res.redirect("/");
  }
  eventSubWanted = true;
  startEventSub().catch((error) => {
    console.error("Could not start EventSub:", error.message);
    eventSubStatus = "Connection failed — check the terminal";
  });
  res.redirect("/");
});

app.post("/eventsub/disconnect", (_req, res) => {
  stopEventSub();
  eventSubStatus = "Not connected";
  res.redirect("/");
});

async function startEventSub() {
  const url = process.env.EVENTSUB_WEBSOCKET_URL || "wss://eventsub.wss.twitch.tv/ws";
  return connectEventSub(url);
}

async function connectEventSub(url, options = {}) {
  eventSubStatus = "Connecting…";
  console.log(`Connecting to EventSub WebSocket: ${url}`);
  // ws automatically answers WebSocket protocol Ping frames with Pong frames.
  const socket = new WebSocket(url, { autoPong: true });
  eventSocket = socket;
  let watchdogTimer = null;
  let keepaliveTimeoutSeconds = 30;
  const resetWatchdog = () => {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (eventSocket === socket && eventSubWanted) {
        console.warn("No EventSub message arrived before the keepalive timeout. Reconnecting automatically…");
        socket.terminate();
      }
    }, (keepaliveTimeoutSeconds + 5) * 1000);
  };

  socket.on("open", () => console.log("EventSub WebSocket opened; waiting for Twitch welcome message…"));
  socket.on("message", async (rawMessage) => {
    resetWatchdog();
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      console.error("EventSub sent a message that was not valid JSON.");
      return;
    }

    const messageType = message.metadata?.message_type;
    if (messageType === "session_welcome") {
      const sessionId = message.payload?.session?.id;
      if (!sessionId) {
        eventSubStatus = "Connected, but Twitch did not send a session ID";
        return;
      }
      try {
        keepaliveTimeoutSeconds = Number(message.payload?.session?.keepalive_timeout_seconds || 30);
        console.log(`EventSub connected with session ${sessionId}.`);
        if (!options.preserveSubscriptions) await subscribeToEvents(sessionId);
        if (options.oldSocket && options.oldSocket.readyState === WebSocket.OPEN) {
          options.oldSocket.close(1000, "EventSub session migrated");
        }
        eventReconnectAttempts = 0;
        eventSubStatus = isLocalMockEventSub()
          ? "Mock mode: listening for Bits and point events"
          : "Listening for chat, Bits, and point events";
      } catch (error) {
        eventSubStatus = "Subscription failed — check the terminal";
        console.error("Could not subscribe to EventSub events:", error.message);
        socket.close(1011, "Subscription failed");
      }
    } else if (messageType === "session_keepalive") {
      // Text keepalive messages need no reply. The ws library handles Ping/Pong frames.
    } else if (messageType === "session_reconnect") {
      console.log("Twitch requested a reconnect. Reconnecting to the supplied address…");
      const reconnectUrl = message.payload?.session?.reconnect_url;
      if (reconnectUrl) connectEventSub(reconnectUrl, { preserveSubscriptions: true, oldSocket: socket });
      else socket.terminate();
    } else if (messageType === "revocation") {
      console.error("Twitch disabled an EventSub subscription:", message.payload?.subscription?.status);
    } else if (messageType === "notification") {
      handleEventSubNotification(message);
    }
  });

  socket.on("error", (error) => {
    eventSubStatus = "Connection error — check the terminal";
    console.error("EventSub WebSocket error:", error.message);
    if (eventSubWanted && eventSocket === socket) socket.terminate();
  });
  socket.on("close", (code) => {
    clearTimeout(watchdogTimer);
    if (eventSocket === socket) {
      eventSocket = null;
      if (eventSubWanted) scheduleEventSubReconnect(`connection closed (${code})`);
    }
  });
}

function scheduleEventSubReconnect(reason) {
  if (!eventSubWanted || eventReconnectTimer) return;
  const delayMs = Math.min(1000 * (2 ** eventReconnectAttempts), 30000);
  eventReconnectAttempts += 1;
  eventSubStatus = `Disconnected — retrying in ${Math.ceil(delayMs / 1000)}s`;
  console.log(`EventSub ${reason}. Retrying in ${Math.ceil(delayMs / 1000)} seconds…`);
  eventReconnectTimer = setTimeout(() => {
    eventReconnectTimer = null;
    startEventSub().catch((error) => {
      console.error("Automatic EventSub reconnect failed:", error.message);
      scheduleEventSubReconnect("could not start a connection");
    });
  }, delayMs);
}

async function subscribeToEvents(sessionId) {
  const broadcaster = { broadcaster_user_id: twitchUser.id };
  if (isLocalMockEventSub()) {
    console.log("Local Twitch CLI mock detected; skipping channel.chat.message because the CLI does not support it.");
  } else {
    await createEventSubSubscription("channel.chat.message", { ...broadcaster, user_id: twitchUser.id }, sessionId);
  }
  await createEventSubSubscription("channel.cheer", broadcaster, sessionId);
  await createEventSubSubscription("channel.channel_points_custom_reward_redemption.add", broadcaster, sessionId);
  console.log(isLocalMockEventSub()
    ? "Subscribed to mock Bits cheers and channel point redemptions."
    : "Subscribed to chat, Bits cheers, and channel point redemptions.");
}

async function createEventSubSubscription(type, condition, sessionId) {
  const subscriptionsUrl = process.env.EVENTSUB_SUBSCRIPTIONS_URL || "https://api.twitch.tv/helix/eventsub/subscriptions";
  const sendRequest = () => fetch(subscriptionsUrl, {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type,
      version: "1",
      condition,
      transport: { method: "websocket", session_id: sessionId }
    })
  });
  let response = await sendRequest();
  // Refresh an expired access token once, so a reconnect can work after a long stream.
  if (response.status === 401 && refreshToken) {
    await refreshTwitchAccessToken();
    response = await sendRequest();
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result.message || result.error || `HTTP ${response.status}`;
    throw new Error(`${type}: ${reason}. Confirm the Twitch app has user:read:chat, bits:read, channel:read:redemptions, and channel:bot permissions; if you just added a permission, reconnect with Twitch.`);
  }
}

async function refreshTwitchAccessToken() {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    throw new Error(`Twitch could not refresh the login token (${result.message || response.status}). Disconnect and reconnect Twitch on the home page.`);
  }
  accessToken = result.access_token;
  refreshToken = result.refresh_token || refreshToken;
  console.log("Twitch login token refreshed for the EventSub reconnect.");
}

function handleEventSubNotification(message) {
  const eventId = message.metadata?.message_id;
  if (eventId && voteState.processedEventIds.has(eventId)) return;
  if (eventId) {
    voteState.processedEventIds.add(eventId);
    if (voteState.processedEventIds.size > 2000) {
      voteState.processedEventIds.delete(voteState.processedEventIds.values().next().value);
    }
  }

  const event = message.payload?.event;
  const type = message.metadata?.subscription_type;
  if (!event) return;

  if (type === "channel.chat.message") {
    console.log(`[CHAT] ${event.chatter_user_name || "Someone"}: ${event.message?.text ?? ""}`);
    countFreeVote(event);
  } else if (type === "channel.cheer") {
    countPaidVote({
      source: "bits",
      amount: Number(event.bits || 0),
      choiceTexts: [event.message || ""],
      name: event.user_name || "Anonymous viewer"
    });
  } else if (type === "channel.channel_points_custom_reward_redemption.add") {
    countPaidVote({
      source: "points",
      amount: Number(event.reward?.cost || 0),
      // Prefer a valid viewer choice, then look for a segment number in the
      // reward title (for example, "Vote 2").
      choiceTexts: [event.user_input || "", event.reward?.title || ""],
      name: event.user_name || "Viewer"
    });
  }
}

function countPaidVote({ source, amount, choiceTexts, name }) {
  if (voteState.phase !== "active") return;

  // Twitch CLI's generated cheer does not include a viewer-written message.
  // A local-only default makes that mock event useful for testing the vote path.
  const choices = choiceTexts.map(parseVoteChoice);
  let selectedSegment = choices
    .map((choice) => voteState.segments.find((segment) => segment.id === choice))
    .find(Boolean);

  // Some reward titles include extra words, so also find a number in the title
  // after checking the viewer's input.
  if (!selectedSegment && source === "points") {
    const titleChoice = parseTitleVoteChoice(choiceTexts[1]);
    selectedSegment = voteState.segments.find((segment) => segment.id === titleChoice);
  }

  // CLI generated events do not always contain a usable choice. Use the
  // configured fallback only while connected to a local mock WebSocket.
  if (!selectedSegment && isLocalMockEventSub()) {
    selectedSegment = voteState.segments.find((segment) => segment.id === process.env.MOCK_DEFAULT_SEGMENT);
  }

  if (!selectedSegment || !Number.isFinite(amount) || amount <= 0) {
    console.log(`[VOTE] ${name}'s ${source === "bits" ? "cheer" : "point redemption"} needs a valid segment choice.`);
    return;
  }

  // Every 100 Bits or points adds a vote; a valid cheer/redemption always
  // counts for at least one vote. These are easy to tune for a real channel.
  const weight = Math.max(1, Math.floor(amount / 100));
  const votesBySegment = source === "bits" ? voteState.bitsVotesBySegment : voteState.pointsVotesBySegment;
  votesBySegment.set(selectedSegment.id, (votesBySegment.get(selectedSegment.id) || 0) + weight);
  if (source === "bits") voteState.bitsSpent += amount;
  else voteState.pointsSpent += amount;

  console.log(`[VOTE] ${name} added ${weight} ${source === "bits" ? "Bits" : "points"} vote${weight === 1 ? "" : "s"} for ${selectedSegment.name}.`);
  broadcastOverlayState();
}

function parseVoteChoice(text) {
  // Cheers include !vote N in the cheer message. For a point reward's text
  // input, viewers can enter either just N or !vote N.
  const cleanText = String(text).trim();
  const command = cleanText.match(/(?:^|\s)!vote\s+(\d+)(?:\s|$)/i);
  const bareNumber = cleanText.match(/^(\d+)$/);
  const namedChoice = cleanText.match(/\b(?:vote|segment)\s*#?\s*(\d+)\b/i);
  return command?.[1] || bareNumber?.[1] || namedChoice?.[1] || null;
}

function parseTitleVoteChoice(text) {
  const title = String(text || "");
  const explicitChoice = title.match(/\b(?:vote|segment)\s*#?\s*(\d+)\b/i);
  const anyNumber = title.match(/(?:^|\D)(\d+)(?:\D|$)/);
  return explicitChoice?.[1] || anyNumber?.[1] || null;
}

function isLocalMockEventSub() {
  try {
    const url = new URL(process.env.EVENTSUB_WEBSOCKET_URL || "");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function stopEventSub() {
  eventSubWanted = false;
  if (eventReconnectTimer) clearTimeout(eventReconnectTimer);
  eventReconnectTimer = null;
  eventReconnectAttempts = 0;
  if (eventSocket) {
    eventSocket.close(1000, "Stopped by user");
    eventSocket = null;
  }
}

function countFreeVote(event) {
  if (voteState.phase !== "active") return;
  const messageId = event.message_id;
  if (messageId && voteState.processedChatMessageIds.has(messageId)) return;

  const messageText = event.message?.text?.trim() ?? "";
  const command = messageText.match(/^!vote\s+(\d+)$/i);
  if (!command) return;

  if (messageId) {
    voteState.processedChatMessageIds.add(messageId);
    // Avoid letting this tiny beginner prototype keep an unlimited ID list.
    if (voteState.processedChatMessageIds.size > 2000) {
      const oldestId = voteState.processedChatMessageIds.values().next().value;
      voteState.processedChatMessageIds.delete(oldestId);
    }
  }

  const choice = command[1];
  const selectedSegment = voteState.segments.find((segment) => segment.id === choice);
  if (!selectedSegment) {
    console.log(`[VOTE] ${event.chatter_user_name || "Someone"}: choose a number from 1 to ${voteState.segments.length}.`);
    return;
  }

  const chatterId = event.chatter_user_id || event.chatter_user_login || event.chatter_user_name;
  if (!chatterId) {
    console.log("[VOTE] Could not identify the chatter, so this vote was skipped.");
    return;
  }

  const previousChoice = voteState.freeVotesByUser.get(chatterId);
  if (previousChoice === selectedSegment.id) {
    console.log(`[VOTE] ${event.chatter_user_name || "Someone"} already voted for ${selectedSegment.name}. No extra vote added.`);
    return;
  }

  // Setting the user's choice replaces their earlier choice, so one chatter
  // can only contribute one free vote at a time.
  voteState.freeVotesByUser.set(chatterId, selectedSegment.id);
  const counts = getVoteCounts();
  const tally = voteState.segments.map((segment) => `${segment.name}: ${counts[segment.id] || 0}`).join(" | ");
  const changed = previousChoice ? " changed their vote to " : " voted for ";
  console.log(`[VOTE] ${event.chatter_user_name || "Someone"}${changed}${selectedSegment.name}. ${tally}`);
  broadcastOverlayState();
}

function getVoteCounts() {
  const counts = Object.fromEntries(voteState.segments.map((segment) => [segment.id, 0]));
  for (const segmentId of voteState.freeVotesByUser.values()) counts[segmentId] += 1;
  for (const [segmentId, votes] of voteState.bitsVotesBySegment) counts[segmentId] += votes;
  for (const [segmentId, votes] of voteState.pointsVotesBySegment) counts[segmentId] += votes;
  return counts;
}

function sumMapValues(valuesBySegment) {
  let total = 0;
  for (const value of valuesBySegment.values()) total += value;
  return total;
}

function startVote(seconds) {
  clearInterval(voteState.timer);
  voteState.freeVotesByUser.clear();
  voteState.bitsVotesBySegment.clear();
  voteState.pointsVotesBySegment.clear();
  voteState.bitsSpent = 0;
  voteState.pointsSpent = 0;
  voteState.processedChatMessageIds.clear();
  voteState.processedEventIds.clear();
  voteState.phase = "active";
  voteState.countdownSeconds = seconds;
  voteState.secondsRemaining = seconds;
  voteState.endsAt = Date.now() + seconds * 1000;
  voteState.winner = null;
  broadcastOverlayState();
  console.log(`Vote started. The countdown is ${seconds} seconds.`);

  voteState.timer = setInterval(() => {
    voteState.secondsRemaining = getSecondsRemaining();
    if (voteState.secondsRemaining <= 0) {
      finishVote();
    } else {
      broadcastOverlayState();
    }
  }, 250);
}

function getSecondsRemaining() {
  if (voteState.phase !== "active" || !voteState.endsAt) return voteState.secondsRemaining;
  return Math.max(0, Math.ceil((voteState.endsAt - Date.now()) / 1000));
}

function finishVote() {
  if (voteState.phase !== "active") return;
  clearInterval(voteState.timer);
  voteState.timer = null;
  voteState.secondsRemaining = 0;
  voteState.phase = "ended";

  const counts = getVoteCounts();
  const highestCount = Math.max(0, ...Object.values(counts));
  // If two choices tie, the first one in the streamer's segment list wins.
  const winningSegment = highestCount > 0
    ? voteState.segments.find((segment) => counts[segment.id] === highestCount)
    : null;
  voteState.winner = winningSegment
    ? { ...winningSegment, votes: highestCount }
    : null;
  voteState.lastSummary = {
    winner: voteState.winner,
    segments: voteState.segments.map((segment) => ({ ...segment, votes: counts[segment.id] || 0 })),
    totalVotes: Object.values(counts).reduce((sum, count) => sum + count, 0),
    freeVotes: voteState.freeVotesByUser.size,
    bitsVotes: sumMapValues(voteState.bitsVotesBySegment),
    pointsVotes: sumMapValues(voteState.pointsVotesBySegment),
    bitsSpent: voteState.bitsSpent,
    pointsSpent: voteState.pointsSpent
  };
  console.log(voteState.winner
    ? `Voting closed. ${voteState.winner.name} wins with ${highestCount} votes!`
    : "Voting closed with no votes.");
  broadcastOverlayState();
}

function makeOverlayState() {
  const counts = getVoteCounts();
  const segments = voteState.segments.map((segment) => ({
    ...segment,
    votes: counts[segment.id] || 0
  }));
  return {
    type: "vote-state",
    segments,
    totalVotes: Object.values(counts).reduce((sum, count) => sum + count, 0),
    bitsSpent: voteState.bitsSpent,
    pointsSpent: voteState.pointsSpent,
    phase: voteState.phase,
    countdownSeconds: voteState.countdownSeconds,
    secondsRemaining: getSecondsRemaining(),
    winner: voteState.winner
  };
}

function broadcastOverlayState() {
  const message = JSON.stringify(makeOverlayState());
  for (const socket of overlaySockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

server.listen(port, () => {
  console.log(`Hype Lobby is running at http://localhost:${port}`);
  console.log("Open that address in your browser to check the setup page.");
});

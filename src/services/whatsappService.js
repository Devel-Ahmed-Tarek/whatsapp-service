if (process.env.MOCK_WHATSAPP === "1" || process.env.MOCK_WHATSAPP === "true") {
  module.exports = require("./whatsappServiceMock");
  return;
}

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const sessions = {};
const DEFAULT_SESSION_ID = "default";

function cleanSessionLock(sessionId) {
  const sessionPath = path.join(process.cwd(), ".wwebjs_auth", `session-${sessionId}`);
  const filesToCleanup = ["lockfile", "SingletonLock", "DevToolsActivePort"];

  filesToCleanup.forEach((file) => {
    const filePath = path.join(sessionPath, file);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`[Session: ${sessionId}] Cleaned up lock file: ${file}`);
      } catch (err) {
        // Ignore errors if file is actually in use
      }
    }
  });
}

function createSession(sessionId) {
  // Clean up any stale lock files before creating a new session
  cleanSessionLock(sessionId);

  const state = {
    clientReady: false,
    latestQR: null,
    client: null,
  };

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  state.client = client;

  client.on("qr", async (qr) => {
    state.latestQR = qr;
    console.log(`[Session: ${sessionId}] QR Received, scan it with your phone:`);
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on("ready", () => {
    state.clientReady = true;
    state.latestQR = null;
    console.log(`[Session: ${sessionId}] Client is ready!`);
  });

  client.on("disconnected", (reason) => {
    state.clientReady = false;
    state.latestQR = null;
    console.log(`[Session: ${sessionId}] Client disconnected:`, reason);
  });

  console.log(`[Session: ${sessionId}] Initializing client...`);
  client.initialize().catch((err) => {
    console.error(`[Session: ${sessionId}] Initialization error:`, err);
  });

  sessions[sessionId] = state;

  return state;
}

function getOrCreateSession(sessionId) {
  const id = sessionId || DEFAULT_SESSION_ID;
  if (!sessions[id]) {
    return createSession(id);
  }
  return sessions[id];
}

function getSessionState(sessionId) {
  const id = sessionId || DEFAULT_SESSION_ID;
  return sessions[id] || null;
}

async function destroySession(sessionId) {
  const id = sessionId || DEFAULT_SESSION_ID;
  const state = sessions[id];
  if (!state) {
    return { destroyed: false, reason: "session not found" };
  }
  try {
    if (state.client) {
      await state.client.destroy();
    }
  } catch (err) {
    // Keep removing session even if destroy fails
  } finally {
    delete sessions[id];
  }
  return { destroyed: true };
}

function getAllSessions() {
  return Object.entries(sessions).map(([id, state]) => ({
    sessionId: id,
    ready: Boolean(state.clientReady),
    hasQr: Boolean(state.latestQR),
  }));
}

async function destroyAllSessions() {
  const ids = Object.keys(sessions);
  for (const id of ids) {
    await destroySession(id);
  }
}

module.exports = {
  getOrCreateSession,
  getSessionState,
  destroySession,
  destroyAllSessions,
  getAllSessions,
  DEFAULT_SESSION_ID,
};

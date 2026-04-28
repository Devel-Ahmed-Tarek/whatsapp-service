if (process.env.MOCK_WHATSAPP === "1" || process.env.MOCK_WHATSAPP === "true") {
  module.exports = require("./whatsappServiceMock");
  return;
}

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { notifyIncomingMessage } = require("./incomingWebhook");

const sessions = {};
const DEFAULT_SESSION_ID = "default";

/** يمنع تشغيل أكثر من initialize() لكروم في نفس الوقت (يخفف البطء لو عدة sessionIds معاً). */
let browserInitChain = Promise.resolve();

function runWhenPreviousInitDone(fn) {
  const serialize =
    process.env.WHATSAPP_SERIALIZE_BROWSER_INIT === "1" ||
    process.env.WHATSAPP_SERIALIZE_BROWSER_INIT === "true";
  if (!serialize) {
    return fn();
  }
  const next = browserInitChain.then(fn, fn);
  browserInitChain = next.catch(() => {});
  return next;
}

function sessionAuthDir(sessionId) {
  return path.join(process.cwd(), ".wwebjs_auth", `session-${sessionId}`);
}

/** يحذف مجلد الجلسة على القرص (نفس مسار LocalAuth). آمن بعد فشل التهيئة أو عند طلب حذف الجلسة. */
function removeSessionAuthDir(sessionId) {
  const dir = sessionAuthDir(sessionId);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Session: ${sessionId}] Removed auth folder`);
  } catch (err) {
    console.warn(`[Session: ${sessionId}] Could not remove auth folder:`, err.message);
  }
}

function buildPuppeteerOptions() {
  const args = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (process.env.PUPPETEER_DISABLE_DEV_SHM === "1" || process.env.PUPPETEER_DISABLE_DEV_SHM === "true") {
    args.push("--disable-dev-shm-usage");
  }
  const extra = process.env.PUPPETEER_EXTRA_ARGS;
  if (extra && String(extra).trim()) {
    args.push(...String(extra).trim().split(/\s+/).filter(Boolean));
  }
  const opts = { headless: true, args };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return opts;
}

function cleanSessionLock(sessionId) {
  const sessionPath = sessionAuthDir(sessionId);
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
    initError: null,
  };

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: buildPuppeteerOptions(),
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

  client.on("message", (msg) => {
    notifyIncomingMessage(sessionId, msg, client);
  });

  console.log(`[Session: ${sessionId}] Initializing client...`);
  runWhenPreviousInitDone(() =>
    client.initialize().catch(async (err) => {
      console.error(`[Session: ${sessionId}] Initialization error:`, err);
      state.initError = err.message || String(err);
      try {
        await client.destroy();
      } catch (e) {
        // ignore
      }
      removeSessionAuthDir(sessionId);
      if (sessions[sessionId] === state) {
        delete sessions[sessionId];
      }
    })
  );

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

async function destroySession(sessionId, options = {}) {
  const purgeAuth = options.purgeAuth === true;
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
    if (purgeAuth) {
      removeSessionAuthDir(id);
    }
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

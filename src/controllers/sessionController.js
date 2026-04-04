const whatsappService = require("../services/whatsappService");
const QRCode = require("qrcode");

// أقصى وقت يظل فيه طلب HTTP واحد مفتوحاً — تجنب تأخير العميل الخارجي (بروكسي، موبايل، إلخ)
const QR_HTTP_WAIT_MS = Number(process.env.QR_HTTP_WAIT_MS) || 15000;
// وضع longPoll=1 في الاستعلام يعيد سلوك الانتظار الطويل (أو عبر QR_LONG_POLL_MS)
const QR_LONG_POLL_MS = Number(process.env.QR_LONG_POLL_MS) || Number(process.env.QR_WAIT_TIMEOUT_MS) || 120000;
const QR_POLL_INTERVAL_MS = 400;

function waitForFirstQr(state, maxWaitMs) {
  return new Promise((resolve) => {
    if (state.clientReady || state.latestQR) {
      resolve();
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    const t = setInterval(() => {
      if (state.clientReady || state.latestQR) {
        clearInterval(t);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(t);
        resolve();
      }
    }, QR_POLL_INTERVAL_MS);
  });
}

async function listSessions(req, res) {
  const sessions = whatsappService.getAllSessions();
  res.json({ count: sessions.length, sessions });
}

async function getQrCode(req, res) {
  const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
  const state = whatsappService.getOrCreateSession(sessionId);

  const useLongPoll =
    req.query.longPoll === "1" ||
    req.query.longPoll === "true" ||
    req.query.sync === "1";
  const httpWaitMs = useLongPoll ? QR_LONG_POLL_MS : QR_HTTP_WAIT_MS;

  if (state.clientReady) {
    return res.json({
      sessionId,
      ready: true,
      message: "Client is already ready",
    });
  }

  if (!state.latestQR) {
    await waitForFirstQr(state, httpWaitMs);
  }

  if (state.clientReady) {
    return res.json({
      sessionId,
      ready: true,
      message: "Client is already ready",
    });
  }

  if (state.initError) {
    return res.status(503).json({
      sessionId,
      ready: false,
      error: "WhatsApp client failed to start",
      details: state.initError,
    });
  }

  if (!state.latestQR) {
    const pollAfterMs = Math.min(5000, Math.max(2000, Math.floor(QR_HTTP_WAIT_MS / 3)));
    return res.json({
      sessionId,
      ready: false,
      initializing: true,
      message:
        "Session is still starting. Call GET /qr again (or poll GET /session-status until hasQr is true).",
      pollAfterMs,
      waitedMs: httpWaitMs,
      longPollHint: "Add ?longPoll=1 to wait longer in a single request (not recommended for public APIs).",
    });
  }

  try {
    const qrImage = await QRCode.toDataURL(state.latestQR);
    res.json({
      sessionId,
      ready: false,
      qr: state.latestQR,
      qrImage,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR image" });
  }
}

async function getStatus(req, res) {
  const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
  const state = whatsappService.getSessionState(sessionId);

  res.json({
    sessionId,
    exists: Boolean(state),
    ready: Boolean(state && state.clientReady),
    hasQr: Boolean(state && state.latestQR),
    initError: state && state.initError ? state.initError : null,
  });
}

async function deleteSession(req, res) {
  try {
    const sessionId = req.query.sessionId || req.body.sessionId || whatsappService.DEFAULT_SESSION_ID;
    const result = await whatsappService.destroySession(sessionId, { purgeAuth: true });
    if (!result.destroyed) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    res.json({ sessionId, success: true, message: "Session disconnected and removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listSessions,
  getQrCode,
  getStatus,
  deleteSession,
};

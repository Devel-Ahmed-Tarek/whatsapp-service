const whatsappService = require("../services/whatsappService");
const QRCode = require("qrcode");

const QR_WAIT_TIMEOUT_MS = 28000; // انتظار أقصاه ~28 ثانية لظهور أول QR
const QR_POLL_INTERVAL_MS = 400;

function waitForFirstQr(state) {
  return new Promise((resolve) => {
    if (state.clientReady || state.latestQR) {
      resolve();
      return;
    }
    const deadline = Date.now() + QR_WAIT_TIMEOUT_MS;
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

  if (state.clientReady) {
    return res.json({
      sessionId,
      ready: true,
      message: "Client is already ready",
    });
  }

  if (!state.latestQR) {
    await waitForFirstQr(state);
  }

  if (state.clientReady) {
    return res.json({
      sessionId,
      ready: true,
      message: "Client is already ready",
    });
  }

  if (!state.latestQR) {
    return res.json({
      sessionId,
      ready: false,
      message: "QR not generated yet. Try again in a few seconds.",
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
  });
}

async function deleteSession(req, res) {
  try {
    const sessionId = req.query.sessionId || req.body.sessionId || whatsappService.DEFAULT_SESSION_ID;
    const result = await whatsappService.destroySession(sessionId);
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

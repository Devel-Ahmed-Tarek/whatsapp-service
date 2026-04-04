const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEDUPE_MAX = 5000;
const notifiedKeys = new Set();
const notifiedQueue = [];

function isWebhookEnabled() {
  const v = process.env.WHATSAPP_WEBHOOK_ENABLED;
  if (v === "0" || v === "false" || v === "off") {
    return false;
  }
  return true;
}

function getIncomingWebhookUrl() {
  return (
    process.env.WHATSAPP_INCOMING_WEBHOOK_URL ||
    process.env.INCOMING_WEBHOOK_URL ||
    ""
  ).trim();
}

function alreadySentThisMessage(sessionId, msg) {
  const id = msg.id?._serialized ?? msg.id?.id ?? String(msg.id);
  const key = `${sessionId}:${id}`;
  if (notifiedKeys.has(key)) {
    return true;
  }
  notifiedKeys.add(key);
  notifiedQueue.push(key);
  while (notifiedQueue.length > DEDUPE_MAX) {
    const old = notifiedQueue.shift();
    notifiedKeys.delete(old);
  }
  return false;
}

function serializeMessageForWebhook(msg, sessionId) {
  const id = msg.id?._serialized ?? msg.id?.id ?? String(msg.id);
  return {
    sessionId,
    messageId: id,
    from: msg.from ?? null,
    to: msg.to ?? null,
    body: msg.body ?? "",
    type: msg.type ?? "chat",
    timestamp: msg.timestamp ?? null,
    hasMedia: Boolean(msg.hasMedia),
    author: msg.author ?? null,
    fromMe: Boolean(msg.fromMe),
    isForwarded: Boolean(msg.isForwarded),
    isStatus: Boolean(msg.isStatus),
    broadcast: Boolean(msg.broadcast),
  };
}

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error("Invalid webhook URL"));
      return;
    }

    const data = JSON.stringify(payload);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data, "utf8"),
        },
        timeout: 15000,
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Webhook HTTP ${res.statusCode}`));
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Webhook timeout"));
    });
    req.write(data);
    req.end();
  });
}

function notifyIncomingMessage(sessionId, msg) {
  if (!isWebhookEnabled()) {
    return;
  }

  const url = getIncomingWebhookUrl();
  if (!url) {
    return;
  }

  if (msg.fromMe) {
    return;
  }

  if (alreadySentThisMessage(sessionId, msg)) {
    return;
  }

  const payload = serializeMessageForWebhook(msg, sessionId);

  postJson(url, payload).catch((err) => {
    console.error(`[Webhook incoming] ${sessionId}:`, err.message);
  });
}

module.exports = {
  getIncomingWebhookUrl,
  isWebhookEnabled,
  notifyIncomingMessage,
  serializeMessageForWebhook,
};

const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// إدارة أكثر من جلسة واتساب (أكثر من رقم) داخل نفس الميكروسيرفس
// key = sessionId (مثلاً clientId أو رقم العميل في السيستم عندك)
// value = { client, clientReady, latestQR }
const sessions = {};

// كاش للشاتات لكل سيشن: تجنب استدعاء getChats في كل مرة
// value = { list: [...], fetchedAt: number }
const CHATS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق
const chatsCache = {};
const DEFAULT_SESSION_ID = "default";
const MESSAGES_FETCH_MAX = 300;

function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== "string") return null;
  const s = chatId.trim();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `${digits}@c.us` : null;
}

function serializeMessage(msg, options = {}) {
  const id = msg.id?._serialized ?? msg.id?.id ?? String(msg.id);
  const hasMedia = Boolean(msg.hasMedia);
  const type = msg.type ?? "chat";
  const o = {
    id,
    body: msg.body ?? "",
    type,
    timestamp: msg.timestamp ?? null,
    fromMe: Boolean(msg.fromMe),
    hasMedia,
    author: msg.author ?? null,
    ack: msg.ack ?? null,
    isForwarded: Boolean(msg.isForwarded),
    hasQuotedMsg: Boolean(msg.hasQuotedMsg),
    isStatus: Boolean(msg.isStatus),
  };
  if (hasMedia && options.sessionId != null) {
    o.mediaUrl = `/message-media?sessionId=${encodeURIComponent(options.sessionId)}&messageId=${encodeURIComponent(id)}`;
  }
  return o;
}

function createSession(sessionId) {
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
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on("ready", () => {
    state.clientReady = true;
    state.latestQR = null;
  });

  client.on("disconnected", () => {
    state.clientReady = false;
    state.latestQR = null;
  });

  client.initialize();

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
    // قد يحدث Protocol error عند الإغلاق - نكمل الحذف
  } finally {
    delete sessions[id];
    delete chatsCache[id];
  }
  return { destroyed: true };
}

app.get("/sessions", (req, res) => {
  const list = Object.entries(sessions).map(([id, state]) => ({
    sessionId: id,
    ready: Boolean(state.clientReady),
    hasQr: Boolean(state.latestQR),
  }));
  res.json({ count: list.length, sessions: list });
});

app.get("/chats", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || DEFAULT_SESSION_ID;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 500);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";

    const state = getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId, error: "WhatsApp client not ready" });
    }

    const now = Date.now();
    let cached = chatsCache[sessionId];
    const cacheValid = cached && now - cached.fetchedAt < CHATS_CACHE_TTL_MS && !forceRefresh;

    if (!cacheValid) {
      const chats = await state.client.getChats();
      const list = chats.map((chat) => ({
        id: chat.id?._serialized ?? chat.id?.id ?? String(chat.id),
        name: chat.name ?? "",
        isGroup: Boolean(chat.isGroup),
        timestamp: chat.timestamp ?? null,
        unreadCount: chat.unreadCount ?? 0,
      }));
      chatsCache[sessionId] = { list, fetchedAt: now };
      cached = chatsCache[sessionId];
    }

    const total = cached.list.length;
    const page = cached.list.slice(offset, offset + limit);

    res.json({
      sessionId,
      total,
      limit,
      offset,
      count: page.length,
      chats: page,
      cached: cacheValid,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/messages", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || DEFAULT_SESSION_ID;
    const rawChatId = req.query.chatId;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const fromMe = req.query.fromMe === "1" || req.query.fromMe === "true" ? true : req.query.fromMe === "0" || req.query.fromMe === "false" ? false : undefined;
    const order = (req.query.order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
    const includeMedia = req.query.includeMedia === "1" || req.query.includeMedia === "true";

    const chatId = normalizeChatId(rawChatId);
    if (!chatId) {
      return res.status(400).json({ error: "chatId required (e.g. 201234567890 or 201234567890@c.us)" });
    }

    const state = getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(chatId);
    if (!chat) {
      return res.status(404).json({ chatId, error: "Chat not found" });
    }

    const searchOptions = { limit: MESSAGES_FETCH_MAX };
    if (fromMe !== undefined) searchOptions.fromMe = fromMe;

    let rawMessages = await chat.fetchMessages(searchOptions);

    if (order === "desc") {
      rawMessages.reverse();
    }

    const total = rawMessages.length;
    const rawPage = rawMessages.slice(offset, offset + limit);

    let page;
    if (includeMedia) {
      page = await Promise.all(
        rawPage.map(async (msg) => {
          const o = serializeMessage(msg, { sessionId });
          if (msg.hasMedia) {
            try {
              const media = await msg.downloadMedia();
              o.media = {
                mimeType: media.mimetype || "application/octet-stream",
                data: media.data,
              };
            } catch (e) {
              o.media = { error: (e && e.message) ? e.message : "Download failed" };
            }
          }
          return o;
        })
      );
    } else {
      page = rawPage.map((msg) => serializeMessage(msg, { sessionId }));
    }

    res.json({
      sessionId,
      chatId,
      total,
      limit,
      offset,
      count: page.length,
      order,
      messages: page,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/message-media", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || DEFAULT_SESSION_ID;
    const messageId = req.query.messageId;

    if (!messageId) {
      return res.status(400).json({ error: "messageId required" });
    }

    const state = getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId, error: "WhatsApp client not ready" });
    }

    const msg = await state.client.getMessageById(messageId);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }
    if (!msg.hasMedia) {
      return res.status(400).json({ error: "Message has no media" });
    }

    const media = await msg.downloadMedia();
    const mimeType = media.mimetype || "application/octet-stream";
    const asJson = req.query.format === "json";

    if (asJson) {
      return res.json({
        messageId,
        mimeType,
        data: media.data,
      });
    }

    const buffer = Buffer.from(media.data, "base64");
    res.set("Content-Type", mimeType);
    res.set("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/session-status", (req, res) => {
  const sessionId = req.query.sessionId || DEFAULT_SESSION_ID;
  const state = getSessionState(sessionId);

  res.json({
    sessionId,
    exists: Boolean(state),
    ready: Boolean(state && state.clientReady),
  });
});

app.get("/qr", async (req, res) => {
  const sessionId = req.query.sessionId || DEFAULT_SESSION_ID;
  const state = getOrCreateSession(sessionId);

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
      message: "QR not generated yet",
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
});

app.post("/send-message", async (req, res) => {
  try {
    const { phoneNumber, message, sessionId } = req.body;

    if (!phoneNumber || !message) {
      return res.status(400).json({ error: "phoneNumber and message required" });
    }

    const state = getOrCreateSession(sessionId);

    if (!state.clientReady) {
      return res.status(503).json({ error: "WhatsApp client not ready" });
    }

    const normalized = String(phoneNumber).replace(/\D/g, "");
    const chatId = `${normalized}@c.us`;

    const result = await state.client.sendMessage(chatId, message);

    res.json({
      success: true,
      id: result.id?._serialized,
      timestamp: result.timestamp,
      to: chatId,
      sessionId: sessionId || DEFAULT_SESSION_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
    // res.status(500).json({ error: "Failed to send message" });
  }
});

app.delete("/session", async (req, res) => {
  try {
    const sessionId = req.query.sessionId || req.body.sessionId || DEFAULT_SESSION_ID;
    const result = await destroySession(sessionId);
    if (!result.destroyed) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    res.json({ sessionId, success: true, message: "Session disconnected and removed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  // يتم إنشاء الجلسات وإعادة استخدامها حسب الطلب عبر getOrCreateSession
});
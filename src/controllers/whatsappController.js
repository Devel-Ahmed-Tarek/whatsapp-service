const whatsappService = require("../services/whatsappService");
const { normalizeChatId, serializeMessage } = require("../utils/formatter");

const CHATS_CACHE_TTL_MS = 5 * 60 * 1000;
const chatsCache = {};
const MESSAGES_FETCH_MAX = 300;

async function getChats(req, res) {
  try {
    const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 500);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";

    const state = whatsappService.getSessionState(sessionId);

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
}

async function getMessages(req, res) {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
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

    const state = whatsappService.getSessionState(sessionId);
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
          const o = serializeMessage(msg, { sessionId, baseUrl });
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
      page = rawPage.map((msg) => serializeMessage(msg, { sessionId, baseUrl }));
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
}

async function getMessageMedia(req, res) {
  try {
    const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
    const messageId = req.query.messageId;

    if (!messageId) {
      return res.status(400).json({ error: "messageId required" });
    }

    const state = whatsappService.getSessionState(sessionId);
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
}

async function sendMessage(req, res) {
  try {
    const { phoneNumber, message, sessionId } = req.body;

    if (!phoneNumber || !message) {
      return res.status(400).json({ error: "phoneNumber and message required" });
    }

    const state = whatsappService.getOrCreateSession(sessionId);

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
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getChats,
  getMessages,
  getMessageMedia,
  sendMessage,
};

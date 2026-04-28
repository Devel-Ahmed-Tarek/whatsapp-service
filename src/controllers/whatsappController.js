const { MessageMedia, Message } = require("whatsapp-web.js");
const whatsappService = require("../services/whatsappService");
const { normalizeChatId, normalizeGroupId, toParticipantIds, serializeMessage } = require("../utils/formatter");

const STATUS_BROADCAST_ID = "status@broadcast";

const CHATS_CACHE_TTL_MS = 5 * 60 * 1000;
const chatsCache = {};
const MESSAGES_FETCH_MAX = 300;

class LidUnresolvedError extends Error {
  constructor(message) {
    super(message);
    this.name = "LidUnresolvedError";
  }
}

async function lookupPnForLid(client, lid) {
  if (typeof client.getContactLidAndPhone !== "function") return null;
  try {
    const result = await client.getContactLidAndPhone([lid]);
    const first = Array.isArray(result) ? result[0] : result;
    const pn = first?.pn;
    if (pn && typeof pn === "string" && pn.includes("@c.us")) return pn;
  } catch (_) {
    // not mapped yet
  }
  return null;
}

/**
 * LID-only threads break WhatsApp Web internals during fetchMessages (e.g. waitForChatLoading).
 * Resolve to @c.us when the client can map the user.
 */
async function effectiveChatIdForMessageFetch(client, chatId) {
  if (!chatId || !String(chatId).endsWith("@lid")) {
    return { effectiveChatId: chatId, resolvedLidToPn: false };
  }
  const pn = await lookupPnForLid(client, chatId);
  if (pn) return { effectiveChatId: pn, resolvedLidToPn: true };
  return { effectiveChatId: chatId, resolvedLidToPn: false };
}

/**
 * Resolve a free-form recipient (digits, "...@c.us" or "...@lid") to a chatId
 * that WhatsApp can deliver to. For LIDs we ask the library for the PN binding,
 * and if that fails we warm the chat cache via getChatById and retry.
 * Throws LidUnresolvedError when an @lid cannot be mapped to a phone number.
 */
async function resolveSendChatId(client, rawPhoneNumber) {
  const raw = String(rawPhoneNumber || "").trim();
  if (!raw) throw new Error("phoneNumber required");

  if (raw.endsWith("@lid")) {
    let pn = await lookupPnForLid(client, raw);
    if (pn) return { chatId: pn, originalChatId: raw, resolvedLidToPn: true };

    try {
      await client.getChatById(raw);
    } catch (_) {
      // ignore — warming may fail when the chat is not yet known
    }

    pn = await lookupPnForLid(client, raw);
    if (pn) return { chatId: pn, originalChatId: raw, resolvedLidToPn: true };

    throw new LidUnresolvedError(
      "Cannot resolve this @lid to a phone number. Open the chat once in linked WhatsApp Web (so the LID-to-phone binding gets cached), or call /send-message with the contact's phone in ...@c.us form."
    );
  }

  if (raw.endsWith("@c.us")) {
    return { chatId: raw, originalChatId: raw, resolvedLidToPn: false };
  }

  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error("phoneNumber must contain digits, ...@c.us or ...@lid");
  const chatId = `${digits}@c.us`;
  return { chatId, originalChatId: raw, resolvedLidToPn: false };
}

function isLidBindingMissingError(err) {
  const msg = err && err.message ? String(err.message) : "";
  return /No LID for users/i.test(msg) || /no\s+pn\s+for/i.test(msg);
}

/**
 * fetchMessages in whatsapp-web.js calls loadEarlierMsgs in a loop; recent WA Web
 * builds throw (e.g. waitForChatLoading). This path only uses msgs already in the
 * client (no loadEarlierMsgs), so the list may be short until the user opens the chat in Web.
 */
async function fetchMessagesInStoreOnly(client, chatIdSerialized, searchOptions) {
  const models = await client.pupPage.evaluate(
    async (chatId, searchOptions) => {
      const msgFilter = (m) => {
        if (m.isNotification) return false;
        if (searchOptions && searchOptions.fromMe !== undefined && m.id.fromMe !== searchOptions.fromMe) {
          return false;
        }
        return true;
      };
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat || !chat.msgs) return [];
      let msgs = chat.msgs.getModelsArray().filter(msgFilter);
      msgs.sort((a, b) => ((a.t > b.t) ? 1 : -1));
      const lim = searchOptions && searchOptions.limit > 0 ? searchOptions.limit : msgs.length;
      if (msgs.length > lim) {
        msgs = msgs.splice(msgs.length - lim);
      }
      return msgs.map((m) => window.WWebJS.getMessageModel(m));
    },
    chatIdSerialized,
    searchOptions
  );
  return models.map((m) => new Message(client, m));
}

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
      const list = chats.map((chat) => {
        const id = chat.id?._serialized ?? chat.id?.id ?? String(chat.id);
        const isGroup = Boolean(chat.isGroup);
        const out = {
          id,
          name: chat.name ?? "",
          isGroup,
          timestamp: chat.timestamp ?? null,
          unreadCount: chat.unreadCount ?? 0,
        };
        if (!isGroup && id && id.includes("@c.us")) {
          out.phoneNumber = id.replace(/@c\.us$/, "");
        }
        return out;
      });
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

    const { effectiveChatId, resolvedLidToPn } = await effectiveChatIdForMessageFetch(
      state.client,
      chatId
    );
    const chat = await state.client.getChatById(effectiveChatId);
    if (!chat) {
      return res.status(404).json({ chatId, error: "Chat not found" });
    }

    let phoneNumber = null;
    if (!chat.isGroup) {
      const id = chat.id?._serialized ?? chat.id?.id ?? String(chat.id);
      if (id && id.endsWith("@c.us")) {
        phoneNumber = id.replace(/@c\.us$/, "");
      } else if (id && id.endsWith("@lid") && state.client.getContactLidAndPhone) {
        try {
          const result = await state.client.getContactLidAndPhone([id]);
          const first = Array.isArray(result) ? result[0] : result;
          const pn = first?.pn ?? first?.number ?? first?.jid;
          if (pn && typeof pn === "string") {
            phoneNumber = pn.replace(/@c\.us$/, "");
          }
        } catch (_) {
          // LID may not return a number yet.
        }
      }
    }

    const searchOptions = { limit: MESSAGES_FETCH_MAX };
    if (fromMe !== undefined) searchOptions.fromMe = fromMe;

    const chatSerializedId = chat.id?._serialized ?? chat.id?.id ?? String(chat.id);
    let rawMessages;
    let historySource = "full";
    try {
      rawMessages = await chat.fetchMessages(searchOptions);
    } catch (err) {
      try {
        rawMessages = await fetchMessagesInStoreOnly(
          state.client,
          chatSerializedId,
          searchOptions
        );
        historySource = "in_memory";
      } catch (_) {
        if (String(chatId).endsWith("@lid") && !resolvedLidToPn) {
          return res.status(422).json({
            sessionId,
            chatId,
            error:
              "Cannot load messages for this @lid chat. WhatsApp did not return a @c.us mapping yet — open the chat in linked WhatsApp Web, save the contact with a number, or call this endpoint with the phone in ...@c.us form if you have it.",
          });
        }
        throw err;
      }
    }

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
      ...(resolvedLidToPn && effectiveChatId !== chatId ? { fetchedChatId: effectiveChatId } : {}),
      ...(historySource === "in_memory" ? { historySource } : {}),
      phoneNumber,
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
  const { phoneNumber, message, sessionId: rawSessionId } = req.body || {};
  const sessionId = rawSessionId || whatsappService.DEFAULT_SESSION_ID;
  const originalRequested = phoneNumber == null ? "" : String(phoneNumber);

  try {
    if (!phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: "missing_required_fields",
        message: "phoneNumber and message are required",
        originalRequested,
        sessionId,
      });
    }

    const state = whatsappService.getOrCreateSession(rawSessionId);

    if (!state.clientReady) {
      return res.status(503).json({
        success: false,
        error: "client_not_ready",
        message: "WhatsApp client not ready",
        originalRequested,
        sessionId,
      });
    }

    let resolved;
    try {
      resolved = await resolveSendChatId(state.client, phoneNumber);
    } catch (err) {
      if (err instanceof LidUnresolvedError) {
        return res.status(422).json({
          success: false,
          error: "lid_unresolvable",
          message: "Cannot resolve LID to a sendable account. Try opening the chat once.",
          originalRequested,
          sessionId,
        });
      }
      return res.status(400).json({
        success: false,
        error: "invalid_phone",
        message: err.message,
        originalRequested,
        sessionId,
      });
    }

    const { chatId } = resolved;

    let result;
    try {
      result = await state.client.sendMessage(chatId, message);
    } catch (err) {
      if (isLidBindingMissingError(err)) {
        return res.status(422).json({
          success: false,
          error: "lid_binding_missing",
          message:
            "WhatsApp does not have the LID-to-phone identity binding cached for this contact yet. Open the chat once in linked WhatsApp Web and retry.",
          originalRequested,
          chatId,
          sessionId,
        });
      }
      throw err;
    }

    res.json({
      success: true,
      messageId: result.id?._serialized ?? null,
      to: chatId,
      originalRequested,
      timestamp: result.timestamp ?? null,
      sessionId,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "internal_error",
      message: err.message,
      originalRequested,
      sessionId,
    });
  }
}

// --- Group endpoints ---

async function createGroup(req, res) {
  try {
    const { sessionId, name, participants, description } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }

    const participantIds = toParticipantIds(participants);
    if (participantIds.length === 0) {
      return res.status(400).json({ error: "participants required (array of phone numbers)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.createGroup(name.trim(), participantIds);
    const groupId =
      chat.id?._serialized ??
      chat.id?.id ??
      (typeof chat.id === "string" ? chat.id : null) ??
      chat.gid ??
      (chat.groupMetadata?.id?.id ?? chat.groupMetadata?.id?._serialized) ??
      (chat._id?.id ?? chat._id?._serialized) ??
      null;

    if (!groupId) {
      return res.status(500).json({ error: "Could not get group id from response" });
    }

    if (description && typeof description === "string" && description.trim()) {
      try {
        await chat.setDescription(description.trim());
      } catch (_) {
        // ignore if setDescription fails (e.g. permissions)
      }
    }

    res.status(201).json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      name: chat.name ?? name.trim(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function addParticipants(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const rawGroupId = req.body.groupId ?? req.query.groupId;
    const participants = req.body.participants ?? req.query.participants;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const participantIds = toParticipantIds(participants);
    if (participantIds.length === 0) {
      return res.status(400).json({ error: "participants required (array of phone numbers)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = await chat.addParticipants(participantIds);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      result: result && typeof result === "object" ? result : { message: String(result) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function removeParticipants(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const rawGroupId = req.body.groupId ?? req.query.groupId;
    const participants = req.body.participants ?? req.query.participants;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const participantIds = toParticipantIds(participants);
    if (participantIds.length === 0) {
      return res.status(400).json({ error: "participants required (array of phone numbers)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = await chat.removeParticipants(participantIds);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      status: result?.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function setGroupSendPermission(req, res) {
  try {
    const { sessionId, groupId: rawGroupId, onlyAdmins } = req.body;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    if (typeof onlyAdmins !== "boolean") {
      return res.status(400).json({ error: "onlyAdmins required (true = قفل: فقط الأدمنز يبعوا، false = فتح: الكل يبعّت)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const ok = await chat.setMessagesAdminsOnly(onlyAdmins);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      onlyAdmins: Boolean(ok),
      message: ok
        ? (onlyAdmins ? "تم قفل المجموعة: فقط الأدمنز يقدرون يبعوا رسائل" : "تم فتح المجموعة: الكل يقدر يبعّت")
        : "لا تملك صلاحية تغيير إعداد الإرسال",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "لا تملك صلاحية تغيير إعداد الإرسال في المجموعة",
    });
  }
}

async function promoteParticipants(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const rawGroupId = req.body.groupId ?? req.query.groupId;
    const participants = req.body.participants ?? req.query.participants;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const participantIds = toParticipantIds(participants);
    if (participantIds.length === 0) {
      return res.status(400).json({ error: "participants required (array of phone numbers)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = await chat.promoteParticipants(participantIds);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      status: result?.status,
      message: "تم ترقية الأعضاء لأدمن (يقدرون يبعوا لو المجموعة مقفولة)",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "لا تملك صلاحية ترقية أعضاء أو العضو ليس في المجموعة",
    });
  }
}

async function demoteParticipants(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const rawGroupId = req.body.groupId ?? req.query.groupId;
    const participants = req.body.participants ?? req.query.participants;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const participantIds = toParticipantIds(participants);
    if (participantIds.length === 0) {
      return res.status(400).json({ error: "participants required (array of phone numbers)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = await chat.demoteParticipants(participantIds);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      status: result?.status,
      message: "تم تنزيل الأعضاء من الأدمن (ما يقدروش يبعوا لو المجموعة مقفولة)",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "لا تملك صلاحية تنزيل أعضاء",
    });
  }
}

async function getGroupInfo(req, res) {
  try {
    const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;
    const rawGroupId = req.query.groupId;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const participants = (chat.participants || []).map((p) => ({
      id: p.id?.id ?? p.id?._serialized ?? String(p.id),
      isAdmin: Boolean(p.isAdmin),
      isSuperAdmin: Boolean(p.isSuperAdmin),
    }));

    res.json({
      sessionId,
      groupId,
      name: chat.name ?? "",
      description: chat.description ?? "",
      owner: chat.owner ?? null,
      createdAt: chat.createdAt ?? null,
      participants,
      participantCount: participants.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function sendMessageToGroup(req, res) {
  try {
    const { sessionId, groupId: rawGroupId, message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message required" });
    }

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = await chat.sendMessage(message.trim());

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      groupId,
      id: result.id?._serialized,
      timestamp: result.timestamp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateGroup(req, res) {
  try {
    const { sessionId, groupId: rawGroupId, name, description, picture, pictureMimeType } = req.body;

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      return res.status(400).json({ error: "groupId required (e.g. 120363xxx@g.us)" });
    }

    const hasName = name != null && typeof name === "string" && name.trim() !== "";
    const hasDescription = description != null;
    const hasPicture = picture != null && typeof picture === "string" && picture.length > 0;

    if (!hasName && !hasDescription && !hasPicture) {
      return res.status(400).json({
        error: "At least one of name, description, or picture is required",
      });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ groupId, error: "Group not found" });
    }

    const result = { sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, groupId };

    if (hasName) {
      try {
        const ok = await chat.setSubject(name.trim());
        result.name = { updated: Boolean(ok) };
      } catch (err) {
        result.name = { updated: false, error: err.message || "لا تملك صلاحية تغيير الاسم" };
      }
    }

    if (hasDescription) {
      try {
        const desc = typeof description === "string" ? description.trim() : "";
        const ok = await chat.setDescription(desc);
        result.description = { updated: Boolean(ok) };
      } catch (err) {
        result.description = { updated: false, error: err.message || "لا تملك صلاحية تغيير الوصف" };
      }
    }

    if (hasPicture) {
      try {
        const mimeType = pictureMimeType || "image/jpeg";
        const data = picture.replace(/^data:[^;]+;base64,/, "");
        const media = new MessageMedia(mimeType, data, undefined);
        const ok = await chat.setPicture(media);
        result.picture = { updated: Boolean(ok) };
      } catch (err) {
        result.picture = {
          updated: false,
          error: err.message || "لا تملك صلاحية تغيير صورة المجموعة",
        };
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// --- Status APIs ---

async function uploadStatus(req, res) {
  try {
    const { sessionId, type, caption, data, mimeType } = req.body;

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const t = (type || "text").toLowerCase();

    if (t === "text") {
      const text = typeof caption === "string" ? caption.trim() : "";
      await state.client.setStatus(text);
      return res.status(201).json({
        success: true,
        sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
        type: "text",
        status: text,
      });
    }

    if (t === "image" || t === "video") {
      if (!data || typeof data !== "string") {
        return res.status(400).json({ error: "data (base64) required for image/video status" });
      }
      const mimetype = mimeType || (t === "image" ? "image/jpeg" : "video/mp4");
      const media = new MessageMedia(mimetype, data.replace(/^data:[^;]+;base64,/, ""), undefined);
      const result = await state.client.sendMessage(STATUS_BROADCAST_ID, media, { caption: typeof caption === "string" ? caption : undefined });
      return res.status(201).json({
        success: true,
        sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
        type: t,
        id: result.id?._serialized,
        timestamp: result.timestamp,
      });
    }

    return res.status(400).json({ error: "type must be text, image, or video" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getStatuses(req, res) {
  try {
    const sessionId = req.query.sessionId || whatsappService.DEFAULT_SESSION_ID;

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId, error: "WhatsApp client not ready" });
    }

    const broadcasts = await state.client.getBroadcasts();
    const list = (broadcasts || []).map((b) => ({
      id: b.id?.id ?? b.id?._serialized ?? String(b.id),
      timestamp: b.timestamp ?? null,
      totalCount: b.totalCount ?? 0,
      unreadCount: b.unreadCount ?? 0,
    }));

    res.json({
      sessionId,
      count: list.length,
      statuses: list,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function deleteStatus(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const messageId = req.body.messageId ?? req.query.messageId;

    if (!messageId || typeof messageId !== "string" || !messageId.trim()) {
      return res.status(400).json({ error: "messageId required" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    await state.client.revokeStatusMessage(messageId.trim());

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      messageId: messageId.trim(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function normalizeChatOrGroupId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.includes("@g.us")) return normalizeGroupId(raw);
  return normalizeChatId(raw);
}

async function setChatPin(req, res) {
  try {
    const { sessionId, chatId: rawChatId, pinned } = req.body;

    const chatId = normalizeChatOrGroupId(rawChatId);
    if (!chatId) {
      return res.status(400).json({ error: "chatId required (e.g. 201234567890 or 201234567890@c.us or 120363xxx@g.us)" });
    }

    if (typeof pinned !== "boolean") {
      return res.status(400).json({ error: "pinned required (true to pin, false to unpin)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const result = pinned ? await state.client.pinChat(chatId) : await state.client.unpinChat(chatId);

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      chatId,
      pinned: Boolean(result),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function sendChatSeen(req, res) {
  try {
    const sessionId = req.body.sessionId ?? req.query.sessionId;
    const rawChatId = req.body.chatId ?? req.query.chatId;

    const chatId = normalizeChatOrGroupId(rawChatId);
    if (!chatId) {
      return res.status(400).json({ error: "chatId required (e.g. 201234567890 or 201234567890@c.us or 131770066424034@lid or 120363xxx@g.us)" });
    }

    const state = whatsappService.getSessionState(sessionId);
    if (!state) {
      return res.status(404).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "Session not found" });
    }
    if (!state.clientReady) {
      return res.status(503).json({ sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID, error: "WhatsApp client not ready" });
    }

    const chat = await state.client.getChatById(chatId);
    if (!chat) {
      return res.status(404).json({ chatId, error: "Chat not found" });
    }

    const result = await chat.sendSeen();

    res.json({
      success: true,
      sessionId: sessionId || whatsappService.DEFAULT_SESSION_ID,
      chatId,
      seen: Boolean(result),
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
  sendChatSeen,
  createGroup,
  addParticipants,
  removeParticipants,
  setGroupSendPermission,
  promoteParticipants,
  demoteParticipants,
  getGroupInfo,
  sendMessageToGroup,
  updateGroup,
  setChatPin,
  uploadStatus,
  getStatuses,
  deleteStatus,
};

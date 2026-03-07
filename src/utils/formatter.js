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
    const baseUrl = options.baseUrl || "";
    o.mediaUrl = `${baseUrl}/message-media?sessionId=${encodeURIComponent(options.sessionId)}&messageId=${encodeURIComponent(id)}`;
  }
  return o;
}

module.exports = {
  normalizeChatId,
  serializeMessage,
};

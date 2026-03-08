/**
 * Mock WhatsApp service - يعمل السيرفر بدون اتصال واتساب حقيقي.
 * تفعيل: MOCK_WHATSAPP=1 أو MOCK_WHATSAPP=true
 */

const sessions = {};
const DEFAULT_SESSION_ID = "default";

function createMockClient() {
  return {
    sendMessage: () => Promise.resolve({ id: { _serialized: "mock_msg_1" }, timestamp: Math.floor(Date.now() / 1000) }),
    getChats: () => Promise.resolve([]),
    getChatById: () =>
      Promise.resolve({
        isGroup: false,
        id: { _serialized: "mock@c.us" },
        name: "Mock Chat",
        fetchMessages: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve({ id: { _serialized: "mock_msg_1" }, timestamp: Math.floor(Date.now() / 1000) }),
        addParticipants: () => Promise.resolve({}),
        removeParticipants: () => Promise.resolve({ status: 200 }),
        promoteParticipants: () => Promise.resolve({ status: 200 }),
        demoteParticipants: () => Promise.resolve({ status: 200 }),
        setSubject: () => Promise.resolve(true),
        setDescription: () => Promise.resolve(true),
        setPicture: () => Promise.resolve(true),
        setMessagesAdminsOnly: () => Promise.resolve(true),
      }),
    getMessageById: () => Promise.resolve(null),
    getBroadcasts: () => Promise.resolve([]),
    createGroup: (name) =>
      Promise.resolve({
        id: { _serialized: "mock_group@g.us", id: "mock_group@g.us" },
        name: name || "Mock Group",
        setDescription: () => Promise.resolve(true),
        setSubject: () => Promise.resolve(true),
        setPicture: () => Promise.resolve(true),
      }),
    revokeStatusMessage: () => Promise.resolve(),
    setStatus: () => Promise.resolve(),
    pinChat: () => Promise.resolve(true),
    unpinChat: () => Promise.resolve(true),
  };
}

function createSession(sessionId) {
  const state = {
    clientReady: true,
    latestQR: null,
    client: createMockClient(),
  };
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
  if (sessions[id]) {
    delete sessions[id];
  }
  return { destroyed: true };
}

function getAllSessions() {
  return Object.entries(sessions).map(([sid, state]) => ({
    sessionId: sid,
    ready: Boolean(state.clientReady),
    hasQr: Boolean(state.latestQR),
  }));
}

async function destroyAllSessions() {
  Object.keys(sessions).forEach((id) => delete sessions[id]);
}

module.exports = {
  getOrCreateSession,
  getSessionState,
  destroySession,
  destroyAllSessions,
  getAllSessions,
  DEFAULT_SESSION_ID,
};

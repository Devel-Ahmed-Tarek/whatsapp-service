require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const sessionRoutes = require("./routes/sessionRoutes");
const whatsappRoutes = require("./routes/whatsappRoutes");
const whatsappService = require("./services/whatsappService");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Routes
app.use("/", sessionRoutes);
app.use("/", whatsappRoutes);

const isMock = process.env.MOCK_WHATSAPP === "1" || process.env.MOCK_WHATSAPP === "true";

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (isMock) {
    console.log("MOCK MODE: WhatsApp disabled - using fake responses (MOCK_WHATSAPP=1)");
    whatsappService.getOrCreateSession(whatsappService.DEFAULT_SESSION_ID);
    return;
  }
  const hook =
    process.env.WHATSAPP_INCOMING_WEBHOOK_URL || process.env.INCOMING_WEBHOOK_URL || "";
  if (hook) {
    console.log(`Incoming message webhook: ${hook}`);
  } else {
    console.log("Incoming webhook: off (set WHATSAPP_INCOMING_WEBHOOK_URL to enable)");
  }
  const skipDefault =
    process.env.WHATSAPP_SKIP_DEFAULT_SESSION === "1" ||
    process.env.WHATSAPP_SKIP_DEFAULT_SESSION === "true";
  if (skipDefault) {
    console.log(
      "WHATSAPP_SKIP_DEFAULT_SESSION: Chrome starts on first /qr or API use — saves RAM if you only use named sessions."
    );
  } else {
    console.log("Initializing default WhatsApp session...");
    whatsappService.getOrCreateSession(whatsappService.DEFAULT_SESSION_ID);
  }
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} signal received: closing HTTP server and sessions...`);
  await whatsappService.destroyAllSessions();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

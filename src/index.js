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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log("Initializing default WhatsApp session...");
  whatsappService.getOrCreateSession(whatsappService.DEFAULT_SESSION_ID);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} signal received: closing HTTP server and sessions...`);
  await whatsappService.destroyAllSessions();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

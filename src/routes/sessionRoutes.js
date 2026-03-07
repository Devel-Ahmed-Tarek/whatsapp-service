const express = require("express");
const router = express.Router();
const sessionController = require("../controllers/sessionController");

router.get("/sessions", sessionController.listSessions);
router.get("/qr", sessionController.getQrCode);
router.get("/session-status", sessionController.getStatus);
router.delete("/session", sessionController.deleteSession);

module.exports = router;

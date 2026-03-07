const express = require("express");
const router = express.Router();
const whatsappController = require("../controllers/whatsappController");

router.get("/chats", whatsappController.getChats);
router.get("/messages", whatsappController.getMessages);
router.get("/message-media", whatsappController.getMessageMedia);
router.post("/send-message", whatsappController.sendMessage);

module.exports = router;

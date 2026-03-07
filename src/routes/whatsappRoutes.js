const express = require("express");
const router = express.Router();
const whatsappController = require("../controllers/whatsappController");

router.get("/chats", whatsappController.getChats);
router.get("/messages", whatsappController.getMessages);
router.get("/message-media", whatsappController.getMessageMedia);
router.post("/send-message", whatsappController.sendMessage);

// Group endpoints
router.post("/group/create", whatsappController.createGroup);
router.post("/group/add-participants", whatsappController.addParticipants);
router.post("/group/remove-participants", whatsappController.removeParticipants);
router.get("/group/info", whatsappController.getGroupInfo);
router.post("/group/send-message", whatsappController.sendMessageToGroup);
router.patch("/group", whatsappController.updateGroup);

// Status APIs
router.post("/status/upload", whatsappController.uploadStatus);
router.get("/status", whatsappController.getStatuses);
router.delete("/status", whatsappController.deleteStatus);

module.exports = router;

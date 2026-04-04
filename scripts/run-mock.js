require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
process.env.MOCK_WHATSAPP = "1";
require("../src/index.js");

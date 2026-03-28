import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

console.log("Token exists:", !!TOKEN);

// Home route
app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

// Webhook
app.post("/webhook", async (req, res) => {
  console.log("Webhook hit");

  try {
    const message = req.body.message;

    if (!message) return res.send("ok");

    const chatId = message.chat.id;
    const text = (message.text || "").toLowerCase().trim();

    let reply = "Command received.";

    // START
    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nCommands:\n/nav fundname\n/ping\n/help";

    // PING
    } else if (text === "/ping") {
      reply = "Bot is live ✅";

    // HELP
    } else if (text === "/help") {
      reply =
        "Commands:\n/nav fundname\nExample:\n/nav hdfc flexi cap";

    // NAV COMMAND
    } else if (text.startsWith("/nav")) {
      const query = text.replace("/nav", "").trim();

      if (!query) {
        reply = "Please enter fund name.\nExample:\n/nav HDFC Flexi Cap";
      } else {
        try {
          // Search fund
          const searchRes = await fetch(
            `https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`
          );
          const searchData = await searchRes.json();

          if (!searchData || searchData.length === 0) {
            reply = "Fund not found.";
          } else {
            const fundCode = searchData[0].schemeCode;

            // Get NAV
            const navRes = await fetch(
              `https://api.mfapi.in/mf/${fundCode}`
            );
            const navData = await navRes.json();

            const latest = navData.data[0];

            reply =
`📊 ${navData.meta.scheme_name}

NAV: ₹${latest.nav}
Date: ${latest.date}`;
          }
        } catch (err) {
          console.error(err);
          reply = "Error fetching data.";
        }
      }

    // DEFAULT
    } else if (text.length > 0) {
      reply = `You said: ${text}`;
    }

    // Send message
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });

    res.send("ok");

  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("error");
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

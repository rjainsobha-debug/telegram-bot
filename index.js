import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

console.log("Token exists:", !!TOKEN);

app.get("/", (req, res) => {
  res.status(200).send("Bot is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "Health check passed",
    tokenConfigured: !!TOKEN
  });
});

app.post("/webhook", async (req, res) => {
  console.log("Webhook hit");
  console.log("Incoming update:", JSON.stringify(req.body));

  try {
    if (!TOKEN) {
      console.error("Missing TELEGRAM_BOT_TOKEN in environment variables");
      return res.status(500).send("Bot token missing");
    }

    const message = req.body.message;

    if (!message) {
      console.log("No message in update");
      return res.status(200).send("ok");
    }

    const chatId = message.chat?.id;
    const text = (message.text || "").trim();

    if (!chatId) {
      console.log("No chat id found");
      return res.status(200).send("ok");
    }

    let reply = "Command received.";

    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nAvailable commands:\n/start - Start bot\n/ping - Check bot\n/help - Show commands";
    } else if (text === "/ping") {
      reply = "Bot is live ✅";
    } else if (text === "/help") {
      reply =
        "Available commands:\n/start - Start bot\n/ping - Check bot\n/help - Show commands";
    } else if (text.length > 0) {
      reply = `You said: ${text}`;
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: reply
        })
      }
    );

    const telegramData = await telegramResponse.json();
    console.log("Telegram response:", telegramData);

    if (!telegramResponse.ok || !telegramData.ok) {
      console.error("Telegram API error:", telegramData);
      return res.status(500).send("Telegram send failed");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
});

app.use((req, res) => {
  res.status(404).send("Route not found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

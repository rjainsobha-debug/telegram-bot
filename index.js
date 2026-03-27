import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// VERY IMPORTANT FOR RAILWAY
const PORT = process.env.PORT || 3000;

// ROOT ROUTE (so browser works)
app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

// WEBHOOK
app.post("/webhook", async (req, res) => {
  console.log("Webhook hit");

  try {
    const message = req.body.message;

    if (!message) return res.send("ok");

    const chatId = message.chat.id;
    const text = message.text;

    let reply = `You said: ${text}`;

    if (text === "/start") {
      reply = "Welcome to WealthNest 📊";
    }

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

// START SERVER (IMPORTANT)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

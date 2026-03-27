import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// IMPORTANT: use Railway port
const PORT = process.env.PORT || 3000;

// health check
app.get("/", (req, res) => {
  res.send("Bot is running");
});

// webhook
app.post("/webhook", async (req, res) => {
  console.log("Webhook hit"); // 👈 IMPORTANT LOG

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
    console.error(err);
    res.send("error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

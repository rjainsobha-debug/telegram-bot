import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.send("ok");

  const chatId = message.chat.id;
  const text = message.text;

  let reply = "Command received";

  if (text === "/start") {
    reply = "Welcome to WealthNest 📊";
  }

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text: reply
    })
  });

  res.send("ok");
});

app.listen(3000, () => console.log("Running"));

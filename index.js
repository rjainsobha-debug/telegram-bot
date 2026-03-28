import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// SAFE INIT
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    tokenConfigured: !!TOKEN,
    supabaseConfigured: !!supabase
  });
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.send("ok");

    const chatId = String(message.chat.id);
    const rawText = (message.text || "").trim();
    const text = rawText.toLowerCase();

    let reply = "Unknown command.\nType /help";

    // START
    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nCommands:\n/nav fundname\n/add fund | amount\n/portfolio";

    // NAV
    } else if (text.startsWith("/nav")) {
      const query = rawText.replace("/nav", "").trim();

      if (!query) {
        reply = "Use:\n/nav fund name";
      } else {
        const fund = await findFund(query);

        if (!fund) {
          reply = "Fund not found.";
        } else {
          const data = await getFund(fund.schemeCode);
          const latest = data.data[0];

          reply =
`📊 ${data.meta.scheme_name}

NAV: ₹${latest.nav}
Date: ${latest.date}`;
        }
      }

    // ADD
    } else if (text.startsWith("/add")) {
      if (!supabase) {
        reply = "Database not connected.";
      } else {
        const body = rawText.replace("/add", "").trim();

        if (!body.includes("|")) {
          reply = "Use:\n/add fund name | amount";
        } else {
          const [nameRaw, amtRaw] = body.split("|");

          const fundName = nameRaw.trim();
          const amount = parseFloat(amtRaw.trim());

          const fund = await findFund(fundName);

          if (!fund) {
            reply = "Fund not found.";
          } else {
            const data = await getFund(fund.schemeCode);
            const nav = parseFloat(data.data[0].nav);

            const units = amount / nav;

            const { error } = await supabase.from("portfolios").insert([
              {
                chat_id: chatId,
                scheme_name: data.meta.scheme_name,
                scheme_code: fund.schemeCode,
                invested_amount: amount,
                units
              }
            ]);

            if (error) {
              reply = "Error saving data";
            } else {
              reply = `✅ Added\n₹${amount} invested`;
            }
          }
        }
      }

    // PORTFOLIO
    } else if (text === "/portfolio") {
      if (!supabase) {
        reply = "Database not connected.";
      } else {
        const { data, error } = await supabase
          .from("portfolios")
          .select("*")
          .eq("chat_id", chatId);

        if (error || !data.length) {
          reply = "No portfolio found.";
        } else {
          let total = 0;
          let current = 0;

          let lines = ["📁 Portfolio\n"];

          for (const item of data) {
            const mf = await getFund(item.scheme_code);
            const nav = parseFloat(mf.data[0].nav);

            const value = nav * item.units;

            total += item.invested_amount;
            current += value;

            lines.push(
`${item.scheme_name}
₹${item.invested_amount} → ₹${value.toFixed(0)}`
            );
          }

          lines.push(`\nTotal: ₹${total}`);
          lines.push(`Current: ₹${current.toFixed(0)}`);

          reply = lines.join("\n\n");
        }
      }
    }

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });

    res.send("ok");

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// HELPERS
async function findFund(q) {
  const r = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
  const d = await r.json();
  return d?.[0] || null;
}

async function getFund(code) {
  const r = await fetch(`https://api.mfapi.in/mf/${code}`);
  return r.json();
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running");
});

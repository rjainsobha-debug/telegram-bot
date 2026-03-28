import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
    supabaseConfigured: !!SUPABASE_URL && !!SUPABASE_ANON_KEY
  });
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(200).send("ok");

    const chatId = String(message.chat.id);
    const rawText = (message.text || "").trim();
    const text = rawText.toLowerCase();

    let reply = "Command received.";

    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nCommands:\n/nav fundname\n/add fund name | amount\n/portfolio\n/help";
    } else if (text === "/help") {
      reply =
        "Commands:\n/nav fundname\n/add fund name | amount\n/portfolio\n\nExamples:\n/nav hdfc flexi cap\n/add hdfc flexi cap | 50000";
    } else if (text === "/ping") {
      reply = "Bot is live ✅";
    } else if (text.startsWith("/nav")) {
      const query = rawText.replace("/nav", "").trim();

      if (!query) {
        reply = "Please enter fund name.\nExample:\n/nav HDFC Flexi Cap";
      } else {
        try {
          const fund = await findFund(query);
          if (!fund) {
            reply = "Fund not found.";
          } else {
            const navData = await getFundDetails(fund.schemeCode);
            const latest = navData.data?.[0];
            if (!latest) {
              reply = "NAV data not available.";
            } else {
              reply = `📊 ${navData.meta.scheme_name}\n\nNAV: ₹${latest.nav}\nDate: ${latest.date}`;
            }
          }
        } catch (err) {
          console.error("NAV error:", err);
          reply = "Error fetching data.";
        }
      }
    } else if (text.startsWith("/add")) {
      if (!supabase) {
        reply = "Database is not configured yet.";
      } else {
        const body = rawText.replace("/add", "").trim();

        if (!body.includes("|")) {
          reply = "Invalid format.\nUse:\n/add fund name | amount\nExample:\n/add hdfc flexi cap | 50000";
        } else {
          const [fundNameRaw, amountRaw] = body.split("|");
          const fundName = (fundNameRaw || "").trim();
          const amount = parseFloat((amountRaw || "").trim());

          if (!fundName || Number.isNaN(amount) || amount <= 0) {
            reply = "Please enter valid fund name and amount.\nExample:\n/add hdfc flexi cap | 50000";
          } else {
            try {
              const fund = await findFund(fundName);

              if (!fund) {
                reply = "Fund not found.";
              } else {
                const navData = await getFundDetails(fund.schemeCode);
                const latest = navData.data?.[0];

                if (!latest) {
                  reply = "NAV data not available.";
                } else {
                  const nav = parseFloat(latest.nav);
                  const units = amount / nav;

                  const { error } = await supabase.from("portfolios").insert([
                    {
                      chat_id: chatId,
                      scheme_name: navData.meta.scheme_name,
                      scheme_code: String(fund.schemeCode),
                      invested_amount: amount,
                      units
                    }
                  ]);

                  if (error) {
                    console.error("Supabase insert error:", error);
                    reply = "Error saving portfolio.";
                  } else {
                    reply = `✅ Added to portfolio\n\nFund: ${navData.meta.scheme_name}\nInvested: ₹${amount.toFixed(2)}\nNAV: ₹${nav.toFixed(2)}\nUnits: ${units.toFixed(4)}`;
                  }
                }
              }
            } catch (err) {
              console.error("Add error:", err);
              reply = "Error adding fund.";
            }
          }
        }
      }
    } else if (text === "/portfolio") {
      if (!supabase) {
        reply = "Database is not configured yet.";
      } else {
        try {
          const { data: userPortfolio, error } = await supabase
            .from("portfolios")
            .select("*")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

          if (error) {
            console.error("Supabase fetch error:", error);
            reply = "Error fetching portfolio.";
          } else if (!userPortfolio || userPortfolio.length === 0) {
            reply = "Your portfolio is empty.\nUse:\n/add fund name | amount";
          } else {
            let totalInvested = 0;
            let totalCurrentValue = 0;
            const lines = ["📁 Your Portfolio\n"];

            for (const item of userPortfolio) {
              const navData = await getFundDetails(item.scheme_code);
              const latest = navData.data?.[0];
              if (!latest) continue;

              const currentNav = parseFloat(latest.nav);
              const currentValue = Number(item.units) * currentNav;
              const gain = currentValue - Number(item.invested_amount);

              totalInvested += Number(item.invested_amount);
              totalCurrentValue += currentValue;

              lines.push(
                `${item.scheme_name}
Invested: ₹${Number(item.invested_amount).toFixed(2)}
Current: ₹${currentValue.toFixed(2)}
Gain/Loss: ₹${gain.toFixed(2)}
`
              );
            }

            const totalGain = totalCurrentValue - totalInvested;

            lines.push(
              `--------------------
Total Invested: ₹${totalInvested.toFixed(2)}
Current Value: ₹${totalCurrentValue.toFixed(2)}
Total Gain/Loss: ₹${totalGain.toFixed(2)}`
            );

            reply = lines.join("\n");
          }
        } catch (err) {
          console.error("Portfolio error:", err);
          reply = "Error fetching portfolio.";
        }
      }
    } else {
      reply = "Unknown command.\nType /help";
    }

    await sendTelegramMessage(chatId, reply);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
});

async function sendTelegramMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  const data = await response.json();
  console.log("Telegram response:", data);
}

async function findFund(query) {
  const searchRes = await fetch(
    `https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`
  );
  const searchData = await searchRes.json();

  if (!searchData || searchData.length === 0) {
    return null;
  }

  return searchData[0];
}

async function getFundDetails(schemeCode) {
  const navRes = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
  return navRes.json();
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

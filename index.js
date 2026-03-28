import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log("SUPABASE_URL exists:", !!SUPABASE_URL);
console.log("SUPABASE_ANON_KEY exists:", !!SUPABASE_ANON_KEY);

let supabase = null;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log("Supabase client created ✅");
} else {
  console.log("Supabase client NOT created ❌");
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

    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nCommands:\n/nav fundname\n/add fund | amount\n/remove fundname\n/portfolio\n/help";

    } else if (text === "/help") {
      reply =
        "Commands:\n/nav fundname\n/add fund | amount\n/remove fundname\n/portfolio\n\nExamples:\n/nav hdfc flexi cap\n/add hdfc flexi cap | 50000\n/remove hdfc flexi cap";

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

    } else if (text.startsWith("/add")) {
      if (!supabase) {
        reply = "Database is not connected ❌";
      } else {
        const body = rawText.replace("/add", "").trim();

        if (!body.includes("|")) {
          reply = "Use:\n/add fund name | amount";
        } else {
          const [nameRaw, amtRaw] = body.split("|");

          const fundName = nameRaw.trim();
          const amount = parseFloat(amtRaw.trim());

          if (!fundName || Number.isNaN(amount) || amount <= 0) {
            reply = "Please enter valid details.\nExample:\n/add hdfc flexi cap | 50000";
          } else {
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
                  scheme_code: String(fund.schemeCode),
                  invested_amount: amount,
                  units
                }
              ]);

              if (error) {
                console.error("Insert error:", error);
                reply = "Error saving data ❌";
              } else {
                reply =
`✅ Added to portfolio

Fund: ${data.meta.scheme_name}
Invested: ₹${amount.toFixed(2)}
NAV: ₹${nav.toFixed(2)}
Units: ${units.toFixed(4)}`;
              }
            }
          }
        }
      }

    } else if (text.startsWith("/remove")) {
      if (!supabase) {
        reply = "Database is not connected ❌";
      } else {
        const query = rawText.replace("/remove", "").trim().toLowerCase();

        if (!query) {
          reply = "Use:\n/remove fund name\nExample:\n/remove hdfc flexi cap";
        } else {
          const { data, error } = await supabase
            .from("portfolios")
            .select("id, scheme_name")
            .eq("chat_id", chatId);

          if (error) {
            console.error("Fetch for remove error:", error);
            reply = "Error finding fund to remove ❌";
          } else if (!data || data.length === 0) {
            reply = "Your portfolio is empty.";
          } else {
            const matches = data.filter(item =>
              item.scheme_name.toLowerCase().includes(query)
            );

            if (matches.length === 0) {
              reply = "No matching fund found in your portfolio.";
            } else if (matches.length === 1) {
              const idToDelete = matches[0].id;

              const { error: deleteError } = await supabase
                .from("portfolios")
                .delete()
                .eq("id", idToDelete)
                .eq("chat_id", chatId);

              if (deleteError) {
                console.error("Delete error:", deleteError);
                reply = "Error removing fund ❌";
              } else {
                reply = `✅ Removed:\n${matches[0].scheme_name}`;
              }
            } else {
              const ids = matches.map(x => x.id);
              const { error: deleteError } = await supabase
                .from("portfolios")
                .delete()
                .in("id", ids)
                .eq("chat_id", chatId);

              if (deleteError) {
                console.error("Bulk delete error:", deleteError);
                reply = "Error removing matching funds ❌";
              } else {
                reply =
`✅ Removed ${matches.length} matching entries:
${matches.map(x => `- ${x.scheme_name}`).join("\n")}`;
              }
            }
          }
        }
      }

    } else if (text === "/portfolio") {
      if (!supabase) {
        reply = "Database is not connected ❌";
      } else {
        const { data, error } = await supabase
          .from("portfolios")
          .select("*")
          .eq("chat_id", chatId);

        if (error) {
          console.error("Portfolio fetch error:", error);
          reply = "Error fetching portfolio ❌";
        } else if (!data || data.length === 0) {
          reply = "No portfolio found.";
        } else {
          let total = 0;
          let current = 0;

          const lines = ["📁 Portfolio\n"];

          for (const item of data) {
            const mf = await getFund(item.scheme_code);
            const nav = parseFloat(mf.data[0].nav);
            const value = nav * item.units;

            total += Number(item.invested_amount);
            current += value;

            lines.push(
`${item.scheme_name}
₹${Number(item.invested_amount).toFixed(2)} → ₹${value.toFixed(2)}`
            );
          }

          const gain = current - total;
          const gainPct = total > 0 ? (gain / total) * 100 : 0;

          lines.push(`\nTotal Invested: ₹${total.toFixed(2)}`);
          lines.push(`Current Value: ₹${current.toFixed(2)}`);
          lines.push(`Gain/Loss: ₹${gain.toFixed(2)} (${gainPct.toFixed(2)}%)`);

          reply = lines.join("\n\n");
        }
      }
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
    console.error("Webhook error:", err);
    res.status(500).send("error");
  }
});

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
  console.log("Server running 🚀");
});

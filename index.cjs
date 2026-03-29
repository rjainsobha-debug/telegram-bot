const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "123";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const HOLDINGS_TABLE = "portfolios";
const SIPS_TABLE = "mf_sips";
const USERS_TABLE = "bot_users";

// ------------------ HELPERS ------------------

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatINR(num) {
  return "₹" + Number(num || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPct(num) {
  const n = Number(num || 0);
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// ------------------ MF API ------------------

async function findFund(query) {
  const res = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  return data && data.length ? data[0] : null;
}

async function getLatestNav(code) {
  const res = await fetch(`https://api.mfapi.in/mf/${code}/latest`);
  const data = await res.json();

  return {
    schemeName: data.meta.scheme_name,
    nav: parseFloat(data.data[0].nav)
  };
}

// ------------------ DB ------------------

async function getPortfolio(chatId) {
  const { data } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId));

  return data || [];
}

// 🔥 FIXED MATCHING (THIS IS THE REAL FIX)
async function findHolding(chatId, query) {
  const portfolio = await getPortfolio(chatId);
  const q = normalizeText(query);

  if (!portfolio.length) return null;

  const words = q.split(" ").filter(Boolean);

  return portfolio.find(p => {
    const name = normalizeText(p.scheme_name);
    return words.every(w => name.includes(w));
  }) || null;
}

// ------------------ SELL LOGIC ------------------

async function sellHolding(chatId, query, amount) {
  const holding = await findHolding(chatId, query);
  if (!holding) throw new Error("Holding not found");

  const latest = await getLatestNav(holding.scheme_code);

  const nav = latest.nav;
  const units = Number(holding.units);
  const invested = Number(holding.invested_amount);

  const currentValue = units * nav;

  if (amount > currentValue) {
    throw new Error(`Sell amount exceeds current value ${formatINR(currentValue)}`);
  }

  const unitsToSell = amount / nav;
  const costPerUnit = invested / units;
  const costSold = costPerUnit * unitsToSell;
  const profit = amount - costSold;

  const remainingUnits = units - unitsToSell;
  const remainingInvested = invested - costSold;

  if (remainingUnits <= 0.0001) {
    await supabase.from(HOLDINGS_TABLE).delete().eq("id", holding.id);

    return `✅ Fully Sold\n\n${holding.scheme_name}\nProfit: ${formatINR(profit)}`;
  }

  await supabase
    .from(HOLDINGS_TABLE)
    .update({
      units: remainingUnits,
      invested_amount: remainingInvested
    })
    .eq("id", holding.id);

  return `✅ Sell Done

Fund: ${holding.scheme_name}
Sold: ${formatINR(amount)}
Profit: ${formatINR(profit)}

Remaining Units: ${remainingUnits.toFixed(4)}
Remaining Invested: ${formatINR(remainingInvested)}`;
}

// ------------------ ROUTES ------------------

app.get("/", (req, res) => res.send("Bot running"));

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.send("ok");

  const chatId = message.chat.id;
  const rawText = message.text || "";
  const text = rawText.toLowerCase();

  let reply = "";

  // -------- SELL --------
  if (text.startsWith("/sell")) {
    try {
      const body = rawText.replace("/sell", "").trim();
      const [name, amt] = body.split("|");

      const amount = parseFloat(amt.trim());

      const result = await sellHolding(chatId, name.trim(), amount);

      reply = result;

    } catch (err) {
      if (err.message === "Holding not found") {
        const portfolio = await getPortfolio(chatId);

        reply =
          "Holding not found.\n\nAvailable funds:\n" +
          portfolio.map(p => `- ${p.scheme_name}`).join("\n");
      } else {
        reply = err.message;
      }
    }
  }

  // -------- PORTFOLIO --------
  else if (text === "/portfolio") {
    const data = await getPortfolio(chatId);

    if (!data.length) {
      reply = "Portfolio empty";
    } else {
      reply = data.map(p =>
        `${p.scheme_name}
Invested: ${formatINR(p.invested_amount)}`
      ).join("\n\n");
    }
  }

  else {
    reply =
`Commands:
/sell fund | amount
/portfolio`;
  }

  await sendTelegramMessage(chatId, reply);
  res.send("ok");
});

// ------------------ START ------------------

app.listen(PORT, () => {
  console.log("Server running...");
});

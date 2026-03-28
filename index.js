const express = require("express");
const https = require("https");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });

const HOLDINGS_TABLE = "mf_holdings";
const SIPS_TABLE = "mf_sips";

// --------------------
// HTTP / WEBHOOK
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("Bot is running");
});

app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// --------------------
// SAFE LOGGING
// --------------------
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// --------------------
// HELPERS
// --------------------
function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatINR(num) {
  const n = Number(num || 0);
  return "₹" + n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(num) {
  const n = Number(num || 0);
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function simpleReturnPct(currentValue, invested) {
  if (!invested || invested <= 0) return 0;
  return ((currentValue - invested) / invested) * 100;
}

function parsePipeInput(input) {
  const parts = String(input || "").split("|");
  return parts.map((x) => x.trim());
}

function sendMessage(chatId, text) {
  return bot.sendMessage(chatId, text);
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error("HTTP " + res.statusCode + " for " + url));
            }
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

// --------------------
// MFAPI
// --------------------
const MFAPI_SCHEME_LIST_URL = "https://api.mfapi.in/mf";
const MFAPI_SCHEME_DETAILS_URL = (code) => `https://api.mfapi.in/mf/${code}`;

let schemeCache = {
  data: null,
  lastFetch: 0,
};

async function getAllSchemes() {
  const now = Date.now();
  const cacheMs = 12 * 60 * 60 * 1000;

  if (schemeCache.data && now - schemeCache.lastFetch < cacheMs) {
    return schemeCache.data;
  }

  const data = await httpsGetJson(MFAPI_SCHEME_LIST_URL);
  schemeCache = {
    data: data,
    lastFetch: now,
  };
  return data;
}

async function findBestSchemeByName(query) {
  const schemes = await getAllSchemes();
  const q = normalizeText(query);

  if (!q) return null;

  let exact = schemes.find(
    (s) =>
      normalizeText(s.schemeName) === q || String(s.schemeCode).trim() === q
  );
  if (exact) return exact;

  let starts = schemes.find((s) =>
    normalizeText(s.schemeName).startsWith(q)
  );
  if (starts) return starts;

  let contains = schemes.filter((s) =>
    normalizeText(s.schemeName).includes(q)
  );

  if (contains.length === 1) return contains[0];
  if (contains.length > 1) {
    contains.sort((a, b) => a.schemeName.length - b.schemeName.length);
    return contains[0];
  }

  return null;
}

async function getLatestNavBySchemeCode(schemeCode) {
  const details = await httpsGetJson(MFAPI_SCHEME_DETAILS_URL(schemeCode));
  const nav = Number(details && details.data && details.data[0] && details.data[0].nav);

  if (!nav) {
    throw new Error("NAV not found for scheme " + schemeCode);
  }

  return nav;
}

async function resolveScheme(query) {
  const scheme = await findBestSchemeByName(query);
  if (!scheme) return null;

  const latestNav = await getLatestNavBySchemeCode(scheme.schemeCode);

  return {
    schemeCode: String(scheme.schemeCode),
    schemeName: scheme.schemeName,
    latestNav,
  };
}

// --------------------
// DB HELPERS
// --------------------
async function getHoldings(chatId) {
  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId));

  if (error) throw error;
  return data || [];
}

async function getSips(chatId) {
  const { data, error } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId));

  if (error) throw error;
  return data || [];
}

async function getSingleHolding(chatId, schemeCode) {
  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode))
    .limit(1);

  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function getSingleSip(chatId, schemeCode) {
  const { data, error } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode))
    .limit(1);

  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function upsertHolding(params) {
  const existing = await getSingleHolding(params.chatId, params.schemeCode);

  if (!existing) {
    const { error } = await supabase.from(HOLDINGS_TABLE).insert([
      {
        chat_id: String(params.chatId),
        scheme_code: String(params.schemeCode),
        scheme_name: params.schemeName,
        total_invested: Number(params.amount),
        total_units: Number(params.units),
        avg_nav: Number(params.navAtPurchase),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    if (error) throw error;
    return;
  }

  const newTotalInvested =
    Number(existing.total_invested || 0) + Number(params.amount);
  const newTotalUnits =
    Number(existing.total_units || 0) + Number(params.units);
  const newAvgNav = newTotalUnits > 0 ? newTotalInvested / newTotalUnits : 0;

  const { error } = await supabase
    .from(HOLDINGS_TABLE)
    .update({
      scheme_name: params.schemeName,
      total_invested: newTotalInvested,
      total_units: newTotalUnits,
      avg_nav: newAvgNav,
      updated_at: new Date().toISOString(),
    })
    .eq("chat_id", String(params.chatId))
    .eq("scheme_code", String(params.schemeCode));

  if (error) throw error;
}

async function upsertSip(params) {
  const existing = await getSingleSip(params.chatId, params.schemeCode);

  if (!existing) {
    const { error } = await supabase.from(SIPS_TABLE).insert([
      {
        chat_id: String(params.chatId),
        scheme_code: String(params.schemeCode),
        scheme_name: params.schemeName,
        sip_amount: Number(params.sipAmount),
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from(SIPS_TABLE)
    .update({
      scheme_name: params.schemeName,
      sip_amount: Number(params.sipAmount),
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq("chat_id", String(params.chatId))
    .eq("scheme_code", String(params.schemeCode));

  if (error) throw error;
}

async function findHoldingByQuery(chatId, query) {
  const holdings = await getHoldings(chatId);
  const q = normalizeText(query);

  let item = holdings.find(
    (h) =>
      normalizeText(h.scheme_name) === q ||
      String(h.scheme_code).trim() === String(query).trim()
  );
  if (item) return item;

  item = holdings.find((h) => normalizeText(h.scheme_name).startsWith(q));
  if (item) return item;

  const matches = holdings.filter((h) =>
    normalizeText(h.scheme_name).includes(q)
  );
  return matches.length ? matches[0] : null;
}

async function findSipByQuery(chatId, query) {
  const sips = await getSips(chatId);
  const q = normalizeText(query);

  let item = sips.find(
    (h) =>
      normalizeText(h.scheme_name) === q ||
      String(h.scheme_code).trim() === String(query).trim()
  );
  if (item) return item;

  item = sips.find((h) => normalizeText(h.scheme_name).startsWith(q));
  if (item) return item;

  const matches = sips.filter((h) =>
    normalizeText(h.scheme_name).includes(q)
  );
  return matches.length ? matches[0] : null;
}

async function removeHolding(chatId, query) {
  const holding = await findHoldingByQuery(chatId, query);
  if (!holding) return null;

  const { error } = await supabase
    .from(HOLDINGS_TABLE)
    .delete()
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(holding.scheme_code));

  if (error) throw error;
  return holding;
}

async function removeSip(chatId, query) {
  const sip = await findSipByQuery(chatId, query);
  if (!sip) return null;

  const { error } = await supabase
    .from(SIPS_TABLE)
    .delete()
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(sip.scheme_code));

  if (error) throw error;
  return sip;
}

// --------------------
// PORTFOLIO
// --------------------
async function enrichHolding(holding) {
  const latestNav = await getLatestNavBySchemeCode(holding.scheme_code);
  const invested = Number(holding.total_invested || 0);
  const units = Number(holding.total_units || 0);
  const currentValue = units * latestNav;
  const profit = currentValue - invested;
  const profitPct = simpleReturnPct(currentValue, invested);

  return {
    scheme_name: holding.scheme_name,
    scheme_code: holding.scheme_code,
    invested,
    units,
    latestNav,
    currentValue,
    profit,
    profitPct,
  };
}

async function buildPortfolioData(chatId) {
  const holdings = await getHoldings(chatId);
  const out = [];

  for (const h of holdings) {
    try {
      const enriched = await enrichHolding(h);
      out.push(enriched);
    } catch (err) {
      console.error("NAV fetch failed for", h.scheme_name, err.message);
    }
  }

  out.sort((a, b) => b.currentValue - a.currentValue);
  return out;
}

async function buildSummaryText(chatId) {
  const portfolio = await buildPortfolioData(chatId);
  const sips = await getSips(chatId);

  if (!portfolio.length && !sips.length) {
    return (
      "No holdings or SIPs found yet.\n\n" +
      "Use:\n" +
      "/add Fund Name | 5000\n" +
      "/addsip Fund Name | 2000"
    );
  }

  let totalInvested = 0;
  let totalCurrent = 0;
  let totalProfit = 0;

  for (const item of portfolio) {
    totalInvested += item.invested;
    totalCurrent += item.currentValue;
    totalProfit += item.profit;
  }

  const totalProfitPct =
    totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  const activeSips = sips.filter((x) => x.is_active !== false);
  const totalSip = activeSips.reduce(
    (sum, x) => sum + Number(x.sip_amount || 0),
    0
  );

  let text = "📊 Daily Mutual Fund Summary\n\n";

  if (portfolio.length) {
    text += "Portfolio Totals\n";
    text += "Invested: " + formatINR(totalInvested) + "\n";
    text += "Current: " + formatINR(totalCurrent) + "\n";
    text += "Profit/Loss: " + formatINR(totalProfit) + " (" + formatPct(totalProfitPct) + ")\n\n";

    text += "Fund-wise Performance\n";
    for (const item of portfolio) {
      text += "\n" + item.scheme_name + "\n";
      text += "Invested: " + formatINR(item.invested) + "\n";
      text += "Current: " + formatINR(item.currentValue) + "\n";
      text += "P/L: " + formatINR(item.profit) + " (" + formatPct(item.profitPct) + ")\n";
    }
  }

  text += "\n\nSIP Summary\n";
  text += "Active SIPs: " + activeSips.length + "\n";
  text += "Monthly SIP Total: " + formatINR(totalSip) + "\n";

  if (activeSips.length) {
    text += "\nActive SIP List\n";
    for (const sip of activeSips) {
      text += sip.scheme_name + " — " + formatINR(sip.sip_amount) + "/month\n";
    }
  }

  return text;
}

// --------------------
// COMMANDS
// --------------------
bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;

  const text =
    "Welcome to your Mutual Fund Bot 🚀\n\n" +
    "Commands:\n" +
    "/nav fundname\n" +
    "/add fund name | amount\n" +
    "/remove fundname\n" +
    "/portfolio\n" +
    "/addsip fund name | monthly amount\n" +
    "/removesip fundname\n" +
    "/sips\n" +
    "/summary";

  await sendMessage(chatId, text);
});

bot.onText(/^\/nav(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return sendMessage(chatId, "Usage:\n/nav fundname");
  }

  try {
    const scheme = await resolveScheme(query);
    if (!scheme) {
      return sendMessage(chatId, "Fund not found.");
    }

    const text =
      "NAV Details\n\n" +
      "Fund: " + scheme.schemeName + "\n" +
      "Scheme Code: " + scheme.schemeCode + "\n" +
      "Latest NAV: " + formatINR(scheme.latestNav);

    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/nav error:", err);
    await sendMessage(chatId, "Unable to fetch NAV right now.");
  }
});

bot.onText(/^\/add(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = (match && match[1] ? match[1] : "").trim();

  if (!raw) {
    return sendMessage(chatId, "Usage:\n/add fund name | amount");
  }

  try {
    const parts = parsePipeInput(raw);
    const fundName = parts[0];
    const amount = Number(parts[1]);

    if (!fundName || !amount || amount <= 0) {
      return sendMessage(chatId, "Invalid format.\nUsage:\n/add fund name | amount");
    }

    const scheme = await resolveScheme(fundName);
    if (!scheme) {
      return sendMessage(chatId, "Fund not found.");
    }

    const units = amount / scheme.latestNav;

    await upsertHolding({
      chatId: chatId,
      schemeCode: scheme.schemeCode,
      schemeName: scheme.schemeName,
      amount: amount,
      units: units,
      navAtPurchase: scheme.latestNav,
    });

    const text =
      "Added investment\n\n" +
      "Fund: " + scheme.schemeName + "\n" +
      "Amount: " + formatINR(amount) + "\n" +
      "NAV: " + formatINR(scheme.latestNav) + "\n" +
      "Units: " + units.toFixed(4);

    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/add error:", err);
    await sendMessage(chatId, "Unable to add fund.");
  }
});

bot.onText(/^\/remove(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return sendMessage(chatId, "Usage:\n/remove fundname");
  }

  try {
    const removed = await removeHolding(chatId, query);
    if (!removed) {
      return sendMessage(chatId, "Holding not found.");
    }

    await sendMessage(chatId, "Removed holding:\n" + removed.scheme_name);
  } catch (err) {
    console.error("/remove error:", err);
    await sendMessage(chatId, "Unable to remove holding.");
  }
});

bot.onText(/^\/portfolio$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const portfolio = await buildPortfolioData(chatId);

    if (!portfolio.length) {
      return sendMessage(chatId, "No holdings found.\nUse /add fund name | amount");
    }

    let totalInvested = 0;
    let totalCurrent = 0;
    let totalProfit = 0;
    let text = "Your Portfolio\n\n";

    for (const item of portfolio) {
      totalInvested += item.invested;
      totalCurrent += item.currentValue;
      totalProfit += item.profit;

      text += item.scheme_name + "\n";
      text += "Invested: " + formatINR(item.invested) + "\n";
      text += "Current: " + formatINR(item.currentValue) + "\n";
      text += "Profit/Loss: " + formatINR(item.profit) + " (" + formatPct(item.profitPct) + ")\n";
      text += "Units: " + item.units.toFixed(4) + "\n";
      text += "Latest NAV: " + formatINR(item.latestNav) + "\n\n";
    }

    const totalProfitPct =
      totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

    text += "Total Portfolio\n";
    text += "Invested: " + formatINR(totalInvested) + "\n";
    text += "Current: " + formatINR(totalCurrent) + "\n";
    text += "Profit/Loss: " + formatINR(totalProfit) + " (" + formatPct(totalProfitPct) + ")";

    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/portfolio error:", err);
    await sendMessage(chatId, "Unable to fetch portfolio.");
  }
});

bot.onText(/^\/addsip(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = (match && match[1] ? match[1] : "").trim();

  if (!raw) {
    return sendMessage(chatId, "Usage:\n/addsip fund name | monthly amount");
  }

  try {
    const parts = parsePipeInput(raw);
    const fundName = parts[0];
    const sipAmount = Number(parts[1]);

    if (!fundName || !sipAmount || sipAmount <= 0) {
      return sendMessage(chatId, "Invalid format.\nUsage:\n/addsip fund name | monthly amount");
    }

    const scheme = await resolveScheme(fundName);
    if (!scheme) {
      return sendMessage(chatId, "Fund not found.");
    }

    await upsertSip({
      chatId: chatId,
      schemeCode: scheme.schemeCode,
      schemeName: scheme.schemeName,
      sipAmount: sipAmount,
    });

    const text =
      "SIP added/updated\n\n" +
      "Fund: " + scheme.schemeName + "\n" +
      "Monthly SIP: " + formatINR(sipAmount);

    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/addsip error:", err);
    await sendMessage(chatId, "Unable to add SIP.");
  }
});

bot.onText(/^\/removesip(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return sendMessage(chatId, "Usage:\n/removesip fundname");
  }

  try {
    const removed = await removeSip(chatId, query);
    if (!removed) {
      return sendMessage(chatId, "SIP not found.");
    }

    await sendMessage(chatId, "Removed SIP:\n" + removed.scheme_name);
  } catch (err) {
    console.error("/removesip error:", err);
    await sendMessage(chatId, "Unable to remove SIP.");
  }
});

bot.onText(/^\/sips$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const sips = await getSips(chatId);
    const activeSips = sips.filter((x) => x.is_active !== false);

    if (!activeSips.length) {
      return sendMessage(chatId, "No active SIPs found.\nUse /addsip fund name | amount");
    }

    let total = 0;
    let text = "Active SIPs\n\n";

    for (const sip of activeSips) {
      total += Number(sip.sip_amount || 0);
      text += sip.scheme_name + " — " + formatINR(sip.sip_amount) + "/month\n";
    }

    text += "\nTotal Monthly SIP: " + formatINR(total);
    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/sips error:", err);
    await sendMessage(chatId, "Unable to fetch SIPs.");
  }
});

bot.onText(/^\/summary$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const text = await buildSummaryText(chatId);
    await sendMessage(chatId, text);
  } catch (err) {
    console.error("/summary error:", err);
    await sendMessage(chatId, "Unable to generate summary.");
  }
});

// --------------------
// START
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server started on port", PORT);
  console.log("Webhook endpoint is /webhook");
  console.log("Startup complete");
});

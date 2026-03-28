const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

// =========================
// ENV
// =========================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing required environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =========================
// BOT SETUP
// =========================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });

const WEBHOOK_PATH = `/webhook`;
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => {
  res.send("Mutual Fund Telegram Bot is running.");
});

// =========================
// CONFIG
// =========================
const MFAPI_SCHEME_LIST_URL = "https://api.mfapi.in/mf";
const MFAPI_SCHEME_DETAILS_URL = (code) => `https://api.mfapi.in/mf/${code}`;
const MFAPI_SCHEME_LATEST_URL = (code) => `https://api.mfapi.in/mf/${code}/latest`;

// Change these if your Supabase table names are different.
const HOLDINGS_TABLE = "mf_holdings";
const SIPS_TABLE = "mf_sips";

// =========================
// SMALL HELPERS
// =========================
function normalizeText(s = "") {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function formatINR(num) {
  const n = Number(num || 0);
  return `₹${n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatPct(num) {
  const n = Number(num || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function escapeMarkdown(text = "") {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function splitCommandText(msgText = "") {
  const firstSpace = msgText.indexOf(" ");
  if (firstSpace === -1) return "";
  return msgText.slice(firstSpace + 1).trim();
}

function parsePipeInput(input) {
  const parts = input.split("|").map((x) => x.trim());
  return parts;
}

function calculateXirrStyleSimplePct(currentValue, invested) {
  if (!invested || invested <= 0) return 0;
  return ((currentValue - invested) / invested) * 100;
}

async function safeSend(chatId, text, opts = {}) {
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// =========================
// MFAPI HELPERS
// =========================
let schemeCache = {
  data: null,
  lastFetch: 0,
};

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function getAllSchemes() {
  const now = Date.now();
  const cacheValidForMs = 1000 * 60 * 60 * 12; // 12 hours

  if (schemeCache.data && now - schemeCache.lastFetch < cacheValidForMs) {
    return schemeCache.data;
  }

  const data = await fetchJson(MFAPI_SCHEME_LIST_URL);
  schemeCache = {
    data,
    lastFetch: now,
  };
  return data;
}

async function findBestSchemeByName(query) {
  const schemes = await getAllSchemes();
  const q = normalizeText(query);

  if (!q) return null;

  const exact = schemes.find(
    (s) => normalizeText(s.schemeName) === q || String(s.schemeCode) === q
  );
  if (exact) return exact;

  const startsWith = schemes.find((s) =>
    normalizeText(s.schemeName).startsWith(q)
  );
  if (startsWith) return startsWith;

  const contains = schemes.filter((s) =>
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
  try {
    const latest = await fetchJson(MFAPI_SCHEME_LATEST_URL(schemeCode));
    const nav = Number(latest?.data?.[0]?.nav || latest?.data?.nav || 0);
    if (nav > 0) return nav;
  } catch (_) {
    // fallback below
  }

  const details = await fetchJson(MFAPI_SCHEME_DETAILS_URL(schemeCode));
  const nav = Number(details?.data?.[0]?.nav || 0);
  if (!nav) throw new Error("NAV not found");
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

// =========================
// DB HELPERS
// =========================
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

async function upsertHolding({
  chatId,
  schemeCode,
  schemeName,
  amount,
  units,
  navAtPurchase,
}) {
  const { data: existing, error: fetchErr } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode))
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (!existing) {
    const { error } = await supabase.from(HOLDINGS_TABLE).insert([
      {
        chat_id: String(chatId),
        scheme_code: String(schemeCode),
        scheme_name: schemeName,
        total_invested: Number(amount),
        total_units: Number(units),
        avg_nav: Number(navAtPurchase),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    if (error) throw error;
    return;
  }

  const newTotalInvested = Number(existing.total_invested || 0) + Number(amount);
  const newTotalUnits = Number(existing.total_units || 0) + Number(units);
  const newAvgNav = newTotalUnits > 0 ? newTotalInvested / newTotalUnits : 0;

  const { error } = await supabase
    .from(HOLDINGS_TABLE)
    .update({
      scheme_name: schemeName,
      total_invested: newTotalInvested,
      total_units: newTotalUnits,
      avg_nav: newAvgNav,
      updated_at: new Date().toISOString(),
    })
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode));

  if (error) throw error;
}

async function removeHolding(chatId, fundQuery) {
  const holding = await findHoldingByQuery(chatId, fundQuery);
  if (!holding) return null;

  const { error } = await supabase
    .from(HOLDINGS_TABLE)
    .delete()
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(holding.scheme_code));

  if (error) throw error;
  return holding;
}

async function upsertSip({ chatId, schemeCode, schemeName, sipAmount }) {
  const { data: existing, error: fetchErr } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode))
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (!existing) {
    const { error } = await supabase.from(SIPS_TABLE).insert([
      {
        chat_id: String(chatId),
        scheme_code: String(schemeCode),
        scheme_name: schemeName,
        sip_amount: Number(sipAmount),
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
      scheme_name: schemeName,
      sip_amount: Number(sipAmount),
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode));

  if (error) throw error;
}

async function removeSip(chatId, fundQuery) {
  const sip = await findSipByQuery(chatId, fundQuery);
  if (!sip) return null;

  const { error } = await supabase
    .from(SIPS_TABLE)
    .delete()
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(sip.scheme_code));

  if (error) throw error;
  return sip;
}

async function findHoldingByQuery(chatId, query) {
  const holdings = await getHoldings(chatId);
  const q = normalizeText(query);

  let exact = holdings.find(
    (h) =>
      normalizeText(h.scheme_name) === q || String(h.scheme_code).trim() === query.trim()
  );
  if (exact) return exact;

  let starts = holdings.find((h) => normalizeText(h.scheme_name).startsWith(q));
  if (starts) return starts;

  let contains = holdings.filter((h) => normalizeText(h.scheme_name).includes(q));
  if (contains.length === 1) return contains[0];

  return contains[0] || null;
}

async function findSipByQuery(chatId, query) {
  const sips = await getSips(chatId);
  const q = normalizeText(query);

  let exact = sips.find(
    (s) =>
      normalizeText(s.scheme_name) === q || String(s.scheme_code).trim() === query.trim()
  );
  if (exact) return exact;

  let starts = sips.find((s) => normalizeText(s.scheme_name).startsWith(q));
  if (starts) return starts;

  let contains = sips.filter((s) => normalizeText(s.scheme_name).includes(q));
  if (contains.length === 1) return contains[0];

  return contains[0] || null;
}

// =========================
// PORTFOLIO CALC HELPERS
// =========================
async function enrichHolding(holding) {
  const latestNav = await getLatestNavBySchemeCode(holding.scheme_code);
  const invested = Number(holding.total_invested || 0);
  const units = Number(holding.total_units || 0);
  const currentValue = units * latestNav;
  const profit = currentValue - invested;
  const profitPct = calculateXirrStyleSimplePct(currentValue, invested);

  return {
    ...holding,
    latestNav,
    invested,
    units,
    currentValue,
    profit,
    profitPct,
  };
}

async function buildPortfolioData(chatId) {
  const holdings = await getHoldings(chatId);
  if (!holdings.length) return [];

  const enriched = [];
  for (const h of holdings) {
    try {
      enriched.push(await enrichHolding(h));
    } catch (e) {
      console.error("NAV fetch error for holding:", h.scheme_name, e.message);
    }
  }

  enriched.sort((a, b) => b.currentValue - a.currentValue);
  return enriched;
}

async function buildSummaryText(chatId) {
  const portfolio = await buildPortfolioData(chatId);
  const sips = await getSips(chatId);

  if (!portfolio.length && !sips.length) {
    return "No holdings or SIPs found yet.\n\nUse:\n/add Fund Name | 5000\n/addsip Fund Name | 2000";
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
  const totalSip = activeSips.reduce((sum, x) => sum + Number(x.sip_amount || 0), 0);

  let text = `📊 *Daily Mutual Fund Summary*\n\n`;

  if (portfolio.length) {
    text += `*Portfolio Totals*\n`;
    text += `• Invested: ${escapeMarkdown(formatINR(totalInvested))}\n`;
    text += `• Current: ${escapeMarkdown(formatINR(totalCurrent))}\n`;
    text += `• Profit/Loss: ${escapeMarkdown(formatINR(totalProfit))} \\(${escapeMarkdown(formatPct(totalProfitPct))}\\)\n\n`;

    text += `*Fund-wise Performance*\n`;
    for (const item of portfolio) {
      text += `• ${escapeMarkdown(item.scheme_name)}\n`;
      text += `  Invested: ${escapeMarkdown(formatINR(item.invested))}\n`;
      text += `  Current: ${escapeMarkdown(formatINR(item.currentValue))}\n`;
      text += `  P/L: ${escapeMarkdown(formatINR(item.profit))} \\(${escapeMarkdown(formatPct(item.profitPct))}\\)\n`;
    }
    text += `\n`;
  }

  text += `*SIP Summary*\n`;
  text += `• Active SIPs: ${activeSips.length}\n`;
  text += `• Monthly SIP Total: ${escapeMarkdown(formatINR(totalSip))}\n`;

  if (activeSips.length) {
    text += `\n*Active SIP List*\n`;
    for (const sip of activeSips) {
      text += `• ${escapeMarkdown(sip.scheme_name)} — ${escapeMarkdown(formatINR(sip.sip_amount))}/month\n`;
    }
  }

  text += `\n_Last updated: ${escapeMarkdown(new Date().toLocaleString("en-IN"))}_`;
  return text;
}

// =========================
// COMMANDS
// =========================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  const text =
    `Welcome to your Mutual Fund Bot 🚀\n\n` +
    `Available commands:\n` +
    `/nav fundname\n` +
    `/add fund name | amount\n` +
    `/remove fundname\n` +
    `/portfolio\n` +
    `/addsip fund name | monthly amount\n` +
    `/removesip fundname\n` +
    `/sips\n` +
    `/summary\n`;

  await safeSend(chatId, text);
});

bot.onText(/^\/nav(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return safeSend(chatId, "Usage:\n/nav fund name");
  }

  try {
    const scheme = await resolveScheme(query);
    if (!scheme) {
      return safeSend(chatId, "Fund not found.");
    }

    const text =
      `📌 *NAV Details*\n\n` +
      `*Fund:* ${escapeMarkdown(scheme.schemeName)}\n` +
      `*Scheme Code:* ${escapeMarkdown(scheme.schemeCode)}\n` +
      `*Latest NAV:* ${escapeMarkdown(formatINR(scheme.latestNav))}`;

    await safeSend(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("/nav error:", e);
    await safeSend(chatId, "Unable to fetch NAV right now.");
  }
});

bot.onText(/^\/add(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = (match && match[1] ? match[1] : "").trim();

  if (!raw) {
    return safeSend(chatId, "Usage:\n/add fund name | amount");
  }

  try {
    const [fundName, amountStr] = parsePipeInput(raw);
    const amount = Number(amountStr);

    if (!fundName || !amount || amount <= 0) {
      return safeSend(chatId, "Invalid format.\nUsage:\n/add fund name | amount");
    }

    const scheme = await resolveScheme(fundName);
    if (!scheme) {
      return safeSend(chatId, "Fund not found.");
    }

    const units = amount / scheme.latestNav;

    await upsertHolding({
      chatId,
      schemeCode: scheme.schemeCode,
      schemeName: scheme.schemeName,
      amount,
      units,
      navAtPurchase: scheme.latestNav,
    });

    const text =
      `✅ Added investment\n\n` +
      `Fund: ${scheme.schemeName}\n` +
      `Amount: ${formatINR(amount)}\n` +
      `NAV: ${formatINR(scheme.latestNav)}\n` +
      `Units: ${units.toFixed(4)}`;

    await safeSend(chatId, text);
  } catch (e) {
    console.error("/add error:", e);
    await safeSend(chatId, "Unable to add fund. Check Supabase table/columns once.");
  }
});

bot.onText(/^\/remove(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return safeSend(chatId, "Usage:\n/remove fundname");
  }

  try {
    const removed = await removeHolding(chatId, query);
    if (!removed) {
      return safeSend(chatId, "Holding not found.");
    }

    await safeSend(chatId, `🗑 Removed holding:\n${removed.scheme_name}`);
  } catch (e) {
    console.error("/remove error:", e);
    await safeSend(chatId, "Unable to remove holding.");
  }
});

bot.onText(/^\/portfolio$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const portfolio = await buildPortfolioData(chatId);

    if (!portfolio.length) {
      return safeSend(chatId, "No holdings found.\nUse /add fund name | amount");
    }

    let totalInvested = 0;
    let totalCurrent = 0;
    let totalProfit = 0;

    let text = `📁 *Your Portfolio*\n\n`;

    for (const item of portfolio) {
      totalInvested += item.invested;
      totalCurrent += item.currentValue;
      totalProfit += item.profit;

      text += `*${escapeMarkdown(item.scheme_name)}*\n`;
      text += `• Invested: ${escapeMarkdown(formatINR(item.invested))}\n`;
      text += `• Current: ${escapeMarkdown(formatINR(item.currentValue))}\n`;
      text += `• Profit/Loss: ${escapeMarkdown(formatINR(item.profit))} \\(${escapeMarkdown(formatPct(item.profitPct))}\\)\n`;
      text += `• Units: ${escapeMarkdown(item.units.toFixed(4))}\n`;
      text += `• Latest NAV: ${escapeMarkdown(formatINR(item.latestNav))}\n\n`;
    }

    const totalProfitPct =
      totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

    text += `*Total Portfolio*\n`;
    text += `• Invested: ${escapeMarkdown(formatINR(totalInvested))}\n`;
    text += `• Current: ${escapeMarkdown(formatINR(totalCurrent))}\n`;
    text += `• Profit/Loss: ${escapeMarkdown(formatINR(totalProfit))} \\(${escapeMarkdown(formatPct(totalProfitPct))}\\)`;

    await safeSend(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("/portfolio error:", e);
    await safeSend(chatId, "Unable to fetch portfolio right now.");
  }
});

bot.onText(/^\/addsip(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = (match && match[1] ? match[1] : "").trim();

  if (!raw) {
    return safeSend(chatId, "Usage:\n/addsip fund name | monthly amount");
  }

  try {
    const [fundName, sipAmountStr] = parsePipeInput(raw);
    const sipAmount = Number(sipAmountStr);

    if (!fundName || !sipAmount || sipAmount <= 0) {
      return safeSend(chatId, "Invalid format.\nUsage:\n/addsip fund name | monthly amount");
    }

    const scheme = await resolveScheme(fundName);
    if (!scheme) {
      return safeSend(chatId, "Fund not found.");
    }

    await upsertSip({
      chatId,
      schemeCode: scheme.schemeCode,
      schemeName: scheme.schemeName,
      sipAmount,
    });

    const text =
      `✅ SIP added/updated\n\n` +
      `Fund: ${scheme.schemeName}\n` +
      `Monthly SIP: ${formatINR(sipAmount)}`;

    await safeSend(chatId, text);
  } catch (e) {
    console.error("/addsip error:", e);
    await safeSend(chatId, "Unable to add SIP. Check Supabase table/columns once.");
  }
});

bot.onText(/^\/removesip(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = (match && match[1] ? match[1] : "").trim();

  if (!query) {
    return safeSend(chatId, "Usage:\n/removesip fundname");
  }

  try {
    const removed = await removeSip(chatId, query);
    if (!removed) {
      return safeSend(chatId, "SIP not found.");
    }

    await safeSend(chatId, `🗑 Removed SIP:\n${removed.scheme_name}`);
  } catch (e) {
    console.error("/removesip error:", e);
    await safeSend(chatId, "Unable to remove SIP.");
  }
});

bot.onText(/^\/sips$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const sips = await getSips(chatId);
    const activeSips = sips.filter((x) => x.is_active !== false);

    if (!activeSips.length) {
      return safeSend(chatId, "No active SIPs found.\nUse /addsip fund name | amount");
    }

    let total = 0;
    let text = `💰 *Active SIPs*\n\n`;

    for (const sip of activeSips) {
      total += Number(sip.sip_amount || 0);
      text += `• ${escapeMarkdown(sip.scheme_name)} — ${escapeMarkdown(formatINR(sip.sip_amount))}/month\n`;
    }

    text += `\n*Total Monthly SIP:* ${escapeMarkdown(formatINR(total))}`;
    await safeSend(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("/sips error:", e);
    await safeSend(chatId, "Unable to fetch SIPs.");
  }
});

bot.onText(/^\/summary$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const summaryText = await buildSummaryText(chatId);
    await safeSend(chatId, summaryText, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("/summary error:", e);
    await safeSend(chatId, "Unable to generate summary.");
  }
});

// Fallback for unknown text commands
bot.on("message", async (msg) => {
  const text = msg.text || "";
  const chatId = msg.chat.id;

  if (!text.startsWith("/")) return;

  const knownPrefixes = [
    "/start",
    "/nav",
    "/add",
    "/remove",
    "/portfolio",
    "/addsip",
    "/removesip",
    "/sips",
    "/summary",
  ];

  const matched = knownPrefixes.some((cmd) => text.toLowerCase().startsWith(cmd));
  if (!matched) {
    await safeSend(
      chatId,
      "Unknown command.\n\nUse:\n/start\n/nav fundname\n/add fund | amount\n/remove fundname\n/portfolio\n/addsip fund | amount\n/removesip fundname\n/sips\n/summary"
    );
  }
});

// =========================
// START SERVER + WEBHOOK
// =========================
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    const railwayDomain =
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.PUBLIC_URL;

    if (railwayDomain) {
      const domain = railwayDomain.startsWith("http")
        ? railwayDomain
        : `https://${railwayDomain}`;

      const webhookUrl = `${domain}${WEBHOOK_PATH}`;
      await bot.setWebHook(webhookUrl);
      console.log("Webhook set to:", webhookUrl);
    } else {
      console.log("No public domain env found. Webhook not auto-set.");
    }
  } catch (e) {
    console.error("Webhook setup error:", e.message);
  }
});

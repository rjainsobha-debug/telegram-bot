// index.cjs
// Mutual Fund Telegram Bot
// Features:
// - /add fund name | amount
// - /sell fund name | amount
// - /portfolio
// - /summary
// - /help
// - Auto daily report endpoint: GET /cron/summary?token=YOUR_CRON_SECRET
//
// ENV REQUIRED:
// TELEGRAM_BOT_TOKEN=xxxxx
// SUPABASE_URL=https://xxxx.supabase.co
// SUPABASE_ANON_KEY=xxxxx
//
// ENV OPTIONAL:
// PORT=3000
// WEBHOOK_PATH=/webhook
// CRON_SECRET=any-secret-string
// HOLDINGS_TABLE=holdings
// TRANSACTIONS_TABLE=transactions
// USER_COL=chat_id
// FUND_NAME_COL=fund_name
// UNITS_COL=units
// INVESTED_COL=invested_amount
// AVG_NAV_COL=avg_nav
// SCHEME_CODE_COL=scheme_code
// LAST_NAV_COL=last_nav
// LAST_NAV_DATE_COL=last_nav_date
// CREATED_AT_COL=created_at
// UPDATED_AT_COL=updated_at
//
// DEFAULT SUPABASE TABLE EXPECTED:
// holdings:
//   id (optional), chat_id, fund_name, units, invested_amount, avg_nav,
//   scheme_code, last_nav, last_nav_date, created_at, updated_at
//
// transactions (optional but recommended):
//   id (optional), chat_id, fund_name, type, amount, nav, units,
//   scheme_code, created_at
//
// Notes:
// - If transactions table does not exist, bot will continue working.
// - This file assumes Node 18+ (global fetch available).
// - Railway can call /cron/summary?token=CRON_SECRET on a schedule.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

// =======================
// ENV / CONFIG
// =======================
const PORT = Number(process.env.PORT || 3000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
const CRON_SECRET = process.env.CRON_SECRET || "change-me";

const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || "holdings";
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE || "transactions";

const USER_COL = process.env.USER_COL || "chat_id";
const FUND_NAME_COL = process.env.FUND_NAME_COL || "fund_name";
const UNITS_COL = process.env.UNITS_COL || "units";
const INVESTED_COL = process.env.INVESTED_COL || "invested_amount";
const AVG_NAV_COL = process.env.AVG_NAV_COL || "avg_nav";
const SCHEME_CODE_COL = process.env.SCHEME_CODE_COL || "scheme_code";
const LAST_NAV_COL = process.env.LAST_NAV_COL || "last_nav";
const LAST_NAV_DATE_COL = process.env.LAST_NAV_DATE_COL || "last_nav_date";
const CREATED_AT_COL = process.env.CREATED_AT_COL || "created_at";
const UPDATED_AT_COL = process.env.UPDATED_AT_COL || "updated_at";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
  process.exit(1);
}
if (!SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_ANON_KEY");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const AMFI_NAV_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = express();
app.use(express.json({ limit: "1mb" }));

// =======================
// NAV CACHE
// =======================
const navCache = {
  lastFetchMs: 0,
  byCode: new Map(),   // schemeCode -> { code, name, nav, date }
  all: [],             // array of schemes
};

const NAV_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

// =======================
// HELPERS
// =======================
function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(direct|growth|regular|plan|option|idcw|dividend|reinvestment)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatINR(num) {
  const n = Number(num || 0);
  return `₹${n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function round2(num) {
  return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
}

function round4(num) {
  return Math.round((Number(num) + Number.EPSILON) * 10000) / 10000;
}

function pct(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}

function parseAmount(value) {
  const cleaned = String(value || "").replace(/[,₹\s]/g, "");
  const amt = Number(cleaned);
  return Number.isFinite(amt) && amt > 0 ? amt : null;
}

function commandBody(text) {
  return String(text || "").split(" ").slice(1).join(" ").trim();
}

function parseFundAndAmount(text) {
  // expected: /add hdfc flexi cap | 5000
  const body = commandBody(text);
  const parts = body.split("|");
  if (parts.length < 2) return null;

  const fundName = parts[0].trim();
  const amount = parseAmount(parts[1].trim());

  if (!fundName || !amount) return null;
  return { fundName, amount };
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };

  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    console.error("Telegram sendMessage error:", data);
  }
  return data;
}

async function setWebhookFromRailwayUrl(baseUrl) {
  if (!baseUrl) return;
  const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`;
  const resp = await fetch(`${TELEGRAM_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = await resp.json().catch(() => ({}));
  console.log("setWebhook response:", data);
}

function scoreMatch(inputNorm, schemeNorm) {
  if (!inputNorm || !schemeNorm) return 0;
  if (schemeNorm === inputNorm) return 100;
  if (schemeNorm.includes(inputNorm)) return 90;
  if (inputNorm.includes(schemeNorm)) return 80;

  const inputWords = new Set(inputNorm.split(" "));
  const schemeWords = new Set(schemeNorm.split(" "));
  let common = 0;
  for (const w of inputWords) {
    if (schemeWords.has(w)) common++;
  }
  return common;
}

// =======================
// AMFI NAV FETCH
// =======================
async function refreshNavCache(force = false) {
  const stale = Date.now() - navCache.lastFetchMs > NAV_CACHE_TTL_MS;
  if (!force && navCache.all.length > 0 && !stale) return navCache;

  const resp = await fetch(AMFI_NAV_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 MF Telegram Bot",
      "Accept": "text/plain,text/html,*/*",
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch NAV feed: ${resp.status}`);
  }

  const txt = await resp.text();
  const lines = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  const byCode = new Map();
  const all = [];

  for (const line of lines) {
    // Typical scheme line:
    // Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
    const parts = line.split(";");
    if (parts.length < 6) continue;

    const code = String(parts[0] || "").trim();
    const name = String(parts[3] || "").trim();
    const navStr = String(parts[4] || "").trim();
    const date = String(parts[5] || "").trim();

    const nav = Number(navStr);
    if (!code || !name || !Number.isFinite(nav)) continue;

    const item = { code, name, nav, date, norm: normalizeText(name) };
    byCode.set(code, item);
    all.push(item);
  }

  navCache.byCode = byCode;
  navCache.all = all;
  navCache.lastFetchMs = Date.now();

  console.log(`NAV cache loaded: ${all.length} schemes`);
  return navCache;
}

async function resolveSchemeByName(fundName) {
  await refreshNavCache(false);
  const inputNorm = normalizeText(fundName);

  let best = null;
  let bestScore = -1;

  for (const scheme of navCache.all) {
    const score = scoreMatch(inputNorm, scheme.norm);
    if (score > bestScore) {
      bestScore = score;
      best = scheme;
    }
  }

  if (best && bestScore >= 2) return best;

  return null;
}

async function getSchemeByCodeOrName(code, name) {
  await refreshNavCache(false);

  if (code && navCache.byCode.has(String(code))) {
    return navCache.byCode.get(String(code));
  }

  return resolveSchemeByName(name);
}

// =======================
// DATABASE HELPERS
// =======================
async function getUserHoldings(chatId) {
  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq(USER_COL, String(chatId));

  if (error) throw error;
  return data || [];
}

async function findHolding(chatId, userTypedFundName) {
  const holdings = await getUserHoldings(chatId);
  if (!holdings.length) return null;

  const inputNorm = normalizeText(userTypedFundName);

  let best = null;
  let bestScore = -1;

  for (const h of holdings) {
    const dbName = h[FUND_NAME_COL] || "";
    const dbNorm = normalizeText(dbName);
    const score = scoreMatch(inputNorm, dbNorm);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }

  if (best && bestScore >= 2) return best;
  return null;
}

async function upsertHoldingById(existingRow, payload) {
  if (existingRow && existingRow.id) {
    const { data, error } = await supabase
      .from(HOLDINGS_TABLE)
      .update(payload)
      .eq("id", existingRow.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function deleteHoldingById(id) {
  const { error } = await supabase
    .from(HOLDINGS_TABLE)
    .delete()
    .eq("id", id);

  if (error) throw error;
}

async function safeInsertTransaction(txn) {
  try {
    const { error } = await supabase.from(TRANSACTIONS_TABLE).insert(txn);
    if (error) {
      console.warn("Transaction log skipped:", error.message);
    }
  } catch (e) {
    console.warn("Transaction log skipped:", e.message);
  }
}

async function getDistinctChatIds() {
  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .select(USER_COL)
    .neq(USER_COL, null);

  if (error) throw error;

  const ids = [...new Set((data || []).map((r) => String(r[USER_COL])).filter(Boolean))];
  return ids;
}

// =======================
// CORE ACTIONS
// =======================
async function addFund(chatId, fundName, amount) {
  const scheme = await resolveSchemeByName(fundName);
  if (!scheme) {
    return {
      ok: false,
      message: `❌ Fund not found for: <b>${escapeHtml(fundName)}</b>\n\nTry a cleaner name like:\n<code>/add hdfc flexi cap | 5000</code>`,
    };
  }

  const nav = Number(scheme.nav);
  const units = amount / nav;
  const holding = await findHolding(chatId, fundName);

  if (holding) {
    const oldUnits = Number(holding[UNITS_COL] || 0);
    const oldInvested = Number(holding[INVESTED_COL] || 0);

    const newUnits = oldUnits + units;
    const newInvested = oldInvested + amount;
    const newAvgNav = newUnits > 0 ? newInvested / newUnits : 0;

    const payload = {
      [USER_COL]: String(chatId),
      [FUND_NAME_COL]: scheme.name,
      [UNITS_COL]: round4(newUnits),
      [INVESTED_COL]: round2(newInvested),
      [AVG_NAV_COL]: round4(newAvgNav),
      [SCHEME_CODE_COL]: scheme.code,
      [LAST_NAV_COL]: round4(nav),
      [LAST_NAV_DATE_COL]: scheme.date,
      [UPDATED_AT_COL]: nowIso(),
    };

    await upsertHoldingById(holding, payload);
  } else {
    const payload = {
      [USER_COL]: String(chatId),
      [FUND_NAME_COL]: scheme.name,
      [UNITS_COL]: round4(units),
      [INVESTED_COL]: round2(amount),
      [AVG_NAV_COL]: round4(nav),
      [SCHEME_CODE_COL]: scheme.code,
      [LAST_NAV_COL]: round4(nav),
      [LAST_NAV_DATE_COL]: scheme.date,
      [CREATED_AT_COL]: nowIso(),
      [UPDATED_AT_COL]: nowIso(),
    };

    await upsertHoldingById(null, payload);
  }

  await safeInsertTransaction({
    [USER_COL]: String(chatId),
    [FUND_NAME_COL]: scheme.name,
    type: "BUY",
    amount: round2(amount),
    nav: round4(nav),
    units: round4(units),
    [SCHEME_CODE_COL]: scheme.code,
    [CREATED_AT_COL]: nowIso(),
  });

  return {
    ok: true,
    message:
      `✅ <b>BUY added</b>\n\n` +
      `📌 Fund: <b>${escapeHtml(scheme.name)}</b>\n` +
      `💰 Invested: <b>${formatINR(amount)}</b>\n` +
      `📊 NAV: <b>${round4(nav)}</b>\n` +
      `🧮 Units added: <b>${round4(units)}</b>\n` +
      `🗓 NAV Date: <b>${escapeHtml(scheme.date)}</b>`,
  };
}

async function sellFund(chatId, fundName, amount) {
  const holding = await findHolding(chatId, fundName);

  if (!holding) {
    return {
      ok: false,
      message: `❌ Holding not found for: <b>${escapeHtml(fundName)}</b>`,
    };
  }

  const scheme = await getSchemeByCodeOrName(holding[SCHEME_CODE_COL], holding[FUND_NAME_COL]);
  if (!scheme) {
    return {
      ok: false,
      message: `❌ Could not fetch latest NAV for <b>${escapeHtml(holding[FUND_NAME_COL])}</b>`,
    };
  }

  const currentNav = Number(scheme.nav);
  const oldUnits = Number(holding[UNITS_COL] || 0);
  const oldInvested = Number(holding[INVESTED_COL] || 0);

  if (oldUnits <= 0) {
    return {
      ok: false,
      message: `❌ No units available to sell in <b>${escapeHtml(holding[FUND_NAME_COL])}</b>`,
    };
  }

  const currentValue = oldUnits * currentNav;
  if (amount > currentValue + 0.01) {
    return {
      ok: false,
      message:
        `❌ Sell amount is more than current holding value.\n\n` +
        `Fund: <b>${escapeHtml(holding[FUND_NAME_COL])}</b>\n` +
        `Current Value: <b>${formatINR(currentValue)}</b>\n` +
        `Requested Sell: <b>${formatINR(amount)}</b>`,
    };
  }

  let unitsToSell = amount / currentNav;
  if (unitsToSell > oldUnits) unitsToSell = oldUnits;

  const avgCostPerUnit = oldInvested / oldUnits;
  const costRemoved = unitsToSell * avgCostPerUnit;
  const newUnits = oldUnits - unitsToSell;
  const newInvested = Math.max(0, oldInvested - costRemoved);
  const realizedProfit = amount - costRemoved;

  if (newUnits <= 0.000001) {
    await deleteHoldingById(holding.id);
  } else {
    const payload = {
      [UNITS_COL]: round4(newUnits),
      [INVESTED_COL]: round2(newInvested),
      [AVG_NAV_COL]: round4(newInvested / newUnits),
      [LAST_NAV_COL]: round4(currentNav),
      [LAST_NAV_DATE_COL]: scheme.date,
      [UPDATED_AT_COL]: nowIso(),
      [SCHEME_CODE_COL]: scheme.code || holding[SCHEME_CODE_COL],
      [FUND_NAME_COL]: scheme.name || holding[FUND_NAME_COL],
    };
    await upsertHoldingById(holding, payload);
  }

  await safeInsertTransaction({
    [USER_COL]: String(chatId),
    [FUND_NAME_COL]: scheme.name || holding[FUND_NAME_COL],
    type: "SELL",
    amount: round2(amount),
    nav: round4(currentNav),
    units: round4(unitsToSell),
    [SCHEME_CODE_COL]: scheme.code || holding[SCHEME_CODE_COL],
    realized_profit: round2(realizedProfit),
    [CREATED_AT_COL]: nowIso(),
  });

  return {
    ok: true,
    message:
      `✅ <b>SELL recorded</b>\n\n` +
      `📌 Fund: <b>${escapeHtml(scheme.name || holding[FUND_NAME_COL])}</b>\n` +
      `💸 Sold Amount: <b>${formatINR(amount)}</b>\n` +
      `📊 NAV: <b>${round4(currentNav)}</b>\n` +
      `🧮 Units sold: <b>${round4(unitsToSell)}</b>\n` +
      `💹 Realized P/L: <b>${formatINR(realizedProfit)}</b>\n` +
      `🗓 NAV Date: <b>${escapeHtml(scheme.date)}</b>`,
  };
}

async function buildPortfolioText(chatId) {
  const holdings = await getUserHoldings(chatId);
  if (!holdings.length) {
    return `📭 <b>No holdings found.</b>\n\nUse:\n<code>/add hdfc flexi cap | 5000</code>`;
  }

  await refreshNavCache(false);

  let totalInvested = 0;
  let totalCurrent = 0;
  const rows = [];

  for (const h of holdings) {
    const scheme = await getSchemeByCodeOrName(h[SCHEME_CODE_COL], h[FUND_NAME_COL]);

    const fundName = scheme?.name || h[FUND_NAME_COL] || "Unknown Fund";
    const nav = Number(scheme?.nav || h[LAST_NAV_COL] || 0);
    const units = Number(h[UNITS_COL] || 0);
    const invested = Number(h[INVESTED_COL] || 0);
    const currentValue = units * nav;
    const profit = currentValue - invested;
    const returnPct = invested > 0 ? (profit / invested) * 100 : 0;

    totalInvested += invested;
    totalCurrent += currentValue;

    rows.push(
      `• <b>${escapeHtml(fundName)}</b>\n` +
      `  Units: <b>${round4(units)}</b>\n` +
      `  Invested: <b>${formatINR(invested)}</b>\n` +
      `  Value: <b>${formatINR(currentValue)}</b>\n` +
      `  P/L: <b>${formatINR(profit)} (${returnPct.toFixed(2)}%)</b>`
    );
  }

  const totalProfit = totalCurrent - totalInvested;
  const totalPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  return (
    `📁 <b>Your Portfolio</b>\n\n` +
    rows.join("\n\n") +
    `\n\n────────────\n` +
    `💰 Total Invested: <b>${formatINR(totalInvested)}</b>\n` +
    `📈 Current Value: <b>${formatINR(totalCurrent)}</b>\n` +
    `📊 Overall P/L: <b>${formatINR(totalProfit)} (${totalPct.toFixed(2)}%)</b>`
  );
}

async function buildSummary(chatId, compact = false) {
  const holdings = await getUserHoldings(chatId);
  if (!holdings.length) {
    return compact
      ? `📭 No holdings found.`
      : `📭 <b>No holdings found.</b>\n\nUse:\n<code>/add hdfc flexi cap | 5000</code>`;
  }

  await refreshNavCache(false);

  let totalInvested = 0;
  let totalCurrent = 0;
  let best = null;
  let worst = null;

  for (const h of holdings) {
    const scheme = await getSchemeByCodeOrName(h[SCHEME_CODE_COL], h[FUND_NAME_COL]);

    const fundName = scheme?.name || h[FUND_NAME_COL] || "Unknown Fund";
    const nav = Number(scheme?.nav || h[LAST_NAV_COL] || 0);
    const units = Number(h[UNITS_COL] || 0);
    const invested = Number(h[INVESTED_COL] || 0);
    const currentValue = units * nav;
    const profit = currentValue - invested;
    const returnPct = invested > 0 ? (profit / invested) * 100 : 0;

    totalInvested += invested;
    totalCurrent += currentValue;

    const item = { fundName, profit, returnPct, currentValue, invested };
    if (!best || item.returnPct > best.returnPct) best = item;
    if (!worst || item.returnPct < worst.returnPct) worst = item;
  }

  const totalProfit = totalCurrent - totalInvested;
  const totalPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  if (compact) {
    return (
      `📊 <b>Daily Portfolio Update</b>\n\n` +
      `💰 Invested: <b>${formatINR(totalInvested)}</b>\n` +
      `📈 Value: <b>${formatINR(totalCurrent)}</b>\n` +
      `📊 P/L: <b>${formatINR(totalProfit)} (${totalPct.toFixed(2)}%)</b>\n\n` +
      `🏆 Best: <b>${escapeHtml(best.fundName)}</b> (${best.returnPct.toFixed(2)}%)\n` +
      `⚠️ Worst: <b>${escapeHtml(worst.fundName)}</b> (${worst.returnPct.toFixed(2)}%)`
    );
  }

  return (
    `📊 <b>Portfolio Summary</b>\n\n` +
    `💰 Total Invested: <b>${formatINR(totalInvested)}</b>\n` +
    `📈 Current Value: <b>${formatINR(totalCurrent)}</b>\n` +
    `📊 Total Profit/Loss: <b>${formatINR(totalProfit)} (${totalPct.toFixed(2)}%)</b>\n\n` +
    `🏆 Top Performing Fund:\n` +
    `<b>${escapeHtml(best.fundName)}</b> — ${best.returnPct.toFixed(2)}%\n\n` +
    `⚠️ Worst Performing Fund:\n` +
    `<b>${escapeHtml(worst.fundName)}</b> — ${worst.returnPct.toFixed(2)}%`
  );
}

// =======================
// COMMAND HANDLERS
// =======================
async function handleTextMessage(chatId, text) {
  const lower = String(text || "").trim();

  try {
    if (lower === "/start") {
      await sendTelegramMessage(
        chatId,
        `👋 <b>Mutual Fund Bot Ready</b>\n\n` +
          `Commands:\n` +
          `<code>/add hdfc flexi cap | 5000</code>\n` +
          `<code>/sell hdfc flexi cap | 2000</code>\n` +
          `<code>/portfolio</code>\n` +
          `<code>/summary</code>\n` +
          `<code>/help</code>`
      );
      return;
    }

    if (lower === "/help") {
      await sendTelegramMessage(
        chatId,
        `🛠 <b>Available Commands</b>\n\n` +
          `1. Buy:\n<code>/add hdfc flexi cap | 5000</code>\n\n` +
          `2. Sell:\n<code>/sell hdfc flexi cap | 2000</code>\n\n` +
          `3. View holdings:\n<code>/portfolio</code>\n\n` +
          `4. Summary:\n<code>/summary</code>`
      );
      return;
    }

    if (lower.startsWith("/add ")) {
      const parsed = parseFundAndAmount(text);
      if (!parsed) {
        await sendTelegramMessage(
          chatId,
          `❌ Invalid format.\n\nUse:\n<code>/add hdfc flexi cap | 5000</code>`
        );
        return;
      }

      const result = await addFund(chatId, parsed.fundName, parsed.amount);
      await sendTelegramMessage(chatId, result.message);
      return;
    }

    if (lower.startsWith("/sell ")) {
      const parsed = parseFundAndAmount(text);
      if (!parsed) {
        await sendTelegramMessage(
          chatId,
          `❌ Invalid format.\n\nUse:\n<code>/sell hdfc flexi cap | 2000</code>`
        );
        return;
      }

      const result = await sellFund(chatId, parsed.fundName, parsed.amount);
      await sendTelegramMessage(chatId, result.message);
      return;
    }

    if (lower === "/portfolio") {
      const message = await buildPortfolioText(chatId);
      await sendTelegramMessage(chatId, message);
      return;
    }

    if (lower === "/summary") {
      const message = await buildSummary(chatId, false);
      await sendTelegramMessage(chatId, message);
      return;
    }

    await sendTelegramMessage(
      chatId,
      `❓ Unknown command.\n\nUse <code>/help</code> to see all commands.`
    );
  } catch (err) {
    console.error("handleTextMessage error:", err);
    await sendTelegramMessage(
      chatId,
      `⚠️ Something went wrong.\n\n<code>${escapeHtml(err.message || "Unknown error")}</code>`
    );
  }
}

// =======================
// TELEGRAM WEBHOOK
// =======================
app.post(WEBHOOK_PATH, async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.chat || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text;

    await handleTextMessage(chatId, text);
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

// =======================
// HEALTH / MANUAL ROUTES
// =======================
app.get("/", async (_req, res) => {
  res.json({
    ok: true,
    service: "mutual-fund-telegram-bot",
    webhook_path: WEBHOOK_PATH,
    nav_cache_items: navCache.all.length,
    nav_cache_last_fetch: navCache.lastFetchMs ? new Date(navCache.lastFetchMs).toISOString() : null,
    now: nowIso(),
  });
});

app.get("/refresh-nav", async (_req, res) => {
  try {
    await refreshNavCache(true);
    res.json({
      ok: true,
      count: navCache.all.length,
      lastFetch: new Date(navCache.lastFetchMs).toISOString(),
    });
  } catch (err) {
    console.error("/refresh-nav error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual test:
// https://your-railway-url/cron/summary?token=YOUR_CRON_SECRET
app.get("/cron/summary", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (token !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    await refreshNavCache(true);

    const chatIds = await getDistinctChatIds();
    let sent = 0;
    let skipped = 0;

    for (const chatId of chatIds) {
      try {
        const msg = await buildSummary(chatId, true);
        if (!msg || msg.includes("No holdings found")) {
          skipped++;
          continue;
        }
        await sendTelegramMessage(chatId, msg);
        sent++;
      } catch (e) {
        console.error(`Cron send failed for ${chatId}:`, e.message);
        skipped++;
      }
    }

    res.json({
      ok: true,
      totalUsers: chatIds.length,
      sent,
      skipped,
    });
  } catch (err) {
    console.error("/cron/summary error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Optional test endpoint:
// /test-send?chat_id=123&msg=hello
app.get("/test-send", async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    const msg = String(req.query.msg || "Test message from bot");
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "chat_id required" });
    }
    const out = await sendTelegramMessage(chatId, escapeHtml(msg));
    res.json({ ok: true, result: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================
// SERVER START
// =======================
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    await refreshNavCache(true);
  } catch (e) {
    console.warn("Initial NAV cache load failed:", e.message);
  }

  const railwayPublicDomain =
    process.env.RAILWAY_STATIC_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.APP_URL ||
    null;

  if (railwayPublicDomain) {
    const baseUrl = railwayPublicDomain.startsWith("http")
      ? railwayPublicDomain
      : `https://${railwayPublicDomain}`;
    await setWebhookFromRailwayUrl(baseUrl);
  } else {
    console.log("Webhook auto-set skipped. Set APP_URL or RAILWAY_PUBLIC_DOMAIN if needed.");
  }
});

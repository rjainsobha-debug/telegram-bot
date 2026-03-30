// index.cjs
// Mutual Fund Telegram Bot with:
// - /add fund | amount
// - /sell fund | amount
// - /portfolio
// - /summary
// - /sip fund | amount | monthly
// - /sips
// - /register name | city | mobile | email
// - Lead capture on message: YES
// - Telegram admin lead alert (Twilio removed)
// - /cron/summary?token=...
// - /cron/run-sips?token=...

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
const SIPS_TABLE = process.env.SIPS_TABLE || "sip_plans";
const USERS_TABLE = process.env.USERS_TABLE || "bot_users";
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_CHAT_ID || "852911307";

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


if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY");

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const AMFI_NAV_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = express();
app.use(express.json({ limit: "1mb" }));

// =======================
// NAV CACHE
// =======================
const navCache = { lastFetchMs: 0, byCode: new Map(), all: [] };
const NAV_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const pendingLeadRequests = new Map();

// =======================
// HELPERS
// =======================
function nowIso() {
  return new Date().toISOString();
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function parseYmdToDate(ymd) {
  const [y, m, d] = String(ymd || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDisplayDate(ymd) {
  const dt = parseYmdToDate(ymd);
  if (!dt) return String(ymd || "");
  return dt.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatLeadTimestamp() {
  return new Date().toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function addMonthsToYmd(ymd, months) {
  const dt = parseYmdToDate(ymd);
  if (!dt) return todayYmd();

  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth();
  const day = dt.getUTCDate();

  const endOfTargetMonth = new Date(Date.UTC(year, month + months + 1, 0));
  const lastDay = endOfTargetMonth.getUTCDate();
  const safeDay = Math.min(day, lastDay);

  return new Date(Date.UTC(year, month + months, safeDay))
    .toISOString()
    .slice(0, 10);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(direct|growth|regular|plan|option|idcw|dividend|reinvestment)\b/g,
      " "
    )
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
  return `₹${Number(num || 0).toLocaleString("en-IN", {
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

function parseAmount(value) {
  const cleaned = String(value || "").replace(/[,₹\s]/g, "");
  const amt = Number(cleaned);
  return Number.isFinite(amt) && amt > 0 ? amt : null;
}

function commandBody(text) {
  return String(text || "").split(" ").slice(1).join(" ").trim();
}

function normalizeTelegramCommandText(text) {
  return String(text || "").trim().replace(/^\/([a-z_]+)@\w+/, "/$1");
}

function parseFundAndAmount(text) {
  const parts = commandBody(text).split("|");
  if (parts.length < 2) return null;

  const fundName = parts[0].trim();
  const amount = parseAmount(parts[1].trim());

  if (!fundName || !amount) return null;
  return { fundName, amount };
}

function parseSipCommand(text) {
  const parts = commandBody(text).split("|").map(x => x.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  const fundName = parts[0];
  const amount = parseAmount(parts[1]);
  const frequency = String(parts[2] || "").toLowerCase();

  if (!fundName || !amount) return null;
  if (!["monthly"].includes(frequency)) return null;

  return { fundName, amount, frequency };
}

function parseRegisterCommand(text) {
  const parts = commandBody(text).split("|").map(x => x.trim());
  if (parts.length < 4) return null;

  const name = parts[0];
  const city = parts[1];
  const mobile = parts[2];
  const email = parts[3];

  if (!name || !city || !mobile || !email) return null;
  return { name, city, mobile, email };
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

function isTableMissingError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("could not find the table") ||
    (msg.includes("relation") && msg.includes("does not exist"));
}

// =======================
// TELEGRAM / TWILIO HELPERS
// =======================
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


function getQuickLeadInlineKeyboard(menu = "main") {
  if (menu === "main") {
    return {
      inline_keyboard: [
        [{ text: "📊 Quick Investment Check", callback_data: "ql_investment" }],
        [{ text: "🚀 Start SIP", callback_data: "ql_sip" }],
        [{ text: "💬 Get Free Advice", callback_data: "ql_advice" }],
      ],
    };
  }

  if (menu === "investment") {
    return {
      inline_keyboard: [
        [
          { text: "₹0-1 lakh", callback_data: "lead_inv_0_1" },
          { text: "₹1-5 lakh", callback_data: "lead_inv_1_5" },
        ],
        [
          { text: "₹5-20 lakh", callback_data: "lead_inv_5_20" },
          { text: "₹20 lakh+", callback_data: "lead_inv_20_plus" },
        ],
        [{ text: "⬅️ Back", callback_data: "ql_main" }],
      ],
    };
  }

  if (menu === "sip") {
    return {
      inline_keyboard: [
        [
          { text: "₹2,000/month", callback_data: "lead_sip_2000" },
          { text: "₹5,000/month", callback_data: "lead_sip_5000" },
        ],
        [
          { text: "₹10,000/month", callback_data: "lead_sip_10000" },
          { text: "₹25,000+/month", callback_data: "lead_sip_25000_plus" },
        ],
        [{ text: "⬅️ Back", callback_data: "ql_main" }],
      ],
    };
  }

  if (menu === "advice") {
    return {
      inline_keyboard: [
        [
          { text: "Portfolio Review", callback_data: "lead_adv_portfolio_review" },
          { text: "Tax Saving Help", callback_data: "lead_adv_tax_saving_help" },
        ],
        [
          { text: "SIP Planning", callback_data: "lead_adv_sip_planning" },
          { text: "Talk to Expert", callback_data: "lead_adv_talk_to_expert" },
        ],
        [{ text: "⬅️ Back", callback_data: "ql_main" }],
      ],
    };
  }

  return { inline_keyboard: [] };
}

function getQuickLeadReplyKeyboard(menu = "main") {
  if (menu === "main") {
    return {
      keyboard: [
        [{ text: "📊 Quick Investment Check" }],
        [{ text: "🚀 Start SIP" }],
        [{ text: "💬 Get Free Advice" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  if (menu === "investment") {
    return {
      keyboard: [
        [{ text: "₹0-1 lakh" }, { text: "₹1-5 lakh" }],
        [{ text: "₹5-20 lakh" }, { text: "₹20 lakh+" }],
        [{ text: "⬅️ Back" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  if (menu === "sip") {
    return {
      keyboard: [
        [{ text: "₹2,000/month" }, { text: "₹5,000/month" }],
        [{ text: "₹10,000/month" }, { text: "₹25,000+/month" }],
        [{ text: "⬅️ Back" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  if (menu === "advice") {
    return {
      keyboard: [
        [{ text: "Portfolio Review" }, { text: "Tax Saving Help" }],
        [{ text: "SIP Planning" }, { text: "Talk to Expert" }],
        [{ text: "⬅️ Back" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  return {
    remove_keyboard: true,
  };
}

function quickLeadTextToAction(text) {
  const cleaned = String(text || "").trim();
  const map = {
    "📊 Quick Investment Check": "ql_investment",
    "Quick Investment Check": "ql_investment",
    "🚀 Start SIP": "ql_sip",
    "Start SIP": "ql_sip",
    "💬 Get Free Advice": "ql_advice",
    "Get Free Advice": "ql_advice",
    "₹0-1 lakh": "lead_inv_0_1",
    "₹1-5 lakh": "lead_inv_1_5",
    "₹5-20 lakh": "lead_inv_5_20",
    "₹20 lakh+": "lead_inv_20_plus",
    "₹2,000/month": "lead_sip_2000",
    "₹5,000/month": "lead_sip_5000",
    "₹10,000/month": "lead_sip_10000",
    "₹25,000+/month": "lead_sip_25000_plus",
    "Portfolio Review": "lead_adv_portfolio_review",
    "Tax Saving Help": "lead_adv_tax_saving_help",
    "SIP Planning": "lead_adv_sip_planning",
    "Talk to Expert": "lead_adv_talk_to_expert",
    "⬅️ Back": "ql_main",
  };
  return map[cleaned] || null;
}

function quickLeadChoiceLabel(data) {
  const map = {
    lead_inv_0_1: "Quick Investment Check: ₹0-1 lakh",
    lead_inv_1_5: "Quick Investment Check: ₹1-5 lakh",
    lead_inv_5_20: "Quick Investment Check: ₹5-20 lakh",
    lead_inv_20_plus: "Quick Investment Check: ₹20 lakh+",
    lead_sip_2000: "Start SIP interest: ₹2,000/month",
    lead_sip_5000: "Start SIP interest: ₹5,000/month",
    lead_sip_10000: "Start SIP interest: ₹10,000/month",
    lead_sip_25000_plus: "Start SIP interest: ₹25,000+/month",
    lead_adv_portfolio_review: "Free Advice request: Portfolio Review",
    lead_adv_tax_saving_help: "Free Advice request: Tax Saving Help",
    lead_adv_sip_planning: "Free Advice request: SIP Planning",
    lead_adv_talk_to_expert: "Free Advice request: Talk to Expert",
  };
  return map[data] || null;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;

  const resp = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return await resp.json().catch(() => ({}));
}

async function editTelegramMessage(chatId, messageId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };

  const resp = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    console.error("Telegram editMessageText error:", data);
  }
  return data;
}

async function sendAutoLeadAlert(chatId, actionLabel) {
  await markLead(chatId);
  const user = await getBotUser(chatId);
  const result = await sendAdminLeadAlert({
    chatId,
    name: user?.name,
    city: user?.city,
    mobile: user?.mobile,
    email: user?.email,
    actionLabel,
  });
  console.log(`AUTO LEAD ALERT (${actionLabel}):`, chatId, result?.ok ? "sent" : "skipped");
  return result;
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery?.data || "";
  const callbackQueryId = callbackQuery?.id;
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;

  if (!chatId || !messageId) return;
  await answerCallbackQuery(callbackQueryId);

  if (data === "ql_main") {
    await editTelegramMessage(
      chatId,
      messageId,
      `Choose a quick lead option below:`,
      { reply_markup: { ...getQuickLeadReplyKeyboard("main"), inline_keyboard: getQuickLeadInlineKeyboard("main").inline_keyboard } }
    );
    return;
  }

  if (data === "ql_investment") {
    await editTelegramMessage(
      chatId,
      messageId,
      `Select your approximate mutual fund investment:`,
      { reply_markup: getQuickLeadInlineKeyboard("investment") }
    );
    return;
  }

  if (data === "ql_sip") {
    await editTelegramMessage(
      chatId,
      messageId,
      `Select the SIP amount you are considering:`,
      { reply_markup: getQuickLeadInlineKeyboard("sip") }
    );
    return;
  }

  if (data === "ql_advice") {
    await editTelegramMessage(
      chatId,
      messageId,
      `Choose what you want help with:`,
      { reply_markup: getQuickLeadInlineKeyboard("advice") }
    );
    return;
  }

  const label = quickLeadChoiceLabel(data);
  if (label) {
    await sendAutoLeadAlert(chatId, label);
    await editTelegramMessage(
      chatId,
      messageId,
      `✅ <b>Request captured</b>

<b>${escapeHtml(label)}</b>

Our expert will connect with you shortly.`,
      { reply_markup: getQuickLeadInlineKeyboard("main") }
    );
    await promptForContact(chatId, label);
  }
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

// =======================
// NAV FETCH
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
  const lines = txt.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  const byCode = new Map();
  const all = [];

  for (const line of lines) {
    const parts = line.split(";");
    if (parts.length < 6) continue;

    const code = String(parts[0] || "").trim();
    const name = String(parts[3] || "").trim();
    const nav = Number(String(parts[4] || "").trim());
    const date = String(parts[5] || "").trim();

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

  return best && bestScore >= 2 ? best : null;
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
    const score = scoreMatch(inputNorm, normalizeText(h[FUND_NAME_COL] || ""));
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }

  return best && bestScore >= 2 ? best : null;
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
    if (error) console.warn("Transaction log skipped:", error.message);
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

  return [...new Set((data || []).map(r => String(r[USER_COL])).filter(Boolean))];
}

// =======================
// USER / LEAD HELPERS
// =======================
async function registerUser(chatId, name, city, mobile, email) {
  try {
    const { error } = await supabase
      .from(USERS_TABLE)
      .upsert(
        {
          chat_id: String(chatId),
          name,
          city,
          mobile,
          email,
          updated_at: nowIso(),
        },
        { onConflict: "chat_id" }
      );

    if (error) throw error;
  } catch (error) {
    if (isTableMissingError(error)) {
      return {
        ok: false,
        message:
          `❌ Users table not found.\n\n` +
          `Create table <b>${escapeHtml(USERS_TABLE)}</b> in Supabase first.`,
      };
    }
    throw error;
  }

  return {
    ok: true,
    message:
      `✅ <b>Registered successfully</b>\n\n` +
      `👤 Name: <b>${escapeHtml(name)}</b>\n` +
      `📍 City: <b>${escapeHtml(city)}</b>\n` +
      `📱 Mobile: <b>${escapeHtml(mobile)}</b>\n` +
      `📧 Email: <b>${escapeHtml(email)}</b>`,
  };
}

async function markLead(chatId) {
  try {
    const { error } = await supabase
      .from(USERS_TABLE)
      .upsert(
        {
          chat_id: String(chatId),
          is_lead: true,
          updated_at: nowIso(),
        },
        { onConflict: "chat_id" }
      );

    if (error) throw error;
    return true;
  } catch (error) {
    if (isTableMissingError(error)) return false;
    throw error;
  }
}

async function getBotUser(chatId) {
  try {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .select("*")
      .eq("chat_id", String(chatId))
      .maybeSingle();

    if (error) throw error;
    return data || null;
  } catch (error) {
    if (isTableMissingError(error)) return null;
    throw error;
  }
}


async function upsertBotUserFields(chatId, fields = {}) {
  try {
    const payload = {
      chat_id: String(chatId),
      updated_at: nowIso(),
      ...fields,
    };

    const { error } = await supabase
      .from(USERS_TABLE)
      .upsert(payload, { onConflict: "chat_id" });

    if (error) throw error;
    return true;
  } catch (error) {
    if (isTableMissingError(error)) return false;
    throw error;
  }
}

function getWhatsAppClickUrl(actionLabel, mobile) {
  const text = encodeURIComponent(
    `Hi Rahul, I came from @Mfddelhibot. I need help with: ${actionLabel}${mobile ? ` | My mobile: ${mobile}` : ""}`
  );
  return `https://wa.me/918882332050?text=${text}`;
}


function extractIndianMobile(text) {
  const raw = String(text || "").replace(/[^\d+]/g, "").trim();
  if (!raw) return null;

  let digits = raw;
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

async function handleManualPhoneInput(message) {
  const chatId = message?.chat?.id;
  if (!chatId) return false;

  const pending = pendingLeadRequests.get(String(chatId));
  if (!pending) return false;

  const phone = extractIndianMobile(message?.text);
  if (!phone) return false;

  const actionLabel = pending?.actionLabel || "Bot lead";
  const tgName = [message?.from?.first_name, message?.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  await upsertBotUserFields(chatId, {
    name: tgName || undefined,
    mobile: phone || undefined,
    is_lead: true,
  });

  await sendAdminLeadAlert({
    chatId,
    name: tgName || undefined,
    mobile: phone || undefined,
    actionLabel: `${actionLabel} | Manual number shared`,
  });

  pendingLeadRequests.delete(String(chatId));

  await sendTelegramMessage(
    chatId,
    `✅ <b>Thanks! We received your number</b>\n\n📱 <b>${escapeHtml(phone)}</b>\n\nOur expert will contact you shortly. You can also chat instantly on WhatsApp below.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Chat on WhatsApp", url: getWhatsAppClickUrl(actionLabel, phone) }],
          [{ text: "🤖 Open @Mfddelhibot", url: "https://t.me/Mfddelhibot" }],
        ],
      },
    }
  );

  return true;
}

function getContactShareKeyboard() {
  return {
    keyboard: [
      [{ text: "📞 Share Contact", request_contact: true }],
      [{ text: "Skip for now" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

async function promptForContact(chatId, actionLabel) {
  pendingLeadRequests.set(String(chatId), {
    actionLabel,
    createdAt: Date.now(),
  });

  await sendTelegramMessage(
    chatId,
    `📞 <b>Almost done</b>

Please share your mobile number so our expert can assist you faster for:
<b>${escapeHtml(actionLabel)}</b>

Or tap <b>Skip for now</b>.`,
    {
      reply_markup: getContactShareKeyboard(),
    }
  );
}

async function handleContactMessage(message) {
  const chatId = message?.chat?.id;
  const contact = message?.contact;
  if (!chatId || !contact) return;

  const pending = pendingLeadRequests.get(String(chatId));
  const actionLabel = pending?.actionLabel || "Bot lead";
  const phone = String(contact.phone_number || "").trim();
  const tgName = [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ").trim();

  await upsertBotUserFields(chatId, {
    name: tgName || undefined,
    mobile: phone || undefined,
    is_lead: true,
  });

  await sendAdminLeadAlert({
    chatId,
    name: tgName || undefined,
    mobile: phone || undefined,
    actionLabel: `${actionLabel} | Contact shared`,
  });

  pendingLeadRequests.delete(String(chatId));

  await sendTelegramMessage(
    chatId,
    `✅ <b>Thanks! Contact received</b>

📱 <b>${escapeHtml(phone)}</b>

Our expert will call you shortly. You can also chat instantly on WhatsApp below.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Chat on WhatsApp", url: getWhatsAppClickUrl(actionLabel, phone) }],
          [{ text: "🤖 Open @Mfddelhibot", url: "https://t.me/Mfddelhibot" }],
        ],
        remove_keyboard: true,
      },
    }
  );
}

async function handleSkipForNow(chatId) {
  const pending = pendingLeadRequests.get(String(chatId));
  if (!pending) return false;

  const actionLabel = pending.actionLabel;
  pendingLeadRequests.delete(String(chatId));

  await sendTelegramMessage(
    chatId,
    `👍 No problem. We have captured your request for <b>${escapeHtml(actionLabel)}</b>.

You can chat instantly on WhatsApp below or share contact later anytime.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Chat on WhatsApp", url: getWhatsAppClickUrl(actionLabel) }],
          [{ text: "📊 Main Menu", callback_data: "ql_main" }],
        ],
      },
    }
  );
  return true;
}

// =======================
// SIP HELPERS
// =======================
async function getUserSips(chatId) {
  const { data, error } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq(USER_COL, String(chatId))
    .eq("is_active", true)
    .order("next_due_date", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function findSip(chatId, userTypedFundName) {
  const rows = await getUserSips(chatId);
  if (!rows.length) return null;

  const inputNorm = normalizeText(userTypedFundName);
  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    const score = scoreMatch(inputNorm, normalizeText(row[FUND_NAME_COL] || ""));
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return best && bestScore >= 2 ? best : null;
}

async function createOrUpdateSip(chatId, fundName, amount, frequency) {
  const scheme = await resolveSchemeByName(fundName);
  if (!scheme) {
    return {
      ok: false,
      message:
        `❌ Fund not found for SIP: <b>${escapeHtml(fundName)}</b>\n\n` +
        `Use format:\n<code>/sip hdfc flexi cap | 5000 | monthly</code>`,
    };
  }

  let existing = null;
  try {
    existing = await findSip(chatId, fundName);
  } catch (error) {
    if (isTableMissingError(error)) {
      return {
        ok: false,
        message:
          `❌ SIP table not found.\n\n` +
          `Create table <b>${escapeHtml(SIPS_TABLE)}</b> in Supabase first.`,
      };
    }
    throw error;
  }

  const payload = {
    [USER_COL]: String(chatId),
    [FUND_NAME_COL]: scheme.name,
    amount: round2(amount),
    frequency,
    [SCHEME_CODE_COL]: scheme.code,
    is_active: true,
    next_due_date: existing?.next_due_date || todayYmd(),
    updated_at: nowIso(),
  };

  if (existing && existing.id) {
    const { error } = await supabase
      .from(SIPS_TABLE)
      .update(payload)
      .eq("id", existing.id);

    if (error) throw error;

    return {
      ok: true,
      message:
        `✅ <b>SIP updated</b>\n\n` +
        `📌 Fund: <b>${escapeHtml(scheme.name)}</b>\n` +
        `💰 Amount: <b>${formatINR(amount)}</b>\n` +
        `🔁 Frequency: <b>${escapeHtml(frequency)}</b>\n` +
        `📅 Next Due: <b>${escapeHtml(formatDisplayDate(payload.next_due_date))}</b>`,
    };
  }

  payload.created_at = nowIso();

  const { error } = await supabase.from(SIPS_TABLE).insert(payload);
  if (error) throw error;

  return {
    ok: true,
    message:
      `✅ <b>SIP created</b>\n\n` +
      `📌 Fund: <b>${escapeHtml(scheme.name)}</b>\n` +
      `💰 Amount: <b>${formatINR(amount)}</b>\n` +
      `🔁 Frequency: <b>${escapeHtml(frequency)}</b>\n` +
      `📅 Next Due: <b>${escapeHtml(formatDisplayDate(payload.next_due_date))}</b>`,
  };
}

async function buildSipsText(chatId) {
  let rows;
  try {
    rows = await getUserSips(chatId);
  } catch (error) {
    if (isTableMissingError(error)) {
      return `❌ <b>SIP table not found.</b>\n\nCreate this table in Supabase: <code>${escapeHtml(SIPS_TABLE)}</code>`;
    }
    throw error;
  }

  if (!rows.length) {
    return `📭 <b>No active SIPs found.</b>\n\nUse:\n<code>/sip hdfc flexi cap | 5000 | monthly</code>`;
  }

  let totalMonthly = 0;
  const lines = [];

  for (const row of rows) {
    const amount = Number(row.amount || 0);
    totalMonthly += amount;

    lines.push(
      `• <b>${escapeHtml(row[FUND_NAME_COL] || "Unknown Fund")}</b>\n` +
      `  Amount: <b>${formatINR(amount)}</b>\n` +
      `  Frequency: <b>${escapeHtml(row.frequency || "monthly")}</b>\n` +
      `  Next Due: <b>${escapeHtml(formatDisplayDate(row.next_due_date))}</b>`
    );
  }

  return (
    `🔁 <b>Your SIPs</b>\n\n` +
    lines.join("\n\n") +
    `\n\n────────────\n` +
    `💸 Total Monthly SIP: <b>${formatINR(totalMonthly)}</b>`
  );
}

async function getSipSnapshot(chatId) {
  try {
    const rows = await getUserSips(chatId);
    const totalMonthly = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    return { count: rows.length, totalMonthly };
  } catch (error) {
    if (isTableMissingError(error)) return { count: 0, totalMonthly: 0 };
    throw error;
  }
}

async function getSipDigest(chatId) {
  try {
    const rows = await getUserSips(chatId);
    if (!rows.length) return "";
    const totalMonthly = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const nextDue = rows[0]?.next_due_date ? formatDisplayDate(rows[0].next_due_date) : "-";

    return (
      `\n\n🔁 <b>Active SIPs:</b> ${rows.length}` +
      `\n💸 <b>Total Monthly SIP:</b> ${formatINR(totalMonthly)}` +
      `\n📅 <b>Next SIP Due:</b> ${escapeHtml(nextDue)}`
    );
  } catch (error) {
    if (isTableMissingError(error)) return "";
    throw error;
  }
}

// =======================
// PORTFOLIO SNAPSHOT
// =======================
async function getPortfolioSnapshot(chatId) {
  const holdings = await getUserHoldings(chatId);

  if (!holdings.length) {
    return {
      totalInvested: 0,
      totalCurrent: 0,
      totalProfit: 0,
      totalPct: 0,
      topFund: null,
    };
  }

  await refreshNavCache(false);

  let totalInvested = 0;
  let totalCurrent = 0;
  let topFund = null;

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

    const item = { fundName, currentValue, invested, profit, returnPct };
    if (!topFund || item.currentValue > topFund.currentValue) {
      topFund = item;
    }
  }

  const totalProfit = totalCurrent - totalInvested;
  const totalPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  return {
    totalInvested,
    totalCurrent,
    totalProfit,
    totalPct,
    topFund,
  };
}

// =======================
// TELEGRAM ADMIN ALERT
// =======================
function getAdminChatIds() {
  return String(ADMIN_TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function sendAdminLeadAlert({ chatId, name, city, mobile, email, actionLabel }) {
  const adminChatIds = getAdminChatIds();
  if (!adminChatIds.length) {
    console.warn("Admin lead alert skipped: missing ADMIN_TELEGRAM_CHAT_ID");
    return { ok: false, skipped: true };
  }

  const portfolio = await getPortfolioSnapshot(chatId);
  const sip = await getSipSnapshot(chatId);
  const leadTime = formatLeadTimestamp();
  const userWhatsappUrl = getWhatsAppClickUrl(actionLabel || "Need help", mobile || "");
  const tgProfile = `tg://user?id=${chatId}`;

  const body =
    `🔥 <b>New MF Lead</b>\n\n` +
    `Name: <b>${escapeHtml(name || "Not provided")}</b>\n` +
    `City: <b>${escapeHtml(city || "Not provided")}</b>\n` +
    `Mobile: <b>${escapeHtml(mobile || "Not provided")}</b>\n` +
    `Email: <b>${escapeHtml(email || "Not provided")}</b>\n` +
    `Chat ID: <code>${chatId}</code>\n\n` +
    `Portfolio:\n` +
    `Invested: ${formatINR(portfolio.totalInvested)}\n` +
    `Current Value: ${formatINR(portfolio.totalCurrent)}\n` +
    `P/L: ${formatINR(portfolio.totalProfit)} (${portfolio.totalPct.toFixed(2)}%)\n` +
    `Top Fund: ${escapeHtml(portfolio.topFund?.fundName || "N/A")}\n\n` +
    `SIPs: ${sip.count}\n` +
    `Monthly SIP: ${formatINR(sip.totalMonthly)}\n\n` +
    `Action: <b>${escapeHtml(actionLabel || "Portfolio review interest captured")}</b>\n` +
    `Time: ${escapeHtml(leadTime)}\n\n` +
    `<a href="${userWhatsappUrl}">Open WhatsApp chat</a> | <a href="${tgProfile}">Open Telegram user</a>`;

  const results = [];
  for (const adminChatId of adminChatIds) {
    const result = await sendTelegramMessage(adminChatId, body);
    results.push(result);
  }
  const ok = results.some((r) => r?.ok);
  if (!ok) {
    console.error("Telegram admin lead alert failed:", results);
    return { ok: false, error: results };
  }
  return { ok: true, sent_to: adminChatIds };
}

// =======================
// CORE ACTIONS
// =======================
async function addFund(chatId, fundName, amount) {
  const scheme = await resolveSchemeByName(fundName);
  if (!scheme) {
    return {
      ok: false,
      message:
        `❌ Fund not found for: <b>${escapeHtml(fundName)}</b>\n\n` +
        `Try:\n<code>/add hdfc flexi cap | 5000</code>`,
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

    await upsertHoldingById(holding, {
      [USER_COL]: String(chatId),
      [FUND_NAME_COL]: scheme.name,
      [UNITS_COL]: round4(newUnits),
      [INVESTED_COL]: round2(newInvested),
      [AVG_NAV_COL]: round4(newAvgNav),
      [SCHEME_CODE_COL]: scheme.code,
      [LAST_NAV_COL]: round4(nav),
      [LAST_NAV_DATE_COL]: scheme.date,
      [UPDATED_AT_COL]: nowIso(),
    });
  } else {
    await upsertHoldingById(null, {
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
    });
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
    await upsertHoldingById(holding, {
      [UNITS_COL]: round4(newUnits),
      [INVESTED_COL]: round2(newInvested),
      [AVG_NAV_COL]: round4(newInvested / newUnits),
      [LAST_NAV_COL]: round4(currentNav),
      [LAST_NAV_DATE_COL]: scheme.date,
      [UPDATED_AT_COL]: nowIso(),
      [SCHEME_CODE_COL]: scheme.code || holding[SCHEME_CODE_COL],
      [FUND_NAME_COL]: scheme.name || holding[FUND_NAME_COL],
    });
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

    const item = { fundName, returnPct };
    if (!best || item.returnPct > best.returnPct) best = item;
    if (!worst || item.returnPct < worst.returnPct) worst = item;
  }

  const totalProfit = totalCurrent - totalInvested;
  const totalPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;
  const sipDigest = await getSipDigest(chatId);

  if (compact) {
    return (
      `📊 <b>Daily Portfolio Update</b>\n\n` +
      `💰 Invested: <b>${formatINR(totalInvested)}</b>\n` +
      `📈 Value: <b>${formatINR(totalCurrent)}</b>\n` +
      `📊 P/L: <b>${formatINR(totalProfit)} (${totalPct.toFixed(2)}%)</b>\n\n` +
      `🏆 Best: <b>${escapeHtml(best.fundName)}</b> (${best.returnPct.toFixed(2)}%)\n` +
      `⚠️ Worst: <b>${escapeHtml(worst.fundName)}</b> (${worst.returnPct.toFixed(2)}%)` +
      sipDigest
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
    `<b>${escapeHtml(worst.fundName)}</b> — ${worst.returnPct.toFixed(2)}%` +
    sipDigest +
    `\n\n💡 Want better returns?\n👉 Reply <b>YES</b> for free portfolio review`
  );
}

// =======================
// COMMAND HANDLER
// =======================
async function handleTextMessage(chatId, text) {
  const normalized = normalizeTelegramCommandText(String(text || "").trim());
  const lower = normalized.toLowerCase();

  try {
    if (lower === "yes") {
      await sendAutoLeadAlert(chatId, "Replied YES for portfolio review");
      await sendTelegramMessage(
        chatId,
        `🔥 <b>Great!</b>\n\nOur expert will connect with you shortly for portfolio review.`
      );
      console.log("NEW LEAD:", chatId);
      return;
    }

    const quickLeadAction = quickLeadTextToAction(text);
    if (quickLeadAction) {
      if (quickLeadAction === "ql_main") {
        await sendTelegramMessage(
          chatId,
          `Choose a quick lead option below:`,
          {
            reply_markup: {
              ...getQuickLeadReplyKeyboard("main"),
              inline_keyboard: getQuickLeadInlineKeyboard("main").inline_keyboard,
            },
          }
        );
        return;
      }

      if (quickLeadAction === "ql_investment") {
        await sendTelegramMessage(
          chatId,
          `Select your approximate mutual fund investment:`,
          {
            reply_markup: {
              ...getQuickLeadReplyKeyboard("investment"),
              inline_keyboard: getQuickLeadInlineKeyboard("investment").inline_keyboard,
            },
          }
        );
        return;
      }

      if (quickLeadAction === "ql_sip") {
        await sendTelegramMessage(
          chatId,
          `Select the SIP amount you are considering:`,
          {
            reply_markup: {
              ...getQuickLeadReplyKeyboard("sip"),
              inline_keyboard: getQuickLeadInlineKeyboard("sip").inline_keyboard,
            },
          }
        );
        return;
      }

      if (quickLeadAction === "ql_advice") {
        await sendTelegramMessage(
          chatId,
          `Choose what you want help with:`,
          {
            reply_markup: {
              ...getQuickLeadReplyKeyboard("advice"),
              inline_keyboard: getQuickLeadInlineKeyboard("advice").inline_keyboard,
            },
          }
        );
        return;
      }

      const label = quickLeadChoiceLabel(quickLeadAction);
      if (label) {
        await sendAutoLeadAlert(chatId, label);
        await sendTelegramMessage(
          chatId,
          `✅ <b>Request captured</b>

<b>${escapeHtml(label)}</b>

Our expert will connect with you shortly.`,
          {
            reply_markup: {
              ...getQuickLeadReplyKeyboard("main"),
              inline_keyboard: getQuickLeadInlineKeyboard("main").inline_keyboard,
            },
          }
        );
        await promptForContact(chatId, label);
        return;
      }
    }

    if (lower === "skip for now") {
      const skipped = await handleSkipForNow(chatId);
      if (skipped) return;
    }

    if (lower === "/start") {
      await sendTelegramMessage(
        chatId,
        `👋 <b>Mutual Fund Bot Ready</b>\n\n` +
        `Choose an option below to get started.\n\n` +
        `💡 Register to get personalized portfolio insights and faster support.`,
        { reply_markup: getQuickLeadInlineKeyboard("main") }
      );
      return;
    }

    if (lower === "/quicklead") {
      await sendTelegramMessage(
        chatId,
        `Choose a quick lead option below:`,
        {
          reply_markup: {
            ...getQuickLeadReplyKeyboard("main"),
            inline_keyboard: getQuickLeadInlineKeyboard("main").inline_keyboard,
          },
        }
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
        `4. Summary:\n<code>/summary</code>\n\n` +
        `5. Create or update SIP:\n<code>/sip hdfc flexi cap | 5000 | monthly</code>\n\n` +
        `6. View SIPs:\n<code>/sips</code>\n\n` +
        `7. Register yourself:\n<code>/register Rahul | Delhi | 8882332050 | rahul23jain@gmail.com</code>\n\n` +
        `8. Quick lead menu:\n<code>/quicklead</code>`
      );
      return;
    }

    if (lower.startsWith("/register ")) {
      const parsed = parseRegisterCommand(normalized);
      if (!parsed) {
        await sendTelegramMessage(
          chatId,
          `❌ Invalid register format.\n\nUse:\n<code>/register Rahul | Delhi | 8882332050 | rahul23jain@gmail.com</code>`
        );
        return;
      }

      const result = await registerUser(
        chatId,
        parsed.name,
        parsed.city,
        parsed.mobile,
        parsed.email
      );
      await sendTelegramMessage(chatId, result.message);
      return;
    }

    if (lower.startsWith("/add ")) {
      const parsed = parseFundAndAmount(normalized);
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
      const parsed = parseFundAndAmount(normalized);
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
      await sendTelegramMessage(chatId, await buildPortfolioText(chatId));
      return;
    }

    if (lower === "/summary") {
      await sendTelegramMessage(chatId, await buildSummary(chatId, false));
      await sendAutoLeadAlert(chatId, "Viewed /summary");
      return;
    }

    if (lower.startsWith("/sip ")) {
      const parsed = parseSipCommand(normalized);
      if (!parsed) {
        await sendTelegramMessage(
          chatId,
          `❌ Invalid SIP format.\n\nUse:\n<code>/sip hdfc flexi cap | 5000 | monthly</code>`
        );
        return;
      }

      const result = await createOrUpdateSip(
        chatId,
        parsed.fundName,
        parsed.amount,
        parsed.frequency
      );
      await sendTelegramMessage(chatId, result.message);
      return;
    }

    if (lower === "/sips") {
      await sendTelegramMessage(chatId, await buildSipsText(chatId));
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
// ROUTES
// =======================
app.post(WEBHOOK_PATH, async (req, res) => {
  res.status(200).send("ok");

  try {
    const update = req.body || {};

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message || !message.chat) return;

    if (message.contact) {
      await handleContactMessage(message);
      return;
    }

    if (!message.text) return;

    const handledManualPhone = await handleManualPhoneInput(message);
    if (handledManualPhone) return;

    await handleTextMessage(message.chat.id, message.text);
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

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

app.get("/cron/summary", async (req, res) => {
  try {
    if (String(req.query.token || "") !== CRON_SECRET) {
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

    res.json({ ok: true, totalUsers: chatIds.length, sent, skipped });
  } catch (err) {
    console.error("/cron/summary error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/cron/run-sips", async (req, res) => {
  try {
    if (String(req.query.token || "") !== CRON_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const today = todayYmd();
    const { data: dueRows, error } = await supabase
      .from(SIPS_TABLE)
      .select("*")
      .eq("is_active", true)
      .lte("next_due_date", today);

    if (error) throw error;

    let processed = 0;
    let failed = 0;

    for (const row of dueRows || []) {
      try {
        const out = await addFund(
          row[USER_COL],
          row[FUND_NAME_COL],
          Number(row.amount || 0)
        );
        if (!out.ok) throw new Error(out.message);

        const nextDue =
          String(row.frequency || "monthly").toLowerCase() === "monthly"
            ? addMonthsToYmd(row.next_due_date || today, 1)
            : today;

        const { error: updateError } = await supabase
          .from(SIPS_TABLE)
          .update({
            last_run_date: today,
            next_due_date: nextDue,
            updated_at: nowIso(),
          })
          .eq("id", row.id);

        if (updateError) throw updateError;

        await sendTelegramMessage(
          row[USER_COL],
          `🔁 <b>SIP executed</b>\n\n` +
          `📌 Fund: <b>${escapeHtml(row[FUND_NAME_COL])}</b>\n` +
          `💰 Amount: <b>${formatINR(row.amount)}</b>\n` +
          `📅 Next Due: <b>${escapeHtml(formatDisplayDate(nextDue))}</b>`
        );

        processed++;
      } catch (e) {
        console.error("SIP run failed:", e.message);
        failed++;
      }
    }

    res.json({
      ok: true,
      today,
      totalDue: (dueRows || []).length,
      processed,
      failed,
    });
  } catch (err) {
    console.error("/cron/run-sips error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/test-send", async (req, res) => {
  try {
    if (!req.query.chat_id) {
      return res.status(400).json({ ok: false, error: "chat_id required" });
    }

    const out = await sendTelegramMessage(
      req.query.chat_id,
      escapeHtml(String(req.query.msg || "Test message from bot"))
    );

    res.json({ ok: true, result: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =======================
// START
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

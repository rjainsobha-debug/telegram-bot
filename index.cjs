const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!TOKEN) {
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

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Existing holdings table
const HOLDINGS_TABLE = "portfolios";
// New SIP table
const SIPS_TABLE = "mf_sips";

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
    maximumFractionDigits: 2
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

async function sendTelegramMessage(chatId, text) {
  try {
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
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

async function findFund(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  const res = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    throw new Error(`MFAPI search failed: ${res.status}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

async function getFundDetails(schemeCode) {
  const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
  if (!res.ok) {
    throw new Error(`MFAPI details failed: ${res.status}`);
  }
  return res.json();
}

async function getLatestNav(schemeCode) {
  const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}/latest`);

  if (res.ok) {
    const latestData = await res.json();

    if (latestData && latestData.meta && Array.isArray(latestData.data) && latestData.data[0]) {
      return {
        schemeName: latestData.meta.scheme_name || "",
        nav: parseFloat(latestData.data[0].nav),
        date: latestData.data[0].date
      };
    }
  }

  const navData = await getFundDetails(schemeCode);
  const latest = navData && navData.data && navData.data[0] ? navData.data[0] : null;

  if (!latest) return null;

  return {
    schemeName: navData.meta ? navData.meta.scheme_name : "",
    nav: parseFloat(latest.nav),
    date: latest.date
  };
}

async function getPortfolio(chatId) {
  const { data, error } = await supabase
    .from(HOLDINGS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function getSips(chatId) {
  const { data, error } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function findHolding(chatId, query) {
  const portfolio = await getPortfolio(chatId);
  const q = normalizeText(query);

  let exact = portfolio.find(
    (p) =>
      normalizeText(p.scheme_name) === q ||
      String(p.scheme_code).trim() === String(query).trim()
  );
  if (exact) return exact;

  let starts = portfolio.find((p) =>
    normalizeText(p.scheme_name).startsWith(q)
  );
  if (starts) return starts;

  const contains = portfolio.filter((p) =>
    normalizeText(p.scheme_name).includes(q)
  );

  return contains[0] || null;
}

async function findSip(chatId, query) {
  const sips = await getSips(chatId);
  const q = normalizeText(query);

  let exact = sips.find(
    (p) =>
      normalizeText(p.scheme_name) === q ||
      String(p.scheme_code).trim() === String(query).trim()
  );
  if (exact) return exact;

  let starts = sips.find((p) =>
    normalizeText(p.scheme_name).startsWith(q)
  );
  if (starts) return starts;

  const contains = sips.filter((p) =>
    normalizeText(p.scheme_name).includes(q)
  );

  return contains[0] || null;
}

async function upsertSip(chatId, schemeCode, schemeName, sipAmount) {
  const { data: existingRows, error: fetchError } = await supabase
    .from(SIPS_TABLE)
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode))
    .limit(1);

  if (fetchError) throw fetchError;

  const existing = existingRows && existingRows.length ? existingRows[0] : null;

  if (!existing) {
    const { error } = await supabase.from(SIPS_TABLE).insert([
      {
        chat_id: String(chatId),
        scheme_code: String(schemeCode),
        scheme_name: schemeName,
        sip_amount: Number(sipAmount),
        is_active: true
      }
    ]);

    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from(SIPS_TABLE)
    .update({
      scheme_name: schemeName,
      sip_amount: Number(sipAmount),
      is_active: true
    })
    .eq("chat_id", String(chatId))
    .eq("scheme_code", String(schemeCode));

  if (error) throw error;
}

async function buildPortfolioText(chatId) {
  const userPortfolio = await getPortfolio(chatId);

  if (!userPortfolio.length) {
    return "Your portfolio is empty.\nUse:\n/add fund name | amount";
  }

  let totalInvested = 0;
  let totalCurrentValue = 0;
  const lines = ["📁 Your Portfolio\n"];

  for (const item of userPortfolio) {
    try {
      const latest = await getLatestNav(item.scheme_code);
      if (!latest) continue;

      const invested = Number(item.invested_amount || 0);
      const units = Number(item.units || 0);
      const currentValue = units * Number(latest.nav);
      const gain = currentValue - invested;
      const gainPct = simpleReturnPct(currentValue, invested);

      totalInvested += invested;
      totalCurrentValue += currentValue;

      lines.push(
        `${item.scheme_name}
Invested: ${formatINR(invested)}
Current: ${formatINR(currentValue)}
Profit/Loss: ${formatINR(gain)} (${formatPct(gainPct)})
Units: ${units.toFixed(4)}
NAV: ${formatINR(latest.nav)}
`
      );
    } catch (err) {
      console.error("Portfolio item error:", err);
    }
  }

  const totalGain = totalCurrentValue - totalInvested;
  const totalGainPct = simpleReturnPct(totalCurrentValue, totalInvested);

  lines.push(
    `--------------------
Total Invested: ${formatINR(totalInvested)}
Current Value: ${formatINR(totalCurrentValue)}
Total Profit/Loss: ${formatINR(totalGain)} (${formatPct(totalGainPct)})`
  );

  return lines.join("\n");
}

async function buildSummaryText(chatId) {
  const userPortfolio = await getPortfolio(chatId);
  const sips = await getSips(chatId);

  if (!userPortfolio.length && !sips.length) {
    return "No data found.\nUse /add and /addsip first.";
  }

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let summary = "📊 Daily Summary\n\n";

  if (userPortfolio.length) {
    summary += "Portfolio\n";

    for (const item of userPortfolio) {
      try {
        const latest = await getLatestNav(item.scheme_code);
        if (!latest) continue;

        const invested = Number(item.invested_amount || 0);
        const currentValue = Number(item.units || 0) * Number(latest.nav);
        const gain = currentValue - invested;
        const gainPct = simpleReturnPct(currentValue, invested);

        totalInvested += invested;
        totalCurrentValue += currentValue;

        summary += `\n${item.scheme_name}
Invested: ${formatINR(invested)}
Current: ${formatINR(currentValue)}
P/L: ${formatINR(gain)} (${formatPct(gainPct)})
`;
      } catch (err) {
        console.error("Summary item error:", err);
      }
    }

    const totalGain = totalCurrentValue - totalInvested;
    const totalGainPct = simpleReturnPct(totalCurrentValue, totalInvested);

    summary += `
Total Invested: ${formatINR(totalInvested)}
Total Current: ${formatINR(totalCurrentValue)}
Total P/L: ${formatINR(totalGain)} (${formatPct(totalGainPct)})
`;
  }

  if (sips.length) {
    const activeSips = sips.filter((x) => x.is_active !== false);
    const totalSip = activeSips.reduce((sum, x) => sum + Number(x.sip_amount || 0), 0);

    summary += `

SIP Summary
Active SIPs: ${activeSips.length}
Monthly SIP Total: ${formatINR(totalSip)}
`;

    for (const sip of activeSips) {
      summary += `${sip.scheme_name} — ${formatINR(sip.sip_amount)}/month\n`;
    }
  }

  return summary;
}

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
        "Welcome to WealthNest 📊\n\n" +
        "Commands:\n" +
        "/nav fundname\n" +
        "/add fund name | amount\n" +
        "/remove fundname\n" +
        "/portfolio\n" +
        "/addsip fund name | monthly amount\n" +
        "/removesip fundname\n" +
        "/sips\n" +
        "/summary";
    }

    else if (text.startsWith("/nav")) {
      const query = rawText.replace("/nav", "").trim();

      if (!query) {
        reply = "Please enter fund name.\nExample:\n/nav HDFC Flexi Cap";
      } else {
        try {
          const fund = await findFund(query);
          if (!fund) {
            reply = "Fund not found.";
          } else {
            const latest = await getLatestNav(fund.schemeCode);
            if (!latest) {
              reply = "NAV data not available.";
            } else {
              reply =
                `📊 ${latest.schemeName}\n\n` +
                `NAV: ${formatINR(latest.nav)}\n` +
                `Date: ${latest.date}`;
            }
          }
        } catch (err) {
          console.error("NAV error:", err);
          reply = "Error fetching data: " + (err.message || "unknown error");
        }
      }
    }

    else if (text.startsWith("/addsip")) {
      const body = rawText.replace("/addsip", "").trim();

      if (!body.includes("|")) {
        reply = "Invalid format.\nUse:\n/addsip fund name | monthly amount";
      } else {
        const [fundNameRaw, amountRaw] = body.split("|");
        const fundName = (fundNameRaw || "").trim();
        const sipAmount = parseFloat((amountRaw || "").trim());

        if (!fundName || Number.isNaN(sipAmount) || sipAmount <= 0) {
          reply = "Please enter valid fund name and SIP amount.";
        } else {
          try {
            const fund = await findFund(fundName);

            if (!fund) {
              reply = "Fund not found.";
            } else {
              const latest = await getLatestNav(fund.schemeCode);
              if (!latest) {
                reply = "NAV data not available.";
              } else {
                await upsertSip(chatId, fund.schemeCode, latest.schemeName, sipAmount);
                reply =
                  `✅ SIP added/updated\n\n` +
                  `Fund: ${latest.schemeName}\n` +
                  `Monthly SIP: ${formatINR(sipAmount)}`;
              }
            }
          } catch (err) {
            console.error("Add SIP error:", err);
            reply = "Error adding SIP: " + (err.message || "unknown error");
          }
        }
      }
    }

    else if (text.startsWith("/removesip")) {
      const query = rawText.replace("/removesip", "").trim();

      if (!query) {
        reply = "Use:\n/removesip fundname";
      } else {
        try {
          const sip = await findSip(chatId, query);
          if (!sip) {
            reply = "SIP not found.";
          } else {
            const { error } = await supabase
              .from(SIPS_TABLE)
              .delete()
              .eq("chat_id", String(chatId))
              .eq("scheme_code", String(sip.scheme_code));

            if (error) {
              console.error("Remove SIP error:", error);
              reply = "Error removing SIP.";
            } else {
              reply = `Removed SIP:\n${sip.scheme_name}`;
            }
          }
        } catch (err) {
          console.error("Remove SIP error:", err);
          reply = "Error removing SIP: " + (err.message || "unknown error");
        }
      }
    }

    else if (text === "/sips") {
      try {
        const sips = await getSips(chatId);
        const activeSips = sips.filter((x) => x.is_active !== false);

        if (!activeSips.length) {
          reply = "No active SIPs found.\nUse:\n/addsip fund name | amount";
        } else {
          let total = 0;
          const lines = ["💰 Active SIPs\n"];

          for (const sip of activeSips) {
            total += Number(sip.sip_amount || 0);
            lines.push(`${sip.scheme_name} — ${formatINR(sip.sip_amount)}/month`);
          }

          lines.push(`\nTotal Monthly SIP: ${formatINR(total)}`);
          reply = lines.join("\n");
        }
      } catch (err) {
        console.error("SIP list error:", err);
        reply = "Error fetching SIPs: " + (err.message || "unknown error");
      }
    }

    else if (text.startsWith("/add")) {
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
              const latest = await getLatestNav(fund.schemeCode);

              if (!latest) {
                reply = "NAV data not available.";
              } else {
                const units = amount / latest.nav;

                const { error } = await supabase.from(HOLDINGS_TABLE).insert([
                  {
                    chat_id: chatId,
                    scheme_name: latest.schemeName,
                    scheme_code: String(fund.schemeCode),
                    invested_amount: amount,
                    units
                  }
                ]);

                if (error) {
                  console.error("Supabase insert error:", error);
                  reply = "Error saving portfolio: " + error.message;
                } else {
                  reply =
                    `✅ Added to portfolio\n\n` +
                    `Fund: ${latest.schemeName}\n` +
                    `Invested: ${formatINR(amount)}\n` +
                    `NAV: ${formatINR(latest.nav)}\n` +
                    `Units: ${units.toFixed(4)}`;
                }
              }
            }
          } catch (err) {
            console.error("Add error:", err);
            reply = "Error adding fund: " + (err.message || "unknown error");
          }
        }
      }
    }

    else if (text.startsWith("/remove")) {
      const query = rawText.replace("/remove", "").trim();

      if (!query) {
        reply = "Use:\n/remove fundname";
      } else {
        try {
          const holding = await findHolding(chatId, query);
          if (!holding) {
            reply = "Holding not found.";
          } else {
            const { error } = await supabase
              .from(HOLDINGS_TABLE)
              .delete()
              .eq("chat_id", String(chatId))
              .eq("scheme_code", String(holding.scheme_code));

            if (error) {
              console.error("Remove holding error:", error);
              reply = "Error removing holding.";
            } else {
              reply = `Removed holding:\n${holding.scheme_name}`;
            }
          }
        } catch (err) {
          console.error("Remove holding error:", err);
          reply = "Error removing holding: " + (err.message || "unknown error");
        }
      }
    }

    else if (text === "/portfolio") {
      try {
        reply = await buildPortfolioText(chatId);
      } catch (err) {
        console.error("Portfolio error:", err);
        reply = "Error fetching portfolio: " + (err.message || "unknown error");
      }
    }

    else if (text === "/summary") {
      try {
        reply = await buildSummaryText(chatId);
      } catch (err) {
        console.error("Summary error:", err);
        reply = "Error generating summary: " + (err.message || "unknown error");
      }
    }

    else {
      reply =
        "Unknown command.\n\n" +
        "Use:\n" +
        "/start\n" +
        "/nav fundname\n" +
        "/add fund | amount\n" +
        "/remove fundname\n" +
        "/portfolio\n" +
        "/addsip fund | amount\n" +
        "/removesip fundname\n" +
        "/sips\n" +
        "/summary";
    }

    await sendTelegramMessage(chatId, reply);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

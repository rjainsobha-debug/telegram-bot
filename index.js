import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

console.log("Token exists:", !!TOKEN);

// Temporary in-memory portfolio store
// Format:
// portfolios[chatId] = [
//   { schemeName, schemeCode, investedAmount, units }
// ]
const portfolios = {};

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

app.post("/webhook", async (req, res) => {
  console.log("Webhook hit");

  try {
    const message = req.body.message;

    if (!message) return res.send("ok");

    const chatId = message.chat.id;
    const rawText = (message.text || "").trim();
    const text = rawText.toLowerCase();

    let reply = "Command received.";

    if (text === "/start") {
      reply =
        "Welcome to WealthNest 📊\n\nCommands:\n/nav fundname\n/add fund name | amount\n/portfolio\n/ping\n/help";

    } else if (text === "/ping") {
      reply = "Bot is live ✅";

    } else if (text === "/help") {
      reply =
        "Commands:\n/nav fundname\n/add fund name | amount\n/portfolio\n\nExamples:\n/nav hdfc flexi cap\n/add hdfc flexi cap | 50000";

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
              reply =
`📊 ${navData.meta.scheme_name}

NAV: ₹${latest.nav}
Date: ${latest.date}`;
            }
          }
        } catch (err) {
          console.error("NAV error:", err);
          reply = "Error fetching data.";
        }
      }

    } else if (text.startsWith("/add")) {
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

                if (!portfolios[chatId]) {
                  portfolios[chatId] = [];
                }

                portfolios[chatId].push({
                  schemeName: navData.meta.scheme_name,
                  schemeCode: fund.schemeCode,
                  investedAmount: amount,
                  units
                });

                reply =
`✅ Added to portfolio

Fund: ${navData.meta.scheme_name}
Invested: ₹${amount.toFixed(2)}
NAV: ₹${nav.toFixed(2)}
Units: ${units.toFixed(4)}`;
              }
            }
          } catch (err) {
            console.error("Add error:", err);
            reply = "Error adding fund.";
          }
        }
      }

    } else if (text === "/portfolio") {
      try {
        const userPortfolio = portfolios[chatId] || [];

        if (userPortfolio.length === 0) {
          reply = "Your portfolio is empty.\nUse:\n/add fund name | amount";
        } else {
          let totalInvested = 0;
          let totalCurrentValue = 0;
          let lines = ["📁 Your Portfolio\n"];

          for (const item of userPortfolio) {
            const navData = await getFundDetails(item.schemeCode);
            const latest = navData.data?.[0];

            if (!latest) continue;

            const currentNav = parseFloat(latest.nav);
            const currentValue = item.units * currentNav;
            const gain = currentValue - item.investedAmount;

            totalInvested += item.investedAmount;
            totalCurrentValue += currentValue;

            lines.push(
`${item.schemeName}
Invested: ₹${item.investedAmount.toFixed(2)}
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

    } else if (text.length > 0) {
      reply = `You said: ${rawText}`;
    }

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    });

    res.send("ok");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("error");
  }
});

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

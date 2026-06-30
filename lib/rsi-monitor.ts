// Watches MNQ + MES on 1-minute bars and fires a Telegram alert when RSI(13)
// CROSSES above 75 (overbought) or below 30 (oversold). Each new closed bar is
// evaluated once, so an alert fires on the crossing bar — not repeatedly while
// RSI stays in the zone.

import { hasCredentials, retrieveBars, searchContracts } from "./topstepx";
import { lastTwoRsi } from "./rsi";
import { sendAlert } from "./telegram";

const SYMBOLS = ["MNQ"];
const RSI_PERIOD = 13;
const OVERBOUGHT = 75;
const OVERSOLD = 30;
const BAR_UNIT = 2; // minute
const BAR_UNIT_NUMBER = 1; // 1-minute
const BAR_LIMIT = 200;

// Process-lifetime state (resets on server restart — fine for a polling monitor).
const lastBarBySymbol = new Map<string, string>();
const contractCache = new Map<string, string>();

async function resolveContractId(symbol: string): Promise<string | null> {
  if (contractCache.has(symbol)) return contractCache.get(symbol)!;
  const contracts = await searchContracts(symbol, false);
  // Prefer the active front-month contract whose root matches the symbol.
  const match =
    contracts.find((c) => c.activeContract && rootOf(c.id) === symbol) ??
    contracts.find((c) => rootOf(c.id) === symbol) ??
    contracts[0];
  if (!match) return null;
  contractCache.set(symbol, match.id);
  return match.id;
}

function rootOf(contractId: string): string {
  const parts = contractId.split(".");
  return parts.length >= 4 ? parts[3] : contractId;
}

export interface SymbolCheck {
  symbol: string;
  contractId?: string;
  rsi?: number;
  prevRsi?: number;
  cross?: "overbought" | "oversold";
  alerted: boolean;
  note?: string;
}

export async function checkRsi(): Promise<{ checkedAt: string; results: SymbolCheck[] }> {
  const results: SymbolCheck[] = [];
  if (!hasCredentials()) {
    return { checkedAt: new Date().toISOString(), results: [{ symbol: "—", alerted: false, note: "no API credentials" }] };
  }

  for (const symbol of SYMBOLS) {
    try {
      const contractId = await resolveContractId(symbol);
      if (!contractId) {
        results.push({ symbol, alerted: false, note: "contract not found" });
        continue;
      }
      const bars = await retrieveBars(contractId, BAR_UNIT, BAR_UNIT_NUMBER, BAR_LIMIT);
      if (bars.length < RSI_PERIOD + 2) {
        results.push({ symbol, contractId, alerted: false, note: "not enough bars" });
        continue;
      }
      const latestBarTime = bars[bars.length - 1].t;
      const closes = bars.map((b) => b.c);
      const pair = lastTwoRsi(closes, RSI_PERIOD);
      if (!pair) {
        results.push({ symbol, contractId, alerted: false, note: "RSI unavailable" });
        continue;
      }
      const [prevRsi, rsi] = pair;

      // Only evaluate a brand-new closed bar so we don't re-alert within a minute.
      if (lastBarBySymbol.get(symbol) === latestBarTime) {
        results.push({ symbol, contractId, rsi: round1(rsi), prevRsi: round1(prevRsi), alerted: false, note: "no new bar" });
        continue;
      }

      let cross: SymbolCheck["cross"];
      if (prevRsi <= OVERBOUGHT && rsi > OVERBOUGHT) cross = "overbought";
      else if (prevRsi >= OVERSOLD && rsi < OVERSOLD) cross = "oversold";

      let alerted = false;
      if (cross) {
        const msg =
          cross === "overbought"
            ? `🔴 ${symbol} RSI crossed ABOVE 75 (overbought)\nRSI = ${rsi.toFixed(1)} on the 1-minute chart.`
            : `🟢 ${symbol} RSI crossed BELOW 30 (oversold)\nRSI = ${rsi.toFixed(1)} on the 1-minute chart.`;
        const sent = await sendAlert(msg);
        alerted = sent.sent > 0;
        if (!alerted && sent.reason) {
          results.push({ symbol, contractId, rsi: round1(rsi), prevRsi: round1(prevRsi), cross, alerted, note: sent.reason });
          lastBarBySymbol.set(symbol, latestBarTime);
          continue;
        }
      }

      lastBarBySymbol.set(symbol, latestBarTime);
      results.push({ symbol, contractId, rsi: round1(rsi), prevRsi: round1(prevRsi), cross, alerted });
    } catch (err) {
      results.push({ symbol, alerted: false, note: err instanceof Error ? err.message : "error" });
    }
  }

  return { checkedAt: new Date().toISOString(), results };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

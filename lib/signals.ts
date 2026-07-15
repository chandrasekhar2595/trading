// Rules-based MNQ buy/sell signal: a higher-timeframe trend filter, then either a
// breakout WITH the trend or a mean-reversion pullback AGAINST a short-term stretch.
//
// This is a heuristic edge, NOT a guarantee. It's decision support — always use
// your own risk management.

import type { Bar } from "./topstepx";
import { ema, rollingVwap } from "./indicators";
import { rsiSeries } from "./rsi";

export type Trend = "up" | "down" | "neutral";
export type Direction = "BUY" | "SELL" | "NEUTRAL";
export type SignalType = "breakout" | "mean-reversion" | "none";

export interface Signal {
  direction: Direction;
  type: SignalType;
  trend: Trend;
  price: number;
  rsi: number;
  vwap: number;
  priorHourHigh: number;
  priorHourLow: number;
  reason: string;
}

const RSI_PERIOD = 13;

/** Trend from 15-minute EMAs: price vs EMA50 and EMA20 vs EMA50. */
export function computeTrend(bars15m: Bar[]): Trend {
  const closes = bars15m.map((b) => b.c);
  if (closes.length < 50) return "neutral";
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const i = closes.length - 1;
  const price = closes[i];
  if (price > e50[i] && e20[i] > e50[i]) return "up";
  if (price < e50[i] && e20[i] < e50[i]) return "down";
  return "neutral";
}

export function computeSignal(bars5m: Bar[], bars15m: Bar[], barsHourly: Bar[]): Signal {
  const trend = computeTrend(bars15m);
  const closes = bars5m.map((b) => b.c);
  const price = closes[closes.length - 1] ?? 0;

  const rsiArr = rsiSeries(closes, RSI_PERIOD);
  const rsi = rsiArr[rsiArr.length - 1] ?? NaN;
  const rsiPrev = rsiArr[rsiArr.length - 2] ?? rsi;
  const rsiTurningUp = rsi > rsiPrev;
  const rsiTurningDown = rsi < rsiPrev;

  const vwap = rollingVwap(bars5m, 24); // ~2h of 5-min bars
  const lastHour = barsHourly[barsHourly.length - 1];
  const priorHourHigh = lastHour?.h ?? price;
  const priorHourLow = lastHour?.l ?? price;

  let direction: Direction = "NEUTRAL";
  let type: SignalType = "none";
  let reason = `No edge right now — ${trend === "neutral" ? "trend is choppy, stand aside" : `${trend}trend but no trigger`}.`;

  if (trend === "up") {
    if (price > priorHourHigh) {
      direction = "BUY";
      type = "breakout";
      reason = `Uptrend + price broke the prior-hour high (${priorHourHigh.toFixed(0)}). Momentum long.`;
    } else if (price <= vwap && rsi < 40 && rsiTurningUp) {
      direction = "BUY";
      type = "mean-reversion";
      reason = `Uptrend pullback to VWAP with RSI ${rsi.toFixed(0)} turning up. Buy the dip.`;
    }
  } else if (trend === "down") {
    if (price < priorHourLow) {
      direction = "SELL";
      type = "breakout";
      reason = `Downtrend + price broke the prior-hour low (${priorHourLow.toFixed(0)}). Momentum short.`;
    } else if (price >= vwap && rsi > 60 && rsiTurningDown) {
      direction = "SELL";
      type = "mean-reversion";
      reason = `Downtrend pop to VWAP with RSI ${rsi.toFixed(0)} turning down. Sell the rip.`;
    }
  }

  return {
    direction,
    type,
    trend,
    price: round2(price),
    rsi: Number.isNaN(rsi) ? 0 : Math.round(rsi * 10) / 10,
    vwap: round2(vwap),
    priorHourHigh: round2(priorHourHigh),
    priorHourLow: round2(priorHourLow),
    reason,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

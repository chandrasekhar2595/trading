// Fetches MNQ bars across timeframes and produces the live signal + best-hours
// analysis. Uses topstepx.retrieveBars, which auto-relogins on a 401 (so it's
// resilient to the single-session token invalidation from the RSI cron).

import { hasCredentials, retrieveBars, searchContracts, type Bar } from "./topstepx";
import { computeSignal, type Signal } from "./signals";

const MNQ_POINT_VALUE = 2; // $ per point for MNQ
const TZ = process.env.TOPSTEP_TZ ?? "America/Chicago";

let cachedContractId: string | null = null;

async function mnqContractId(): Promise<string> {
  if (cachedContractId) return cachedContractId;
  try {
    const contracts = await searchContracts("MNQ", false);
    const match =
      contracts.find((c) => c.activeContract && c.id.includes(".MNQ.")) ??
      contracts.find((c) => c.id.includes(".MNQ.")) ??
      contracts[0];
    cachedContractId = match?.id ?? "CON.F.US.MNQ.U26";
  } catch {
    cachedContractId = "CON.F.US.MNQ.U26";
  }
  return cachedContractId;
}

export interface HourStat {
  hour: number; // hour of day in the trading timezone (CT)
  n: number;
  avgRangeUsd: number; // typical high-low range in $
  avgMoveUsd: number; // avg close-open in $ (directional bias)
  upPct: number; // % of hours that closed green
}

export interface MarketSignal {
  contractId: string;
  signal: Signal;
  bestHours: HourStat[];
  updatedAt: string;
  warning?: string;
}

function ctHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(
      new Date(iso)
    )
  );
}

function computeBestHours(hourlyBars: Bar[]): HourStat[] {
  const byHour = new Map<number, { range: number[]; move: number[] }>();
  for (const b of hourlyBars) {
    const h = ctHour(b.t);
    const row = byHour.get(h) ?? { range: [], move: [] };
    row.range.push(b.h - b.l);
    row.move.push(b.c - b.o);
    byHour.set(h, row);
  }
  const stats: HourStat[] = [];
  for (const [hour, { range, move }] of byHour) {
    const n = range.length;
    const avgRange = (range.reduce((a, b) => a + b, 0) / n) * MNQ_POINT_VALUE;
    const avgMove = (move.reduce((a, b) => a + b, 0) / n) * MNQ_POINT_VALUE;
    const upPct = (100 * move.filter((m) => m > 0).length) / n;
    stats.push({
      hour,
      n,
      avgRangeUsd: Math.round(avgRange),
      avgMoveUsd: Math.round(avgMove),
      upPct: Math.round(upPct),
    });
  }
  return stats.sort((a, b) => a.hour - b.hour);
}

export async function getMarketSignal(): Promise<MarketSignal> {
  if (!hasCredentials()) {
    return {
      contractId: "—",
      signal: {
        direction: "NEUTRAL",
        type: "none",
        trend: "neutral",
        price: 0,
        rsi: 0,
        vwap: 0,
        priorHourHigh: 0,
        priorHourLow: 0,
        reason: "No API credentials.",
      },
      bestHours: [],
      updatedAt: new Date().toISOString(),
      warning: "No API credentials set.",
    };
  }

  const cid = await mnqContractId();
  // Sequential (not parallel) to avoid three concurrent logins racing the token.
  const bars5m = await retrieveBars(cid, 2, 5, 120); // 5-minute
  const bars15m = await retrieveBars(cid, 2, 15, 120); // 15-minute
  const barsHourly = await retrieveBars(cid, 3, 1, 350); // ~14 days of hourly

  const signal = computeSignal(bars5m, bars15m, barsHourly);
  const bestHours = computeBestHours(barsHourly);

  return {
    contractId: cid,
    signal,
    bestHours,
    updatedAt: new Date().toISOString(),
  };
}

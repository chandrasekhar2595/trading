// Builds a full dashboard snapshot: fetch from TopstepX, derive daily stats and
// the equity high-water mark from trade history, then run the rules engine.

import {
  RTC_URL,
  getRealtimeToken,
  hasCredentials,
  searchAccounts,
  searchContract,
  searchOpenPositions,
  searchTrades,
  selectAccount,
  type TsPosition,
  type TsTrade,
} from "./topstepx";
import {
  COMBINE_CONFIGS,
  evaluate,
  type AccountSize,
  type CombineConfig,
  type EngineResult,
} from "./rules";

const TZ = process.env.TOPSTEP_TZ ?? "America/Chicago";

export interface PositionView {
  contractId: string;
  side: "Long" | "Short";
  size: number;
  averagePrice: number;
  /** $ per 1.0 move in price, per contract (tickValue / tickSize). */
  pointValue: number;
}

export interface RealtimeInfo {
  token: string;
  rtcUrl: string;
  accountId: number;
  contractIds: string[];
}

// Fallback $/point for common CME futures when the contract API can't be reached.
const FALLBACK_POINT_VALUES: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, RTY: 50, M2K: 5, YM: 5, MYM: 0.5,
  CL: 1000, MCL: 100, GC: 100, MGC: 10, SI: 5000, NG: 10000, MNG: 1000,
  "6E": 125000, "6B": 62500, "6J": 12500000, ZB: 1000, ZN: 1000, ZF: 1000,
};

function contractRoot(contractId: string): string {
  // e.g. "CON.F.US.MES.U26" -> "MES"
  const parts = contractId.split(".");
  return parts.length >= 4 ? parts[3] : contractId;
}

function fallbackPointValue(contractId: string): number {
  return FALLBACK_POINT_VALUES[contractRoot(contractId)] ?? 1;
}

/** Infer the Combine size from the account name, e.g. "150KTC-V2-..." -> "150K". */
export function sizeFromName(name: string): AccountSize {
  const m = name.match(/(\d+)K/i);
  const n = m ? Number(m[1]) : 0;
  if (n >= 150) return "150K";
  if (n >= 100) return "100K";
  return "50K";
}

export interface AccountListItem {
  id: number;
  name: string;
  balance: number;
  size: AccountSize;
  canTrade: boolean;
  simulated: boolean;
  /** V2 accounts with "DLL" in the name carry a Daily Loss Limit rule. */
  hasDailyLossLimit: boolean;
}

/**
 * Eligibility matches what TopstepX marks in its own account switcher: an account
 * is eligible only if it's a DLL-rule account AND currently in profit (balance
 * above its starting balance). Non-DLL "Trading Combine" accounts (the retired
 * product) and DLL accounts below their start are all ineligible.
 */
function isEligible(a: AccountListItem): boolean {
  return (
    a.canTrade && a.hasDailyLossLimit && a.balance > COMBINE_CONFIGS[a.size].startingBalance
  );
}

/** Active, eligible accounts only, sorted by balance (highest first). */
export async function listAccounts(): Promise<AccountListItem[]> {
  if (!hasCredentials()) return [];
  const accounts = await searchAccounts();
  return accounts
    .map((a) => ({
      id: a.id,
      name: a.name,
      balance: a.balance,
      size: sizeFromName(a.name),
      canTrade: a.canTrade,
      simulated: Boolean(a.simulated),
      hasDailyLossLimit: /DLL/i.test(a.name),
    }))
    .filter(isEligible)
    .sort((a, b) => b.balance - a.balance);
}

export interface DailyPnl {
  day: string;
  pnl: number;
  /** Round-turn trades closed that day (position-closing fills). */
  trades: number;
}

export interface HourlyPerf {
  hour: number; // CT clock hour 0-23
  netUsd: number;
  trades: number;
  winRate: number; // % of closing fills that were green
}

function ctClockHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(
      new Date(iso)
    )
  );
}

/** The account's realized P&L and win-rate grouped by hour of day (CT). */
function deriveHourlyPerformance(trades: TsTrade[]): HourlyPerf[] {
  const byHour = new Map<number, { net: number; wins: number; n: number }>();
  for (const t of trades) {
    if (t.voided) continue;
    const hour = ctClockHour(t.creationTimestamp);
    const row = byHour.get(hour) ?? { net: 0, wins: 0, n: 0 };
    row.net += (t.profitAndLoss ?? 0) - (t.fees ?? 0) - (t.commissions ?? 0);
    if (t.profitAndLoss != null) {
      row.n += 1;
      if (t.profitAndLoss > 0) row.wins += 1;
    }
    byHour.set(hour, row);
  }
  return [...byHour.entries()]
    .map(([hour, v]) => ({
      hour,
      netUsd: Math.round(v.net),
      trades: v.n,
      winRate: v.n ? Math.round((100 * v.wins) / v.n) : 0,
    }))
    .sort((a, b) => a.hour - b.hour);
}

export interface Snapshot {
  source: "live" | "demo";
  accountId: number | null;
  accountName: string;
  size: AccountSize;
  config: CombineConfig;
  balance: number;
  unrealizedPnl: number;
  peakEquity: number;
  positions: PositionView[];
  dailyPnl: DailyPnl[];
  hourlyPerformance: HourlyPerf[];
  result: EngineResult;
  realtime: RealtimeInfo | null;
  /** Current Topstep session day (for picking out today's P&L client-side). */
  currentSessionDay: string;
  /** Whether this account carries a Daily Loss Limit (DLL-rule account). */
  hasDailyLossLimit: boolean;
  updatedAt: string;
  warning?: string;
}

function dayKey(iso: string): string {
  // Topstep's trading day runs on a 5pm-CT session boundary: anything from 17:00
  // CT onward counts toward the NEXT calendar day's session. Get the wall-clock
  // date + hour in the trading timezone (DST-safe), then roll forward if >= 17:00.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let [y, m, d] = [get("year"), get("month"), get("day")];
  if (get("hour") >= 17) {
    const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function deriveDailyPnl(trades: TsTrade[]): DailyPnl[] {
  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    if (t.voided) continue; // cancelled/voided fills don't affect the account
    const key = dayKey(t.creationTimestamp);
    const row = byDay.get(key) ?? { pnl: 0, trades: 0 };
    // Fees + commissions are charged on EVERY fill (entry and exit); realized P&L
    // only lands on the closing (exit) fill, which is what we count as a trade.
    row.pnl -= (t.fees ?? 0) + (t.commissions ?? 0);
    if (t.profitAndLoss != null) {
      row.pnl += t.profitAndLoss;
      row.trades += 1;
    }
    byDay.set(key, row);
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, pnl: Math.round(v.pnl * 100) / 100, trades: v.trades }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function deriveStats(config: CombineConfig, balance: number, daily: DailyPnl[]) {
  const daysTraded = daily.length;
  const largestWinningDay = daily.reduce((m, d) => Math.max(m, d.pnl), 0);

  // Reconstruct the realized equity high-water mark from the cumulative P&L curve.
  let cum = config.startingBalance;
  let peakRealized = config.startingBalance;
  for (const d of daily) {
    cum += d.pnl;
    peakRealized = Math.max(peakRealized, cum);
  }
  // The API balance is authoritative; fold it into the peak too.
  peakRealized = Math.max(peakRealized, balance);
  return { daysTraded, largestWinningDay, peakRealized };
}

function viewPositions(
  positions: TsPosition[],
  pointValues: Map<string, number>
): PositionView[] {
  return positions.map((p) => ({
    contractId: p.contractId,
    side: p.type === 1 ? "Long" : "Short",
    size: p.size,
    averagePrice: p.averagePrice,
    pointValue: pointValues.get(p.contractId) ?? fallbackPointValue(p.contractId),
  }));
}

/** Look up $/point for each open contract, with a fallback table on any failure. */
async function resolvePointValues(contractIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    contractIds.map(async (id) => {
      try {
        const c = await searchContract(id);
        if (c && c.tickSize > 0 && c.tickValue > 0) {
          out.set(id, c.tickValue / c.tickSize);
          return;
        }
      } catch {
        // ignore — fall back below
      }
      out.set(id, fallbackPointValue(id));
    })
  );
  return out;
}

export async function getSnapshot(
  sizeOverride?: AccountSize,
  accountId?: number
): Promise<Snapshot> {
  if (!hasCredentials()) {
    const size = sizeOverride ?? "50K";
    return demoSnapshot(size, "No API credentials set — showing demo data. Add them in .env.local.");
  }

  try {
    const accounts = await searchAccounts();
    const account =
      (accountId != null && accounts.find((a) => a.id === accountId)) || selectAccount(accounts);
    if (!account) {
      return demoSnapshot(sizeOverride ?? "50K", "No active TopstepX account found.");
    }

    // Size follows the account name unless the user explicitly overrides it.
    const size = sizeOverride ?? sizeFromName(account.name);
    const config = COMBINE_CONFIGS[size];

    const end = new Date();
    const start = new Date(end.getTime() - 120 * 24 * 60 * 60 * 1000); // last 120 days
    const [positions, trades] = await Promise.all([
      searchOpenPositions(account.id),
      searchTrades(account.id, start.toISOString(), end.toISOString()),
    ]);

    const contractIds = [...new Set(positions.map((p) => p.contractId))];
    const [dailyPnl, pointValues, token] = await Promise.all([
      Promise.resolve(deriveDailyPnl(trades)),
      resolvePointValues(contractIds),
      getRealtimeToken(),
    ]);
    const { daysTraded, largestWinningDay, peakRealized } = deriveStats(
      config,
      account.balance,
      dailyPnl
    );

    // Baseline unrealized is 0 here; the browser updates it live via the market hub.
    const unrealizedPnl = 0;
    const peakEquity = Math.max(peakRealized, account.balance + unrealizedPnl);

    const currentSessionDay = dayKey(new Date().toISOString());
    const hasDailyLossLimit = /DLL/i.test(account.name);
    const todayRealized = dailyPnl.find((d) => d.day === currentSessionDay)?.pnl ?? 0;

    const result = evaluate({
      config,
      balance: account.balance,
      unrealizedPnl,
      peakEquity,
      daysTraded,
      largestWinningDay,
      openContracts: positions.reduce((s, p) => s + p.size, 0),
      todayPnl: todayRealized + unrealizedPnl,
      dailyLimitActive: hasDailyLossLimit,
    });

    return {
      source: "live",
      accountId: account.id,
      accountName: account.name,
      size,
      config,
      balance: account.balance,
      unrealizedPnl,
      peakEquity,
      positions: viewPositions(positions, pointValues),
      dailyPnl,
      hourlyPerformance: deriveHourlyPerformance(trades),
      currentSessionDay,
      hasDailyLossLimit,
      result,
      realtime: { token, rtcUrl: RTC_URL, accountId: account.id, contractIds },
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error fetching TopstepX data.";
    return demoSnapshot(sizeOverride ?? "50K", message);
  }
}

// ── Demo data so the dashboard renders before credentials are wired up ─────────
function demoSnapshot(size: AccountSize, warning: string): Snapshot {
  const config = COMBINE_CONFIGS[size];
  const dailyPnl: DailyPnl[] = [
    { day: "2026-06-22", pnl: 420, trades: 6 },
    { day: "2026-06-23", pnl: -180, trades: 9 },
    { day: "2026-06-24", pnl: 610, trades: 4 },
    { day: "2026-06-25", pnl: 250, trades: 7 },
    { day: "2026-06-26", pnl: -90, trades: 3 },
  ];
  const balance = config.startingBalance + dailyPnl.reduce((s, d) => s + d.pnl, 0);
  const { daysTraded, largestWinningDay, peakRealized } = deriveStats(config, balance, dailyPnl);
  const positions: PositionView[] = [
    { contractId: "CON.F.US.MES.U26", side: "Long", size: 2, averagePrice: 5512.25, pointValue: 5 },
  ];
  const currentSessionDay = "2026-06-26";
  const todayRealized = dailyPnl.find((d) => d.day === currentSessionDay)?.pnl ?? 0;
  const result = evaluate({
    config,
    balance,
    unrealizedPnl: 0,
    peakEquity: peakRealized,
    daysTraded,
    largestWinningDay,
    openContracts: 2,
    todayPnl: todayRealized,
    dailyLimitActive: true,
  });
  return {
    source: "demo",
    accountId: null,
    accountName: "Demo Combine",
    size,
    config,
    balance,
    unrealizedPnl: 0,
    peakEquity: peakRealized,
    positions,
    dailyPnl,
    hourlyPerformance: [
      { hour: 8, netUsd: 640, trades: 22, winRate: 59 },
      { hour: 9, netUsd: -210, trades: 31, winRate: 42 },
      { hour: 10, netUsd: 380, trades: 12, winRate: 67 },
      { hour: 13, netUsd: -140, trades: 9, winRate: 44 },
    ],
    result,
    realtime: null,
    currentSessionDay,
    hasDailyLossLimit: true,
    updatedAt: new Date().toISOString(),
    warning,
  };
}

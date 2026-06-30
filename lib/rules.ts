// ─────────────────────────────────────────────────────────────────────────────
// Topstep Combine (Trading Combine) rules engine.
//
// IMPORTANT: Prop-firm rules change. These defaults reflect the common Topstep
// Trading Combine structure (trailing Maximum Loss Limit + profit target).
// Verify the numbers against your current Topstep account agreement and adjust
// COMBINE_CONFIGS below if they differ.
// ─────────────────────────────────────────────────────────────────────────────

export type AccountSize = "50K" | "100K" | "150K";

export interface CombineConfig {
  size: AccountSize;
  startingBalance: number;
  /** Profit target to pass the Combine (based on end-of-day balance). */
  profitTarget: number;
  /** Trailing Maximum Loss Limit amount (the trailing drawdown window). */
  maxLossLimit: number;
  /** Max contracts allowed (full-size). */
  maxContracts: number;
  /** Minimum number of trading days before a pass is eligible. */
  minTradingDays: number;
  /** Consistency target: no single winning day may exceed this share of total profit. */
  consistencyMaxDayPct: number;
  /** Daily Loss Limit amount (only enforced on DLL-rule accounts). */
  dailyLossLimit: number;
}

export const COMBINE_CONFIGS: Record<AccountSize, CombineConfig> = {
  "50K": {
    size: "50K",
    startingBalance: 50_000,
    profitTarget: 3_000,
    maxLossLimit: 2_000,
    maxContracts: 5,
    minTradingDays: 2,
    consistencyMaxDayPct: 0.5,
    dailyLossLimit: 1_000, // NOTE: placeholder — confirm the 50K DLL value with Topstep.
  },
  "100K": {
    size: "100K",
    startingBalance: 100_000,
    profitTarget: 6_000,
    maxLossLimit: 3_000,
    maxContracts: 10,
    minTradingDays: 2,
    consistencyMaxDayPct: 0.5,
    dailyLossLimit: 2_000,
  },
  "150K": {
    size: "150K",
    startingBalance: 150_000,
    profitTarget: 9_000,
    maxLossLimit: 4_500,
    maxContracts: 15,
    minTradingDays: 2,
    consistencyMaxDayPct: 0.5,
    dailyLossLimit: 3_000,
  },
};

export type SignalLevel = "ok" | "info" | "warn" | "danger";

export interface Signal {
  level: SignalLevel;
  title: string;
  detail: string;
}

export interface EngineInput {
  config: CombineConfig;
  /** Realized account balance from the API (authoritative cash). */
  balance: number;
  /** Open/unrealized P&L on current positions (0 if flat or unavailable). */
  unrealizedPnl: number;
  /** High-water mark of equity (balance + unrealized) over the account's life. */
  peakEquity: number;
  /** Distinct days with at least one trade. */
  daysTraded: number;
  /** Largest single winning-day P&L (for consistency). */
  largestWinningDay: number;
  /** Number of open contracts right now. */
  openContracts: number;
  /** Today's session P&L (realized + unrealized) for the daily loss limit. */
  todayPnl: number;
  /** Whether the daily loss limit applies (DLL-rule account). */
  dailyLimitActive: boolean;
}

export interface EngineResult {
  status: "active" | "passed" | "failed";
  equity: number;
  trailingFloor: number;
  /** equity − trailingFloor: how much you can lose before the account fails. */
  bufferToFloor: number;
  /** bufferToFloor as a fraction of the full max-loss window. */
  bufferPct: number;
  floorLocked: boolean;
  netProfit: number;
  profitProgressPct: number;
  remainingToTarget: number;
  daysTraded: number;
  daysRemaining: number;
  consistencyOk: boolean;
  consistencyRequiredTotal: number;
  /** Suggested max $ risk on the next trade (a fraction of remaining buffer). */
  suggestedMaxRisk: number;
  // ── Daily loss limit (DLL accounts only) ──
  dailyLimitActive: boolean;
  dailyLossLimit: number;
  todayPnl: number;
  /** How much you can still lose today before the daily floor (dailyLossLimit + todayPnl). */
  dailyRemaining: number;
  /** Share of the daily loss limit already used (0–1). */
  dailyUsedPct: number;
  signals: Signal[];
  playbook: { dos: string[]; donts: string[] };
}

const RISK_FRACTION_OF_BUFFER = 0.2; // never risk more than 20% of remaining buffer

export function evaluate(input: EngineInput): EngineResult {
  const { config } = input;
  const equity = round2(input.balance + input.unrealizedPnl);

  // Trailing floor: trails peak equity by maxLossLimit, but never rises above the
  // starting balance (it "locks" once the account has banked a full window of profit).
  const cappedPeak = Math.min(input.peakEquity, config.startingBalance + config.maxLossLimit);
  const trailingFloor = round2(cappedPeak - config.maxLossLimit);
  const floorLocked = input.peakEquity >= config.startingBalance + config.maxLossLimit;

  const bufferToFloor = round2(equity - trailingFloor);
  const bufferPct = clamp(bufferToFloor / config.maxLossLimit, 0, 1);

  const netProfit = round2(input.balance - config.startingBalance);
  const remainingToTarget = round2(Math.max(0, config.profitTarget - netProfit));
  const profitProgressPct = clamp(netProfit / config.profitTarget, 0, 1);

  const daysRemaining = Math.max(0, config.minTradingDays - input.daysTraded);

  // Consistency: largest winning day must be ≤ consistencyMaxDayPct of total profit.
  const consistencyRequiredTotal = round2(input.largestWinningDay / config.consistencyMaxDayPct);
  const consistencyOk =
    input.largestWinningDay <= 0 || netProfit >= consistencyRequiredTotal;

  // Daily Loss Limit (DLL accounts): you fail if the account drops dailyLossLimit
  // below where it started the session. dailyRemaining is how much you can still
  // lose today; it's a SECOND floor on top of the trailing one.
  const dailyLimitActive = input.dailyLimitActive && config.dailyLossLimit > 0;
  const dailyRemaining = dailyLimitActive
    ? round2(config.dailyLossLimit + input.todayPnl)
    : Infinity;
  const dailyUsedPct = dailyLimitActive
    ? clamp(Math.max(0, -input.todayPnl) / config.dailyLossLimit, 0, 1)
    : 0;

  // The binding buffer is whichever floor (trailing or daily) is closer.
  const bindingBuffer = Math.min(bufferToFloor, dailyRemaining);

  const targetHit = netProfit >= config.profitTarget;
  let status: EngineResult["status"] = "active";
  if (bindingBuffer <= 0) status = "failed";
  else if (targetHit && daysRemaining === 0 && consistencyOk) status = "passed";

  const suggestedMaxRisk = round2(Math.max(0, bindingBuffer * RISK_FRACTION_OF_BUFFER));

  const signals = buildSignals({
    input,
    equity,
    trailingFloor,
    bufferToFloor,
    bufferPct,
    netProfit,
    remainingToTarget,
    profitProgressPct,
    daysRemaining,
    consistencyOk,
    consistencyRequiredTotal,
    targetHit,
    status,
    suggestedMaxRisk,
  });

  const playbook = buildPlaybook({
    config,
    bufferToFloor,
    bufferPct,
    suggestedMaxRisk,
    remainingToTarget,
    daysRemaining,
    consistencyOk,
    consistencyRequiredTotal,
    netProfit,
    status,
    openContracts: input.openContracts,
    dailyLimitActive,
    dailyRemaining,
    dailyUsedPct,
  });

  return {
    status,
    equity,
    trailingFloor,
    bufferToFloor,
    bufferPct,
    floorLocked,
    netProfit,
    profitProgressPct,
    remainingToTarget,
    daysTraded: input.daysTraded,
    daysRemaining,
    consistencyOk,
    consistencyRequiredTotal,
    suggestedMaxRisk,
    dailyLimitActive,
    dailyLossLimit: config.dailyLossLimit,
    todayPnl: round2(input.todayPnl),
    dailyRemaining: dailyLimitActive ? dailyRemaining : 0,
    dailyUsedPct,
    signals,
    playbook,
  };
}

function buildSignals(ctx: {
  input: EngineInput;
  equity: number;
  trailingFloor: number;
  bufferToFloor: number;
  bufferPct: number;
  netProfit: number;
  remainingToTarget: number;
  profitProgressPct: number;
  daysRemaining: number;
  consistencyOk: boolean;
  consistencyRequiredTotal: number;
  targetHit: boolean;
  status: EngineResult["status"];
  suggestedMaxRisk: number;
}): Signal[] {
  const s: Signal[] = [];

  if (ctx.status === "failed") {
    s.push({
      level: "danger",
      title: "Account breached",
      detail: `Equity ${money(ctx.equity)} is at or below the trailing floor ${money(
        ctx.trailingFloor
      )}. This Combine is failed.`,
    });
    return s;
  }

  if (ctx.status === "passed") {
    s.push({
      level: "ok",
      title: "Profit target reached — pass eligible",
      detail: `You've banked ${money(ctx.netProfit)} and met the trading-day and consistency conditions. Lock it in.`,
    });
  }

  // Trailing-drawdown buffer is the single most important guardrail.
  if (ctx.bufferPct < 0.2) {
    s.push({
      level: "danger",
      title: "Critical: near max loss limit",
      detail: `Only ${money(ctx.bufferToFloor)} (${pct(
        ctx.bufferPct
      )}) of your drawdown window remains. One bad trade ends the Combine.`,
    });
  } else if (ctx.bufferPct < 0.4) {
    s.push({
      level: "warn",
      title: "Buffer getting thin",
      detail: `${money(ctx.bufferToFloor)} (${pct(ctx.bufferPct)}) left to the trailing floor. Tighten size and stops.`,
    });
  } else {
    s.push({
      level: "ok",
      title: "Healthy drawdown buffer",
      detail: `${money(ctx.bufferToFloor)} (${pct(ctx.bufferPct)}) to the trailing floor.`,
    });
  }

  if (ctx.status === "active") {
    if (ctx.targetHit) {
      s.push({
        level: "info",
        title: "Target hit, pass not yet eligible",
        detail:
          ctx.daysRemaining > 0
            ? `Profit target met but you need ${ctx.daysRemaining} more trading day(s).`
            : `Profit target met but consistency isn't satisfied yet (see below).`,
      });
    } else {
      s.push({
        level: "info",
        title: "Progress to target",
        detail: `${money(ctx.remainingToTarget)} to go (${pct(ctx.profitProgressPct)} of target).`,
      });
    }
  }

  if (!ctx.consistencyOk) {
    s.push({
      level: "warn",
      title: "Consistency rule at risk",
      detail: `Your biggest day is too large relative to total profit. You'd need total profit of about ${money(
        ctx.consistencyRequiredTotal
      )} for it to comply. Spread gains across more days.`,
    });
  }

  return s;
}

function buildPlaybook(ctx: {
  config: CombineConfig;
  bufferToFloor: number;
  bufferPct: number;
  suggestedMaxRisk: number;
  remainingToTarget: number;
  daysRemaining: number;
  consistencyOk: boolean;
  consistencyRequiredTotal: number;
  netProfit: number;
  status: EngineResult["status"];
  openContracts: number;
  dailyLimitActive: boolean;
  dailyRemaining: number;
  dailyUsedPct: number;
}): { dos: string[]; donts: string[] } {
  const dos: string[] = [];
  const donts: string[] = [];

  if (ctx.status === "failed") {
    donts.push("Do not place any further trades — the account is breached.");
    dos.push("Stop, review what went wrong, and reset for a new Combine.");
    return { dos, donts };
  }

  // Daily loss limit takes priority — it's the fastest way to fail a DLL account.
  if (ctx.dailyLimitActive) {
    if (ctx.dailyUsedPct >= 0.8) {
      donts.push(
        `STOP for the day — only ${money(ctx.dailyRemaining)} left before the daily loss limit fails the account.`
      );
      dos.push("Flatten and walk away. Today's session is over — protect the account.");
      return { dos, donts };
    }
    if (ctx.dailyUsedPct >= 0.5) {
      donts.push("Do not try to 'win it back' — you're over half your daily loss limit.");
      dos.push(`Cut size hard. ${money(ctx.dailyRemaining)} of daily room remains.`);
    }
  }

  if (ctx.status === "passed") {
    dos.push("Stop trading and lock in the pass — you've met every condition.");
    donts.push("Do not give back profit chasing more; the Combine is done.");
    return { dos, donts };
  }

  // Risk sizing guidance.
  dos.push(`Risk no more than ${money(ctx.suggestedMaxRisk)} on the next trade (≈20% of remaining buffer).`);

  if (ctx.bufferPct < 0.2) {
    donts.push("Do NOT open new positions — you're one trade from failing.");
    dos.push("Flatten, walk away, and resume tomorrow with a fresh buffer.");
    if (ctx.openContracts > 0) donts.push("Do not add to the open position; manage it down.");
  } else if (ctx.bufferPct < 0.4) {
    dos.push("Trade minimum size and use a hard stop on every entry.");
    donts.push("Do not average down or widen stops to 'give it room'.");
  } else {
    dos.push(`You can scale within risk, but stay under your ${ctx.config.maxContracts}-contract cap.`);
  }

  if (ctx.daysRemaining > 0) {
    dos.push(`Trade at least ${ctx.daysRemaining} more day(s) to satisfy the minimum-days rule.`);
  }

  if (!ctx.consistencyOk) {
    donts.push(
      `Keep any single day under ${pct(ctx.config.consistencyMaxDayPct)} of total profit (consistency).`
    );
  }

  return { dos, donts };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

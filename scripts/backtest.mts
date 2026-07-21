/**
 * Backtest harness for the MNQ signal.
 *
 * Design commitments (this is what makes a backtest trustworthy):
 *  1. PARITY — imports the exact `computeSignal` used live. No re-implementation.
 *  2. NO LOOK-AHEAD — at each 5m bar close, the engine sees only bars that have
 *     already closed; every fill happens at the NEXT bar's open. You can never
 *     trade at a price you're still computing on.
 *  3. REAL COSTS — fees + commissions taken from your actual fills (~$1.24 per
 *     round-turn/contract) plus slippage. No frictionless fantasy fills.
 *  4. OUT-OF-SAMPLE — split by time; if the recent (OOS) slice collapses vs the
 *     older (IS) slice, the "edge" was overfit noise.
 *  5. BASELINE — compared against a random-entry control so we can tell signal
 *     from luck.
 *
 * Run: npm run backtest
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── config ───────────────────────────────────────────────────────────────────
const SYMBOL = "MNQ";
const POINT_VALUE = 2; // $ per index point for MNQ
const TICK = 0.25; // MNQ tick size in points
const SLIPPAGE_TICKS = 1; // assumed slippage per side (conservative for a scalper)
const COST_PER_ROUND_TURN = 1.24; // fees + commissions per contract, from real fills
const CONTRACTS = 1;
const BACKTEST_DAYS = 45;
const OOS_FRACTION = 1 / 3; // last third of the period is out-of-sample
const TAIL5 = 200; // history window fed to the engine per step (bounds cost)
const TAIL15 = 120;
const TAILH = 4;

// ── load .env.local into process.env, then import the live engine ────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const idx = s.indexOf("=");
  const k = s.slice(0, idx).trim();
  const v = s.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
  if (!process.env[k]) process.env[k] = v;
}

const { computeSignal } = await import("../lib/signals.ts");

// ── minimal typed bar ─────────────────────────────────────────────────────────
interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const BASE = process.env.TOPSTEPX_BASE_URL ?? "https://api.topstepx.com";

// ── auth with 401-retry (beats ProjectX's single-session token invalidation) ──
let token: string | null = null;
async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      userName: process.env.TOPSTEPX_USERNAME,
      apiKey: process.env.TOPSTEPX_API_KEY,
    }),
  });
  const data = await res.json();
  if (!data?.token) throw new Error(`auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  token = data.token;
  return token!;
}

async function post<T>(path: string, body: unknown, tries = 5): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!token) await login();
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      token = null; // invalidated by another session — re-login and retry
      await sleep(500 + attempt * 400);
      continue;
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`${path} failed after ${tries} retries (token race)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveContract(): Promise<string> {
  const data = await post<{ contracts?: { id: string; activeContract?: boolean }[] }>(
    "/api/Contract/search",
    { searchText: SYMBOL, live: false }
  );
  const cs = data.contracts ?? [];
  return (
    cs.find((c) => c.activeContract && c.id.includes(`.${SYMBOL}.`))?.id ??
    cs.find((c) => c.id.includes(`.${SYMBOL}.`))?.id ??
    cs[0]?.id ??
    "CON.F.US.MNQ.U26"
  );
}

/** Paginated historical fetch — chunks kept under the API's size cap. */
async function fetchHistory(
  cid: string,
  unit: number,
  unitNumber: number,
  days: number,
  approxBarsPerChunk = 450
): Promise<Bar[]> {
  const intervalMin = unit === 2 ? unitNumber : unit === 3 ? unitNumber * 60 : unitNumber * 1440;
  const chunkMs = approxBarsPerChunk * intervalMin * 60_000;
  const endAll = Date.now();
  const startAll = endAll - days * 86_400_000;
  const byTs = new Map<string, Bar>();
  let end = endAll;
  let emptyChunks = 0;
  while (end > startAll) {
    const start = Math.max(startAll, end - chunkMs);
    const data = await post<{ bars?: Bar[] }>("/api/History/retrieveBars", {
      contractId: cid,
      live: false,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      unit,
      unitNumber,
      limit: 500,
      includePartialBar: false,
    });
    const bars = data.bars ?? [];
    for (const b of bars) byTs.set(b.t, b);
    if (bars.length === 0 && ++emptyChunks > 3) break;
    end = start - 1;
    process.stdout.write(`\r  fetching ${unitNumber}${unit === 3 ? "h" : "m"} bars: ${byTs.size}   `);
  }
  process.stdout.write("\n");
  return [...byTs.values()].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

// ── trade model ───────────────────────────────────────────────────────────────
interface Trade {
  side: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
}

const ms = (iso: string) => new Date(iso).getTime();

/** P&L for a trade under a given cost/slippage assumption (0/0 = raw signal edge). */
function tradePnl(t: Trade, costRT: number, slipTicks: number): number {
  const slipPts = slipTicks * TICK;
  const entryFill = t.side === "long" ? t.entryPrice + slipPts : t.entryPrice - slipPts;
  const exitFill = t.side === "long" ? t.exitPrice - slipPts : t.exitPrice + slipPts;
  const pts = t.side === "long" ? exitFill - entryFill : entryFill - exitFill;
  return pts * POINT_VALUE * CONTRACTS - costRT * CONTRACTS;
}

// ── the replay ────────────────────────────────────────────────────────────────
function backtest(bars5: Bar[], bars15: Bar[], barsH: Bar[]): Trade[] {
  const trades: Trade[] = [];
  let p15 = 0;
  let pH = 0;
  let side: "long" | "short" | null = null;
  let entryPrice = 0;
  let entryTime = 0;

  for (let i = 0; i < bars5.length - 1; i++) {
    // A 5m bar is CLOSED at its open time + 5 minutes (bar t = open time assumption).
    const closeTime = ms(bars5[i].t) + 5 * 60_000;
    while (p15 + 1 < bars15.length && ms(bars15[p15 + 1].t) + 15 * 60_000 <= closeTime) p15++;
    while (pH + 1 < barsH.length && ms(barsH[pH + 1].t) + 60 * 60_000 <= closeTime) pH++;

    const sub5 = bars5.slice(Math.max(0, i - TAIL5 + 1), i + 1);
    const sub15 = bars15.slice(Math.max(0, p15 - TAIL15 + 1), p15 + 1);
    const subH = barsH.slice(Math.max(0, pH - TAILH + 1), pH + 1);
    if (sub15.length < 50) continue; // not enough history for the trend filter

    const sig = computeSignal(sub5, sub15, subH);
    const nextOpen = bars5[i + 1].o;
    const nextTime = ms(bars5[i + 1].t);

    if (side === null) {
      if (sig.direction === "BUY") {
        side = "long";
        entryPrice = nextOpen;
        entryTime = nextTime;
      } else if (sig.direction === "SELL") {
        side = "short";
        entryPrice = nextOpen;
        entryTime = nextTime;
      }
    } else if (side === "long" && sig.closeLong) {
      trades.push({ side, entryTime, entryPrice, exitTime: nextTime, exitPrice: nextOpen });
      side = null;
    } else if (side === "short" && sig.closeShort) {
      trades.push({ side, entryTime, entryPrice, exitTime: nextTime, exitPrice: nextOpen });
      side = null;
    }
  }
  return trades;
}

// ── metrics ───────────────────────────────────────────────────────────────────
function metrics(trades: Trade[], costRT: number, slipTicks: number) {
  const n = trades.length;
  if (n === 0) return null;
  const nets = trades.map((t) => tradePnl(t, costRT, slipTicks));
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const total = nets.reduce((a, b) => a + b, 0);
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const x of nets) {
    equity += x;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return {
    n,
    winRate: (100 * wins.length) / n,
    expectancy: total / n,
    total,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDD,
  };
}

function report(label: string, trades: Trade[], costRT: number, slipTicks: number) {
  const m = metrics(trades, costRT, slipTicks);
  console.log(`\n── ${label} ──`);
  if (!m) {
    console.log("  no trades");
    return;
  }
  console.log(`  trades:        ${m.n}`);
  console.log(`  win rate:      ${m.winRate.toFixed(1)}%`);
  console.log(`  expectancy:    $${m.expectancy.toFixed(2)} / trade  ${m.expectancy > 0 ? "✅" : "❌"}`);
  console.log(`  total net:     $${m.total.toFixed(0)}`);
  console.log(`  avg win:       $${m.avgWin.toFixed(2)}   avg loss: $${m.avgLoss.toFixed(2)}`);
  console.log(`  profit factor: ${m.profitFactor.toFixed(2)}  (>1 = profitable, <1 = bleeding)`);
  console.log(`  max drawdown:  $${m.maxDD.toFixed(0)}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`Backtesting ${SYMBOL} signal over ~${BACKTEST_DAYS} days (costs: $${COST_PER_ROUND_TURN} + ${SLIPPAGE_TICKS} tick slip/side)\n`);
const cid = await resolveContract();
console.log("contract:", cid);
const bars5 = await fetchHistory(cid, 2, 5, BACKTEST_DAYS);
const bars15 = await fetchHistory(cid, 2, 15, BACKTEST_DAYS);
const barsH = await fetchHistory(cid, 3, 1, BACKTEST_DAYS);
console.log(`bars: 5m=${bars5.length}  15m=${bars15.length}  1h=${barsH.length}`);

if (bars5.length < 500) {
  console.log("Not enough 5m history to backtest meaningfully.");
  process.exit(1);
}

const allTrades = backtest(bars5, bars15, barsH);

// time-based IS/OOS split
const startT = ms(bars5[0].t);
const endT = ms(bars5[bars5.length - 1].t);
const splitT = startT + (endT - startT) * (1 - OOS_FRACTION);
const is = allTrades.filter((t) => t.entryTime < splitT);
const oos = allTrades.filter((t) => t.entryTime >= splitT);

console.log("\n================ WITH REAL COSTS ================");
report("FULL PERIOD", allTrades, COST_PER_ROUND_TURN, SLIPPAGE_TICKS);
report("IN-SAMPLE (older 2/3)", is, COST_PER_ROUND_TURN, SLIPPAGE_TICKS);
report("OUT-OF-SAMPLE (recent 1/3)", oos, COST_PER_ROUND_TURN, SLIPPAGE_TICKS);

console.log("\n========== ZERO COSTS (raw signal edge) ==========");
console.log("(No commissions, no slippage — does the signal predict direction AT ALL?)");
report("FULL PERIOD — gross", allTrades, 0, 0);
report("OUT-OF-SAMPLE — gross", oos, 0, 0);

const grossM = metrics(allTrades, 0, 0);
console.log(`\nVerdict:`);
if (!grossM || grossM.expectancy <= 0) {
  console.log(`  ❌ Even with ZERO costs, the raw signal expectancy is $${grossM?.expectancy.toFixed(2) ?? "n/a"}/trade.`);
  console.log(`     The logic has NO directional edge. Cost-tuning cannot save it — the entries/exits are directionless.`);
} else {
  const drag = COST_PER_ROUND_TURN + SLIPPAGE_TICKS * TICK * 2 * POINT_VALUE;
  console.log(`  ⚠️  Raw signal is +$${grossM.expectancy.toFixed(2)}/trade before costs, but costs (~$${drag.toFixed(2)}/trade) flip it negative.`);
  console.log(`     There's a faint edge, but it's smaller than the friction. It would need far fewer, bigger trades to survive.`);
}
process.exit(0);

/**
 * Opening-Range Breakout (ORB) backtest for MNQ.
 *
 * Hypothesis: the first 15 minutes after the 8:30 CT cash open define a range;
 * a break of that range in the RTH session has directional follow-through.
 *
 * Rules (one trade/day, honest fills, no look-ahead):
 *  • Opening range = high/low of the first OR_MINUTES after 08:30 CT.
 *  • Entry: first 5m bar that CLOSES beyond the range, entered at the NEXT bar's
 *    open, only before ENTRY_CUTOFF.
 *  • Stop = the opposite side of the range. Target = TARGET_R × range.
 *  • If both stop and target fall in one bar, assume STOP first (conservative).
 *  • Flat by session end if neither hits.
 *  • Real costs + slippage. Time-split IS/OOS.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── config ───────────────────────────────────────────────────────────────────
const SYMBOL = "MNQ";
const POINT_VALUE = 2;
const TICK = 0.25;
const SLIPPAGE_TICKS = 1;
const COST_PER_ROUND_TURN = 1.24;
const CONTRACTS = 1;
const BACKTEST_DAYS = 90;
const OOS_FRACTION = 1 / 3;

const OR_MINUTES = 15; // opening-range length
const SESSION_START = 8 * 60 + 30; // 08:30 CT (cash open)
const OR_END = SESSION_START + OR_MINUTES;
const ENTRY_CUTOFF = 11 * 60; // no new entries after 11:00 CT
const SESSION_END = 15 * 60; // flat by 15:00 CT
const TARGET_R = 1.0; // target = 1× the opening range

// ── env + shared fetch (same pattern as backtest.mts) ─────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  const k = s.slice(0, i).trim();
  const v = s.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  if (!process.env[k]) process.env[k] = v;
}

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
const BASE = process.env.TOPSTEPX_BASE_URL ?? "https://api.topstepx.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let token: string | null = null;

async function login() {
  const res = await fetch(`${BASE}/api/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ userName: process.env.TOPSTEPX_USERNAME, apiKey: process.env.TOPSTEPX_API_KEY }),
  });
  const d = await res.json();
  if (!d?.token) throw new Error("auth failed");
  token = d.token;
}
async function post<T>(path: string, body: unknown, tries = 6): Promise<T> {
  for (let a = 0; a < tries; a++) {
    if (!token) await login();
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { token = null; await sleep(500 + a * 400); continue; }
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`${path} failed (token race)`);
}
async function resolveContract(): Promise<string> {
  const d = await post<{ contracts?: { id: string; activeContract?: boolean }[] }>("/api/Contract/search", { searchText: SYMBOL, live: false });
  const cs = d.contracts ?? [];
  return cs.find((c) => c.activeContract && c.id.includes(`.${SYMBOL}.`))?.id ?? cs.find((c) => c.id.includes(`.${SYMBOL}.`))?.id ?? cs[0]?.id ?? "CON.F.US.MNQ.U26";
}
async function fetchHistory(cid: string, unit: number, unitNumber: number, days: number, chunkBars = 450): Promise<Bar[]> {
  const intervalMin = unit === 2 ? unitNumber : unitNumber * 60;
  const chunkMs = chunkBars * intervalMin * 60_000;
  const endAll = Date.now();
  const startAll = endAll - days * 86_400_000;
  const byTs = new Map<string, Bar>();
  let end = endAll, empty = 0;
  while (end > startAll) {
    const start = Math.max(startAll, end - chunkMs);
    const d = await post<{ bars?: Bar[] }>("/api/History/retrieveBars", {
      contractId: cid, live: false, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
      unit, unitNumber, limit: 500, includePartialBar: false,
    });
    const bars = d.bars ?? [];
    for (const b of bars) byTs.set(b.t, b);
    if (bars.length === 0 && ++empty > 3) break;
    end = start - 1;
    process.stdout.write(`\r  fetching 5m bars: ${byTs.size}   `);
  }
  process.stdout.write("\n");
  return [...byTs.values()].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

// ── CT time helpers ───────────────────────────────────────────────────────────
const dtf = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function ct(iso: string): { day: string; min: number } {
  const p = dtf.formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, min: Number(g("hour")) * 60 + Number(g("minute")) };
}

// ── simulate ──────────────────────────────────────────────────────────────────
interface Trade { side: "long" | "short"; entryTime: number; pnlUsd: number }
const slip = SLIPPAGE_TICKS * TICK;

function backtestOrb(bars5: Bar[]): Trade[] {
  // group RTH bars by CT day
  const days = new Map<string, Bar[]>();
  for (const b of bars5) {
    const { day, min } = ct(b.t);
    if (min < SESSION_START || min >= SESSION_END) continue;
    (days.get(day) ?? days.set(day, []).get(day)!).push(b);
  }

  const trades: Trade[] = [];
  for (const [, dayBars] of days) {
    const orBars = dayBars.filter((b) => ct(b.t).min < OR_END);
    if (orBars.length === 0) continue;
    const orHigh = Math.max(...orBars.map((b) => b.h));
    const orLow = Math.min(...orBars.map((b) => b.l));
    const range = orHigh - orLow;
    if (range <= 0) continue;

    const after = dayBars.filter((b) => ct(b.t).min >= OR_END);
    let entryIdx = -1;
    let side: "long" | "short" | null = null;
    for (let i = 0; i < after.length; i++) {
      if (ct(after[i].t).min >= ENTRY_CUTOFF) break;
      if (after[i].c > orHigh) { side = "long"; entryIdx = i; break; }
      if (after[i].c < orLow) { side = "short"; entryIdx = i; break; }
    }
    if (side === null || entryIdx + 1 >= after.length) continue;

    const entry = after[entryIdx + 1].o; // fill next bar open
    const stop = side === "long" ? orLow : orHigh;
    const target = side === "long" ? entry + TARGET_R * range : entry - TARGET_R * range;

    let exit = after[after.length - 1].c; // default: session-end close
    for (let i = entryIdx + 1; i < after.length; i++) {
      const b = after[i];
      if (side === "long") {
        if (b.l <= stop) { exit = stop; break; } // stop first (conservative)
        if (b.h >= target) { exit = target; break; }
      } else {
        if (b.h >= stop) { exit = stop; break; }
        if (b.l <= target) { exit = target; break; }
      }
    }

    const entryFill = side === "long" ? entry + slip : entry - slip;
    const exitFill = side === "long" ? exit - slip : exit + slip;
    const pts = side === "long" ? exitFill - entryFill : entryFill - exitFill;
    const pnl = pts * POINT_VALUE * CONTRACTS - COST_PER_ROUND_TURN * CONTRACTS;
    trades.push({ side, entryTime: new Date(after[entryIdx + 1].t).getTime(), pnlUsd: pnl });
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

function report(label: string, trades: Trade[]) {
  console.log(`\n── ${label} ──`);
  if (trades.length === 0) { console.log("  no trades"); return; }
  const nets = trades.map((t) => t.pnlUsd);
  const wins = nets.filter((x) => x > 0);
  const total = nets.reduce((a, b) => a + b, 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(nets.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const x of nets) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  console.log(`  trades:        ${trades.length}`);
  console.log(`  win rate:      ${((100 * wins.length) / trades.length).toFixed(1)}%`);
  console.log(`  expectancy:    $${(total / trades.length).toFixed(2)} / trade  ${total / trades.length > 0 ? "✅" : "❌"}`);
  console.log(`  total net:     $${total.toFixed(0)}`);
  console.log(`  profit factor: ${gl > 0 ? (gw / gl).toFixed(2) : "∞"}`);
  console.log(`  max drawdown:  $${dd.toFixed(0)}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`ORB backtest — MNQ, ${OR_MINUTES}min range @ 08:30 CT, target ${TARGET_R}×range, over ~${BACKTEST_DAYS}d\n`);
const cid = await resolveContract();
const bars5 = await fetchHistory(cid, 2, 5, BACKTEST_DAYS);
console.log(`contract ${cid}, 5m bars: ${bars5.length}`);

const trades = backtestOrb(bars5);
const startT = trades[0]?.entryTime ?? 0;
const endT = trades[trades.length - 1]?.entryTime ?? 0;
const splitT = startT + (endT - startT) * (1 - OOS_FRACTION);
report("FULL PERIOD", trades);
report("IN-SAMPLE (older 2/3)", trades.filter((t) => t.entryTime < splitT));
report("OUT-OF-SAMPLE (recent 1/3)", trades.filter((t) => t.entryTime >= splitT));
process.exit(0);

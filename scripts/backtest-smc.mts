/**
 * Backtest for the Range → Change → Execution model (lib/smc.ts), simulated on
 * a fresh account (default $250,000) — not your own trade history.
 *
 *  1. PARITY — replays the exact `runSmc` the Telegram monitor uses.
 *  2. NO LOOK-AHEAD — the engine is causal (decides at bar close with closed
 *     bars only; limits can fill from the NEXT bar on). Verified below by
 *     re-running on truncated history and checking each setup is identical.
 *  3. REAL FILLS — limit entry needs a 1-tick trade-through; stop checked before
 *     target inside a bar; stop / session-close exits pay 1 tick slippage;
 *     $1.24 fees per round turn per contract.
 *  4. FRONT MONTH ONLY — each date uses the contract that was actually being
 *     traded then (rolls 8 days before expiry). Back-month 1m data is thin and
 *     would distort structure/FVGs.
 *  5. OUT-OF-SAMPLE — last third of the period reported separately.
 *
 * Sizing: risk a fixed % of the starting balance per trade, in MNQ micros,
 * contracts = floor(risk$ / (stop distance × $2)), capped at MAX_MICROS.
 *
 * Run:  npm run backtest:smc
 *       ACCOUNT=250000 RISK_PCT=0.5 MAX_MICROS=150 DAYS=60 npm run backtest:smc
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const POINT_VALUE = 2;
const TICK = 0.25;
const SLIPPAGE_TICKS = 1;
const COST_PER_ROUND_TURN = 1.24;
const DAYS = Number(process.env.DAYS ?? 60); // TopstepX keeps ~60 days of 1m bars
const OOS_FRACTION = 1 / 3;
const ACCOUNT = Number(process.env.ACCOUNT ?? 250_000);
const RISK_PCT = Number(process.env.RISK_PCT ?? 0.5);
const MAX_MICROS = Number(process.env.MAX_MICROS ?? 150);
const TZ = "America/Chicago";

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

const { runSmc, DEFAULT_SMC } = await import("../lib/smc.ts");
type Setup = import("../lib/smc.ts").Setup;
type SmcConfig = import("../lib/smc.ts").SmcConfig;

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const BASE = process.env.TOPSTEPX_BASE_URL ?? "https://api.topstepx.com";
let token: string | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ userName: process.env.TOPSTEPX_USERNAME, apiKey: process.env.TOPSTEPX_API_KEY }),
  });
  const data = await res.json();
  if (!data?.token) throw new Error(`auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  token = data.token;
  return token!;
}

async function post<T>(path: string, body: unknown, tries = 12): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!token) await login();
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      token = null;
      await sleep(500 + attempt * 400);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 + attempt * 2000);
      continue;
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  throw new Error(`${path} failed after ${tries} retries`);
}

// ── front-month contract schedule ────────────────────────────────────────────
// Equity index futures expire the 3rd Friday of Mar/Jun/Sep/Dec; volume rolls
// to the next contract 8 days earlier (Thursday).
const MONTH_CODES: [number, string][] = [[2, "H"], [5, "M"], [8, "U"], [11, "Z"]];
function thirdFriday(y: number, m: number): Date {
  const d = new Date(Date.UTC(y, m, 1));
  const firstFri = 1 + ((5 - d.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(y, m, firstFri + 14));
}
interface Segment {
  cid: string;
  from: number;
  to: number;
}
function frontMonthSegments(startMs: number, endMs: number): Segment[] {
  const rolls: { at: number; code: string }[] = [];
  const y0 = new Date(startMs).getUTCFullYear() - 1;
  for (let y = y0; y <= y0 + 3; y++) {
    for (const [m, c] of MONTH_CODES) {
      rolls.push({ at: thirdFriday(y, m).getTime() - 8 * 86_400_000, code: `${c}${String(y).slice(2)}` });
    }
  }
  const segs: Segment[] = [];
  let from = startMs;
  for (const r of rolls) {
    if (r.at <= from) continue;
    const to = Math.min(r.at, endMs);
    segs.push({ cid: `CON.F.US.MNQ.${r.code}`, from, to });
    from = to;
    if (from >= endMs) break;
  }
  return segs;
}

async function fetchRange(cid: string, unitNumber: number, startMs: number, endMs: number): Promise<Bar[]> {
  const chunkMs = 450 * unitNumber * 60_000;
  const byTs = new Map<string, Bar>();
  let end = endMs;
  while (end > startMs) {
    const start = Math.max(startMs, end - chunkMs);
    const data = await post<{ bars?: Bar[] }>("/api/History/retrieveBars", {
      contractId: cid,
      live: false,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      unit: 2,
      unitNumber,
      limit: 500,
      includePartialBar: false,
    });
    for (const b of data.bars ?? []) byTs.set(b.t, b);
    end = start - 1;
    process.stdout.write(`\r  ${cid} ${unitNumber}m bars: ${byTs.size}      `);
  }
  process.stdout.write("\n");
  return [...byTs.values()].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

// ── scoring ──────────────────────────────────────────────────────────────────
const ms = (iso: string) => new Date(iso).getTime();

/** $ P&L per 1 micro contract. */
function pnlPerContract(s: Setup, withCosts: boolean): number {
  const exit = s.exitPrice!;
  // Limit entry and limit target fill at price; stops and market flattens slip.
  const slips = withCosts && s.status !== "target" ? SLIPPAGE_TICKS * TICK : 0;
  const pts = (s.side === "long" ? exit - s.entry : s.entry - exit) - slips;
  return pts * POINT_VALUE - (withCosts ? COST_PER_ROUND_TURN : 0);
}

const riskBudget = (ACCOUNT * RISK_PCT) / 100;
const contractsFor = (s: Setup) => Math.max(1, Math.min(MAX_MICROS, Math.floor(riskBudget / (s.risk * POINT_VALUE))));

const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const ctFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

function stats(trades: Setup[], withCosts = true) {
  const nets = trades.map((t) => pnlPerContract(t, withCosts) * contractsFor(t));
  const rs = trades.map((t) => pnlPerContract(t, withCosts) / (t.risk * POINT_VALUE));
  const wins = nets.filter((x) => x > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(nets.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  const total = nets.reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const x of nets) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    streak = x <= 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  return {
    n: trades.length,
    winRate: trades.length ? (100 * wins.length) / trades.length : 0,
    total,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    pf: gl > 0 ? gw / gl : Infinity,
    dd,
    worst,
  };
}

function report(label: string, trades: Setup[], withCosts = true) {
  console.log(`\n── ${label} ──`);
  if (!trades.length) return console.log("  no trades");
  const m = stats(trades, withCosts);
  const by = (st: string) => trades.filter((t) => t.status === st).length;
  console.log(`  trades:        ${m.n}  (target ${by("target")} · stop ${by("stopped")} · BE ${by("breakeven")} · EOD ${by("session_close")})`);
  console.log(`  win rate:      ${m.winRate.toFixed(1)}%   (break-even win rate at 1:${DEFAULT_SMC.rr} ≈ ${(100 / (DEFAULT_SMC.rr + 1)).toFixed(0)}%)`);
  console.log(`  avg per trade: ${m.avgR >= 0 ? "+" : ""}${m.avgR.toFixed(2)}R   ${m.total > 0 ? "✅" : "❌"}`);
  console.log(`  net P&L:       ${money(m.total)}  (${((100 * m.total) / ACCOUNT).toFixed(2)}% of account)`);
  console.log(`  profit factor: ${Number.isFinite(m.pf) ? m.pf.toFixed(2) : "∞"}`);
  console.log(`  max drawdown:  ${money(m.dd)}   longest losing streak: ${m.worst}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(`SMC strategy backtest — simulated ${money(ACCOUNT)} account`);
console.log(`Risk ${RISK_PCT}% (${money(riskBudget)}) per trade in MNQ micros, max ${MAX_MICROS}; ~${DAYS} days; 1m execution / 15m range\n`);

const cfg: SmcConfig = { ...DEFAULT_SMC };
const endMs = Date.now();
const startMs = endMs - DAYS * 86_400_000;
const WARMUP = 4 * 86_400_000; // extra same-contract history so structure exists on day one

interface SegData { seg: Segment; ltf: Bar[]; htf: Bar[] }
const segData: SegData[] = [];
for (const seg of frontMonthSegments(startMs, endMs)) {
  const ltf = await fetchRange(seg.cid, 1, seg.from - WARMUP, seg.to);
  const htf = await fetchRange(seg.cid, 15, seg.from - WARMUP - 3 * 86_400_000, seg.to);
  segData.push({ seg, ltf, htf });
}
for (const { seg, ltf } of segData) {
  const inSeg = ltf.filter((b) => ms(b.t) >= seg.from).length;
  console.log(`  ${seg.cid}: ${dayFmt.format(seg.from)} → ${dayFmt.format(seg.to)}  ${inSeg} 1m bars`);
}

function runAll(c: SmcConfig): Setup[] {
  const out: Setup[] = [];
  for (const { seg, ltf, htf } of segData) {
    if (ltf.length < 1000) continue;
    for (const s of runSmc(ltf, htf, c).setups) {
      const t = ms(s.createdAt);
      if (t >= seg.from && t < seg.to) out.push(s);
    }
  }
  return out;
}

const setups = runAll(cfg);
const closed = setups.filter((s) => s.exitPrice !== undefined);
const cancelled = setups.filter((s) => s.status === "cancelled");
console.log(`\nsetups alerted: ${setups.length}   filled: ${closed.length}   never filled (cancelled): ${cancelled.length}`);

// Look-ahead check: rerun on history truncated at each setup's bar; the setup
// must come out identical (same entry/stop/target) using only data up to then.
let checked = 0;
let mismatches = 0;
for (const { seg, ltf, htf } of segData) {
  // Only this contract's own setups (warmup days overlap the previous contract).
  const idxOf = new Map(ltf.map((b, i) => [b.t, i]));
  const own = setups.filter((s) => idxOf.has(s.createdAt) && ms(s.createdAt) >= seg.from && ms(s.createdAt) < seg.to);
  for (const s of own.filter((_, i) => i % Math.max(1, Math.floor(own.length / 8)) === 0)) {
    const i = idxOf.get(s.createdAt)!;
    const cutT = ms(ltf[i].t) + 60_000;
    const h = htf.filter((b) => ms(b.t) + 15 * 60_000 <= cutT);
    const again = runSmc(ltf.slice(0, i + 1), h, cfg).setups.find((x) => x.id === s.id);
    checked++;
    if (!again || again.entry !== s.entry || again.stop !== s.stop || again.target !== s.target) mismatches++;
  }
}
console.log(`look-ahead check: ${checked - mismatches}/${checked} setups reproduced from truncated history ${mismatches ? "❌" : "✅"}`);

// ── trade log + equity curve ──
console.log("\n================ TRADE LOG (CT) ================");
console.log("  date/time     side   entry      stop       exit       result      qty     P&L        balance");
let bal = ACCOUNT;
let peakBal = ACCOUNT;
let maxDdBal = 0;
const daily = new Map<string, number>();
for (const s of closed) {
  const q = contractsFor(s);
  const p = pnlPerContract(s, true) * q;
  bal += p;
  peakBal = Math.max(peakBal, bal);
  maxDdBal = Math.max(maxDdBal, peakBal - bal);
  const d = dayFmt.format(new Date(s.fillTime!));
  daily.set(d, (daily.get(d) ?? 0) + p);
  const res = { target: `+${DEFAULT_SMC.rr}R tgt`, stopped: "-1R stop", breakeven: "BE stop", session_close: "EOD flat" }[s.status as string] ?? s.status;
  console.log(
    `  ${ctFmt.format(new Date(s.fillTime!)).padEnd(13)} ${s.side.padEnd(6)} ${s.entry.toFixed(2).padStart(9)}  ${s.stop.toFixed(2).padStart(9)}  ${s.exitPrice!.toFixed(2).padStart(9)}  ${res.padEnd(10)} ${String(q).padStart(4)}  ${money(p).padStart(9)}  ${money(bal).padStart(10)}`
  );
}

const days = [...daily.values()];
console.log("\n================ ACCOUNT SUMMARY ================");
console.log(`  start balance:   ${money(ACCOUNT)}`);
console.log(`  end balance:     ${money(bal)}   (${bal >= ACCOUNT ? "+" : ""}${(((bal - ACCOUNT) / ACCOUNT) * 100).toFixed(2)}%)`);
console.log(`  max drawdown:    ${money(maxDdBal)}  (${((maxDdBal / ACCOUNT) * 100).toFixed(2)}% of account)`);
if (days.length) {
  console.log(`  days traded:     ${days.length}   green days: ${days.filter((x) => x > 0).length}`);
  console.log(`  best day:        ${money(Math.max(...days))}   worst day: ${money(Math.min(...days))}`);
}

const startT = segData[0] ? segData[0].seg.from : startMs;
const splitT = startT + (endMs - startT) * (1 - OOS_FRACTION);
console.log("\n================ BREAKDOWN (with costs) ================");
report("FULL PERIOD", closed);
report("IN-SAMPLE (older 2/3)", closed.filter((t) => ms(t.fillTime!) < splitT));
report("OUT-OF-SAMPLE (recent 1/3)", closed.filter((t) => ms(t.fillTime!) >= splitT));
report("LONGS", closed.filter((t) => t.side === "long"));
report("SHORTS", closed.filter((t) => t.side === "short"));
report("ZERO COSTS (raw edge)", closed, false);

// When in the session do setups work? (entry fill time, CT)
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const bucket = (iso: string) => {
  const [h, m] = hourFmt.format(new Date(iso)).split(":").map(Number);
  const start = (h % 24) * 60 + (m < 30 ? 0 : 30);
  const f = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  return `${f(start)}-${f(start + 30)}`;
};
console.log("\n========== BY TIME OF DAY (setup time, CT, with costs) ==========");
console.log("  window        setups  filled  wins   net $      avg R");
const windows = [...new Set(setups.map((s) => bucket(s.createdAt)))].sort();
for (const w of windows) {
  const all = setups.filter((s) => bucket(s.createdAt) === w);
  const f = closed.filter((s) => bucket(s.createdAt) === w);
  const m = stats(f);
  console.log(
    `  ${w}   ${String(all.length).padStart(5)}  ${String(f.length).padStart(6)}  ${String(f.filter((t) => pnlPerContract(t, true) > 0).length).padStart(4)}   ${money(m.total).padStart(8)}   ${f.length ? m.avgR.toFixed(2).padStart(6) : "     -"}`
  );
}

// Sensitivity: does the result hold across nearby settings, or only at one knob?
console.log("\n========== SENSITIVITY (net $, with costs) ==========");
console.log("  rr   fvg×ATR  expiry  trades   win%     avg R     net $     OOS net $");
for (const rr of [2, 3, 4]) {
  for (const fvgMinAtr of [0.3, 0.6]) {
    for (const expiryBars of [15, 30]) {
      const tr = runAll({ ...cfg, rr, fvgMinAtr, expiryBars }).filter((s) => s.exitPrice !== undefined);
      const m = stats(tr);
      const o = stats(tr.filter((t) => ms(t.fillTime!) >= splitT));
      const mark = rr === cfg.rr && fvgMinAtr === cfg.fvgMinAtr && expiryBars === cfg.expiryBars ? " ← default" : "";
      console.log(
        `  ${rr}    ${fvgMinAtr.toFixed(1)}      ${String(expiryBars).padStart(2)}      ${String(m.n).padStart(4)}   ${m.winRate.toFixed(0).padStart(4)}%   ${m.avgR.toFixed(2).padStart(6)}   ${money(m.total).padStart(8)}   ${money(o.total).padStart(8)}${mark}`
      );
    }
  }
}
process.exit(0);

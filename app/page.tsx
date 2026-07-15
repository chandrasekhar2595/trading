"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COMBINE_CONFIGS, evaluate, type AccountSize, type EngineResult } from "@/lib/rules";
import type { AccountListItem, PositionView, RealtimeInfo } from "@/lib/account-snapshot";
import { useRealtime, type RealtimeStatus } from "@/lib/use-realtime";
import type { MarketSignal } from "@/lib/market-signal";

interface Snapshot {
  source: "live" | "demo";
  accountId: number | null;
  accountName: string;
  size: AccountSize;
  balance: number;
  unrealizedPnl: number;
  peakEquity: number;
  positions: PositionView[];
  dailyPnl: { day: string; pnl: number; trades: number }[];
  hourlyPerformance: { hour: number; netUsd: number; trades: number; winRate: number }[];
  realtime: RealtimeInfo | null;
  currentSessionDay: string;
  hasDailyLossLimit: boolean;
  updatedAt: string;
  warning?: string;
  config: {
    profitTarget: number;
    maxLossLimit: number;
    maxContracts: number;
    minTradingDays: number;
  };
  result: EngineResult;
}

const POLL_MS = 5000;

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const moneySigned = (n: number) => (n >= 0 ? "+" : "") + money(n);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function Dashboard() {
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [signal, setSignal] = useState<MarketSignal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Monotonic request id: only the latest request is allowed to write state, so a
  // slow response for a previously-selected account can't overwrite the current one.
  const reqSeq = useRef(0);

  // Load the eligible account list once and default to the first (highest balance).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/accounts", { cache: "no-store" });
        const data = await res.json();
        const list: AccountListItem[] = data.accounts ?? [];
        setAccounts(list);
        setAccountId((cur) => cur ?? list[0]?.id ?? null);
      } catch {
        /* demo mode — no accounts; snapshot still renders */
      }
    })();
  }, []);

  const load = useCallback(async (id: number | null) => {
    const seq = ++reqSeq.current;
    try {
      const qs = id != null ? `accountId=${id}` : "";
      const res = await fetch(`/api/snapshot?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Snapshot = await res.json();
      if (seq !== reqSeq.current) return; // superseded by a newer request
      // Ignore a response that no longer matches the selected account.
      if (id != null && data.accountId !== id) return;
      setSnap(data);
      setError(null);
    } catch (e) {
      if (seq === reqSeq.current) setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Switching accounts: drop the previous snapshot so stale stats never show.
    setSnap(null);
    setLoading(true);
    load(accountId);
    const id = setInterval(() => load(accountId), POLL_MS);
    return () => clearInterval(id);
  }, [accountId, load]);

  // Local fallback for RSI alerts: ping the monitor every minute while the
  // dashboard is open. In production, the Vercel cron runs it 24/7.
  useEffect(() => {
    const ping = () => fetch("/api/rsi-check", { cache: "no-store" }).catch(() => {});
    ping();
    const id = setInterval(ping, 60_000);
    return () => clearInterval(id);
  }, []);

  // MNQ buy/sell signal + best-hours, refreshed every 30s.
  useEffect(() => {
    const loadSignal = () =>
      fetch("/api/signal", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => (d?.signal ? setSignal(d) : null))
        .catch(() => {});
    loadSignal();
    const id = setInterval(loadSignal, 30_000);
    return () => clearInterval(id);
  }, []);

  // Live quotes + balance from the SignalR hubs (or a demo simulation).
  const rt = useRealtime(snap?.realtime ?? null, snap?.positions ?? []);

  // Recompute the engine with the live unrealized P&L so the buffer moves in real time.
  const view = useMemo<Snapshot | null>(() => {
    if (!snap) return null;
    const config = COMBINE_CONFIGS[snap.size];
    const balance = rt.liveBalance ?? snap.balance;
    const unrealizedPnl = rt.unrealizedPnl;
    const peakEquity = Math.max(snap.peakEquity, balance + unrealizedPnl);
    const daysTraded = snap.dailyPnl.length;
    const largestWinningDay = snap.dailyPnl.reduce((m, d) => Math.max(m, d.pnl), 0);
    const todayRealized =
      snap.dailyPnl.find((d) => d.day === snap.currentSessionDay)?.pnl ?? 0;
    const result = evaluate({
      config,
      balance,
      unrealizedPnl,
      peakEquity,
      daysTraded,
      largestWinningDay,
      openContracts: snap.positions.reduce((s, p) => s + p.size, 0),
      todayPnl: todayRealized + unrealizedPnl,
      dailyLimitActive: snap.hasDailyLossLimit,
    });
    return { ...snap, balance, unrealizedPnl, peakEquity, result };
  }, [snap, rt.liveBalance, rt.unrealizedPnl]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <Header
        accounts={accounts}
        accountId={accountId}
        onAccount={setAccountId}
        snap={view}
        loading={loading}
        rtStatus={rt.status}
        onRefresh={() => load(accountId)}
      />

      {error && (
        <Banner tone="danger">Couldn&apos;t reach the dashboard API: {error}</Banner>
      )}
      {view?.source === "demo" && (
        <Banner tone="warn">
          Demo data — {view.warning ?? "add TopstepX credentials to .env.local to go live."}
        </Banner>
      )}

      {view && (
        <>
          <section className="mt-5 grid gap-4 md:grid-cols-2">
            <BufferCard snap={view} />
            <ProgressCard snap={view} />
          </section>

          {view.result.dailyLimitActive && <DailyLossCard snap={view} />}

          <Playbook snap={view} />

          {signal?.signal && (
            <section className="mt-4 grid gap-4 lg:grid-cols-2">
              <SignalCard data={signal} />
              <BestHours hours={signal.bestHours} personal={view.hourlyPerformance} />
            </section>
          )}

          <section className="mt-4 grid gap-4 lg:grid-cols-2">
            <Positions snap={view} prices={rt.priceByContract} />
            <DailyPnl snap={view} />
          </section>
        </>
      )}
    </main>
  );
}

function Header({
  accounts,
  accountId,
  onAccount,
  snap,
  loading,
  rtStatus,
  onRefresh,
}: {
  accounts: AccountListItem[];
  accountId: number | null;
  onAccount: (id: number) => void;
  snap: Snapshot | null;
  loading: boolean;
  rtStatus: RealtimeStatus;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          Topstep Guardrail
          <LiveDot status={rtStatus} />
        </h1>
        <p className="text-sm text-zinc-400">
          {snap ? `${snap.size} Combine` : "Loading…"}
          {snap && (
            <span className="ml-2 text-zinc-600">
              · updated {new Date(snap.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {snap && <StatusBadge status={snap.result.status} />}
        {accounts.length > 0 && (
          <select
            value={accountId ?? ""}
            onChange={(e) => onAccount(Number(e.target.value))}
            className="max-w-60 truncate rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 focus:outline-none"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.size} · {money(a.balance)}
                {a.hasDailyLossLimit ? " · DLL" : ""} — {shortName(a.name)}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={onRefresh}
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
    </header>
  );
}

// "150KTC-V2-230653-26297330" -> "…26297330" (the unique tail)
function shortName(name: string): string {
  const parts = name.split("-");
  return parts[parts.length - 1] ?? name;
}

function LiveDot({ status }: { status: RealtimeStatus }) {
  const map: Record<RealtimeStatus, { label: string; dot: string; text: string }> = {
    connected: { label: "live", dot: "bg-emerald-400", text: "text-emerald-400" },
    connecting: { label: "connecting", dot: "bg-amber-400 animate-pulse", text: "text-amber-400" },
    demo: { label: "demo feed", dot: "bg-sky-400 animate-pulse", text: "text-sky-400" },
    offline: { label: "offline", dot: "bg-zinc-500", text: "text-zinc-500" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-normal ${m.text}`}>
      <span className={`h-2 w-2 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function StatusBadge({ status }: { status: Snapshot["result"]["status"] }) {
  const map = {
    active: { label: "Active", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
    passed: { label: "Pass eligible", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    failed: { label: "Breached", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  }[status];
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${map.cls}`}>
      {map.label}
    </span>
  );
}

function bufferTone(p: number) {
  if (p < 0.2) return { bar: "bg-red-500", text: "text-red-300", ring: "border-red-500/40" };
  if (p < 0.4) return { bar: "bg-amber-500", text: "text-amber-300", ring: "border-amber-500/40" };
  return { bar: "bg-emerald-500", text: "text-emerald-300", ring: "border-emerald-500/40" };
}

function BufferCard({ snap }: { snap: Snapshot }) {
  const { result } = snap;
  const tone = bufferTone(result.bufferPct);
  return (
    <Card className={`border ${tone.ring}`}>
      <CardTitle>Drawdown buffer</CardTitle>
      <div className="mt-1 flex items-end justify-between">
        <div className={`text-4xl font-bold tabular-nums ${tone.text}`}>
          {money(result.bufferToFloor)}
        </div>
        <div className="text-right text-sm text-zinc-400">
          <div>{pct(result.bufferPct)} of window</div>
          <div className="text-xs text-zinc-500">to the trailing floor</div>
        </div>
      </div>
      <Bar pct={result.bufferPct} className={tone.bar} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <Mini label="Equity" value={money(result.equity)} />
        <Mini label="Floor" value={money(result.trailingFloor)} />
        <Mini label="Max risk / trade" value={money(result.suggestedMaxRisk)} />
      </div>
      {result.floorLocked && (
        <p className="mt-2 text-xs text-zinc-500">Floor is locked at your starting balance.</p>
      )}
    </Card>
  );
}

function ProgressCard({ snap }: { snap: Snapshot }) {
  const { result, config } = snap;
  return (
    <Card>
      <CardTitle>Progress to pass</CardTitle>
      <div className="mt-1 flex items-end justify-between">
        <div className="text-4xl font-bold tabular-nums text-zinc-100">
          {moneySigned(result.netProfit)}
        </div>
        <div className="text-right text-sm text-zinc-400">
          <div>{pct(result.profitProgressPct)} of target</div>
          <div className="text-xs text-zinc-500">target {money(config.profitTarget)}</div>
        </div>
      </div>
      <Bar pct={result.profitProgressPct} className="bg-sky-500" />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <Mini label="To target" value={money(result.remainingToTarget)} />
        <Mini label="Days traded" value={`${result.daysTraded}`} />
        <Mini
          label="Min days left"
          value={result.daysRemaining === 0 ? "met" : `${result.daysRemaining}`}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Consistency:{" "}
        <span className={result.consistencyOk ? "text-emerald-400" : "text-amber-400"}>
          {result.consistencyOk ? "on track" : "at risk"}
        </span>
      </p>
    </Card>
  );
}

function DailyLossCard({ snap }: { snap: Snapshot }) {
  const { result } = snap;
  // Color by how much of the daily limit is used.
  const tone =
    result.dailyUsedPct >= 0.8
      ? { bar: "bg-red-500", text: "text-red-300", ring: "border-red-500/40" }
      : result.dailyUsedPct >= 0.5
        ? { bar: "bg-amber-500", text: "text-amber-300", ring: "border-amber-500/40" }
        : { bar: "bg-emerald-500", text: "text-emerald-300", ring: "border-emerald-500/30" };
  return (
    <Card className={`mt-4 border ${tone.ring}`}>
      <div className="flex items-center justify-between">
        <CardTitle>Daily loss limit</CardTitle>
        <span className="text-xs text-zinc-500">
          today {moneySigned(result.todayPnl)} · limit {money(result.dailyLossLimit)}
        </span>
      </div>
      <div className="mt-1 flex items-end justify-between">
        <div className={`text-3xl font-bold tabular-nums ${tone.text}`}>
          {money(result.dailyRemaining)}
        </div>
        <div className="text-right text-sm text-zinc-400">
          <div>{pct(result.dailyUsedPct)} of daily limit used</div>
          <div className="text-xs text-zinc-500">left before the daily stop-out</div>
        </div>
      </div>
      <Bar pct={result.dailyUsedPct} className={tone.bar} />
      {result.dailyUsedPct >= 0.8 && (
        <p className="mt-2 text-sm font-medium text-red-300">
          ⛔ Stop trading — you&apos;re about to hit the daily loss limit and fail the account.
        </p>
      )}
    </Card>
  );
}

function SignalCard({ data }: { data: MarketSignal }) {
  const s = data.signal;
  const tone =
    s.direction === "BUY"
      ? { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", ring: "border-emerald-500/30" }
      : s.direction === "SELL"
        ? { badge: "bg-red-500/15 text-red-300 border-red-500/40", ring: "border-red-500/30" }
        : { badge: "bg-zinc-700/30 text-zinc-300 border-zinc-600/40", ring: "border-zinc-800" };
  const trendIcon = s.trend === "up" ? "↑ uptrend" : s.trend === "down" ? "↓ downtrend" : "→ choppy";
  return (
    <Card className={`border ${tone.ring}`}>
      <div className="flex items-center justify-between">
        <CardTitle>MNQ signal</CardTitle>
        <span className="text-xs text-zinc-500">
          {trendIcon} · {s.type !== "none" ? s.type : "no setup"}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <span className={`rounded-lg border px-3 py-1.5 text-2xl font-bold ${tone.badge}`}>
          {s.direction}
        </span>
        <span className="text-sm text-zinc-400">
          {s.price.toLocaleString()} · RSI {s.rsi}
        </span>
      </div>
      <p className="mt-3 text-sm text-zinc-300">{s.reason}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <Mini label="VWAP" value={s.vwap.toLocaleString()} />
        <Mini label="Prior hr high" value={s.priorHourHigh.toLocaleString()} />
        <Mini label="Prior hr low" value={s.priorHourLow.toLocaleString()} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-zinc-500">
        Heuristic edge, not a guarantee — always use your own stop and risk limits.
      </p>
    </Card>
  );
}

function BestHours({
  hours,
  personal,
}: {
  hours: MarketSignal["bestHours"];
  personal: { hour: number; netUsd: number; trades: number; winRate: number }[];
}) {
  const max = Math.max(1, ...hours.map((h) => h.avgRangeUsd));
  const perfByHour = new Map(personal.map((p) => [p.hour, p]));
  const currentHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(
      new Date()
    )
  );
  const fmtHour = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
  const top = [...hours].sort((a, b) => b.avgRangeUsd - a.avgRangeUsd)[0]?.avgRangeUsd ?? 0;
  const hasPersonal = personal.length > 0;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>Best hours (CT)</CardTitle>
        <span className="text-xs text-zinc-500">market range · your P&amp;L</span>
      </div>
      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
        {hours.map((h) => {
          const isTop = h.avgRangeUsd >= top * 0.8;
          const isNow = h.hour === currentHour;
          const p = perfByHour.get(h.hour);
          return (
            <div key={h.hour} className="flex items-center gap-2 text-xs">
              <span className={`w-8 shrink-0 tabular-nums ${isNow ? "font-bold text-sky-300" : "text-zinc-500"}`}>
                {fmtHour(h.hour)}
              </span>
              <div className="relative h-3.5 flex-1 rounded bg-zinc-800/40">
                <div
                  className={`absolute top-0 h-3.5 rounded ${isTop ? "bg-sky-500/80" : "bg-zinc-600/70"}`}
                  style={{ width: `${(h.avgRangeUsd / max) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right tabular-nums text-zinc-400">${h.avgRangeUsd}</span>
              {hasPersonal && (
                <span
                  className={`w-16 shrink-0 text-right tabular-nums ${
                    !p ? "text-zinc-700" : p.netUsd > 0 ? "text-emerald-400" : p.netUsd < 0 ? "text-red-400" : "text-zinc-500"
                  }`}
                  title={p ? `${p.trades} trades, ${p.winRate}% win` : "no trades this hour"}
                >
                  {p ? `${p.netUsd >= 0 ? "+" : ""}$${p.netUsd}` : "—"}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Blue = market&apos;s most active hours.{" "}
        {hasPersonal ? "Right column = your net P&L that hour (hover for win-rate)." : "Trade more to see your P&L by hour."}
      </p>
    </Card>
  );
}

function Playbook({ snap }: { snap: Snapshot }) {
  const { dos, donts } = snap.result.playbook;
  return (
    <Card>
      <CardTitle>Playbook — do / don&apos;t</CardTitle>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-400">
            Do
          </div>
          <ul className="space-y-2">
            {dos.map((d, i) => (
              <li key={i} className="flex gap-2 text-sm text-zinc-300">
                <span className="text-emerald-400">✓</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-400">
            Don&apos;t
          </div>
          <ul className="space-y-2">
            {donts.map((d, i) => (
              <li key={i} className="flex gap-2 text-sm text-zinc-300">
                <span className="text-red-400">✕</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function Positions({ snap, prices }: { snap: Snapshot; prices: Record<string, number> }) {
  return (
    <Card>
      <CardTitle>Open positions</CardTitle>
      {snap.positions.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">Flat — no open positions.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="pb-2 font-normal">Contract</th>
              <th className="pb-2 font-normal">Side</th>
              <th className="pb-2 text-right font-normal">Size</th>
              <th className="pb-2 text-right font-normal">Avg</th>
              <th className="pb-2 text-right font-normal">Last</th>
              <th className="pb-2 text-right font-normal">Open P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {snap.positions.map((p, i) => {
              const last = prices[p.contractId];
              const dir = p.side === "Long" ? 1 : -1;
              const upl =
                last != null ? (last - p.averagePrice) * p.size * p.pointValue * dir : null;
              return (
                <tr key={i} className="border-t border-zinc-800">
                  <td className="py-2 font-mono text-xs">{p.contractId}</td>
                  <td className={p.side === "Long" ? "text-emerald-400" : "text-red-400"}>
                    {p.side}
                  </td>
                  <td className="text-right tabular-nums">{p.size}</td>
                  <td className="text-right tabular-nums">{p.averagePrice}</td>
                  <td className="text-right tabular-nums">{last != null ? last.toFixed(2) : "—"}</td>
                  <td
                    className={`text-right tabular-nums ${
                      upl == null ? "text-zinc-500" : upl >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {upl != null ? moneySigned(upl) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DailyPnl({ snap }: { snap: Snapshot }) {
  const days = snap.dailyPnl.slice(-10);
  const max = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  return (
    <Card>
      <CardTitle>Daily P&amp;L</CardTitle>
      {days.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No closed trades in range.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {days.map((d) => (
            <div key={d.day} className="flex items-center gap-3 text-sm">
              <span className="w-16 shrink-0 text-xs text-zinc-500">{d.day.slice(5)}</span>
              <span className="w-16 shrink-0 text-right text-xs text-zinc-500 tabular-nums">
                {d.trades} {d.trades === 1 ? "trade" : "trades"}
              </span>
              <div className="relative h-4 flex-1 rounded bg-zinc-800/40">
                <div
                  className={`absolute top-0 h-4 rounded ${d.pnl >= 0 ? "bg-emerald-500/70" : "bg-red-500/70"}`}
                  style={{ width: `${(Math.abs(d.pnl) / max) * 100}%` }}
                />
              </div>
              <span
                className={`w-20 shrink-0 text-right tabular-nums ${d.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
              >
                {moneySigned(d.pnl)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── primitives ────────────────────────────────────────────────────────────────
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 ${className}`}>
      {children}
    </div>
  );
}
function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-medium text-zinc-400">{children}</h2>;
}
function Bar({ pct: p, className }: { pct: number; className: string }) {
  return (
    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.round(p * 100)}%` }} />
    </div>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-800/40 px-2 py-1.5">
      <div className="text-zinc-500">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums text-zinc-200">{value}</div>
    </div>
  );
}
function Banner({ tone, children }: { tone: "info" | "warn" | "danger"; children: React.ReactNode }) {
  const cls = {
    info: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    danger: "border-red-500/30 bg-red-500/10 text-red-200",
  }[tone];
  return <div className={`mt-4 rounded-lg border px-4 py-2.5 text-sm ${cls}`}>{children}</div>;
}

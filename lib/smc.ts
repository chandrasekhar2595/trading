// "Range → Change → Execution" market-structure model (BOS / CHoCH + FVG).
//
//  1. RANGE  (15m) — who's in control? Track confirmed swing highs/lows. A close
//     through the latest swing high = buyers in control; through the latest swing
//     low = sellers. Same direction = BOS, flip = CHoCH.
//  2. CHANGE (1m)  — wait for a 1m CHoCH in the direction the 15m is in control,
//     carried by a high-impact fair value gap (displacement) that price hasn't
//     traded back into yet. The top of that breakdown leg (bottom for longs) is
//     the "liquidity inflection level" (LIL).
//  3. EXECUTION    — limit entry a hair before the FVG midpoint, stop just past
//     the LIL, target 1:4. Move stop to break-even only on a new BOS (a close
//     through the impulse extreme). Next unfilled 15m FVG midpoint = runner target.
//
// The engine is a pure, causal replay: every decision at bar i uses only bars
// that had closed by then. The live Telegram monitor and the backtest both call
// `runSmc`, so what you're alerted on is exactly what was backtested.

import type { Bar } from "./topstepx";

export type Side = "long" | "short";
type Dir = "bull" | "bear";

export interface SmcConfig {
  tick: number;
  pivotLtf: number; // bars each side to confirm a 1m swing
  pivotHtf: number; // bars each side to confirm a 15m swing
  htfMinutes: number;
  rr: number; // take-profit in R
  fvgMinAtr: number; // "high impact": gap must be ≥ this × ATR(14) on 1m
  minRiskPts: number;
  maxRiskPts: number;
  stopBufferTicks: number; // stop sits this far past the LIL
  entryOffsetTicks: number; // enter slightly before the midpoint so you get filled
  expiryBars: number; // cancel an unfilled setup after this many 1m bars
  tz: string;
  entryStartMin: number; // new setups only inside this window (minutes of day, tz)
  entryEndMin: number;
  flatMin: number; // flatten any open trade at/after this time
}

export const DEFAULT_SMC: SmcConfig = {
  tick: 0.25,
  pivotLtf: 3,
  pivotHtf: 2,
  htfMinutes: 15,
  rr: 4,
  fvgMinAtr: 0.3,
  minRiskPts: 4,
  maxRiskPts: 40,
  stopBufferTicks: 2,
  entryOffsetTicks: 1,
  expiryBars: 30,
  tz: "America/Chicago",
  entryStartMin: 8 * 60 + 30, // NY open (08:30 CT)
  entryEndMin: 11 * 60, // backtest: setups after 11:00 CT were 0 for 7
  flatMin: 15 * 60 + 5, // before Topstep's 3:10pm CT auto-flat
};

export interface Fvg {
  top: number;
  bottom: number;
  mid: number;
}

export type SetupStatus =
  | "pending"
  | "open"
  | "target"
  | "stopped"
  | "breakeven"
  | "session_close"
  | "cancelled";

export interface Setup {
  id: string;
  side: Side;
  createdAt: string; // close-bar time of the CHoCH
  chochLevel: number; // swing that was broken
  lil: number; // liquidity inflection level (leg extreme)
  fvg: Fvg;
  entry: number;
  stop: number; // initial stop
  target: number; // rr target
  htfTarget: number | null; // next unfilled 15m FVG midpoint beyond entry
  bosLevel: number; // close beyond this → move stop to break-even
  risk: number; // points
  status: SetupStatus;
  cancelReason?: string;
  fillTime?: string;
  movedToBe?: boolean;
  exitTime?: string;
  exitPrice?: number;
  r?: number; // realized R (before costs)
}

export type SmcEventKind =
  | "setup"
  | "filled"
  | "breakeven"
  | "target"
  | "stopped"
  | "breakeven_stop"
  | "session_close"
  | "cancelled";

export interface SmcEvent {
  kind: SmcEventKind;
  barIndex: number;
  time: string; // bar open time of the bar at whose CLOSE this became known
  setup: Setup;
}

export interface SmcResult {
  setups: Setup[];
  events: SmcEvent[];
  htfBias: Dir | null;
  ltfBias: Dir | null;
  lastPrice: number;
  active: Setup | null;
}

// ── time helpers ─────────────────────────────────────────────────────────────
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function minuteOfDay(iso: string, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    fmtCache.set(tz, f);
  }
  const [h, m] = f.format(new Date(iso)).split(":").map(Number);
  return (h % 24) * 60 + m;
}
const ms = (iso: string) => new Date(iso).getTime();

// ── market structure tracker ─────────────────────────────────────────────────
interface Swing {
  idx: number;
  price: number;
  broken: boolean;
}

interface Break {
  dir: Dir;
  kind: "BOS" | "CHOCH";
  swing: Swing;
}

class Structure {
  state: Dir | null = null;
  lastHigh: Swing | null = null;
  lastLow: Swing | null = null;
  constructor(private bars: Bar[], private n: number) {}

  /** Process bar i (just closed). Returns a structure break if its close made one. */
  update(i: number): Break | null {
    const { bars, n } = this;
    const p = i - n; // pivot candidate is confirmed once n bars follow it
    if (p >= n) {
      let isHigh = true;
      let isLow = true;
      for (let k = p - n; k <= p + n; k++) {
        if (k === p) continue;
        if (k < p ? bars[k].h >= bars[p].h : bars[k].h > bars[p].h) isHigh = false;
        if (k < p ? bars[k].l <= bars[p].l : bars[k].l < bars[p].l) isLow = false;
      }
      if (isHigh) this.lastHigh = { idx: p, price: bars[p].h, broken: false };
      if (isLow) this.lastLow = { idx: p, price: bars[p].l, broken: false };
    }
    const c = bars[i].c;
    if (this.lastHigh && !this.lastHigh.broken && c > this.lastHigh.price) {
      this.lastHigh.broken = true;
      const kind = this.state === "bull" ? "BOS" : "CHOCH";
      this.state = "bull";
      return { dir: "bull", kind, swing: this.lastHigh };
    }
    if (this.lastLow && !this.lastLow.broken && c < this.lastLow.price) {
      this.lastLow.broken = true;
      const kind = this.state === "bear" ? "BOS" : "CHOCH";
      this.state = "bear";
      return { dir: "bear", kind, swing: this.lastLow };
    }
    return null;
  }
}

// ── HTF fair value gaps (draw-on-liquidity targets) ──────────────────────────
interface HtfGap extends Fvg {
  dir: Dir; // bull gap sits below price (support), bear gap above (resistance)
  filled: boolean; // price traded through its midpoint
}

function updateHtfGaps(gaps: HtfGap[], bars: Bar[], j: number) {
  const b = bars[j];
  for (const g of gaps) {
    if (g.filled) continue;
    if (g.dir === "bull" && b.l <= g.mid) g.filled = true;
    if (g.dir === "bear" && b.h >= g.mid) g.filled = true;
  }
  if (j < 2) return;
  const a = bars[j - 2];
  if (b.l > a.h) gaps.push({ dir: "bull", top: b.l, bottom: a.h, mid: (b.l + a.h) / 2, filled: false });
  if (b.h < a.l) gaps.push({ dir: "bear", top: a.l, bottom: b.h, mid: (a.l + b.h) / 2, filled: false });
  if (gaps.length > 200) gaps.splice(0, gaps.length - 200);
}

function atrAt(bars: Bar[], i: number, period = 14): number {
  let sum = 0;
  let n = 0;
  for (let k = Math.max(1, i - period + 1); k <= i; k++) {
    const b = bars[k];
    const pc = bars[k - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    n++;
  }
  return n ? sum / n : 0;
}

const roundTick = (x: number, tick: number) => Math.round(x / tick) * tick;

// ── the model ────────────────────────────────────────────────────────────────
export function runSmc(bars: Bar[], htfBars: Bar[], cfg: SmcConfig = DEFAULT_SMC): SmcResult {
  const ltf = new Structure(bars, cfg.pivotLtf);
  const htf = new Structure(htfBars, cfg.pivotHtf);
  const htfGaps: HtfGap[] = [];
  const setups: Setup[] = [];
  const events: SmcEvent[] = [];
  const htfMs = cfg.htfMinutes * 60_000;
  let hp = 0; // next HTF bar to process
  let active: Setup | null = null;
  let activeCreatedIdx = 0;
  let stop = 0; // live stop of the active trade (moves to BE)

  const emit = (kind: SmcEventKind, i: number, s: Setup) =>
    events.push({ kind, barIndex: i, time: bars[i].t, setup: { ...s } });

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const closeT = ms(b.t) + 60_000;
    const mod = minuteOfDay(b.t, cfg.tz) + 1; // minute-of-day at bar close

    // Advance the 15m context to include only HTF bars closed by now.
    while (hp < htfBars.length && ms(htfBars[hp].t) + htfMs <= closeT) {
      htf.update(hp);
      updateHtfGaps(htfGaps, htfBars, hp);
      hp++;
    }

    const brk = ltf.update(i);

    // ── manage the active setup on this bar ──
    if (active) {
      const s = active;
      const short = s.side === "short";
      const t = cfg.tick;
      if (s.status === "pending") {
        const touched = short ? b.h >= s.entry + t : b.l <= s.entry - t; // trade-through fill
        if (touched) {
          s.status = "open";
          s.fillTime = b.t;
          stop = s.stop;
          emit("filled", i, s);
          const stoppedSameBar = short ? b.h >= stop : b.l <= stop;
          if (stoppedSameBar) close(s, i, "stopped", stop);
        } else if (short ? b.l <= s.target : b.h >= s.target) {
          cancel(s, i, "target reached before fill");
        } else if (i - activeCreatedIdx >= cfg.expiryBars) {
          cancel(s, i, `not filled within ${cfg.expiryBars} min`);
        } else if (mod >= cfg.flatMin || mod < cfg.entryStartMin - 60) {
          cancel(s, i, "session over");
        } else if (brk && brk.dir !== (short ? "bear" : "bull")) {
          cancel(s, i, "1m structure flipped against it");
        }
      } else if (s.status === "open") {
        if (short ? b.h >= stop : b.l <= stop) {
          close(s, i, s.movedToBe ? "breakeven" : "stopped", stop);
        } else if (short ? b.l <= s.target - t : b.h >= s.target + t) {
          close(s, i, "target", s.target);
        } else if (mod >= cfg.flatMin) {
          close(s, i, "session_close", b.c);
        } else if (!s.movedToBe && (short ? b.c < s.bosLevel : b.c > s.bosLevel)) {
          s.movedToBe = true;
          stop = s.entry;
          emit("breakeven", i, s);
        }
      }
      if (s.status !== "pending" && s.status !== "open") active = null;
    }

    // ── look for a new setup: 1m CHoCH aligned with 15m control ──
    if (!active && brk && brk.kind === "CHOCH" && htf.state === brk.dir) {
      if (mod >= cfg.entryStartMin && mod < cfg.entryEndMin) {
        const s = buildSetup(bars, i, brk, htfGaps, cfg);
        if (s) {
          setups.push(s);
          active = s;
          activeCreatedIdx = i;
          emit("setup", i, s);
        }
      }
    }
  }

  function close(s: Setup, i: number, status: SetupStatus, price: number) {
    s.status = status;
    s.exitTime = bars[i].t;
    s.exitPrice = price;
    s.r = (s.side === "long" ? price - s.entry : s.entry - price) / s.risk;
    emit(status === "breakeven" ? "breakeven_stop" : (status as SmcEventKind), i, s);
  }
  function cancel(s: Setup, i: number, reason: string) {
    s.status = "cancelled";
    s.cancelReason = reason;
    emit("cancelled", i, s);
  }

  return {
    setups,
    events,
    htfBias: htf.state,
    ltfBias: ltf.state,
    lastPrice: bars.length ? bars[bars.length - 1].c : 0,
    active,
  };
}

function buildSetup(bars: Bar[], i: number, brk: Break, htfGaps: HtfGap[], cfg: SmcConfig): Setup | null {
  const short = brk.dir === "bear";
  const from = brk.swing.idx;

  // LIL = extreme of the leg between the broken swing and the CHoCH bar.
  let legIdx = from;
  for (let k = from; k <= i; k++) {
    if (short ? bars[k].h > bars[legIdx].h : bars[k].l < bars[legIdx].l) legIdx = k;
  }
  const lil = short ? bars[legIdx].h : bars[legIdx].l;

  // Largest displacement FVG in the impulse leg (leg extreme → CHoCH bar) that
  // price hasn't traded back to the midpoint of yet.
  const atr = atrAt(bars, i);
  let best: Fvg | null = null;
  for (let j = Math.max(legIdx + 2, 2); j <= i; j++) {
    const a = bars[j - 2];
    const c = bars[j];
    const gap: Fvg | null = short
      ? c.h < a.l ? { top: a.l, bottom: c.h, mid: (a.l + c.h) / 2 } : null
      : c.l > a.h ? { top: c.l, bottom: a.h, mid: (c.l + a.h) / 2 } : null;
    if (!gap || gap.top - gap.bottom < cfg.fvgMinAtr * atr) continue;
    let mitigated = false;
    for (let k = j + 1; k <= i; k++) {
      if (short ? bars[k].h >= gap.mid : bars[k].l <= gap.mid) mitigated = true;
    }
    if (mitigated) continue;
    if (!best || gap.top - gap.bottom > best.top - best.bottom) best = gap;
  }
  if (!best) return null;

  const t = cfg.tick;
  const off = cfg.entryOffsetTicks * t;
  const entry = roundTick(short ? best.mid - off : best.mid + off, t);
  const stop = roundTick(short ? lil + cfg.stopBufferTicks * t : lil - cfg.stopBufferTicks * t, t);
  const risk = short ? stop - entry : entry - stop;
  if (risk < cfg.minRiskPts || risk > cfg.maxRiskPts) return null;
  if (short ? bars[i].c >= entry : bars[i].c <= entry) return null;
  const target = roundTick(short ? entry - cfg.rr * risk : entry + cfg.rr * risk, t);

  // Draw on liquidity: nearest unfilled opposing 15m gap beyond the entry.
  let htfTarget: number | null = null;
  for (const g of htfGaps) {
    if (g.filled) continue;
    if (short && g.dir === "bull" && g.mid < entry && (htfTarget === null || g.mid > htfTarget)) htfTarget = g.mid;
    if (!short && g.dir === "bear" && g.mid > entry && (htfTarget === null || g.mid < htfTarget)) htfTarget = g.mid;
  }

  // Break-even trigger: a close beyond the impulse extreme (the CHoCH bar) is the
  // next BOS in the trade's direction.
  const bosLevel = short ? bars[i].l : bars[i].h;

  return {
    id: `${bars[i].t}:${short ? "S" : "L"}`,
    side: short ? "short" : "long",
    createdAt: bars[i].t,
    chochLevel: brk.swing.price,
    lil,
    fvg: best,
    entry,
    stop,
    target,
    htfTarget: htfTarget === null ? null : roundTick(htfTarget, t),
    bosLevel,
    risk,
    status: "pending",
  };
}

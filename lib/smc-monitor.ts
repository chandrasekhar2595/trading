// Telegram alerts for the Range → Change → Execution (BOS/CHoCH + FVG) model.
//
// Each minute: pull 15m + 1m MNQ bars, replay the engine in lib/smc.ts, and
// alert only on events that happened on bars we haven't seen yet:
//   • SETUP     — limit entry / stop / 1:4 target / 15m FVG runner target
//   • FILLED    — your limit would have been hit
//   • BREAKEVEN — new BOS in your direction: move stop to entry
//   • TARGET / STOPPED / BE-STOP / SESSION CLOSE — trade is over
//   • CANCELLED — pending limit is no longer valid: pull your order
//
// State is in-process (dedupe). On a cold start we only alert the newest bar,
// so a restart never replays old setups at you.

import { retrieveBars } from "./topstepx";
import { mnqContractId } from "./market-signal";
import { sendAlert } from "./telegram";
import { ALERTS } from "./alert-config";
import { runSmc, DEFAULT_SMC, type SmcEvent } from "./smc";

const sent = new Set<string>();
let lastBarT: string | null = null;

export interface SmcCheck {
  htfBias: string | null;
  ltfBias: string | null;
  price: number;
  active: { side: string; status: string; entry: number; stop: number; target: number } | null;
  newEvents: string[];
  alerted: boolean;
}

const px = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function message(e: SmcEvent): string {
  const s = e.setup;
  const side = s.side.toUpperCase();
  const icon = s.side === "long" ? "🟢" : "🔴";
  switch (e.kind) {
    case "setup":
      return (
        `${icon} ${s.side === "long" ? "BUY" : "SELL"} MNQ — place ${s.side === "long" ? "BUY" : "SELL"} LIMIT ${px(s.entry)}\n` +
        `(15m bias + 1m CHoCH + FVG)\n` +
        `Stop ${px(s.stop)} (${px(s.risk)} pts = $${(s.risk * 2).toFixed(0)}/contract)\n` +
        `Target 1:${DEFAULT_SMC.rr} ${px(s.target)}` +
        (s.htfTarget !== null ? `\n15m FVG runner ${px(s.htfTarget)}` : "") +
        `\nMove stop to BE on a close ${s.side === "long" ? "above" : "below"} ${px(s.bosLevel)}.\n` +
        `Cancel if not filled in ${DEFAULT_SMC.expiryBars} min.`
      );
    case "filled":
      return `✅ MNQ ${side} filled @ ${px(s.entry)} · stop ${px(s.stop)} · target ${px(s.target)}`;
    case "breakeven":
      return `🛡️ MNQ ${side}: new BOS — move stop to break-even ${px(s.entry)}`;
    case "target":
      return `🎯 MNQ ${side} hit 1:${DEFAULT_SMC.rr} target ${px(s.target)} (+${s.r?.toFixed(1)}R)` +
        (s.htfTarget !== null ? `\nRunner target: 15m FVG ${px(s.htfTarget)}` : "");
    case "stopped":
      return `❌ MNQ ${side} stopped @ ${px(s.exitPrice ?? s.stop)} (−1R)`;
    case "breakeven_stop":
      return `➖ MNQ ${side} stopped at break-even ${px(s.entry)}`;
    case "session_close":
      return `⏰ MNQ ${side}: session ending — flatten @ ~${px(s.exitPrice ?? 0)} (${s.r?.toFixed(1)}R)`;
    case "cancelled":
      return `🚫 MNQ ${side} setup cancelled — ${s.cancelReason}. Pull the limit at ${px(s.entry)}.`;
  }
}

export async function checkSmc(): Promise<SmcCheck> {
  const cid = await mnqContractId();
  // Sequential to avoid concurrent logins racing the single-session token.
  const htf = await retrieveBars(cid, 2, 15, 200);
  const ltf = await retrieveBars(cid, 2, 1, 600);
  const res = runSmc(ltf, htf, DEFAULT_SMC);

  const newest = ltf.length ? ltf[ltf.length - 1].t : null;
  const cutoff = lastBarT ?? (ltf.length > 1 ? ltf[ltf.length - 2].t : null);
  const fresh = res.events.filter((e) => cutoff === null || e.time > cutoff);
  lastBarT = newest;

  let alerted = false;
  const newEvents: string[] = [];
  for (const e of fresh) {
    const key = `${e.setup.id}:${e.kind}`;
    if (sent.has(key)) continue;
    sent.add(key);
    newEvents.push(key);
    if (ALERTS.smc) {
      const r = await sendAlert(message(e));
      alerted = alerted || r.sent > 0;
    }
  }
  if (sent.size > 500) sent.clear();

  const a = res.active;
  return {
    htfBias: res.htfBias,
    ltfBias: res.ltfBias,
    price: res.lastPrice,
    active: a ? { side: a.side, status: a.status, entry: a.entry, stop: a.stop, target: a.target } : null,
    newEvents,
    alerted,
  };
}

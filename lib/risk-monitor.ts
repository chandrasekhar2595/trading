// Risk alerts — the ones that actually protect capital.
//
// Fires a Telegram alert as an account approaches the Daily Loss Limit or the
// trailing max-loss floor. Only checked for accounts that are actually exposed
// (open position, or already down on the session) to bound API load.
//
// NOTE: dedupe state is in-process. On serverless this can re-fire after a cold
// start. For a risk alert a duplicate is far safer than a miss, so this is an
// acceptable interim; durable dedupe (Upstash) is the proper fix.

import { getSnapshot, listAccounts } from "./account-snapshot";
import { searchOpenPositions } from "./topstepx";
import { sendAlert } from "./telegram";
import { ALERTS } from "./alert-config";

type Level = "breached" | "daily85" | "daily70" | "buffer20" | "buffer35";

const fired = new Set<string>(); // `${accountId}:${level}:${sessionDay}`

export interface RiskCheck {
  accountId: number;
  name: string;
  level: Level | "ok";
  alerted: boolean;
}

export async function checkRisk(): Promise<RiskCheck[]> {
  const out: RiskCheck[] = [];
  let accounts;
  try {
    accounts = await listAccounts();
  } catch {
    return out;
  }

  for (const a of accounts) {
    try {
      // Only spend API calls on accounts with live exposure.
      const positions = await searchOpenPositions(a.id);
      const exposed = positions.length > 0;
      if (!exposed) continue;

      const snap = await getSnapshot(undefined, a.id);
      const r = snap.result;
      const day = snap.currentSessionDay;

      let level: Level | null = null;
      let msg = "";

      if (r.status === "failed") {
        level = "breached";
        msg = `🚫 ${a.size} ${shortId(a.name)} — ACCOUNT BREACHED.\nStop trading immediately.`;
      } else if (r.dailyLimitActive && r.dailyUsedPct >= 0.85) {
        level = "daily85";
        msg = `⛔ ${a.size} ${shortId(a.name)} — STOP FOR THE DAY.\nOnly $${Math.round(r.dailyRemaining)} left before the daily loss limit fails this account.`;
      } else if (r.bufferPct < 0.2) {
        level = "buffer20";
        msg = `⛔ ${a.size} ${shortId(a.name)} — NEAR MAX LOSS.\nOnly $${Math.round(r.bufferToFloor)} to the trailing floor. One bad trade ends the Combine.`;
      } else if (r.dailyLimitActive && r.dailyUsedPct >= 0.7) {
        level = "daily70";
        msg = `⚠️ ${a.size} ${shortId(a.name)} — 70% of your daily loss limit is used.\n$${Math.round(r.dailyRemaining)} of daily room left. Cut size.`;
      } else if (r.bufferPct < 0.35) {
        level = "buffer35";
        msg = `⚠️ ${a.size} ${shortId(a.name)} — drawdown buffer thin.\n$${Math.round(r.bufferToFloor)} to the trailing floor. Trade minimum size.`;
      }

      if (!level) {
        out.push({ accountId: a.id, name: a.name, level: "ok", alerted: false });
        continue;
      }

      const key = `${a.id}:${level}:${day}`;
      let alerted = false;
      if (ALERTS.risk && !fired.has(key)) {
        const res = await sendAlert(msg);
        alerted = res.sent > 0;
        if (alerted) fired.add(key);
      }
      out.push({ accountId: a.id, name: a.name, level, alerted });
    } catch {
      // one bad account must not kill the whole risk sweep
    }
  }
  return out;
}

function shortId(name: string): string {
  const parts = name.split("-");
  return parts[parts.length - 1] ?? name;
}

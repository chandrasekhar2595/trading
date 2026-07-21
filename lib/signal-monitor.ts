// Telegram alerts for the MNQ signal:
//  • ENTRY: when the signal flips to BUY or SELL.
//  • EXIT: when you're actually holding MNQ and the close condition fires.
//
// Exit alerts are position-aware (checked against your open positions) so you
// only get "close" pings for trades you actually have on. State is in-process;
// we only alert on transitions, so it won't spam.

import { getMarketSignal } from "./market-signal";
import { sendAlert } from "./telegram";
import { listAccounts } from "./account-snapshot";
import { searchOpenPositions } from "./topstepx";
import { ALERTS } from "./alert-config";

let lastDirection: "BUY" | "SELL" | "NEUTRAL" | null = null;
let closeLongAlerted = false;
let closeShortAlerted = false;

export interface SignalCheck {
  direction: string;
  type: string;
  alerted: boolean;
  holding?: { long: boolean; short: boolean };
  note?: string;
}

async function mnqHolding(): Promise<{ long: boolean; short: boolean }> {
  try {
    const accounts = await listAccounts();
    let long = false;
    let short = false;
    for (const a of accounts) {
      const positions = await searchOpenPositions(a.id);
      for (const p of positions) {
        if (!p.contractId.includes(".MNQ.")) continue;
        if (p.type === 1) long = true;
        else if (p.type === 2) short = true;
      }
    }
    return { long, short };
  } catch {
    return { long: false, short: false };
  }
}

export async function checkSignal(): Promise<SignalCheck> {
  const { signal } = await getMarketSignal();
  const dir = signal.direction;

  // Skip the position sweep entirely when no signal alerts are enabled.
  const holding = ALERTS.signalExit ? await mnqHolding() : { long: false, short: false };

  let alerted = false;

  // ENTRY alert on a fresh directional flip.
  if (ALERTS.signalEntry && (dir === "BUY" || dir === "SELL") && dir !== lastDirection) {
    const emoji = dir === "BUY" ? "🟢" : "🔴";
    const res = await sendAlert(
      `${emoji} MNQ ${dir} signal (${signal.type})\n${signal.reason}\n` +
        `Price ${signal.price.toLocaleString()} · RSI ${signal.rsi} · ${signal.trend}trend.`
    );
    alerted = alerted || res.sent > 0;
  }
  lastDirection = dir;

  // EXIT alert only if you actually hold the position and the close just triggered.
  if (holding.long && signal.closeLong && !closeLongAlerted) {
    const res = await sendAlert(`⚠️ MNQ CLOSE LONG\n${signal.closeLongReason}\nPrice ${signal.price.toLocaleString()} · RSI ${signal.rsi}.`);
    alerted = alerted || res.sent > 0;
    closeLongAlerted = true;
  }
  if (!holding.long || !signal.closeLong) closeLongAlerted = false;

  if (holding.short && signal.closeShort && !closeShortAlerted) {
    const res = await sendAlert(`⚠️ MNQ CLOSE SHORT\n${signal.closeShortReason}\nPrice ${signal.price.toLocaleString()} · RSI ${signal.rsi}.`);
    alerted = alerted || res.sent > 0;
    closeShortAlerted = true;
  }
  if (!holding.short || !signal.closeShort) closeShortAlerted = false;

  return { direction: dir, type: signal.type, alerted, holding };
}

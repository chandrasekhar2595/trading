// Fires a Telegram alert when the MNQ signal FLIPS to BUY or SELL. State is kept
// in-process; we only alert on a change into a directional signal (not on every
// poll, and not when it goes back to NEUTRAL), so it won't spam.

import { getMarketSignal } from "./market-signal";
import { sendAlert } from "./telegram";

let lastDirection: "BUY" | "SELL" | "NEUTRAL" | null = null;

export interface SignalCheck {
  direction: string;
  type: string;
  alerted: boolean;
  note?: string;
}

export async function checkSignal(): Promise<SignalCheck> {
  const { signal } = await getMarketSignal();
  const dir = signal.direction;

  let alerted = false;
  let note: string | undefined;

  if ((dir === "BUY" || dir === "SELL") && dir !== lastDirection) {
    const emoji = dir === "BUY" ? "🟢" : "🔴";
    const msg =
      `${emoji} MNQ ${dir} signal (${signal.type})\n` +
      `${signal.reason}\n` +
      `Price ${signal.price.toLocaleString()} · RSI ${signal.rsi} · ${signal.trend}trend.`;
    const res = await sendAlert(msg);
    alerted = res.sent > 0;
    if (!alerted) note = res.reason ?? res.errors?.join("; ");
  }

  lastDirection = dir;
  return { direction: dir, type: signal.type, alerted, note };
}

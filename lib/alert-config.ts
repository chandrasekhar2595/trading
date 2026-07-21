// Which alerts are allowed to reach your phone.
//
// Principle: an alert must be RARE and demand ACTION. Anything that fires
// routinely trains you to ignore all alerts — including the one that saves the
// account. Default is risk-only.
//
// Override per-type with env flags (e.g. ALERTS_RSI=1) if you want them back.

const on = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : v === "1" || v === "true");

export const ALERTS = {
  /** RSI 70/30 crosses. OFF: fires many times a day on a 1-min chart, not actionable. */
  rsiCross: on(process.env.ALERTS_RSI, false),
  /** BUY/SELL entry signals. OFF: backtested at negative expectancy — acting on these loses money. */
  signalEntry: on(process.env.ALERTS_SIGNAL_ENTRY, false),
  /** CLOSE alerts while holding a position. OFF by default; risk gates cover the dangerous case. */
  signalExit: on(process.env.ALERTS_SIGNAL_EXIT, false),
  /** Daily loss limit / drawdown / breach. ON: rare, and each one can save the account. */
  risk: on(process.env.ALERTS_RISK, true),
};

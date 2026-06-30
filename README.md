# Topstep Guardrail

A live risk-monitor + trading playbook for the **Topstep Trading Combine**. It
authenticates to the **TopstepX / ProjectX Gateway API**, pulls your account,
positions, and trades, then runs a rules engine that tells you, in real time,
**what to do and what not to do** so you don't blow the evaluation.

## What it shows

- **Drawdown buffer** — exactly how much you can lose before hitting the trailing
  Maximum Loss Limit, with green/amber/red urgency and a suggested max risk per trade.
- **Progress to pass** — net profit vs. the profit target, minimum trading days,
  and consistency-rule status.
- **Playbook** — concrete do / don't actions generated from your current numbers.
- **Live signals** — prioritized warnings (e.g. "near max loss limit — stop trading").
- **Open positions** and **daily P&L**.

**Real-time:** the browser connects directly to the ProjectX **SignalR** user +
market hubs for live fills, positions, and quotes. Unrealized P&L is computed from
live prices and feeds the drawdown buffer in real time (`$/point` per contract comes
from the contract API, with a fallback table for common futures). REST stays the
authoritative source (5s poll); quotes drive the sub-second updates. The header dot
shows the feed state: green `live`, amber `connecting`, blue `demo feed`, grey `offline`.

It falls back to **demo data** (with a simulated quote feed) until you add credentials,
so you can see the whole thing immediately.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add your TopstepX credentials. Copy `.env.example` to `.env.local` and fill in:

   ```
   TOPSTEPX_USERNAME=your_topstepx_login
   TOPSTEPX_API_KEY=your_generated_api_key
   ```

   Generate the API key inside TopstepX: **Settings → API Access → Generate Key**.
   Optionally set `TOPSTEPX_ACCOUNT_ID` to pin a specific account.

3. Run it (run this while you trade):

   ```bash
   npm run dev
   ```

   Open http://localhost:3000.

## Rules accuracy ⚠️

Prop-firm rules change. The defaults in [`lib/rules.ts`](lib/rules.ts) encode the
common Topstep Combine structure (trailing Maximum Loss Limit + profit target per
account size). **Verify the profit target, trailing max-loss amount, contract cap,
minimum trading days, and consistency rule against your current Topstep agreement**
and edit `COMBINE_CONFIGS` if anything differs.

## Known limitations / things to verify

- **Verify event + quote payload shapes against live Topstep.** The SignalR handlers
  in [`lib/use-realtime.ts`](lib/use-realtime.ts) read fields defensively, but the exact
  `GatewayQuote` / `GatewayUserPosition` shapes should be confirmed with a real
  connection and adjusted if needed.
- The trailing floor is modeled as `peakEquity − maxLossLimit`, locking once the
  account banks a full window of profit. The peak is reconstructed from trade history
  plus live equity; it won't capture an intraday unrealized peak that occurred before
  the dashboard was open.

## Next steps (easy to add)

- Persist the equity high-water mark (Vercel KV / Upstash) instead of reconstructing it.
- Push/browser notifications when the buffer crosses a threshold.
- Per-trade journaling and behavioral nudges (overtrading / revenge-trading detection).

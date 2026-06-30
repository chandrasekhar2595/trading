// Wilder's RSI. Returns a series aligned to `closes` (entries before `period`
// are NaN). Use the last two defined values to detect a threshold cross.

export function rsiSeries(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Latest two defined RSI values [previous, current], or null if not enough data. */
export function lastTwoRsi(closes: number[], period = 14): [number, number] | null {
  const s = rsiSeries(closes, period);
  let cur = NaN;
  let prev = NaN;
  for (let i = s.length - 1; i >= 0; i--) {
    if (!Number.isNaN(s[i])) {
      if (Number.isNaN(cur)) cur = s[i];
      else {
        prev = s[i];
        break;
      }
    }
  }
  if (Number.isNaN(cur) || Number.isNaN(prev)) return null;
  return [prev, cur];
}

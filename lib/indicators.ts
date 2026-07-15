// Small set of pure technical-indicator helpers used by the signal engine.

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Volume-weighted average price over the last `lookback` bars (rolling VWAP). */
export function rollingVwap(
  bars: { h: number; l: number; c: number; v: number }[],
  lookback: number
): number {
  const slice = bars.slice(-lookback);
  let pv = 0;
  let vol = 0;
  for (const b of slice) {
    const typical = (b.h + b.l + b.c) / 3;
    const v = b.v || 0;
    pv += typical * v;
    vol += v;
  }
  if (vol > 0) return pv / vol;
  return slice.length ? slice[slice.length - 1].c : 0;
}

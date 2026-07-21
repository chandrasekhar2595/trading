import { NextRequest, NextResponse } from "next/server";
import { checkRsi } from "@/lib/rsi-monitor";
import { checkSignal } from "@/lib/signal-monitor";
import { checkRisk } from "@/lib/risk-monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // If CRON_SECRET is set, require it — accept it either as a Bearer header or a
  // ?key= query param, so any free scheduler (header-capable or not) can trigger it.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const key = req.nextUrl.searchParams.get("key");
    if (auth !== `Bearer ${secret}` && key !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Each minute: RSI crosses, MNQ signal flips, and account risk gates.
  // Isolated so one failing monitor can't suppress the others.
  const [rsi, signal, risk] = await Promise.all([
    checkRsi(),
    checkSignal().catch((e) => ({ error: String(e) })),
    checkRisk().catch((e) => ({ error: String(e) })),
  ]);
  return NextResponse.json({ ...rsi, signal, risk }, { headers: { "Cache-Control": "no-store" } });
}

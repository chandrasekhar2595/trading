import { NextResponse } from "next/server";
import { getMarketSignal } from "@/lib/market-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const data = await getMarketSignal();
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "signal error";
    return NextResponse.json({ error: message }, { status: 200 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { checkRsi } from "@/lib/rsi-monitor";

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

  const result = await checkRsi();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

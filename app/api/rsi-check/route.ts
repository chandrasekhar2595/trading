import { NextRequest, NextResponse } from "next/server";
import { checkRsi } from "@/lib/rsi-monitor";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // If CRON_SECRET is set, require it (Vercel Cron sends it as a Bearer token).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const result = await checkRsi();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

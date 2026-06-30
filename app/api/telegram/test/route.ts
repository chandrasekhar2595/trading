import { NextResponse } from "next/server";
import { sendAlert, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Fires a one-off test message to all registered chat IDs to confirm delivery.
export async function GET() {
  if (!telegramConfigured()) {
    return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 200 });
  }
  const result = await sendAlert(
    "✅ Topstep Guardrail test — RSI alerts are wired up. You'll get a ping when MNQ RSI(13) crosses above 75 or below 30 on the 1-minute chart."
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

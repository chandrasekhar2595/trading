import { NextResponse } from "next/server";
import { recentChats, registeredChatIds, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Helper to register a phone: message your bot, then GET this route to see the
// chat id, and add it to TELEGRAM_CHAT_IDS in .env.local.
export async function GET() {
  if (!telegramConfigured()) {
    return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 200 });
  }
  const chats = await recentChats();
  return NextResponse.json(
    { registered: registeredChatIds(), recentChats: chats },
    { headers: { "Cache-Control": "no-store" } }
  );
}

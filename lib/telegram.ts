// Telegram alerts. Messages are sent ONLY to the allowlist of registered chat
// IDs in TELEGRAM_CHAT_IDS — even if someone else messages the bot, they get
// nothing unless their chat id is added there.

const API = "https://api.telegram.org";

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export function registeredChatIds(): string[] {
  return (process.env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SendResult {
  sent: number;
  skipped: boolean;
  reason?: string;
}

export async function sendAlert(text: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: 0, skipped: true, reason: "TELEGRAM_BOT_TOKEN not set" };

  const ids = registeredChatIds();
  if (ids.length === 0) return { sent: 0, skipped: true, reason: "no registered chat IDs" };

  let sent = 0;
  await Promise.all(
    ids.map(async (chatId) => {
      try {
        const res = await fetch(`${API}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
        });
        if (res.ok) sent += 1;
      } catch {
        /* ignore individual failures */
      }
    })
  );
  return { sent, skipped: false };
}

export interface ChatRef {
  chatId: number | string;
  name: string;
  registered: boolean;
}

/** Recent chats that have messaged the bot — used to find your chat id to register. */
export async function recentChats(): Promise<ChatRef[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return [];
  const res = await fetch(`${API}/bot${token}/getUpdates`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  const allow = new Set(registeredChatIds());
  const seen = new Map<string, ChatRef>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat;
    if (!chat) continue;
    const id = String(chat.id);
    seen.set(id, {
      chatId: chat.id,
      name: chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? chat.username ?? id,
      registered: allow.has(id),
    });
  }
  return [...seen.values()];
}

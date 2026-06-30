import { NextResponse } from "next/server";
import { listAccounts } from "@/lib/account-snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list accounts";
    return NextResponse.json({ accounts: [], error: message }, { status: 200 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/account-snapshot";
import { COMBINE_CONFIGS, type AccountSize } from "@/lib/rules";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sizeParam = req.nextUrl.searchParams.get("size");
  const size: AccountSize | undefined =
    sizeParam && sizeParam in COMBINE_CONFIGS ? (sizeParam as AccountSize) : undefined;

  const accountIdParam = req.nextUrl.searchParams.get("accountId");
  const accountId = accountIdParam ? Number(accountIdParam) : undefined;

  const snapshot = await getSnapshot(size, accountId);
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}

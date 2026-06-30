// ─────────────────────────────────────────────────────────────────────────────
// Thin client for the ProjectX Gateway API (the platform behind TopstepX).
// Docs: https://gateway.docs.projectx.com / https://api.topstepx.com
//
// Auth flow: POST /api/Auth/loginKey { userName, apiKey } -> JWT, then send the
// JWT as a Bearer token on every subsequent request. Tokens are cached in-module
// and refreshed on 401.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.TOPSTEPX_BASE_URL ?? "https://api.topstepx.com";
export const RTC_URL = process.env.TOPSTEPX_RTC_URL ?? "https://rtc.topstepx.com";

export interface TsAccount {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
  isVisible: boolean;
  simulated?: boolean;
}

export interface TsPosition {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: number; // 1 = long, 2 = short
  size: number;
  averagePrice: number;
}

export interface TsContract {
  id: string;
  name: string;
  description?: string;
  tickSize: number;
  tickValue: number;
}

export interface TsTrade {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null; // null on entry/half-turn fills
  fees: number;
  commissions: number;
  voided: boolean;
  side: number;
  size: number;
}

export function hasCredentials(): boolean {
  return Boolean(process.env.TOPSTEPX_USERNAME && process.env.TOPSTEPX_API_KEY);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const userName = process.env.TOPSTEPX_USERNAME;
  const apiKey = process.env.TOPSTEPX_API_KEY;
  if (!userName || !apiKey) {
    throw new Error("Missing TOPSTEPX_USERNAME / TOPSTEPX_API_KEY environment variables.");
  }

  const res = await fetch(`${BASE_URL}/api/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ userName, apiKey }),
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token || data?.success === false) {
    const reason = data?.errorMessage ?? data?.errorCode ?? `HTTP ${res.status}`;
    throw new Error(`TopstepX auth failed: ${reason}`);
  }

  cachedToken = { token: data.token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return data.token;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const send = async (token: string) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

  let token = await getToken();
  let res = await send(token);

  if (res.status === 401) {
    cachedToken = null;
    token = await getToken();
    res = await send(token);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.success === false)) {
    const reason = data?.errorMessage ?? data?.errorCode ?? `HTTP ${res.status}`;
    throw new Error(`TopstepX ${path} failed: ${reason}`);
  }
  return data as T;
}

export async function searchAccounts(): Promise<TsAccount[]> {
  const data = await post<{ accounts?: TsAccount[] }>("/api/Account/search", {
    onlyActiveAccounts: true,
  });
  return data.accounts ?? [];
}

export async function searchOpenPositions(accountId: number): Promise<TsPosition[]> {
  const data = await post<{ positions?: TsPosition[] }>("/api/Position/searchOpen", {
    accountId,
  });
  return data.positions ?? [];
}

export async function searchTrades(
  accountId: number,
  startTimestamp: string,
  endTimestamp: string
): Promise<TsTrade[]> {
  const data = await post<{ trades?: TsTrade[] }>("/api/Trade/search", {
    accountId,
    startTimestamp,
    endTimestamp,
  });
  return data.trades ?? [];
}

export async function searchContract(contractId: string): Promise<TsContract | null> {
  const data = await post<{ contract?: TsContract; contracts?: TsContract[] }>(
    "/api/Contract/searchById",
    { contractId }
  );
  return data.contract ?? data.contracts?.[0] ?? null;
}

export interface TsContractMeta extends TsContract {
  activeContract?: boolean;
}

/** Search contracts by text (e.g. "MNQ") to resolve the tradeable front month. */
export async function searchContracts(
  searchText: string,
  live = false
): Promise<TsContractMeta[]> {
  const data = await post<{ contracts?: TsContractMeta[] }>("/api/Contract/search", {
    searchText,
    live,
  });
  return data.contracts ?? [];
}

export interface Bar {
  t: string; // bar timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ProjectX bar units: 1=Second, 2=Minute, 3=Hour, 4=Day, 5=Week, 6=Month.
export async function retrieveBars(
  contractId: string,
  unit: number,
  unitNumber: number,
  limit: number
): Promise<Bar[]> {
  const end = new Date();
  // Look back generously so we always get `limit` worth of closed bars.
  const spanMs = unit === 2 ? 60_000 : unit === 3 ? 3_600_000 : 86_400_000;
  const start = new Date(end.getTime() - limit * unitNumber * spanMs * 3);
  const data = await post<{ bars?: Bar[] }>("/api/History/retrieveBars", {
    contractId,
    live: false,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    unit,
    unitNumber,
    limit,
    includePartialBar: false, // closed bars only -> stable RSI
  });
  const bars = data.bars ?? [];
  // Normalize to oldest -> newest.
  return [...bars].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

/** A short-lived JWT the browser uses to connect to the SignalR hubs directly. */
export async function getRealtimeToken(): Promise<string> {
  return getToken();
}

/** Pick the account to monitor: env-pinned id, else first active/visible one. */
export function selectAccount(accounts: TsAccount[]): TsAccount | null {
  if (accounts.length === 0) return null;
  const pinned = process.env.TOPSTEPX_ACCOUNT_ID;
  if (pinned) {
    const match = accounts.find((a) => String(a.id) === String(pinned));
    if (match) return match;
  }
  return accounts.find((a) => a.canTrade && a.isVisible) ?? accounts[0];
}

"use client";

// Connects the browser directly to the ProjectX SignalR hubs:
//   • user hub   -> account balance, position, and trade updates
//   • market hub -> live quotes used to compute unrealized P&L
//
// REST (the /api/snapshot poll in the page) stays the authoritative source for
// balance and positions; this hook layers fast, sub-second price + unrealized
// updates on top. In demo mode (no token) it simulates a drifting quote so the
// live UI is visible without credentials.

import { useEffect, useRef, useState } from "react";
import type { PositionView, RealtimeInfo } from "./account-snapshot";

export type RealtimeStatus = "connecting" | "connected" | "offline" | "demo";

export interface RealtimeState {
  status: RealtimeStatus;
  /** Live balance from the user hub, or null until/unless an update arrives. */
  liveBalance: number | null;
  /** Aggregate unrealized P&L across open positions, in dollars. */
  unrealizedPnl: number;
  /** Latest price seen per contract. */
  priceByContract: Record<string, number>;
}

interface LivePosition {
  contractId: string;
  side: "Long" | "Short";
  size: number;
  averagePrice: number;
  pointValue: number;
}

function computeUnrealized(
  positions: Map<string, LivePosition>,
  prices: Map<string, number>
): number {
  let total = 0;
  for (const p of positions.values()) {
    const price = prices.get(p.contractId);
    if (price == null || p.size === 0) continue;
    const dir = p.side === "Long" ? 1 : -1;
    total += (price - p.averagePrice) * p.size * p.pointValue * dir;
  }
  return Math.round(total * 100) / 100;
}

function extractPrice(args: unknown[]): number | null {
  // GatewayQuote may arrive as (contractId, data) or as a single object.
  const payload = (args.length >= 2 ? args[1] : args[0]) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  const last = payload.lastPrice ?? payload.last ?? payload.price;
  if (typeof last === "number") return last;
  const bid = payload.bestBid ?? payload.bid;
  const ask = payload.bestAsk ?? payload.ask;
  if (typeof bid === "number" && typeof ask === "number") return (bid + ask) / 2;
  return null;
}

export function useRealtime(
  realtime: RealtimeInfo | null,
  basePositions: PositionView[]
): RealtimeState {
  const [status, setStatus] = useState<RealtimeStatus>(realtime ? "connecting" : "demo");
  const [liveBalance, setLiveBalance] = useState<number | null>(null);
  const [unrealizedPnl, setUnrealizedPnl] = useState(0);
  const [priceByContract, setPriceByContract] = useState<Record<string, number>>({});

  // Live refs that the SignalR callbacks mutate without re-triggering effects.
  const positionsRef = useRef<Map<string, LivePosition>>(new Map());
  const pricesRef = useRef<Map<string, number>>(new Map());

  // The token is a stable cached JWT, but the snapshot object identity changes on
  // every 5s poll. Key the connection on primitives so we don't reconnect each poll.
  const realtimeRef = useRef(realtime);
  realtimeRef.current = realtime;
  const connKey = realtime
    ? `${realtime.rtcUrl}|${realtime.accountId}|${realtime.token}`
    : null;

  // Switching accounts must drop the previous account's live balance/prices so its
  // numbers can't bleed into the newly-selected account before fresh data arrives.
  useEffect(() => {
    setLiveBalance(null);
    pricesRef.current.clear();
    setUnrealizedPnl(0);
    setPriceByContract({});
  }, [connKey]);

  // Keep the position map in sync with the latest REST snapshot (authoritative).
  useEffect(() => {
    const next = new Map<string, LivePosition>();
    for (const p of basePositions) {
      next.set(p.contractId, {
        contractId: p.contractId,
        side: p.side,
        size: p.size,
        averagePrice: p.averagePrice,
        pointValue: p.pointValue,
      });
      // Seed price at entry so unrealized starts at 0 until a quote arrives.
      if (!pricesRef.current.has(p.contractId)) {
        pricesRef.current.set(p.contractId, p.averagePrice);
      }
    }
    positionsRef.current = next;
    setUnrealizedPnl(computeUnrealized(positionsRef.current, pricesRef.current));
  }, [basePositions]);

  // ── Demo mode: random-walk a synthetic price so the UI shows live movement ──
  useEffect(() => {
    if (connKey) return;
    setStatus("demo");
    const id = setInterval(() => {
      for (const p of positionsRef.current.values()) {
        const cur = pricesRef.current.get(p.contractId) ?? p.averagePrice;
        const drift = (Math.random() - 0.48) * (p.averagePrice * 0.0004);
        const next = Math.round((cur + drift) * 100) / 100;
        pricesRef.current.set(p.contractId, next);
      }
      setPriceByContract(Object.fromEntries(pricesRef.current));
      setUnrealizedPnl(computeUnrealized(positionsRef.current, pricesRef.current));
    }, 1500);
    return () => clearInterval(id);
  }, [connKey]);

  // ── Live mode: connect to both SignalR hubs ─────────────────────────────────
  useEffect(() => {
    const realtime = realtimeRef.current;
    if (!connKey || !realtime) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let userConn: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let marketConn: any;
    const subscribed = new Set<string>();

    const recompute = () => {
      setPriceByContract(Object.fromEntries(pricesRef.current));
      setUnrealizedPnl(computeUnrealized(positionsRef.current, pricesRef.current));
    };

    const stopAll = () => {
      // stop() rejects if start() is still pending — swallow it.
      userConn?.stop?.().catch(() => {});
      marketConn?.stop?.().catch(() => {});
    };

    (async () => {
      let signalR: typeof import("@microsoft/signalr");
      try {
        signalR = await import("@microsoft/signalr");
      } catch {
        return;
      }
      if (cancelled) return;
      const { token, rtcUrl, accountId } = realtime;

      // NOTE: the TopstepX RTC hubs REQUIRE negotiation (skipNegotiation breaks
      // with "connection ID not present"). Let SignalR negotiate, then use WS.
      const build = (hub: string) =>
        new signalR.HubConnectionBuilder()
          .withUrl(`${rtcUrl}/hubs/${hub}`, {
            accessTokenFactory: () => token,
            transport: signalR.HttpTransportType.WebSockets,
          })
          .withAutomaticReconnect()
          .configureLogging(signalR.LogLevel.None)
          .build();

      userConn = build("user");
      marketConn = build("market");

      const ensureQuote = (cid: string) => {
        if (subscribed.has(cid)) return;
        subscribed.add(cid);
        marketConn.invoke("SubscribeContractQuotes", cid).catch(() => subscribed.delete(cid));
      };

      userConn.on("GatewayUserAccount", (...args: unknown[]) => {
        const data = (args.length >= 2 ? args[1] : args[0]) as Record<string, unknown> | undefined;
        const bal = data?.balance;
        if (typeof bal === "number") setLiveBalance(bal);
      });

      userConn.on("GatewayUserPosition", (...args: unknown[]) => {
        const d = (args.length >= 2 ? args[1] : args[0]) as Record<string, unknown> | undefined;
        if (!d || typeof d.contractId !== "string") return;
        const cid = d.contractId;
        const size = typeof d.size === "number" ? d.size : 0;
        if (size === 0) {
          positionsRef.current.delete(cid);
        } else {
          const existing = positionsRef.current.get(cid);
          positionsRef.current.set(cid, {
            contractId: cid,
            side: d.type === 2 ? "Short" : "Long",
            size,
            averagePrice: typeof d.averagePrice === "number" ? d.averagePrice : existing?.averagePrice ?? 0,
            pointValue: existing?.pointValue ?? 1,
          });
          if (!pricesRef.current.has(cid) && typeof d.averagePrice === "number") {
            pricesRef.current.set(cid, d.averagePrice);
          }
          ensureQuote(cid);
        }
        recompute();
      });

      marketConn.on("GatewayQuote", (...args: unknown[]) => {
        const cid = typeof args[0] === "string" ? (args[0] as string) : undefined;
        const price = extractPrice(args);
        if (price == null) return;
        const key = cid ?? [...positionsRef.current.keys()][0];
        if (!key) return;
        pricesRef.current.set(key, price);
        recompute();
      });

      const subscribeAll = () => {
        userConn.invoke("SubscribeAccounts").catch(() => {});
        userConn.invoke("SubscribePositions", accountId).catch(() => {});
        userConn.invoke("SubscribeTrades", accountId).catch(() => {});
        subscribed.clear();
        for (const cid of positionsRef.current.keys()) ensureQuote(cid);
      };
      userConn.onreconnected(() => {
        if (!cancelled) subscribeAll();
      });

      // allSettled never rejects, so a failed connection won't throw an unhandled
      // rejection (the source of the console spam during StrictMode remounts).
      const results = await Promise.allSettled([userConn.start(), marketConn.start()]);
      if (cancelled) {
        stopAll();
        return;
      }
      if (results.every((r) => r.status === "fulfilled")) {
        setStatus("connected");
        subscribeAll();
      } else {
        // REST polling still keeps the dashboard fully functional.
        setStatus("offline");
        stopAll();
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [connKey]);

  return { status, liveBalance, unrealizedPnl, priceByContract };
}

"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus, PriceUpdate } from "@/lib/types";

export interface PricePoint {
  time: number;
  value: number;
}

const MAX_POINTS = 600;

export interface PriceStream {
  prices: Record<string, PriceUpdate>;
  history: Record<string, PricePoint[]>;
  openPrices: Record<string, number>;
  status: ConnectionStatus;
}

/** Append a price, keeping one point per whole second (latest wins). */
export function appendPoint(points: PricePoint[] = [], update: PriceUpdate): PricePoint[] {
  const time = Math.floor(update.timestamp);
  const last = points[points.length - 1];
  if (last && last.time === time) {
    return [...points.slice(0, -1), { time, value: update.price }];
  }
  if (last && last.time > time) return points;
  return [...points, { time, value: update.price }].slice(-MAX_POINTS);
}

/** Subscribe to /api/stream/prices and accumulate prices and history since page load. */
export function usePriceStream(): PriceStream {
  const [state, setState] = useState<PriceStream>({
    prices: {},
    history: {},
    openPrices: {},
    status: "reconnecting",
  });

  useEffect(() => {
    const source = new EventSource("/api/stream/prices");
    source.onopen = () => setState((s) => ({ ...s, status: "connected" }));
    source.onerror = () =>
      setState((s) => ({
        ...s,
        status: source.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting",
      }));
    source.onmessage = (event) => {
      const updates: Record<string, PriceUpdate> = JSON.parse(event.data);
      setState((s) => {
        const history = { ...s.history };
        const openPrices = { ...s.openPrices };
        for (const u of Object.values(updates)) {
          history[u.ticker] = appendPoint(history[u.ticker], u);
          openPrices[u.ticker] ??= u.price;
        }
        return { prices: updates, history, openPrices, status: "connected" };
      });
    };
    return () => source.close();
  }, []);

  return state;
}

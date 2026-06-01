"use client";

import { useCallback, useEffect, useState } from "react";
import type { Recap } from "./types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://binturong-api.nikita-osminine.workers.dev"
    : "http://localhost:8787");

async function authHeaders(): Promise<HeadersInit> {
  const { supabase } = await import("@/integrations/supabase/client");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetches the latest ready recap for a portfolio (weekly preferred on
 * weekends, else the most recent of either type). Exposes a `markSeen`
 * that clears the "new" indicator.
 */
export function useRecap(portfolioId: string) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRecap = useCallback(async () => {
    if (!portfolioId) return;
    try {
      const headers = await authHeaders();
      // Prefer the weekly recap on Sat/Sun, otherwise the latest of any type.
      const day = new Date().getDay(); // 0=Sun, 6=Sat
      const preferWeekly = day === 0 || day === 6;
      const url = `${API_BASE_URL}/api/recaps?portfolio_id=${portfolioId}${
        preferWeekly ? "&type=weekly" : ""
      }`;
      let res = await fetch(url, { headers });
      let data = res.ok ? ((await res.json()) as Recap | null) : null;
      // Fall back to any type if the preferred one isn't ready yet.
      if (!data && preferWeekly) {
        res = await fetch(`${API_BASE_URL}/api/recaps?portfolio_id=${portfolioId}`, { headers });
        data = res.ok ? ((await res.json()) as Recap | null) : null;
      }
      setRecap(data);
    } catch {
      setRecap(null);
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    setLoading(true);
    fetchRecap();
  }, [fetchRecap]);

  const markSeen = useCallback(async () => {
    if (!recap || recap.seen_at) return;
    setRecap((r) => (r ? { ...r, seen_at: new Date().toISOString() } : r));
    try {
      const headers = await authHeaders();
      await fetch(`${API_BASE_URL}/api/recaps/${recap.id}/seen`, { method: "POST", headers });
    } catch {
      // optimistic; ignore failure
    }
  }, [recap]);

  return { recap, loading, markSeen, refetch: fetchRecap };
}

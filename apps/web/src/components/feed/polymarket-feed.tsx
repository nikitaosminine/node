"use client";

import { useState, useEffect, useCallback } from "react";
import { TrendingUp, RefreshCw, Pin, CalendarDays } from "lucide-react";
import { formatDistanceToNow, isPast } from "date-fns";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://binturong-api.nikita-osminine.workers.dev"
    : "http://localhost:8787");

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolymarketMarket {
  condition_id: string;
  event_id: string | null;
  event_slug: string | null;
  event_title: string | null;
  market_slug: string | null;
  question: string;
  tags: Array<{ id: number; label: string }>;
  outcomes: string[];
  outcome_prices: number[];
  liquidity: number | null;
  volume_24hr: number | null;
  end_date: string | null;
  image: string | null;
  active: boolean;
  fetched_at: string;
}

interface PolymarketMatch {
  is_pinned: boolean;
  score: number | null;
  reason: string | null;
  polymarket_markets: PolymarketMarket;
}

interface FeedData {
  pinned: PolymarketMatch[];
  rotating: PolymarketMatch[];
}

interface PolymarketFeedProps {
  portfolioId: string;
}

// ---------------------------------------------------------------------------
// Market card
// ---------------------------------------------------------------------------

function endDateLabel(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isPast(d)) return "Resolved";
    return `Ends ${formatDistanceToNow(d, { addSuffix: true })}`;
  } catch {
    return null;
  }
}

function MarketCard({ match }: { match: PolymarketMatch }) {
  const m = match.polymarket_markets;

  // Pair outcomes with prices, sort by probability descending
  const pairs: Array<{ label: string; prob: number }> = m.outcomes
    .map((label, i) => ({ label, prob: m.outcome_prices[i] ?? 0 }))
    .sort((a, b) => b.prob - a.prob);

  const isBinary = pairs.length === 2;
  const endLabel = endDateLabel(m.end_date);
  const href = m.event_slug
    ? `https://polymarket.com/event/${m.event_slug}`
    : "https://polymarket.com";

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-3.5 transition-shadow hover:shadow-sm">
      {/* Header: pinned badge + end date */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {match.is_pinned && (
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-foreground-muted/60">
              <Pin className="h-2.5 w-2.5" />
              Pinned
            </div>
          )}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold leading-snug text-foreground hover:underline"
          >
            {m.question}
          </a>
        </div>
        {m.image && (
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={m.image}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
      </div>

      {/* Outcomes */}
      {isBinary ? (
        // 2-outcome bar
        <div className="flex flex-col gap-1">
          <div className="flex overflow-hidden rounded-full" style={{ height: 6 }}>
            <div
              className="bg-positive transition-all"
              style={{ width: `${(pairs[0]?.prob ?? 0) * 100}%` }}
            />
            <div className="flex-1 bg-surface-3" />
          </div>
          <div className="flex justify-between text-xs">
            {pairs.map((p) => (
              <div key={p.label} className="flex items-center gap-1">
                <span className="font-medium text-foreground">{Math.round(p.prob * 100)}%</span>
                <span className="text-foreground-muted">{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Multi-way ranked list (top 4)
        <div className="flex flex-col gap-1.5">
          {pairs.slice(0, 4).map((p) => (
            <div key={p.label} className="flex items-center gap-2">
              <div className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
                {Math.round(p.prob * 100)}%
              </div>
              <div className="relative flex-1 overflow-hidden rounded-full bg-surface-3" style={{ height: 5 }}>
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-foreground/30 transition-all"
                  style={{ width: `${p.prob * 100}%` }}
                />
              </div>
              <div className="min-w-0 flex-1 truncate text-xs text-foreground-muted">{p.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Footer: reason + end date */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-foreground-muted/70">
        {match.reason && !match.is_pinned && (
          <span className="min-w-0 truncate italic">{match.reason}</span>
        )}
        {endLabel && (
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <CalendarDays className="h-3 w-3" />
            {endLabel}
          </span>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Feed header
// ---------------------------------------------------------------------------

function FeedHeader({ title, onRefresh }: { title: string; onRefresh?: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-foreground-muted" />
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="grid h-7 w-7 place-items-center rounded-md text-foreground-muted hover:bg-surface-2 hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main feed component
// ---------------------------------------------------------------------------

export function PolymarketFeed({ portfolioId }: PolymarketFeedProps) {
  const [data, setData] = useState<FeedData>({ pinned: [], rotating: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFeed = useCallback(
    async (showLoadingSpinner = false) => {
      if (showLoadingSpinner) setLoading(true);
      setError(null);
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch(
          `${API_BASE_URL}/api/feed/polymarket?portfolio_id=${portfolioId}`,
          token ? { headers: { Authorization: `Bearer ${token}` } } : {},
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = await res.json() as FeedData;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load markets, retrying…");
      } finally {
        setLoading(false);
      }
    },
    [portfolioId],
  );

  useEffect(() => {
    fetchFeed(true);
  }, [fetchFeed]);

  useEffect(() => {
    const id = setInterval(() => fetchFeed(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchFeed]);

  useEffect(() => {
    const handler = () => fetchFeed(false);
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [fetchFeed]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <FeedHeader title="Markets" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <FeedHeader title="Markets" onRefresh={() => fetchFeed(true)} />
        <div className="rounded-xl border border-border/50 bg-card p-6 text-center text-sm text-foreground-muted">
          {error}
        </div>
      </div>
    );
  }

  const totalItems = data.pinned.length + data.rotating.length;

  if (totalItems === 0) {
    return (
      <div className="flex flex-col gap-3">
        <FeedHeader title="Markets" />
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border/50 bg-card p-8 text-center">
          <TrendingUp className="h-8 w-8 text-foreground-muted/40" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground-muted">No markets yet</p>
            <p className="text-xs text-foreground-muted/70">
              Markets feed is personalized. Import holdings to display relevant markets.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FeedHeader title="Markets" onRefresh={() => fetchFeed(true)} />

      {/* Pinned markets */}
      {data.pinned.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="px-0.5 text-[10px] font-semibold uppercase tracking-widest text-foreground-muted/60">
            Pinned
          </div>
          {data.pinned.map((match) => (
            <MarketCard key={match.polymarket_markets.condition_id} match={match} />
          ))}
        </div>
      )}

      {/* Rotating markets */}
      {data.rotating.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.pinned.length > 0 && (
            <div className="px-0.5 text-[10px] font-semibold uppercase tracking-widest text-foreground-muted/60">
              Relevant to your portfolio
            </div>
          )}
          {data.rotating.map((match) => (
            <MarketCard key={match.polymarket_markets.condition_id} match={match} />
          ))}
        </div>
      )}
    </div>
  );
}

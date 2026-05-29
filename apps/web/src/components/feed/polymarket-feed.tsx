"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { TrendingUp, Pin, CalendarDays } from "lucide-react";
import { formatDistanceToNow, isPast } from "date-fns";
import { FeedShell } from "@/components/feed/feed-shell";
import { CategoryPills, type PolymarketTabId } from "@/components/feed/category-pills";

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

interface PersonalizedFeedData {
  pinned: PolymarketMatch[];
  rotating: PolymarketMatch[];
}

interface PolymarketFeedProps {
  portfolioId: string;
}

// ---------------------------------------------------------------------------
// Dedup by event_id (for personalized tab)
// ---------------------------------------------------------------------------

// Collapse buckets of the same event to one row, keeping the highest-"Yes"
// bucket (the consensus answer). Mirrors the server-side dedup; safety net since
// the server already dedups personalized matches before storing them.
function dedupeByEvent(matches: PolymarketMatch[]): PolymarketMatch[] {
  const seen = new Map<string, PolymarketMatch>();
  const yesProb = (m: PolymarketMatch) => {
    const { outcomes, outcome_prices } = m.polymarket_markets;
    const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o.trim()));
    if (yesIdx >= 0) return outcome_prices[yesIdx] ?? 0;
    return Math.max(...(outcome_prices.length > 0 ? outcome_prices : [0]));
  };

  for (const match of matches) {
    const key =
      match.polymarket_markets.event_id ?? match.polymarket_markets.condition_id;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, match);
      continue;
    }
    if (yesProb(match) > yesProb(existing)) seen.set(key, match);
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Helpers
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

function polymarketHref(m: PolymarketMarket): string {
  return m.event_slug
    ? `https://polymarket.com/event/${m.event_slug}`
    : "https://polymarket.com";
}

/** Compact volume label, e.g. "$2.4M" / "$840k" / "$120" */
function formatVolume(v: number | null | undefined): string | null {
  if (v == null || v <= 0) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/** Live "updated Xs ago" — recomputed on each tick of `now` */
function formatUpdatedAgo(since: Date | null, now: number): string | null {
  if (!since) return null;
  const secs = Math.max(0, Math.round((now - since.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ---------------------------------------------------------------------------
// Probability bar — single clean display matching the reference design
// ---------------------------------------------------------------------------

function ProbabilityBar({ pairs }: { pairs: Array<{ label: string; prob: number }> }) {
  // pairs is already sorted desc — top probability is the leading outcome
  const top = pairs[0];
  const pct = Math.round((top?.prob ?? 0) * 100);
  const label = top?.label ?? "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-muted">
          Probability
        </span>
        <span className="flex items-baseline gap-1.5 leading-none">
          <span className="text-base font-semibold tabular-nums">{pct}%</span>
          {label && (
            <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
              {label}
            </span>
          )}
        </span>
      </div>
      <div className="overflow-hidden rounded-full bg-surface-3" style={{ height: 6 }}>
        <div
          className="h-full rounded-full bg-foreground transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market row — used for both personalized and category tabs
// ---------------------------------------------------------------------------

function MarketRow({
  market,
  isPinned,
  reason,
}: {
  market: PolymarketMarket;
  isPinned: boolean;
  reason: string | null;
}) {
  const pairs = market.outcomes
    .map((label, i) => ({ label, prob: market.outcome_prices[i] ?? 0 }))
    .sort((a, b) => b.prob - a.prob);
  const endLabel = endDateLabel(market.end_date);
  const volLabel = formatVolume(market.volume_24hr);

  return (
    <li>
      <a
        href={polymarketHref(market)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/40"
      >
        {/* Left thumbnail */}
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-surface-2">
          {market.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={market.image}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <TrendingUp className="h-4 w-4 text-foreground-muted/40" />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* Question + pinned badge */}
          <div className="flex items-start gap-1.5">
            {isPinned && (
              <Pin className="mt-0.5 h-3 w-3 shrink-0 text-foreground-muted/60" />
            )}
            <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
              {market.question}
            </h3>
          </div>

          {/* Probability */}
          <ProbabilityBar pairs={pairs} />

          {/* Footer: reason + volume + end date */}
          <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-foreground-muted/70">
            {reason && !isPinned && (
              <span className="min-w-0 line-clamp-2 italic">{reason}</span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2.5">
              {volLabel && <span className="tabular-nums">{volLabel} vol</span>}
              {endLabel && (
                <span className="flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" />
                  {endLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </a>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main feed component
// ---------------------------------------------------------------------------

export function PolymarketFeed({ portfolioId }: PolymarketFeedProps) {
  const [activeTab, setActiveTab] = useState<PolymarketTabId>("personalized");

  // Personalized tab state
  const [personalizedData, setPersonalizedData] = useState<PersonalizedFeedData>({
    pinned: [],
    rotating: [],
  });
  const [personalizedLoading, setPersonalizedLoading] = useState(true);
  const [personalizedError, setPersonalizedError] = useState<string | null>(null);

  // Category tab state
  const [categoryMarkets, setCategoryMarkets] = useState<PolymarketMarket[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // "updated Xs ago" tracking — lastUpdated set on each successful fetch,
  // nowTick re-renders the relative label every 15s
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Fetch personalized
  const fetchPersonalized = useCallback(
    async (showLoadingSpinner = false) => {
      if (showLoadingSpinner) setPersonalizedLoading(true);
      setPersonalizedError(null);
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch(
          `${API_BASE_URL}/api/feed/polymarket?portfolio_id=${portfolioId}`,
          token ? { headers: { Authorization: `Bearer ${token}` } } : {},
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const raw = (await res.json()) as PersonalizedFeedData;
        setPersonalizedData({
          pinned: dedupeByEvent(raw.pinned),
          rotating: dedupeByEvent(raw.rotating),
        });
        setLastUpdated(new Date());
      } catch (err) {
        setPersonalizedError(
          err instanceof Error ? err.message : "Couldn't load markets, retrying…",
        );
      } finally {
        setPersonalizedLoading(false);
      }
    },
    [portfolioId],
  );

  // Fetch category
  const fetchCategory = useCallback(async (tag: Exclude<PolymarketTabId, "personalized">) => {
    setCategoryLoading(true);
    setCategoryError(null);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch(
        `${API_BASE_URL}/api/polymarket/category?tag=${tag}&limit=30`,
        token ? { headers: { Authorization: `Bearer ${token}` } } : {},
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as PolymarketMarket[];
      setCategoryMarkets(data);
      setLastUpdated(new Date());
    } catch (err) {
      setCategoryError(
        err instanceof Error ? err.message : "Couldn't load markets, retrying…",
      );
    } finally {
      setCategoryLoading(false);
    }
  }, []);

  // Initial load + polling
  useEffect(() => { fetchPersonalized(true); }, [fetchPersonalized]);

  useEffect(() => {
    const id = setInterval(() => {
      if (activeTab === "personalized") fetchPersonalized(false);
      else fetchCategory(activeTab as Exclude<PolymarketTabId, "personalized">);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchPersonalized, fetchCategory, activeTab]);

  useEffect(() => {
    const handler = () => {
      if (activeTab === "personalized") fetchPersonalized(false);
      else fetchCategory(activeTab as Exclude<PolymarketTabId, "personalized">);
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [fetchPersonalized, fetchCategory, activeTab]);

  // Fetch category when tab changes.
  // Note: we deliberately DON'T clear categoryMarkets here — clearing causes a
  // skeleton flash + header reflow that makes the pill layout animation jump.
  // The old data stays visible until the new category arrives.
  useEffect(() => {
    if (activeTab !== "personalized") {
      fetchCategory(activeTab as Exclude<PolymarketTabId, "personalized">);
    }
  }, [activeTab, fetchCategory]);

  const handleRefresh = () => {
    if (activeTab === "personalized") fetchPersonalized(true);
    else fetchCategory(activeTab as Exclude<PolymarketTabId, "personalized">);
  };

  // ---------------------------------------------------------------------------
  // Derived state — single FeedShell stays mounted across all of these so the
  // header (and the category-pill layout animation) never reflow.
  // ---------------------------------------------------------------------------

  const isPersonalized = activeTab === "personalized";
  const personalizedCount =
    personalizedData.pinned.length + personalizedData.rotating.length;
  const count = isPersonalized ? personalizedCount : categoryMarkets.length;
  const hasData = count > 0;
  const isLoading = isPersonalized ? personalizedLoading : categoryLoading;
  const currentError = isPersonalized ? personalizedError : categoryError;
  const showSkeleton = isLoading && !hasData;

  // Subtitle is ALWAYS a non-empty string → header height stays constant →
  // no vertical jump in the pill layout animation.
  const updatedLabel = formatUpdatedAgo(lastUpdated, nowTick);
  let subtitle: string;
  if (showSkeleton) {
    subtitle = "Loading…";
  } else if (currentError && !hasData) {
    subtitle = "Connection issue";
  } else {
    const parts = [`${count} ${count === 1 ? "market" : "markets"} tracked`];
    if (updatedLabel) parts.push(`updated ${updatedLabel}`);
    subtitle = parts.join(" · ");
  }

  const pills = <CategoryPills activeTab={activeTab} onChange={setActiveTab} />;

  // Body content (only rendered when not showing skeletons)
  let body: ReactNode;
  if (currentError && !hasData) {
    body = (
      <li className="px-4 py-8 text-center text-sm text-foreground-muted">
        {currentError}
      </li>
    );
  } else if (!hasData) {
    body = (
      <li className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <TrendingUp className="h-8 w-8 text-foreground-muted/30" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground-muted">No markets yet</p>
          <p className="text-xs text-foreground-muted/70">
            {isPersonalized
              ? "Markets feed is personalized. Import holdings to display relevant markets."
              : "No markets found for this category."}
          </p>
        </div>
      </li>
    );
  } else if (isPersonalized) {
    body = (
      <>
        {personalizedData.pinned.map((match) => (
          <MarketRow
            key={match.polymarket_markets.condition_id}
            market={match.polymarket_markets}
            isPinned
            reason={match.reason}
          />
        ))}
        {personalizedData.rotating.map((match) => (
          <MarketRow
            key={match.polymarket_markets.condition_id}
            market={match.polymarket_markets}
            isPinned={false}
            reason={match.reason}
          />
        ))}
      </>
    );
  } else {
    body = categoryMarkets.map((market) => (
      <MarketRow
        key={market.condition_id}
        market={market}
        isPinned={false}
        reason={null}
      />
    ));
  }

  return (
    <FeedShell
      title="Markets"
      liveColor="green"
      liveLabel="Polymarket"
      subtitle={subtitle}
      headerSlot={pills}
      onRefresh={handleRefresh}
      loading={showSkeleton}
    >
      {body}
    </FeedShell>
  );
}

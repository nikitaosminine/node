"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BarChart3, Briefcase, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PortfolioChart } from "@/components/portfolio-chart";
import { NewsFeed } from "@/components/feed/news-feed";
import { PolymarketFeed } from "@/components/feed/polymarket-feed";
import {
  convertCurrency,
  fetchFxRates,
  formatCurrency,
  formatSignedCurrency,
  normalizeCurrencyCode,
  DEFAULT_PORTFOLIO_CURRENCY,
} from "@/lib/currency";
import {
  MARKET_CACHE_MAX_AGE_MS,
  getCachedFxRates,
  getCachedQuotes,
  getFxRateKeys,
  upsertCachedFxRates,
  upsertCachedQuotes,
} from "@/lib/market-cache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Holding {
  id: string;
  ticker: string;
  quantity: number;
  purchase_price: number;
  currency: string | null;
  fees: number;
}

interface Portfolio {
  id: string;
  name: string;
  description: string | null;
  currency: string | null;
  cash_value: number | null;
  holdings: Holding[];
}

interface LiveQuote {
  ticker: string;
  currentPrice: number | null;
  currency: string | null;
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://binturong-api.nikita-osminine.workers.dev"
    : "http://localhost:8787");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function holdingsValue(
  holdings: Holding[],
  portfolioCurrency: string,
  quotes: Record<string, LiveQuote>,
  fxRates: Record<string, number>,
) {
  return holdings.reduce((s, h) => {
    const quote = quotes[h.ticker.toUpperCase()];
    const price = quote?.currentPrice ?? h.purchase_price;
    const currency = quote?.currency ?? h.currency ?? portfolioCurrency;
    return s + convertCurrency(price * h.quantity, currency, portfolioCurrency, fxRates);
  }, 0);
}

function holdingsCost(
  holdings: Holding[],
  portfolioCurrency: string,
  fxRates: Record<string, number>,
) {
  return holdings.reduce(
    (s, h) =>
      s +
      convertCurrency(
        h.purchase_price * h.quantity + (h.fees ?? 0),
        h.currency ?? portfolioCurrency,
        portfolioCurrency,
        fxRates,
      ),
    0,
  );
}

// ---------------------------------------------------------------------------
// StatCard (same design as portfolios.tsx)
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  tone = "neutral",
  loading = false,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
  loading?: boolean;
}) {
  const cls =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border/50 bg-card p-4">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      {loading ? (
        <div className="mt-2 h-5 w-24 animate-pulse rounded bg-surface-2" />
      ) : (
        <div className={`mt-1.5 font-mono text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// No-portfolio empty state
// ---------------------------------------------------------------------------

function NoPortfolioSelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Briefcase className="h-12 w-12 text-foreground-muted/40" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-foreground-muted">Select a portfolio</p>
        <p className="text-sm text-foreground-muted/70">
          Use the portfolio picker in the sidebar to get started.
        </p>
      </div>
      <Link
        href="/portfolios"
        className="mt-2 flex items-center gap-1.5 rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      >
        <BarChart3 className="h-4 w-4" />
        Manage portfolios
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview content (requires portfolioId)
// ---------------------------------------------------------------------------

function OverviewContent({ portfolioId }: { portfolioId: string }) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [fxRates, setFxRates] = useState<Record<string, number>>({});

  const portfolioCurrency = normalizeCurrencyCode(portfolio?.currency) ?? DEFAULT_PORTFOLIO_CURRENCY;

  const fetchPortfolio = useCallback(async () => {
    const { data, error } = await supabase
      .from("portfolios")
      .select("id,name,description,currency,cash_value,holdings(id,ticker,quantity,purchase_price,currency,fees)")
      .eq("id", portfolioId)
      .maybeSingle();

    if (error || !data) {
      setLoading(false);
      return;
    }
    setPortfolio(data as unknown as Portfolio);
    setLoading(false);
  }, [portfolioId]);

  // Fetch quotes from API
  const fetchQuotes = useCallback(async () => {
    if (!portfolio?.holdings?.length) return;

    const tickers = [...new Set(portfolio.holdings.map((h) => h.ticker.toUpperCase()))];
    const cacheResult = getCachedQuotes(tickers);

    // Use cache entries immediately
    const quotesFromCache: Record<string, LiveQuote> = {};
    for (const [t, c] of Object.entries(cacheResult.entries)) {
      quotesFromCache[t] = { ticker: t, currentPrice: c.currentPrice, currency: c.currency };
    }
    if (Object.keys(quotesFromCache).length > 0) {
      setQuotes((q) => ({ ...q, ...quotesFromCache }));
    }

    if (cacheResult.shouldRefetch) {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        const res = await fetch(`${API_BASE_URL}/api/quotes?tickers=${tickers.join(",")}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const fresh = await res.json() as LiveQuote[];
          const freshMap: Record<string, LiveQuote> = {};
          for (const q of fresh) freshMap[q.ticker.toUpperCase()] = q;
          setQuotes((prev) => ({ ...prev, ...freshMap }));
          upsertCachedQuotes(
            fresh.map((q) => ({ ticker: q.ticker, currentPrice: q.currentPrice, currency: q.currency })),
          );
        }
      } catch {
        // silent — use stale cache
      }
    }

    // FX rates
    const holdingCurrencies = portfolio.holdings.map((h) => h.currency ?? portfolioCurrency);
    const needed = getFxRateKeys(holdingCurrencies, [portfolioCurrency]);
    if (needed.length > 0) {
      const cachedRates = getCachedFxRates(needed);
      if (cachedRates.hasAny) {
        setFxRates((r) => ({ ...r, ...cachedRates.entries }));
      }
      if (cachedRates.shouldRefetch) {
        try {
          const holdingCurrenciesForFetch = portfolio.holdings.map((h) => h.currency ?? portfolioCurrency);
          const freshRates = await fetchFxRates(API_BASE_URL, holdingCurrenciesForFetch, portfolioCurrency);
          setFxRates((r) => ({ ...r, ...freshRates }));
          upsertCachedFxRates(freshRates);
        } catch {
          // use cached
        }
      }
    }
  }, [portfolio, portfolioCurrency]);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  useEffect(() => {
    if (portfolio) fetchQuotes();
  }, [portfolio, fetchQuotes]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-6 pt-14">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
        <div className="h-56 animate-pulse rounded-xl bg-surface-2" />
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="h-64 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-64 animate-pulse rounded-xl bg-surface-2" />
        </div>
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-foreground-muted">Portfolio not found.</p>
        <Link href="/portfolios" className="text-sm text-foreground-muted hover:underline">
          ← Back to portfolios
        </Link>
      </div>
    );
  }

  const holdings = portfolio.holdings ?? [];
  const securitiesValue = holdingsValue(holdings, portfolioCurrency, quotes, fxRates);
  const cashValue = convertCurrency(portfolio.cash_value ?? 0, portfolioCurrency, portfolioCurrency, fxRates);
  const totalValue = securitiesValue + cashValue;
  const costBasis = holdingsCost(holdings, portfolioCurrency, fxRates);
  const gainLoss = totalValue - costBasis;
  const gainLossPct = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;

  return (
    <div className="flex flex-col gap-6 p-6 pt-14">
      {/* Portfolio name + link to Details */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{portfolio.name}</h1>
          {portfolio.description && (
            <p className="mt-0.5 text-sm text-foreground-muted">{portfolio.description}</p>
          )}
        </div>
        <Link
          href={`/portfolios/${portfolioId}`}
          className="flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-foreground-muted hover:bg-surface-2 hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Details
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total value"
          value={formatCurrency(totalValue, portfolioCurrency)}
          loading={loading}
        />
        <StatCard
          label="Securities"
          value={formatCurrency(securitiesValue, portfolioCurrency)}
          loading={loading}
        />
        <StatCard
          label="Gain / Loss"
          value={formatSignedCurrency(gainLoss, portfolioCurrency)}
          tone={gainLoss > 0 ? "positive" : gainLoss < 0 ? "negative" : "neutral"}
          loading={loading}
        />
        <StatCard
          label="Return"
          value={`${gainLossPct >= 0 ? "+" : ""}${gainLossPct.toFixed(2)}%`}
          tone={gainLossPct > 0 ? "positive" : gainLossPct < 0 ? "negative" : "neutral"}
          loading={loading}
        />
      </div>

      {/* Chart */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <PortfolioChart portfolioId={portfolioId} currency={portfolioCurrency} />
      </div>

      {/* Feed 2-column grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <NewsFeed portfolioId={portfolioId} />
        <PolymarketFeed portfolioId={portfolioId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page (reads ?portfolioId from search params)
// ---------------------------------------------------------------------------

function OverviewPage() {
  const searchParams = useSearchParams();
  const portfolioId = searchParams.get("portfolioId") ?? "";

  if (!portfolioId) return <NoPortfolioSelected />;
  return <OverviewContent portfolioId={portfolioId} />;
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8"><div className="h-8 w-8 animate-pulse rounded-full bg-surface-2" /></div>}>
      <OverviewPage />
    </Suspense>
  );
}

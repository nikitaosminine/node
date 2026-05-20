"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { BarChart3, Briefcase } from "lucide-react";
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

function calcHoldingsValue(
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

function calcHoldingsCost(
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
// No-portfolio empty state
// ---------------------------------------------------------------------------

function NoPortfolioSelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Briefcase className="h-12 w-12 text-foreground-muted/40" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-foreground-muted">Select a portfolio</p>
        <p className="text-sm text-foreground-muted/70">
          Choose a portfolio from the sidebar to get started.
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
  const [marketReady, setMarketReady] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [fxRates, setFxRates] = useState<Record<string, number>>({});

  const portfolioCurrency = normalizeCurrencyCode(portfolio?.currency) ?? DEFAULT_PORTFOLIO_CURRENCY;

  const fetchPortfolio = useCallback(async () => {
    const { data, error } = await supabase
      .from("portfolios")
      .select(
        "id,name,description,currency,cash_value,holdings(id,ticker,quantity,purchase_price,currency,fees)",
      )
      .eq("id", portfolioId)
      .maybeSingle();

    if (error || !data) {
      setLoading(false);
      return;
    }
    setPortfolio(data as unknown as Portfolio);
    setLoading(false);
  }, [portfolioId]);

  const fetchQuotes = useCallback(async () => {
    if (!portfolio?.holdings?.length) {
      setMarketReady(true);
      return;
    }

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
          const fresh = (await res.json()) as LiveQuote[];
          const freshMap: Record<string, LiveQuote> = {};
          for (const q of fresh) freshMap[q.ticker.toUpperCase()] = q;
          setQuotes((prev) => ({ ...prev, ...freshMap }));
          upsertCachedQuotes(
            fresh.map((q) => ({
              ticker: q.ticker,
              currentPrice: q.currentPrice,
              currency: q.currency,
            })),
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
          const holdingCurrenciesForFetch = portfolio.holdings.map(
            (h) => h.currency ?? portfolioCurrency,
          );
          const freshRates = await fetchFxRates(
            API_BASE_URL,
            holdingCurrenciesForFetch,
            portfolioCurrency,
          );
          setFxRates((r) => ({ ...r, ...freshRates }));
          upsertCachedFxRates(freshRates);
        } catch {
          // use cached
        }
      }
    }

    setMarketReady(true);
  }, [portfolio, portfolioCurrency]);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  useEffect(() => {
    if (portfolio) fetchQuotes();
  }, [portfolio, fetchQuotes]);

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 pb-8 pt-4">
        <div className="h-8 w-48 animate-pulse rounded bg-surface-2" />
        <div className="h-16 animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-[480px] animate-pulse rounded-2xl bg-surface-2" />
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
  const securitiesValue = calcHoldingsValue(holdings, portfolioCurrency, quotes, fxRates);
  const cashValue = convertCurrency(
    portfolio.cash_value ?? 0,
    portfolioCurrency,
    portfolioCurrency,
    fxRates,
  );
  const totalValue = securitiesValue + cashValue;
  const costBasis = calcHoldingsCost(holdings, portfolioCurrency, fxRates);
  const gainLoss = totalValue - costBasis;
  const gainLossPct = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;

  const KPIS = [
    {
      label: "Total value",
      value: formatCurrency(totalValue, portfolioCurrency),
    },
    {
      label: "Securities",
      value: formatCurrency(securitiesValue, portfolioCurrency),
    },
    {
      label: "Gain / Loss",
      value: formatSignedCurrency(gainLoss, portfolioCurrency),
      detail: gainLoss !== 0 ? `${gainLossPct >= 0 ? "+" : ""}${gainLossPct.toFixed(2)}%` : undefined,
      tone: gainLoss > 0 ? "positive" : gainLoss < 0 ? "negative" : undefined,
    },
    {
      label: "Cost basis",
      value: formatCurrency(costBasis, portfolioCurrency),
      subtle: true,
    },
    {
      label: "Cash",
      value: formatCurrency(cashValue, portfolioCurrency),
      muted: cashValue === 0,
    },
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 pb-8 pt-4">
      {/* Portfolio name */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{portfolio.name}</h1>
        {portfolio.description && (
          <p className="mt-0.5 text-sm text-foreground-muted">{portfolio.description}</p>
        )}
      </div>

      {/* KPI strip — matches portfolio-detail style */}
      <div className="rounded-2xl border border-hairline bg-surface px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
          {KPIS.map((kpi, i) => (
            <div
              key={kpi.label}
              className={`min-w-0 ${i > 0 ? "xl:border-l xl:border-hairline xl:pl-4" : ""}`}
            >
              <dt className="truncate text-[13px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {kpi.label}
              </dt>
              {!marketReady ? (
                <dd className="mt-1 h-[22px] w-28 animate-pulse rounded bg-surface-2" />
              ) : (
                <dd
                  className={`mt-1 flex min-w-0 flex-col gap-1 font-mono leading-none tabular-nums ${
                    "muted" in kpi && kpi.muted
                      ? "text-foreground-muted"
                      : "tone" in kpi && kpi.tone === "positive"
                        ? "text-positive"
                        : "tone" in kpi && kpi.tone === "negative"
                          ? "text-negative"
                          : "subtle" in kpi && kpi.subtle
                            ? "text-foreground-muted/85"
                            : "text-foreground"
                  }`}
                >
                  <span className="truncate text-[clamp(18px,1.35vw,22px)] font-medium">
                    {kpi.value}
                  </span>
                  {"detail" in kpi && kpi.detail && (
                    <span className="truncate text-[clamp(12px,0.95vw,15px)] font-medium">
                      {kpi.detail}
                    </span>
                  )}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </div>

      {/* Chart with explicit height */}
      <div
        className="flex flex-col rounded-2xl border border-hairline bg-surface p-5"
        style={{ height: 480 }}
      >
        <div className="shrink-0 text-[11px] uppercase tracking-widest text-foreground-muted">
          Portfolio value
        </div>
        <div className="h-1 shrink-0" />
        <div className="min-h-0 flex-1">
          <PortfolioChart portfolioId={portfolioId} currency={portfolioCurrency} />
        </div>
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
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="h-8 w-8 animate-pulse rounded-full bg-surface-2" />
        </div>
      }
    >
      <OverviewPage />
    </Suspense>
  );
}

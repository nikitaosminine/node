"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { CreateCsvModal } from "@/components/create-csv-modal";
import { CreateManualModal } from "@/components/create-manual-modal";
import { EditPortfolioModal } from "@/components/edit-portfolio-modal";
import { MOCK_PRICES } from "@/lib/mock-data";
import { toast } from "sonner";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OrbitRing } from "@/components/loading-ui/orbit-ring";
import {
  DEFAULT_PORTFOLIO_CURRENCY,
  convertCurrency,
  fetchFxRates,
  formatCurrency,
  formatSignedCurrency,
  normalizeCurrencyCode,
} from "@/lib/currency";
import {
  MARKET_CACHE_MAX_AGE_MS,
  getCachedFxRates,
  getCachedQuotes,
  getFxRateKeys,
  upsertCachedFxRates,
  upsertCachedQuotes,
} from "@/lib/market-cache";

interface Holding {
  id: string;
  ticker: string;
  quantity: number;
  purchase_price: number;
  currency: string | null;
}

interface Portfolio {
  id: string;
  name: string;
  description: string | null;
  currency: string | null;
  created_at: string;
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

function fmtMoney(n: number, currency: string) {
  return formatCurrency(n, currency);
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function holdingsValue(
  holdings: Holding[],
  portfolioCurrency: string,
  quotes: Record<string, LiveQuote>,
  fxRates: Record<string, number>,
) {
  return holdings.reduce((s, h) => {
    const quote = quotes[h.ticker.toUpperCase()];
    const price = quote?.currentPrice ?? MOCK_PRICES[h.ticker] ?? h.purchase_price;
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
      s + convertCurrency(h.purchase_price * h.quantity, h.currency, portfolioCurrency, fxRates),
    0,
  );
}

function StatCard({
  label,
  value,
  tone = "neutral",
  muted = false,
  loading = false,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
  muted?: boolean;
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
        <div
          className={`mt-1.5 text-lg font-semibold tabular-nums font-mono ${muted ? "text-foreground/70" : cls}`}
        >
          {value}
        </div>
      )}
    </div>
  );
}

function Sparkline({ points, positive }: { points: { value: number }[]; positive: boolean }) {
  return (
    <div style={{ width: 110, height: 34 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={positive ? "oklch(0.72 0.19 145)" : "oklch(0.65 0.2 25)"}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PortfolioCard({
  portfolio,
  onClick,
  onEdit,
  onDelete,
  liveQuotes,
  fxRates,
  marketReady,
}: {
  portfolio: Portfolio;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  liveQuotes: Record<string, LiveQuote>;
  fxRates: Record<string, number>;
  marketReady: boolean;
}) {
  const currency = normalizeCurrencyCode(portfolio.currency);
  const cash = portfolio.cash_value ?? 0;
  const val = holdingsValue(portfolio.holdings, currency, liveQuotes, fxRates) + cash;
  const cost = holdingsCost(portfolio.holdings, currency, fxRates) + cash;
  const pl = val - cost;
  const plPct = cost > 0 ? (pl / cost) * 100 : 0;
  const positive = pl >= 0;

  const [sparkPoints, setSparkPoints] = useState<{ value: number }[]>([]);
  useEffect(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    supabase
      .from("portfolio_snapshots")
      .select("date, total_value")
      .eq("portfolio_id", portfolio.id)
      .gte("date", thirtyDaysAgo.toISOString().slice(0, 10))
      .order("date", { ascending: true })
      .then(({ data }) => {
        if (data && data.length >= 2) {
          setSparkPoints(data.map((row) => ({ value: Number(row.total_value ?? 0) })));
        }
      });
  }, [portfolio.id]);

  const topHoldings = [...portfolio.holdings]
    .sort((a, b) => b.purchase_price * b.quantity - a.purchase_price * a.quantity)
    .slice(0, 3);
  const extra = portfolio.holdings.length - 3;

  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className="group w-full cursor-pointer rounded-lg border border-border/50 bg-card p-4 text-left transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight truncate">{portfolio.name}</div>
          {portfolio.description && (
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
              {portfolio.description}
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Open actions for ${portfolio.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          {marketReady ? (
            <>
              <div className="text-[17px] font-semibold font-mono tabular-nums">
                {fmtMoney(val, currency)}
              </div>
              <div
                className={`text-[11px] font-mono ${positive ? "text-positive" : "text-negative"}`}
              >
                {formatSignedCurrency(pl, currency)} · {fmtPct(plPct)}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <div className="h-5 w-28 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-20 animate-pulse rounded bg-surface-2" />
            </div>
          )}
        </div>
        {sparkPoints.length >= 2 && <Sparkline points={sparkPoints} positive={positive} />}
      </div>

      {portfolio.holdings.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border flex items-center gap-1.5 flex-wrap">
          {topHoldings.map((h) => (
            <span
              key={h.ticker}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-secondary text-secondary-foreground"
            >
              {h.ticker}
            </span>
          ))}
          {extra > 0 && (
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-secondary text-secondary-foreground">
              +{extra}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AddCard({ onNewCsv, onNewManual }: { onNewCsv: () => void; onNewManual: () => void }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-center transition-colors hover:border-foreground/40">
      <div className="h-9 w-9 rounded-full bg-[oklch(1_0_0/4%)] border border-border flex items-center justify-center">
        <Plus className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="text-xs text-muted-foreground">Add another portfolio</div>
      <div className="flex gap-1.5 mt-1">
        <Button variant="outline" size="sm" onClick={onNewCsv}>
          Import CSV
        </Button>
        <Button size="sm" onClick={onNewManual}>
          Manual
        </Button>
      </div>
    </div>
  );
}

export default function PortfoliosPage() {
  const router = useRouter();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [csvOpen, setCsvOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingPortfolio, setEditingPortfolio] = useState<Portfolio | null>(null);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, LiveQuote>>({});
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const [marketReady, setMarketReady] = useState(false);

  const hydrateCachedMarketState = useCallback((nextPortfolios: Portfolio[]) => {
    const tickers = Array.from(
      new Set(
        nextPortfolios.flatMap((portfolio) =>
          portfolio.holdings.map((holding) => holding.ticker.toUpperCase()),
        ),
      ),
    ).filter(Boolean);
    if (tickers.length === 0) {
      setLiveQuotes({});
      setFxRates({});
      return true;
    }

    const cachedQuotes = getCachedQuotes(tickers);
    const sourceCurrencies = nextPortfolios.flatMap((portfolio) => [
      portfolio.currency,
      ...portfolio.holdings.map(
        (holding) =>
          cachedQuotes.entries[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
      ),
    ]);
    const targetCurrencies = Array.from(
      new Set([
        DEFAULT_PORTFOLIO_CURRENCY,
        ...nextPortfolios.map((portfolio) => normalizeCurrencyCode(portfolio.currency)),
      ]),
    );
    const cachedFx = getCachedFxRates(getFxRateKeys(sourceCurrencies, targetCurrencies));

    if (cachedQuotes.hasAll) setLiveQuotes(cachedQuotes.entries);
    if (cachedFx.hasAll) setFxRates(cachedFx.entries);

    return cachedQuotes.hasAll && cachedFx.hasAll;
  }, []);

  const fetchPortfolios = useCallback(async () => {
    const { data, error } = await supabase
      .from("portfolios")
      .select("*, holdings(*)")
      .order("created_at", { ascending: false });
    if (error) {
      toast.error("Failed to load portfolios");
    } else {
      const nextPortfolios = (data as Portfolio[]) || [];
      const hasCachedMarketData = hydrateCachedMarketState(nextPortfolios);
      setPortfolios(nextPortfolios);
      setMarketReady(
        !nextPortfolios.some((portfolio) => portfolio.holdings.length > 0) || hasCachedMarketData,
      );
    }
    setLoading(false);
  }, [hydrateCachedMarketState]);

  useEffect(() => {
    void fetchPortfolios();
  }, [fetchPortfolios]);

  useEffect(() => {
    const tickers = Array.from(
      new Set(
        portfolios.flatMap((portfolio) =>
          portfolio.holdings.map((holding) => holding.ticker.toUpperCase()),
        ),
      ),
    ).filter(Boolean);
    if (tickers.length === 0) {
      setLiveQuotes({});
      setFxRates({});
      setMarketReady(true);
      return;
    }

    let cancelled = false;
    const cachedQuotes = getCachedQuotes(tickers);
    const cachedSourceCurrencies = portfolios.flatMap((portfolio) => [
      portfolio.currency,
      ...portfolio.holdings.map(
        (holding) =>
          cachedQuotes.entries[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
      ),
    ]);
    const targetCurrencies = Array.from(
      new Set([
        DEFAULT_PORTFOLIO_CURRENCY,
        ...portfolios.map((portfolio) => normalizeCurrencyCode(portfolio.currency)),
      ]),
    );
    const cachedFx = getCachedFxRates(getFxRateKeys(cachedSourceCurrencies, targetCurrencies));
    const hasCompleteCache = cachedQuotes.hasAll && cachedFx.hasAll;

    if (cachedQuotes.hasAll) setLiveQuotes(cachedQuotes.entries);
    if (cachedFx.hasAll) setFxRates(cachedFx.entries);
    if (hasCompleteCache) setMarketReady(true);

    const refreshMarketData = async () => {
      try {
        const quoteRequest = fetch(
          `${API_BASE_URL}/api/market/quotes?symbols=${encodeURIComponent(tickers.join(","))}`,
        );
        const knownSourceCurrencies = portfolios.flatMap((portfolio) => [
          portfolio.currency,
          ...portfolio.holdings.map((holding) => holding.currency),
        ]);
        const knownRateEntriesRequest = Promise.all(
          targetCurrencies.map((target) =>
            fetchFxRates(API_BASE_URL, knownSourceCurrencies, target),
          ),
        );
        const [response, knownRateEntries] = await Promise.all([
          quoteRequest,
          knownRateEntriesRequest,
        ]);
        if (!response.ok) throw new Error("Quote request failed");
        const quotes = (await response.json()) as LiveQuote[];
        if (cancelled) return;
        const quoteMap = quotes.reduce<Record<string, LiveQuote>>((acc, quote) => {
          acc[quote.ticker.toUpperCase()] = quote;
          return acc;
        }, {});
        upsertCachedQuotes(quotes);
        setLiveQuotes(quoteMap);
        const sourceCurrencies = portfolios.flatMap((portfolio) => [
          portfolio.currency,
          ...portfolio.holdings.map(
            (holding) => quoteMap[holding.ticker.toUpperCase()]?.currency ?? holding.currency,
          ),
        ]);
        const knownRates = Object.assign({}, ...knownRateEntries);
        const missingSourceCurrencies = sourceCurrencies.filter((currency) =>
          getFxRateKeys([currency], targetCurrencies).some((key) => knownRates[key] == null),
        );
        const missingRateEntries =
          missingSourceCurrencies.length > 0
            ? await Promise.all(
                targetCurrencies.map((target) =>
                  fetchFxRates(API_BASE_URL, missingSourceCurrencies, target),
                ),
              )
            : [];
        if (!cancelled) {
          const nextFxRates = Object.assign({}, knownRates, ...missingRateEntries);
          upsertCachedFxRates(nextFxRates);
          setFxRates(nextFxRates);
          setMarketReady(true);
        }
      } catch {
        if (!cancelled) {
          if (!hasCompleteCache) setMarketReady(true);
        }
      }
    };

    if (cachedQuotes.shouldRefetch || cachedFx.shouldRefetch) void refreshMarketData();
    const intervalId = window.setInterval(() => void refreshMarketData(), MARKET_CACHE_MAX_AGE_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [portfolios]);

  const onCreated = () => {
    setCsvOpen(false);
    setManualOpen(false);
    void fetchPortfolios();
  };
  const handleEditPortfolio = (portfolio: Portfolio) => {
    setEditingPortfolio(portfolio);
    setEditOpen(true);
  };

  const handleDeletePortfolio = async (portfolio: Portfolio) => {
    if (!confirm(`Delete ${portfolio.name}? This will remove all holdings in this portfolio.`))
      return;

    const { error: holdingsError } = await supabase
      .from("holdings")
      .delete()
      .eq("portfolio_id", portfolio.id);
    if (holdingsError) {
      toast.error("Failed to delete portfolio holdings");
      return;
    }

    const { error } = await supabase.from("portfolios").delete().eq("id", portfolio.id);
    if (error) {
      toast.error("Failed to delete portfolio");
      return;
    }

    toast.success("Portfolio deleted");
    void fetchPortfolios();
  };

  const totalValue = useMemo(
    () =>
      portfolios.reduce((s, p) => {
        const currency = normalizeCurrencyCode(p.currency);
        const portfolioValue =
          holdingsValue(p.holdings, currency, liveQuotes, fxRates) + (p.cash_value ?? 0);
        return s + convertCurrency(portfolioValue, currency, DEFAULT_PORTFOLIO_CURRENCY, fxRates);
      }, 0),
    [fxRates, liveQuotes, portfolios],
  );
  const totalCash = useMemo(
    () =>
      portfolios.reduce(
        (s, p) =>
          s +
          convertCurrency(
            p.cash_value ?? 0,
            normalizeCurrencyCode(p.currency),
            DEFAULT_PORTFOLIO_CURRENCY,
            fxRates,
          ),
        0,
      ),
    [fxRates, portfolios],
  );
  const totalCost = useMemo(
    () =>
      portfolios.reduce((s, p) => {
        const currency = normalizeCurrencyCode(p.currency);
        const portfolioCost = holdingsCost(p.holdings, currency, fxRates) + (p.cash_value ?? 0);
        return s + convertCurrency(portfolioCost, currency, DEFAULT_PORTFOLIO_CURRENCY, fxRates);
      }, 0),
    [fxRates, portfolios],
  );
  const totalPL = totalValue - totalCost;
  const returnPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <OrbitRing className="size-6" />
        <span>Loading portfolios.</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Portfolios</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Manage and track your investments across accounts.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setCsvOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Import CSV
          </Button>
          <Button size="sm" onClick={() => setManualOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create manually
          </Button>
        </div>
      </div>

      {portfolios.length > 0 && (
        <div className="grid grid-cols-5 gap-3">
          <StatCard
            label="Total value"
            value={fmtMoney(totalValue, DEFAULT_PORTFOLIO_CURRENCY)}
            loading={!marketReady}
          />
          <StatCard
            label="Cash value"
            value={fmtMoney(totalCash, DEFAULT_PORTFOLIO_CURRENCY)}
            muted
          />
          <StatCard
            label="Total cost"
            value={fmtMoney(totalCost, DEFAULT_PORTFOLIO_CURRENCY)}
            muted
          />
          <StatCard
            label="Unrealized P/L"
            value={fmtMoney(totalPL, DEFAULT_PORTFOLIO_CURRENCY)}
            tone={totalPL >= 0 ? "positive" : "negative"}
            loading={!marketReady}
          />
          <StatCard
            label="Return"
            value={fmtPct(returnPct)}
            tone={returnPct >= 0 ? "positive" : "negative"}
            loading={!marketReady}
          />
        </div>
      )}

      {portfolios.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="h-14 w-14 rounded-full bg-[oklch(1_0_0/4%)] border border-border flex items-center justify-center mb-4">
            <Upload className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-base font-semibold">No portfolios yet</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Create your first portfolio by importing a CSV or adding holdings manually.
          </p>
          <div className="flex gap-2 mt-5">
            <Button variant="outline" onClick={() => setCsvOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Create from CSV
            </Button>
            <Button onClick={() => setManualOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Create manually
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {portfolios.map((p) => (
            <PortfolioCard
              key={p.id}
              portfolio={p}
              onClick={() => router.push(`/overview?portfolioId=${p.id}`)}
              onEdit={() => handleEditPortfolio(p)}
              onDelete={() => handleDeletePortfolio(p)}
              liveQuotes={liveQuotes}
              fxRates={fxRates}
              marketReady={marketReady}
            />
          ))}
          <AddCard onNewCsv={() => setCsvOpen(true)} onNewManual={() => setManualOpen(true)} />
        </div>
      )}

      <CreateCsvModal open={csvOpen} onOpenChange={setCsvOpen} onCreated={onCreated} />
      <CreateManualModal open={manualOpen} onOpenChange={setManualOpen} onCreated={onCreated} />
      <EditPortfolioModal
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditingPortfolio(null);
        }}
        portfolio={editingPortfolio}
        onSaved={() => void fetchPortfolios()}
      />
    </div>
  );
}

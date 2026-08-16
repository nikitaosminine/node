"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InfinityLoop } from "@/components/loading-ui/infinity";
import { TextShimmer } from "@/components/loading-ui/text-shimmer";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { formatCurrency, normalizeCurrencyCode } from "@/lib/currency";
import { API_BASE_URL } from "@/lib/api";

interface ChartSeries {
  date: string;
  total_value: number;
  cash_balance: number;
  securities_value: number;
  simple_return_pct: number;
  twr_pct: number;
}

export interface PortfolioChartPoint {
  time: string;
  value: number;
}

interface PortfolioChartProps {
  data?: PortfolioChartPoint[];
  portfolioId?: string;
  currency?: string;
}

type Mode = "value" | "simple" | "twr";
type Range = "1M" | "3M" | "1Y" | "ALL";
type View = "line" | "returns";
type BarPeriod = "M" | "Q" | "Y";

interface ReturnBar {
  label: string;
  returnPct: number;
}

interface BenchmarkWeight {
  ticker: string;
  weight: number;
}

interface BenchmarkDefinition {
  id?: string;
  name: string;
  ticker: string;
  color: string;
  weights?: BenchmarkWeight[] | null;
}

interface BenchmarkSearchResult {
  name: string;
  ticker: string;
}

interface BenchmarkSuggestion extends BenchmarkSearchResult {
  reason: string;
}

interface BenchmarkPricePoint {
  date: string;
  close: number;
}

type BenchmarkTab = "search" | "saved";

const RANGES: { id: Range; label: string; days: number | null }[] = [
  { id: "1M", label: "Monthly", days: 30 },
  { id: "3M", label: "Quarterly", days: 90 },
  { id: "1Y", label: "Yearly", days: 365 },
  { id: "ALL", label: "All time", days: null },
];

const chartConfig = {
  value: {
    label: "Portfolio value",
    color: "var(--accent-teal)",
  },
} satisfies ChartConfig;

const PILL_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.7 };
const MAX_ACTIVE_BENCHMARKS = 4;
const BENCHMARK_PALETTE = ["amber", "violet", "rose", "sky"] as const;
const BENCHMARK_COLORS: Record<string, string> = {
  amber: "var(--benchmark-amber)",
  violet: "var(--benchmark-violet)",
  rose: "var(--benchmark-rose)",
  sky: "var(--benchmark-sky)",
};
const ACTIVE_BENCHMARKS_STORAGE_PREFIX = "portfolio-chart:active-benchmarks";

function fmtValue(n: number, mode: Mode, currency: string) {
  if (mode === "value") {
    return formatCurrency(n, currency, {
      maximumFractionDigits: 0,
    });
  }
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function keepLastPerPeriod(
  points: PortfolioChartPoint[],
  keyFn: (point: PortfolioChartPoint) => string,
): PortfolioChartPoint[] {
  const map = new Map<string, PortfolioChartPoint>();
  for (const point of points) map.set(keyFn(point), point);
  return [...map.values()];
}

function downsample(points: PortfolioChartPoint[], range: Range): PortfolioChartPoint[] {
  if (range === "1M") return points;
  if (range === "3M") {
    return keepLastPerPeriod(points, (point) => {
      const date = new Date(point.time);
      const week = Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000));
      return `${date.getFullYear()}-W${week}`;
    });
  }
  return keepLastPerPeriod(points, (point) => point.time.slice(0, 7));
}

function computeReturns(points: PortfolioChartPoint[], period: BarPeriod): ReturnBar[] {
  const keyFn = (time: string): string => {
    if (period === "M") return time.slice(0, 7);
    if (period === "Q") {
      const [year, month] = time.split("-").map(Number);
      return `${year}-Q${Math.ceil(month / 3)}`;
    }
    return time.slice(0, 4);
  };

  const groups = new Map<string, PortfolioChartPoint[]>();
  const sortedPoints = [...points].sort((a, b) => a.time.localeCompare(b.time));
  for (const point of sortedPoints) {
    const key = keyFn(point.time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(point);
  }

  const bars: ReturnBar[] = [];
  for (const [key, group] of groups.entries()) {
    const startFactor = 1 + group[0].value / 100;
    const endFactor = 1 + group[group.length - 1].value / 100;
    if (startFactor <= 0) continue;
    let label = key;
    if (period === "M") {
      const [year, month] = key.split("-").map(Number);
      label = new Date(year, month - 1).toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
      });
    }
    bars.push({ label, returnPct: (endFactor / startFactor - 1) * 100 });
  }
  return bars;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${token}` };
}

function benchmarkKey(ticker: string) {
  return `benchmark_${ticker.replace(/[^a-z0-9]/gi, "_")}`;
}

function benchmarkColor(color: string) {
  return BENCHMARK_COLORS[color] ?? color;
}

function activeBenchmarksStorageKey(portfolioId: string) {
  return `${ACTIVE_BENCHMARKS_STORAGE_PREFIX}:${portfolioId}`;
}

function loadStoredActiveBenchmarks(portfolioId?: string): BenchmarkDefinition[] {
  if (!portfolioId || typeof window === "undefined") return [];
  return parseStoredActiveBenchmarks(
    window.localStorage.getItem(activeBenchmarksStorageKey(portfolioId)),
  );
}

function parseStoredActiveBenchmarks(value: string | null): BenchmarkDefinition[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const name = String(row.name ?? "").trim();
        const ticker = String(row.ticker ?? "")
          .trim()
          .toUpperCase();
        const color = String(row.color ?? "").trim();
        if (!name || !ticker || !color) return null;
        return {
          ...(typeof row.id === "string" ? { id: row.id } : {}),
          name,
          ticker,
          color,
          weights: Array.isArray(row.weights) ? (row.weights as BenchmarkWeight[]) : null,
        } as BenchmarkDefinition;
      })
      .filter((item): item is BenchmarkDefinition => item != null)
      .slice(0, MAX_ACTIVE_BENCHMARKS);
  } catch {
    return [];
  }
}

function benchmarkLabelFromName(name: unknown, benchmarks: BenchmarkDefinition[]) {
  const key = String(name ?? "");
  if (key === "value" || key === "returnPct") return "Portfolio";
  return (
    benchmarks.find((benchmark) => benchmarkKey(benchmark.ticker) === key || benchmark.name === key)
      ?.name ?? "Benchmark"
  );
}

function toBenchmarkSeries(prices: BenchmarkPricePoint[]): PortfolioChartPoint[] {
  const sorted = [...prices]
    .filter((point) => Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const base = sorted[0]?.close;
  if (!base) return [];
  return sorted.map((point) => ({
    time: point.date,
    value: (point.close / base - 1) * 100,
  }));
}

function latestValueOnOrBefore(points: PortfolioChartPoint[], date: string): number | null {
  let value: number | null = null;
  for (const point of points) {
    if (point.time > date) break;
    value = point.value;
  }
  return value;
}

function pricesCoverStart(prices: BenchmarkPricePoint[] | undefined, inceptionDate: string) {
  const firstDate = prices?.[0]?.date;
  if (!firstDate) return false;
  const latestAcceptableFirstDate = new Date(`${inceptionDate}T00:00:00.000Z`);
  latestAcceptableFirstDate.setUTCDate(latestAcceptableFirstDate.getUTCDate() + 7);
  return firstDate <= latestAcceptableFirstDate.toISOString().slice(0, 10);
}

function chooseBenchmarkColor(
  activeBenchmarks: BenchmarkDefinition[],
  savedBenchmarks: BenchmarkDefinition[],
) {
  const used = new Set(
    [...activeBenchmarks, ...savedBenchmarks].map((benchmark) => benchmark.color),
  );
  return (
    BENCHMARK_PALETTE.find((color) => !used.has(color)) ??
    BENCHMARK_PALETTE[activeBenchmarks.length % BENCHMARK_PALETTE.length]
  );
}

function ExpandableBenchmarkSearch({
  portfolioId,
  activeCount,
  savedBenchmarks,
  onApply,
  onSave,
  onDeleteSaved,
  onChangeSavedColor,
}: {
  portfolioId?: string;
  activeCount: number;
  savedBenchmarks: BenchmarkDefinition[];
  onApply: (benchmark: Omit<BenchmarkDefinition, "color"> & { color?: string }) => void;
  onSave: (benchmark: BenchmarkSearchResult | BenchmarkSuggestion) => Promise<void>;
  onDeleteSaved: (benchmark: BenchmarkDefinition) => Promise<void>;
  onChangeSavedColor: (benchmark: BenchmarkDefinition, color: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<BenchmarkTab>("search");
  const [results, setResults] = useState<BenchmarkSearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<BenchmarkSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionStatus, setSuggestionStatus] = useState<
    "idle" | "loading" | "success" | "empty" | "error"
  >("idle");
  const [savingTicker, setSavingTicker] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [colorChangingId, setColorChangingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && query === "") {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [query]);

  useEffect(() => {
    if (!expanded || tab !== "search" || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/benchmarks/search?q=${encodeURIComponent(query.trim())}`,
          {
            signal: controller.signal,
          },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Search failed");
        setResults(Array.isArray(body) ? body : []);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [expanded, query, tab]);

  const saveBenchmark = async (benchmark: BenchmarkSearchResult | BenchmarkSuggestion) => {
    setSavingTicker(benchmark.ticker);
    try {
      await onSave(benchmark);
    } finally {
      setSavingTicker(null);
    }
  };

  const suggestBenchmarks = async () => {
    if (!portfolioId) return;
    setSuggesting(true);
    setSuggestionStatus("loading");
    try {
      const res = await fetch(`${API_BASE_URL}/api/benchmarks/suggest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ portfolioId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Suggestion failed");
      const nextSuggestions = Array.isArray(body) ? body : [];
      setSuggestions(nextSuggestions);
      setSuggestionStatus(nextSuggestions.length > 0 ? "success" : "empty");
      setTab("search");
    } catch {
      setSuggestions([]);
      setSuggestionStatus("error");
    } finally {
      setSuggesting(false);
    }
  };

  const deleteSavedBenchmark = async (benchmark: BenchmarkDefinition) => {
    setDeletingId(benchmark.id ?? benchmark.ticker);
    try {
      await onDeleteSaved(benchmark);
    } finally {
      setDeletingId(null);
    }
  };

  const changeSavedColor = async (benchmark: BenchmarkDefinition, color: string) => {
    if (benchmark.color === color) return;
    setColorChangingId(benchmark.id ?? benchmark.ticker);
    try {
      await onChangeSavedColor(benchmark, color);
    } finally {
      setColorChangingId(null);
    }
  };

  const canApplyMore = activeCount < MAX_ACTIVE_BENCHMARKS;

  return (
    <div ref={containerRef} className="relative flex justify-end">
      <motion.form
        initial={false}
        animate={{ width: expanded ? 360 : 40 }}
        transition={{ type: "spring" as const, stiffness: 400, damping: 30 }}
        style={{ maxWidth: "calc(100vw - 2rem)" }}
        onSubmit={(event) => event.preventDefault()}
        onClick={() => !expanded && setExpanded(true)}
        className={cn(
          "relative flex h-10 items-center overflow-hidden rounded-full border shadow-sm",
          expanded
            ? "border-hairline bg-surface-elevated"
            : "cursor-pointer border-transparent bg-surface-2 hover:bg-surface-elevated",
        )}
      >
        <button
          type="button"
          aria-label="Search benchmarks"
          className="absolute left-0 z-10 flex h-full w-10 items-center justify-center text-foreground-muted transition-colors hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          <Search className="h-5 w-5" />
        </button>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search benchmark..."
          onChange={(event) => setQuery(event.target.value)}
          className="h-full w-full border-none bg-transparent pl-10 pr-20 text-sm text-foreground outline-none placeholder:text-foreground-muted"
          style={{ pointerEvents: expanded ? "auto" : "none", opacity: expanded ? 1 : 0 }}
          tabIndex={expanded ? 0 : -1}
        />
        <AnimatePresence>
          {expanded && query !== "" && (
            <motion.button
              type="button"
              aria-label="Clear benchmark search"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute right-10 flex h-full w-10 items-center justify-center text-foreground-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </motion.button>
          )}
        </AnimatePresence>
        {expanded && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Suggest benchmarks"
                  disabled={!portfolioId || suggesting}
                  onClick={suggestBenchmarks}
                  className="absolute right-0 flex h-full w-10 items-center justify-center text-foreground-muted hover:text-foreground disabled:opacity-50"
                >
                  {suggesting ? (
                    <InfinityLoop className="h-6 w-8" />
                  ) : (
                    <>
                      <img
                        src="/brand/node-logo-icon-black.svg"
                        alt=""
                        className="h-5 w-5 dark:hidden"
                      />
                      <img
                        src="/brand/node-logo-icon-white.svg"
                        alt=""
                        className="hidden h-5 w-5 dark:block"
                      />
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-56 text-center">
                Engages AI to generate appropriate benchmarks
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </motion.form>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="absolute right-0 top-12 z-20 w-[min(22.5rem,calc(100vw-2rem))] rounded-lg border border-hairline bg-surface-elevated p-2 shadow-xl"
          >
            <div className="mb-2 flex gap-1 rounded-full bg-surface-2 p-1">
              {(
                [
                  ["search", "Search"],
                  ["saved", "Saved"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "flex-1 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    tab === id
                      ? "bg-foreground text-background"
                      : "text-foreground-muted hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeCount >= MAX_ACTIVE_BENCHMARKS && (
              <div className="mb-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs text-foreground-muted">
                Maximum 4 active benchmarks.
              </div>
            )}

            {tab === "search" ? (
              <div className="grid gap-1">
                {suggestionStatus !== "idle" && (
                  <div className="mb-2 grid gap-1 rounded-md border border-hairline bg-surface p-2">
                    <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-foreground-muted">
                      Suggested
                    </div>
                    {suggestionStatus === "loading" && (
                      <div className="py-2 text-xs text-foreground-muted">
                        <TextShimmer>Generating benchmarks...</TextShimmer>
                      </div>
                    )}
                    {suggestionStatus === "empty" && (
                      <div className="py-2 text-xs text-foreground-muted">
                        No Yahoo-backed benchmark suggestions found.
                      </div>
                    )}
                    {suggestionStatus === "error" && (
                      <div className="py-2 text-xs text-foreground-muted">
                        Benchmark suggestions failed. Try again in a moment.
                      </div>
                    )}
                    {suggestions.map((suggestion) => (
                      <div
                        key={`suggestion-${suggestion.ticker}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md px-1 py-1.5 hover:bg-surface-2"
                      >
                        <button
                          type="button"
                          disabled={!canApplyMore}
                          onClick={() => onApply(suggestion)}
                          className="min-w-0 flex-1 py-2.5 text-left disabled:opacity-50 md:py-0"
                        >
                          <span className="block break-words text-sm leading-snug text-foreground">
                            {suggestion.name}
                          </span>
                          <span className="block break-words text-xs leading-snug text-foreground-muted">
                            {suggestion.reason}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={savingTicker === suggestion.ticker}
                          onClick={() => saveBenchmark(suggestion)}
                          className="shrink-0 rounded-full border border-hairline px-2 py-2.5 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50 md:py-1"
                        >
                          Save
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {searching ? (
                  <div className="px-2 py-3 text-xs text-foreground-muted">Searching...</div>
                ) : results.length > 0 ? (
                  results.map((result) => (
                    <div
                      key={`${result.ticker}-${result.name}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md px-2 py-2 hover:bg-surface-2"
                    >
                      <button
                        type="button"
                        disabled={!canApplyMore}
                        onClick={() => onApply(result)}
                        className="min-w-0 flex-1 text-left disabled:opacity-50"
                      >
                        <div className="break-words text-sm leading-snug text-foreground">
                          {result.name}
                        </div>
                        <div className="break-all text-xs text-foreground-muted">
                          {result.ticker}
                        </div>
                      </button>
                      <button
                        type="button"
                        disabled={savingTicker === result.ticker}
                        onClick={() => saveBenchmark(result)}
                        className="shrink-0 rounded-full border border-hairline px-2 py-1 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="px-2 py-3 text-xs text-foreground-muted">
                    {query.trim().length >= 2
                      ? "No benchmarks found."
                      : "Type at least 2 characters."}
                  </div>
                )}
              </div>
            ) : savedBenchmarks.length > 0 ? (
              <div className="grid gap-1">
                {savedBenchmarks.map((benchmark) => (
                  <div
                    key={benchmark.id ?? benchmark.ticker}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 hover:bg-surface-2"
                  >
                    <button
                      type="button"
                      disabled={!canApplyMore}
                      onClick={() => onApply(benchmark)}
                      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-left disabled:opacity-50"
                    >
                      <span
                        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: benchmarkColor(benchmark.color) }}
                      />
                      <span className="min-w-0">
                        <span className="block break-words text-sm leading-snug text-foreground">
                          {benchmark.name}
                        </span>
                        <span className="block break-all text-xs text-foreground-muted">
                          {benchmark.ticker}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      {BENCHMARK_PALETTE.map((color) => (
                        <button
                          key={`${benchmark.id}-${color}`}
                          type="button"
                          aria-label={`Set ${benchmark.name} color to ${color}`}
                          disabled={colorChangingId === (benchmark.id ?? benchmark.ticker)}
                          onClick={() => changeSavedColor(benchmark, color)}
                          className={cn(
                            "h-4 w-4 rounded-full border transition-transform hover:scale-110 disabled:opacity-50",
                            benchmark.color === color ? "border-foreground" : "border-hairline",
                          )}
                          style={{ backgroundColor: benchmarkColor(color) }}
                        />
                      ))}
                      <button
                        type="button"
                        aria-label={`Delete ${benchmark.name}`}
                        disabled={deletingId === (benchmark.id ?? benchmark.ticker)}
                        onClick={() => deleteSavedBenchmark(benchmark)}
                        className="rounded-full p-1 text-foreground-muted hover:bg-surface hover:text-foreground disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-2 py-3 text-xs text-foreground-muted">
                No saved benchmarks yet.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PortfolioChart({ data, portfolioId, currency = "EUR" }: PortfolioChartProps) {
  const displayCurrency = normalizeCurrencyCode(currency);
  const [range, setRange] = useState<Range>("ALL");
  const [mode, setMode] = useState<Mode>("value");
  const [view, setView] = useState<View>("line");
  const [barPeriod, setBarPeriod] = useState<BarPeriod>("M");
  const [chartSeries, setChartSeries] = useState<ChartSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeBenchmarks, setActiveBenchmarks] = useState<BenchmarkDefinition[]>(() =>
    loadStoredActiveBenchmarks(portfolioId),
  );
  const [savedBenchmarks, setSavedBenchmarks] = useState<BenchmarkDefinition[]>([]);
  const [benchmarkPrices, setBenchmarkPrices] = useState<Record<string, BenchmarkPricePoint[]>>({});
  const [loadingBenchmarkTickers, setLoadingBenchmarkTickers] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeBenchmarksHydratedFor, setActiveBenchmarksHydratedFor] = useState<string | null>(
    portfolioId ?? null,
  );
  const shouldReduceMotion = useReducedMotion();
  const pillTransition = shouldReduceMotion ? { duration: 0 } : PILL_TRANSITION;

  useEffect(() => {
    if (!portfolioId) {
      setActiveBenchmarks([]);
      setActiveBenchmarksHydratedFor(null);
      return;
    }
    setActiveBenchmarks(loadStoredActiveBenchmarks(portfolioId));
    setActiveBenchmarksHydratedFor(portfolioId);
  }, [portfolioId]);

  useEffect(() => {
    if (!portfolioId || activeBenchmarksHydratedFor !== portfolioId) return;
    window.localStorage.setItem(
      activeBenchmarksStorageKey(portfolioId),
      JSON.stringify(activeBenchmarks),
    );
  }, [activeBenchmarks, activeBenchmarksHydratedFor, portfolioId]);

  const fetchChartData = useCallback(async () => {
    if (!portfolioId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/chart`, {
        headers: await authHeaders(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load chart");
      setChartSeries(body.series ?? []);
    } catch {
      setChartSeries([]);
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    fetchChartData();
  }, [fetchChartData]);

  const fetchSavedBenchmarks = useCallback(async () => {
    if (!portfolioId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/benchmarks/saved`, {
        headers: await authHeaders(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load saved benchmarks");
      setSavedBenchmarks(
        (body.benchmarks ?? []).map((benchmark: BenchmarkDefinition) => benchmark),
      );
    } catch {
      setSavedBenchmarks([]);
    }
  }, [portfolioId]);

  useEffect(() => {
    fetchSavedBenchmarks();
  }, [fetchSavedBenchmarks]);

  const applyBenchmark = useCallback(
    (benchmark: Omit<BenchmarkDefinition, "color"> & { color?: string }) => {
      setActiveBenchmarks((current) => {
        if (current.some((item) => item.ticker.toUpperCase() === benchmark.ticker.toUpperCase())) {
          return current;
        }
        if (current.length >= MAX_ACTIVE_BENCHMARKS) return current;
        return [
          ...current,
          {
            id: benchmark.id,
            name: benchmark.name,
            ticker: benchmark.ticker.toUpperCase(),
            weights: benchmark.weights ?? null,
            color: benchmark.color ?? chooseBenchmarkColor(current, savedBenchmarks),
          },
        ];
      });
    },
    [savedBenchmarks],
  );

  const saveBenchmark = useCallback(
    async (benchmark: BenchmarkSearchResult | BenchmarkSuggestion) => {
      if (!portfolioId) return;
      const existing = savedBenchmarks.find(
        (item) => item.ticker.toUpperCase() === benchmark.ticker.toUpperCase(),
      );
      if (existing) return;
      const color = chooseBenchmarkColor(activeBenchmarks, savedBenchmarks);
      const res = await fetch(`${API_BASE_URL}/api/portfolios/${portfolioId}/benchmarks/saved`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          name: benchmark.name,
          ticker: benchmark.ticker,
          color,
          weights: null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to save benchmark");
      setSavedBenchmarks((current) => [...current, body]);
    },
    [activeBenchmarks, portfolioId, savedBenchmarks],
  );

  const deleteSavedBenchmark = useCallback(
    async (benchmark: BenchmarkDefinition) => {
      if (!portfolioId || !benchmark.id) return;
      const res = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/benchmarks/saved/${benchmark.id}`,
        {
          method: "DELETE",
          headers: await authHeaders(),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to delete benchmark");
      setSavedBenchmarks((current) => current.filter((item) => item.id !== benchmark.id));
      setActiveBenchmarks((current) =>
        current.filter(
          (item) =>
            item.id !== benchmark.id &&
            item.ticker.toUpperCase() !== benchmark.ticker.toUpperCase(),
        ),
      );
    },
    [portfolioId],
  );

  const changeSavedBenchmarkColor = useCallback(
    async (benchmark: BenchmarkDefinition, color: string) => {
      if (!portfolioId || !benchmark.id) return;
      const res = await fetch(
        `${API_BASE_URL}/api/portfolios/${portfolioId}/benchmarks/saved/${benchmark.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(await authHeaders()),
          },
          body: JSON.stringify({ color }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update benchmark color");
      const updated = (body.benchmarks ?? []) as BenchmarkDefinition[];
      if (updated.length === 0) return;
      const updatedById = new Map(updated.map((item) => [item.id, item]));
      setSavedBenchmarks((current) => current.map((item) => updatedById.get(item.id) ?? item));
      setActiveBenchmarks((current) =>
        current.map((item) => {
          const match =
            updatedById.get(item.id) ??
            updated.find(
              (updatedItem) => updatedItem.ticker.toUpperCase() === item.ticker.toUpperCase(),
            );
          return match ? { ...item, color: match.color } : item;
        }),
      );
    },
    [portfolioId],
  );

  useEffect(() => {
    if (!portfolioId) return;
    const channel = supabase
      .channel(`snapshots:${portfolioId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "portfolio_snapshots",
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        () => fetchChartData(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [portfolioId, fetchChartData]);

  const points: PortfolioChartPoint[] = useMemo(() => {
    if (data?.length) return data;
    if (!chartSeries.length) return [];
    return chartSeries.map((point) => ({
      time: point.date,
      value:
        mode === "value"
          ? point.total_value
          : mode === "simple"
            ? point.simple_return_pct
            : point.twr_pct,
    }));
  }, [chartSeries, data, mode]);

  const inceptionDate = useMemo(() => {
    if (chartSeries.length > 0) return chartSeries[0].date;
    if (data?.length) return data[0].time;
    return null;
  }, [chartSeries, data]);

  useEffect(() => {
    if (!inceptionDate) return;
    for (const benchmark of activeBenchmarks) {
      const ticker = benchmark.ticker.toUpperCase();
      if (
        pricesCoverStart(benchmarkPrices[ticker], inceptionDate) ||
        loadingBenchmarkTickers.has(ticker)
      )
        continue;
      setLoadingBenchmarkTickers((current) => new Set(current).add(ticker));
      void (async () => {
        try {
          const res = await fetch(
            `${API_BASE_URL}/api/benchmarks/${encodeURIComponent(ticker)}/prices?from=${encodeURIComponent(inceptionDate)}`,
            { headers: await authHeaders() },
          );
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Failed to load benchmark prices");
          setBenchmarkPrices((current) => ({
            ...current,
            [ticker]: Array.isArray(body) ? body : [],
          }));
        } catch {
          setBenchmarkPrices((current) => ({ ...current, [ticker]: [] }));
        } finally {
          setLoadingBenchmarkTickers((current) => {
            const next = new Set(current);
            next.delete(ticker);
            return next;
          });
        }
      })();
    }
  }, [activeBenchmarks, benchmarkPrices, inceptionDate, loadingBenchmarkTickers]);

  const twrPoints: PortfolioChartPoint[] = useMemo(() => {
    if (!chartSeries.length) return [];
    return chartSeries.map((point) => ({
      time: point.date,
      value: point.twr_pct,
    }));
  }, [chartSeries]);

  const lineData = useMemo(() => {
    if (points.length === 0) return [];
    const rangeDef = RANGES.find((r) => r.id === range)!;
    let filtered = points;
    if (rangeDef.days) {
      const last = new Date(points[points.length - 1].time);
      const cutoff = new Date(last);
      cutoff.setDate(cutoff.getDate() - rangeDef.days);
      filtered = points.filter((point) => new Date(point.time) >= cutoff);
    }
    return downsample(filtered, range);
  }, [points, range]);

  const visibleBenchmarks = useMemo(
    () => (view === "line" && mode === "value" ? [] : activeBenchmarks),
    [activeBenchmarks, mode, view],
  );

  const benchmarkSeriesByTicker = useMemo(() => {
    const entries = activeBenchmarks.map(
      (benchmark) =>
        [benchmark.ticker, toBenchmarkSeries(benchmarkPrices[benchmark.ticker] ?? [])] as const,
    );
    return new Map(entries);
  }, [activeBenchmarks, benchmarkPrices]);

  const lineChartData = useMemo(() => {
    return lineData.map((point) => {
      const row: Record<string, number | string | null> = { ...point };
      for (const benchmark of visibleBenchmarks) {
        const value = latestValueOnOrBefore(
          benchmarkSeriesByTicker.get(benchmark.ticker) ?? [],
          point.time,
        );
        row[benchmarkKey(benchmark.ticker)] = value;
      }
      return row;
    });
  }, [benchmarkSeriesByTicker, lineData, visibleBenchmarks]);

  const barData = useMemo(() => computeReturns(twrPoints, barPeriod), [twrPoints, barPeriod]);
  const barChartData = useMemo(() => {
    const benchmarkReturnsByTicker = new Map(
      visibleBenchmarks.map((benchmark) => [
        benchmark.ticker,
        new Map(
          computeReturns(benchmarkSeriesByTicker.get(benchmark.ticker) ?? [], barPeriod).map(
            (bar) => [bar.label, bar.returnPct],
          ),
        ),
      ]),
    );
    return barData.map((bar) => {
      const row: Record<string, number | string | null> = { ...bar };
      for (const benchmark of visibleBenchmarks) {
        row[benchmarkKey(benchmark.ticker)] =
          benchmarkReturnsByTicker.get(benchmark.ticker)?.get(bar.label) ?? null;
      }
      return row;
    });
  }, [barData, barPeriod, benchmarkSeriesByTicker, visibleBenchmarks]);

  const hasVisibleBenchmarks = visibleBenchmarks.length > 0;
  const unavailableBenchmarks = useMemo(
    () =>
      visibleBenchmarks.filter((benchmark) => {
        const prices = benchmarkPrices[benchmark.ticker];
        return prices && toBenchmarkSeries(prices).length === 0;
      }),
    [benchmarkPrices, visibleBenchmarks],
  );

  const barPeriods: { id: BarPeriod; label: string }[] = [
    { id: "M", label: "Monthly" },
    { id: "Q", label: "Quarterly" },
    { id: "Y", label: "Yearly" },
  ];

  const fmtPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 pt-16">
      <div className="absolute -top-2 right-0 z-20 flex items-start justify-end">
        <div className="flex flex-col items-end gap-2">
          <div className="text-[9px] font-medium uppercase tracking-[0.12em] text-foreground-muted">
            Benchmark
          </div>
          <ExpandableBenchmarkSearch
            portfolioId={portfolioId}
            activeCount={activeBenchmarks.length}
            savedBenchmarks={savedBenchmarks}
            onApply={applyBenchmark}
            onSave={saveBenchmark}
            onDeleteSaved={deleteSavedBenchmark}
            onChangeSavedColor={changeSavedBenchmarkColor}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex gap-1 rounded-full border border-hairline bg-surface-2 p-1"
          role="tablist"
          aria-label="Chart view"
        >
          {(["line", "returns"] as View[]).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={view === item}
              onClick={() => setView(item)}
              className={`relative rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                view === item ? "text-background" : "text-foreground-muted hover:text-foreground"
              } isolate`}
            >
              {view === item && (
                <motion.span
                  layoutId="portfolio-chart-view-pill"
                  className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                  transition={pillTransition}
                />
              )}
              <span className="relative z-10">{item === "line" ? "Trend" : "Performance"}</span>
            </button>
          ))}
        </div>

        {view === "line" && (
          <div
            className="flex gap-1 rounded-full border border-hairline bg-surface-2 p-1"
            role="tablist"
            aria-label="Chart mode"
          >
            {(
              [
                ["value", "Value"],
                ["simple", "Return"],
                ["twr", "TWR"],
              ] as const
            ).map(([id, label]) => {
              const modeButton = (
                <button
                  key={id}
                  role="tab"
                  aria-selected={mode === id}
                  onClick={() => setMode(id)}
                  className={`relative rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    mode === id ? "text-background" : "text-foreground-muted hover:text-foreground"
                  } isolate`}
                >
                  {mode === id && (
                    <motion.span
                      layoutId="portfolio-chart-mode-pill"
                      className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                      transition={pillTransition}
                    />
                  )}
                  <span className="relative z-10">{label}</span>
                </button>
              );

              if (id !== "twr") return modeButton;

              return (
                <TooltipProvider key={id} delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>{modeButton}</TooltipTrigger>
                    <TooltipContent side="top" className="max-w-64 text-center">
                      Time-Weighted Return. Excludes cash movements to focus on the quality of
                      decision making.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>
        )}

        <div
          className="flex gap-1 rounded-full border border-hairline bg-surface-2 p-1"
          role="tablist"
          aria-label={view === "line" ? "Time range" : "Return period"}
        >
          {view === "line"
            ? RANGES.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={range === item.id}
                  onClick={() => setRange(item.id)}
                  className={`relative rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    range === item.id
                      ? "text-background"
                      : "text-foreground-muted hover:text-foreground"
                  } isolate`}
                >
                  {range === item.id && (
                    <motion.span
                      layoutId="portfolio-chart-range-pill"
                      className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                      transition={pillTransition}
                    />
                  )}
                  <span className="relative z-10">{item.label}</span>
                </button>
              ))
            : barPeriods.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={barPeriod === item.id}
                  onClick={() => setBarPeriod(item.id)}
                  className={`relative rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    barPeriod === item.id
                      ? "text-background"
                      : "text-foreground-muted hover:text-foreground"
                  } isolate`}
                >
                  {barPeriod === item.id && (
                    <motion.span
                      layoutId="portfolio-chart-period-pill"
                      className="pointer-events-none absolute inset-0 z-0 rounded-full bg-foreground"
                      transition={pillTransition}
                    />
                  )}
                  <span className="relative z-10">{item.label}</span>
                </button>
              ))}
        </div>
      </div>

      {loading ? (
        <div className="min-h-0 flex-1 animate-pulse rounded-lg bg-surface-2" />
      ) : view === "returns" ? (
        <ChartContainer
          config={chartConfig}
          className={cn("min-h-[220px] w-full flex-1 !aspect-auto", hasVisibleBenchmarks && "pb-1")}
        >
          <BarChart data={barChartData} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--hairline)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={8}
              tick={{ fill: "var(--foreground-muted)", fontSize: 10 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={52}
              tick={{ fill: "var(--foreground-muted)", fontSize: 10 }}
              tickFormatter={(value: number) => `${value.toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="var(--hairline)" />
            <ChartTooltip
              cursor={{ fill: "var(--hairline)", fillOpacity: 0.5 }}
              content={
                <ChartTooltipContent
                  formatter={(value: unknown, name: unknown) =>
                    `${fmtPct(value as number)} - ${benchmarkLabelFromName(name, visibleBenchmarks)}`
                  }
                  indicator="dot"
                />
              }
            />
            <Bar dataKey="returnPct" radius={[3, 3, 0, 0]}>
              {barData.map((entry, index) => (
                <Cell
                  key={`${entry.label}-${index}`}
                  fill={entry.returnPct >= 0 ? "var(--accent-teal)" : "var(--destructive)"}
                  fillOpacity={0.85}
                />
              ))}
            </Bar>
            {visibleBenchmarks.map((benchmark) => (
              <Bar
                key={benchmark.ticker}
                dataKey={benchmarkKey(benchmark.ticker)}
                name={benchmark.name}
                fill={benchmarkColor(benchmark.color)}
                fillOpacity={0.88}
                radius={[3, 3, 0, 0]}
              />
            ))}
          </BarChart>
        </ChartContainer>
      ) : (
        <ChartContainer
          config={chartConfig}
          className={cn("min-h-[220px] w-full flex-1 !aspect-auto", hasVisibleBenchmarks && "pb-1")}
        >
          <AreaChart data={lineChartData} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--chart-accent)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--chart-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--hairline)" />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={40}
              tick={{ fill: "var(--foreground-muted)", fontSize: 10 }}
              tickFormatter={(value: string) =>
                new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })
              }
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={72}
              tick={{ fill: "var(--foreground-muted)", fontSize: 10 }}
              tickFormatter={(value: number) => fmtValue(value, mode, displayCurrency)}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--chart-accent)", strokeOpacity: 0.4, strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  labelFormatter={(value: string) =>
                    new Date(value).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  }
                  formatter={(value: unknown, name: unknown) =>
                    `${fmtValue(value as number, mode, displayCurrency)} - ${benchmarkLabelFromName(name, visibleBenchmarks)}`
                  }
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey="value"
              type="natural"
              fill="url(#fillValue)"
              stroke="var(--chart-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 5,
                fill: "var(--chart-accent)",
                stroke: "var(--background)",
                strokeWidth: 2,
              }}
            />
            {visibleBenchmarks.map((benchmark) => (
              <Line
                key={benchmark.ticker}
                dataKey={benchmarkKey(benchmark.ticker)}
                name={benchmark.name}
                type="natural"
                stroke={benchmarkColor(benchmark.color)}
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: benchmarkColor(benchmark.color),
                  stroke: "var(--background)",
                  strokeWidth: 2,
                }}
                connectNulls
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )}

      {hasVisibleBenchmarks && (
        <div className="shrink-0 border-t border-hairline pt-2 text-xs leading-none text-foreground-muted">
          <div className="relative flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--chart-accent)]" />
                <span>Portfolio</span>
              </div>
              {visibleBenchmarks.map((benchmark) => (
                <div key={benchmark.ticker} className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: benchmarkColor(benchmark.color) }}
                  />
                  <span className="truncate">{benchmark.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${benchmark.name}`}
                    onClick={() =>
                      setActiveBenchmarks((current) =>
                        current.filter((item) => item.ticker !== benchmark.ticker),
                      )
                    }
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-surface-2/80 text-foreground-muted shadow-sm transition-colors hover:border-foreground/30 hover:bg-surface-2 hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setActiveBenchmarks([])}
              className="shrink-0 rounded-full border border-hairline bg-surface-2/80 px-2.5 py-1 text-xs text-foreground-muted shadow-sm transition-colors hover:border-foreground/30 hover:bg-surface-2 hover:text-foreground sm:absolute sm:right-0"
            >
              Clear all
            </button>
          </div>
          {unavailableBenchmarks.length > 0 && (
            <div className="mt-2 text-center text-[11px] text-foreground-muted">
              No benchmark price data for{" "}
              {unavailableBenchmarks.map((benchmark) => benchmark.name).join(", ")}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

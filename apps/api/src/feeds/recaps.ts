// ============================================================
// Recap generation — RAG core.
//
// Pipeline per recap (plan §3/§4):
//   1. Gather hard facts deterministically (snapshots → return,
//      holdings × Yahoo → biggest mover, indices, polymarket).
//   2. Retrieve narrative via Exa (mover press + macro), with an
//      explicit no-press fallback for thinly-covered movers.
//   3. Single grounded Gemini call → prose-only slides.
//   4. Assemble SlideSpec[] by attaching the COMPUTED stat/chart/
//      sources to each slide (numbers never come from the LLM).
//
// Self-contained like news.ts / polymarket.ts: own Env subset,
// own Yahoo + Exa helpers, no import from index.ts (avoids a
// circular dep with the queue handler).
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client, RunTree } from "langsmith";
import { withRunTree } from "langsmith/traceable";
import {
  invokeGeminiStructured,
  invokeGeminiWithTools,
  MaxIterationsError,
  geminiModel,
  type GeminiSchema,
  type GeminiFunctionDeclaration,
  type GeminiFunctionParam,
  type ToolCallRecord,
} from "../llm/gemini";
import type {
  RecapType,
  SlideKind,
  SlideStat,
  SlideSpec,
  SlideChart,
  SlideSource,
  ChartSeries,
  RecapLlmOutput,
  RecapLlmSlide,
  Direction,
} from "./recap-types";
import { NEWS_INCLUDE_DOMAINS, NEWS_INCLUDE_DOMAINS_SECONDARY } from "./news";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  EXA_SEARCH?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_BASE_URL?: string;
  // Optional — when unset, recap generation runs identically but is not
  // traced and no presigned feedback token is produced.
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  // Override the LangSmith API base URL (e.g. EU region). Defaults to US.
  LANGSMITH_ENDPOINT?: string;
  // Required for org-scoped API keys (sent as x-tenant-id).
  LANGSMITH_WORKSPACE_ID?: string;
}

function db(env: Env): AnySupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}

// LangSmith client — null when not configured, so tracing is opt-in and the
// generation path is identical without it. Instantiated per request from the
// Worker env binding (no module-load env access in CF Workers).
function langsmithClient(env: Env): Client | null {
  if (!env.LANGSMITH_API_KEY) return null;
  return new Client({
    apiKey: env.LANGSMITH_API_KEY,
    // Region-specific. US is the default; EU-region accounts set
    // LANGSMITH_ENDPOINT to https://eu.api.smith.langchain.com.
    apiUrl: env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
    // Required by LangSmith for org-scoped API keys (sent as x-tenant-id) —
    // without it an org-scoped key gets 403 Forbidden. Harmless for
    // workspace-scoped keys; omitted entirely when unset.
    workspaceId: env.LANGSMITH_WORKSPACE_ID,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default benchmark indices per primary_exchange, used when the portfolio has
// no saved_benchmarks configured. Tickers are Yahoo index symbols.
const EXCHANGE_INDEX_DEFAULTS: Record<string, Array<{ ticker: string; label: string }>> = {
  NYSE: [{ ticker: "^GSPC", label: "S&P 500" }],
  NASDAQ: [{ ticker: "^IXIC", label: "Nasdaq" }],
  EURONEXT: [
    { ticker: "^FCHI", label: "CAC 40" },
    { ticker: "^STOXX50E", label: "Euro Stoxx 50" },
  ],
  XETRA: [{ ticker: "^GDAXI", label: "DAX" }],
  LSE: [{ ticker: "^FTSE", label: "FTSE 100" }],
  TSE: [{ ticker: "^N225", label: "Nikkei 225" }],
};

const EXCHANGE_REGION: Record<string, { label: string; userLocation: string }> = {
  NYSE: { label: "the US", userLocation: "us" },
  NASDAQ: { label: "the US", userLocation: "us" },
  EURONEXT: { label: "Europe", userLocation: "fr" },
  XETRA: { label: "Germany", userLocation: "de" },
  LSE: { label: "the UK", userLocation: "gb" },
  TSE: { label: "Japan", userLocation: "jp" },
};

// Exa relevance floor for the mover search. Below this (or zero results) we
// switch to the no-press fallback. Starts permissive; recalibrate from
// observed Exa output (see plan verification).
const MOVER_MIN_SCORE = 0.25;
const EXA_BASE = "https://api.exa.ai";

// Series colors map to design-system tokens (resolved on the web). The
// portfolio line uses the monochrome chart-accent (matches portfolio-chart.tsx);
// indices use the categorical benchmark palette.
const PORTFOLIO_COLOR = "chart-accent";
const INDEX_COLORS = ["benchmark-amber", "benchmark-violet", "benchmark-sky"];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function directionOf(x: number): Direction {
  if (x > 0.05) return "up";
  if (x < -0.05) return "down";
  return "flat";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Yahoo daily series (self-contained; mirrors index.ts fetchHistoricalPrices)
// ---------------------------------------------------------------------------

interface YahooSeries {
  symbol: string;
  series: Array<{ date: string; close: number }>;
  currentPrice: number | null;
  previousClose: number | null;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchYahooSeries(symbol: string, fromMs: number): Promise<YahooSeries> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("period2", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return { symbol, series: [], currentPrice: null, previousClose: null };
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number | null; previousClose?: number | null };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const series: Array<{ date: string; close: number }> = [];
    timestamps.forEach((ts, idx) => {
      const close = closes[idx];
      if (close == null) return;
      series.push({ date: toDateStr(new Date(ts * 1000)), close });
    });
    return {
      symbol,
      series,
      currentPrice: result?.meta?.regularMarketPrice ?? series.at(-1)?.close ?? null,
      previousClose: result?.meta?.previousClose ?? series.at(-2)?.close ?? null,
    };
  } catch {
    return { symbol, series: [], currentPrice: null, previousClose: null };
  }
}

// Period change % for an instrument over the recap window. Daily uses the last
// two closes (≈1d); weekly uses first→last close across the window.
function periodChangePct(y: YahooSeries, type: RecapType): number | null {
  if (type === "daily") {
    const last = y.currentPrice ?? y.series.at(-1)?.close ?? null;
    const prev = y.previousClose ?? y.series.at(-2)?.close ?? null;
    if (last == null || prev == null || prev === 0) return null;
    return (last / prev - 1) * 100;
  }
  const first = y.series[0]?.close ?? null;
  const last = y.series.at(-1)?.close ?? y.currentPrice ?? null;
  if (first == null || last == null || first === 0) return null;
  return (last / first - 1) * 100;
}

// ---------------------------------------------------------------------------
// Exa (focused: search + summaries, single light retry inline)
// ---------------------------------------------------------------------------

interface ExaResult {
  id?: string;
  url?: string;
  title?: string;
  publishedDate?: string | null;
  score?: number;
  summary?: string;
}

async function exaSearch(
  apiKey: string,
  query: string,
  startPublishedDate: string,
  userLocation: string,
  numResults: number,
  includeDomains?: string[],
): Promise<ExaResult[]> {
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query,
        type: "auto",
        category: "news",
        numResults,
        startPublishedDate,
        userLocation,
        ...(includeDomains && includeDomains.length ? { includeDomains } : {}),
        contents: { summary: { query } },
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: ExaResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

function toSources(results: ExaResult[], limit: number): SlideSource[] {
  const out: SlideSource[] = [];
  for (const r of results) {
    if (!r.url || !r.title) continue;
    let host = "";
    try {
      host = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    out.push({ title: r.title, url: r.url, source: host });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gathered context
// ---------------------------------------------------------------------------

interface MoverInfo {
  ticker: string;
  name: string;
  changePct: number;
  contribution: number; // signed weight × change fraction (native currency)
  series: Array<{ date: string; close: number }>;
}

interface GatheredContext {
  type: RecapType;
  periodLabel: string; // "today" | "this week"
  // performance
  returnPct: number;
  portfolioSeries: Array<{ date: string; close: number }>;
  // movers: biggest gainer + biggest loser (by signed contribution)
  gainer: MoverInfo | null;
  loser: MoverInfo | null;
  // the more significant of the two (larger |contribution|) — gets the chart + press
  dominantMover: MoverInfo | null;
  moverPress: SlideSource[];
  moverPressSummaries: string[];
  moverNoPress: boolean;
  // indices / macro
  indices: Array<{ label: string; changePct: number }>;
  macroPress: SlideSource[];
  macroPressSummaries: string[];
  // watch
  watch: Array<{ question: string; url: string | null; topProbability: number | null }>;
  usPct: number; // US exposure % from geography allocations (for watch slide context)
  holdingsSummary: Array<{ ticker: string; name: string }>; // for watch prompt (what's in the book)
}

interface RecapRowLite {
  id: string;
  portfolio_id: string;
  user_id: string;
  type: RecapType;
  period_start: string;
  period_end: string;
}

// ---------------------------------------------------------------------------
// Step 1+2: gather facts + retrieve narrative
// ---------------------------------------------------------------------------

async function gatherContext(
  env: Env,
  recap: RecapRowLite,
  macroCache: Map<string, { sources: SlideSource[]; summaries: string[] }>,
): Promise<GatheredContext | null> {
  const client = db(env);
  const type = recap.type;
  const periodLabel = type === "daily" ? "today" : "this week";

  // --- portfolio metadata (exchange, cash, holdings) ---
  const { data: pf } = await client
    .from("portfolios")
    .select("primary_exchange,cash_value")
    .eq("id", recap.portfolio_id)
    .maybeSingle();
  const primaryExchange = String(pf?.primary_exchange ?? "").toUpperCase();
  const cashValue = Number(pf?.cash_value ?? 0);

  const { data: holdingRows } = await client
    .from("holdings")
    .select("id,ticker,name,quantity,asset_type")
    .eq("portfolio_id", recap.portfolio_id)
    .gt("quantity", 0);
  const holdings = (holdingRows ?? []).map((r) => ({
    ticker: String(r.ticker).toUpperCase(),
    name: String(r.name ?? r.ticker),
    quantity: Number(r.quantity ?? 0),
  }));
  if (holdings.length === 0) return null;

  // --- performance + movers from price_history (single source of truth) ---
  // Lookback: period_start - 5 calendar days to capture the prior trading day.
  const lookbackDate = new Date(`${recap.period_start}T00:00:00.000Z`);
  lookbackDate.setUTCDate(lookbackDate.getUTCDate() - 5);
  const tickers = holdings.map((h) => h.ticker);

  const { data: priceRows } = await client
    .from("price_history")
    .select("yahoo_ticker,date,closing_price")
    .in("yahoo_ticker", tickers)
    .gte("date", toDateStr(lookbackDate))
    .lte("date", recap.period_end)
    .order("date", { ascending: true });

  // Build per-ticker sorted date maps from price_history.
  const priceMapByTicker = new Map<string, Map<string, number>>();
  for (const row of priceRows ?? []) {
    const t = String(row.yahoo_ticker).toUpperCase();
    if (!priceMapByTicker.has(t)) priceMapByTicker.set(t, new Map());
    priceMapByTicker.get(t)!.set(String(row.date), Number(row.closing_price));
  }

  // Collect all trading days across tickers.
  const allTradingDaySet = new Set<string>();
  for (const dateMap of priceMapByTicker.values()) {
    for (const d of dateMap.keys()) allTradingDaySet.add(d);
  }
  const allTradingDays = Array.from(allTradingDaySet).sort();

  // Helper: carry-forward close on or before a date.
  function carryForward(dateMap: Map<string, number>, dateStr: string): number | null {
    let best: number | null = null;
    let bestDate = "";
    for (const [d, p] of dateMap.entries()) {
      if (d <= dateStr && d > bestDate) { bestDate = d; best = p; }
    }
    return best;
  }

  // V(date) = Σ qty × close + cash
  function portfolioValue(dateStr: string): number {
    let v = cashValue;
    for (const h of holdings) {
      const map = priceMapByTicker.get(h.ticker);
      const p = carryForward(map ?? new Map(), dateStr);
      if (p != null) v += h.quantity * p;
    }
    return v;
  }

  // Determine start and end trading days for the period.
  const tradingDaysInPeriod = allTradingDays.filter(
    (d) => d >= recap.period_start && d <= recap.period_end,
  );

  // Daily: prior trading day close → today's close (overnight return).
  // Weekly: first trading day of the week (Mon) → last trading day (Fri).
  //   "What happened this week?" = Mon open value vs Fri close, measured from
  //   Mon's own close (the first close of the week).
  let startDate: string;
  let endDate: string;
  if (type === "daily") {
    const beforePeriod = allTradingDays.filter((d) => d < recap.period_start);
    startDate = beforePeriod.at(-1) ?? tradingDaysInPeriod[0] ?? "";
    endDate = tradingDaysInPeriod.at(-1) ?? startDate;
  } else {
    // Weekly: Mon close → Fri close of this trading week.
    startDate = tradingDaysInPeriod[0] ?? allTradingDays[0] ?? "";
    endDate = tradingDaysInPeriod.at(-1) ?? startDate;
  }
  if (!startDate || !endDate || startDate === endDate) return null;

  const vStart = portfolioValue(startDate);
  const vEnd = portfolioValue(endDate);
  if (vStart <= 0) return null;
  const returnPct = (vEnd / vStart - 1) * 100;

  // Slide-1 sparkline: portfolio value across the period trading days.
  const sparklineDays = allTradingDays.filter((d) => d >= startDate && d <= endDate);
  const portfolioSeries = sparklineDays.map((d) => ({ date: d, close: portfolioValue(d) }));

  // Movers: per-holding change from startDate to endDate using the same price maps.
  let gainer: MoverInfo | null = null;
  let loser: MoverInfo | null = null;
  for (const h of holdings) {
    const map = priceMapByTicker.get(h.ticker);
    if (!map) continue;
    const pStart = carryForward(map, startDate);
    const pEnd = carryForward(map, endDate);
    if (!pStart || !pEnd || pStart === 0) continue;
    const changePct = (pEnd / pStart - 1) * 100;
    const contribution = h.quantity * (pEnd - pStart);
    const series = Array.from(map.entries())
      .filter(([d]) => d >= startDate && d <= endDate)
      .map(([d, p]) => ({ date: d, close: p }));
    const info: MoverInfo = { ticker: h.ticker, name: h.name, changePct, contribution, series };
    if (contribution > 0 && (!gainer || contribution > gainer.contribution)) gainer = info;
    if (contribution < 0 && (!loser || contribution < loser.contribution)) loser = info;
  }
  const dominantMover =
    [gainer, loser].filter((m): m is MoverInfo => m != null).sort(
      (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
    )[0] ?? null;

  const { data: savedBenchmarks } = await client
    .from("saved_benchmarks")
    .select("ticker,name")
    .eq("portfolio_id", recap.portfolio_id)
    .limit(3);

  const indexTargets =
    (savedBenchmarks ?? []).length > 0
      ? (savedBenchmarks ?? []).map((b) => ({
          ticker: String(b.ticker).toUpperCase(),
          // Collapse stray whitespace in user-entered benchmark names so the
          // chart axis label is clean (e.g. "EURO STOXX 50      I").
          label: String(b.name ?? b.ticker).replace(/\s+/g, " ").trim(),
        }))
      : (EXCHANGE_INDEX_DEFAULTS[primaryExchange] ?? []);

  // Indices use Yahoo because they aren't in price_history; window from start date.
  const indexWindowMs = new Date(`${startDate}T00:00:00.000Z`).getTime() - 3 * 86_400_000;
  const indexSeries = await mapLimit(indexTargets, 3, (t) =>
    fetchYahooSeries(t.ticker, indexWindowMs).then((y) => ({ t, y })),
  );
  const indices = indexSeries
    .map(({ t, y }) => ({ label: t.label, changePct: periodChangePct(y, type) }))
    .filter((x): x is { label: string; changePct: number } => x.changePct != null);

  // --- watch (slide 4): top portfolio-relevant Polymarket markets ---
  // Select by relevance (is_pinned then score) — drop the near-term end_date
  // filter that was excluding the portfolio's highest-relevance markets
  // (Fed rate hike 0.82, no rate cuts 0.80, inflation 0.72, recession 0.68…
  // all Dec-2026 end dates). Keep end_date only as context "by when".
  const { data: watchRows } = await client
    .from("portfolio_polymarket_matches")
    .select(
      `is_pinned, score,
       polymarket_markets!inner(question, event_slug, outcome_prices, end_date, active)`,
    )
    .eq("portfolio_id", recap.portfolio_id)
    .eq("polymarket_markets.active", true)
    .gte("polymarket_markets.end_date", new Date().toISOString())
    .order("is_pinned", { ascending: false })
    .order("score", { ascending: false, nullsFirst: false })
    .limit(5);

  // Geography exposure for the watch prompt (US% and notable ETFs).
  const { data: geoRows } = await client
    .from("holding_geography_allocations")
    .select("country_code,weight_pct,holding_id")
    .in("holding_id", holdingRows?.map((h: { id?: string }) => String(h.id ?? "")).filter(Boolean) ?? []);

  // Compute US % of the total securities weight (sum of all geo allocations).
  let totalGeoWeight = 0;
  let usGeoWeight = 0;
  for (const row of geoRows ?? []) {
    const w = Number(row.weight_pct ?? 0);
    totalGeoWeight += w;
    if (String(row.country_code).toUpperCase() === "US") usGeoWeight += w;
  }
  const usPct = totalGeoWeight > 0 ? Math.round((usGeoWeight / totalGeoWeight) * 100) : 0;
  const watch = (watchRows ?? []).map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (r as any).polymarket_markets;
    const prices: number[] = Array.isArray(m?.outcome_prices) ? m.outcome_prices.map(Number) : [];
    return {
      question: String(m?.question ?? ""),
      url: m?.event_slug ? `https://polymarket.com/event/${m.event_slug}` : null,
      topProbability: prices.length ? Math.max(...prices) : null,
    };
  });

  // --- narrative retrieval (Exa) ---
  const region = EXCHANGE_REGION[primaryExchange] ?? { label: "global markets", userLocation: "us" };
  const windowDays = type === "daily" ? 2 : 8;
  const startPublished = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  let moverPress: SlideSource[] = [];
  let moverPressSummaries: string[] = [];
  let moverNoPress = true;
  if (dominantMover && env.EXA_SEARCH) {
    // Reuse stored news_clusters first (zero cost).
    const { data: clusterRows } = await client
      .from("portfolio_news_matches")
      .select(`score, news_clusters!inner(primary_article, entities, expires_at)`)
      .eq("portfolio_id", recap.portfolio_id)
      .gt("news_clusters.expires_at", new Date().toISOString())
      .order("score", { ascending: false })
      .limit(10);
    const moverTicker = dominantMover.ticker;
    const matchedClusters = (clusterRows ?? []).filter((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ents = (r as any).news_clusters?.entities ?? {};
      const tickers: string[] = (ents.tickers ?? []).map((t: string) => String(t).toUpperCase());
      return tickers.includes(moverTicker);
    });
    if (matchedClusters.length > 0) {
      moverPress = matchedClusters.slice(0, 3).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = (r as any).news_clusters?.primary_article ?? {};
        return { title: String(a.title ?? ""), url: String(a.url ?? ""), source: String(a.source ?? "") };
      });
      moverPressSummaries = matchedClusters.slice(0, 3).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = (r as any).news_clusters?.primary_article ?? {};
        return String(a.snippet ?? a.title ?? "");
      });
      moverNoPress = false;
    } else {
      const dir = dominantMover.changePct >= 0 ? "rise" : "fall";
      // Premium allowlist: small-caps with no premium coverage fall through to
      // the no-press framing (desired) rather than citing SEO junk.
      const results = await exaSearch(
        env.EXA_SEARCH,
        `What drove ${dominantMover.name} (${dominantMover.ticker}) stock to ${dir} ${periodLabel}?`,
        startPublished,
        region.userLocation,
        8,
        NEWS_INCLUDE_DOMAINS,
      );
      const onTarget = results.filter((r) => (r.score ?? 0) >= MOVER_MIN_SCORE);
      if (onTarget.length > 0) {
        moverPress = toSources(onTarget, 3);
        moverPressSummaries = onTarget.slice(0, 3).map((r) => r.summary ?? r.title ?? "");
        moverNoPress = false;
      }
    }
  }

  // Macro press — shared across portfolios per region within a fanout batch.
  // Restricted to the premium financial-press allowlist (FT/WSJ/Bloomberg/
  // Reuters/Economist/lesechos…) — the "markets wrap" tier — so we never cite
  // the .sg/.hk/SEO long tail.
  let macroPress: SlideSource[] = [];
  let macroPressSummaries: string[] = [];
  const macroKey = `${primaryExchange}:${type}`;
  if (env.EXA_SEARCH) {
    const cached = macroCache.get(macroKey);
    if (cached) {
      macroPress = cached.sources;
      macroPressSummaries = cached.summaries;
    } else {
      const results = await exaSearch(
        env.EXA_SEARCH,
        `${region.label} stock market wrap: what moved markets ${periodLabel}`,
        startPublished,
        region.userLocation,
        10,
        NEWS_INCLUDE_DOMAINS,
      );
      macroPress = toSources(results, 3);
      macroPressSummaries = results.slice(0, 3).map((r) => r.summary ?? r.title ?? "");
      macroCache.set(macroKey, { sources: macroPress, summaries: macroPressSummaries });
    }
  }

  return {
    type,
    periodLabel,
    returnPct,
    portfolioSeries,
    gainer,
    loser,
    dominantMover,
    moverPress,
    moverPressSummaries,
    moverNoPress,
    indices,
    macroPress,
    macroPressSummaries,
    watch,
    usPct,
    holdingsSummary: holdings.map((h) => ({ ticker: h.ticker, name: h.name })),
  };
}

// ---------------------------------------------------------------------------
// Step 3: prompt + Gemini
// ---------------------------------------------------------------------------

function buildLlmSchema(type: RecapType): GeminiSchema {
  const kindEnum = type === "daily"
    ? ["performance", "macro", "mover"]
    : ["performance", "macro", "mover", "watch"];
  return {
    type: "OBJECT",
    properties: {
      slides: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            kind: { type: "STRING", enum: kindEnum },
            headline: { type: "STRING" },
            body: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["kind", "headline", "body"],
          propertyOrdering: ["kind", "headline", "body"],
        },
      },
    },
    required: ["slides"],
  };
}

function buildStaticSystemPrompt(type: RecapType): string {
  const slideCount = type === "daily" ? "3" : "4";
  const slideOrder = type === "daily"
    ? "performance, macro, mover"
    : "performance, macro, mover, watch";
  const watchLine = type === "weekly"
    ? "For the watch slide, name the 1-2 most important concrete, dated catalysts from the provided items; avoid vague themes like 'monitor inflation' unless tied to a specific named event."
    : "";
  return [
    `You write a ${slideCount}-slide ${type} portfolio recap for a retail investor.`,
    "Voice: calm, factual, sharp, concise. Each slide is 1-3 short lines. Short and sweet.",
    "Use ONLY the facts and source snippets provided for prices, news, and specific events.",
    "Put NO prices, currency amounts, or percentage figures in your prose — those are rendered separately from structured data. Do not restate the numbers.",
    "Make no quantified factual claim (e.g. 'third straight day', 'two-week low', 'record high') and cite no specific event or catalyst unless a provided source snippet states it.",
    "You MAY use well-known general knowledge of a company's industry/sector and broad, established sector themes for context (e.g. 'the semiconductor maker, a beneficiary of AI demand'). Do not invent company-specific news, figures, or dates.",
    "Only relate a holding to a market index when the holding actually trades in that market — e.g. do not imply a French-listed stock tracks the Nasdaq. Compare it to its own market's index or its sector instead.",
    "Never invent a cause. If told no company-specific news drove a move, say so plainly; attribute it to broad/sector movement only when that is supported.",
    watchLine,
    `Return the ${slideCount} slides in order: ${slideOrder}.`,
  ].filter(Boolean).join(" ");
}

function buildUserPrompt(ctx: GatheredContext): string {
  const lines: string[] = [];
  lines.push(`PERIOD: ${ctx.type} recap (covers ${ctx.periodLabel}).`);
  lines.push("");
  lines.push("=== FACTS (already computed; do not repeat the numbers in prose) ===");
  lines.push(
    `Portfolio ${ctx.returnPct >= 0 ? "rose" : "fell"} ${ctx.periodLabel} (direction only; the figure renders separately).`,
  );
  if (ctx.indices.length > 0) {
    lines.push(
      `Reference indices and their direction ${ctx.periodLabel}: ` +
        ctx.indices.map((i) => `${i.label} ${i.changePct >= 0 ? "up" : "down"}`).join(", ") +
        ".",
    );
  } else {
    lines.push("No reference index data available.");
  }
  if (ctx.gainer) {
    lines.push(`Biggest gainer: ${ctx.gainer.name} (${ctx.gainer.ticker}), up ${ctx.periodLabel}.`);
  }
  if (ctx.loser) {
    lines.push(`Biggest loser: ${ctx.loser.name} (${ctx.loser.ticker}), down ${ctx.periodLabel}.`);
  }
  if (!ctx.gainer && !ctx.loser) {
    lines.push("No notable individual movers identified.");
  }
  if (ctx.dominantMover && ctx.moverNoPress) {
    lines.push(
      `NO company-specific news was found for ${ctx.dominantMover.name}. Do NOT invent a catalyst. You may note its industry/sector and broad sector themes; otherwise state plainly that no major company news drove the move.`,
    );
  }
  // Portfolio composition — so the model knows exactly which holdings are exposed to each risk.
  lines.push(
    "Portfolio holdings: " +
      ctx.holdingsSummary.map((h) => `${h.name} (${h.ticker})`).join(", ") + ".",
  );
  if (ctx.usPct > 0) {
    lines.push(`US exposure: ~${ctx.usPct}% of the portfolio. US monetary policy and economic data are directly material.`);
  }
  if (ctx.watch.length > 0) {
    lines.push(
      "Crowd-consensus event probabilities (Polymarket) — use these as one input, not the only one:\n" +
        ctx.watch
          .filter((w) => w.question)
          .map((w, i) => {
            return `  ${i + 1}. ${w.question}${w.topProbability != null ? ` — ${Math.round(w.topProbability * 100)}% probability` : ""}`;
          })
          .join("\n"),
    );
  }
  lines.push("Also use the macro/market press snippets below to identify sector or macro catalysts that could move these specific holdings.");
  lines.push("");
  lines.push("=== SOURCE SNIPPETS (cite these only; do not invent others) ===");
  if (ctx.macroPressSummaries.length > 0) {
    lines.push("Macro/market:");
    ctx.macroPressSummaries.forEach((s, i) => lines.push(`  [M${i + 1}] ${s}`));
  }
  if (ctx.moverPressSummaries.length > 0) {
    lines.push("Mover:");
    ctx.moverPressSummaries.forEach((s, i) => lines.push(`  [V${i + 1}] ${s}`));
  }
  if (ctx.macroPressSummaries.length === 0 && ctx.moverPressSummaries.length === 0) {
    lines.push("(none)");
  }
  // Time-frame guidance for search_news tool calls
  if (ctx.type === "daily") {
    lines.push("SEARCH WINDOW: this is a DAILY recap. Search for news from the LAST 48 HOURS ONLY (set date_from to 2 days ago). Focus on what specifically happened today — today's market moves, company announcements, intraday catalysts.");
  } else {
    lines.push("SEARCH WINDOW: this is a WEEKLY recap. Search for news from the LAST 7-10 DAYS to capture context from across the full week.");
  }
  lines.push("");
  lines.push("=== SLIDES TO WRITE ===");
  lines.push("performance: one line on whether the book was up or down and the broad reason.");
  lines.push("macro: the market backdrop — how the relevant indices moved and why, grounded in the macro snippets.");
  lines.push(
    "mover: cover the biggest gainer AND the biggest loser. For each, why it moved — use the mover snippets if present, else its sector/industry context. Keep it sharp.",
  );
  if (ctx.type === "weekly") {
    lines.push(
      "watch: 3-4 concrete catalysts to watch next week that could impact THIS portfolio's specific holdings. For each item, name the catalyst AND which holding(s) it affects. Draw from: (1) the Polymarket event probabilities above as crowd-consensus signals, (2) the macro press snippets as current news context — do not use Polymarket alone. Include sector-specific risks (e.g. oil price moves for TotalEnergies, rate decisions for growth/tech holdings). You may use up to 4 sentences.",
    );
  }
  return lines.join("\n");
}

function parseLlmOutput(text: string): RecapLlmOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("Gemini output was not JSON");
    parsed = JSON.parse(text.slice(s, e + 1));
  }
  const slides = (parsed as RecapLlmOutput)?.slides;
  if (!Array.isArray(slides)) throw new Error("Gemini output missing slides[]");
  return { slides };
}

// ---------------------------------------------------------------------------
// Step 4: assemble final slides (attach COMPUTED data by kind)
// ---------------------------------------------------------------------------

function assembleSlides(ctx: GatheredContext, llm: RecapLlmOutput): SlideSpec[] {
  const byKind = new Map<SlideKind, RecapLlmSlide>();
  for (const s of llm.slides) {
    if (s && typeof s.headline === "string" && Array.isArray(s.body)) byKind.set(s.kind, s);
  }

  // Soft lint: prose must not contain raw % / $ figures (plan §4a). We log, not fail.
  const figureRe = /[%$€£]|\d+\.\d+/;
  let proseFigureHits = 0;
  for (const s of byKind.values()) {
    if (s.body.some((b) => figureRe.test(b)) || figureRe.test(s.headline)) proseFigureHits++;
  }
  if (proseFigureHits > 0) {
    console.warn(`[recaps] prose contained figures in ${proseFigureHits} slide(s) — rendered as-is, structured data is source of truth`);
  }

  const prose = (kind: SlideKind, fallbackHeadline: string): { headline: string; body: string[] } => {
    const s = byKind.get(kind);
    return { headline: s?.headline ?? fallbackHeadline, body: s?.body ?? [] };
  };

  const slides: SlideSpec[] = [];

  // 1. performance
  {
    const p = prose("performance", ctx.returnPct >= 0 ? "Your portfolio gained" : "Your portfolio dipped");
    slides.push({
      schema_version: 1,
      kind: "performance",
      headline: p.headline,
      body: p.body,
      stat: {
        label: ctx.type === "daily" ? "Today" : "This week",
        value: formatPct(ctx.returnPct),
        direction: directionOf(ctx.returnPct),
      },
      chart: {
        type: "sparkline",
        series: [
          {
            key: "portfolio",
            label: "Portfolio",
            color: PORTFOLIO_COLOR,
            points: ctx.portfolioSeries.map((p2) => ({ x: p2.date, y: p2.close })),
          },
        ],
      },
    });
  }

  // 2. macro (index bars: portfolio vs indices)
  {
    const p = prose("macro", "The market backdrop");
    const barSeries: ChartSeries[] = [
      {
        key: "portfolio",
        label: "Portfolio",
        color: PORTFOLIO_COLOR,
        points: [{ x: "Portfolio", y: Number(ctx.returnPct.toFixed(2)) }],
      },
      ...ctx.indices.map((idx, i) => ({
        key: `index-${i}`,
        label: idx.label,
        color: INDEX_COLORS[i % INDEX_COLORS.length],
        points: [{ x: idx.label, y: Number(idx.changePct.toFixed(2)) }],
      })),
    ];
    slides.push({
      schema_version: 1,
      kind: "macro",
      headline: p.headline,
      body: p.body,
      chart: { type: "bars", series: barSeries },
      sources: ctx.macroPress,
    });
  }

  // 3. mover — biggest gainer + biggest loser; chart shows the dominant one
  {
    const p = prose("mover", "Biggest movers");
    const statOf = (m: MoverInfo): SlideStat => ({
      label: `${m.name} (${m.ticker})`,
      value: formatPct(m.changePct),
      direction: directionOf(m.changePct),
    });
    const stats: SlideStat[] = [];
    if (ctx.gainer) stats.push(statOf(ctx.gainer));
    if (ctx.loser) stats.push(statOf(ctx.loser));

    // Build a mini sparkline for each mover that has ≥2 price points.
    const moverCharts: SlideChart[] = [];
    if (ctx.gainer && ctx.gainer.series.length >= 2) {
      moverCharts.push({
        type: "sparkline",
        series: [{
          key: "gainer",
          label: ctx.gainer.ticker,
          color: "positive",
          points: ctx.gainer.series.map((p2) => ({ x: p2.date, y: p2.close })),
        }],
      });
    }
    if (ctx.loser && ctx.loser.series.length >= 2) {
      moverCharts.push({
        type: "sparkline",
        series: [{
          key: "loser",
          label: ctx.loser.ticker,
          color: "negative",
          points: ctx.loser.series.map((p2) => ({ x: p2.date, y: p2.close })),
        }],
      });
    }

    const slide: SlideSpec = {
      schema_version: 1,
      kind: "mover",
      headline: p.headline,
      body: p.body,
      stats: stats.length ? stats : undefined,
      charts: moverCharts.length ? moverCharts : undefined,
      sources: ctx.moverPress,
    };
    slides.push(slide);
  }

  // 4. watch — weekly only; daily recaps are 3 slides (markets are closed when it fires)
  if (ctx.type === "weekly") {
    const p = prose("watch", "Next week");
    const watchSources: SlideSource[] = [
      ...ctx.macroPress.slice(0, 2),
      ...ctx.watch
        .filter((w) => w.url && w.question)
        .slice(0, 3)
        .map((w) => ({ title: w.question, url: w.url!, source: "Polymarket" })),
    ];
    slides.push({
      schema_version: 1,
      kind: "watch",
      headline: p.headline,
      body: p.body,
      sources: watchSources,
    });
  }

  return slides;
}

// ---------------------------------------------------------------------------
// V1.3: Agentic tool declarations + handlers
// ---------------------------------------------------------------------------

// Tool parameter schemas use lowercase standard JSON Schema types.
function str(description: string): GeminiFunctionParam {
  return { type: "string", description };
}

function buildAgentTools(type: RecapType): GeminiFunctionDeclaration[] {
  const isDaily = type === "daily";
  const slideCount = isDaily ? "3" : "4";
  const slideOrder = isDaily ? "performance, macro, mover" : "performance, macro, mover, watch";
  const kindEnum = isDaily
    ? ["performance", "macro", "mover"]
    : ["performance", "macro", "mover", "watch"];
  const searchDateHint = isDaily
    ? "For a DAILY recap, always set date_from to 2 days ago (YYYY-MM-DD format)."
    : "For a WEEKLY recap, set date_from to 7-10 days ago to cover the full week.";

  const tools: GeminiFunctionDeclaration[] = [
    {
      name: "search_news",
      description:
        "Search for news articles about a company, market, or macro topic via Exa. " +
        "Use language='fr' and French queries for French-listed stocks (.PA tickers) " +
        "or French market news — this retrieves French-language sources like " +
        `boursorama.com, investir.lesechos.fr, latribune.fr. ${searchDateHint}`,
      parameters: {
        type: "object",
        properties: {
          query: str("The search query. Use French for .PA stocks (e.g. 'action SEMCO Technologies ALSEM.PA bourse')."),
          language: { type: "string", enum: ["en", "fr"], description: "Query language and Exa userLocation." },
          date_from: str("Required: ISO date (YYYY-MM-DD) for the lookback window start."),
        },
        required: ["query", "language"],
      },
    },
    {
      name: "get_stored_news",
      description:
        "Retrieve stored news articles for a specific holding ticker from the portfolio's news database. " +
        "Zero Exa cost — checks what has already been indexed. Call this first for any holding before searching.",
      parameters: {
        type: "object",
        properties: {
          ticker: str("The Yahoo Finance ticker (e.g. 'ALSEM.PA', 'TTE.PA')."),
        },
        required: ["ticker"],
      },
    },
    {
      name: "write_slides",
      description:
        "TERMINAL TOOL — call this when you have gathered enough context. " +
        `Submit the final ${slideCount} slides: ${slideOrder}. ` +
        "Prose only — do not include prices, percentages, or dollar amounts in headlines or body text. " +
        "Numbers are rendered separately from structured data.",
      parameters: {
        type: "object",
        properties: {
          slides: {
            type: "array",
            description: `Exactly ${slideCount} slides in order: ${slideOrder}.`,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: kindEnum },
                headline: str("Short headline, no numbers."),
                body: { type: "array", items: str("One sentence."), description: "1-4 sentences of narrative." },
              },
              required: ["kind", "headline", "body"],
            },
          },
        },
        required: ["slides"],
      },
    },
  ];

  // get_polymarket_events is only useful for the weekly watch slide.
  if (!isDaily) {
    tools.splice(2, 0, {
      name: "get_polymarket_events",
      description:
        "Retrieve the top portfolio-relevant Polymarket prediction markets (crowd-consensus probabilities for macro events). " +
        "Use these as one signal alongside news — not the only source for the watch slide.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    });
  }

  return tools;
}

function buildAgentToolHandlers(
  env: Env,
  client: ReturnType<typeof db>,
  portfolioId: string,
  ctx: GatheredContext,
  collectedSources: { mover: SlideSource[]; moverSummaries: string[]; macro: SlideSource[]; macroSummaries: string[]; watch: typeof ctx.watch },
): Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  return {
    search_news: async (args) => {
      if (!env.EXA_SEARCH) return { results: [], note: "EXA_SEARCH not configured" };
      const query = String(args.query ?? "");
      const language = args.language === "fr" ? "fr" : "en";
      const dateFrom = typeof args.date_from === "string" && args.date_from
        ? args.date_from
        : new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      const startPublished = new Date(`${dateFrom}T00:00:00.000Z`).toISOString();

      // Code decides the domain allowlist — agent cannot override it.
      const isFrench = language === "fr";
      const domains = isFrench
        ? [...NEWS_INCLUDE_DOMAINS, ...NEWS_INCLUDE_DOMAINS_SECONDARY]
        : NEWS_INCLUDE_DOMAINS;

      const results = await exaSearch(env.EXA_SEARCH, query, startPublished, language === "fr" ? "fr" : "us", 8, domains);
      const out = results
        .filter((r) => r.url && r.title)
        .slice(0, 5)
        .map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          source: (() => { try { return new URL(r.url!).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
          summary: r.summary ?? "",
          score: r.score ?? 0,
          published: r.publishedDate ?? "",
        }));

      // Accumulate any useful results into collectedSources for assembleSlides.
      // The agent can search for both macro and mover context — we sort by usage later.
      if (out.length > 0 && collectedSources.macro.length < 3) {
        collectedSources.macro.push(...toSources(results, 3 - collectedSources.macro.length));
        collectedSources.macroSummaries.push(...results.slice(0, 2).map((r) => r.summary ?? r.title ?? ""));
      }

      return { results: out };
    },

    get_stored_news: async (args) => {
      const ticker = String(args.ticker ?? "").toUpperCase();
      const { data } = await client
        .from("portfolio_news_matches")
        .select("score, news_clusters!inner(primary_article, entities, expires_at)")
        .eq("portfolio_id", portfolioId)
        .gt("news_clusters.expires_at", new Date().toISOString())
        .order("score", { ascending: false })
        .limit(12);

      const matchedRows = (data ?? []).filter((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ents = (r as any).news_clusters?.entities ?? {};
        return ((ents.tickers ?? []) as string[]).map((t) => t.toUpperCase()).includes(ticker);
      });

      const articles = matchedRows.slice(0, 5).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = (r as any).news_clusters?.primary_article ?? {};
        return {
          title: String(a.title ?? ""),
          url: String(a.url ?? ""),
          source: String(a.source ?? ""),
          snippet: String(a.snippet ?? ""),
          published: String(a.published_at ?? ""),
        };
      });

      // If the dominant mover matches, update collectedSources.
      if (articles.length > 0 && (ctx.dominantMover?.ticker === ticker)) {
        collectedSources.mover = articles.map((a) => ({ title: a.title, url: a.url, source: a.source }));
        collectedSources.moverSummaries = articles.map((a) => a.snippet || a.title);
      }

      return { ticker, articles };
    },

    get_polymarket_events: async () => {
      const events = ctx.watch.map((w) => ({
        question: w.question,
        probability: w.topProbability != null ? Math.round(w.topProbability * 100) : null,
        url: w.url,
      }));
      collectedSources.watch = ctx.watch;
      return { events };
    },
  };
}

// ---------------------------------------------------------------------------
// Agent system prompt (for tool-calling mode)
// ---------------------------------------------------------------------------

function buildAgentSystemPrompt(type: RecapType): string {
  const isDaily = type === "daily";
  const slideCount = isDaily ? "3" : "4";
  const searchTimeframe = isDaily
    ? "Search for news from the LAST 48 HOURS ONLY (date_from = 2 days ago). Focus on today's session."
    : "Search for news from the LAST 7-10 DAYS to cover the full week.";
  const strategySteps = isDaily
    ? "(1) call get_stored_news for the biggest gainer and loser; (2) call search_news for today's context — use date_from 2 days ago, use language='fr' for .PA stocks; (3) call write_slides."
    : "(1) call get_stored_news for the biggest gainer and loser; (2) call search_news for any holding or macro topic — use language='fr' for .PA stocks; (3) call get_polymarket_events for macro risk signals; (4) call write_slides.";
  const frenchNote = "For .PA (French-listed) stocks, always search in French: 'action {name} ({ticker}) bourse aujourd'hui' (daily) or 'cette semaine' (weekly).";
  return [
    `You are writing a ${slideCount}-slide ${type} portfolio recap for a retail investor. Voice: calm, factual, sharp.`,
    "You have tools to gather narrative context. Use them before writing slides.",
    `Strategy: ${strategySteps}`,
    `TIME FRAME: ${searchTimeframe}`,
    "GROUNDING RULES: Never contradict the FACTS section. Never invent figures, dates, or company-specific news. No prices, %, or currency amounts in slide prose — those render from structured data.",
    frenchNote,
    "write_slides prose only — no numbers. Each slide: 1-4 short sentences.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Public: generate one recap (called by the queue consumer)
// ---------------------------------------------------------------------------

export async function generateRecap(
  env: Env,
  recapId: string,
  macroCache: Map<string, { sources: SlideSource[]; summaries: string[] }> = new Map(),
): Promise<{ status: "ready" | "skipped"; reason?: string }> {
  const client = db(env);
  const { data: row, error } = await client
    .from("recaps")
    .select("id,portfolio_id,user_id,type,period_start,period_end")
    .eq("id", recapId)
    .single();
  if (error || !row) throw new Error(`recap ${recapId} not found: ${error?.message ?? "missing"}`);
  const recap = row as RecapRowLite;

  const ctx = await gatherContext(env, recap, macroCache);
  if (!ctx) {
    await client
      .from("recaps")
      .update({ status: "skipped", error: "insufficient data (need price_history data and holdings)" })
      .eq("id", recapId);
    return { status: "skipped", reason: "insufficient data" };
  }

  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY for recap generation");

  // Sources collected by tool handlers (agent fills these as it searches).
  const collectedSources = {
    mover: [] as SlideSource[],
    moverSummaries: [] as string[],
    macro: ctx.macroPress,       // pre-seeded from gatherContext for fallback
    macroSummaries: ctx.macroPressSummaries,
    watch: ctx.watch,
  };

  // The agentic path with static single-shot fallback. Extracted to a closure
  // so it can run inside a LangSmith run-tree context (withRunTree) — that is
  // what makes the wrapped Gemini calls nest as child spans. The body is
  // unchanged from the un-traced version; tracing is purely additive.
  const runGeneration = async (): Promise<{
    llm: RecapLlmOutput;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    toolCallLog: ToolCallRecord[];
  }> => {
    let llm: RecapLlmOutput;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let toolCallLog: ToolCallRecord[] = [];

    try {
      // --- Agentic path ---
      const handlers = buildAgentToolHandlers(env, client, recap.portfolio_id, ctx, collectedSources);
      const agentResult = await invokeGeminiWithTools(env, {
        system: buildAgentSystemPrompt(ctx.type),
        user: buildUserPrompt(ctx),
        tools: buildAgentTools(ctx.type),
        handlers,
        terminalTool: "write_slides",
        maxIterations: ctx.type === "daily" ? 5 : 6,
      });

      // Extract slides from the write_slides tool call output.
      const rawSlides = agentResult.output.slides;
      if (!Array.isArray(rawSlides)) throw new Error("Agent write_slides did not include slides[]");
      llm = { slides: rawSlides as RecapLlmOutput["slides"] };
      usage = agentResult.usage;
      toolCallLog = agentResult.toolCalls;
      console.log(`[recaps] agentic path: ${toolCallLog.length} tool calls`);
    } catch (err) {
      // --- Fallback: static single-shot path ---
      if (err instanceof MaxIterationsError) {
        toolCallLog = err.toolCalls;
        console.warn(`[recaps] agent hit max iterations (${toolCallLog.length} calls), falling back to static path`);
      } else {
        console.warn(`[recaps] agent error, falling back:`, err instanceof Error ? err.message : err);
      }

      const staticResult = await invokeGeminiStructured(env, {
        system: buildStaticSystemPrompt(ctx.type),
        user: buildUserPrompt(ctx),
        schema: buildLlmSchema(ctx.type),
      });
      llm = parseLlmOutput(staticResult.text);
      usage = staticResult.usage;
    }

    return { llm, usage, toolCallLog };
  };

  // --- LangSmith tracing (additive) ---
  // Create the parent run BEFORE generation so child spans attach. Every
  // LangSmith call is best-effort: a failure logs and degrades to the
  // un-traced path — recap generation must never break because of tracing.
  const lsClient = langsmithClient(env);
  let langsmithRunId: string | null = null;
  let rt: RunTree | null = null;
  if (lsClient) {
    langsmithRunId = crypto.randomUUID();
    rt = new RunTree({
      name: "recap-generation",
      // "chain" (orchestration), not "llm" — avoids token-table rendering
      // artifacts on a span that wraps HTTP + JSON assembly.
      run_type: "chain",
      id: langsmithRunId,
      project_name: env.LANGSMITH_PROJECT ?? "node-recaps",
      client: lsClient,
      tracingEnabled: true,
      inputs: {
        recap_type: recap.type,
        portfolio_id: recap.portfolio_id,
        model: geminiModel(env),
      },
    });
    try {
      await rt.postRun();
    } catch (err) {
      console.error("[recaps] LangSmith postRun failed — continuing untraced:", err);
      rt = null;
      langsmithRunId = null;
    }
  }

  let generated: {
    llm: RecapLlmOutput;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    toolCallLog: ToolCallRecord[];
  };
  try {
    generated = rt ? await withRunTree(rt, runGeneration) : await runGeneration();
  } catch (err) {
    if (rt) {
      try {
        await rt.end(undefined, err instanceof Error ? err.message : String(err));
        await rt.patchRun();
        await lsClient?.flush(); // send the error run before the Worker exits
      } catch (patchErr) {
        console.error("[recaps] LangSmith patchRun/flush (error path) failed:", patchErr);
      }
    }
    throw err; // generation failure is real — let the queue retry / mark failed
  }
  const { llm, usage, toolCallLog } = generated;

  if (rt) {
    try {
      await rt.end({ status: "ready", slides: llm.slides.length });
      await rt.patchRun();
      // CRITICAL on CF Workers: flush the batched run events before the
      // request context tears down. Without this the create + end/outputs
      // never send and the run is left "pending"/"incomplete" with an empty
      // output field.
      await lsClient?.flush();
    } catch (patchErr) {
      console.error("[recaps] LangSmith patchRun/flush failed:", patchErr);
    }
  }

  // Per-slide user feedback lives in Supabase (recap_slide_feedback), correlated
  // to this run via langsmith_run_id. We deliberately do NOT push a recap-level
  // "user_score" to LangSmith: the presigned-token channel appends on every
  // click (re-votes pollute the aggregate) and a single score can't represent
  // per-slide sentiment. A proper idempotent run metric belongs in the eval loop.

  // Merge any sources the agent retrieved into ctx for assembleSlides.
  const mergedCtx: GatheredContext = {
    ...ctx,
    moverPress: collectedSources.mover.length > 0 ? collectedSources.mover : ctx.moverPress,
    moverPressSummaries: collectedSources.moverSummaries.length > 0 ? collectedSources.moverSummaries : ctx.moverPressSummaries,
    macroPress: collectedSources.macro,
    macroPressSummaries: collectedSources.macroSummaries,
    moverNoPress: (collectedSources.mover.length === 0 && ctx.moverPress.length === 0),
  };

  const slides = assembleSlides(mergedCtx, llm);

  await client
    .from("recaps")
    .update({
      status: "ready",
      slides,
      model: geminiModel(env),
      token_usage: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
        tool_calls: toolCallLog.map((t) => ({ tool: t.tool, durationMs: t.durationMs, input: t.input })),
      },
      generated_at: new Date().toISOString(),
      error: null,
      langsmith_run_id: langsmithRunId,
    })
    .eq("id", recapId);

  return { status: "ready" };
}

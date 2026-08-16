import { type SupabaseClient } from "@supabase/supabase-js";
import {
  adminDb,
  assertPortfolioAccess,
  requireAuth,
  requirePortfolioAccess,
} from "./auth";
import {
  buildEtfGeographyResearchPrompt,
  assetTypeWithCachedGeography,
  hasValidFundGeographyAllocation,
  countryFromIsin,
  isFundLikeAsset,
  isValidFundGeographySource,
  normalizeEtfExtraction,
  shouldInferDirectGeographyFromIsin,
  shouldEnqueueGeographyResearchJob,
  type NormalizedGeographyAllocation,
  type GeographySource,
} from "./geography";
import {
  etfConstituentsPromptExtension,
  extractAndNormalizeConstituents,
  upsertEtfConstituents,
} from "./feeds/etf-constituents";
import { runNewsFanout } from "./feeds/news";
import {
  runPolymarketFanout,
  NON_FINANCIAL_RE,
  TAG_IDS,
  isShortTermMarket,
  isNearCertainMarket,
} from "./feeds/polymarket";
import { generateRecap } from "./feeds/recaps";
import { langsmithClient } from "./llm/langsmith";
import type { RecapQueueMessage, RecapType } from "./feeds/recap-types";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_ANON_KEY: string;
  AGENT_RUNS_QUEUE: Queue<AgentRunQueueMessage>;
  SNAPSHOT_QUEUE: Queue<SnapshotQueueMessage>;
  GEOGRAPHY_QUEUE: Queue<GeographyQueueMessage>;
  RECAP_QUEUE: Queue<RecapQueueMessage>;
  GROK_MAIN_API_KEY?: string;
  GROK_SUB_API_KEY?: string;
  GROK_NORMALIZATION_API_KEY?: string;
  GROK_WEB_SEARCH_MODEL?: string;
  GROK_NORMALIZATION_MODEL?: string;
  GROK_NORMALIZATION_EFFORT?: string;
  POLYMARKET_GROK_MODEL?: string;
  POLYMARKET_GROK_REASONING_EFFORT?: string;
  GROK_API_BASE_URL?: string;
  MAIN_AGENT_SYSTEM_PROMPT?: string;
  SUB_AGENT_SYSTEM_PROMPT?: string;
  SUB_AGENT_PLANNING_SYSTEM_PROMPT?: string;
  FRED_API_KEY?: string;
  EXA_SEARCH?: string;
  POLYMARKET_GAMMA_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_BASE_URL?: string;
  // LangSmith tracing for recap generation. Optional — the app behaves
  // identically when unset (no traces, no per-slide feedback pushed back).
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  // Override the LangSmith API base URL (e.g. EU region). Defaults to US.
  LANGSMITH_ENDPOINT?: string;
  // Required for org-scoped API keys (sent as x-tenant-id).
  LANGSMITH_WORKSPACE_ID?: string;
  // Shared secret protecting operator-only routes (debug + scheduled fanout).
  ADMIN_SECRET?: string;
  // Comma-separated list of allowed browser origins for CORS. When unset, falls
  // back to "*" (safe only because the API authenticates via bearer token, not cookies).
  ALLOWED_ORIGINS?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

// Deterministic UUID from a stable input string (SHA-256 → UUID format).
// Used to give LangSmith feedback an idempotent feedbackId: the same
// (run, user, slide) always maps to the same UUID, so re-votes UPSERT the
// feedback instead of appending a new row (the bug that retired the old
// presigned-token channel). Labeled v5 for format validity only — we use
// SHA-256, not SHA-1; only stability matters here, not RFC-4122 derivation.
async function deterministicUuid(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseSymbols(raw: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function normalizeCurrencyCode(value: unknown): string | null {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

// Copy only whitelisted keys from a client-supplied body. Prevents callers from
// setting internal/ownership columns (e.g. user_id) on insert/update.
function pickColumns(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const PORTFOLIO_WRITE_COLUMNS = [
  "name",
  "description",
  "currency",
  "cash_value",
  "primary_exchange",
] as const;

const HOLDING_WRITE_COLUMNS = [
  "name",
  "ticker",
  "isin",
  "portfolio_id",
  "purchase_date",
  "purchase_price",
  "quantity",
  "fees",
  "currency",
  "asset_type",
  "country_code",
  "country_name",
] as const;

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json",
};

async function fetchJson<T>(url: string, options: { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId =
    options.timeoutMs == null
      ? null
      : setTimeout(() => controller.abort("Request timed out"), options.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error(`Yahoo API error (${res.status})`);
  return (await res.json()) as T;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function searchYahooAssets(query: string): Promise<AssetSearchResult[]> {
  const searchUrl = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("quotesCount", "10");
  searchUrl.searchParams.set("newsCount", "0");
  searchUrl.searchParams.set("enableFuzzyQuery", "false");
  searchUrl.searchParams.set("enableEnhancedTrivialQuery", "true");

  const result = await fetchJson<YahooSearchResponse>(searchUrl.toString());
  return (result.quotes || [])
    .filter((quote) => quote.symbol)
    .map((quote) => ({
      ticker: quote.symbol || "",
      name: quote.shortname || quote.longname || quote.symbol || "",
      exchange: quote.exchange || quote.fullExchangeName || "N/A",
      assetType: quote.quoteType || "N/A",
      currency: normalizeCurrencyCode(quote.currency),
    }))
    .slice(0, 10);
}

function yahooExchangeToPrimary(exchange: string | null | undefined, ticker: string | null | undefined): string | null {
  const value = `${exchange ?? ""} ${ticker ?? ""}`.toUpperCase();
  if (/\b(NYQ|NYSE)\b/.test(value)) return "NYSE";
  if (/\b(NMS|NGM|NCM|NASDAQ)\b/.test(value)) return "NASDAQ";
  if (/\b(PAR|EPA|EURONEXT|XPAR)\b/.test(value) || /\.PA\b/.test(value)) return "EURONEXT";
  if (/\b(GER|XETRA|FRA|XETR)\b/.test(value) || /\.DE\b/.test(value)) return "XETRA";
  if (/\b(LSE|LONDON)\b/.test(value) || /\.L\b/.test(value)) return "LSE";
  if (/\b(TYO|TSE|TOKYO)\b/.test(value) || /\.T\b/.test(value)) return "TSE";
  return null;
}

function stripCurrency(raw: string): string {
  return raw.replace(/[^0-9.,-]/g, "").trim();
}

function parseFlexibleNumber(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const value = stripCurrency(String(raw ?? "")).replace(/\s+/g, "");
  if (!value) return 0;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    return Number.parseFloat(value.split(thousandsSeparator).join("").replace(decimalSeparator, ".")) || 0;
  }

  if (lastComma > -1) {
    const parts = value.split(",");
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1) {
      return Number.parseFloat(parts.join("")) || 0;
    }
    return Number.parseFloat(value.replace(",", ".")) || 0;
  }

  return Number.parseFloat(value) || 0;
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeDateString(raw: string): string {
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid transaction date: ${raw}`);
  return toDateString(parsed);
}

function computeDailyTwrByDate(
  snapshots: Array<{ date: string; total_value: number | string | null }>,
  flowByDate: Map<string, number>,
): Map<string, number> {
  let twrIndex = 1;
  let previousTotalValue: number | null = null;
  const twrByDate = new Map<string, number>();

  for (const snap of snapshots) {
    const date = String(snap.date);
    const totalValue = Number(snap.total_value ?? 0);

    if (previousTotalValue == null) {
      previousTotalValue = totalValue;
      twrByDate.set(date, 0);
      continue;
    }

    if (previousTotalValue > 0) {
      const externalFlow = flowByDate.get(date) ?? 0;
      const periodReturn = (totalValue - externalFlow - previousTotalValue) / previousTotalValue;
      if (Number.isFinite(periodReturn)) twrIndex *= 1 + periodReturn;
    }

    previousTotalValue = totalValue;
    twrByDate.set(date, (twrIndex - 1) * 100);
  }

  return twrByDate;
}

function isTransactionSide(value: unknown): value is TransactionSide {
  return value === "BUY" || value === "SELL" || value === "DEP" || value === "WD" || value === "DIV" || value === "FEE";
}

function normalizeTransactionRows(rows: NormalisedTransactionRow[]): NormalisedTransactionRow[] {
  return rows.map((row, index) => {
    const side = String(row.side ?? "").toUpperCase();
    if (!isTransactionSide(side)) throw new Error(`Invalid side on row ${index + 1}`);
    return {
      date: normalizeDateString(String(row.date ?? "")),
      symbol: String(row.symbol || (row.isin ? row.isin : "CASH")).trim() || "CASH",
      isin: row.isin ? String(row.isin).trim().toUpperCase() : null,
      yahoo_ticker: row.yahoo_ticker ? String(row.yahoo_ticker).trim().toUpperCase() : null,
      side,
      quantity: row.quantity ?? null,
      net_amount: row.net_amount ?? null,
      commission: row.commission ?? "0",
    };
  });
}

// Gate for operator-only routes (debug + scheduled fanout). Requires the caller to
// present the shared ADMIN_SECRET via the X-Admin-Secret header. If ADMIN_SECRET is
// not configured, the route is treated as locked (fails closed) rather than open.
function requireAdmin(request: Request, env: Env): Response | null {
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (!env.ADMIN_SECRET || provided !== env.ADMIN_SECRET) {
    return json({ error: "Forbidden" }, 403);
  }
  return null;
}

interface YahooSearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  fullExchangeName?: string;
  quoteType?: string;
  currency?: string | null;
}

interface YahooSearchResponse {
  quotes?: YahooSearchQuote[];
}

interface YahooQuoteItem {
  currentPrice: number | null;
  change1dPercent: number | null;
  currency: string | null;
  sector: string | null;
  assetType: string | null;
  lastPriceUpdatedAt: string | null;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number | null;
        previousClose?: number | null;
        currency?: string | null;
        instrumentType?: string | null;
        quoteType?: string | null;
        regularMarketTime?: number | null;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
  };
}

interface BenchmarkPricePoint {
  date: string;
  close: number;
}

interface BenchmarkSuggestion {
  name: string;
  reason: string;
}

interface ResolvedBenchmarkSuggestion extends BenchmarkSuggestion {
  ticker: string;
}

interface BenchmarkConcept extends BenchmarkSuggestion {
  yahooSearchQueries: string[];
  confidence: number;
  needsWebSearch: boolean;
}

interface BenchmarkSuggestionDiagnostics {
  concepts: number;
  yahooCandidates: number;
  webSearchFallbacks: number;
  resolved: number;
}

interface BenchmarkHoldingPayload {
  id: string;
  ticker: string;
  isin: string | null;
  name: string;
  weight: number;
  sector: string;
  geography: string;
  assetType: string;
  value: number;
}

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: Array<{
      symbol?: string;
      regularMarketPrice?: number | null;
      regularMarketPreviousClose?: number | null;
      regularMarketChangePercent?: number | null;
      currency?: string | null;
      financialCurrency?: string | null;
      quoteType?: string | null;
      typeDisp?: string | null;
      regularMarketTime?: number | null;
    }>;
  };
}

interface YahooQuoteSummaryResponse {
  quoteSummary?: {
    result?: Array<{
      summaryProfile?: {
        sector?: string;
        country?: string;
      };
      assetProfile?: {
        sector?: string;
        country?: string;
      };
      fundProfile?: {
        categoryName?: string;
        fundFamily?: string;
      };
    }>;
  };
}

type AgentRunTriggerType = "scheduled" | "ondemand";
type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "failed_validation";

interface AgentRunQueueMessage {
  runId: string;
  userId: string;
  portfolioId: string;
  triggerType: AgentRunTriggerType;
}

interface SnapshotQueueMessage {
  type: "full_rebuild" | "daily_update";
  portfolio_id: string;
}

interface GeographyQueueMessage {
  type: "geography_research";
  portfolio_id: string;
  holding_id?: string;
  holding_ids?: string[];
  reason?: "holding_change" | "transaction_import" | "snapshot_rebuild" | "manual_retry" | "monthly_refresh";
}

type WorkerQueueMessage =
  | AgentRunQueueMessage
  | SnapshotQueueMessage
  | GeographyQueueMessage
  | RecapQueueMessage;

const STALE_GEOGRAPHY_RUNNING_JOB_MS = 15 * 60 * 1000;

type TransactionSide = "BUY" | "SELL" | "DEP" | "WD" | "DIV" | "FEE";

interface NormalisedTransactionRow {
  date: string;
  symbol: string;
  isin: string | null;
  yahoo_ticker?: string | null;
  side: TransactionSide;
  quantity: string | number | null;
  net_amount: string | number | null;
  commission?: string | number | null;
}

interface TransactionRow {
  id?: string;
  portfolio_id: string;
  date: string;
  symbol: string;
  isin: string | null;
  yahoo_ticker: string | null;
  side: TransactionSide;
  quantity: number | null;
  net_amount: number | null;
  commission: number;
}

interface AssetSearchResult {
  ticker: string;
  name: string;
  exchange: string;
  assetType: string;
  currency: string | null;
}

type AgentToolName =
  | "portfolio_context"
  | "market_quotes"
  | "get_ecb_data"
  | "get_fred_indicator"
  | "search_news";

interface AgentToolCall {
  tool: AgentToolName;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
}

interface AgentRunRow {
  id: string;
  user_id: string;
  portfolio_id: string | null;
  trigger_type: AgentRunTriggerType;
  status: AgentRunStatus;
  idempotency_key: string;
  scope_hash: string;
  model_main: string | null;
  model_sub: string | null;
  token_usage: Record<string, unknown>;
  error_code: string | null;
  error_detail: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PortfolioContextResult {
  portfolioId: string;
  holdings: Array<{
    ticker: string;
    name: string;
    quantity: number;
  }>;
  theses: Array<{
    id: string;
    title: string;
    summary: string;
    body: unknown;
    evidence: unknown;
    horizon: string;
    conviction: "low" | "med" | "high";
    tickers: string[];
    status: string;
  }>;
}

interface MarketQuotesResult {
  tickers: string[];
  quotes: Array<{
    ticker: string;
    currentPrice: number | null;
    change1dPercent: number | null;
    ytdChangePercent: number | null;
    sector: string;
    assetType: string | null;
    lastPriceUpdatedAt: string | null;
  }>;
}

interface EcbDataResult {
  dataset: string;
  observations: Array<{
    period: string;
    value: string;
  }>;
}

interface FredIndicatorResult {
  series_id: string;
  observations: Array<{
    date: string;
    value: string;
  }>;
}

interface NewsSearchResult {
  query: string;
  items: Array<{
    title: string;
    url: string;
    source: string;
    snippet: string;
    published_at: string | null;
    is_stale: boolean;
  }>;
  provider: "xai_web_search" | "google_rss_fallback";
  recencyDays: number;
  totalRetrieved: number;
}

interface HoldingGeographyRow {
  id: string;
  ticker: string;
  name: string;
  isin: string | null;
  asset_type: string | null;
  quantity: number;
  purchase_price: number;
  fees: number;
}

interface GuardrailState {
  startedMs: number;
  totalCalls: number;
  callsByTool: Record<AgentToolName, number>;
  maxTotalCalls: number;
  perToolLimit: number;
  maxDurationMs: number;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

interface AgentRunMetricsSummary {
  window_hours: number;
  from_iso: string;
  total_runs: number;
  counts_by_status: Record<string, number>;
  counts_by_trigger: Record<string, number>;
  queue_depth: number;
  success_rate: number | null;
  duration_ms: {
    samples: number;
    avg: number | null;
    p50: number | null;
    p95: number | null;
  };
  failures_with_error_code: Record<string, number>;
}

function summarizeRunMetrics(
  rows: Array<{
    status: string | null;
    trigger_type: string | null;
    started_at: string | null;
    finished_at: string | null;
    error_code: string | null;
  }>,
  options: { hours: number; fromIso: string },
): AgentRunMetricsSummary {
  const countsByStatus = rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? "unknown");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const countsByTrigger = rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.trigger_type ?? "unknown");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const durationsMs = rows
    .map((row) => {
      if (!row.started_at || !row.finished_at) return null;
      const ms = new Date(row.finished_at).getTime() - new Date(row.started_at).getTime();
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    })
    .filter((ms): ms is number => ms != null);
  const completed = countsByStatus.completed ?? 0;
  const failed = countsByStatus.failed ?? 0;
  const successRate = completed + failed > 0 ? completed / (completed + failed) : null;

  return {
    window_hours: options.hours,
    from_iso: options.fromIso,
    total_runs: rows.length,
    counts_by_status: countsByStatus,
    counts_by_trigger: countsByTrigger,
    queue_depth: (countsByStatus.queued ?? 0) + (countsByStatus.running ?? 0),
    success_rate: successRate,
    duration_ms: {
      samples: durationsMs.length,
      avg:
        durationsMs.length > 0
          ? Math.round(durationsMs.reduce((sum, ms) => sum + ms, 0) / durationsMs.length)
          : null,
      p50: percentile(durationsMs, 50),
      p95: percentile(durationsMs, 95),
    },
    failures_with_error_code: rows
      .filter((row) => row.status === "failed")
      .reduce<Record<string, number>>((acc, row) => {
        const key = String(row.error_code ?? "UNKNOWN");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
  };
}

function classifyQueueProcessingError(error: unknown): {
  retryable: boolean;
  errorCode: string;
  failureClass: string;
  detail: string;
  statusOverride?: "failed_validation" | "failed";
} {
  const detail = error instanceof Error ? error.message : "Unknown queue processing error";
  if (detail.includes("Model output is not valid JSON")) {
    return {
      retryable: false,
      errorCode: "MODEL_OUTPUT_INVALID_JSON",
      failureClass: "validation",
      detail,
      statusOverride: "failed_validation",
    };
  }
  if (detail.includes("Model output missing required items")) {
    return {
      retryable: false,
      errorCode: "MODEL_OUTPUT_EMPTY",
      failureClass: "validation",
      detail,
      statusOverride: "failed_validation",
    };
  }
  if (detail.includes("Grok API error (4")) {
    return {
      retryable: false,
      errorCode: "UPSTREAM_GROK_4XX",
      failureClass: "upstream_permanent",
      detail,
    };
  }
  if (detail.includes("Grok API error (5")) {
    return {
      retryable: true,
      errorCode: "UPSTREAM_GROK_5XX",
      failureClass: "upstream_transient",
      detail,
    };
  }
  if (detail.includes("Missing ") || detail.includes("Server misconfiguration")) {
    return {
      retryable: false,
      errorCode: "CONFIGURATION_ERROR",
      failureClass: "configuration",
      detail,
    };
  }
  if (detail.includes("Guardrail:")) {
    return {
      retryable: false,
      errorCode: "GUARDRAIL_LIMIT_HIT",
      failureClass: "guardrail",
      detail,
    };
  }
  if (detail.includes("Yahoo API error (429")) {
    return {
      retryable: true,
      errorCode: "UPSTREAM_YAHOO_429",
      failureClass: "upstream_transient",
      detail,
    };
  }
  return {
    retryable: true,
    errorCode: "QUEUE_PROCESSING_ERROR",
    failureClass: "unknown",
    detail,
  };
}

interface SubAgentOutput {
  evidence_items: Array<{
    id: string;
    thesis_id: string;
    claim: string;
    snippet: string;
    url: string;
    source: string;
    published_at: string | null;
    is_stale: boolean;
    staleness_reason: string | null;
    relevance_score: number;
    tags: string[];
  }>;
  missing_info: string[];
  retrieval_meta: {
    query: string;
    provider: "xai_web_search" | "google_rss_fallback";
    recency_days: number;
    total_retrieved: number;
    total_kept: number;
    total_stale: number;
  };
}

interface SubAgentPlanningOutput {
  classifications: Array<{
    thesis_id: string;
    established_facts: string[];
    claims_to_verify: string[];
    signals_to_monitor: string[];
    etf_underlying: string | null;
  }>;
  search_queries: Array<{
    thesis_id: string;
    query: string;
  }>;
  raw_search_queries?: Array<{
    thesis_id: string;
    query: string;
  }>;
}

interface MainAgentOutput {
  signals: Array<{
    thesis_id: string;
    signal_type: "at_risk" | "supportive" | "watch" | "neutral";
    title: string;
    explanation: string;
    risk_horizon: "short_term" | "long_term" | null;
    confidence: number;
    evidence_ids: string[];
    assumptions: string[];
    no_evidence_reason: string | null;
    change_type: "new_information" | "confirmation" | "contradiction" | "no_material_change";
    delta_summary: string | null;
  }>;
  overall_summary: string;
  questions_for_user: string[];
}

function normalizeSubAgentPlanningOutput(raw: Record<string, unknown>): SubAgentPlanningOutput {
  const classificationsRaw = Array.isArray(raw.classifications) ? raw.classifications : [];
  const searchQueriesRaw = Array.isArray(raw.search_queries) ? raw.search_queries : [];
  return {
    classifications: classificationsRaw
      .map((item) => {
        const row = item as Record<string, unknown>;
        const thesisId = String(row.thesis_id ?? "");
        if (!thesisId) return null;
        return {
          thesis_id: thesisId,
          established_facts: Array.isArray(row.established_facts)
            ? row.established_facts.map((value) => String(value))
            : [],
          claims_to_verify: Array.isArray(row.claims_to_verify)
            ? row.claims_to_verify.map((value) => String(value))
            : [],
          signals_to_monitor: Array.isArray(row.signals_to_monitor)
            ? row.signals_to_monitor.map((value) => String(value))
            : [],
          etf_underlying: row.etf_underlying == null ? null : String(row.etf_underlying),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item),
    search_queries: searchQueriesRaw
      .map((item) => {
        if (typeof item === "string") {
          return { thesis_id: "", query: item };
        }
        const row = item as Record<string, unknown>;
        return {
          thesis_id: String(row.thesis_id ?? ""),
          query: String(row.query ?? ""),
        };
      })
      .filter((item) => Boolean(item.query))
      .slice(0, 8),
  };
}

function toConceptQuery(input: { title: string; summary: string; tickers: string[] }): string {
  const base = `${input.title} ${input.summary}`
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = base
    .split(" ")
    .filter((word) => word.length > 2 && !/^[A-Z]{1,5}(\.[A-Z]{1,3})?$/.test(word))
    .slice(0, 12);
  if (words.length > 0) return words.join(" ");
  return input.tickers.slice(0, 3).join(" ");
}

interface GrokChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
    };
  }>;
}

function normalizeSectorLabel(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  if (!cleaned) return null;
  if (cleaned.toLowerCase() === "n/a") return null;
  return cleaned;
}

async function getSectorsForSymbols(symbols: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const url = new URL(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}`);
        url.searchParams.set("modules", "summaryProfile,assetProfile,fundProfile");
        const summary = await fetchJson<YahooQuoteSummaryResponse>(url.toString());
        const profile = summary.quoteSummary?.result?.[0];
        const sector =
          normalizeSectorLabel(profile?.summaryProfile?.sector) ??
          normalizeSectorLabel(profile?.assetProfile?.sector) ??
          normalizeSectorLabel(profile?.fundProfile?.categoryName) ??
          normalizeSectorLabel(profile?.fundProfile?.fundFamily);
        if (!sector) return [symbol, "Other"] as const;
        return [symbol, sector] as const;
      } catch {
        return [symbol, "Other"] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

async function researchEtfGeography(
  env: Env,
  holding: HoldingGeographyRow,
): Promise<{
  allocations: NormalizedGeographyAllocation[];
  source: GeographySource;
  confidence: number;
  evidence: Record<string, unknown>;
}> {
  if (!env.GROK_SUB_API_KEY) {
    throw new Error("Missing GROK_SUB_API_KEY");
  }

  const raw = await withTimeout(
    invokeGrokWebGeographyResearch(env, holding),
    60_000,
    `ETF geography web research for ${holding.ticker}`,
  );
  const rawJson = extractJsonObject(raw.outputText);
  const normalized = normalizeEtfExtraction(rawJson);
  const webSearchModel = env.GROK_WEB_SEARCH_MODEL || "grok-4-1-fast-reasoning";

  // Side-effect: populate central ETF constituents registry (fire-and-forget)
  if (holding.isin) {
    const constituentsData = extractAndNormalizeConstituents(rawJson, {
      responseId: raw.responseId,
      webSearchModel,
    });
    if (constituentsData) {
      void upsertEtfConstituents(adminDb(env), holding.isin, constituentsData).catch((err: unknown) => {
        console.error(`[etf-constituents] side-effect upsert failed for ${holding.isin}:`, err);
      });
    }
  }

  return {
    allocations: normalized.allocations,
    source: normalized.allocations.length > 0 ? "llm_web" : "unknown",
    confidence: normalized.confidence,
    evidence: {
      ...normalized.evidence,
      responseId: raw.responseId,
      webSearchModel,
      citations: raw.citations,
    },
  };
}

async function invokeGrokWebGeographyResearch(
  env: Env,
  holding: HoldingGeographyRow,
): Promise<{ outputText: string; responseId: string | null; citations: unknown[] }> {
  const prompt =
    buildEtfGeographyResearchPrompt({
      ticker: holding.ticker,
      name: holding.name,
      isin: holding.isin,
      assetType: holding.asset_type,
    }) + etfConstituentsPromptExtension();
  const body = {
    model: env.GROK_WEB_SEARCH_MODEL || "grok-4-1-fast-reasoning",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are a careful ETF geography and constituents research agent. Use web search to find actual country allocation and top holdings. Return strict JSON only.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    tools: [{ type: "web_search" }],
  };
  const res = await fetch(`${getGrokBaseUrl(env)}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROK_SUB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ETF geography web research failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const outputText = outputTextFromResponse(raw);
  if (!outputText) throw new Error("ETF geography web research returned no output text");
  return {
    outputText,
    responseId: typeof raw.id === "string" ? raw.id : null,
    citations: Array.isArray(raw.citations) ? raw.citations : [],
  };
}

function resolveFastHoldingGeography(
  holding: HoldingGeographyRow,
): {
  allocations: NormalizedGeographyAllocation[];
  source: GeographySource;
  confidence: number;
  evidence: Record<string, unknown>;
  preservesCachedResearch: boolean;
} {
  if (!shouldInferDirectGeographyFromIsin(holding.asset_type, holding.name, holding.ticker)) {
    return {
      allocations: [],
      source: "unknown",
      confidence: 0,
      evidence: { reason: "ETF/fund research is not run during fast refresh" },
      preservesCachedResearch: true,
    };
  }

  const fromIsin = countryFromIsin(holding.isin);
  if (!fromIsin) {
    return {
      allocations: [],
      source: "unknown",
      confidence: 0,
      evidence: { reason: "No country match from ISIN prefix", isin: holding.isin },
      preservesCachedResearch: false,
    };
  }

  return {
    allocations: [{ countryCode: fromIsin.code, countryName: fromIsin.name, weightPct: 100 }],
    source: "isin",
    confidence: 0.95,
    evidence: { isin: holding.isin },
    preservesCachedResearch: false,
  };
}

async function runGeographyMonthlyRefresh(env: Env): Promise<void> {
  const { data, error } = await adminDb(env).from("portfolios").select("id");
  if (error) throw new Error(`monthly geography refresh portfolio lookup failed: ${error.message}`);
  const portfolioIds = (data ?? []).map((r) => String(r.id));
  await Promise.all(
    portfolioIds.map((portfolioId) =>
      enqueuePendingGeographyResearch(env, portfolioId, "monthly_refresh", {
        force: true,
        includeResearched: true,
      }).catch((err) => console.error(`monthly geography refresh failed for ${portfolioId}:`, err)),
    ),
  );
}

async function recomputePortfolioGeography(env: Env, portfolioId: string): Promise<{
  checked: number;
  resolved: number;
  unresolved: number;
  pendingResearch: number;
}> {
  const client = adminDb(env);
  const { data, error } = await client
    .from("holdings")
    .select("id,ticker,name,isin,asset_type,quantity,purchase_price,fees")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(`geography holdings lookup failed: ${error.message}`);

  const holdings = (data ?? []).map((row) => ({
    id: String(row.id),
    ticker: String(row.ticker).toUpperCase(),
    name: String(row.name ?? row.ticker),
    isin: row.isin == null ? null : String(row.isin).toUpperCase(),
    asset_type: row.asset_type == null ? null : String(row.asset_type),
    quantity: Number(row.quantity ?? 0),
    purchase_price: Number(row.purchase_price ?? 0),
    fees: Number(row.fees ?? 0),
  }));
  const holdingIds = holdings.map((holding) => holding.id);
  const { data: existingAllocations, error: existingAllocationsError } =
    holdingIds.length === 0
      ? { data: [], error: null }
      : await client
          .from("holding_geography_allocations")
          .select("holding_id,source")
          .in("holding_id", holdingIds);
  if (existingAllocationsError) {
    throw new Error(`geography existing allocations lookup failed: ${existingAllocationsError.message}`);
  }

  const allocationSourcesByHolding = new Map<string, string[]>();
  for (const allocation of existingAllocations ?? []) {
    const holdingId = String(allocation.holding_id);
    const sources = allocationSourcesByHolding.get(holdingId) ?? [];
    sources.push(String(allocation.source ?? "unknown"));
    allocationSourcesByHolding.set(holdingId, sources);
  }

  let resolved = 0;
  let pendingResearch = 0;
  const staleHoldingIds: string[] = [];
  const invalidFundLikeHoldingIds: string[] = [];
  const allocationRows: Array<{
    holding_id: string;
    portfolio_id: string;
    country_code: string;
    country_name: string;
    weight_pct: number;
    source: GeographySource;
    confidence: number;
    evidence: Record<string, unknown>;
  }> = [];

  for (const holding of holdings) {
    const isDirectIsinCandidate = shouldInferDirectGeographyFromIsin(
      holding.asset_type,
      holding.name,
      holding.ticker,
    );
    if (!isDirectIsinCandidate) {
      const existingSources = allocationSourcesByHolding.get(holding.id) ?? [];
      if (hasValidFundGeographyAllocation(existingSources)) {
        resolved += 1;
        continue;
      }

      pendingResearch += 1;
      invalidFundLikeHoldingIds.push(holding.id);
      await client
        .from("holdings")
        .update({
          country_code: null,
          country_name: null,
          geography_source: "unknown",
          geography_confidence: 0,
          geography_checked_at: new Date().toISOString(),
        })
        .eq("id", holding.id);
      continue;
    }

    const result = resolveFastHoldingGeography(holding);
    const primary = result.allocations[0] ?? null;
    if (result.allocations.length > 0) resolved += 1;

    if (result.preservesCachedResearch) {
      pendingResearch += 1;
      continue;
    }

    staleHoldingIds.push(holding.id);

    await client
      .from("holdings")
      .update({
        country_code: primary?.countryCode ?? null,
        country_name: primary?.countryName ?? null,
        geography_source: result.source,
        geography_confidence: result.confidence,
        geography_checked_at: new Date().toISOString(),
      })
      .eq("id", holding.id);

    allocationRows.push(
      ...result.allocations.map((allocation) => ({
        holding_id: holding.id,
        portfolio_id: portfolioId,
        country_code: allocation.countryCode,
        country_name: allocation.countryName,
        weight_pct: allocation.weightPct,
        source: result.source,
        confidence: result.confidence,
        evidence: result.evidence,
      })),
    );
  }

  if (staleHoldingIds.length > 0) {
    await client.from("holding_geography_allocations").delete().in("holding_id", staleHoldingIds);
  }
  if (invalidFundLikeHoldingIds.length > 0) {
    await client
      .from("holding_geography_allocations")
      .delete()
      .in("holding_id", invalidFundLikeHoldingIds)
      .neq("source", "llm_web");
  }
  if (allocationRows.length > 0) {
    const { error: insertError } = await client.from("holding_geography_allocations").insert(allocationRows);
    if (insertError) throw new Error(`geography allocation insert failed: ${insertError.message}`);
  }

  return {
    checked: holdings.length,
    resolved,
    unresolved: holdings.length - resolved,
    pendingResearch,
  };
}

async function pendingFundLikeHoldingIds(
  env: Env,
  portfolioId: string,
  options: { includeResearched?: boolean } = {},
): Promise<string[]> {
  const client = adminDb(env);
  const { data, error } = await client
    .from("holdings")
    .select("id,ticker,name,asset_type")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(`pending geography holdings lookup failed: ${error.message}`);

  const fundHoldings = (data ?? [])
    .map((row) => ({
      id: String(row.id),
      ticker: String(row.ticker ?? ""),
      name: String(row.name ?? row.ticker ?? ""),
      asset_type: row.asset_type == null ? null : String(row.asset_type),
    }))
    .filter((holding) => isFundLikeAsset(holding.asset_type, holding.name, holding.ticker));
  if (fundHoldings.length === 0) return [];

  if (options.includeResearched) return fundHoldings.map((holding) => holding.id);

  const holdingIds = fundHoldings.map((holding) => holding.id);
  const { data: allocations, error: allocationsError } = await client
    .from("holding_geography_allocations")
    .select("holding_id,source")
    .in("holding_id", holdingIds);
  if (allocationsError) throw new Error(`pending geography allocations lookup failed: ${allocationsError.message}`);

  const coveredHoldingIds = new Set(
    (allocations ?? [])
      .filter((allocation) => isValidFundGeographySource(String(allocation.source ?? "unknown")))
      .map((allocation) => String(allocation.holding_id)),
  );
  return fundHoldings
    .filter((holding) => !coveredHoldingIds.has(holding.id))
    .map((holding) => holding.id);
}

async function enqueuePendingGeographyResearch(
  env: Env,
  portfolioId: string,
  reason: GeographyQueueMessage["reason"],
  options: { force?: boolean; includeResearched?: boolean } = {},
): Promise<{ queued: boolean; pendingResearchCount: number; holdingIds: string[]; sentHoldingIds: string[] }> {
  const client = adminDb(env);
  const holdingIds = await pendingFundLikeHoldingIds(env, portfolioId, {
    includeResearched: options.includeResearched,
  });
  if (holdingIds.length === 0) {
    return { queued: false, pendingResearchCount: 0, holdingIds, sentHoldingIds: [] };
  }

  const nowDate = new Date();
  const { data: existingJobs, error: existingJobsError } = await client
    .from("geography_research_jobs")
    .select("holding_id,status,started_at,updated_at")
    .in("holding_id", holdingIds);
  if (existingJobsError) throw new Error(`geography jobs lookup failed: ${existingJobsError.message}`);

  const jobsByHolding = new Map(
    (existingJobs ?? []).map((job) => [
      String(job.holding_id),
      {
        status: String(job.status ?? ""),
        startedAt: job.started_at == null ? null : String(job.started_at),
        updatedAt: job.updated_at == null ? null : String(job.updated_at),
      },
    ]),
  );

  const holdingIdsToQueue = holdingIds.filter((holdingId) => {
    const job = jobsByHolding.get(holdingId);
    return shouldEnqueueGeographyResearchJob(job, {
      force: options.force,
      now: nowDate,
      staleMs: STALE_GEOGRAPHY_RUNNING_JOB_MS,
    });
  });

  if (holdingIdsToQueue.length === 0) {
    return { queued: false, pendingResearchCount: holdingIds.length, holdingIds, sentHoldingIds: [] };
  }

  if (!env.GEOGRAPHY_QUEUE) {
    console.warn(`GEOGRAPHY_QUEUE binding missing; ${holdingIdsToQueue.length} geography research jobs not queued`);
    return { queued: false, pendingResearchCount: holdingIds.length, holdingIds, sentHoldingIds: [] };
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await client.from("geography_research_jobs").upsert(
    holdingIdsToQueue.map((holdingId) => ({
      holding_id: holdingId,
      portfolio_id: portfolioId,
      status: "queued",
      reason,
      last_error: null,
      started_at: null,
      finished_at: null,
      updated_at: now,
    })),
    { onConflict: "holding_id" },
  );
  if (upsertError) throw new Error(`geography job enqueue failed: ${upsertError.message}`);

  await Promise.all(
    holdingIdsToQueue.map((holdingId) =>
      env.GEOGRAPHY_QUEUE.send({
        type: "geography_research",
        portfolio_id: portfolioId,
        holding_id: holdingId,
        reason,
      }),
    ),
  );
  return {
    queued: holdingIdsToQueue.length > 0,
    pendingResearchCount: holdingIds.length,
    holdingIds,
    sentHoldingIds: holdingIdsToQueue,
  };
}

async function syncAndEnqueueGeography(
  env: Env,
  portfolioId: string,
  reason: GeographyQueueMessage["reason"],
): Promise<{
  checked: number;
  resolved: number;
  unresolved: number;
  pendingResearch: number;
  researchQueued: boolean;
  queuedHoldingIds: string[];
}> {
  const result = await recomputePortfolioGeography(env, portfolioId);
  const queued = await enqueuePendingGeographyResearch(env, portfolioId, reason);
  return {
    ...result,
    pendingResearch: queued.pendingResearchCount,
    researchQueued: queued.queued,
    queuedHoldingIds: queued.sentHoldingIds,
  };
}

async function refreshMissingFundLikeAssetTypes(env: Env, portfolioId: string): Promise<{ updated: number }> {
  const client = adminDb(env);
  const { data: holdings, error: holdingsError } = await client
    .from("holdings")
    .select("id,ticker,name,asset_type")
    .eq("portfolio_id", portfolioId);
  if (holdingsError) throw new Error(`geography repair holdings lookup failed: ${holdingsError.message}`);

  const holdingRows = (holdings ?? []).map((row) => ({
    id: String(row.id),
    ticker: String(row.ticker ?? "").trim().toUpperCase(),
    name: String(row.name ?? row.ticker ?? ""),
    assetType: row.asset_type == null ? null : String(row.asset_type),
  }));
  const holdingIds = holdingRows.map((holding) => holding.id);
  if (holdingIds.length === 0) return { updated: 0 };

  const { data: allocations, error: allocationsError } = await client
    .from("holding_geography_allocations")
    .select("holding_id,source")
    .in("holding_id", holdingIds);
  if (allocationsError) throw new Error(`geography repair allocation lookup failed: ${allocationsError.message}`);

  const coveredHoldingIds = new Set(
    (allocations ?? [])
      .filter((allocation) => isValidFundGeographySource(String(allocation.source ?? "unknown")))
      .map((allocation) => String(allocation.holding_id)),
  );
  const unresolvedTickers = Array.from(
    new Set(
      holdingRows
        .filter((holding) => !coveredHoldingIds.has(holding.id))
        .filter((holding) => !isFundLikeAsset(holding.assetType, holding.name, holding.ticker))
        .map((holding) => holding.ticker)
        .filter(Boolean),
    ),
  );
  if (unresolvedTickers.length === 0) return { updated: 0 };

  const { typeByTicker } = await getAssetMetadataFromBatch(unresolvedTickers).catch((error) => {
    console.error("geography repair asset metadata refresh failed", error);
    return { typeByTicker: new Map<string, string>(), currencyByTicker: new Map<string, string>() };
  });
  const updates = holdingRows
    .map((holding) => ({
      id: holding.id,
      assetType: typeByTicker.get(holding.ticker),
    }))
    .filter((holding): holding is { id: string; assetType: string } => isFundLikeAsset(holding.assetType));

  await Promise.all(
    updates.map(async (holding) => {
      const { error } = await client.from("holdings").update({ asset_type: holding.assetType }).eq("id", holding.id);
      if (error) throw new Error(`geography repair asset type update failed: ${error.message}`);
    }),
  );

  return { updated: updates.length };
}

async function repairPortfolioGeography(env: Env, portfolioId: string): Promise<{
  checked: number;
  resolved: number;
  unresolved: number;
  pendingResearch: number;
  researchQueued: boolean;
  queuedHoldingIds: string[];
  repairedAssetTypes: number;
}> {
  const assetTypeRepair = await refreshMissingFundLikeAssetTypes(env, portfolioId);
  const result = await recomputePortfolioGeography(env, portfolioId);
  const queued = await enqueuePendingGeographyResearch(env, portfolioId, "manual_retry", { force: true });
  return {
    ...result,
    pendingResearch: queued.pendingResearchCount,
    researchQueued: queued.queued,
    queuedHoldingIds: queued.sentHoldingIds,
    repairedAssetTypes: assetTypeRepair.updated,
  };
}

async function markGeographyJobRunning(
  client: ReturnType<typeof adminDb>,
  input: { portfolioId: string; holdingId: string; reason?: GeographyQueueMessage["reason"] },
): Promise<void> {
  const { data: existingJob, error: existingJobError } = await client
    .from("geography_research_jobs")
    .select("attempts")
    .eq("holding_id", input.holdingId)
    .maybeSingle();
  if (existingJobError) throw new Error(`geography job lookup failed: ${existingJobError.message}`);

  const now = new Date().toISOString();
  const { error } = await client.from("geography_research_jobs").upsert(
    {
      holding_id: input.holdingId,
      portfolio_id: input.portfolioId,
      status: "running",
      reason: input.reason ?? null,
      attempts: Number(existingJob?.attempts ?? 0) + 1,
      last_error: null,
      started_at: now,
      finished_at: null,
      updated_at: now,
    },
    { onConflict: "holding_id" },
  );
  if (error) throw new Error(`geography job running update failed: ${error.message}`);
}

async function markGeographyJobCompleted(
  client: ReturnType<typeof adminDb>,
  holdingId: string,
  options: { lastError?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client
    .from("geography_research_jobs")
    .update({
      status: "completed",
      last_error: options.lastError ?? null,
      finished_at: now,
      updated_at: now,
    })
    .eq("holding_id", holdingId);
  if (error) throw new Error(`geography job completion update failed: ${error.message}`);
}

async function markGeographyJobsFailed(
  env: Env,
  portfolioId: string,
  holdingIds: string[],
  error: unknown,
): Promise<void> {
  if (holdingIds.length === 0) return;
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : "Geography research failed";
  const { error: updateError } = await adminDb(env)
    .from("geography_research_jobs")
    .update({
      status: "failed",
      last_error: message,
      finished_at: now,
      updated_at: now,
    })
    .eq("portfolio_id", portfolioId)
    .in("holding_id", holdingIds);
  if (updateError) console.error("geography job failure update failed", updateError);
}

function completedUnknownGeographyReason(result: {
  evidence: Record<string, unknown>;
  confidence: number;
}): string {
  const diagnostics = result.evidence.normalizationDiagnostics as
    | {
        reason?: unknown;
        invalidCountryLabels?: unknown;
        acceptedWeightTotal?: unknown;
        rejectedWeightTotal?: unknown;
        confidence?: unknown;
      }
    | undefined;
  const reason =
    typeof diagnostics?.reason === "string" && diagnostics.reason.trim()
      ? diagnostics.reason.trim()
      : "No reliable country allocation returned by ETF research.";
  const invalidCountryLabels = Array.isArray(diagnostics?.invalidCountryLabels)
    ? diagnostics.invalidCountryLabels
        .map((label) => String(label))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const acceptedWeightTotal = Number(diagnostics?.acceptedWeightTotal ?? NaN);
  const rejectedWeightTotal = Number(diagnostics?.rejectedWeightTotal ?? NaN);
  const notes = typeof result.evidence.notes === "string" ? result.evidence.notes.trim() : "";
  const parts = [reason];
  if (Number.isFinite(acceptedWeightTotal)) parts.push(`accepted ${acceptedWeightTotal.toFixed(1)}%`);
  if (Number.isFinite(rejectedWeightTotal) && rejectedWeightTotal > 0) {
    parts.push(`rejected ${rejectedWeightTotal.toFixed(1)}%`);
  }
  if (invalidCountryLabels.length > 0) parts.push(`invalid: ${invalidCountryLabels.join(", ")}`);
  parts.push(`confidence ${result.confidence.toFixed(2)}`);
  if (notes) parts.push(notes.slice(0, 180));
  return parts.join(" · ");
}

async function researchPortfolioEtfGeography(
  env: Env,
  portfolioId: string,
  options: { holdingIds?: string[]; onlyPending?: boolean; reason?: GeographyQueueMessage["reason"] } = {},
): Promise<{ checked: number; resolved: number; unresolved: number }> {
  const client = adminDb(env);
  const { data, error } = await client
    .from("holdings")
    .select("id,ticker,name,isin,asset_type,quantity,purchase_price,fees")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(`ETF geography holdings lookup failed: ${error.message}`);

  const requestedHoldingIds = new Set((options.holdingIds ?? []).map(String));
  const holdings = (data ?? [])
    .map((row) => ({
      id: String(row.id),
      ticker: String(row.ticker).toUpperCase(),
      name: String(row.name ?? row.ticker),
      isin: row.isin == null ? null : String(row.isin).toUpperCase(),
      asset_type: row.asset_type == null ? null : String(row.asset_type),
      quantity: Number(row.quantity ?? 0),
      purchase_price: Number(row.purchase_price ?? 0),
      fees: Number(row.fees ?? 0),
    }))
    .filter((holding) => isFundLikeAsset(holding.asset_type, holding.name, holding.ticker))
    .filter((holding) => requestedHoldingIds.size === 0 || requestedHoldingIds.has(holding.id));

  const holdingIds = holdings.map((holding) => holding.id);
  const { data: allocationsData, error: allocationsError } =
    holdingIds.length === 0
      ? { data: [], error: null }
      : await client
          .from("holding_geography_allocations")
          .select("holding_id,source,updated_at")
          .in("holding_id", holdingIds);
  if (allocationsError) throw new Error(`ETF geography allocations lookup failed: ${allocationsError.message}`);

  const allocationsByHolding = new Map<string, Array<Record<string, unknown>>>();
  for (const allocation of allocationsData ?? []) {
    const holdingId = String(allocation.holding_id);
    const current = allocationsByHolding.get(holdingId) ?? [];
    current.push(allocation as Record<string, unknown>);
    allocationsByHolding.set(holdingId, current);
  }

  if (options.onlyPending) {
    const alreadyCoveredHoldings = holdings.filter(
      (holding) => (allocationsByHolding.get(holding.id) ?? []).length > 0,
    );
    await Promise.all(alreadyCoveredHoldings.map((holding) => markGeographyJobCompleted(client, holding.id)));
  }

  const holdingsToResearch = holdings
    .filter((holding) => !options.onlyPending || (allocationsByHolding.get(holding.id) ?? []).length === 0)
    .sort((a, b) => {
      const aPending = (allocationsByHolding.get(a.id) ?? []).length === 0 ? 0 : 1;
      const bPending = (allocationsByHolding.get(b.id) ?? []).length === 0 ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return a.ticker.localeCompare(b.ticker);
    });

  let resolved = 0;
  const now = new Date().toISOString();
  for (const holding of holdingsToResearch) {
    await markGeographyJobRunning(client, {
      portfolioId,
      holdingId: holding.id,
      reason: options.reason,
    });
    try {
      const result = await withTimeout(
        researchEtfGeography(env, holding),
        75_000,
        `ETF geography research for ${holding.ticker}`,
      );
      const primary = result.allocations[0] ?? null;
      if (result.allocations.length > 0) resolved += 1;

      await client
        .from("holdings")
        .update({
          country_code: primary?.countryCode ?? null,
          country_name: primary?.countryName ?? null,
          geography_source: result.source,
          geography_confidence: result.confidence,
          geography_checked_at: now,
        })
        .eq("id", holding.id);
      await client.from("holding_geography_allocations").delete().eq("holding_id", holding.id);

      if (result.allocations.length > 0) {
        const { error: insertError } = await client.from("holding_geography_allocations").insert(
          result.allocations.map((allocation) => ({
            holding_id: holding.id,
            portfolio_id: portfolioId,
            country_code: allocation.countryCode,
            country_name: allocation.countryName,
            weight_pct: allocation.weightPct,
            source: result.source,
            confidence: result.confidence,
            evidence: result.evidence,
          })),
        );
        if (insertError) throw new Error(`ETF geography allocation insert failed: ${insertError.message}`);
      }
      await markGeographyJobCompleted(client, holding.id, {
        lastError: result.allocations.length === 0 ? completedUnknownGeographyReason(result) : null,
      });
    } catch (error) {
      await markGeographyJobsFailed(env, portfolioId, [holding.id], error);
      throw error;
    }
  }

  return { checked: holdingsToResearch.length, resolved, unresolved: holdingsToResearch.length - resolved };
}

async function getPortfolioGeography(
  env: Env,
  portfolioId: string,
  options: { useQuotes?: boolean } = {},
): Promise<Record<string, unknown>> {
  const client = adminDb(env);
  const { data: holdingsData, error: holdingsError } = await client
    .from("holdings")
    .select("id,ticker,name,asset_type,currency,quantity,purchase_price,fees,geography_checked_at")
    .eq("portfolio_id", portfolioId);
  if (holdingsError) throw new Error(`geography holdings lookup failed: ${holdingsError.message}`);
  const { data: portfolioData, error: portfolioError } = await client
    .from("portfolios")
    .select("currency")
    .eq("id", portfolioId)
    .single();
  if (portfolioError) throw new Error(`geography portfolio lookup failed: ${portfolioError.message}`);
  const portfolioCurrency = normalizeCurrencyCode(portfolioData?.currency) ?? "EUR";

  const holdings = (holdingsData ?? []).map((row) => ({
    id: String(row.id),
    ticker: String(row.ticker).toUpperCase(),
    name: String(row.name ?? row.ticker),
    asset_type: row.asset_type == null ? null : String(row.asset_type),
    currency: normalizeCurrencyCode(row.currency) ?? portfolioCurrency,
    quantity: Number(row.quantity ?? 0),
    purchase_price: Number(row.purchase_price ?? 0),
    fees: Number(row.fees ?? 0),
    geography_checked_at: row.geography_checked_at == null ? null : String(row.geography_checked_at),
  }));
  const holdingIds = holdings.map((holding) => holding.id);
  const { data: allocationsData, error: allocationsError } =
    holdingIds.length === 0
      ? { data: [], error: null }
      : await client
          .from("holding_geography_allocations")
          .select("holding_id,country_code,country_name,weight_pct,source,confidence,updated_at")
          .in("holding_id", holdingIds);
  if (allocationsError) throw new Error(`geography allocations lookup failed: ${allocationsError.message}`);

  const { data: jobsData, error: jobsError } =
    holdingIds.length === 0
      ? { data: [], error: null }
      : await client
          .from("geography_research_jobs")
          .select("holding_id,status,last_error")
          .in("holding_id", holdingIds);
  if (jobsError) throw new Error(`geography jobs lookup failed: ${jobsError.message}`);

  const quotesBySymbol =
    options.useQuotes === false ? {} : await getQuotesResilient(holdings.map((holding) => holding.ticker));
  const fxRates = await getFxRates(
    holdings.map((holding) => quotesBySymbol[holding.ticker]?.currency ?? holding.currency),
    portfolioCurrency,
  );
  const allocationsByHolding = new Map<string, Array<Record<string, unknown>>>();
  for (const allocation of allocationsData ?? []) {
    const holdingId = String(allocation.holding_id);
    const current = allocationsByHolding.get(holdingId) ?? [];
    current.push(allocation as Record<string, unknown>);
    allocationsByHolding.set(holdingId, current);
  }
  const jobsByHolding = new Map<string, { status: string; lastError: string | null }>();
  for (const job of jobsData ?? []) {
    jobsByHolding.set(String(job.holding_id), {
      status: String(job.status ?? ""),
      lastError: job.last_error == null ? null : String(job.last_error),
    });
  }

  const countryValues = new Map<
    string,
    { countryCode: string; countryName: string; value: number; source: string; confidence: number }
  >();
  let securitiesValue = 0;
  let coveredValue = 0;
  let unknownValue = 0;
  let unknownHoldingCount = 0;
  let pendingResearchCount = 0;
  let queuedResearchCount = 0;
  let runningResearchCount = 0;
  let failedResearchCount = 0;
  let completedUnknownResearchCount = 0;
  const completedUnknownResearchReasons: string[] = [];
  const failedResearchReasons: string[] = [];
  let freshest: string | null = null;
  let stalest: string | null = null;

  for (const holding of holdings) {
    const quote = quotesBySymbol[holding.ticker];
    const price = quote?.currentPrice ?? holding.purchase_price;
    const sourceCurrency = quote?.currency ?? holding.currency;
    const value = Math.max(
      0,
      convertCurrencyValue(price * holding.quantity + holding.fees, sourceCurrency, portfolioCurrency, fxRates),
    );
    securitiesValue += value;

    const allocations = allocationsByHolding.get(holding.id) ?? [];
    if (allocations.length === 0) {
      unknownValue += value;
      unknownHoldingCount += 1;
      if (isFundLikeAsset(holding.asset_type, holding.name, holding.ticker)) {
        const job = jobsByHolding.get(holding.id);
        const jobStatus = job?.status;
        if (jobStatus === "queued") queuedResearchCount += 1;
        else if (jobStatus === "running") runningResearchCount += 1;
        else if (jobStatus === "failed") {
          failedResearchCount += 1;
          if (job?.lastError) failedResearchReasons.push(job.lastError);
        } else if (jobStatus === "completed") {
          completedUnknownResearchCount += 1;
          if (job?.lastError) completedUnknownResearchReasons.push(job.lastError);
        } else pendingResearchCount += 1;
      }
      continue;
    }

    coveredValue += value;
    for (const allocation of allocations) {
      const code = String(allocation.country_code);
      const weightPct = Number(allocation.weight_pct ?? 0);
      const countryValue = value * (weightPct / 100);
      const current = countryValues.get(code) ?? {
        countryCode: code,
        countryName: String(allocation.country_name ?? code),
        value: 0,
        source: String(allocation.source ?? "unknown"),
        confidence: Number(allocation.confidence ?? 0),
      };
      current.value += countryValue;
      current.confidence = Math.max(current.confidence, Number(allocation.confidence ?? 0));
      if (current.source !== "llm_web") current.source = String(allocation.source ?? current.source);
      countryValues.set(code, current);
    }

    if (holding.geography_checked_at) {
      if (!freshest || holding.geography_checked_at > freshest) freshest = holding.geography_checked_at;
      if (!stalest || holding.geography_checked_at < stalest) stalest = holding.geography_checked_at;
    }
  }

  const safeTotal = securitiesValue || 1;
  const countries = [...countryValues.values()]
    .map((country) => ({
      ...country,
      percentage: Math.round((country.value / safeTotal) * 1000) / 10,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    portfolioId,
    totalValue: securitiesValue,
    coveragePct: Math.round((coveredValue / safeTotal) * 1000) / 10,
    unknownValue,
    unknownPct: Math.round((unknownValue / safeTotal) * 1000) / 10,
    unknownHoldingCount,
    pendingResearchCount,
    queuedResearchCount,
    runningResearchCount,
    failedResearchCount,
    completedUnknownResearchCount,
    completedUnknownResearchReasons: Array.from(new Set(completedUnknownResearchReasons)).slice(0, 3),
    failedResearchReasons: Array.from(new Set(failedResearchReasons)).slice(0, 3),
    checkedAt: freshest,
    oldestCheckedAt: stalest,
    countries,
  };
}

function yahooTimeToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

async function getQuotesFromBatch(symbols: string[]): Promise<Record<string, YahooQuoteItem>> {
  if (symbols.length === 0) return {};

  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbols.join(","));

  const data = await fetchJson<YahooQuoteResponse>(url.toString());
  const rows = data.quoteResponse?.result ?? [];
  const bySymbol = rows.reduce<Record<string, YahooQuoteItem>>((acc, row) => {
    const symbol = row.symbol?.toUpperCase();
    if (!symbol) return acc;

    const currentPrice = row.regularMarketPrice ?? null;
    const change1dPercent =
      row.regularMarketChangePercent ??
      (currentPrice != null &&
      row.regularMarketPreviousClose != null &&
      row.regularMarketPreviousClose !== 0
        ? ((currentPrice - row.regularMarketPreviousClose) /
          row.regularMarketPreviousClose) *
          100
        : null);

    acc[symbol] = {
      currentPrice,
      change1dPercent,
      currency: normalizeCurrencyCode(row.currency) ?? normalizeCurrencyCode(row.financialCurrency),
      sector: null,
      assetType: normalizeYahooAssetType(row.quoteType, row.typeDisp),
      lastPriceUpdatedAt: yahooTimeToIso(row.regularMarketTime),
    };
    return acc;
  }, {});

  return bySymbol;
}

async function getQuoteFromChart(symbol: string): Promise<YahooQuoteItem> {
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("range", "5d");

    const chart = await fetchJson<YahooChartResponse>(url.toString());
    const series = chart.chart?.result?.[0];
    const assetType = normalizeYahooAssetType(
      series?.meta?.instrumentType,
      series?.meta?.quoteType,
    );
    const closes = (series?.indicators?.quote?.[0]?.close ?? []).filter(
      (value): value is number => value != null,
    );
    const latestClose = closes.at(-1) ?? null;
    const previousClose = closes.length > 1 ? closes.at(-2)! : null;
    const change1dPercent =
      latestClose != null && previousClose != null && previousClose !== 0
        ? ((latestClose - previousClose) / previousClose) * 100
        : null;

    return {
      currentPrice: latestClose,
      change1dPercent,
      currency: normalizeCurrencyCode(series?.meta?.currency),
      sector: null,
      assetType,
      lastPriceUpdatedAt: yahooTimeToIso(series?.meta?.regularMarketTime),
    };
  } catch {
    return {
      currentPrice: null,
      change1dPercent: null,
      currency: null,
      sector: null,
      assetType: null,
      lastPriceUpdatedAt: null,
    };
  }
}

async function getQuotesResilient(symbols: string[]): Promise<Record<string, YahooQuoteItem>> {
  try {
    const batch = await getQuotesFromBatch(symbols);
    const missing = symbols.filter((symbol) => !batch[symbol]);
    if (missing.length === 0) return batch;

    const fallbackEntries = await Promise.all(
      missing.map(async (symbol) => [symbol, await getQuoteFromChart(symbol)] as const),
    );
    return { ...batch, ...Object.fromEntries(fallbackEntries) };
  } catch {
    const fallbackEntries = await Promise.all(
      symbols.map(async (symbol) => [symbol, await getQuoteFromChart(symbol)] as const),
    );
    return Object.fromEntries(fallbackEntries);
  }
}

function currencyRateKey(from: string, to: string): string {
  return `${from}:${to}`;
}

async function getFxRates(sourceCurrencies: string[], targetCurrency: string): Promise<Record<string, number>> {
  const target = normalizeCurrencyCode(targetCurrency) ?? "EUR";
  const sources = Array.from(
    new Set(sourceCurrencies.map((currency) => normalizeCurrencyCode(currency) ?? target)),
  ).filter((currency) => currency !== target);
  if (sources.length === 0) return {};

  const directSymbols = sources.map((source) => `${source}${target}=X`);
  const directQuotes = await getQuotesResilient(directSymbols);
  const rates: Record<string, number> = {};
  const missing: string[] = [];

  for (const source of sources) {
    const price = directQuotes[`${source}${target}=X`]?.currentPrice;
    if (price != null && Number.isFinite(price) && price > 0) {
      rates[currencyRateKey(source, target)] = price;
    } else {
      missing.push(source);
    }
  }

  if (missing.length > 0) {
    const inverseSymbols = missing.map((source) => `${target}${source}=X`);
    const inverseQuotes = await getQuotesResilient(inverseSymbols);
    for (const source of missing) {
      const price = inverseQuotes[`${target}${source}=X`]?.currentPrice;
      if (price != null && Number.isFinite(price) && price > 0) {
        rates[currencyRateKey(source, target)] = 1 / price;
      }
    }
  }

  return rates;
}

function convertCurrencyValue(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string,
  rates: Record<string, number>,
) {
  const from = normalizeCurrencyCode(fromCurrency) ?? normalizeCurrencyCode(toCurrency) ?? "EUR";
  const to = normalizeCurrencyCode(toCurrency) ?? "EUR";
  if (from === to) return amount;
  const rate = rates[currencyRateKey(from, to)];
  return Number.isFinite(rate) && rate > 0 ? amount * rate : amount;
}

async function getYtdChangePercent(symbol: string): Promise<number | null> {
  try {
    const now = new Date();
    const ytdStartUnix = Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1) / 1000);
    const nowUnix = Math.floor(now.getTime() / 1000);
    const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
    chartUrl.searchParams.set("period1", String(ytdStartUnix));
    chartUrl.searchParams.set("period2", String(nowUnix));
    chartUrl.searchParams.set("interval", "1d");
    chartUrl.searchParams.set("events", "history");

    const chart = await fetchJson<YahooChartResponse>(chartUrl.toString());
    const series = chart.chart?.result?.[0];
    const closes = series?.indicators?.quote?.[0]?.close ?? [];

    if (!closes.length) return null;
    const firstClose = closes.find((value) => value != null);
    const lastClose = [...closes].reverse().find((value) => value != null);
    if (!firstClose || !lastClose) return null;

    return ((lastClose - firstClose) / firstClose) * 100;
  } catch {
    return null;
  }
}

function isSnapshotQueueMessage(message: WorkerQueueMessage): message is SnapshotQueueMessage {
  return "type" in message && (message.type === "full_rebuild" || message.type === "daily_update");
}

function isGeographyQueueMessage(message: WorkerQueueMessage): message is GeographyQueueMessage {
  return "type" in message && message.type === "geography_research";
}

function isRecapQueueMessage(message: WorkerQueueMessage): message is RecapQueueMessage {
  return "recapId" in message;
}

async function fetchHistoricalPrices(
  ticker: string,
  firstDate: Date,
): Promise<{ prices: Map<string, number>; type: string | null }> {
  const period1 = Math.floor(firstDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");

  const chart = await fetchJson<YahooChartResponse>(url.toString());
  const result = chart.chart?.result?.[0];
  const instrumentType = normalizeYahooAssetType(
    result?.meta?.instrumentType,
    result?.meta?.quoteType,
  );
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const dateMap = new Map<string, number>();

  timestamps.forEach((ts, index) => {
    const close = closes[index];
    if (close == null) return;
    dateMap.set(toDateString(new Date(ts * 1000)), close);
  });

  return { prices: dateMap, type: instrumentType };
}

async function getBenchmarkPrices(
  env: Env,
  ticker: string,
  fromDate: string,
): Promise<BenchmarkPricePoint[]> {
  const normalizedTicker = ticker.trim().toUpperCase();
  if (!normalizedTicker) throw new Error("ticker is required");
  const normalizedFromDate = normalizeDateString(fromDate);
  const from = new Date(`${normalizedFromDate}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error("from must be a valid date");

  const client = adminDb(env);
  const today = toDateString(new Date());
  const staleAfter = new Date();
  staleAfter.setUTCDate(staleAfter.getUTCDate() - 1);
  const staleAfterDate = toDateString(staleAfter);
  const startCoverageGrace = new Date(from);
  startCoverageGrace.setUTCDate(startCoverageGrace.getUTCDate() + 7);
  const latestAcceptableFirstCachedDate = toDateString(startCoverageGrace);

  const readCached = async () => {
    const { data, error } = await client
      .from("benchmark_price_history")
      .select("date, close")
      .eq("ticker", normalizedTicker)
      .gte("date", normalizedFromDate)
      .lte("date", today)
      .order("date", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      date: String(row.date),
      close: Number(row.close),
    }));
  };

  const cached = await readCached();
  const earliestCachedDate = cached[0]?.date ?? null;
  const latestCachedDate = cached.at(-1)?.date ?? null;
  const cacheCoversRequestedStart =
    earliestCachedDate != null && earliestCachedDate <= latestAcceptableFirstCachedDate;
  if (cacheCoversRequestedStart && latestCachedDate && latestCachedDate >= staleAfterDate) return cached;

  try {
    const { prices } = await fetchHistoricalPrices(normalizedTicker, from);
    const rows = [...prices.entries()].map(([date, close]) => ({
      ticker: normalizedTicker,
      date,
      close,
    }));
    if (rows.length > 0) {
      const { error } = await client.from("benchmark_price_history").upsert(rows, {
        onConflict: "ticker,date",
      });
      if (error) throw new Error(error.message);
    }
    return await readCached();
  } catch (error) {
    if (cached.length > 0) return cached;
    throw error;
  }
}

function parseJsonArrayFromModelOutput(raw: string): unknown[] {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start < 0 || end <= start) {
      const objectStart = stripped.indexOf("{");
      const objectEnd = stripped.lastIndexOf("}");
      if (objectStart < 0 || objectEnd <= objectStart) return [];
      try {
        parsed = JSON.parse(stripped.slice(objectStart, objectEnd + 1));
      } catch {
        return [];
      }
    } else {
      try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return [];
      }
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const row = parsed as Record<string, unknown>;
    if (Array.isArray(row.benchmarks)) return row.benchmarks;
    if (Array.isArray(row.suggestions)) return row.suggestions;
    if (Array.isArray(row.concepts)) return row.concepts;
  }
  return [];
}

function parseModelBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  if (typeof value === "number") return value !== 0;
  return false;
}

function parseBenchmarkConcepts(raw: string): BenchmarkConcept[] {
  return parseJsonArrayFromModelOutput(raw)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const name = String(row.name ?? "").trim();
      const reason = String(row.reason ?? "").trim();
      const rawQueries = row.yahooSearchQueries ?? row.yahoo_search_queries ?? row.queries;
      const yahooSearchQueries = Array.isArray(rawQueries)
        ? rawQueries.map((query) => String(query).trim()).filter(Boolean)
        : [];
      const rawConfidence = Number(row.confidence ?? 0.75);
      const confidence =
        Number.isFinite(rawConfidence) && rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
      const needsWebSearch = parseModelBoolean(row.needsWebSearch ?? row.needs_web_search ?? false);
      if (!name || !reason) return null;
      return {
        name,
        reason,
        yahooSearchQueries: Array.from(new Set([...yahooSearchQueries, name])).slice(0, 5),
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.75,
        needsWebSearch,
      };
    })
    .filter((item): item is BenchmarkConcept => item != null)
    .slice(0, 3);
}

function parseBenchmarkFallbackQueries(raw: string): string[] {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    if (parsed && typeof parsed === "object") {
      const row = parsed as Record<string, unknown>;
      const queries = row.yahooSearchQueries ?? row.yahoo_search_queries ?? row.queries;
      if (Array.isArray(queries)) return queries.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    return parseBenchmarkFallbackQueries(stripped.slice(start, end + 1));
  }
  return [];
}

function tokenizeBenchmarkText(value: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "index", "indices", "benchmark", "fund"]);
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function benchmarkAssetTypeScore(assetType: string): number {
  const normalized = assetType.toUpperCase();
  if (normalized.includes("INDEX")) return 90;
  if (normalized.includes("ETF") || normalized.includes("ETP")) return 75;
  if (normalized.includes("MUTUAL") || normalized.includes("FUND")) return 60;
  if (normalized.includes("FUTURE")) return 35;
  if (normalized.includes("EQUITY") || normalized.includes("STOCK")) return -80;
  return 5;
}

function scoreBenchmarkCandidate(concept: BenchmarkConcept, candidate: AssetSearchResult, query: string): number {
  const candidateText = `${candidate.name} ${candidate.ticker} ${candidate.assetType} ${candidate.exchange}`.toLowerCase();
  const conceptName = concept.name.toLowerCase();
  const conceptTokens = tokenizeBenchmarkText(`${concept.name} ${query}`);
  const uniqueTokens = Array.from(new Set(conceptTokens));
  let score = benchmarkAssetTypeScore(candidate.assetType);

  if (candidateText.includes(conceptName)) score += 45;
  if (conceptName.includes(candidate.name.toLowerCase()) && candidate.name.length > 4) score += 30;
  if (candidate.ticker.startsWith("^")) score += 15;
  if (candidateText.includes("index")) score += 10;
  if (query.toLowerCase().includes(candidate.ticker.toLowerCase())) score += 35;
  for (const token of uniqueTokens) {
    if (candidateText.includes(token)) score += 8;
  }
  return score;
}

async function collectBenchmarkCandidates(
  concept: BenchmarkConcept,
): Promise<{ candidates: Array<AssetSearchResult & { score: number }>; checked: number }> {
  const byTicker = new Map<string, AssetSearchResult & { score: number }>();
  let checked = 0;
  const queries = Array.from(
    new Set([concept.name, ...concept.yahooSearchQueries].map((query) => query.trim()).filter(Boolean)),
  ).slice(0, 6);

  for (const query of queries) {
    const results = await searchYahooAssets(query);
    checked += results.length;
    for (const result of results) {
      const ticker = result.ticker.toUpperCase();
      const score = scoreBenchmarkCandidate(concept, result, query);
      const existing = byTicker.get(ticker);
      if (!existing || score > existing.score) {
        byTicker.set(ticker, { ...result, ticker, score });
      }
    }
  }

  const candidates = [...byTicker.values()]
    .filter((candidate) => candidate.score >= 40)
    .sort((a, b) => b.score - a.score);
  return { candidates, checked };
}

async function getBenchmarkWebFallbackQueries(env: Env, concept: BenchmarkConcept): Promise<string[]> {
  const apiKey = env.GROK_SUB_API_KEY ?? env.GROK_NORMALIZATION_API_KEY;
  if (!apiKey) return [];
  const body = {
    model: env.GROK_WEB_SEARCH_MODEL || "grok-4-1-fast-reasoning",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You resolve investment benchmark concepts to Yahoo Finance searchable names.",
              "Use web search only to clarify the exact index, ETF, or fund name.",
              "Return strict JSON only: {\"yahooSearchQueries\":[\"...\"]}.",
            ].join(" "),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              name: concept.name,
              reason: concept.reason,
              existingYahooSearchQueries: concept.yahooSearchQueries,
            }),
          },
        ],
      },
    ],
    tools: [{ type: "web_search" }],
  };
  const res = await fetch(`${getGrokBaseUrl(env)}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as Record<string, unknown>;
  return parseBenchmarkFallbackQueries(outputTextFromResponse(raw)).slice(0, 4);
}

async function resolveBenchmarkConcepts(
  env: Env,
  concepts: BenchmarkConcept[],
): Promise<{ suggestions: ResolvedBenchmarkSuggestion[]; diagnostics: BenchmarkSuggestionDiagnostics }> {
  const suggestions: ResolvedBenchmarkSuggestion[] = [];
  const seenTickers = new Set<string>();
  const diagnostics: BenchmarkSuggestionDiagnostics = {
    concepts: concepts.length,
    yahooCandidates: 0,
    webSearchFallbacks: 0,
    resolved: 0,
  };

  for (const concept of concepts) {
    let { candidates, checked } = await collectBenchmarkCandidates(concept);
    diagnostics.yahooCandidates += checked;
    if (candidates.length === 0 && (concept.needsWebSearch || concept.confidence < 0.65)) {
      diagnostics.webSearchFallbacks += 1;
      const fallbackQueries = await getBenchmarkWebFallbackQueries(env, concept).catch(() => []);
      if (fallbackQueries.length > 0) {
        const fallbackConcept = {
          ...concept,
          yahooSearchQueries: Array.from(new Set([...concept.yahooSearchQueries, ...fallbackQueries])),
        };
        const fallbackResult = await collectBenchmarkCandidates(fallbackConcept);
        candidates = fallbackResult.candidates;
        diagnostics.yahooCandidates += fallbackResult.checked;
      }
    }

    const match = candidates.find((candidate) => !seenTickers.has(candidate.ticker));
    if (!match) continue;
    seenTickers.add(match.ticker);
    suggestions.push({
      name: match.name || concept.name,
      ticker: match.ticker,
      reason: concept.reason,
    });
    if (suggestions.length >= 3) break;
  }

  diagnostics.resolved = suggestions.length;
  return { suggestions, diagnostics };
}

async function buildBenchmarkSuggestionHoldingsPayload(
  client: SupabaseClient,
  portfolioId: string,
): Promise<BenchmarkHoldingPayload[]> {
  const { data: holdings, error } = await client
    .from("holdings")
    .select("id,ticker,name,isin,asset_type,quantity,purchase_price,country_name")
    .eq("portfolio_id", portfolioId);
  if (error) throw new Error(error.message);

  const rows = (holdings ?? []).map((row) => ({
    id: String(row.id),
    ticker: String(row.ticker ?? "").toUpperCase(),
    name: String(row.name ?? row.ticker ?? ""),
    isin: row.isin == null ? null : String(row.isin),
    assetType: row.asset_type == null ? null : String(row.asset_type),
    quantity: Number(row.quantity ?? 0),
    purchasePrice: Number(row.purchase_price ?? 0),
    countryName: row.country_name == null ? null : String(row.country_name),
  }));
  if (rows.length === 0) return [];

  const [sectorsBySymbol, quotesBySymbol, allocationsResult] = await Promise.all([
    getSectorsForSymbols(rows.map((row) => row.ticker)).catch(() => ({} as Record<string, string>)),
    getQuotesResilient(rows.map((row) => row.ticker)).catch(() => ({} as Record<string, YahooQuoteItem>)),
    client
      .from("holding_geography_allocations")
      .select("holding_id,country_name,weight_pct")
      .eq("portfolio_id", portfolioId),
  ]);
  if (allocationsResult.error) throw new Error(allocationsResult.error.message);

  const allocationsByHolding = new Map<string, Array<{ countryName: string; weightPct: number }>>();
  for (const allocation of allocationsResult.data ?? []) {
    const holdingId = String(allocation.holding_id);
    const current = allocationsByHolding.get(holdingId) ?? [];
    current.push({
      countryName: String(allocation.country_name),
      weightPct: Number(allocation.weight_pct ?? 0),
    });
    allocationsByHolding.set(holdingId, current);
  }

  const enrichedRows = rows.map((row) => {
    const quote = quotesBySymbol[row.ticker];
    const price = quote?.currentPrice ?? row.purchasePrice;
    return {
      ...row,
      value: Math.max(0, price * row.quantity),
      assetType: normalizeYahooAssetType(quote?.assetType, row.assetType) ?? row.assetType ?? "Other",
      sector: sectorsBySymbol[row.ticker] ?? row.assetType ?? "Other",
    };
  });
  const securitiesValue = enrichedRows.reduce((sum, row) => sum + row.value, 0);
  return enrichedRows.map((row) => {
    const allocations = (allocationsByHolding.get(row.id) ?? [])
      .sort((a, b) => b.weightPct - a.weightPct)
      .slice(0, 3);
    const isinCountry = countryFromIsin(row.isin);
    const geography =
      allocations.length > 0
        ? allocations.map((allocation) => allocation.countryName).join(", ")
        : row.countryName || isinCountry?.name || "Unknown";

    return {
      id: row.id,
      ticker: row.ticker,
      isin: row.isin,
      name: row.name,
      weight: securitiesValue > 0 ? Math.round((row.value / securitiesValue) * 10000) / 10000 : 0,
      sector: row.sector,
      geography,
      assetType: row.assetType,
      value: row.value,
    };
  });
}

function compactMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "~$0";
  if (value >= 1_000_000) return `~$${Math.round(value / 100_000) / 10}M`;
  return `~$${Math.round(value).toLocaleString("en-US")}`;
}

function formatExposurePct(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function aggregateWeights(entries: Array<{ label: string; value: number }>, totalValue: number) {
  const byLabel = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.label || entry.value <= 0) continue;
    byLabel.set(entry.label, (byLabel.get(entry.label) ?? 0) + entry.value);
  }
  const safeTotal = totalValue || 1;
  return [...byLabel.entries()]
    .map(([label, value]) => ({
      label,
      weight: Math.round((value / safeTotal) * 1000) / 10,
      value,
    }))
    .sort((a, b) => b.value - a.value);
}

function formatBreakdown(
  entries: Array<{ label: string; weight: number; value: number }>,
  options: { maxItems?: number } = {},
): string {
  if (entries.length === 0) return "None.";
  const maxItems = options.maxItems ?? 6;
  const visible = entries.slice(0, maxItems);
  const remainder = entries.slice(maxItems).reduce((sum, entry) => sum + entry.weight, 0);
  const parts = visible.map((entry) => `${entry.label} ${formatExposurePct(entry.weight)}`);
  if (remainder >= 0.5) parts.push(`Other ${formatExposurePct(remainder)}`);
  return `${parts.join(", ")}.`;
}

async function buildBenchmarkPortfolioSummary(
  env: Env,
  portfolioId: string,
  holdings: BenchmarkHoldingPayload[],
): Promise<{ summaryString: string; holdingsPromptPayload: Array<Record<string, unknown>> }> {
  const client = adminDb(env);
  const { data: portfolio, error: portfolioError } = await client
    .from("portfolios")
    .select("cash_value")
    .eq("id", portfolioId)
    .single();
  if (portfolioError) throw new Error(portfolioError.message);

  const cashValue = Math.max(0, Number(portfolio?.cash_value ?? 0));
  const securitiesValue = holdings.reduce((sum, holding) => sum + holding.value, 0);
  const totalValue = securitiesValue + cashValue;
  const sectorBreakdown = aggregateWeights(
    holdings.map((holding) => ({ label: holding.sector || "Other", value: holding.value })),
    securitiesValue,
  );
  const assetMixEntries = holdings.map((holding) => ({
    label: holding.assetType || "Other",
    value: holding.value,
  }));
  if (cashValue > 0) assetMixEntries.push({ label: "Cash", value: cashValue });
  const assetMixBreakdown = aggregateWeights(assetMixEntries, totalValue);

  const allocationsResult =
    holdings.length === 0
      ? { data: [], error: null }
      : await client
          .from("holding_geography_allocations")
          .select("holding_id,country_name,weight_pct")
          .in("holding_id", holdings.map((holding) => holding.id));
  if (allocationsResult.error) throw new Error(allocationsResult.error.message);

  const allocationsByHolding = new Map<string, Array<{ countryName: string; weightPct: number }>>();
  for (const allocation of allocationsResult.data ?? []) {
    const holdingId = String(allocation.holding_id);
    const current = allocationsByHolding.get(holdingId) ?? [];
    current.push({
      countryName: String(allocation.country_name ?? "Unknown"),
      weightPct: Number(allocation.weight_pct ?? 0),
    });
    allocationsByHolding.set(holdingId, current);
  }

  const geographyEntries: Array<{ label: string; value: number }> = [];
  for (const holding of holdings) {
    const allocations = allocationsByHolding.get(holding.id) ?? [];
    if (allocations.length === 0) {
      geographyEntries.push({ label: "Unknown", value: holding.value });
      continue;
    }
    for (const allocation of allocations) {
      geographyEntries.push({
        label: allocation.countryName || "Unknown",
        value: holding.value * (allocation.weightPct / 100),
      });
    }
  }
  const geographyBreakdown = aggregateWeights(geographyEntries, securitiesValue);
  const holdingsPromptPayload = holdings.map(({ id: _id, value: _value, ...holding }) => holding);

  return {
    summaryString: [
      `Portfolio summary: ${holdings.length} holdings, ${compactMoney(totalValue)} total value.`,
      `Sector exposure: ${formatBreakdown(sectorBreakdown)}`,
      `Geographic exposure: ${formatBreakdown(geographyBreakdown)}`,
      `Asset mix: ${formatBreakdown(assetMixBreakdown)}`,
    ].join("\n"),
    holdingsPromptPayload,
  };
}

async function getAssetMetadataFromBatch(symbols: string[]): Promise<{
  typeByTicker: Map<string, string>;
  currencyByTicker: Map<string, string>;
}> {
  if (symbols.length === 0) {
    return { typeByTicker: new Map(), currencyByTicker: new Map() };
  }

  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbols.join(","));

  const data = await fetchJson<YahooQuoteResponse>(url.toString());
  const rows = data.quoteResponse?.result ?? [];
  const typeByTicker = new Map<string, string>();
  const currencyByTicker = new Map<string, string>();
  for (const row of rows) {
    const symbol = row.symbol?.toUpperCase();
    if (!symbol) continue;
    const assetType = normalizeYahooAssetType(row.quoteType, row.typeDisp);
    if (assetType) typeByTicker.set(symbol, assetType);
    const currency = normalizeCurrencyCode(row.currency) ?? normalizeCurrencyCode(row.financialCurrency);
    if (currency) currencyByTicker.set(symbol, currency);
  }
  return { typeByTicker, currencyByTicker };
}

async function getPricesByTicker(
  env: Env,
  tickers: string[],
  firstDate: Date,
): Promise<{
  pricesByTicker: Map<string, Map<string, number>>;
  typeByTicker: Map<string, string>;
  currencyByTicker: Map<string, string>;
}> {
  const client = adminDb(env);
  const allPriceRows: Array<{ yahoo_ticker: string; date: string; closing_price: number }> = [];
  const { typeByTicker, currencyByTicker } = await getAssetMetadataFromBatch(tickers).catch((error) => {
    console.error("asset metadata fetch failed", error);
    return { typeByTicker: new Map<string, string>(), currencyByTicker: new Map<string, string>() };
  });
  const entries = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const { prices: dateMap, type } = await fetchHistoricalPrices(ticker, firstDate);
        const priceRows = [...dateMap.entries()].map(([date, closing_price]) => ({
          yahoo_ticker: ticker,
          date,
          closing_price,
        }));
        allPriceRows.push(...priceRows);
        if (type && !typeByTicker.has(ticker.toUpperCase())) {
          typeByTicker.set(ticker.toUpperCase(), type);
        }
        return [ticker, dateMap] as const;
      } catch (error) {
        console.error(`price fetch failed for ${ticker}`, error);
        return [ticker, new Map<string, number>()] as const;
      }
    }),
  );
  if (allPriceRows.length > 0) {
    await client.from("price_history").upsert(allPriceRows, {
      onConflict: "yahoo_ticker,date",
    });
  }
  return { pricesByTicker: new Map(entries), typeByTicker, currencyByTicker };
}

function normalizeYahooAssetType(...values: Array<string | null | undefined>): string | null {
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const normalized = value.toUpperCase().replace(/[_-]+/g, " ");
    if (normalized === "ETF" || normalized.includes("EXCHANGE TRADED FUND")) return "ETF";
    if (
      normalized === "MUTUALFUND" ||
      normalized === "MUTUAL FUND" ||
      normalized === "FUND" ||
      normalized.endsWith(" FUND") ||
      normalized.includes("OPEN END FUND")
    ) {
      return "Fund";
    }
    if (
      normalized === "EQUITY" ||
      normalized === "STOCK" ||
      normalized === "COMMON STOCK" ||
      normalized.includes("EQUITY")
    ) {
      return "Equity";
    }
  }
  return null;
}

function getCarryForwardPrice(dateMap: Map<string, number> | undefined, dateStr: string): number {
  if (!dateMap) return 0;
  const exact = dateMap.get(dateStr);
  if (exact != null) return exact;
  let bestDate = "";
  let bestPrice = 0;
  for (const [date, price] of dateMap.entries()) {
    if (date <= dateStr && date > bestDate) {
      bestDate = date;
      bestPrice = price;
    }
  }
  return bestPrice;
}

async function loadPortfolioTransactions(env: Env, portfolioId: string): Promise<TransactionRow[]> {
  const { data, error } = await adminDb(env)
    .from("transactions")
    .select("id, portfolio_id, date, symbol, isin, yahoo_ticker, side, quantity, net_amount, commission")
    .eq("portfolio_id", portfolioId)
    .order("date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    portfolio_id: String(row.portfolio_id),
    date: String(row.date),
    symbol: String(row.symbol),
    isin: row.isin == null ? null : String(row.isin),
    yahoo_ticker: row.yahoo_ticker == null ? null : String(row.yahoo_ticker),
    side: row.side as TransactionSide,
    quantity: row.quantity == null ? null : Number(row.quantity),
    net_amount: row.net_amount == null ? null : Number(row.net_amount),
    commission: Number(row.commission ?? 0),
  }));
}

function stableGeographyKey(input: { isin?: string | null; ticker?: string | null }): string | null {
  const isin = input.isin?.trim().toUpperCase();
  if (isin) return `isin:${isin}`;
  const ticker = input.ticker?.trim().toUpperCase();
  if (ticker) return `ticker:${ticker}`;
  return null;
}

interface CachedGeographyAllocation {
  country_code: string;
  country_name: string;
  weight_pct: number;
  source: GeographySource;
  confidence: number;
  evidence: Record<string, unknown>;
}

interface CachedHoldingGeography {
  asset_type: string | null;
  country_code: string | null;
  country_name: string | null;
  geography_source: GeographySource;
  geography_confidence: number;
  geography_checked_at: string | null;
  allocations: CachedGeographyAllocation[];
}

async function snapshotHoldingGeography(
  client: ReturnType<typeof adminDb>,
  portfolioId: string,
): Promise<Map<string, CachedHoldingGeography>> {
  const { data: holdings, error: holdingsError } = await client
    .from("holdings")
    .select(
      "id,ticker,isin,asset_type,country_code,country_name,geography_source,geography_confidence,geography_checked_at",
    )
    .eq("portfolio_id", portfolioId);
  if (holdingsError) throw new Error(`geography snapshot holdings lookup failed: ${holdingsError.message}`);

  const holdingKeysById = new Map<string, string>();
  const snapshot = new Map<string, CachedHoldingGeography>();
  for (const holding of holdings ?? []) {
    const key = stableGeographyKey({
      isin: holding.isin == null ? null : String(holding.isin),
      ticker: holding.ticker == null ? null : String(holding.ticker),
    });
    if (!key) continue;
    holdingKeysById.set(String(holding.id), key);
    snapshot.set(key, {
      asset_type: holding.asset_type == null ? null : String(holding.asset_type),
      country_code: holding.country_code == null ? null : String(holding.country_code),
      country_name: holding.country_name == null ? null : String(holding.country_name),
      geography_source: String(holding.geography_source ?? "unknown") as GeographySource,
      geography_confidence: Number(holding.geography_confidence ?? 0),
      geography_checked_at: holding.geography_checked_at == null ? null : String(holding.geography_checked_at),
      allocations: [],
    });
  }
  const holdingIds = [...holdingKeysById.keys()];
  if (holdingIds.length === 0) return new Map();

  const { data: allocations, error: allocationsError } = await client
    .from("holding_geography_allocations")
    .select("holding_id,country_code,country_name,weight_pct,source,confidence,evidence")
    .in("holding_id", holdingIds);
  if (allocationsError) throw new Error(`geography snapshot allocations lookup failed: ${allocationsError.message}`);

  for (const allocation of allocations ?? []) {
    const key = holdingKeysById.get(String(allocation.holding_id));
    if (!key) continue;
    const cached = snapshot.get(key);
    if (!cached) continue;
    cached.allocations.push({
      country_code: String(allocation.country_code),
      country_name: String(allocation.country_name ?? allocation.country_code),
      weight_pct: Number(allocation.weight_pct ?? 0),
      source: String(allocation.source ?? "unknown") as GeographySource,
      confidence: Number(allocation.confidence ?? 0),
      evidence:
        allocation.evidence && typeof allocation.evidence === "object"
          ? (allocation.evidence as Record<string, unknown>)
          : {},
    });
  }

  return snapshot;
}

function restoredAssetType(
  ticker: string,
  cached: CachedHoldingGeography | undefined,
  typeByTicker: Map<string, string>,
): string {
  return assetTypeWithCachedGeography(typeByTicker.get(ticker.toUpperCase()), {
    assetType: cached?.asset_type,
    geographySource: cached?.geography_source,
    allocationSources: cached?.allocations.map((allocation) => allocation.source),
  });
}

async function rebuildCurrentHoldings(
  env: Env,
  portfolioId: string,
  typeByTicker: Map<string, string> = new Map(),
  currencyByTicker: Map<string, string> = new Map(),
): Promise<void> {
  const client = adminDb(env);
  const txns = await loadPortfolioTransactions(env, portfolioId);
  const cachedGeography = await snapshotHoldingGeography(client, portfolioId);
  const lots = new Map<
    string,
    {
      isin: string | null;
      ticker: string;
      name: string;
      quantity: number;
      cost: number;
      firstDate: string;
    }
  >();
  let cashValue = 0;

  for (const txn of txns) {
    cashValue += txn.net_amount ?? 0;
    if (!txn.isin || (txn.side !== "BUY" && txn.side !== "SELL")) continue;

    const key = txn.isin;
    const current = lots.get(key) ?? {
      isin: txn.isin,
      ticker: txn.yahoo_ticker || txn.symbol,
      name: txn.symbol,
      quantity: 0,
      cost: 0,
      firstDate: txn.date,
    };
    const quantity = txn.quantity ?? 0;

    if (txn.side === "BUY") {
      current.quantity += quantity;
      current.cost += Math.abs(txn.net_amount ?? 0);
      if (txn.date < current.firstDate) current.firstDate = txn.date;
    } else if (txn.side === "SELL") {
      const averageCost = current.quantity > 0 ? current.cost / current.quantity : 0;
      current.quantity -= quantity;
      current.cost = Math.max(0, current.cost - averageCost * quantity);
    }

    if (current.quantity > 0.000001) lots.set(key, current);
    else lots.delete(key);
  }

  const { error: deleteError } = await client.from("holdings").delete().eq("portfolio_id", portfolioId);
  if (deleteError) throw new Error(`holdings rebuild delete failed: ${deleteError.message}`);
  const holdingRows = [...lots.values()].map((lot) => {
    const ticker = lot.ticker.toUpperCase();
    const key = stableGeographyKey({ isin: lot.isin, ticker });
    const cached = key ? cachedGeography.get(key) : undefined;
    return {
      portfolio_id: portfolioId,
      ticker,
      isin: lot.isin,
      name: lot.name,
      purchase_date: lot.firstDate,
      purchase_price: lot.quantity > 0 ? lot.cost / lot.quantity : 0,
      quantity: lot.quantity,
      fees: 0,
      asset_type: restoredAssetType(ticker, cached, typeByTicker),
      currency: currencyByTicker.get(ticker) ?? "EUR",
    };
  });
  if (holdingRows.length > 0) {
    const { data: insertedHoldings, error: insertError } = await client
      .from("holdings")
      .insert(holdingRows)
      .select("id,ticker,isin,name,asset_type");
    if (insertError) throw new Error(`holdings rebuild insert failed: ${insertError.message}`);

    const restoredHoldingUpdates: Array<{
      id: string;
      country_code: string | null;
      country_name: string | null;
      geography_source: GeographySource;
      geography_confidence: number;
      geography_checked_at: string | null;
    }> = [];
    const restoredRows = (insertedHoldings ?? []).flatMap((holding) => {
      const key = stableGeographyKey({
        isin: holding.isin == null ? null : String(holding.isin),
        ticker: holding.ticker == null ? null : String(holding.ticker),
      });
      const cached = key ? cachedGeography.get(key) : undefined;
      const ticker = holding.ticker == null ? "" : String(holding.ticker);
      const name = holding.name == null ? ticker : String(holding.name);
      const assetType = holding.asset_type == null ? null : String(holding.asset_type);
      const isFundLike = !shouldInferDirectGeographyFromIsin(assetType, name, ticker);
      const allocationsToRestore = isFundLike
        ? (cached?.allocations ?? []).filter((allocation) => isValidFundGeographySource(allocation.source))
        : (cached?.allocations ?? []);
      const shouldRestoreHoldingGeography =
        Boolean(cached) &&
        (!isFundLike ||
          hasValidFundGeographyAllocation((cached?.allocations ?? []).map((allocation) => allocation.source)));

      if (cached && shouldRestoreHoldingGeography) {
        restoredHoldingUpdates.push({
          id: String(holding.id),
          country_code: cached.country_code,
          country_name: cached.country_name,
          geography_source: cached.geography_source,
          geography_confidence: cached.geography_confidence,
          geography_checked_at: cached.geography_checked_at,
        });
      }
      return allocationsToRestore.map((allocation) => ({
        ...allocation,
        holding_id: String(holding.id),
        portfolio_id: portfolioId,
      }));
    });

    await Promise.all(
      restoredHoldingUpdates.map(async (holding) => {
        const { error: restoreHoldingError } = await client
          .from("holdings")
          .update({
            country_code: holding.country_code,
            country_name: holding.country_name,
            geography_source: holding.geography_source,
            geography_confidence: holding.geography_confidence,
            geography_checked_at: holding.geography_checked_at,
          })
          .eq("id", holding.id);
        if (restoreHoldingError) throw new Error(`holding geography restore failed: ${restoreHoldingError.message}`);
      }),
    );
    if (restoredRows.length > 0) {
      const { error: restoreError } = await client
        .from("holding_geography_allocations")
        .upsert(restoredRows, { onConflict: "holding_id,country_code" });
      if (restoreError) throw new Error(`geography restore failed: ${restoreError.message}`);
    }
  }
  await client.from("portfolios").update({ cash_value: cashValue }).eq("id", portfolioId);
}

function computeSnapshotForDate(
  txns: TransactionRow[],
  pricesByTicker: Map<string, Map<string, number>>,
  dateStr: string,
): { cash_balance: number; securities_value: number; total_value: number } {
  const holdings = new Map<string, { quantity: number; ticker: string | null }>();
  let cashBalance = 0;

  for (const txn of txns) {
    if (txn.date > dateStr) continue;
    cashBalance += txn.net_amount ?? 0;
    if (!txn.isin || (txn.side !== "BUY" && txn.side !== "SELL")) continue;
    const current = holdings.get(txn.isin) ?? { quantity: 0, ticker: txn.yahoo_ticker };
    if (txn.yahoo_ticker) current.ticker = txn.yahoo_ticker;
    if (txn.side === "BUY") current.quantity += txn.quantity ?? 0;
    if (txn.side === "SELL") current.quantity -= txn.quantity ?? 0;
    holdings.set(txn.isin, current);
  }

  let securitiesValue = 0;
  for (const holding of holdings.values()) {
    if (holding.quantity <= 0 || !holding.ticker) continue;
    securitiesValue += holding.quantity * getCarryForwardPrice(pricesByTicker.get(holding.ticker), dateStr);
  }

  return {
    cash_balance: cashBalance,
    securities_value: securitiesValue,
    total_value: cashBalance + securitiesValue,
  };
}

async function recomputeSnapshots(env: Env, portfolioId: string): Promise<void> {
  const client = adminDb(env);
  const txns = await loadPortfolioTransactions(env, portfolioId);
  console.log("[recompute] transactions fetched:", txns.length);

  if (txns.length === 0) {
    await rebuildCurrentHoldings(env, portfolioId);
    await client.from("portfolio_snapshots").delete().eq("portfolio_id", portfolioId);
    console.log("[recompute] snapshots built:", 0);
    console.log("[recompute] insert result:", JSON.stringify(null));
    return;
  }

  const firstDate = new Date(`${txns[0].date}T00:00:00.000Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tickers = Array.from(new Set(txns.map((txn) => txn.yahoo_ticker).filter(Boolean))) as string[];
  const { pricesByTicker, typeByTicker, currencyByTicker } = await getPricesByTicker(env, tickers, firstDate);
  await rebuildCurrentHoldings(env, portfolioId, typeByTicker, currencyByTicker);
  const snapshots: Array<{
    portfolio_id: string;
    date: string;
    total_value: number;
    cash_balance: number;
    securities_value: number;
    twr_pct: number;
  }> = [];

  // Collect the union of all real trading days present in the price maps
  // (Mon–Fri only, no weekends), bounded by [firstDate, today]. A calendar
  // cursor would generate weekend rows and miss any market-specific holidays;
  // price_history is the authoritative set of dates prices actually exist.
  const tradingDaySet = new Set<string>();
  const todayStr = toDateString(today);
  const firstDateStr = toDateString(firstDate);
  for (const dateMap of pricesByTicker.values()) {
    for (const d of dateMap.keys()) {
      if (d >= firstDateStr && d <= todayStr) tradingDaySet.add(d);
    }
  }
  const tradingDays = Array.from(tradingDaySet).sort();

  const rawSnapshots = tradingDays.map((date) => ({
    portfolio_id: portfolioId,
    date,
    ...computeSnapshotForDate(txns, pricesByTicker, date),
  }));

  const flowByDate = new Map<string, number>();
  for (const txn of txns) {
    if (txn.side !== "DEP" && txn.side !== "WD") continue;
    const d = String(txn.date);
    flowByDate.set(d, (flowByDate.get(d) ?? 0) + (txn.net_amount ?? 0));
  }
  const twrByDate = computeDailyTwrByDate(rawSnapshots, flowByDate);

  for (const snap of rawSnapshots) {
    snapshots.push({
      ...snap,
      twr_pct: Math.round((twrByDate.get(snap.date) ?? 0) * 100) / 100,
    });
  }
  console.log("[recompute] snapshots built:", snapshots.length);

  await client.from("portfolio_snapshots").delete().eq("portfolio_id", portfolioId);
  for (let i = 0; i < snapshots.length; i += 500) {
    const { error: insertError } = await client
      .from("portfolio_snapshots")
      .insert(snapshots.slice(i, i + 500));
    console.log("[recompute] insert result:", JSON.stringify(insertError));
    if (insertError) throw new Error(insertError.message);
  }
}

// Returns the trading day the snapshot was written for, or null if no price
// data was available (e.g. called on a public holiday with no close yet).
// The date is derived from the latest trading day present in the fetched
// price maps — NOT from the wall-clock — so a misfired cron (e.g. Sunday)
// writes Friday's snapshot and never creates a weekend row.
async function appendTodaySnapshot(env: Env, portfolioId: string): Promise<string | null> {
  const txns = await loadPortfolioTransactions(env, portfolioId);
  if (txns.length === 0) return null;

  const tickers = Array.from(new Set(txns.map((txn) => txn.yahoo_ticker).filter(Boolean))) as string[];
  const { pricesByTicker, typeByTicker, currencyByTicker } = await getPricesByTicker(
    env,
    tickers,
    new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // lookback covers a long weekend
  );

  // Find the latest trading day across all fetched price maps.
  let latestTradingDay = "";
  for (const dateMap of pricesByTicker.values()) {
    for (const d of dateMap.keys()) {
      if (d > latestTradingDay) latestTradingDay = d;
    }
  }
  if (!latestTradingDay) return null;

  const date = latestTradingDay;
  const snapshotData = computeSnapshotForDate(txns, pricesByTicker, date);
  await adminDb(env).from("portfolio_snapshots").upsert(
    { portfolio_id: portfolioId, date, ...snapshotData },
    { onConflict: "portfolio_id,date" },
  );

  // Compute TWR incrementally from the previous snapshot
  const { data: prevSnaps } = await adminDb(env)
    .from("portfolio_snapshots")
    .select("date, total_value, twr_pct")
    .eq("portfolio_id", portfolioId)
    .lt("date", date)
    .order("date", { ascending: false })
    .limit(1);
  const prev = prevSnaps?.[0];
  const todayFlow = txns
    .filter((t) => t.date === date && (t.side === "DEP" || t.side === "WD"))
    .reduce((s, t) => s + (t.net_amount ?? 0), 0);
  let twr_pct = 0;
  if (prev && Number(prev.total_value) > 0) {
    const prevIndex = 1 + Number(prev.twr_pct ?? 0) / 100;
    const periodReturn = (snapshotData.total_value - todayFlow - Number(prev.total_value)) / Number(prev.total_value);
    const newIndex = Number.isFinite(periodReturn) ? prevIndex * (1 + periodReturn) : prevIndex;
    twr_pct = Math.round((newIndex - 1) * 100 * 100) / 100;
  }
  await adminDb(env)
    .from("portfolio_snapshots")
    .update({ twr_pct })
    .eq("portfolio_id", portfolioId)
    .eq("date", date);

  await rebuildCurrentHoldings(env, portfolioId, typeByTicker, currencyByTicker);
  return date;
}

async function enqueueDailySnapshotsForClosedMarkets(env: Env, scheduledTime: number): Promise<void> {
  if (!env.SNAPSHOT_QUEUE) return;
  const scheduledAt = new Date(scheduledTime);
  const timeKey = `${scheduledAt.getUTCHours()}:${String(scheduledAt.getUTCMinutes()).padStart(2, "0")}`;
  const exchangesByTime: Record<string, string[]> = {
    "6:30": ["TSE"],
    "16:30": ["LSE"],
    "17:30": ["EURONEXT", "XETRA"],
    "21:00": ["NYSE", "NASDAQ"],
  };
  const exchanges = exchangesByTime[timeKey] ?? [];
  if (exchanges.length === 0) return;

  const { data, error } = await adminDb(env)
    .from("portfolios")
    .select("id")
    .in("primary_exchange", exchanges);
  if (error) throw new Error(`daily snapshot portfolio lookup failed: ${error.message}`);
  await Promise.all(
    (data ?? []).map((portfolio) =>
      env.SNAPSHOT_QUEUE.send({ type: "daily_update", portfolio_id: String(portfolio.id) }),
    ),
  );
}

function buildIdempotencyKey(input: {
  userId: string;
  portfolioId: string;
  triggerType: AgentRunTriggerType;
  now: Date;
}): string {
  const dayWindow = `${input.now.getUTCFullYear()}-${String(input.now.getUTCMonth() + 1).padStart(2, "0")}-${String(input.now.getUTCDate()).padStart(2, "0")}`;
  if (input.triggerType === "scheduled") {
    const hourWindow = String(input.now.getUTCHours()).padStart(2, "0");
    return `${input.userId}:${input.portfolioId}:${input.triggerType}:${dayWindow}T${hourWindow}`;
  }

  const minuteWindow = `${dayWindow}T${String(input.now.getUTCHours()).padStart(2, "0")}:${String(input.now.getUTCMinutes()).padStart(2, "0")}`;
  return `${input.userId}:${input.portfolioId}:${input.triggerType}:${minuteWindow}`;
}

async function createRun(
  client: SupabaseClient,
  params: {
    userId: string;
    portfolioId: string;
    triggerType: AgentRunTriggerType;
    idempotencyKey?: string;
  },
): Promise<AgentRunRow> {
  const now = new Date();
  const idempotencyKey =
    params.idempotencyKey ??
    buildIdempotencyKey({
      userId: params.userId,
      portfolioId: params.portfolioId,
      triggerType: params.triggerType,
      now,
    });

  const payload = {
    user_id: params.userId,
    portfolio_id: params.portfolioId,
    trigger_type: params.triggerType,
    status: "queued" as const,
    idempotency_key: idempotencyKey,
    scope_hash: params.portfolioId,
    model_main: "grok-4.20-0309-reasoning",
    model_sub: "grok-4-1-fast-reasoning",
  };

  const { data: inserted, error: insertError } = await client
    .from("agent_runs")
    .insert(payload)
    .select("*")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: existing, error: existingError } = await client
        .from("agent_runs")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (existingError || !existing) {
        throw new Error(existingError?.message || "Failed to load existing run");
      }
      return existing as AgentRunRow;
    }

    throw new Error(insertError.message);
  }

  return inserted as AgentRunRow;
}

async function queueRun(env: Env, run: AgentRunRow): Promise<void> {
  await env.AGENT_RUNS_QUEUE.send({
    runId: run.id,
    userId: run.user_id,
    portfolioId: run.portfolio_id ?? "",
    triggerType: run.trigger_type,
  });
}

async function listUserPortfolioIds(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.from("portfolios").select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.id as string);
}

function runsPerDayToLocalHours(runsPerDay: number): number[] {
  if (runsPerDay <= 1) return [8];
  if (runsPerDay === 2) return [8, 20];
  return [6, 14, 22];
}

function getHourInTimezone(now: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const parsed = Number.parseInt(hour, 10);
  if (Number.isNaN(parsed)) return now.getUTCHours();
  return parsed;
}

function getWeekdayInTimezone(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(now);
  }
}

// Most recent Friday on or before `now` (UTC). Weekly recaps fire Saturday
// morning and cover Mon–Fri, reading Friday's already-committed snapshot.
function mostRecentFridayUTC(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0=Sun … 5=Fri … 6=Sat
  const delta = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - delta);
  return d;
}

function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Idempotent recap-row create + enqueue. Returns the recap id, or null if a
// recap for this (portfolio, type, period_end) already exists (unique
// constraint) — so snapshot retries / repeated cron ticks never double-generate.
async function createAndQueueRecap(
  env: Env,
  params: {
    portfolioId: string;
    userId: string;
    type: RecapType;
    periodStart: string;
    periodEnd: string;
  },
): Promise<string | null> {
  const client = adminDb(env);
  const { data, error } = await client
    .from("recaps")
    .insert({
      portfolio_id: params.portfolioId,
      user_id: params.userId,
      type: params.type,
      period_start: params.periodStart,
      period_end: params.periodEnd,
      status: "queued",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null; // already exists for this period
    throw new Error(`createAndQueueRecap insert error: ${error.message}`);
  }
  const recapId = String(data.id);
  if (env.RECAP_QUEUE) await env.RECAP_QUEUE.send({ recapId });
  return recapId;
}

// Weekly fanout — runs on the hourly cron; selects portfolios where it is
// Saturday 08:00 in the user's timezone. (Daily recaps are NOT fanned here —
// they are chained off the snapshot commit; see the queue() handler.)
async function runWeeklyRecapFanout(
  env: Env,
  options: { now: Date; dryRun?: boolean },
): Promise<{ dryRun: boolean; checkedPortfolios: number; duePortfolios: number; queued: number; queuedIds: string[] }> {
  const client = adminDb(env);
  const [{ data: portfolios, error: pErr }, { data: userSettings, error: sErr }] = await Promise.all([
    client.from("portfolios").select("id,user_id"),
    client.from("agent_user_settings").select("user_id,timezone"),
  ]);
  if (pErr) throw new Error(`weekly recap fanout portfolios error: ${pErr.message}`);
  if (sErr) throw new Error(`weekly recap fanout settings error: ${sErr.message}`);

  const tzByUser = new Map(
    (userSettings ?? []).map((r) => [String(r.user_id), String(r.timezone ?? "Europe/Paris")]),
  );

  const friday = mostRecentFridayUTC(options.now);
  const monday = new Date(friday);
  monday.setUTCDate(monday.getUTCDate() - 4);
  const periodEnd = toUtcDateString(friday);
  const periodStart = toUtcDateString(monday);

  const due = (portfolios ?? []).filter((p) => {
    const tz = tzByUser.get(String(p.user_id)) ?? "Europe/Paris";
    return getWeekdayInTimezone(options.now, tz) === "Sat" && getHourInTimezone(options.now, tz) === 8;
  });

  if (options.dryRun) {
    return {
      dryRun: true,
      checkedPortfolios: (portfolios ?? []).length,
      duePortfolios: due.length,
      queued: 0,
      queuedIds: [],
    };
  }

  const queuedIds: string[] = [];
  for (const p of due) {
    const id = await createAndQueueRecap(env, {
      portfolioId: String(p.id),
      userId: String(p.user_id),
      type: "weekly",
      periodStart,
      periodEnd,
    });
    if (id) queuedIds.push(id);
  }

  return {
    dryRun: false,
    checkedPortfolios: (portfolios ?? []).length,
    duePortfolios: due.length,
    queued: queuedIds.length,
    queuedIds,
  };
}

async function runScheduledFanout(
  env: Env,
  options: { now: Date; dryRun?: boolean; source: "cron" | "manual" },
): Promise<{
  source: "cron" | "manual";
  dryRun: boolean;
  checkedPortfolios: number;
  duePortfolios: number;
  queuedRuns: number;
  queuedRunIds: string[];
}> {
  if (!env.AGENT_RUNS_QUEUE && !options.dryRun) {
    throw new Error("Server misconfiguration: AGENT_RUNS_QUEUE binding is missing");
  }

  const client = adminDb(env);
  const [{ data: portfolios, error: portfoliosError }, { data: userSettings, error: userSettingsError }, { data: portfolioSettings, error: portfolioSettingsError }] =
    await Promise.all([
      client.from("portfolios").select("id,user_id"),
      client.from("agent_user_settings").select("user_id,timezone,global_runs_per_day"),
      client
        .from("agent_portfolio_settings")
        .select("portfolio_id,user_id,runs_per_day_override,agent_enabled"),
    ]);

  if (portfoliosError) throw new Error(`scheduled fanout portfolios error: ${portfoliosError.message}`);
  if (userSettingsError) {
    throw new Error(`scheduled fanout agent_user_settings error: ${userSettingsError.message}`);
  }
  if (portfolioSettingsError) {
    throw new Error(`scheduled fanout agent_portfolio_settings error: ${portfolioSettingsError.message}`);
  }

  const userSettingsByUserId = new Map(
    (userSettings ?? []).map((row) => [
      String(row.user_id),
      {
        timezone: String(row.timezone ?? "Europe/Paris"),
        globalRunsPerDay: Number(row.global_runs_per_day ?? 2),
      },
    ]),
  );
  const portfolioSettingsByPortfolioId = new Map(
    (portfolioSettings ?? []).map((row) => [
      String(row.portfolio_id),
      {
        userId: String(row.user_id),
        runsPerDayOverride:
          row.runs_per_day_override == null ? null : Number(row.runs_per_day_override),
        agentEnabled: row.agent_enabled == null ? true : Boolean(row.agent_enabled),
      },
    ]),
  );

  const dueTargets = (portfolios ?? []).filter((portfolio) => {
    const portfolioId = String(portfolio.id);
    const userId = String(portfolio.user_id);
    const userSetting = userSettingsByUserId.get(userId);
    const portfolioSetting = portfolioSettingsByPortfolioId.get(portfolioId);

    if (portfolioSetting && !portfolioSetting.agentEnabled) return false;

    const timezone = userSetting?.timezone ?? "Europe/Paris";
    const runsPerDay = Math.max(
      1,
      Math.min(3, portfolioSetting?.runsPerDayOverride ?? userSetting?.globalRunsPerDay ?? 2),
    );
    const localHour = getHourInTimezone(options.now, timezone);
    return runsPerDayToLocalHours(runsPerDay).includes(localHour);
  });

  if (options.dryRun) {
    return {
      source: options.source,
      dryRun: true,
      checkedPortfolios: (portfolios ?? []).length,
      duePortfolios: dueTargets.length,
      queuedRuns: 0,
      queuedRunIds: [],
    };
  }

  const queuedRunIds: string[] = [];
  for (const target of dueTargets) {
    const run = await createRun(adminDb(env), {
      userId: String(target.user_id),
      portfolioId: String(target.id),
      triggerType: "scheduled",
    });
    await queueRun(env, run);
    queuedRunIds.push(run.id);
  }

  return {
    source: options.source,
    dryRun: false,
    checkedPortfolios: (portfolios ?? []).length,
    duePortfolios: dueTargets.length,
    queuedRuns: queuedRunIds.length,
    queuedRunIds,
  };
}

async function runPortfolioContextTool(
  env: Env,
  input: { userId: string; portfolioId: string },
): Promise<PortfolioContextResult> {
  const client = adminDb(env);
  const [{ data: holdings, error: holdingsError }, { data: theses, error: thesesError }] =
    await Promise.all([
      client
        .from("holdings")
        .select("ticker,name,quantity")
        .eq("portfolio_id", input.portfolioId)
        .order("ticker", { ascending: true }),
      client
        .from("theses")
        .select("id,title,summary,body,evidence,horizon,conviction,tickers,status")
        .eq("user_id", input.userId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

  if (holdingsError) throw new Error(`portfolio_context holdings error: ${holdingsError.message}`);
  if (thesesError) throw new Error(`portfolio_context theses error: ${thesesError.message}`);

  const portfolioTickers = new Set((holdings ?? []).map((row) => String(row.ticker).toUpperCase()));
  const filteredTheses = (theses ?? []).filter((row) =>
    (row.tickers ?? []).some((ticker: string) => portfolioTickers.has(String(ticker).toUpperCase())),
  );

  return {
    portfolioId: input.portfolioId,
    holdings: (holdings ?? []).map((row) => ({
      ticker: String(row.ticker).toUpperCase(),
      name: String(row.name ?? row.ticker),
      quantity: Number(row.quantity ?? 0),
    })),
    theses: filteredTheses.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      summary: String(row.summary ?? ""),
      body: row.body ?? [],
      evidence: row.evidence ?? [],
      horizon: String(row.horizon ?? ""),
      conviction:
        row.conviction === "low" || row.conviction === "high" ? row.conviction : "med",
      tickers: (row.tickers ?? []).map((ticker: string) => String(ticker).toUpperCase()),
      status: String(row.status),
    })),
  };
}

async function runMarketQuotesTool(input: { tickers: string[] }): Promise<MarketQuotesResult> {
  const dedupedTickers = Array.from(new Set(input.tickers.map((ticker) => ticker.toUpperCase()))).slice(0, 30);
  if (dedupedTickers.length === 0) {
    return { tickers: [], quotes: [] };
  }

  const [quotesBySymbol, ytdChanges, sectorsBySymbol] = await Promise.all([
    getQuotesResilient(dedupedTickers),
    Promise.all(dedupedTickers.map((symbol) => getYtdChangePercent(symbol))),
    getSectorsForSymbols(dedupedTickers),
  ]);

  return {
    tickers: dedupedTickers,
    quotes: dedupedTickers.map((ticker, index) => {
      const quote = quotesBySymbol[ticker];
      return {
        ticker,
        currentPrice: quote?.currentPrice ?? null,
        change1dPercent: quote?.change1dPercent ?? null,
        ytdChangePercent: ytdChanges[index] ?? null,
        sector: sectorsBySymbol[ticker] ?? quote?.sector ?? "Other",
        assetType: quote?.assetType ?? null,
        lastPriceUpdatedAt: quote?.lastPriceUpdatedAt ?? null,
      };
    }),
  };
}

async function runEcbDataTool(input: { dataset?: string; lastNObservations?: number }): Promise<EcbDataResult> {
  const dataset = input.dataset || "FM/B.U2.EUR.4F.KR.MRR_FR.LEV";
  const url = new URL(`https://data-api.ecb.europa.eu/service/data/${dataset}`);
  url.searchParams.set("format", "csvdata");
  url.searchParams.set("lastNObservations", String(input.lastNObservations ?? 2));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "text/csv",
      "User-Agent": "binturong-trace-agent/1.0",
    },
  });
  if (!res.ok) throw new Error(`get_ecb_data failed (${res.status})`);
  const text = await res.text();
  const rows = text.split("\n").filter(Boolean);

  return {
    dataset,
    observations: rows.slice(-3).map((row) => {
      const cols = row.split(",");
      return {
        period: cols[cols.length - 2] ?? "",
        value: cols[cols.length - 1] ?? "",
      };
    }),
  };
}

async function runFredIndicatorTool(
  env: Env,
  input: { series_id: string; limit?: number },
): Promise<FredIndicatorResult> {
  if (!env.FRED_API_KEY) {
    throw new Error("get_fred_indicator requires FRED_API_KEY secret");
  }

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", input.series_id);
  url.searchParams.set("api_key", env.FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(input.limit ?? 3));

  const data = await fetchJson<{ observations?: Array<{ date?: string; value?: string }> }>(url.toString());
  return {
    series_id: input.series_id,
    observations: (data.observations ?? []).map((row) => ({
      date: row.date ?? "",
      value: row.value ?? "",
    })),
  };
}

function inferSourceFromUrl(rawUrl: string): string {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
    return hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function parseIsoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isStaleByRecency(publishedAt: string | null, recencyDays: number): boolean {
  if (!publishedAt) return false;
  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) return false;
  const ageMs = Date.now() - publishedMs;
  return ageMs > recencyDays * 24 * 60 * 60 * 1000;
}

async function runWebSearchTool(
  env: Env,
  input: { query: string; limit?: number; recencyDays?: number; locale?: string },
): Promise<NewsSearchResult> {
  if (!env.GROK_SUB_API_KEY) {
    throw new Error("Missing GROK_SUB_API_KEY for xAI web search");
  }
  const limit = Math.max(1, Math.min(10, Number(input.limit ?? 6)));
  const recencyDays = Math.max(1, Math.min(365, Number(input.recencyDays ?? 60)));
  const locale = (input.locale ?? "en-US").trim() || "en-US";
  const webSearchModel = (env.GROK_WEB_SEARCH_MODEL ?? "grok-4-1-fast-reasoning").trim();

  const body = {
    model: webSearchModel,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Find recent web evidence for query: ${input.query}`,
              `Locale: ${locale}. Return up to ${limit} results.`,
              "Return strict JSON only in this format:",
              '{ "items": [{ "title": "...", "url": "...", "source": "...", "published_at": null, "snippet": "..." }] }',
              "Do not include markdown.",
            ].join("\n"),
          },
        ],
      },
    ],
    tools: [{ type: "web_search" }],
  };
  const res = await fetch(`${getGrokBaseUrl(env)}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROK_SUB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI web search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const outputText = outputTextFromResponse(raw);

  let rows: Array<Record<string, unknown>> = [];
  try {
    const parsed = extractJsonObject(outputText);
    rows = Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [];
  } catch {
    rows = [];
  }

  if (rows.length === 0 && Array.isArray(raw.citations)) {
    rows = (raw.citations as Array<Record<string, unknown>>).map((citation) => ({
      title: citation.title ?? citation.name ?? "Untitled",
      url: citation.url ?? citation.link ?? "",
      source: citation.publisher ?? citation.source ?? null,
      published_at: citation.published_at ?? citation.date ?? null,
      snippet: citation.snippet ?? citation.text ?? "",
    }));
  }

  const items = rows.slice(0, limit).map((row) => {
    const url = String(row.url ?? row.link ?? "");
    const publishedAt = parseIsoDateOrNull(row.published_at ?? row.date ?? row.publishedAt);
    return {
      title: String(row.title ?? "Untitled"),
      url,
      source: String(row.source ?? row.publisher ?? inferSourceFromUrl(url)),
      snippet: String(row.snippet ?? row.summary ?? ""),
      published_at: publishedAt,
      is_stale: isStaleByRecency(publishedAt, recencyDays),
    };
  });
  if (items.length === 0) {
    throw new Error("xAI web search returned no parseable items");
  }
  return {
    query: input.query,
    items,
    provider: "xai_web_search",
    recencyDays,
    totalRetrieved: rows.length || items.length,
  };
}

function outputTextFromResponse(raw: Record<string, unknown>): string {
  if (typeof raw.output_text === "string") return raw.output_text;
  if (!Array.isArray(raw.output)) return "";
  return (raw.output as Array<Record<string, unknown>>)
    .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
    .map((content) => String(content.text ?? ""))
    .join("\n");
}

async function runNewsSearchTool(
  input: { query: string; limit?: number; recencyDays?: number },
): Promise<NewsSearchResult> {
  const encoded = encodeURIComponent(input.query);
  const recencyDays = Math.max(1, Math.min(365, Number(input.recencyDays ?? 60)));
  const url = `https://news.google.com/rss/search?q=${encoded}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`search_news failed (${res.status})`);
  const xml = await res.text();
  const items = Array.from(xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g))
    .slice(0, input.limit ?? 6)
    .map((match) => ({
      title: match[1]?.replace(/<!\[CDATA\[|\]\]>/g, "") ?? "",
      url: match[2] ?? "",
      source: inferSourceFromUrl(match[2] ?? ""),
      snippet: "",
      published_at: null,
      is_stale: false,
    }));

  return {
    query: input.query,
    items,
    provider: "google_rss_fallback",
    recencyDays,
    totalRetrieved: items.length,
  };
}

function createGuardrailState(): GuardrailState {
  return {
    startedMs: Date.now(),
    totalCalls: 0,
    callsByTool: {
      portfolio_context: 0,
      market_quotes: 0,
      get_ecb_data: 0,
      get_fred_indicator: 0,
      search_news: 0,
    },
    maxTotalCalls: 12,
    perToolLimit: 4,
    maxDurationMs: 45_000,
  };
}

function getGrokBaseUrl(env: Env): string {
  return (env.GROK_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "");
}

async function invokeGrok(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  env: Env,
): Promise<string> {
  const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Grok API error (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as GrokChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Grok response did not include content");
  return content;
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error("Model output is not valid JSON");
  }
}

function normalizeSubAgentOutput(raw: Record<string, unknown>): SubAgentOutput {
  const evidenceRaw = Array.isArray(raw.evidence_items) ? raw.evidence_items : [];
  const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];
  const missingInfoRaw = Array.isArray(raw.missing_info) ? raw.missing_info : [];
  const retrievalMeta = (raw.retrieval_meta ?? {}) as Record<string, unknown>;
  const normalizedEvidence = evidenceRaw
    .map((item) => {
      const row = item as Record<string, unknown>;
      const url = String(row.url ?? "");
      if (!/^https?:\/\//i.test(url)) return null;
      return {
        id: String(row.id ?? ""),
        thesis_id: String(row.thesis_id ?? ""),
        claim: String(row.claim ?? ""),
        snippet: String(row.snippet ?? ""),
        url,
        source: String(row.source ?? inferSourceFromUrl(url)),
        published_at: parseIsoDateOrNull(row.published_at),
        is_stale: Boolean(row.is_stale),
        staleness_reason: row.staleness_reason == null ? null : String(row.staleness_reason),
        relevance_score: Math.min(100, Math.max(0, Number(row.relevance_score ?? 50))),
        tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)) : [],
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> =>
        !!item && Boolean(item.id) && Boolean(item.thesis_id) && Boolean(item.claim),
    );

  const legacyEvidence = findingsRaw
    .map((item, index) => {
      const row = item as Record<string, unknown>;
      const rawSources = Array.isArray(row.raw_sources)
        ? row.raw_sources.map((source) => String(source))
        : [];
      const url = rawSources.find((source) => /^https?:\/\//i.test(source)) ?? "";
      if (!url) return null;
      const thesisId = String(row.thesis_id ?? "");
      const claim = String(row.title ?? row.explanation ?? "");
      if (!thesisId || !claim) return null;
      return {
        id: `${thesisId}:legacy:${index}`,
        thesis_id: thesisId,
        claim,
        snippet: String(row.explanation ?? ""),
        url,
        source: inferSourceFromUrl(url),
        published_at: null,
        is_stale: false,
        staleness_reason: "legacy_sub_agent_format",
        relevance_score: Math.min(100, Math.max(0, Number(row.relevance_score ?? 50))),
        tags: ["legacy_findings"],
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);

  const evidenceItems = normalizedEvidence.length > 0 ? normalizedEvidence : legacyEvidence;
  return {
    evidence_items: evidenceItems,
    missing_info: missingInfoRaw.map((value) => String(value)),
    retrieval_meta: {
      query: String(retrievalMeta.query ?? ""),
      provider:
        retrievalMeta.provider === "google_rss_fallback" ? "google_rss_fallback" : "xai_web_search",
      recency_days: Math.max(1, Math.min(365, Number(retrievalMeta.recency_days ?? 60))),
      total_retrieved: Math.max(0, Number(retrievalMeta.total_retrieved ?? 0)),
      total_kept: Math.max(0, Number(retrievalMeta.total_kept ?? 0)),
      total_stale: Math.max(0, Number(retrievalMeta.total_stale ?? 0)),
    },
  };
}

function normalizeMainAgentOutput(raw: Record<string, unknown>): MainAgentOutput {
  const signalsRaw = Array.isArray(raw.signals) ? raw.signals : [];
  return {
    signals: signalsRaw
      .map((item) => {
        const row = item as Record<string, unknown>;
        const signalType = String(row.signal_type ?? "neutral");
        if (!["at_risk", "supportive", "watch", "neutral"].includes(signalType)) return null;
        const riskHorizon = row.risk_horizon == null ? null : String(row.risk_horizon);
        const changeTypeRaw = String(row.change_type ?? "new_information");
        const changeType: "new_information" | "confirmation" | "contradiction" | "no_material_change" =
          changeTypeRaw === "confirmation" ||
          changeTypeRaw === "contradiction" ||
          changeTypeRaw === "no_material_change"
            ? changeTypeRaw
            : "new_information";
        return {
          thesis_id: String(row.thesis_id ?? ""),
          signal_type: signalType as "at_risk" | "supportive" | "watch" | "neutral",
          title: String(row.title ?? ""),
          explanation: String(row.explanation ?? ""),
          risk_horizon:
            riskHorizon && ["short_term", "long_term"].includes(riskHorizon)
              ? (riskHorizon as "short_term" | "long_term")
              : null,
          confidence: Math.min(100, Math.max(0, Number(row.confidence ?? 50))),
          evidence_ids: Array.isArray(row.evidence_ids)
            ? row.evidence_ids.map((id) => String(id)).filter(Boolean)
            : [],
          assumptions: Array.isArray(row.assumptions)
            ? row.assumptions.map((assumption) => String(assumption))
            : [],
          no_evidence_reason:
            row.no_evidence_reason == null ? null : String(row.no_evidence_reason),
          change_type: changeType,
          delta_summary: row.delta_summary == null ? null : String(row.delta_summary),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item),
    overall_summary: String(raw.overall_summary ?? ""),
    questions_for_user: Array.isArray(raw.questions_for_user)
      ? raw.questions_for_user.map((question) => String(question))
      : [],
  };
}

function validateMainAgentOutput(output: MainAgentOutput): void {
  for (const signal of output.signals) {
    if (signal.signal_type !== "neutral" && signal.evidence_ids.length === 0 && !signal.no_evidence_reason) {
      throw new Error("Model output missing required items: non-neutral signal missing evidence_ids");
    }
  }
}

function assertGuardrails(state: GuardrailState, tool: AgentToolName): void {
  if (Date.now() - state.startedMs > state.maxDurationMs) {
    throw new Error("Guardrail: run exceeded max duration");
  }
  if (state.totalCalls >= state.maxTotalCalls) {
    throw new Error("Guardrail: max tool calls exceeded");
  }
  if (state.callsByTool[tool] >= state.perToolLimit) {
    throw new Error(`Guardrail: per-tool call limit exceeded for ${tool}`);
  }
}

async function runToolWithGuardrails<TInput, TOutput>(
  state: GuardrailState,
  callLog: AgentToolCall[],
  tool: AgentToolName,
  input: TInput,
  runner: (input: TInput) => Promise<TOutput>,
): Promise<TOutput> {
  assertGuardrails(state, tool);
  state.totalCalls += 1;
  state.callsByTool[tool] += 1;

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const output = await runner(input);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  callLog.push({
    tool,
    startedAt,
    finishedAt,
    durationMs,
    inputSummary: {
      keys: Object.keys((input ?? {}) as Record<string, unknown>),
    },
    outputSummary:
      tool === "portfolio_context"
        ? {
            holdings: (output as PortfolioContextResult).holdings.length,
            theses: (output as PortfolioContextResult).theses.length,
          }
        : tool === "market_quotes"
          ? {
            quotes: (output as MarketQuotesResult).quotes.length,
            }
          : tool === "get_ecb_data"
            ? {
                observations: (output as EcbDataResult).observations.length,
              }
            : tool === "get_fred_indicator"
              ? {
                  observations: (output as FredIndicatorResult).observations.length,
                }
              : {
                  items: (output as NewsSearchResult).items.length,
                },
  });

  return output;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY || !env.SUPABASE_ANON_KEY) {
      return json(
        {
          error:
            "Server misconfiguration: SUPABASE_URL, SUPABASE_SERVICE_KEY, or SUPABASE_ANON_KEY is missing",
        },
        500,
      );
    }

    // GET /api/health
    if (method === "GET" && pathname === "/api/health") {
      let supabase = "not_checked";
      try {
        const { error } = await adminDb(env).from("portfolios").select("id").limit(1);
        supabase = error ? "error" : "connected";
      } catch {
        supabase = "error";
      }
      return json({ status: "ok", supabase, timestamp: new Date().toISOString() });
    }

    // POST /api/expenses/import/preview — normalize a bank/card CSV into expense rows
    // via the LLM (Grok). User-scoped (expenses are owner-owned, not portfolio-scoped).
    // Writes nothing: the web client confirms + inserts via RLS (per the direct-client
    // write decision). Mirrors /api/portfolios/:id/transactions/preview.
    if (method === "POST" && pathname === "/api/expenses/import/preview") {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      if (!env.GROK_NORMALIZATION_API_KEY) {
        return json({ error: "Server misconfiguration: GROK_NORMALIZATION_API_KEY is missing" }, 500);
      }

      const body = (await request.json().catch(() => ({}))) as { csv?: string };
      const csv = String(body.csv ?? "");
      if (!csv.trim()) return json({ error: "csv is required" }, 400);

      const instructions = [
        "You are a personal-finance data normalizer. Map each bank or card CSV row to this exact schema:",
        "posted_at: ISO date YYYY-MM-DD.",
        "merchant_name: cleaned merchant or payee name (strip card/ref noise).",
        "amount: positive number string of the absolute value (no sign, keep decimals).",
        "currency: 3-letter ISO code; default EUR if absent.",
        'kind: "spend" for money out, "income" for money in (salary, refunds treated as income).',
        "is_recurring: true for rent, utilities, subscriptions, insurance, loan repayments, and salary; false for one-off purchases.",
        "pfc_primary: ONE of exactly these Plaid PFCv2 primary categories:",
        "INCOME, TRANSFER_IN, TRANSFER_OUT, LOAN_PAYMENTS, BANK_FEES, ENTERTAINMENT, FOOD_AND_DRINK, GENERAL_MERCHANDISE, HOME_IMPROVEMENT, MEDICAL, PERSONAL_CARE, GENERAL_SERVICES, GOVERNMENT_AND_NON_PROFIT, TRANSPORTATION, TRAVEL, RENT_AND_UTILITIES.",
        "external_ref: the bank's own transaction id/reference if such a column exists, else null.",
        "confidence: number 0 to 1 for how sure you are of pfc_primary and kind.",
        "Rules: do not invent missing data; skip empty/summary/balance rows. Keep amounts positive.",
        'Return only JSON: { "columns_detected": string[], "rows": [ { posted_at, merchant_name, amount, currency, kind, is_recurring, pfc_primary, external_ref, confidence } ], "errors": string[] }',
        "",
        "Disambiguation rules:",
        "- Payment processors (SQ *, SQUARE, PAYPAL *, SP *, TST*, IZ *, ZTL*) are NOT the merchant: strip the prefix and categorize by the underlying name that follows.",
        "- is_recurring=true ONLY for charges that clearly repeat on a schedule: rent, utilities, insurance, loan/mortgage repayments, named subscriptions (Netflix, Spotify, gym, mobile plans), and salary. A one-off purchase at a recurring-looking merchant stays false.",
        "- Account transfers and credit-card repayments → TRANSFER_OUT (money out) or TRANSFER_IN (money in). Salary and refunds → kind=income.",
        "- Lower confidence (≤0.4) when the descriptor is cryptic or the category is a genuine guess.",
        "Examples (raw descriptor → key fields):",
        '  "TFL TRAVEL CH LONDON GB" → merchant_name="Transport for London", kind="spend", is_recurring=false, pfc_primary="TRANSPORTATION"',
        '  "UBER *EATS help.uber.com" → merchant_name="Uber Eats", kind="spend", is_recurring=false, pfc_primary="FOOD_AND_DRINK"',
        '  "SQ *BLUE BOTTLE COFFEE" → merchant_name="Blue Bottle Coffee", kind="spend", is_recurring=false, pfc_primary="FOOD_AND_DRINK"',
        '  "PAYPAL *STEAMGAMES 4029357" → merchant_name="Steam Games", kind="spend", is_recurring=false, pfc_primary="ENTERTAINMENT"',
        '  "NETFLIX.COM 8662232" → merchant_name="Netflix", kind="spend", is_recurring=true, pfc_primary="ENTERTAINMENT"',
        '  "THAMES WATER DD" → merchant_name="Thames Water", kind="spend", is_recurring=true, pfc_primary="RENT_AND_UTILITIES"',
        '  "ACME LTD SALARY JUN" → merchant_name="Acme Ltd", kind="income", is_recurring=true, pfc_primary="INCOME"',
        '  "MONTHLY ACCOUNT FEE" → merchant_name="Account fee", kind="spend", is_recurring=true, pfc_primary="BANK_FEES"',
        "",
        "The first CSV line below is the header (column names) — use it to read the columns but do NOT emit a row for it.",
      ];

      // A single LLM call over a large CSV is dominated by OUTPUT-token generation: hundreds
      // of rows × ~9 fields is tens of thousands of tokens emitted sequentially, which blows
      // any reasonable timeout no matter how trivial each row is. So split the rows into small
      // batches and normalize them concurrently — wall-clock collapses to roughly one batch,
      // and a slow/failed batch degrades to a skip-with-error instead of failing the import.
      const allLines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const header = allLines[0] ?? "";
      let dataLines = allLines.slice(1);

      const MAX_ROWS = 1000;
      const preErrors: string[] = [];
      if (dataLines.length > MAX_ROWS) {
        preErrors.push(
          `Only the first ${MAX_ROWS} of ${dataLines.length} rows were processed — re-upload the rest separately.`,
        );
        dataLines = dataLines.slice(0, MAX_ROWS);
      }
      if (dataLines.length === 0) {
        return json({ columns_detected: [], rows: [], errors: ["No data rows found in the CSV."] });
      }

      const CHUNK_SIZE = 50;
      const chunks: string[] = [];
      for (let i = 0; i < dataLines.length; i += CHUNK_SIZE) {
        chunks.push([header, ...dataLines.slice(i, i + CHUNK_SIZE)].join("\n"));
      }

      type ChunkResult = { columns: string[]; rows: unknown[]; errors: string[] };
      const normalizeChunk = async (chunkCsv: string): Promise<ChunkResult> => {
        const prompt = [...instructions, "", "CSV:", chunkCsv].join("\n");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
          const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.GROK_NORMALIZATION_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              // Dedicated model for expense normalization (decoupled from GROK_WEB_SEARCH_MODEL).
              // Small batches make reasoning affordable again: grok-4.3 at reasoning_effort
              // "low" sharpens category/recurring inference without blowing the per-batch bound.
              model: env.GROK_NORMALIZATION_MODEL || "grok-4.3",
              reasoning_effort: env.GROK_NORMALIZATION_EFFORT || "low",
              messages: [{ role: "user", content: prompt }],
              response_format: { type: "json_object" },
              max_tokens: 16000,
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const text = await res.text();
            return { columns: [], rows: [], errors: [`A batch failed (${res.status}): ${text.slice(0, 150)}`] };
          }
          const llmData = (await res.json()) as GrokChatResponse;
          const content: string = llmData.choices?.[0]?.message?.content ?? "";
          const stripped = content
            .trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(stripped) as Record<string, unknown>;
          } catch {
            const start = stripped.indexOf("{");
            const end = stripped.lastIndexOf("}");
            if (start >= 0 && end > start) {
              parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
            } else {
              return { columns: [], rows: [], errors: ["A batch returned unparseable content and was skipped."] };
            }
          }
          return {
            columns: Array.isArray(parsed.columns_detected) ? (parsed.columns_detected as string[]) : [],
            rows: Array.isArray(parsed.rows) ? (parsed.rows as unknown[]) : [],
            errors: Array.isArray(parsed.errors) ? (parsed.errors as string[]) : [],
          };
        } catch (error) {
          const message =
            error instanceof Error && error.name === "AbortError"
              ? "A batch timed out and was skipped."
              : error instanceof Error
                ? error.message
                : "A batch failed.";
          return { columns: [], rows: [], errors: [message] };
        } finally {
          clearTimeout(timeout);
        }
      };

      // Bounded concurrency: several batches at once, but not all of them if the CSV is large
      // (stays under subrequest/rate limits). A shared cursor hands each worker the next chunk.
      const CONCURRENCY = 8;
      const results: ChunkResult[] = new Array(chunks.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
          for (let index = cursor++; index < chunks.length; index = cursor++) {
            results[index] = await normalizeChunk(chunks[index]);
          }
        }),
      );

      const rows = results.flatMap((r) => r.rows);
      const columns_detected = Array.from(new Set(results.flatMap((r) => r.columns)));
      const errors = [...preErrors, ...results.flatMap((r) => r.errors)];

      // Total failure only when every batch produced nothing; otherwise return the partial
      // rows plus the per-batch errors (the review UI surfaces them).
      if (rows.length === 0) {
        return json({ error: errors[0] ?? "Normalization produced no rows" }, 502);
      }
      return json({ columns_detected, rows, errors });
    }

    if (method === "GET" && pathname === "/api/benchmarks/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json([]);
      try {
        const results = await searchYahooAssets(q);
        return json(results.map((result) => ({ name: result.name, ticker: result.ticker })));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Benchmark search failed" }, 500);
      }
    }

    if (method === "POST" && pathname === "/api/benchmarks/suggest") {
      const body = (await request.json().catch(() => ({}))) as { portfolioId?: string };
      const portfolioId = String(body.portfolioId ?? "").trim();
      if (!portfolioId) return json({ error: "portfolioId is required" }, 400);
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
      if (!env.GROK_NORMALIZATION_API_KEY) {
        return json({ error: "Server misconfiguration: GROK_NORMALIZATION_API_KEY is missing" }, 500);
      }

      try {
        const holdingsPayload = await buildBenchmarkSuggestionHoldingsPayload(auth.db, portfolioId);
        if (holdingsPayload.length === 0) return json([]);
        const { summaryString, holdingsPromptPayload } = await buildBenchmarkPortfolioSummary(
          env,
          portfolioId,
          holdingsPayload,
        );
        const systemPrompt = [
          "You are a portfolio analyst choosing benchmark concepts for a portfolio.",
          "Use your model knowledge first; do not assume web search is available.",
          "Given holdings with ISINs, names, weights, sectors, and geographies, infer 1 to 3 appropriate benchmark concepts, prioritizing indices over ETFs over funds.",
          "The frontend can only overlay instruments available through Yahoo Finance, so include precise Yahoo Finance search queries for each concept.",
          "Use needsWebSearch=true only when the concept is uncertain or needs external clarification before it can be resolved to a Yahoo Finance index, ETF, or fund.",
          "Return strict JSON only, no markdown, as an array of objects with: name, reason, yahooSearchQueries, confidence, needsWebSearch.",
        ].join(" ");
        const userPrompt = `What benchmark can I use to compare my portfolio's performance to?

${summaryString}

Holdings detail:
${JSON.stringify(holdingsPromptPayload, null, 2)}`;
        const content = await invokeGrok(
          env.GROK_NORMALIZATION_API_KEY,
          "grok-4.20-0309-reasoning",
          systemPrompt,
          userPrompt,
          env,
        );
        const concepts = parseBenchmarkConcepts(content);
        const { suggestions, diagnostics } = await resolveBenchmarkConcepts(env, concepts);
        console.log(
          "benchmark_suggest_diagnostics",
          JSON.stringify({
            portfolioId,
            ...diagnostics,
          }),
        );
        return json(suggestions);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Benchmark suggestions failed" }, 500);
      }
    }

    const benchmarkPricesMatch = pathname.match(/^\/api\/benchmarks\/([^/]+)\/prices$/);
    if (benchmarkPricesMatch && method === "GET") {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      const ticker = decodeURIComponent(benchmarkPricesMatch[1]);
      const from = (url.searchParams.get("from") || "").trim();
      if (!from) return json({ error: "from is required" }, 400);
      try {
        return json(await getBenchmarkPrices(env, ticker, from));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Benchmark price fetch failed" }, 500);
      }
    }

    // Portfolios
    if (pathname === "/api/portfolios") {
      if (method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
        const { data, error } = await auth.db.from("portfolios").select("*");
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (method === "POST") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
        const body = (await request.json()) as Record<string, unknown>;
        // Ownership is forced from the verified token — never from the body.
        const payload = { ...pickColumns(body, PORTFOLIO_WRITE_COLUMNS), user_id: auth.userId };
        const { data, error } = await auth.db.from("portfolios").insert(payload).select();
        if (error) return json({ error: error.message }, 500);
        return json(data, 201);
      }
    }

    const portfolioMatch = pathname.match(/^\/api\/portfolios\/([^/]+)$/);
    if (portfolioMatch) {
      const id = portfolioMatch[1];
      const auth = await requirePortfolioAccess(request, env, id);
        if (auth instanceof Response) return auth;
      if (method === "GET") {
        const { data, error } = await auth.db.from("portfolios").select("*").eq("id", id).single();
        if (error) return json({ error: error.message }, 404);
        return json(data);
      }
      if (method === "PUT") {
        const body = (await request.json()) as Record<string, unknown>;
        const payload = pickColumns(body, PORTFOLIO_WRITE_COLUMNS);
        const { data, error } = await auth.db
          .from("portfolios")
          .update(payload)
          .eq("id", id)
          .select();
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (method === "DELETE") {
        const { error } = await auth.db.from("portfolios").delete().eq("id", id);
        if (error) return json({ error: error.message }, 500);
        return json({ deleted: true });
      }
    }

    const savedBenchmarksMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/benchmarks\/saved$/);
    if (savedBenchmarksMatch) {
      const portfolioId = savedBenchmarksMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      if (method === "GET") {
        const { data, error } = await auth.db
          .from("saved_benchmarks")
          .select("id, portfolio_id, name, ticker, weights, color, created_at")
          .eq("portfolio_id", portfolioId)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 500);
        return json({ benchmarks: data ?? [] });
      }

      if (method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          name?: string;
          ticker?: string;
          weights?: unknown;
          color?: string;
        };
        const name = String(body.name ?? "").trim();
        const ticker = String(body.ticker ?? "").trim().toUpperCase();
        if (!name || !ticker) return json({ error: "name and ticker are required" }, 400);

        const palette = ["amber", "violet", "rose", "sky"];
        const { data: existing, error: existingError } = await auth.db
          .from("saved_benchmarks")
          .select("color")
          .eq("portfolio_id", portfolioId);
        if (existingError) return json({ error: existingError.message }, 500);
        const usedColors = new Set((existing ?? []).map((row) => String(row.color)));
        const color =
          String(body.color ?? "").trim() ||
          palette.find((candidate) => !usedColors.has(candidate)) ||
          palette[(existing?.length ?? 0) % palette.length];
        const { data, error } = await auth.db
          .from("saved_benchmarks")
          .insert({
            portfolio_id: portfolioId,
            name,
            ticker,
            weights: body.weights ?? null,
            color,
          })
          .select("id, portfolio_id, name, ticker, weights, color, created_at")
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(data, 201);
      }
    }

    const savedBenchmarkMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/benchmarks\/saved\/([^/]+)$/);
    if (savedBenchmarkMatch) {
      const [, portfolioId, benchmarkId] = savedBenchmarkMatch;
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      if (method === "DELETE") {
        const { error } = await auth.db
          .from("saved_benchmarks")
          .delete()
          .eq("id", benchmarkId)
          .eq("portfolio_id", portfolioId);
        if (error) return json({ error: error.message }, 500);
        return json({ deleted: benchmarkId });
      }

      if (method === "PATCH") {
        const body = (await request.json().catch(() => ({}))) as { color?: string };
        const color = String(body.color ?? "").trim();
        const palette = new Set(["amber", "violet", "rose", "sky"]);
        if (!palette.has(color)) return json({ error: "Invalid benchmark color" }, 400);

        const { data: target, error: targetError } = await auth.db
          .from("saved_benchmarks")
          .select("id, color")
          .eq("id", benchmarkId)
          .eq("portfolio_id", portfolioId)
          .single();
        if (targetError || !target) return json({ error: "Saved benchmark not found" }, 404);

        const { data: occupied, error: occupiedError } = await auth.db
          .from("saved_benchmarks")
          .select("id, color")
          .eq("portfolio_id", portfolioId)
          .eq("color", color)
          .maybeSingle();
        if (occupiedError) return json({ error: occupiedError.message }, 500);

        const client = auth.db;
        const updatedIds = [benchmarkId];
        if (occupied && String(occupied.id) !== benchmarkId) {
          updatedIds.push(String(occupied.id));
          const { error: swapError } = await client
            .from("saved_benchmarks")
            .update({ color: String(target.color) })
            .eq("id", String(occupied.id))
            .eq("portfolio_id", portfolioId);
          if (swapError) return json({ error: swapError.message }, 500);
        }

        const { error: updateError } = await client
          .from("saved_benchmarks")
          .update({ color })
          .eq("id", benchmarkId)
          .eq("portfolio_id", portfolioId);
        if (updateError) return json({ error: updateError.message }, 500);

        const { data, error } = await client
          .from("saved_benchmarks")
          .select("id, portfolio_id, name, ticker, weights, color, created_at")
          .in("id", updatedIds);
        if (error) return json({ error: error.message }, 500);
        return json({ benchmarks: data ?? [] });
      }
    }

    const recomputeMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/recompute$/);
    if (recomputeMatch && method === "POST") {
      const portfolioId = recomputeMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
      console.log("[recompute] triggered for portfolio", portfolioId);
      await recomputeSnapshots(env, portfolioId);
      console.log("[recompute] done");
      return json({ ok: true });
    }

    const transactionPreviewMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/transactions\/preview$/);
    if (transactionPreviewMatch && method === "POST") {
      const portfolioId = transactionPreviewMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
      if (!env.GROK_NORMALIZATION_API_KEY) {
        return json({ error: "Server misconfiguration: GROK_NORMALIZATION_API_KEY is missing" }, 500);
      }

      const body = (await request.json().catch(() => ({}))) as { csv?: string };
      const csv = String(body.csv ?? "");
      if (!csv.trim()) return json({ error: "csv is required" }, 400);

      const prompt = [
        "You are a financial data normalizer. Map broker CSV transaction rows to this exact schema:",
        "date: ISO date YYYY-MM-DD. symbol: security name or CASH. isin: ISIN or null.",
        "side: one of BUY, SELL, DEP, WD, DIV, FEE.",
        "quantity: raw string share quantity, null for cash/fee rows.",
        "net_amount: raw string signed cash impact, negative for BUY/FEE/WD, positive for SELL/DEP/DIV.",
        "commission: raw string fee amount, default 0.",
        "Rules: return raw number strings with currency symbols unchanged; do not invent missing data.",
        "Refunds/reimbursements are DEP. Standalone tax/stamp-duty rows are FEE.",
        'Return only JSON: { "columns_detected": string[], "rows": [...], "errors": string[] }',
        "",
        "CSV:",
        csv.slice(0, 100000),
      ].join("\n");

      try {
        const res = await fetch(`${getGrokBaseUrl(env)}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GROK_NORMALIZATION_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.GROK_WEB_SEARCH_MODEL || "grok-4-1-fast-non-reasoning",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 32000,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return json({ error: `Normalization failed (${res.status}): ${text.slice(0, 300)}` }, 502);
        }
        const llmData = (await res.json()) as GrokChatResponse;
        const content: string = llmData.choices?.[0]?.message?.content ?? "";

        console.log("[csv-preview] finish_reason:", llmData.choices?.[0]?.finish_reason);
        console.log("[csv-preview] content length:", content.length);
        console.log("[csv-preview] content snippet:", content.slice(0, 300));

        const stripped = content
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(stripped) as Record<string, unknown>;
        } catch {
          const start = stripped.indexOf("{");
          const end = stripped.lastIndexOf("}");
          if (start >= 0 && end > start) {
            parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
          } else {
            throw new Error(`LLM returned unparseable content: ${stripped.slice(0, 300)}`);
          }
        }
        return json(parsed);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Preview failed" }, 500);
      }
    }

    const transactionsMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/transactions$/);
    if (transactionsMatch) {
      const portfolioId = transactionsMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      if (method === "GET") {
        const { data, error } = await auth.db
          .from("transactions")
          .select("id, date, symbol, isin, yahoo_ticker, side, quantity, net_amount, commission")
          .eq("portfolio_id", portfolioId)
          .order("date", { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json({ transactions: data ?? [] });
      }

      if (method === "POST") {
        if (!env.SNAPSHOT_QUEUE) {
          return json({ error: "Server misconfiguration: SNAPSHOT_QUEUE binding is missing" }, 500);
        }
        const body = (await request.json().catch(() => ({}))) as { rows?: NormalisedTransactionRow[] };
        const normalizedRows = normalizeTransactionRows(Array.isArray(body.rows) ? body.rows : []);
        if (normalizedRows.length === 0) return json({ error: "rows are required" }, 400);

        const parsedRows = normalizedRows.map((row) => ({
          ...row,
          quantity: row.quantity == null ? null : parseFlexibleNumber(row.quantity),
          net_amount: row.net_amount == null ? null : parseFlexibleNumber(row.net_amount),
          commission: parseFlexibleNumber(row.commission ?? "0"),
        }));
        const uniqueIsins = Array.from(new Set(parsedRows.map((row) => row.isin).filter(Boolean))) as string[];
        const assetEntries = await Promise.all(
          uniqueIsins.map(async (isin) => {
            try {
              const match = (await searchYahooAssets(isin))[0] ?? null;
              return [isin, match] as const;
            } catch {
              return [isin, null] as const;
            }
          }),
        );
        const assetsByIsin = new Map(assetEntries);
        const primaryExchangeCounts = new Map<string, number>();
        const dbRows = parsedRows.map((row) => {
          const asset = row.isin ? assetsByIsin.get(row.isin) : null;
          const primaryExchange = yahooExchangeToPrimary(asset?.exchange, asset?.ticker);
          if (primaryExchange) {
            primaryExchangeCounts.set(primaryExchange, (primaryExchangeCounts.get(primaryExchange) ?? 0) + 1);
          }
          return {
            portfolio_id: portfolioId,
            date: row.date,
            symbol: row.symbol,
            isin: row.isin,
            yahoo_ticker: row.yahoo_ticker ?? (row.isin ? (asset?.ticker ?? null) : null),
            side: row.side,
            quantity: row.quantity,
            net_amount: row.net_amount,
            commission: row.commission,
          };
        });

        const { error } = await auth.db.from("transactions").insert(dbRows);
        if (error) return json({ error: error.message }, 500);

        const primaryExchange = [...primaryExchangeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (primaryExchange) {
          await auth.db.from("portfolios").update({ primary_exchange: primaryExchange }).eq("id", portfolioId);
        }
        await rebuildCurrentHoldings(env, portfolioId);
        await syncAndEnqueueGeography(env, portfolioId, "transaction_import");
        await env.SNAPSHOT_QUEUE.send({ type: "full_rebuild", portfolio_id: portfolioId });
        return json({ inserted: dbRows.length }, 201);
      }
    }

    const chartMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/chart$/);
    if (chartMatch && method === "GET") {
      const portfolioId = chartMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      const [{ data: snapshots, error: snapshotsError }, { data: txns, error: txnsError }] = await Promise.all([
        auth.db
          .from("portfolio_snapshots")
          .select("date, total_value, cash_balance, securities_value")
          .eq("portfolio_id", portfolioId)
          .order("date", { ascending: true }),
        auth.db
          .from("transactions")
          .select("date, side, net_amount")
          .eq("portfolio_id", portfolioId)
          .order("date", { ascending: true }),
      ]);
      if (snapshotsError) return json({ error: snapshotsError.message }, 500);
      if (txnsError) return json({ error: txnsError.message }, 500);
      if (!snapshots || snapshots.length === 0) return json({ series: [] });

      const flowByDate = new Map<string, number>();
      for (const txn of txns ?? []) {
        if (txn.side !== "DEP" && txn.side !== "WD") continue;
        const date = String(txn.date);
        flowByDate.set(date, (flowByDate.get(date) ?? 0) + Number(txn.net_amount ?? 0));
      }

      const twrByDate = computeDailyTwrByDate(snapshots, flowByDate);

      let runningDeposits = 0;
      const series = snapshots.map((snap) => {
        const date = String(snap.date);
        runningDeposits += flowByDate.get(date) ?? 0;
        const totalValue = Number(snap.total_value ?? 0);
        const simpleReturn = runningDeposits > 0 ? ((totalValue - runningDeposits) / runningDeposits) * 100 : 0;
        return {
          date,
          total_value: totalValue,
          cash_balance: Number(snap.cash_balance ?? 0),
          securities_value: Number(snap.securities_value ?? 0),
          simple_return_pct: Math.round(simpleReturn * 100) / 100,
          twr_pct: Math.round((twrByDate.get(date) ?? 0) * 100) / 100,
        };
      });

      return json({ series });
    }

    const lastPricesMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/last-prices$/);
    if (lastPricesMatch && method === "GET") {
      const portfolioId = lastPricesMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      const { data: holdings, error: holdingsError } = await auth.db
        .from("holdings")
        .select("ticker")
        .eq("portfolio_id", portfolioId);
      if (holdingsError) return json({ error: holdingsError.message }, 500);

      const tickers = Array.from(
        new Set(
          (holdings ?? [])
            .map((row) => String(row.ticker ?? "").trim().toUpperCase())
            .filter(Boolean),
        ),
      );
      if (tickers.length === 0) return json([]);

      const results = await Promise.all(
        tickers.map(async (ticker) => {
          const { data, error } = await auth.db
            .from("price_history")
            .select("date, closing_price")
            .eq("yahoo_ticker", ticker)
            .order("date", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (error || !data) return { ticker, date: null, close: null };
          return {
            ticker,
            date: String(data.date),
            close: Number(data.closing_price),
          };
        }),
      );

      return json(results);
    }

    const geographyMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/geography$/);
    if (geographyMatch) {
      const portfolioId = geographyMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      try {
        if (method === "GET") return json(await getPortfolioGeography(env, portfolioId));
        if (method === "POST") {
          const result = await recomputePortfolioGeography(env, portfolioId);
          return json(result);
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Geography failed" }, 500);
      }
    }

    const geographyEnqueueMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/geography\/enqueue$/);
    if (geographyEnqueueMatch && method === "POST") {
      const portfolioId = geographyEnqueueMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      try {
        const result = await syncAndEnqueueGeography(env, portfolioId, "holding_change");
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Geography enqueue failed" }, 500);
      }
    }

    const geographyRepairMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/geography\/repair$/);
    if (geographyRepairMatch && method === "POST") {
      const portfolioId = geographyRepairMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      try {
        const result = await repairPortfolioGeography(env, portfolioId);
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Geography repair failed" }, 500);
      }
    }

    const geographyResearchMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/geography\/research$/);
    if (geographyResearchMatch && method === "POST") {
      const portfolioId = geographyResearchMatch[1];
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      try {
        const result = await researchPortfolioEtfGeography(env, portfolioId, { reason: "manual_retry" });
        const geography = await getPortfolioGeography(env, portfolioId);
        return json({ ...result, geography });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "ETF geography research failed" }, 500);
      }
    }

    const transactionDeleteMatch = pathname.match(/^\/api\/portfolios\/([^/]+)\/transactions\/([^/]+)$/);
    if (transactionDeleteMatch && (method === "PATCH" || method === "DELETE")) {
      const [, portfolioId, txnId] = transactionDeleteMatch;
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
      if (!env.SNAPSHOT_QUEUE) {
        return json({ error: "Server misconfiguration: SNAPSHOT_QUEUE binding is missing" }, 500);
      }

      if (method === "PATCH") {
        const body = (await request.json().catch(() => ({}))) as { row?: NormalisedTransactionRow };
        const normalizedRows = normalizeTransactionRows(body.row ? [body.row] : []);
        if (normalizedRows.length === 0) return json({ error: "row is required" }, 400);
        const row = normalizedRows[0];
        const parsedRow = {
          ...row,
          quantity: row.quantity == null ? null : parseFlexibleNumber(row.quantity),
          net_amount: row.net_amount == null ? null : parseFlexibleNumber(row.net_amount),
          commission: parseFlexibleNumber(row.commission ?? "0"),
        };
        let asset: AssetSearchResult | null = null;
        if (!parsedRow.yahoo_ticker && parsedRow.isin) {
          try {
            asset = (await searchYahooAssets(parsedRow.isin))[0] ?? null;
          } catch {
            asset = null;
          }
        }
        const primaryExchange = yahooExchangeToPrimary(asset?.exchange, asset?.ticker);
        const { data, error } = await auth.db
          .from("transactions")
          .update({
            date: parsedRow.date,
            symbol: parsedRow.symbol,
            isin: parsedRow.isin,
            yahoo_ticker: parsedRow.yahoo_ticker ?? (parsedRow.isin ? (asset?.ticker ?? null) : null),
            side: parsedRow.side,
            quantity: parsedRow.quantity,
            net_amount: parsedRow.net_amount,
            commission: parsedRow.commission,
          })
          .eq("id", txnId)
          .eq("portfolio_id", portfolioId)
          .select("id")
          .maybeSingle();
        if (error) return json({ error: error.message }, 500);
        if (!data) return json({ error: "Transaction not found" }, 404);
        if (primaryExchange) {
          await auth.db.from("portfolios").update({ primary_exchange: primaryExchange }).eq("id", portfolioId);
        }
        await rebuildCurrentHoldings(env, portfolioId);
        await syncAndEnqueueGeography(env, portfolioId, "transaction_import");
        await env.SNAPSHOT_QUEUE.send({ type: "full_rebuild", portfolio_id: portfolioId });
        return json({ updated: txnId });
      }

      const { error } = await auth.db
        .from("transactions")
        .delete()
        .eq("id", txnId)
        .eq("portfolio_id", portfolioId);
      if (error) return json({ error: error.message }, 500);
      await rebuildCurrentHoldings(env, portfolioId);
      await syncAndEnqueueGeography(env, portfolioId, "transaction_import");
      await env.SNAPSHOT_QUEUE.send({ type: "full_rebuild", portfolio_id: portfolioId });
      return json({ deleted: txnId });
    }

    // Holdings
    if (pathname === "/api/holdings") {
      if (method === "GET") {
        const portfolioId = url.searchParams.get("portfolio_id");
        if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
        const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
        const { data, error } = await auth.db
          .from("holdings")
          .select("*")
          .eq("portfolio_id", portfolioId);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        const portfolioId = String(body.portfolio_id ?? "");
        if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
        const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;
        const payload = pickColumns(body, HOLDING_WRITE_COLUMNS);
        const { data, error } = await auth.db.from("holdings").insert(payload).select();
        if (error) return json({ error: error.message }, 500);
        const portfolioIds = Array.from(
          new Set((data ?? []).map((row) => String(row.portfolio_id ?? "")).filter(Boolean)),
        );
        await Promise.all(portfolioIds.map((portfolioId) => syncAndEnqueueGeography(env, portfolioId, "holding_change")));
        return json(data, 201);
      }
    }

    // Market data
    if (method === "GET" && pathname === "/api/market/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json([]);

      try {
        return json(await searchYahooAssets(q));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Search failed" }, 500);
      }
    }

    if (method === "GET" && pathname === "/api/market/quotes") {
      const symbols = parseSymbols(url.searchParams.get("symbols"));
      const fallbackCurrency = normalizeCurrencyCode(url.searchParams.get("currency"));
      if (symbols.length === 0) return json([]);
      const [quotesBySymbol, ytdChanges, sectorsBySymbol] = await Promise.all([
        getQuotesResilient(symbols),
        Promise.all(symbols.map((symbol) => getYtdChangePercent(symbol))),
        getSectorsForSymbols(symbols),
      ]);
      const fetchedAt = new Date().toISOString();

      const data = symbols.map((symbol, i) => {
        const quote =
          quotesBySymbol[symbol] ??
          ({
            currentPrice: null,
            change1dPercent: null,
            currency: null,
            sector: null,
            assetType: null,
            lastPriceUpdatedAt: null,
          } satisfies YahooQuoteItem);
        return {
          ticker: symbol,
          currentPrice: quote.currentPrice,
          change1dPercent: quote.change1dPercent,
          currency: quote.currency ?? fallbackCurrency,
          ytdChangePercent: ytdChanges[i],
          sector: sectorsBySymbol[symbol] ?? quote.sector ?? "Other",
          assetType: quote.assetType,
          lastPriceUpdatedAt: quote.lastPriceUpdatedAt ?? fetchedAt,
        };
      });

      return json(data);
    }

    const holdingMatch = pathname.match(/^\/api\/holdings\/([^/]+)$/);
    if (holdingMatch) {
      const id = holdingMatch[1];
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      // RLS ensures only holdings in the caller's portfolios are visible.
      const { data: existingHolding } = await auth.db
        .from("holdings")
        .select("portfolio_id")
        .eq("id", id)
        .maybeSingle();
      const owningPortfolioId =
        existingHolding?.portfolio_id == null ? null : String(existingHolding.portfolio_id);
      if (!owningPortfolioId) return json({ error: "Holding not found" }, 404);

      if (method === "PUT") {
        const body = (await request.json()) as Record<string, unknown>;
        // Exclude portfolio_id so a holding cannot be moved into another portfolio here.
        const payload = pickColumns(body, HOLDING_WRITE_COLUMNS);
        delete payload.portfolio_id;
        const { data, error } = await auth.db.from("holdings").update(payload).eq("id", id).select();
        if (error) return json({ error: error.message }, 500);
        const portfolioIds = Array.from(
          new Set((data ?? []).map((row) => String(row.portfolio_id ?? "")).filter(Boolean)),
        );
        await Promise.all(portfolioIds.map((portfolioId) => syncAndEnqueueGeography(env, portfolioId, "holding_change")));
        return json(data);
      }
      if (method === "DELETE") {
        const { error } = await auth.db.from("holdings").delete().eq("id", id);
        if (error) return json({ error: error.message }, 500);
        await syncAndEnqueueGeography(env, owningPortfolioId, "holding_change");
        return json({ deleted: true });
      }
    }

    // Agent runs
    if (pathname === "/api/agent/runs") {
      if (method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

        const portfolioId = url.searchParams.get("portfolio_id");
        let query = auth.db
          .from("agent_runs")
          .select("*")
          .eq("user_id", auth.userId)
          .order("created_at", { ascending: false })
          .limit(100);

        if (portfolioId) query = query.eq("portfolio_id", portfolioId);
        const { data, error } = await query;
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      if (method === "POST") {
        if (!env.AGENT_RUNS_QUEUE) {
          return json({ error: "Server misconfiguration: AGENT_RUNS_QUEUE binding is missing" }, 500);
        }

        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

        const body = (await request.json()) as {
          portfolioId?: string;
          triggerType?: AgentRunTriggerType;
          allPortfolios?: boolean;
          idempotencyKey?: string;
          forceNew?: boolean;
        };

        const triggerType = body.triggerType ?? "ondemand";
        if (!["scheduled", "ondemand"].includes(triggerType)) {
          return json({ error: "triggerType must be scheduled or ondemand" }, 400);
        }

        // listUserPortfolioIds is already scoped to the authenticated user; a single
        // target portfolio is verified for ownership before any run is created.
        const portfolioIds = body.allPortfolios
          ? await listUserPortfolioIds(auth.db)
          : body.portfolioId
            ? [body.portfolioId]
            : [];

        if (portfolioIds.length === 0) {
          return json({ error: "No target portfolios found" }, 400);
        }

        if (!body.allPortfolios) {
          for (const portfolioId of portfolioIds) {
            const accessError = await assertPortfolioAccess(auth.db, portfolioId);
        if (accessError) return accessError;
          }
        }

        const runs: AgentRunRow[] = [];
        for (const portfolioId of portfolioIds) {
          const run = await createRun(auth.db, {
            userId: auth.userId,
            portfolioId,
            triggerType,
            idempotencyKey: body.forceNew ? crypto.randomUUID() : body.idempotencyKey,
          });
          runs.push(run);
        }

        await Promise.all(runs.map((run) => queueRun(env, run)));
        return json(
          {
            queued: runs.length,
            runs: runs.map((run) => ({
              id: run.id,
              portfolioId: run.portfolio_id,
              status: run.status,
              idempotencyKey: run.idempotency_key,
              createdAt: run.created_at,
            })),
          },
          201,
        );
      }
    }

    if (pathname === "/api/agent/settings") {
      if (method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

        const { data, error } = await auth.db
          .from("agent_user_settings")
          .select("*")
          .eq("user_id", auth.userId)
          .maybeSingle();
        if (error) return json({ error: error.message }, 500);
        return json(
          data ?? {
            user_id: auth.userId,
            timezone: "Europe/Paris",
            global_runs_per_day: 2,
            auto_apply_enabled: false,
            auto_apply_min_confidence: 0.8,
          },
        );
      }

      if (method === "PUT") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
        const body = (await request.json()) as {
          timezone?: string;
          globalRunsPerDay?: number;
          autoApplyEnabled?: boolean;
          autoApplyMinConfidence?: number;
        };

        const payload = {
          user_id: auth.userId,
          timezone: body.timezone ?? "Europe/Paris",
          global_runs_per_day: Math.max(1, Math.min(3, Number(body.globalRunsPerDay ?? 2))),
          auto_apply_enabled: Boolean(body.autoApplyEnabled ?? false),
          auto_apply_min_confidence: Math.max(
            0,
            Math.min(1, Number(body.autoApplyMinConfidence ?? 0.8)),
          ),
        };

        const { data, error } = await auth.db
          .from("agent_user_settings")
          .upsert(payload, { onConflict: "user_id" })
          .select("*")
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(data, 200);
      }
    }

    if (pathname === "/api/agent/portfolio-settings") {
      if (method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

        const { data, error } = await auth.db
          .from("agent_portfolio_settings")
          .select("*")
          .eq("user_id", auth.userId)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 500);
        return json(data ?? []);
      }

      if (method === "PUT") {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
        const body = (await request.json()) as {
          portfolioId?: string;
          runsPerDayOverride?: number | null;
          agentEnabled?: boolean;
        };
        if (!body.portfolioId) {
          return json({ error: "portfolioId is required" }, 400);
        }
        const accessError = await assertPortfolioAccess(auth.db, body.portfolioId);
        if (accessError) return accessError;

        const payload = {
          user_id: auth.userId,
          portfolio_id: body.portfolioId,
          runs_per_day_override:
            body.runsPerDayOverride == null
              ? null
              : Math.max(1, Math.min(3, Number(body.runsPerDayOverride))),
          agent_enabled: body.agentEnabled == null ? true : Boolean(body.agentEnabled),
        };

        const { data, error } = await auth.db
          .from("agent_portfolio_settings")
          .upsert(payload, { onConflict: "portfolio_id" })
          .select("*")
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(data, 200);
      }
    }

    if (pathname === "/api/agent/metrics") {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      const hours = Math.max(1, Math.min(168, Number(url.searchParams.get("hours") ?? 24)));
      const fromIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await auth.db
        .from("agent_runs")
        .select("id,status,trigger_type,created_at,started_at,finished_at,error_code")
        .eq("user_id", auth.userId)
        .gte("created_at", fromIso)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) return json({ error: error.message }, 500);

      return json(summarizeRunMetrics(data ?? [], { hours, fromIso }), 200);
    }

    if (pathname === "/api/agent/feed") {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));

      const { data, error } = await auth.db
        .from("agent_runs")
        .select("id,portfolio_id,created_at,token_usage,status,trigger_type")
        .eq("user_id", auth.userId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: error.message }, 500);

      const insights = (data ?? [])
        .flatMap((run) => {
          const tokenUsage = (run.token_usage ?? {}) as Record<string, unknown>;
          const main = (
            tokenUsage.impact_stage ??
            tokenUsage.main_agent ??
            {}
          ) as Record<string, unknown>;
          const signals = Array.isArray(main.signals)
            ? (main.signals as Array<Record<string, unknown>>)
            : [];
          return signals.map((signal, index) => {
            const type = String(signal.signal_type ?? "neutral");
            const status =
              type === "at_risk"
                ? "At risk"
                : type === "supportive"
                  ? "Supportive"
                  : type === "watch"
                    ? "Watch"
                    : "Neutral";
            return {
              id: `${run.id}:${index}`,
              run_id: run.id,
              portfolio_id: run.portfolio_id,
              created_at: run.created_at,
              trigger_type: run.trigger_type,
              source: "agent",
              thesis_id: String(signal.thesis_id ?? ""),
              status,
              headline: String(signal.title ?? "Agent signal"),
              body: String(signal.explanation ?? ""),
              confidence: Number(signal.confidence ?? 50),
              risk_horizon:
                signal.risk_horizon == null ? null : String(signal.risk_horizon),
              evidence_ids: Array.isArray(signal.evidence_ids)
                ? signal.evidence_ids.map((id) => String(id))
                : [],
              change_type: String(signal.change_type ?? "new_information"),
              delta_summary:
                signal.delta_summary == null ? null : String(signal.delta_summary),
              questions_for_user: Array.isArray(main.questions_for_user)
                ? main.questions_for_user.map((question) => String(question))
                : [],
            };
          });
        })
        .reduce<Array<Record<string, unknown>>>((acc, insight) => {
          const thesisId = String(insight.thesis_id ?? "");
          const prior = acc.find((item) => String(item.thesis_id ?? "") === thesisId);
          if (String(insight.change_type ?? "") === "no_material_change" && prior) {
            return acc;
          }
          acc.push(insight);
          return acc;
        }, [])
        .slice(0, limit);

      return json({ insights }, 200);
    }

    if (pathname === "/api/agent/alerts") {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      const hours = Math.max(1, Math.min(168, Number(url.searchParams.get("hours") ?? 24)));
      const queueDepthThreshold = Math.max(
        1,
        Math.min(200, Number(url.searchParams.get("queue_depth_threshold") ?? 5)),
      );
      const successRateThreshold = Math.max(
        0,
        Math.min(1, Number(url.searchParams.get("success_rate_threshold") ?? 0.9)),
      );
      const p95MsThreshold = Math.max(
        1000,
        Math.min(60 * 60 * 1000, Number(url.searchParams.get("p95_ms_threshold") ?? 120000)),
      );
      const fromIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await auth.db
        .from("agent_runs")
        .select("status,trigger_type,started_at,finished_at,error_code")
        .eq("user_id", auth.userId)
        .gte("created_at", fromIso)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) return json({ error: error.message }, 500);

      const metrics = summarizeRunMetrics(data ?? [], { hours, fromIso });
      const alerts = [
        {
          key: "queue_depth_high",
          triggered: metrics.queue_depth >= queueDepthThreshold,
          value: metrics.queue_depth,
          threshold: queueDepthThreshold,
        },
        {
          key: "success_rate_low",
          triggered:
            metrics.success_rate != null && metrics.success_rate <= successRateThreshold,
          value: metrics.success_rate,
          threshold: successRateThreshold,
        },
        {
          key: "p95_latency_high",
          triggered:
            metrics.duration_ms.p95 != null && metrics.duration_ms.p95 >= p95MsThreshold,
          value: metrics.duration_ms.p95,
          threshold: p95MsThreshold,
        },
      ];

      return json(
        {
          window_hours: hours,
          thresholds: {
            queue_depth_threshold: queueDepthThreshold,
            success_rate_threshold: successRateThreshold,
            p95_ms_threshold: p95MsThreshold,
          },
          alerts,
          metrics,
        },
        200,
      );
    }

    if (pathname === "/api/agent/scheduled/fanout") {
      if (method !== "POST") return json({ error: "Method not allowed" }, 405);
      const adminError = requireAdmin(request, env);
      if (adminError) return adminError;

      const body = (await request.json().catch(() => ({}))) as {
        dryRun?: boolean;
        nowIso?: string;
      };
      const now = body.nowIso ? new Date(body.nowIso) : new Date();
      if (Number.isNaN(now.getTime())) {
        return json({ error: "Invalid nowIso" }, 400);
      }

      const result = await runScheduledFanout(env, {
        now,
        dryRun: Boolean(body.dryRun),
        source: "manual",
      });
      return json(result, 200);
    }

    const cancelRunMatch = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/cancel$/);
    if (cancelRunMatch && method === "POST") {
      const runId = cancelRunMatch[1];
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
      // Verify the run belongs to the caller before cancelling.
      const { data: run } = await auth.db
        .from("agent_runs")
        .select("user_id")
        .eq("id", runId)
        .maybeSingle();
      if (!run || String(run.user_id) !== auth.userId) return json({ error: "Run not found" }, 404);
      const { data, error } = await auth.db
        .from("agent_runs")
        .update({
          status: "cancelled",
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .in("status", ["queued", "running"])
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    // ---------------------------------------------------------------------------
    // Debug endpoints — operator only. Gated by the ADMIN_SECRET shared secret
    // (X-Admin-Secret header). Destructive / cost-incurring; never publicly reachable.
    // ---------------------------------------------------------------------------

    if (method === "POST" && pathname === "/api/_debug/run-news-fanout") {
      const adminError = requireAdmin(request, env);
      if (adminError) return adminError;
      try {
        // ?reset=true wipes existing clusters first (cascade clears the bridge) so a
        // test run reflects only the fresh fanout.
        if (url.searchParams.get("reset") === "true") {
          await adminDb(env).from("news_clusters").delete().not("id", "is", null);
        }
        const result = await runNewsFanout(env);
        return json(result, 200);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }


    if (method === "POST" && pathname === "/api/_debug/run-polymarket-fanout") {
      const adminError = requireAdmin(request, env);
      if (adminError) return adminError;
      try {
        const result = await runPolymarketFanout(env, {
          forceRescore: url.searchParams.get("force") === "true",
        });
        return json(result, 200);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/_debug/run-recap-fanout
    //   ?type=weekly                       → run the weekly cron fanout (add &dryRun=true to preview)
    //   ?type=daily|weekly&portfolio_id=…  → generate one recap synchronously (force-regenerates)
    if (method === "POST" && pathname === "/api/_debug/run-recap-fanout") {
      const adminError = requireAdmin(request, env);
      if (adminError) return adminError;
      try {
        const type = (url.searchParams.get("type") ?? "daily") as RecapType;
        if (type !== "daily" && type !== "weekly") {
          return json({ error: "type must be 'daily' or 'weekly'" }, 400);
        }
        const portfolioId = url.searchParams.get("portfolio_id");

        if (!portfolioId) {
          // Fanout path (weekly only — daily is chained off snapshots).
          if (type !== "weekly") {
            return json({ error: "daily requires portfolio_id (daily is chained off snapshots)" }, 400);
          }
          const result = await runWeeklyRecapFanout(env, {
            now: new Date(),
            dryRun: url.searchParams.get("dryRun") === "true",
          });
          return json(result, 200);
        }

        // Single-portfolio synchronous generation (force-regenerate for testing).
        const client = adminDb(env);
        const { data: pf } = await client
          .from("portfolios")
          .select("user_id")
          .eq("id", portfolioId)
          .maybeSingle();
        if (!pf?.user_id) return json({ error: "portfolio not found" }, 404);

        let periodStart: string;
        let periodEnd: string;
        if (type === "weekly") {
          const friday = mostRecentFridayUTC(new Date());
          const monday = new Date(friday);
          monday.setUTCDate(monday.getUTCDate() - 4);
          periodEnd = toUtcDateString(friday);
          periodStart = toUtcDateString(monday);
        } else {
          // Allow overriding period_end for testing (e.g. passing a specific trading day
          // when running the debug endpoint on a weekend).
          const overridePeriodEnd = url.searchParams.get("period_end");
          periodEnd = overridePeriodEnd ?? toUtcDateString(new Date());
          periodStart = periodEnd;
        }

        await client
          .from("recaps")
          .delete()
          .eq("portfolio_id", portfolioId)
          .eq("type", type)
          .eq("period_end", periodEnd);
        const { data: created, error: createErr } = await client
          .from("recaps")
          .insert({
            portfolio_id: portfolioId,
            user_id: String(pf.user_id),
            type,
            period_start: periodStart,
            period_end: periodEnd,
            status: "running",
          })
          .select("id")
          .single();
        if (createErr || !created) return json({ error: createErr?.message ?? "insert failed" }, 500);

        try {
          const result = await generateRecap(env, String(created.id));
          const { data: finalRow } = await client.from("recaps").select("*").eq("id", created.id).single();
          return json({ result, recap: finalRow }, 200);
        } catch (genErr) {
          await client
            .from("recaps")
            .update({ status: "failed", error: genErr instanceof Error ? genErr.message : String(genErr) })
            .eq("id", created.id);
          return json({ error: genErr instanceof Error ? genErr.message : String(genErr) }, 500);
        }
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ---------------------------------------------------------------------------
    // Feed read endpoints
    // ---------------------------------------------------------------------------

    // GET /api/feed/news?portfolio_id=...&limit=20
    if (method === "GET" && pathname === "/api/feed/news") {
      const portfolioId = url.searchParams.get("portfolio_id") ?? "";
      if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));

      const { data, error } = await auth.db
        .from("portfolio_news_matches")
        .select(
          `score, match_reason,
           news_clusters!inner(
             id, cluster_key, primary_article, see_also, entities, published_at, expires_at
           )`,
        )
        .eq("portfolio_id", portfolioId)
        .gt("news_clusters.expires_at", new Date().toISOString())
        // Minimum score floor. Score is exaScore × recency × holdingsBooster,
        // whose distribution differs from the previous provider's entity-weight
        // one — so this starts permissive and MUST be recalibrated empirically
        // from observed Exa output (see plan verification step).
        .gte("score", 0.05)
        .order("score", { ascending: false })
        .limit(limit);

      if (error) return json({ error: error.message }, 500);
      return json(data ?? [], 200);
    }

    // GET /api/feed/polymarket?portfolio_id=...
    if (method === "GET" && pathname === "/api/feed/polymarket") {
      const portfolioId = url.searchParams.get("portfolio_id") ?? "";
      if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      const { data, error } = await auth.db
        .from("portfolio_polymarket_matches")
        .select(
          `is_pinned, score, reason,
           polymarket_markets!inner(
             condition_id, event_id, event_slug, event_title, market_slug,
             question, tags, outcomes, outcome_prices, liquidity, volume_24hr,
             end_date, image, active, fetched_at
           )`,
        )
        .eq("portfolio_id", portfolioId)
        .eq("polymarket_markets.active", true)
        .order("is_pinned", { ascending: false })
        .order("score", { ascending: false, nullsFirst: false })
        .limit(30);

      if (error) return json({ error: error.message }, 500);

      const rows = data ?? [];
      const pinned = rows.filter((r) => r.is_pinned);
      const rotating = rows.filter((r) => !r.is_pinned);
      return json({ pinned, rotating }, 200);
    }

    // GET /api/recaps?portfolio_id=...&type=daily|weekly → latest ready recap
    if (method === "GET" && pathname === "/api/recaps") {
      const portfolioId = url.searchParams.get("portfolio_id") ?? "";
      if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
      // Need the userId (not just ownership) to attach the caller's own
      // per-slide feedback, so resolve it explicitly here.
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;
      const accessError = await assertPortfolioAccess(auth.db, portfolioId);
        if (accessError) return accessError;

      const type = url.searchParams.get("type");
      let query = auth.db
        .from("recaps")
        .select(
          "id, type, period_start, period_end, status, slides, generated_at, seen_at, langsmith_run_id",
        )
        .eq("portfolio_id", portfolioId)
        .eq("status", "ready");
      if (type === "daily" || type === "weekly") query = query.eq("type", type);

      const { data, error } = await query
        .order("period_end", { ascending: false })
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json(null, 200);

      // Attach the caller's per-slide feedback for this recap. Supplementary —
      // a query error (e.g. migration not yet applied) degrades to [] rather
      // than failing the whole recap fetch.
      const { data: slideFeedback, error: fbError } = await auth.db
        .from("recap_slide_feedback")
        .select("slide_index, score, comment")
        .eq("recap_id", data.id)
        .eq("user_id", auth.userId);
      if (fbError) {
        console.error("[recaps] slide_feedback fetch failed:", fbError.message);
      }
      return json({ ...data, slide_feedback: slideFeedback ?? [] }, 200);
    }

    // GET /api/recaps/list?portfolio_id=...&limit=20 → recap history
    if (method === "GET" && pathname === "/api/recaps/list") {
      const portfolioId = url.searchParams.get("portfolio_id") ?? "";
      if (!portfolioId) return json({ error: "portfolio_id is required" }, 400);
      const auth = await requirePortfolioAccess(request, env, portfolioId);
        if (auth instanceof Response) return auth;

      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
      const { data, error } = await auth.db
        .from("recaps")
        .select("id, type, period_start, period_end, status, generated_at, seen_at")
        .eq("portfolio_id", portfolioId)
        .order("period_end", { ascending: false })
        .limit(limit);
      if (error) return json({ error: error.message }, 500);
      return json(data ?? [], 200);
    }

    // POST /api/recaps/:id/seen → mark a recap as seen (clears the "new" dot)
    const recapSeenMatch = pathname.match(/^\/api\/recaps\/([^/]+)\/seen$/);
    if (method === "POST" && recapSeenMatch) {
      const recapId = decodeURIComponent(recapSeenMatch[1]);
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      const { data: recap } = await auth.db
        .from("recaps")
        .select("portfolio_id")
        .eq("id", recapId)
        .maybeSingle();
      if (!recap) return json({ error: "recap not found" }, 404);

      const { error } = await auth.db
        .from("recaps")
        .update({ seen_at: new Date().toISOString() })
        .eq("id", recapId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

    // POST /api/recaps/:id/feedback → upsert per-slide thumbs + comment.
    // Body: { slide_index: number, score: 1 | -1, comment?: string }
    // One row per (recap, user, slide); re-voting / editing the comment
    // upserts (last write wins). user_id always comes from the bearer token.
    const recapFeedbackMatch = pathname.match(/^\/api\/recaps\/([^/]+)\/feedback$/);
    if (method === "POST" && recapFeedbackMatch) {
      const recapId = decodeURIComponent(recapFeedbackMatch[1]);

      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      const client = auth.db;
      const { data: recap } = await client
        .from("recaps")
        .select("portfolio_id, slides, langsmith_run_id")
        .eq("id", recapId)
        .maybeSingle();
      if (!recap) return json({ error: "recap not found" }, 404);

      const accessError = await assertPortfolioAccess(auth.db, String(recap.portfolio_id));
        if (accessError) return accessError;

      let body: { slide_index?: unknown; score?: unknown; comment?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const slideIndex = Number(body.slide_index);
      const score = Number(body.score);
      const slideCount = Array.isArray(recap.slides) ? recap.slides.length : 0;
      if (!Number.isInteger(slideIndex) || slideIndex < 0 || (slideCount > 0 && slideIndex >= slideCount)) {
        return json({ error: "slide_index out of range" }, 400);
      }
      if (score !== 1 && score !== -1) {
        return json({ error: "score must be 1 or -1" }, 400);
      }
      // Client sends the current comment alongside every vote (and the current
      // score alongside every comment edit), so the upsert overwrites both.
      const comment = typeof body.comment === "string" ? body.comment.slice(0, 2000) : null;

      const { error } = await client.from("recap_slide_feedback").upsert(
        {
          recap_id: recapId,
          portfolio_id: String(recap.portfolio_id),
          user_id: auth.userId,
          slide_index: slideIndex,
          score,
          comment,
        },
        { onConflict: "recap_id,user_id,slide_index" },
      );
      if (error) return json({ error: error.message }, 500);

      // Retroactively attach this vote to the recap's already-recorded
      // LangSmith trace. Best-effort and fully decoupled from the Supabase
      // write above (which is the source of truth): a LangSmith outage,
      // an unconfigured key, or an untraced recap must never fail the save.
      //
      // Idempotent by design: feedbackId = uuid(run, user, slide), so a
      // re-vote (👍→👎) UPDATES the same feedback instead of appending a new
      // one — the exact pollution that retired the old presigned-token path.
      // One feedback key per slide (slide_<n>_score) keeps per-slide sentiment
      // distinct on the run instead of collapsing to a single recap score.
      const langsmithRunId =
        typeof recap.langsmith_run_id === "string" ? recap.langsmith_run_id : null;
      if (langsmithRunId) {
        const lsClient = langsmithClient(env);
        if (lsClient) {
          try {
            const feedbackId = await deterministicUuid(
              `${langsmithRunId}:${auth.userId}:${slideIndex}`,
            );
            // Key feedback by the slide's KIND (performance/macro/mover/watch),
            // not its 0-based array index — self-documenting in the LangSmith UI
            // and comparable across recaps. Each kind is unique within a recap.
            // Falls back to the index if the kind is somehow missing.
            const slideKind =
              Array.isArray(recap.slides) && recap.slides[slideIndex]?.kind;
            const feedbackKey =
              typeof slideKind === "string" ? `${slideKind}_score` : `slide_${slideIndex}_score`;
            await lsClient.createFeedback(langsmithRunId, feedbackKey, {
              score,
              // Always send the comment field (empty string when the user has
              // none / just cleared it) so clearing a comment propagates to the
              // trace instead of leaving the prior one stale.
              comment: comment ?? "",
              feedbackId,
            });
            // CF Workers: flush the batched event before the request context
            // tears down, or the feedback never sends.
            await lsClient.flush();
          } catch (err) {
            console.error(
              "[recaps] LangSmith createFeedback failed for run",
              langsmithRunId,
              err,
            );
          }
        }
      }

      return json({ ok: true }, 200);
    }

    // GET /api/polymarket/category?tag=finance|geopolitics|tech|economy&limit=30
    // Returns volume-ranked markets for a given category tag, filtered by
    // NON_FINANCIAL_RE. No portfolio context or LLM call — suitable for browsing.
    if (method === "GET" && pathname === "/api/polymarket/category") {
      const auth = await requireAuth(request, env);
        if (auth instanceof Response) return auth;

      const tagName = url.searchParams.get("tag") ?? "";
      const TAG_BY_NAME: Record<string, number> = {
        finance: TAG_IDS.finance,
        geopolitics: TAG_IDS.geopolitics,
        tech: TAG_IDS.tech,
        economy: TAG_IDS.economy,
        crypto: TAG_IDS.crypto,
      };
      const tagId = TAG_BY_NAME[tagName];
      if (!tagId) {
        return json(
          { error: `Unknown tag "${tagName}". Valid: ${Object.keys(TAG_BY_NAME).join(", ")}` },
          400,
        );
      }

      const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 60);

      const { data, error } = await auth.db
        .from("polymarket_markets")
        .select(
          "condition_id, event_id, event_slug, event_title, market_slug, question, tags, outcomes, outcome_prices, liquidity, volume_24hr, start_date, end_date, image, active, fetched_at",
        )
        .contains("tags", JSON.stringify([{ id: tagId }]))
        .eq("active", true)
        .order("volume_24hr", { ascending: false })
        .limit(limit * 2); // fetch extra to have room after client-side filters

      if (error) return json({ error: error.message }, 500);

      // Apply the same filters as the personalized rotating path: strip
      // sports/entertainment noise (NON_FINANCIAL_RE), weekly/daily
      // price-gambling markets (isShortTermMarket), and markets that are
      // resolved-in-all-but-name (isNearCertainMarket).
      const filtered = (data ?? [])
        .filter((m) => !NON_FINANCIAL_RE.test(m.question ?? ""))
        .filter((m) => !isShortTermMarket(m.start_date, m.end_date))
        .filter((m) => !isNearCertainMarket(m.outcome_prices))
        .slice(0, limit);

      return json(filtered, 200);
    }

    return json({ error: "Not found" }, 404);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runScheduledFanout(env, {
        now: new Date(controller.scheduledTime),
        source: "cron",
      });
    } catch (error) {
      console.error("scheduled fanout failed", error);
    }
    try {
      await enqueueDailySnapshotsForClosedMarkets(env, controller.scheduledTime);
    } catch (error) {
      console.error("daily snapshot fanout failed", error);
    }
    // News fanout — decoupled from the hourly cron to a few times/day to cut Exa
    // spend. Runs only on these cron slots (not the hourly "5 * * * *"): weekday
    // morning, afternoon, and evening. Manual runs go via /api/_debug/run-news-fanout.
    const NEWS_CRON_SLOTS = new Set(["30 6 * * 2-6", "30 16 * * 1-5", "0 21 * * 1-5"]);
    if (NEWS_CRON_SLOTS.has(controller.cron)) {
      try {
        await runNewsFanout(env);
      } catch (error) {
        console.error("news fanout failed", error);
      }
    }
    try {
      await runPolymarketFanout(env);
    } catch (error) {
      console.error("polymarket fanout failed", error);
    }
    // Weekly recap fanout — rides the hourly cron; fires for portfolios where
    // it is Saturday 08:00 in the user's tz. Daily recaps are chained off the
    // snapshot commit in queue(), not here.
    if (controller.cron === "5 * * * *") {
      try {
        await runWeeklyRecapFanout(env, { now: new Date(controller.scheduledTime) });
      } catch (error) {
        console.error("weekly recap fanout failed", error);
      }
      // Monthly ETF geography refresh — piggybacks on the hourly cron on the
      // first of each month at UTC midnight (fires at 00:05). Re-researches all
      // ETF holdings across all portfolios to pick up index rebalancing changes.
      const scheduledDate = new Date(controller.scheduledTime);
      if (scheduledDate.getUTCDate() === 1 && scheduledDate.getUTCHours() === 0) {
        try {
          await runGeographyMonthlyRefresh(env);
        } catch (error) {
          console.error("monthly geography refresh failed", error);
        }
      }
    }
  },
  async queue(batch: MessageBatch<WorkerQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isSnapshotQueueMessage(message.body)) {
        try {
          if (message.body.type === "full_rebuild") {
            await recomputeSnapshots(env, message.body.portfolio_id);
            await syncAndEnqueueGeography(env, message.body.portfolio_id, "snapshot_rebuild");
          } else {
            const tradingDay = await appendTodaySnapshot(env, message.body.portfolio_id);
            // Chain the daily recap AFTER the snapshot commits. Use the actual
            // trading day returned (not wall-clock) so a misfired Sunday cron
            // never creates a "Sunday daily recap" — it either chains off
            // Friday's row or skips if no trading day was written.
            if (tradingDay) {
              try {
                const { data: pf } = await adminDb(env)
                  .from("portfolios")
                  .select("user_id")
                  .eq("id", message.body.portfolio_id)
                  .maybeSingle();
                if (pf?.user_id) {
                  await createAndQueueRecap(env, {
                    portfolioId: message.body.portfolio_id,
                    userId: String(pf.user_id),
                    type: "daily",
                    periodStart: tradingDay,
                    periodEnd: tradingDay,
                  });
                }
              } catch (recapError) {
                // Recap chaining is best-effort — never fail the snapshot ack over it.
                console.error(`daily recap enqueue failed for portfolio ${message.body.portfolio_id}`, recapError);
              }
            }
          }
          message.ack();
        } catch (error) {
          console.error(`snapshot queue failed for portfolio ${message.body.portfolio_id}`, error);
          message.retry();
        }
        continue;
      }

      if (isGeographyQueueMessage(message.body)) {
        const holdingIds = message.body.holding_id
          ? [message.body.holding_id]
          : (message.body.holding_ids ?? []);
        try {
          await researchPortfolioEtfGeography(env, message.body.portfolio_id, {
            holdingIds,
            onlyPending: true,
            reason: message.body.reason,
          });
          message.ack();
        } catch (error) {
          await markGeographyJobsFailed(env, message.body.portfolio_id, holdingIds, error);
          console.error(`geography queue failed for portfolio ${message.body.portfolio_id}`, error);
          message.retry();
        }
        continue;
      }

      if (isRecapQueueMessage(message.body)) {
        const recapId = message.body.recapId;
        try {
          await adminDb(env).from("recaps").update({ status: "running" }).eq("id", recapId).eq("status", "queued");
          await generateRecap(env, recapId);
          message.ack();
        } catch (error) {
          console.error(`recap queue failed for recap ${recapId}`, error);
          await adminDb(env)
            .from("recaps")
            .update({ status: "failed", error: error instanceof Error ? error.message : String(error) })
            .eq("id", recapId);
          // Mark failed and ack — deterministic failures shouldn't retry-storm Gemini.
          message.ack();
        }
        continue;
      }

      const runId = message.body.runId;
      try {
        const guardrails = createGuardrailState();
        const toolCalls: AgentToolCall[] = [];
        const start = new Date().toISOString();
        await adminDb(env)
          .from("agent_runs")
          .update({ status: "running", started_at: start })
          .eq("id", runId)
          .eq("status", "queued");

        const context = await runToolWithGuardrails(
          guardrails,
          toolCalls,
          "portfolio_context",
          {
            userId: message.body.userId,
            portfolioId: message.body.portfolioId,
          },
          (input) => runPortfolioContextTool(env, input),
        );

        const contextTickers = Array.from(
          new Set([
            ...context.holdings.map((holding) => holding.ticker),
            ...context.theses.flatMap((thesis) => thesis.tickers),
          ]),
        );

        const quotes = await runToolWithGuardrails(
          guardrails,
          toolCalls,
          "market_quotes",
          {
            tickers: contextTickers,
          },
          (input) => runMarketQuotesTool(input),
        );

        const ecbData = await runToolWithGuardrails(
          guardrails,
          toolCalls,
          "get_ecb_data",
          {
            dataset: "FM/B.U2.EUR.4F.KR.MRR_FR.LEV",
            lastNObservations: 2,
          },
          (input) => runEcbDataTool(input),
        );

        const fredData = await runToolWithGuardrails(
          guardrails,
          toolCalls,
          "get_fred_indicator",
          {
            series_id: "FEDFUNDS",
            limit: 3,
          },
          (input) => runFredIndicatorTool(env, input),
        );

        if (!env.GROK_SUB_API_KEY || !env.GROK_MAIN_API_KEY) {
          throw new Error(
            "Missing GROK_SUB_API_KEY or GROK_MAIN_API_KEY. Set both secrets before Phase 4 processing.",
          );
        }

        const subPass1SystemPrompt =
          env.SUB_AGENT_PLANNING_SYSTEM_PROMPT ??
          [
            "You are a thesis classification agent.",
            "Return strict JSON only with keys classifications and search_queries.",
            "classifications[]: { thesis_id, established_facts, claims_to_verify, signals_to_monitor, etf_underlying }.",
            "Each classification must include at least 2 concrete signals_to_monitor.",
            "search_queries[] should be concept-driven and grounded in thesis wording.",
            "Do not copy thesis title verbatim as the full query.",
          ].join(" ");

        const subPass1UserPrompt = JSON.stringify(
          {
            portfolioId: message.body.portfolioId,
            thesis_input: context.theses,
          },
          null,
          2,
        );

        const subPass1Raw = await invokeGrok(
          env.GROK_SUB_API_KEY,
          "grok-4-1-fast-reasoning",
          subPass1SystemPrompt,
          subPass1UserPrompt,
          env,
        );
        const subPass1Output = normalizeSubAgentPlanningOutput(
          extractJsonObject(subPass1Raw),
        );
        if (subPass1Output.classifications.length === 0) {
          subPass1Output.classifications = context.theses.map((thesis) => ({
            thesis_id: thesis.id,
            established_facts: [thesis.title],
            claims_to_verify: thesis.summary ? [thesis.summary] : [thesis.title],
            signals_to_monitor: [],
            etf_underlying: null,
          }));
        }
        subPass1Output.classifications = subPass1Output.classifications.map((classification) => {
          if (classification.signals_to_monitor.length >= 2) return classification;
          const seeds = [
            ...classification.claims_to_verify,
            ...classification.established_facts,
          ]
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 2);
          const defaults = seeds.length > 0 ? seeds : ["earnings revisions", "policy changes"];
          return {
            ...classification,
            signals_to_monitor: defaults,
          };
        });
        subPass1Output.raw_search_queries = subPass1Output.search_queries.map((item) => ({
          thesis_id: item.thesis_id,
          query: item.query,
        }));
        if (subPass1Output.search_queries.length === 0) {
          subPass1Output.search_queries = context.theses
            .map((thesis) => ({
              thesis_id: thesis.id,
              query: toConceptQuery({
                title: thesis.title,
                summary: thesis.summary,
                tickers: thesis.tickers,
              }),
            }))
            .filter((item) => Boolean(item.query))
            .slice(0, 8);
        }
        const newsQuery =
          subPass1Output.search_queries
            .map((item) => item.query.trim())
            .filter(Boolean)
            .join(" OR ")
            .trim() ||
          contextTickers.slice(0, 5).join(" OR ") ||
          "global markets macro";
        let news: NewsSearchResult;
        let webSearchFallbackReason: string | null = null;
        try {
          news = await runToolWithGuardrails(
            guardrails,
            toolCalls,
            "search_news",
            {
              query: newsQuery,
              limit: 8,
              recencyDays: 60,
              locale: "en-US",
            },
            (input) => runWebSearchTool(env, input),
          );
        } catch (error) {
          webSearchFallbackReason = error instanceof Error ? error.message : "xAI web search failed";
          news = await runToolWithGuardrails(
            guardrails,
            toolCalls,
            "search_news",
            {
              query: newsQuery,
              limit: 8,
              recencyDays: 60,
            },
            (input) => runNewsSearchTool(input),
          );
        }

        const subSystemPrompt =
          env.SUB_AGENT_SYSTEM_PROMPT ??
          [
            "You are an evidence extraction agent for investment theses.",
            "Extract external evidence only and never rewrite the user's thesis.",
            "Return strict JSON only with keys evidence_items, missing_info, retrieval_meta.",
            "evidence_items[]: { id, thesis_id, claim, snippet, url, source, published_at, is_stale, staleness_reason, relevance_score, tags }.",
            "Hard rule: no recommendations. Hard rule: every claim must cite url.",
          ].join(" ");

        const subUserPrompt = JSON.stringify(
          {
            portfolioId: message.body.portfolioId,
            thesis_input: context.theses,
            thesis_classification: subPass1Output,
            retrieval_input: {
              holdings: context.holdings,
              quotes: quotes.quotes,
              ecb_data: ecbData,
              fred_data: fredData,
              web_results: news.items,
            },
            policy: {
              recency_days: news.recencyDays,
              stale_rule: "Mark evidence stale when published_at is older than recency_days",
            },
          },
          null,
          2,
        );

        const subRaw = await invokeGrok(
          env.GROK_SUB_API_KEY,
          "grok-4-1-fast-reasoning",
          subSystemPrompt,
          subUserPrompt,
          env,
        );
        const subOutput = normalizeSubAgentOutput(extractJsonObject(subRaw));
        if (subOutput.evidence_items.length === 0) {
          const fallbackEvidence = context.theses
            .map((thesis, index) => {
              const source = news.items[index % Math.max(1, news.items.length)];
              const fallbackUrl = source?.url || "https://news.google.com";
              return {
                id: `${thesis.id}:fallback:${index}`,
                thesis_id: thesis.id,
                claim:
                  source?.title ||
                  `No extractable evidence found for thesis "${thesis.title}" in this run`,
                snippet:
                  source?.snippet ||
                  "Fallback evidence item generated because sub-agent returned no structured evidence.",
                url: fallbackUrl,
                source: inferSourceFromUrl(fallbackUrl),
                published_at: source?.published_at ?? null,
                is_stale: Boolean(source?.is_stale),
                staleness_reason: "sub_agent_empty_fallback",
                relevance_score: 25,
                tags: ["fallback", "low_confidence"],
              };
            })
            .slice(0, 8);
          if (fallbackEvidence.length === 0) {
            throw new Error("Model output missing required items: sub_agent.evidence_items is empty");
          }
          subOutput.evidence_items = fallbackEvidence;
          subOutput.missing_info = [
            ...subOutput.missing_info,
            "Sub-agent returned empty evidence_items; fallback evidence synthesized from retrieval inputs.",
          ];
        }

        const mainSystemPrompt =
          env.MAIN_AGENT_SYSTEM_PROMPT ??
          [
            "You are a thesis impact reasoning agent.",
            "Bridge user thesis intent with extracted external evidence.",
            "Return strict JSON only with keys: signals, overall_summary, questions_for_user.",
            "Each signal: { thesis_id, signal_type, title, explanation, risk_horizon, confidence, evidence_ids, assumptions, no_evidence_reason, change_type, delta_summary }.",
            "Do not treat evidence titles as user thesis text.",
          ].join(" ");

        const mainUserPrompt = JSON.stringify(
          {
            portfolioId: message.body.portfolioId,
            thesis_input: context.theses,
            portfolio_context: {
              holdings: context.holdings,
            },
            evidence_items: subOutput.evidence_items,
          },
          null,
          2,
        );

        const mainRaw = await invokeGrok(
          env.GROK_MAIN_API_KEY,
          "grok-4.20-0309-reasoning",
          mainSystemPrompt,
          mainUserPrompt,
          env,
        );
        const mainOutput = normalizeMainAgentOutput(extractJsonObject(mainRaw));
        validateMainAgentOutput(mainOutput);
        if (mainOutput.signals.length === 0) {
          throw new Error("Model output missing required items: main_agent.signals is empty");
        }

        await adminDb(env)
          .from("agent_runs")
          .update({
            status: "completed",
            finished_at: new Date().toISOString(),
            token_usage: {
              phase: "phase11_evidence_impact_pipeline_v2",
              processed_by: "cloudflare_queue_consumer",
              guardrails: {
                maxTotalCalls: guardrails.maxTotalCalls,
                perToolLimit: guardrails.perToolLimit,
                maxDurationMs: guardrails.maxDurationMs,
                callsByTool: guardrails.callsByTool,
                totalCalls: guardrails.totalCalls,
                durationMs: Date.now() - guardrails.startedMs,
              },
              context: {
                holdings: context.holdings.length,
                theses: context.theses.length,
                tickers: contextTickers.length,
              },
              quotes: {
                count: quotes.quotes.length,
              },
              macro: {
                ecb_observations: ecbData.observations.length,
                fred_observations: fredData.observations.length,
              },
              news: {
                count: news.items.length,
                query: news.query,
                provider: news.provider,
                recency_days: news.recencyDays,
                total_retrieved: news.totalRetrieved,
                fallback_reason:
                  news.provider === "google_rss_fallback" ? webSearchFallbackReason : null,
              },
              tool_calls: toolCalls,
              classification_stage: subPass1Output,
              evidence_stage: subOutput,
              impact_stage: mainOutput,
              sub_agent: subOutput,
              main_agent: mainOutput,
            },
          })
          .eq("id", runId)
          .neq("status", "cancelled");

        message.ack();
      } catch (error) {
        const classified = classifyQueueProcessingError(error);
        await adminDb(env)
          .from("agent_runs")
          .update({
            status: classified.statusOverride ?? "failed",
            finished_at: new Date().toISOString(),
            error_code: classified.errorCode,
            error_detail: classified.detail,
            token_usage: {
              phase: "phase8_failure_classification_v1",
              failure_class: classified.failureClass,
              retryable: classified.retryable,
            },
          })
          .eq("id", runId);
        if (classified.retryable) message.retry();
        else message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

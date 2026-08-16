import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deriveMarketTopics, mentionsTopic, type MarketTopic } from "./market-topics";
import { isFundLike } from "./portfolio-profile";
import {
  aggregateObservationsByCompany,
  computeEwma,
  mergeEvidenceClusterIds,
  mergeScoredClusterIds,
  scoreClusterSentiments,
  type ClusterSentiment,
  type ScoredClusterRecord,
  type SentimentCompanyRef,
  type SentimentTarget,
} from "./sentiment";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  EXA_SEARCH?: string;
  GROK_MAIN_API_KEY?: string;
  GROK_SUB_API_KEY?: string;
  GROK_NORMALIZATION_API_KEY?: string;
  GROK_API_BASE_URL?: string;
  SENTIMENT_GROK_MODEL?: string;
}

interface HoldingRow {
  id: string;
  ticker: string;
  isin: string | null;
  asset_type: string | null;
  name: string;
  quantity: number;
  portfolio_id: string;
}

// Exa Search API shapes (POST https://api.exa.ai/search)
interface ExaSearchResult {
  id?: string;
  url?: string;
  title?: string;
  publishedDate?: string | null;
  author?: string | null;
  image?: string;
  favicon?: string;
  score?: number;
  summary?: string;
}

interface ExaSearchResponse {
  requestId?: string;
  searchType?: string;
  results?: ExaSearchResult[];
  costDollars?: { total?: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXA_BASE = "https://api.exa.ai";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
// 7-day window: French/European mid-caps have sparse coverage. A short window
// often returns 0 articles; 7 days keeps the feed populated. The expires_at TTL
// uses the same value so we don't surface stale content indefinitely.
const CLUSTER_TTL_HOURS = 168;
const NEWS_WINDOW_MS = CLUSTER_TTL_HOURS * 3_600_000;
const RESULTS_PER_COMPANY = 25;
// Bounded concurrency for the Exa fetch phase.
const FETCH_CONCURRENCY = 4;
// Hard cap on ETF-derived market-topic searches per run (subrequest-budget guard).
const MAX_MARKET_TOPICS = 12;
const NEWS_SUBREQUEST_BUDGET = 50;
const MAX_COMPANY_SENTIMENT_ATTEMPTS = 3;
const MAX_COMPANY_SENTIMENT_SUBREQUESTS = 1 + MAX_COMPANY_SENTIMENT_ATTEMPTS * 5;
const MAX_FIXED_FANOUT_SUBREQUESTS = 11;
const MAX_POST_SEARCH_SUBREQUESTS = 24;
export const MAX_COMPANY_SEARCHES_PER_RUN = Math.max(
  1,
  Math.floor(
    (NEWS_SUBREQUEST_BUDGET -
      MAX_MARKET_TOPICS -
      MAX_FIXED_FANOUT_SUBREQUESTS -
      MAX_COMPANY_SENTIMENT_SUBREQUESTS) /
      2,
  ),
);
const FANOUT_WINDOW = MAX_COMPANY_SEARCHES_PER_RUN;
const FANOUT_ROTATION_INTERVAL_MS = 3_600_000;
// Per-topic keep cap (best Exa score first) so broad market queries don't
// drown per-company coverage in the feed.
const MARKET_RESULTS_KEPT = 12;

// Source-quality allowlist: curated premium financial/news outlets. An allowlist
// (not blocklist) decisively cuts the long tail of quote pages / SEO junk.
// NOTE: Exa returns HTTP 403 ("domains not available") for the WHOLE request if
// includeDomains names a domain it no longer indexes — and these were dropped
// from Exa's index (publisher opt-outs / removed crawl): wsj.com, bloomberg.com,
// reuters.com, apnews.com, breakingviews.reuters.com. They are removed below so
// the allowlist works; only add a domain back after confirming Exa still indexes
// it (a single search with includeDomains:[domain] 403s if it doesn't).
export const NEWS_INCLUDE_DOMAINS = [
  "ft.com",
  "economist.com",
  "barrons.com",
  "marketwatch.com",
  "cnbc.com",
  "seekingalpha.com",
  "morningstar.com",
  "imf.org",
  "worldbank.org",
  "bis.org",
  "ecb.europa.eu",
  "banque-france.fr",
  "sec.gov",
  "amf-france.org",
  "oecd.org",
  "alphaville.ft.com",
  "institutionalinvestor.com",
  "pensions-investments.com",
  "zerohedge.com",
  "calculatedriskblog.com",
  "lesechos.fr",
  "latribune.fr",
  "boursier.com",
  "boursorama.com",
  "challenges.fr",
  "euronews.com",
];

// Secondary (broader / small-cap-friendly) allowlist — only searched when the
// premium list yields too few on-target results for a company. Tune as needed.
export const NEWS_INCLUDE_DOMAINS_SECONDARY = [
  "investir.lesechos.fr",
  "capital.fr",
  "usinenouvelle.com",
  "agefi.fr",
  "tradingsat.com",
  "bfmtv.com",
];

// Trigger a secondary search when fewer than this many on-target results come
// back from the premium list (big caps often return mostly sector-noise, so the
// company-specific count is low even for well-covered names).
const MIN_ONTARGET = 4;

// Source-quality priority for cross-story dedup (lower = better, kept on merge).
// Exa's score is relevance, NOT authority, so quality ranking must be explicit.
const SOURCE_TIER: Record<string, number> = {
  "reuters.com": 1,
  "bloomberg.com": 1,
  "ft.com": 1,
  "wsj.com": 1,
  "economist.com": 1,
  "apnews.com": 1,
  // Top French sources — human-written, high quality for this portfolio.
  "lesechos.fr": 1,
  "boursier.com": 1,
  "boursorama.com": 1,
  "barrons.com": 2,
  "cnbc.com": 2,
  "marketwatch.com": 2,
  "latribune.fr": 2,
  "sec.gov": 2,
  "ecb.europa.eu": 2,
  "imf.org": 2,
  "amf-france.org": 2,
  "seekingalpha.com": 3,
  "morningstar.com": 3,
  "challenges.fr": 3,
  "euronews.com": 3,
};
function sourceTier(source: string): number {
  return SOURCE_TIER[source.replace(/^www\./i, "")] ?? 99;
}

// French-language sources → drive the language of the generated summary.
const FRENCH_DOMAINS = new Set([
  "lesechos.fr",
  "investir.lesechos.fr",
  "boursier.com",
  "boursorama.com",
  "latribune.fr",
  "challenges.fr",
  "capital.fr",
  "usinenouvelle.com",
  "agefi.fr",
  "tradingsat.com",
  "bfmtv.com",
  "banque-france.fr",
  "amf-france.org",
]);
function isFrenchSource(source: string): boolean {
  const s = source.replace(/^www\./i, "");
  return FRENCH_DOMAINS.has(s) || s.endsWith(".fr");
}

// English stopwords + filler — dropped from title signatures so dedup compares
// the distinctive tokens of a story.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "in",
  "on",
  "and",
  "or",
  "as",
  "at",
  "by",
  "from",
  "with",
  "is",
  "are",
  "be",
  "its",
  "it",
  "that",
  "this",
  "se",
  "sa",
  "inc",
  "ltd",
  "plc",
  "corp",
  "co",
  "group",
  "news",
  "update",
  "latest",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NewsSubrequestBudgetExceededError extends Error {
  constructor() {
    super("news fanout subrequest budget exhausted");
    this.name = "NewsSubrequestBudgetExceededError";
  }
}

type NewsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

class NewsSubrequestBudget {
  private used = 0;
  private reserved = 0;

  reserve(count: number): void {
    if (this.used + this.reserved + count > NEWS_SUBREQUEST_BUDGET) {
      throw new NewsSubrequestBudgetExceededError();
    }
    this.reserved += count;
  }

  release(count: number): void {
    this.reserved = Math.max(0, this.reserved - count);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.used + this.reserved >= NEWS_SUBREQUEST_BUDGET) {
      throw new NewsSubrequestBudgetExceededError();
    }
    this.used++;
    return globalThis.fetch(input, init);
  }
}

export function selectRotatingWindow<T>(
  entries: readonly T[],
  limit: number,
  now: number = Date.now(),
): T[] {
  if (entries.length === 0 || limit <= 0) return [];
  if (entries.length <= limit) return [...entries];
  const start = Math.floor(now / FANOUT_ROTATION_INTERVAL_MS) % entries.length;
  return Array.from({ length: limit }, (_, offset) => entries[(start + offset) % entries.length]);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Canonical key for one company — collapses multi-lot / dual-listing rows of the
// same company into a single work-list entry so they don't double-boost.
function canonicalKey(h: HoldingRow): string {
  if (h.isin) return `isin:${h.isin.toUpperCase()}`;
  if (h.ticker) return `ticker:${h.ticker.toUpperCase()}`;
  return `name:${normalizeName(h.name)}`;
}

// Map exchange suffix → ISO 2-letter country code for Exa userLocation
const EXCHANGE_COUNTRY: Record<string, string> = {
  PA: "FR",
  DE: "DE",
  AS: "NL",
  MI: "IT",
  L: "GB",
  SW: "CH",
  MC: "ES",
  BE: "BE",
  VI: "AT",
  CO: "DK",
  HE: "FI",
  ST: "SE",
  OL: "NO",
};

function deriveUserLocation(workList: Map<string, CompanyEntry>): string {
  const counts = new Map<string, number>();
  for (const entry of workList.values()) {
    for (const holder of entry.holders.values()) {
      for (const ticker of holder.tickers) {
        const suffix = ticker.split(".").pop()?.toUpperCase() ?? "";
        const country = EXCHANGE_COUNTRY[suffix];
        if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return "FR";
  return [...counts.entries()].sort(([, a], [, b]) => b - a)[0][0];
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

// Drop stock-quote / price-chart / data pages with no editorial content, even
// when they sit on an allowed news domain and pass category:"news".
// Catches e.g. "Legrand ADR Stock Quote - MarketWatch" and markets.ft.com data pages.
const LOW_VALUE_TITLE =
  /stock quote|share price|markets data|stock price|\bADR\b.*\bquote\b|cours de bourse|quote \(|price target|^subscribe to (read|continue)|^log ?in|^sign ?in/i;
const LOW_VALUE_PATH = /\/(quote|quotes|cours|stock-quote|share-price|chart)\b/i;

function isLowValuePage(title: string, url: string): boolean {
  const host = hostname(url);
  if (/^markets\./i.test(host)) return true; // markets.ft.com etc. — pure data
  if (LOW_VALUE_TITLE.test(title)) return true;
  try {
    if (LOW_VALUE_PATH.test(new URL(url).pathname)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

// Run an async fn over items with a fixed concurrency cap. Never rejects —
// per-item failures are handled inside `fn` (mirrors Promise.allSettled).
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]);
    }
  });
  await Promise.allSettled(workers);
}

// ---------------------------------------------------------------------------
// Work-list: one entry per distinct company, deduped across all portfolios
// ---------------------------------------------------------------------------

interface CompanyHolder {
  tickers: Set<string>;
  isins: Set<string>;
}

interface CompanyEntry {
  canonicalKey: string;
  query: string; // canonical query string — the company name, computed once
  holders: Map<string, CompanyHolder>; // portfolioId → that portfolio's identifiers
}

async function buildGlobalWorkList(
  client: AnySupabaseClient,
): Promise<{ workList: Map<string, CompanyEntry>; fundHoldings: HoldingRow[] }> {
  const { data, error } = await client
    .from("holdings")
    .select("id,ticker,isin,asset_type,name,quantity,portfolio_id")
    .gt("quantity", 0);

  if (error) {
    throw new Error(`[news] failed to fetch holdings: ${error.message}`);
  }

  const holdings = (data as HoldingRow[] | null) ?? [];
  const workList = new Map<string, CompanyEntry>();
  const fundHoldings: HoldingRow[] = [];

  for (const h of holdings) {
    if (!h.name && !h.ticker && !h.isin) continue;
    if (isFundLike(h.asset_type, h.name)) {
      // Fund-like holdings don't get per-company queries — they map to 1-2
      // market topics each via buildMarketWorkList instead.
      fundHoldings.push(h);
      continue;
    }

    const key = canonicalKey(h);
    let entry = workList.get(key);
    if (!entry) {
      entry = { canonicalKey: key, query: h.name?.trim() || h.ticker, holders: new Map() };
      workList.set(key, entry);
    }

    let holder = entry.holders.get(h.portfolio_id);
    if (!holder) {
      holder = { tickers: new Set(), isins: new Set() };
      entry.holders.set(h.portfolio_id, holder);
    }
    if (h.ticker) holder.tickers.add(h.ticker.toUpperCase());
    if (h.isin) holder.isins.add(h.isin.toUpperCase());
  }

  return { workList, fundHoldings };
}

// ---------------------------------------------------------------------------
// Market work-list: one entry per distinct market topic derived from the held
// ETFs. Taxonomy data (etf_constituents + holding_geography_allocations) is
// best-effort — read failures or empty tables degrade to the static
// name/ticker override table in market-topics.ts.
// ---------------------------------------------------------------------------

interface MarketHolder {
  etfTickers: Set<string>;
}

interface MarketEntry {
  canonicalKey: string; // `topic:${topicKey}`
  topic: MarketTopic;
  holders: Map<string, MarketHolder>; // portfolioId → the ETFs that map here
}

interface EtfConstituentRow {
  etf_isin: string;
  constituents: Array<{ ticker?: string; name?: string }> | null;
  top_sectors: Array<{ sector: string; weight_pct: number }> | null;
}

interface GeographyRow {
  holding_id: string;
  country_code: string;
  country_name: string;
  weight_pct: number;
}

async function buildMarketWorkList(
  client: AnySupabaseClient,
  fundHoldings: HoldingRow[],
): Promise<Map<string, MarketEntry>> {
  const marketList = new Map<string, MarketEntry>();
  if (fundHoldings.length === 0) return marketList;

  // Collapse multi-lot / multi-portfolio rows of the same ETF (same canonical
  // key logic as companies) so each distinct ETF is mapped once.
  interface DistinctEtf {
    ticker: string;
    isin: string | null;
    name: string;
    holdingIds: string[];
    holders: Map<string, MarketHolder>;
  }
  const etfs = new Map<string, DistinctEtf>();
  for (const h of fundHoldings) {
    const key = canonicalKey(h);
    let etf = etfs.get(key);
    if (!etf) {
      etf = {
        ticker: (h.ticker ?? "").toUpperCase(),
        isin: h.isin ? h.isin.toUpperCase() : null,
        name: h.name ?? "",
        holdingIds: [],
        holders: new Map(),
      };
      etfs.set(key, etf);
    }
    etf.holdingIds.push(h.id);
    let holder = etf.holders.get(h.portfolio_id);
    if (!holder) {
      holder = { etfTickers: new Set() };
      etf.holders.set(h.portfolio_id, holder);
    }
    if (h.ticker) holder.etfTickers.add(h.ticker.toUpperCase());
  }

  // Best-effort taxonomy seeds — 2 batched reads, each individually guarded so
  // a failed read (a resolved Supabase {error} or a genuine rejection) degrades
  // that seed only: static name/ticker overrides in deriveMarketTopics must
  // always run.
  const isins = [...new Set([...etfs.values()].map((e) => e.isin).filter(Boolean))] as string[];
  const holdingIds = fundHoldings.map((h) => h.id);

  const constituentsByIsin = new Map<string, EtfConstituentRow>();
  if (isins.length > 0) {
    try {
      const { data, error } = await client
        .from("etf_constituents")
        .select("etf_isin,constituents,top_sectors")
        .in("etf_isin", isins);
      if (error) {
        console.warn(
          "[news] etf_constituents read failed (static overrides still apply):",
          error.message,
        );
      }
      for (const row of (data as EtfConstituentRow[] | null) ?? []) {
        constituentsByIsin.set(row.etf_isin, row);
      }
    } catch (err) {
      console.warn("[news] etf_constituents read failed (static overrides still apply):", err);
    }
  }

  const countryWeightsByHolding = new Map<string, GeographyRow[]>();
  try {
    const { data, error } = await client
      .from("holding_geography_allocations")
      .select("holding_id,country_code,country_name,weight_pct")
      .in("holding_id", holdingIds);
    if (error) {
      console.warn(
        "[news] geography allocations read failed (static overrides still apply):",
        error.message,
      );
    }
    for (const row of (data as GeographyRow[] | null) ?? []) {
      const list = countryWeightsByHolding.get(row.holding_id) ?? [];
      list.push(row);
      countryWeightsByHolding.set(row.holding_id, list);
    }
  } catch (err) {
    console.warn("[news] geography allocations read failed (static overrides still apply):", err);
  }

  for (const etf of etfs.values()) {
    // Merge country weights across this ETF's holding rows — same ETF means
    // the same research result, so keep the max weight per country.
    const mergedCountries = new Map<string, GeographyRow>();
    for (const id of etf.holdingIds) {
      for (const cw of countryWeightsByHolding.get(id) ?? []) {
        const prev = mergedCountries.get(cw.country_code);
        if (!prev || Number(cw.weight_pct) > Number(prev.weight_pct)) {
          mergedCountries.set(cw.country_code, cw);
        }
      }
    }

    const constituentRow = etf.isin ? constituentsByIsin.get(etf.isin) : undefined;
    const topConstituents = (constituentRow?.constituents ?? [])
      .slice(0, 10)
      .map((c) => c.name || c.ticker || "")
      .filter(Boolean);

    const topics = deriveMarketTopics(
      { ticker: etf.ticker, isin: etf.isin, name: etf.name },
      {
        topSectors: constituentRow?.top_sectors ?? null,
        countryWeights: [...mergedCountries.values()].map((cw) => ({
          country_code: cw.country_code,
          country_name: cw.country_name,
          weight_pct: Number(cw.weight_pct),
        })),
        topConstituents,
      },
    );

    for (const topic of topics) {
      const key = `topic:${topic.topicKey}`;
      let entry = marketList.get(key);
      if (!entry) {
        entry = { canonicalKey: key, topic, holders: new Map() };
        marketList.set(key, entry);
      } else {
        // Same topic derived from another ETF: union the relevance terms so a
        // headline mentioning only the later ETF's top constituents still
        // passes mentionsTopic for every holder of this topic.
        entry.topic.relevanceTerms = [
          ...new Set([...entry.topic.relevanceTerms, ...topic.relevanceTerms]),
        ];
      }
      for (const [portfolioId, holder] of etf.holders) {
        let merged = entry.holders.get(portfolioId);
        if (!merged) {
          merged = { etfTickers: new Set() };
          entry.holders.set(portfolioId, merged);
        }
        holder.etfTickers.forEach((t) => merged!.etfTickers.add(t));
      }
    }
  }

  return marketList;
}

// ---------------------------------------------------------------------------
// Exa Search with retry/backoff
// ---------------------------------------------------------------------------

async function exaSearchNews(
  apiKey: string,
  query: string,
  startPublishedDate: string,
  userLocation: string,
  includeDomains: string[],
  fetchImpl: NewsFetch = fetch,
  attempt = 1,
): Promise<ExaSearchResponse> {
  let res: Response;
  try {
    res = await fetchImpl(`${EXA_BASE}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        category: "news",
        numResults: RESULTS_PER_COMPANY,
        startPublishedDate,
        userLocation,
        includeDomains,
        // No `contents` — search returns title/url/publishedDate/image/score natively.
        // Summaries are fetched only for survivors via the Contents API (cheaper).
      }),
    });
  } catch (err) {
    if (err instanceof NewsSubrequestBudgetExceededError) throw err;
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaSearchNews(
      apiKey,
      query,
      startPublishedDate,
      userLocation,
      includeDomains,
      fetchImpl,
      attempt + 1,
    );
  }

  // Retry only transient failures. 400/401/422 are deterministic — fail fast.
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Exa ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaSearchNews(
      apiKey,
      query,
      startPublishedDate,
      userLocation,
      includeDomains,
      fetchImpl,
      attempt + 1,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Exa ${res.status}: ${body}`);
  }

  return res.json() as Promise<ExaSearchResponse>;
}

// ---------------------------------------------------------------------------
// Exa Contents — fetch summaries for a batch of URLs in ONE call.
// On /contents, `summary` is TOP-LEVEL (unlike /search where it nests in contents).
// summaryQuery is written in the target language so the summary matches the article.
// ---------------------------------------------------------------------------

interface ExaContentsResponse {
  results?: Array<{ id?: string; url?: string; summary?: string }>;
  error?: string;
}

async function exaFetchSummaries(
  apiKey: string,
  urls: string[],
  summaryQuery: string,
  fetchImpl: NewsFetch = fetch,
  attempt = 1,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;

  let res: Response;
  try {
    res = await fetchImpl(`${EXA_BASE}/contents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      // Prefer Exa's cached/indexed content (what search-summary used) over a fresh
      // livecrawl, which hits paywalls (Bloomberg/FT/MarketWatch) and returns no text.
      body: JSON.stringify({ urls, summary: { query: summaryQuery }, maxAgeHours: 720 }),
    });
  } catch (err) {
    if (err instanceof NewsSubrequestBudgetExceededError) throw err;
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaFetchSummaries(apiKey, urls, summaryQuery, fetchImpl, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Exa contents ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaFetchSummaries(apiKey, urls, summaryQuery, fetchImpl, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Exa contents ${res.status}: ${body}`);
  }

  const json = (await res.json()) as ExaContentsResponse;
  for (const r of json.results ?? []) {
    const key = r.url ?? r.id;
    if (key && r.summary) out.set(key, r.summary);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decides what a cluster's `sentiments` write should be. Grok can return
// valid, parseable JSON that still only covers a subset of the requested
// (cluster, company) pairs — that's success, not a scoring failure, so
// scoreClusterSentiments reports no error. Treating "no error" as "every
// cluster is fully scored" would write a partial or empty sentiments array
// for the omitted pairs and silently erase whatever was already stored for
// them. So a cluster's sentiments are only written when every company
// requested for it got an answer; otherwise the write is skipped (null)
// so the upsert leaves the stored data untouched, same as a full failure.
// The companies missing this run stay eligible (not in scored_cluster_ids)
// and get re-scored on the next fanout while their cluster is still in the
// TTL window — no permanent loss, just a delayed observation.
// ---------------------------------------------------------------------------

export function resolveSentimentsForRow(
  expectedCompanyKeys: string[],
  scored: ClusterSentiment[],
  sentimentError: string | null,
): ClusterSentiment[] | null {
  if (sentimentError) return null;
  const expected = new Set(expectedCompanyKeys);
  const answered = new Set(scored.map((s) => s.companyKey));
  if (
    scored.length !== expected.size ||
    answered.size !== expected.size ||
    [...expected].some((companyKey) => !answered.has(companyKey))
  ) {
    return null;
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Cluster row builder — pure, no DB call (batch upsert happens after Phase 1)
// Dropping the per-row pre-SELECT + GREATEST(expires_at) logic keeps subrequests
// within the free-plan cap. expires_at = published_at + TTL is deterministic for
// a given article (published_at is fixed), so re-fetching computes the same value.
// ---------------------------------------------------------------------------

export function buildClusterRow(
  result: ExaSearchResult,
  tickers: string[],
  isins: string[],
  summary: string,
  sentiments: ClusterSentiment[] | null,
  companiesByKey: Map<string, SentimentCompanyRef>,
  countries: string[] = [],
  sectors: string[] = [],
  priorSentiments: unknown[] = [],
) {
  const url = result.url!;
  const currentSentiments =
    sentiments?.map((s) => {
      const ref = companiesByKey.get(s.companyKey);
      return {
        company_key: s.companyKey,
        company_name: ref?.name ?? null,
        tickers: ref?.tickers ?? [],
        isins: ref?.isins ?? [],
        score: s.score,
        rationale: s.rationale,
      };
    }) ?? null;
  const currentCompanyKeys = new Set(
    (currentSentiments ?? []).map((sentiment) => sentiment.company_key),
  );
  const preservedSentiments = priorSentiments.filter(
    (sentiment): sentiment is Record<string, unknown> =>
      Boolean(sentiment) &&
      typeof sentiment === "object" &&
      typeof (sentiment as Record<string, unknown>).company_key === "string" &&
      !currentCompanyKeys.has((sentiment as Record<string, unknown>).company_key),
  );
  return {
    cluster_key: result.id ?? url,
    primary_article: {
      title: result.title ?? "",
      url,
      source: hostname(url),
      published_at: result.publishedDate!,
      // Strip an occasional leading "Summary:"/"Résumé:" label.
      snippet: summary.replace(/^\s*(summary|résumé|resume)\s*:\s*/i, "").trim(),
      image: result.image ?? null,
      exa_score: typeof result.score === "number" ? result.score : null,
    },
    see_also: [] as unknown[],
    entities: { isins, tickers, countries, sectors },
    // Per-(cluster, company) sentiment from the batched Grok scoring call —
    // reintroduces the field V1 deliberately dropped (see migration
    // 20260520195025 comment). null = scoring failed this run: the key is
    // omitted so the conflict upsert leaves any previously stored sentiments
    // untouched (fresh rows fall back to the column default '[]'). An empty
    // array is a legitimate "scored, nothing returned for this cluster" result
    // and is written as-is.
    ...(sentiments === null
      ? {}
      : {
          sentiments: [...(currentSentiments ?? []), ...preservedSentiments],
    }),
    published_at: result.publishedDate!,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(new Date(result.publishedDate!).getTime() + NEWS_WINDOW_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Company-sentiment update lock — guards the read-modify-write EWMA merge
// below against a lost update when two fanout runs overlap for the same
// company (e.g. the admin-only /_debug/run-news-fanout endpoint fired while
// a scheduled run is still in flight). PostgREST gives no transaction that
// spans multiple HTTP calls, so the compare-and-swap has to happen
// server-side: try_acquire_company_sentiment_lock (in the news-sentiment
// migration) is checked before the prior-state read, and
// apply_company_sentiment_batch re-validates the same lease — atomically,
// in the same transaction as the write via `select ... for update` — right
// before writing. The second check is what closes the gap a TTL check alone
// leaves open: acquiring the lease and writing are still two separate round
// trips, so a caller whose read-modify work stalls past the TTL could
// otherwise resume and overwrite a row a second caller already wrote after
// stealing the expired lease.
// ---------------------------------------------------------------------------

const COMPANY_SENTIMENT_LOCK_TTL_SECONDS = 60;
const COMPANY_SENTIMENT_RETRY_DELAY_MS = 10;

async function acquireCompanySentimentLock(
  client: AnySupabaseClient,
  holder: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("try_acquire_company_sentiment_lock", {
    p_holder: holder,
    p_ttl_seconds: COMPANY_SENTIMENT_LOCK_TTL_SECONDS,
  });
  if (error) {
    console.error("[news] company sentiment lock acquire failed:", error.message);
    return false;
  }
  return data === true;
}

async function releaseCompanySentimentLock(
  client: AnySupabaseClient,
  holder: string,
): Promise<void> {
  const { error } = await client
    .from("company_sentiment_lock")
    .delete()
    .eq("id", "singleton")
    .eq("holder", holder);
  if (error) console.error("[news] company sentiment lock release failed:", error.message);
}

// ---------------------------------------------------------------------------
// Rolling per-company sentiment (EWMA) — lock contention and lease loss get
// bounded retries, each re-reading the current rows before merging.
// ---------------------------------------------------------------------------

export async function updateRollingCompanySentiment(
  client: AnySupabaseClient,
  idBackedSentiments: ClusterSentiment[],
  companiesByKey: Map<string, SentimentCompanyRef>,
): Promise<{ companiesRescored: number; error: string | null }> {
  if (idBackedSentiments.length === 0 && companiesByKey.size === 0) {
    return { companiesRescored: 0, error: null };
  }

  const companyKeys = [
    ...new Set([...idBackedSentiments.map((s) => s.companyKey), ...companiesByKey.keys()]),
  ];
  let lastError = "company sentiment update skipped: another fanout run holds the lock";

  if (idBackedSentiments.length > 0) {
    const pendingRows = idBackedSentiments.map((sentiment) => {
      const ref = companiesByKey.get(sentiment.companyKey);
      return {
        company_key: sentiment.companyKey,
        company_name: ref?.name ?? sentiment.companyKey,
        ticker: ref?.tickers[0] ?? null,
        isin: ref?.isins[0] ?? null,
        cluster_id: sentiment.clusterKey,
        score: sentiment.score,
        rationale: sentiment.rationale,
        observed_at: new Date().toISOString(),
      };
    });
    const { error: enqueueError } = await client.rpc("enqueue_company_sentiment_pending", {
      p_rows: pendingRows,
    });
    if (enqueueError) {
      const msg = enqueueError.message;
      console.error("[news] company sentiment enqueue failed:", msg);
      return { companiesRescored: 0, error: msg };
    }
  }

  for (let attempt = 1; attempt <= MAX_COMPANY_SENTIMENT_ATTEMPTS; attempt++) {
    const holder = crypto.randomUUID();
    if (!(await acquireCompanySentimentLock(client, holder))) {
      if (attempt < MAX_COMPANY_SENTIMENT_ATTEMPTS) {
        await sleep(COMPANY_SENTIMENT_RETRY_DELAY_MS * attempt);
      }
      continue;
    }

    let retryLeaseLoss = false;
    try {
      const { data: pendingRows, error: pendingError } = await client
        .from("company_sentiment_pending")
        .select("company_key, cluster_id, company_name, ticker, isin, score, rationale");

      if (pendingError) throw new Error(pendingError.message);

      const readCompanyKeys = [
        ...new Set([
          ...companyKeys,
          ...(pendingRows ?? []).map((row: { company_key: string }) => row.company_key),
        ]),
      ];
      const { data: priorRows, error: priorError } = await client
        .from("company_sentiment")
        .select("company_key, score, evidence_cluster_ids, scored_cluster_ids")
        .in("company_key", readCompanyKeys);

      if (priorError) throw new Error(priorError.message);

      const queuedSentiments: ClusterSentiment[] = (pendingRows ?? []).map(
        (r: {
          company_key: string;
          cluster_id: string;
          company_name: string;
          ticker: string | null;
          isin: string | null;
          score: number;
          rationale: string;
        }) => {
          if (!companiesByKey.has(r.company_key)) {
            companiesByKey.set(r.company_key, {
              canonicalKey: r.company_key,
              name: r.company_name,
              tickers: r.ticker ? [r.ticker] : [],
              isins: r.isin ? [r.isin] : [],
            });
          }
          return {
            clusterKey: r.cluster_id,
            companyKey: r.company_key,
            score: r.score,
            rationale: r.rationale,
          };
        },
      );
      const seenObservationKeys = new Set<string>();
      const observations = [...queuedSentiments, ...idBackedSentiments].filter((sentiment) => {
        const key = `${sentiment.companyKey}\u0000${sentiment.clusterKey}`;
        if (seenObservationKeys.has(key)) return false;
        seenObservationKeys.add(key);
        return true;
      });

      const priorByKey = new Map<
        string,
        { score: number; evidence_cluster_ids: string[]; scored_cluster_ids: ScoredClusterRecord[] }
      >(
        (priorRows ?? []).map(
          (r: {
            company_key: string;
            score: number;
            evidence_cluster_ids: string[] | null;
            scored_cluster_ids: ScoredClusterRecord[] | null;
          }) => [
            r.company_key,
            {
              score: r.score,
              evidence_cluster_ids: r.evidence_cluster_ids ?? [],
              scored_cluster_ids: r.scored_cluster_ids ?? [],
            },
          ],
        ),
      );

      const priorScoredByCompany = new Map<string, Set<string>>(
        [...priorByKey].map(([companyKey, prior]) => [
          companyKey,
          new Set(prior.scored_cluster_ids.map((r) => r.id)),
        ]),
      );
      const observationsByCompany = aggregateObservationsByCompany(
        observations,
        priorScoredByCompany,
      );

      const now = Date.now();
      const companySentimentRows = [...observationsByCompany].map(([companyKey, obs]) => {
        const prior = priorByKey.get(companyKey) ?? null;
        const { score, trend } = computeEwma(prior?.score ?? null, obs.observedScore);
        const ref = companiesByKey.get(companyKey);
        return {
          company_key: companyKey,
          company_name: ref?.name ?? companyKey,
          ticker: ref?.tickers[0] ?? null,
          isin: ref?.isins[0] ?? null,
          score,
          trend,
          evidence_cluster_ids: mergeEvidenceClusterIds(
            prior?.evidence_cluster_ids ?? [],
            obs.clusterKeys,
          ),
          scored_cluster_ids: mergeScoredClusterIds(
            prior?.scored_cluster_ids ?? [],
            obs.clusterKeys,
            now,
            NEWS_WINDOW_MS,
          ),
          updated_at: new Date(now).toISOString(),
        };
      });

      if (companySentimentRows.length === 0) return { companiesRescored: 0, error: null };

      const { data: applied, error: applyError } = await client.rpc("apply_company_sentiment_batch", {
        p_holder: holder,
        p_rows: companySentimentRows,
      });

      if (applyError) throw new Error(applyError.message);
      if (applied !== true) {
        lastError = "company sentiment update skipped: lease was lost before the write completed";
        retryLeaseLoss = true;
      } else {
        return { companiesRescored: companySentimentRows.length, error: null };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[news] rolling company sentiment update failed:", msg);
      return { companiesRescored: 0, error: msg };
    } finally {
      await releaseCompanySentimentLock(client, holder);
    }

    if (retryLeaseLoss && attempt < MAX_COMPANY_SENTIMENT_ATTEMPTS) {
      await sleep(COMPANY_SENTIMENT_RETRY_DELAY_MS * attempt);
    }
  }

  return { companiesRescored: 0, error: lastError };
}

// ---------------------------------------------------------------------------
// Score: exaScore × recencyDecay × holdingsBooster (hybrid; each signal once)
// ---------------------------------------------------------------------------

function computeMatchScore(exaScore: number, publishedAt: string, holdingsHit: number): number {
  // Missing score → 0.5: the result came from this company's query, so a format
  // quirk shouldn't zero it out.
  const exa = Math.min(1, Math.max(0, Number.isFinite(exaScore) ? exaScore : 0.5));
  const booster = Math.min(1.3, 1 + (Math.max(1, holdingsHit) - 1) * 0.15);
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  const recency = Math.max(0.1, 1 - (ageHours / CLUSTER_TTL_HOURS) * 0.9);
  return Math.round(exa * recency * booster * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Name-presence (drift filter) + cross-story dedup helpers
// ---------------------------------------------------------------------------

// Normalize a company name to its searchable core (drop legal suffixes/punctuation).
function coreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôöùûüç\s]/gi, " ")
    .replace(/\b(se|sa|plc|inc|ltd|corp|nv|ag|spa|llc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Does the title/summary actually mention the company? Requires the FULL core
// name (e.g. "schneider electric", not bare "schneider") — a single proper-noun
// token is too loose for surname-like names (matched a baseball article on
// "schneider"). The LLM summaries reliably contain the full official name.
// Tradeoff: drops articles that reference a company only by a partial name.
function mentionsCompany(haystack: string, companyNames: string[]): boolean {
  const hay = haystack.toLowerCase();
  for (const name of companyNames) {
    const core = coreName(name);
    if (core && hay.includes(core)) return true;
  }
  return false;
}

// Distinctive-token signature of a headline (company name + source label stripped).
function titleSignature(title: string, companyNames: string[]): Set<string> {
  let t = title.toLowerCase();
  t = t.replace(/\s+[–\-|]\s+[^–\-|]*$/u, " "); // trailing " – Bloomberg" / " | Seeking Alpha"
  t = t.replace(/\([^)]*\)/g, " "); // (TTE:NYSE)
  t = t
    .replace(/\$/g, " ")
    .replace(/(\d)\s*b\b/g, "$1 billion")
    .replace(/(\d)\s*m\b/g, "$1 million");
  for (const name of companyNames) {
    const core = coreName(name);
    if (core) t = t.split(core).join(" ");
  }
  const tokens = t
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

// Collapse near-identical stories from different sources. Keeps the best source
// tier (tiebreak exaScore, then recency); merges companyKeys and entity sets so
// attribution survives. Conservative: requires ≥3 shared distinctive tokens AND
// ≥0.6 containment.
function dedupeByStory(
  pending: Map<string, PendingCluster>,
  queryByKey: Map<string, string>,
): number {
  const keys = [...pending.keys()];
  const sig = new Map<string, Set<string>>();
  for (const key of keys) {
    const pc = pending.get(key)!;
    const names = [...pc.companyKeys].map((ck) => queryByKey.get(ck) ?? "").filter(Boolean);
    sig.set(key, titleSignature(pc.result.title ?? "", names));
  }

  let dropped = 0;
  for (let i = 0; i < keys.length; i++) {
    const keyA = keys[i];
    if (!pending.has(keyA)) continue;
    for (let j = i + 1; j < keys.length; j++) {
      const keyB = keys[j];
      if (!pending.has(keyB)) continue;
      const a = sig.get(keyA)!;
      const b = sig.get(keyB)!;
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const containment = inter / Math.min(a.size, b.size);
      if (inter < 3 || containment < 0.6) continue;

      const pcA = pending.get(keyA)!;
      const pcB = pending.get(keyB)!;
      const tierA = sourceTier(hostname(pcA.result.url ?? ""));
      const tierB = sourceTier(hostname(pcB.result.url ?? ""));
      let dropKey: string;
      if (tierA !== tierB) dropKey = tierA < tierB ? keyB : keyA;
      else if (pcA.exaScore !== pcB.exaScore) dropKey = pcA.exaScore >= pcB.exaScore ? keyB : keyA;
      else {
        const da = new Date(pcA.result.publishedDate ?? 0).getTime();
        const db = new Date(pcB.result.publishedDate ?? 0).getTime();
        dropKey = da >= db ? keyB : keyA;
      }
      const keepKey = dropKey === keyA ? keyB : keyA;
      const keep = pending.get(keepKey)!;
      const drop = pending.get(dropKey)!;
      drop.companyKeys.forEach((ck) => keep.companyKeys.add(ck));
      drop.tickers.forEach((t) => keep.tickers.add(t));
      drop.isins.forEach((n) => keep.isins.add(n));
      drop.countries.forEach((c) => keep.countries.add(c));
      drop.sectors.forEach((s) => keep.sectors.add(s));
      pending.delete(dropKey);
      dropped++;
      if (dropKey === keyA) break; // A removed — stop comparing it
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Main: runNewsFanout (two-phase, globally deduped, batched DB writes)
//
// Subrequest budget (free plan cap = 50):
//   1    holdings query
//   0-2  ETF taxonomy reads (etf_constituents + geography; only when ETFs are held)
//   N    company Exa searches (one per distinct company, N=4 today)
//   ≤N   secondary company searches (only when premium results are thin)
//   M    market-topic Exa searches (one per distinct ETF-derived topic,
//        M ≤ MAX_MARKET_TOPICS=12, M≈4 today; no secondary tier for topics)
//   ≤2   Exa contents calls (batched summaries, one per language FR/EN)
//   1    cluster entities pre-read (batched .in() on cluster_key, so a
//        re-upsert never erases entity attribution from a previous run)
//   ≤2   batch cluster upserts (sentiment-bearing and sentiment-preserving rows)
//   1    batch match upsert
//   1    sweep
//   1    Grok sentiment scoring call (skipped if no survivors)
  //   ≤16  company sentiment enqueue/lock/read/write/release requests
  //   ─────────────────
  //   worst case physical fetches stay within the 50-subrequest cap.
// ---------------------------------------------------------------------------

interface PendingCluster {
  result: ExaSearchResult; // raw search result — summary fetched later via Contents API
  exaScore: number;
  companyKeys: Set<string>; // company canonical keys AND `topic:*` market keys
  tickers: Set<string>;
  isins: Set<string>;
  countries: Set<string>; // from market topics; empty for company-only clusters
  sectors: Set<string>;
}

interface ClusterAccum {
  publishedAt: string;
  exaScore: number;
  companyKeys: Set<string>;
}

export async function runNewsFanout(env: Env): Promise<{
  distinctCompaniesQueried: number;
  marketTopicsQueried: number;
  clustersUpserted: number;
  matchesUpserted: number;
  undatedDropped: number;
  lowValueDropped: number;
  offTargetDropped: number;
  offTopicDropped: number;
  secondarySearches: number;
  dedupedAway: number;
  expiredSwept: number;
  clustersScored: number;
  companiesRescored: number;
  errors: string[];
}> {
  const errors: string[] = [];

  if (!env.EXA_SEARCH) {
    console.warn("[news] EXA_SEARCH not set — skipping news fanout");
    return {
      distinctCompaniesQueried: 0,
      marketTopicsQueried: 0,
      clustersUpserted: 0,
      matchesUpserted: 0,
      undatedDropped: 0,
      lowValueDropped: 0,
      offTargetDropped: 0,
      offTopicDropped: 0,
      secondarySearches: 0,
      dedupedAway: 0,
      expiredSwept: 0,
      clustersScored: 0,
      companiesRescored: 0,
      errors: ["EXA_SEARCH not configured"],
    };
  }

  const apiKey = env.EXA_SEARCH;
  const budget = new NewsSubrequestBudget();
  const budgetFetch = budget.fetch.bind(budget);
  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    global: { fetch: budgetFetch },
  });

  // --- Build global work-list (1 subrequest) ---------------------------------
  const { workList, fundHoldings } = await buildGlobalWorkList(client);

  // --- Market work-list from held ETFs (0-2 subrequests) ---------------------
  let marketList = new Map<string, MarketEntry>();
  try {
    marketList = await buildMarketWorkList(client, fundHoldings);
  } catch (err) {
    // Market coverage is additive — never let it break the company fanout.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[news] market work-list failed:", msg);
    errors.push(`market work-list: ${msg}`);
  }
  const rotationNow = Date.now();
  const marketEntries = selectRotatingWindow(
    [...marketList.values()].sort((a, b) =>
      a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
    ),
    MAX_MARKET_TOPICS,
    rotationNow,
  );
  // Drop capped-away entries so later match/dedup phases can't reference them.
  marketList = new Map(marketEntries.map((e) => [e.canonicalKey, e]));

  const allCompanies = [...workList.values()].sort((a, b) =>
    a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
  );
  const companies = selectRotatingWindow(allCompanies, FANOUT_WINDOW, rotationNow);

  const startPublishedDate = new Date(Date.now() - NEWS_WINDOW_MS).toISOString();
  const userLocation = deriveUserLocation(workList);
  budget.reserve(MAX_POST_SEARCH_SUBREQUESTS);

  // --- Phase 1: FETCH — collect results, no DB writes (N..2N+M subrequests) --
  const pendingClusters = new Map<string, PendingCluster>();
  let undatedDropped = 0;
  let lowValueDropped = 0;
  let offTargetDropped = 0;
  let offTopicDropped = 0;
  let secondarySearches = 0;

  // Filter a result list for one company and add survivors to pendingClusters.
  // Returns the count of on-target (company-mentioning) results kept.
  const ingest = (
    results: ExaSearchResult[],
    company: CompanyEntry,
    tickerArr: string[],
    isinArr: string[],
  ): number => {
    let kept = 0;
    for (const result of results) {
      if (!result.publishedDate || !result.url) {
        undatedDropped++;
        continue;
      }
      if (isLowValuePage(result.title ?? "", result.url)) {
        lowValueDropped++;
        continue;
      }
      // Drift filter on the TITLE only (summary not fetched yet — see Contents step).
      if (!mentionsCompany(result.title ?? "", [company.query])) {
        offTargetDropped++;
        continue;
      }

      kept++;
      const clusterKey = result.id ?? result.url;
      const exaScore = typeof result.score === "number" ? result.score : 0.5;
      const existing = pendingClusters.get(clusterKey);
      if (existing) {
        existing.exaScore = Math.max(existing.exaScore, exaScore);
        existing.companyKeys.add(company.canonicalKey);
        tickerArr.forEach((t) => existing.tickers.add(t));
        isinArr.forEach((i) => existing.isins.add(i));
      } else {
        pendingClusters.set(clusterKey, {
          result,
          exaScore,
          companyKeys: new Set([company.canonicalKey]),
          tickers: new Set(tickerArr),
          isins: new Set(isinArr),
          countries: new Set(),
          sectors: new Set(),
        });
      }
    }
    return kept;
  };

  // Market analog of `ingest`: topic-relevance drift filter instead of the
  // company-name filter, plus a per-topic keep cap (best Exa score first).
  const ingestMarket = (results: ExaSearchResult[], entry: MarketEntry): void => {
    const survivors: Array<{ result: ExaSearchResult; exaScore: number }> = [];
    for (const result of results) {
      if (!result.publishedDate || !result.url) {
        undatedDropped++;
        continue;
      }
      if (isLowValuePage(result.title ?? "", result.url)) {
        lowValueDropped++;
        continue;
      }
      if (!mentionsTopic(result.title ?? "", entry.topic)) {
        offTopicDropped++;
        continue;
      }
      survivors.push({
        result,
        exaScore: typeof result.score === "number" ? result.score : 0.5,
      });
    }

    survivors.sort((a, b) => b.exaScore - a.exaScore);
    for (const s of survivors.slice(0, MARKET_RESULTS_KEPT)) {
      const clusterKey = s.result.id ?? s.result.url!;
      const existing = pendingClusters.get(clusterKey);
      if (existing) {
        existing.exaScore = Math.max(existing.exaScore, s.exaScore);
        existing.companyKeys.add(entry.canonicalKey);
        entry.topic.countries.forEach((c) => existing.countries.add(c));
        entry.topic.sectors.forEach((sec) => existing.sectors.add(sec));
      } else {
        pendingClusters.set(clusterKey, {
          result: s.result,
          exaScore: s.exaScore,
          companyKeys: new Set([entry.canonicalKey]),
          tickers: new Set(),
          isins: new Set(),
          countries: new Set(entry.topic.countries),
          sectors: new Set(entry.topic.sectors),
        });
      }
    }
  };

  await runWithConcurrency(companies, FETCH_CONCURRENCY, async (company) => {
    const tickers = new Set<string>();
    const isins = new Set<string>();
    for (const holder of company.holders.values()) {
      holder.tickers.forEach((t) => tickers.add(t));
      holder.isins.forEach((i) => isins.add(i));
    }
    const tickerArr = [...tickers];
    const isinArr = [...isins];
    // News-intent phrasing nudges ranking toward articles over reference pages.
    const newsQuery = `${company.query} latest news and developments`;

    // Primary search — premium allowlist.
    let primary: ExaSearchResponse;
    try {
      primary = await exaSearchNews(
        apiKey,
        newsQuery,
        startPublishedDate,
        userLocation,
        NEWS_INCLUDE_DOMAINS,
        budgetFetch,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[news] Exa primary failed for "${company.query}":`, msg);
      errors.push(`${company.canonicalKey}: ${msg}`);
      return;
    }
    if (primary.error) {
      console.error(`[news] Exa API error for "${company.query}":`, primary.error);
      errors.push(`${company.canonicalKey}: Exa error ${primary.error}`);
      return;
    }
    const onTarget = ingest(primary.results ?? [], company, tickerArr, isinArr);

    // Tiered fallback — too few on-target premium results → broaden once.
    if (onTarget < MIN_ONTARGET) {
      secondarySearches++;
      try {
        const secondary = await exaSearchNews(
          apiKey,
          newsQuery,
          startPublishedDate,
          userLocation,
          NEWS_INCLUDE_DOMAINS_SECONDARY,
          budgetFetch,
        );
        if (!secondary.error) ingest(secondary.results ?? [], company, tickerArr, isinArr);
        else errors.push(`${company.canonicalKey} (secondary): Exa error ${secondary.error}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[news] Exa secondary failed for "${company.query}":`, msg);
        errors.push(`${company.canonicalKey} (secondary): ${msg}`);
      }
    }
  });

  // Market-topic searches (M subrequests) — premium allowlist only. Macro/market
  // coverage is dense there, so no secondary tier: keeps the budget deterministic.
  await runWithConcurrency(marketEntries, FETCH_CONCURRENCY, async (entry) => {
    try {
      const response = await exaSearchNews(
        apiKey, entry.topic.query, startPublishedDate, userLocation, NEWS_INCLUDE_DOMAINS,
        budgetFetch,
      );
      if (response.error) {
        console.error(`[news] Exa API error for topic "${entry.topic.topicKey}":`, response.error);
        errors.push(`${entry.canonicalKey}: Exa error ${response.error}`);
        return;
      }
      ingestMarket(response.results ?? [], entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[news] Exa market search failed for "${entry.topic.topicKey}":`, msg);
      errors.push(`${entry.canonicalKey}: ${msg}`);
    }
  });
  budget.release(MAX_POST_SEARCH_SUBREQUESTS);

  // Collapse same-story duplicates across sources (keep best source tier).
  const queryByKey = new Map<string, string>();
  for (const [key, entry] of workList) queryByKey.set(key, entry.query);
  for (const [key, entry] of marketList) queryByKey.set(key, entry.topic.label);
  const dedupedAway = dedupeByStory(pendingClusters, queryByKey);

  // --- Fetch summaries for survivors only, in the article's language ---------
  const EN_SUMMARY_QUERY =
    "Summarize the key business, financial, and strategic developments in this article in 2-3 sentences.";
  const FR_SUMMARY_QUERY =
    "Résumez les principaux développements commerciaux, financiers et stratégiques de cet article en 2 à 3 phrases.";

  const survivors = [...pendingClusters.values()];
  const summaryByUrl = new Map<string, string>();
  const frUrls = survivors
    .filter((p) => isFrenchSource(hostname(p.result.url ?? "")))
    .map((p) => p.result.url!);
  const enUrls = survivors
    .filter((p) => !isFrenchSource(hostname(p.result.url ?? "")))
    .map((p) => p.result.url!);
  for (const [urls, q] of [
    [frUrls, FR_SUMMARY_QUERY],
    [enUrls, EN_SUMMARY_QUERY],
  ] as const) {
    if (urls.length === 0) continue;
    try {
      const m = await exaFetchSummaries(apiKey, urls, q, budgetFetch);
      for (const [u, s] of m) summaryByUrl.set(u, s);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[news] Exa contents (summaries) failed:", msg);
      errors.push(`contents: ${msg}`);
    }
  }

  // --- Merge prior-run entity attribution (1 subrequest) ---------------------
  // The upsert below is last-writer-wins on the whole row: without this union a
  // cluster re-fetched by a different search (company vs market topic) would
  // erase the entities written by an earlier run.
  // Read-merge-write is not atomic across CONCURRENT fanouts (scheduled + admin
  // debug overlapping). That race is accepted: runs are minutes apart on 3 fixed
  // cron slots, admin runs are rare and manual, a lost union self-heals on the
  // next run's pre-read, and a DB-side jsonb merge would need a new RPC/trigger
  // migration that this feature deliberately avoids.
  const existingSentimentsByClusterKey = new Map<string, unknown[]>();
  const companiesByKey = new Map<string, SentimentCompanyRef>();
  for (const [companyKey, entry] of workList) {
    const holderTickers = new Set<string>();
    const holderIsins = new Set<string>();
    for (const holder of entry.holders.values()) {
      holder.tickers.forEach((ticker) => holderTickers.add(ticker));
      holder.isins.forEach((isin) => holderIsins.add(isin));
    }
    companiesByKey.set(companyKey, {
      canonicalKey: companyKey,
      name: entry.query,
      tickers: [...holderTickers],
      isins: [...holderIsins],
    });
  }
  if (survivors.length > 0) {
    const { data: existingRows, error: preReadError } = await client
      .from("news_clusters")
      .select("cluster_key,entities,sentiments")
      .in("cluster_key", survivors.map((p) => p.result.id ?? p.result.url!));
    if (preReadError) {
      errors.push(`cluster entities pre-read: ${preReadError.message}`);
      console.error("[news] cluster entities pre-read failed:", preReadError.message);
    }
    const rows = (existingRows as Array<{
      cluster_key: string;
      entities: { isins?: string[]; tickers?: string[]; countries?: string[]; sectors?: string[] } | null;
      sentiments: unknown[] | null;
    }> | null) ?? [];
    for (const row of rows) {
      const pending = pendingClusters.get(row.cluster_key);
      if (Array.isArray(row.sentiments)) {
        existingSentimentsByClusterKey.set(row.cluster_key, row.sentiments);
      }
      if (pending && row.entities) {
        (row.entities.tickers ?? []).forEach((t) => pending.tickers.add(t));
        (row.entities.isins ?? []).forEach((n) => pending.isins.add(n));
        (row.entities.countries ?? []).forEach((c) => pending.countries.add(c));
        (row.entities.sectors ?? []).forEach((s) => pending.sectors.add(s));
      }
    }

  }

  // --- Sentiment scoring: one batched Grok call for every survivor's ---------
  // (cluster, company) pairs (1 subrequest). Never throws — a failure here
  // must not block the feed from populating (see scoreClusterSentiments).
  const sentimentTargets: SentimentTarget[] = survivors.map((p) => {
    const clusterKey = p.result.id ?? p.result.url!;
    const companies: SentimentCompanyRef[] = [...p.companyKeys]
      .map((ck) => {
        // Market-topic keys are not companies and must not receive sentiment.
        const entry = workList.get(ck);
        if (!entry) return null;
        return companiesByKey.get(ck) ?? null;
      })
      .filter((ref): ref is SentimentCompanyRef => ref !== null);
    return {
      clusterKey,
      title: p.result.title ?? "",
      summary: summaryByUrl.get(p.result.url!) ?? "",
      companies,
    };
  });

  const { sentiments: clusterSentiments, error: sentimentError } = await scoreClusterSentiments(
    env,
    sentimentTargets,
    budgetFetch,
  );
  if (sentimentError) errors.push(`sentiment scoring: ${sentimentError}`);

  const sentimentsByClusterKey = new Map<string, ClusterSentiment[]>();
  for (const s of clusterSentiments) {
    const arr = sentimentsByClusterKey.get(s.clusterKey);
    if (arr) arr.push(s);
    else sentimentsByClusterKey.set(s.clusterKey, [s]);
  }
  const expectedCompanyKeysByCluster = new Map<string, string[]>(
    sentimentTargets.map((t) => [t.clusterKey, t.companies.map((company) => company.canonicalKey)]),
  );
  const resolvedSentimentsByClusterKey = new Map<string, ClusterSentiment[] | null>();

  // --- Batch cluster upsert ---------------------------------------------------
  const clusterRows = survivors.map((p) => {
    const clusterKey = p.result.id ?? p.result.url!;
    const resolvedSentiments = resolveSentimentsForRow(
      expectedCompanyKeysByCluster.get(clusterKey) ?? [],
      sentimentsByClusterKey.get(clusterKey) ?? [],
      sentimentError,
    );
    resolvedSentimentsByClusterKey.set(clusterKey, resolvedSentiments);
    return buildClusterRow(
      p.result,
      [...p.tickers],
      [...p.isins],
      summaryByUrl.get(p.result.url!) ?? "",
      resolvedSentiments,
      companiesByKey,
      [...p.countries],
      [...p.sectors],
      existingSentimentsByClusterKey.get(clusterKey) ?? [],
    );
  });
  let clustersUpserted = 0;
  const clusterMap = new Map<string, ClusterAccum>();
  const clusterKeyToId = new Map<string, string>();

  const clusterRowsWithSentiments = clusterRows.filter((row) =>
    Object.prototype.hasOwnProperty.call(row, "sentiments"),
  );
  const clusterRowsWithoutSentiments = clusterRows.filter(
    (row) => !Object.prototype.hasOwnProperty.call(row, "sentiments"),
  );
  for (const rows of [clusterRowsWithSentiments, clusterRowsWithoutSentiments]) {
    if (rows.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: upserted, error: clusterBatchError } = (await (client as any)
      .from("news_clusters")
      .upsert(rows, { onConflict: "cluster_key" })
      .select("id, cluster_key")) as {
      data: Array<{ id: string; cluster_key: string }> | null;
      error: { message: string } | null;
    };

    if (clusterBatchError) {
      errors.push(`batch cluster upsert: ${clusterBatchError.message}`);
      console.error("[news] batch cluster upsert failed:", clusterBatchError.message);
      continue;
    }
    for (const row of upserted ?? []) {
      const pending = pendingClusters.get(row.cluster_key);
      if (pending) {
        clusterMap.set(row.id, {
          publishedAt: pending.result.publishedDate ?? new Date().toISOString(),
          exaScore: pending.exaScore,
          companyKeys: pending.companyKeys,
        });
        clusterKeyToId.set(row.cluster_key, row.id);
      }
    }
  }
  clustersUpserted = clusterMap.size;

  // --- Rolling per-company sentiment (EWMA) -----------------------------------
  // Swap the survivor-scoped clusterKey for the durable DB cluster id so
  // company_sentiment cluster-id lists reference real, queryable rows.
  const idBackedSentiments: ClusterSentiment[] = [...resolvedSentimentsByClusterKey].flatMap(
    ([clusterKey, sentiments]) => {
      const clusterId = clusterKeyToId.get(clusterKey);
      if (!clusterId || !sentiments) return [];
      return sentiments.map((s) => ({ ...s, clusterKey: clusterId }));
    },
  );

  const { companiesRescored, error: companySentimentError } = await updateRollingCompanySentiment(
    client,
    idBackedSentiments,
    companiesByKey,
  );
  if (companySentimentError) errors.push(`company sentiment: ${companySentimentError}`);

  // --- Phase 2: SCORE + MATCH — build matchAccum (pure JS, 0 subrequests) ---
  interface MatchAccum {
    keys: Set<string>;
    tickers: Set<string>;
    etfTickers: Set<string>;
    topicLabels: Set<string>;
  }
  const matchAccum = new Map<string, Map<string, MatchAccum>>();

  const accFor = (portfolioId: string, clusterId: string): MatchAccum => {
    let pMap = matchAccum.get(portfolioId);
    if (!pMap) {
      pMap = new Map();
      matchAccum.set(portfolioId, pMap);
    }
    let acc = pMap.get(clusterId);
    if (!acc) {
      acc = { keys: new Set(), tickers: new Set(), etfTickers: new Set(), topicLabels: new Set() };
      pMap.set(clusterId, acc);
    }
    return acc;
  };

  for (const [clusterId, cluster] of clusterMap) {
    for (const ck of cluster.companyKeys) {
      const companyEntry = workList.get(ck);
      if (companyEntry) {
        for (const [portfolioId, holder] of companyEntry.holders) {
          const acc = accFor(portfolioId, clusterId);
          acc.keys.add(ck);
          holder.tickers.forEach((t) => acc.tickers.add(t));
        }
        continue;
      }
      const marketEntry = marketList.get(ck);
      if (!marketEntry) continue;
      for (const [portfolioId, holder] of marketEntry.holders) {
        const acc = accFor(portfolioId, clusterId);
        acc.keys.add(ck);
        acc.topicLabels.add(marketEntry.topic.label);
        holder.etfTickers.forEach((t) => acc.etfTickers.add(t));
      }
    }
  }

  // --- Batch match upsert (1 subrequest) ------------------------------------
  let matchesUpserted = 0;
  const matchRows: Array<{
    portfolio_id: string;
    cluster_id: string;
    score: number;
    match_reason: object;
  }> = [];

  for (const [portfolioId, pMap] of matchAccum) {
    for (const [clusterId, acc] of pMap) {
      const cluster = clusterMap.get(clusterId);
      if (!cluster) continue;
      const companyNames = [...acc.keys]
        .map((ck) => workList.get(ck)?.query)
        .filter((n): n is string => Boolean(n));

      // Company fields keep their exact V1 shape; ETF/market fields
      // (reserved in migration 20260520195025) only appear on market matches.
      const matchReason: Record<string, unknown> = {};
      if (companyNames.length > 0) {
        matchReason.matched_tickers = [...acc.tickers];
        matchReason.matched_company_names = companyNames;
      }
      if (acc.topicLabels.size > 0) {
        matchReason.matched_etfs = [...acc.etfTickers];
        matchReason.matched_topics = [...acc.topicLabels];
      }

      matchRows.push({
        portfolio_id: portfolioId,
        cluster_id: clusterId,
        score: computeMatchScore(cluster.exaScore, cluster.publishedAt, acc.keys.size),
        match_reason: matchReason,
      });
    }
  }

  if (matchRows.length > 0) {
    const { error: matchBatchError } = await client
      .from("portfolio_news_matches")
      .upsert(matchRows, { onConflict: "portfolio_id,cluster_id" });

    if (matchBatchError) {
      errors.push(`batch match upsert: ${matchBatchError.message}`);
      console.error("[news] batch match upsert failed:", matchBatchError.message);
    } else {
      matchesUpserted = matchRows.length;
    }
  }

  // --- Sweep expired clusters (1 subrequest) --------------------------------
  const { count: expiredSwept, error: sweepError } = await client
    .from("news_clusters")
    .delete({ count: "exact" })
    .lt("expires_at", new Date().toISOString());

  if (sweepError) {
    console.error("[news] expired sweep failed:", sweepError.message);
  }

  const result = {
    distinctCompaniesQueried: companies.length,
    marketTopicsQueried: marketEntries.length,
    clustersUpserted,
    matchesUpserted,
    undatedDropped,
    lowValueDropped,
    offTargetDropped,
    offTopicDropped,
    secondarySearches,
    dedupedAway,
    expiredSwept: expiredSwept ?? 0,
    clustersScored: [...resolvedSentimentsByClusterKey.values()].filter(
      (sentiments) => sentiments !== null && sentiments.length > 0,
    ).length,
    companiesRescored,
    errors,
  };

  console.log("[news] fanout complete:", result);
  return result;
}

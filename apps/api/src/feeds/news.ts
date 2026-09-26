import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  firecrawlSearchNews,
  mapFirecrawlNewsResults,
  type FirecrawlSearchResponse,
  type NewsSearchResult,
} from "./firecrawl";
import { deriveMarketTopics, mentionsTopic, type MarketTopic } from "./market-topics";
import { isFundLike } from "./portfolio-profile";
import {
  aggregateObservationsByCompany,
  computeEwma,
  latestEvidenceClusterIds,
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
  FIRECRAWL_API_KEY?: string;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
// 7-day window: French/European mid-caps have sparse coverage. A short window
// often returns 0 articles; 7 days keeps the feed populated. The expires_at TTL
// uses the same value so we don't surface stale content indefinitely.
const CLUSTER_TTL_HOURS = 168;
const NEWS_WINDOW_MS = CLUSTER_TTL_HOURS * 3_600_000;
const RESULTS_PER_COMPANY = 10;
const RESULTS_PER_MARKET_TOPIC = 15;
// Bounded concurrency for inline-summary Firecrawl searches.
const FETCH_CONCURRENCY = 4;
// Hard cap on ETF-derived market-topic searches per run (subrequest-budget guard).
const MAX_MARKET_TOPICS = 12;
const NEWS_SUBREQUEST_BUDGET = 50;
const MAX_COMPANY_SENTIMENT_ATTEMPTS = 2;
const PENDING_PAGE_SIZE = 200;
const MAX_PENDING_PAGES_PER_RUN = 2;
const PRIOR_COMPANY_CHUNK_SIZE = 125;
const MAX_PRIOR_COMPANY_CHUNKS = 4;
const MAX_POST_SEARCH_SUBREQUESTS = 31;
const MAX_COMPANY_SEARCH_REQUESTS = MAX_RETRIES * 2;
export const MAX_COMPANY_SEARCHES_PER_RUN = Math.max(
  1,
  Math.floor(
    (NEWS_SUBREQUEST_BUDGET - MAX_POST_SEARCH_SUBREQUESTS - MAX_RETRIES) /
      MAX_COMPANY_SEARCH_REQUESTS,
  ),
);
const FANOUT_WINDOW = MAX_COMPANY_SEARCHES_PER_RUN;
export const NEWS_CRON_SLOTS = ["30 6 * * 2-6", "30 16 * * 2-6", "0 21 * * 2-6"] as const;
const WEEK_MS = 7 * 24 * 3_600_000;
const MONDAY_EPOCH_MS = Date.UTC(1970, 0, 5);
const NEWS_RUN_MINUTES_OF_WEEK = NEWS_CRON_SLOTS.flatMap((cron) => {
  const [minuteText, hourText, , , dayRange] = cron.split(" ");
  const [firstDay, lastDay] = dayRange.split("-").map(Number);
  return Array.from({ length: lastDay - firstDay + 1 }, (_, offset) => {
    const mondayBasedDay = (firstDay + offset + 5) % 7;
    return mondayBasedDay * 24 * 60 + Number(hourText) * 60 + Number(minuteText);
  });
}).sort((a, b) => a - b);
// Per-topic keep cap (best provider score first) so broad market queries don't
// drown per-company coverage in the feed.
const MARKET_RESULTS_KEPT = 12;

// Source-quality allowlist: curated premium financial/news outlets. An allowlist
// (not blocklist) decisively cuts the long tail of quote pages / SEO junk.
// Firecrawl covers the premium domains that Exa dropped from its index.
export const NEWS_INCLUDE_DOMAINS = [
  "ft.com",
  "economist.com",
  "wsj.com",
  "bloomberg.com",
  "reuters.com",
  "apnews.com",
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
// Provider rank score is relevance, not authority, so quality ranking is explicit.
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
  private activeReservation: number | null = null;

  constructor(
    private readonly limit: number = NEWS_SUBREQUEST_BUDGET,
    private readonly fetchImpl: NewsFetch = globalThis.fetch,
  ) {}

  reserve(count: number): void {
    if (this.used + this.reserved + count > this.limit) {
      throw new NewsSubrequestBudgetExceededError();
    }
    this.reserved += count;
  }

  activateReservation(count: number): void {
    if (this.reserved < count) throw new NewsSubrequestBudgetExceededError();
    this.reserved -= count;
    this.activeReservation = count;
  }

  availableSearchSubrequests(): number {
    return Math.max(0, this.limit - this.used - this.reserved);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (
      this.used >= this.limit ||
      (this.activeReservation !== null && this.activeReservation <= 0) ||
      (this.activeReservation === null && this.used + this.reserved >= this.limit)
    ) {
      throw new NewsSubrequestBudgetExceededError();
    }
    if (this.activeReservation !== null) this.activeReservation--;
    this.used++;
    return this.fetchImpl(input, init);
  }
}

export function selectRotatingWindow<T>(
  entries: readonly T[],
  limit: number,
  now: number = Date.now(),
): T[] {
  if (entries.length === 0 || limit <= 0) return [];
  if (entries.length <= limit) return [...entries];
  const date = new Date(now);
  const mondayBasedDay = (date.getUTCDay() + 6) % 7;
  const weekStart = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - mondayBasedDay,
  );
  const minuteOfWeek = mondayBasedDay * 24 * 60 + date.getUTCHours() * 60 + date.getUTCMinutes();
  const completedSlots = NEWS_RUN_MINUTES_OF_WEEK.filter((slot) => slot <= minuteOfWeek).length;
  const week = Math.floor((weekStart - MONDAY_EPOCH_MS) / WEEK_MS);
  const runOrdinal = week * NEWS_RUN_MINUTES_OF_WEEK.length + completedSlots - 1;
  const start = (((runOrdinal * limit) % entries.length) + entries.length) % entries.length;
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

// Map exchange suffix → ISO 2-letter country code for news-search location.
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

interface ExistingNewsCluster {
  id: string;
  cluster_key: string;
  article_url: string;
  primary_article: Record<string, unknown>;
  see_also: unknown[];
  entities: {
    isins?: string[];
    tickers?: string[];
    countries?: string[];
    sectors?: string[];
  } | null;
  sentiments: unknown[] | null;
  published_at: string;
  expires_at: string;
}

export function buildClusterRow(
  result: NewsSearchResult,
  tickers: string[],
  isins: string[],
  summary: string,
  sentiments: ClusterSentiment[] | null,
  companiesByKey: Map<string, SentimentCompanyRef>,
  countries: string[] = [],
  sectors: string[] = [],
  priorSentiments: unknown[] = [],
  priorCluster?: ExistingNewsCluster,
) {
  const url = result.url;
  const publishedAt = priorCluster?.published_at ?? result.publishedAt!;
  const newExpiry = new Date(new Date(result.publishedAt!).getTime() + NEWS_WINDOW_MS);
  const priorExpiryMs = Date.parse(priorCluster?.expires_at ?? "");
  const expiresAt = Number.isFinite(priorExpiryMs)
    ? new Date(Math.max(newExpiry.getTime(), priorExpiryMs))
    : newExpiry;
  const priorArticle = priorCluster?.primary_article ?? {};
  const freshSnippet = summary.replace(/^\s*(summary|résumé|resume)\s*:\s*/i, "").trim();
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
    (sentiment): sentiment is Record<string, unknown> => {
      if (!sentiment || typeof sentiment !== "object") return false;
      const companyKey = (sentiment as Record<string, unknown>).company_key;
      return typeof companyKey === "string" && !currentCompanyKeys.has(companyKey);
    },
  );
  return {
    cluster_key: priorCluster?.cluster_key ?? url,
    primary_article: {
      // Preserve provider-specific fields while refreshing usable Firecrawl
      // content. A blank scrape must not erase a stored headline or snippet.
      ...priorArticle,
      title: result.title?.trim() || priorArticle.title || "",
      source: hostname(url),
      published_at: publishedAt,
      snippet: freshSnippet || priorArticle.snippet || "",
      image: result.image || priorArticle.image || null,
      exa_score: result.providerScore ?? priorArticle.exa_score ?? null,
      // The URL remains the exact identity used by the database guard.
      url,
    },
    see_also: priorCluster?.see_also ?? ([] as unknown[]),
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
    published_at: publishedAt,
    fetched_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
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

interface PendingSentimentRow {
  id: number;
  company_key: string;
  cluster_id: string;
  company_name: string;
  ticker: string | null;
  isin: string | null;
  score: number;
  rationale: string;
  published_at: string;
  observed_at: string;
}

export async function updateRollingCompanySentiment(
  client: AnySupabaseClient,
  idBackedSentiments: ClusterSentiment[],
  companiesByKey: Map<string, SentimentCompanyRef>,
): Promise<{ companiesRescored: number; error: string | null }> {
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
        published_at: sentiment.publishedAt ?? new Date().toISOString(),
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
      // Descending identity keyset pages give this attempt a finite snapshot:
      // rows enqueued after the first page have higher IDs and wait for the
      // next fanout. Two bounded pages advance a backlog larger than
      // PostgREST's default 1,000 returned rows over successive fanouts.
      const pendingRows: PendingSentimentRow[] = [];
      let beforeId: number | null = null;
      for (let page = 0; page < MAX_PENDING_PAGES_PER_RUN; page++) {
        let query = client
          .from("company_sentiment_pending")
          .select(
            "id, company_key, cluster_id, company_name, ticker, isin, score, rationale, published_at, observed_at",
          )
          .order("id", { ascending: false })
          .limit(PENDING_PAGE_SIZE);
        if (beforeId !== null) query = query.lt("id", beforeId);
        const { data, error: pendingError } = await query;
        if (pendingError) throw new Error(pendingError.message);
        const pageRows = (data ?? []) as PendingSentimentRow[];
        pendingRows.push(...pageRows);
        if (pageRows.length < PENDING_PAGE_SIZE) break;
        beforeId = pageRows[pageRows.length - 1].id;
      }

      if (
        idBackedSentiments.length === 0 &&
        companiesByKey.size === 0 &&
        pendingRows.length === 0
      ) {
        return { companiesRescored: 0, error: null };
      }

      const readCompanyKeys = [
        ...new Set([...companyKeys, ...pendingRows.map((row) => row.company_key)]),
      ];
      if (readCompanyKeys.length > PRIOR_COMPANY_CHUNK_SIZE * MAX_PRIOR_COMPANY_CHUNKS) {
        throw new Error("company sentiment prior-state scope exceeded the reserved read budget");
      }
      let priorRows: Array<{
        company_key: string;
        company_name?: string | null;
        ticker?: string | null;
        isin?: string | null;
        score: number;
        trend?: "up" | "down" | "flat" | null;
        evidence_cluster_ids: string[] | null;
        scored_cluster_ids: ScoredClusterRecord[] | null;
      }> = [];
      for (let offset = 0; offset < readCompanyKeys.length; offset += PRIOR_COMPANY_CHUNK_SIZE) {
        const keys = readCompanyKeys.slice(offset, offset + PRIOR_COMPANY_CHUNK_SIZE);
        const { data, error: priorError } = await client
          .from("company_sentiment")
          .select(
            "company_key, company_name, ticker, isin, score, trend, evidence_cluster_ids, scored_cluster_ids",
          )
          .in("company_key", keys);

        if (priorError) throw new Error(priorError.message);
        priorRows.push(...(data ?? []));
      }

      const now = Date.now();
      const activePendingRows = pendingRows.filter(
        (row) => now - Date.parse(row.observed_at) <= NEWS_WINDOW_MS,
      );
      const queuedSentiments: ClusterSentiment[] = activePendingRows.map((r) => {
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
          publishedAt: r.published_at,
        };
      });
      const seenObservationKeys = new Set<string>();
      const observations = [...queuedSentiments, ...idBackedSentiments].filter((sentiment) => {
        const key = `${sentiment.companyKey}\u0000${sentiment.clusterKey}`;
        if (seenObservationKeys.has(key)) return false;
        seenObservationKeys.add(key);
        return true;
      });

      const priorByKey = new Map<
        string,
        {
          company_name: string | null;
          ticker: string | null;
          isin: string | null;
          score: number;
          trend: "up" | "down" | "flat";
          evidence_cluster_ids: string[];
          scored_cluster_ids: ScoredClusterRecord[];
        }
      >(
        priorRows.map((r) => [
          r.company_key,
          {
            company_name: r.company_name ?? null,
            ticker: r.ticker ?? null,
            isin: r.isin ?? null,
            score: r.score,
            trend: r.trend ?? "flat",
            evidence_cluster_ids: r.evidence_cluster_ids ?? [],
            scored_cluster_ids: r.scored_cluster_ids ?? [],
          },
        ]),
      );

      const expiredScoredCompanies = new Set<string>();
      const priorScoredByCompany = new Map<string, Set<string>>(
        [...priorByKey].map(([companyKey, prior]) => {
          const validScored = prior.scored_cluster_ids.filter(
            (record) => now - new Date(record.scoredAt).getTime() <= NEWS_WINDOW_MS,
          );
          if (validScored.length !== prior.scored_cluster_ids.length) {
            expiredScoredCompanies.add(companyKey);
            prior.scored_cluster_ids = validScored;
          }
          return [companyKey, new Set(validScored.map((record) => record.id))];
        }),
      );
      const observationsByCompany = aggregateObservationsByCompany(
        observations,
        priorScoredByCompany,
      );
      const publishedAtById = new Map(
        observations
          .filter((sentiment) => sentiment.publishedAt)
          .map((sentiment) => [sentiment.clusterKey, sentiment.publishedAt!] as const),
      );

      const companySentimentRows = [...observationsByCompany].map(([companyKey, obs]) => {
        const prior = priorByKey.get(companyKey) ?? null;
        const { score, trend } = computeEwma(prior?.score ?? null, obs.observedScore);
        const ref = companiesByKey.get(companyKey);
        const scoredClusterIds = mergeScoredClusterIds(
          prior?.scored_cluster_ids ?? [],
          obs.clusterKeys,
          now,
          NEWS_WINDOW_MS,
          publishedAtById,
        );
        return {
          company_key: companyKey,
          company_name: ref?.name ?? companyKey,
          ticker: ref?.tickers[0] ?? null,
          isin: ref?.isins[0] ?? null,
          score,
          trend,
          evidence_cluster_ids: latestEvidenceClusterIds(scoredClusterIds),
          scored_cluster_ids: scoredClusterIds,
          updated_at: new Date(now).toISOString(),
        };
      });

      for (const companyKey of expiredScoredCompanies) {
        if (observationsByCompany.has(companyKey)) continue;
        const prior = priorByKey.get(companyKey);
        if (!prior) continue;
        const ref = companiesByKey.get(companyKey);
        companySentimentRows.push({
          company_key: companyKey,
          company_name: ref?.name ?? prior.company_name ?? companyKey,
          ticker: ref?.tickers[0] ?? prior.ticker,
          isin: ref?.isins[0] ?? prior.isin,
          score: prior.score,
          trend: prior.trend,
          evidence_cluster_ids: latestEvidenceClusterIds(prior.scored_cluster_ids),
          scored_cluster_ids: prior.scored_cluster_ids,
          updated_at: new Date(now).toISOString(),
        });
      }

      const { data: applied, error: applyError } = await client.rpc(
        "apply_company_sentiment_batch",
        {
          p_holder: holder,
          p_rows: companySentimentRows,
        },
      );

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
        const da = new Date(pcA.result.publishedAt ?? 0).getTime();
        const db = new Date(pcB.result.publishedAt ?? 0).getTime();
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
//   N    company Firecrawl searches (one per distinct company, N=4 today)
//   ≤N   secondary company searches (only when premium results are thin)
//   M    market-topic Firecrawl searches (one per distinct ETF-derived topic,
//        M ≤ MAX_MARKET_TOPICS=12, M≈4 today; no secondary tier for topics)
//        summaries arrive inline with search results (no contents calls)
//   1    cluster identity/metadata pre-read (batched .in() on article_url, so
//        Exa-keyed rows keep their UUID and earlier attribution)
//   ≤2   batch cluster upserts (sentiment-bearing and sentiment-preserving rows)
//   1    batch match upsert
//   1    sweep
//   1    Grok sentiment scoring call (skipped if no survivors)
//   ≤16  company sentiment enqueue/lock/read/write/release requests
//   ─────────────────
//   worst case physical fetches stay within the 50-subrequest cap.
// ---------------------------------------------------------------------------

interface PendingCluster {
  result: NewsSearchResult; // mapped result with inline summary
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

export async function runNewsFanout(
  env: Env,
  options: { availableSubrequests?: number; fetch?: NewsFetch; scheduledTime?: number } = {},
): Promise<{
  distinctCompaniesQueried: number;
  marketTopicsQueried: number;
  clustersUpserted: number;
  matchesUpserted: number;
  undatedDropped: number;
  staleDropped: number;
  googleWrappedDropped: number;
  lowValueDropped: number;
  offTargetDropped: number;
  offTopicDropped: number;
  secondarySearches: number;
  dedupedAway: number;
  expiredSwept: number;
  clustersScored: number;
  companiesRescored: number;
  persistenceFailed: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  if (!env.FIRECRAWL_API_KEY) {
    console.warn("[news] FIRECRAWL_API_KEY not set — skipping news fanout");
    throw new Error("FIRECRAWL_API_KEY not configured");
  }

  const apiKey = env.FIRECRAWL_API_KEY;
  const availableSubrequests = Math.max(
    0,
    Math.min(NEWS_SUBREQUEST_BUDGET, options.availableSubrequests ?? NEWS_SUBREQUEST_BUDGET),
  );
  const budget = new NewsSubrequestBudget(availableSubrequests, options.fetch);
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
  const rotationNow = options.scheduledTime ?? Date.now();
  const marketCandidates = [...marketList.values()].sort((a, b) =>
    a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
  );
  let marketEntries: MarketEntry[] = [];

  const allCompanies = [...workList.values()].sort((a, b) =>
    a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
  );
  const userLocation = deriveUserLocation(workList);
  budget.reserve(MAX_POST_SEARCH_SUBREQUESTS);
  const marketSearchReservation = marketCandidates.length > 0 ? MAX_RETRIES : 0;
  if (marketSearchReservation > 0) budget.reserve(marketSearchReservation);
  const companySearchLimit = Math.min(
    FANOUT_WINDOW,
    Math.floor(budget.availableSearchSubrequests() / MAX_COMPANY_SEARCH_REQUESTS),
  );
  const companies = selectRotatingWindow(allCompanies, companySearchLimit, rotationNow);

  // --- Phase 1: FETCH — collect results, no DB writes (N..2N+M subrequests) --
  const pendingClusters = new Map<string, PendingCluster>();
  let undatedDropped = 0;
  let staleDropped = 0;
  let googleWrappedDropped = 0;
  let lowValueDropped = 0;
  let offTargetDropped = 0;
  let offTopicDropped = 0;
  let secondarySearches = 0;

  // Explicit ≤7-day window: Firecrawl's tbs:"qdr:w" leaks ~12% older results
  // (some years old), so this filter — not the undated-drop — is the
  // load-bearing recency guard now.
  const isStale = (publishedAt: string): boolean => {
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    return ageMs < 0 || ageMs > NEWS_WINDOW_MS;
  };

  // Filter a result list for one company and add survivors to pendingClusters.
  // Returns the count of on-target (company-mentioning) results kept.
  const ingest = (
    results: NewsSearchResult[],
    company: CompanyEntry,
    tickerArr: string[],
    isinArr: string[],
  ): number => {
    let kept = 0;
    for (const result of results) {
      if (!result.publishedAt) {
        undatedDropped++;
        continue;
      }
      if (isStale(result.publishedAt)) {
        staleDropped++;
        continue;
      }
      if (isLowValuePage(result.title, result.url)) {
        lowValueDropped++;
        continue;
      }
      // Drift filter on title + inline summary (summaries reliably carry the
      // full official company name even when a paywalled title doesn't).
      if (!mentionsCompany(`${result.title}\n${result.summary}`, [company.query])) {
        offTargetDropped++;
        continue;
      }

      kept++;
      const clusterKey = result.url;
      const existing = pendingClusters.get(clusterKey);
      if (existing) {
        existing.exaScore = Math.max(existing.exaScore, result.providerScore);
        existing.companyKeys.add(company.canonicalKey);
        tickerArr.forEach((t) => existing.tickers.add(t));
        isinArr.forEach((i) => existing.isins.add(i));
      } else {
        pendingClusters.set(clusterKey, {
          result,
          exaScore: result.providerScore,
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
  // company-name filter, plus a per-topic keep cap (best provider score first).
  const ingestMarket = (results: NewsSearchResult[], entry: MarketEntry): void => {
    const survivors: NewsSearchResult[] = [];
    for (const result of results) {
      if (!result.publishedAt) {
        undatedDropped++;
        continue;
      }
      if (isStale(result.publishedAt)) {
        staleDropped++;
        continue;
      }
      if (isLowValuePage(result.title, result.url)) {
        lowValueDropped++;
        continue;
      }
      if (!mentionsTopic(`${result.title}\n${result.summary}`, entry.topic)) {
        offTopicDropped++;
        continue;
      }
      survivors.push(result);
    }

    survivors.sort((a, b) => b.providerScore - a.providerScore);
    for (const result of survivors.slice(0, MARKET_RESULTS_KEPT)) {
      const clusterKey = result.url;
      const existing = pendingClusters.get(clusterKey);
      if (existing) {
        existing.exaScore = Math.max(existing.exaScore, result.providerScore);
        existing.companyKeys.add(entry.canonicalKey);
        entry.topic.countries.forEach((c) => existing.countries.add(c));
        entry.topic.sectors.forEach((sec) => existing.sectors.add(sec));
      } else {
        pendingClusters.set(clusterKey, {
          result,
          exaScore: result.providerScore,
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

    // Extract mapped results, tallying the shared drop counters. Firecrawl
    // errors surface either as thrown non-2xx statuses or as an in-body
    // success:false/error — normalize both to null + errors[] entry.
    const mapped = (
      response: FirecrawlSearchResponse,
      label: string,
    ): NewsSearchResult[] | null => {
      if (response.success === false || response.error) {
        console.error(
          `[news] Firecrawl API error for "${label}":`,
          response.error ?? "success=false",
        );
        return null;
      }
      const { results, googleWrappedDropped: dropped } = mapFirecrawlNewsResults(
        response.data?.news ?? [],
        Date.now(),
      );
      googleWrappedDropped += dropped;
      return results;
    };

    // Primary search — premium allowlist.
    let primaryResults: NewsSearchResult[] | null;
    try {
      const primary = await firecrawlSearchNews(
        apiKey,
        {
          query: newsQuery,
          limit: RESULTS_PER_COMPANY,
          location: userLocation,
          includeDomains: NEWS_INCLUDE_DOMAINS,
        },
        budgetFetch,
      );
      primaryResults = mapped(primary, company.query);
      if (!primaryResults) {
        errors.push(`${company.canonicalKey}: Firecrawl error ${primary.error ?? "success=false"}`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[news] Firecrawl primary failed for "${company.query}":`, msg);
      errors.push(`${company.canonicalKey}: ${msg}`);
      return;
    }
    const onTarget = ingest(primaryResults, company, tickerArr, isinArr);

    // Tiered fallback — too few on-target premium results → broaden once.
    if (onTarget < MIN_ONTARGET) {
      secondarySearches++;
      try {
        const secondary = await firecrawlSearchNews(
          apiKey,
          {
            query: newsQuery,
            limit: RESULTS_PER_COMPANY,
            location: userLocation,
            includeDomains: NEWS_INCLUDE_DOMAINS_SECONDARY,
          },
          budgetFetch,
        );
        const secondaryResults = mapped(secondary, `${company.query} (secondary)`);
        if (secondaryResults) ingest(secondaryResults, company, tickerArr, isinArr);
        else
          errors.push(
            `${company.canonicalKey} (secondary): Firecrawl error ${secondary.error ?? "success=false"}`,
          );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[news] Firecrawl secondary failed for "${company.query}":`, msg);
        errors.push(`${company.canonicalKey} (secondary): ${msg}`);
      }
    }
  });

  const marketSearchLimit = Math.min(
    MAX_MARKET_TOPICS,
    Math.floor((budget.availableSearchSubrequests() + marketSearchReservation) / MAX_RETRIES),
  );
  marketEntries = selectRotatingWindow(marketCandidates, marketSearchLimit, rotationNow);
  // Drop capped-away entries so later match/dedup phases can't reference them.
  marketList = new Map(marketEntries.map((e) => [e.canonicalKey, e]));

  const marketSearchSlots = marketEntries.length * MAX_RETRIES;
  if (marketSearchSlots > marketSearchReservation) {
    budget.reserve(marketSearchSlots - marketSearchReservation);
  }
  if (marketSearchSlots > 0) budget.activateReservation(marketSearchSlots);

  // Market-topic searches (M subrequests) — premium allowlist only. Macro/market
  // coverage is dense there, so no secondary tier: keeps the budget deterministic.
  await runWithConcurrency(marketEntries, FETCH_CONCURRENCY, async (entry) => {
    try {
      const response = await firecrawlSearchNews(
        apiKey,
        {
          query: entry.topic.query,
          limit: RESULTS_PER_MARKET_TOPIC,
          location: userLocation,
          includeDomains: NEWS_INCLUDE_DOMAINS,
        },
        budgetFetch,
      );
      if (response.success === false || response.error) {
        console.error(
          `[news] Firecrawl API error for topic "${entry.topic.topicKey}":`,
          response.error ?? "success=false",
        );
        errors.push(`${entry.canonicalKey}: Firecrawl error ${response.error ?? "success=false"}`);
        return;
      }
      const { results, googleWrappedDropped: dropped } = mapFirecrawlNewsResults(
        response.data?.news ?? [],
        Date.now(),
      );
      googleWrappedDropped += dropped;
      ingestMarket(results, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[news] Firecrawl market search failed for "${entry.topic.topicKey}":`, msg);
      errors.push(`${entry.canonicalKey}: ${msg}`);
    }
  });

  budget.activateReservation(MAX_POST_SEARCH_SUBREQUESTS);
  // Collapse same-story duplicates across sources (keep best source tier).
  const queryByKey = new Map<string, string>();
  for (const [key, entry] of workList) queryByKey.set(key, entry.query);
  for (const [key, entry] of marketList) queryByKey.set(key, entry.topic.label);
  const dedupedAway = dedupeByStory(pendingClusters, queryByKey);

  // Summaries arrived inline with each search result (scrapeOptions summary
  // format) — no separate contents/scrape phase. Results whose scrape failed
  // keep an empty snippet, exactly as before.
  const survivors = [...pendingClusters.values()];

  // --- Reuse the existing exact-URL identity and attribution (1 subrequest) --
  // The upsert below is last-writer-wins on the whole row: without this union a
  // cluster re-fetched by a different search (company vs market topic) would
  // erase the entities written by an earlier run.
  // The generated article_url and its unique index (migration
  // 20260820120000) protect exact URL identity across concurrent fanouts.
  // A writer that loses the race returns persistenceFailed so the queued fanout
  // retries against the winning row; the manual debug path reports the error.
  const existingClustersByUrl = new Map<string, ExistingNewsCluster>();
  const existingSentimentsByClusterKey = new Map<string, unknown[]>();
  let identityPreReadFailed = false;
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
      .select(
        "id,cluster_key,article_url,primary_article,see_also,entities,sentiments,published_at,expires_at",
      )
      .in(
        "article_url",
        survivors.map((p) => p.result.url),
      );
    if (preReadError || !Array.isArray(existingRows)) {
      identityPreReadFailed = true;
      const message = preReadError?.message ?? "identity lookup returned no rows payload";
      errors.push(`cluster URL identity pre-read: ${message}`);
      console.error("[news] cluster URL identity pre-read failed:", message);
    }
    const rows = (existingRows as ExistingNewsCluster[] | null) ?? [];
    for (const row of rows) {
      const pending = pendingClusters.get(row.article_url);
      existingClustersByUrl.set(row.article_url, row);
      if (Array.isArray(row.sentiments)) {
        existingSentimentsByClusterKey.set(row.article_url, row.sentiments);
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
    const clusterKey = p.result.url;
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
      summary: p.result.summary,
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
  // A failed identity lookup must never fall through to URL-key insertion:
  // that would fork a legacy Exa-keyed article into a second cluster.
  const clusterRows = (identityPreReadFailed ? [] : survivors).map((p) => {
    const clusterKey = p.result.url;
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
      p.result.summary,
      resolvedSentiments,
      companiesByKey,
      [...p.countries],
      [...p.sectors],
      existingSentimentsByClusterKey.get(clusterKey) ?? [],
      existingClustersByUrl.get(clusterKey),
    );
  });
  let clustersUpserted = 0;
  let persistenceFailed = identityPreReadFailed;
  const clusterMap = new Map<string, ClusterAccum>();
  const clusterKeyToId = new Map<string, string>();
  const urlByClusterKey = new Map(
    clusterRows.map((row, index) => [row.cluster_key, survivors[index].result.url]),
  );

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
      persistenceFailed = true;
      errors.push(`batch cluster upsert: ${clusterBatchError.message}`);
      console.error("[news] batch cluster upsert failed:", clusterBatchError.message);
      continue;
    }
    for (const row of upserted ?? []) {
      const url = urlByClusterKey.get(row.cluster_key);
      const pending = url ? pendingClusters.get(url) : undefined;
      if (url && pending) {
        clusterMap.set(row.id, {
          publishedAt: pending.result.publishedAt ?? new Date().toISOString(),
          exaScore: pending.exaScore,
          companyKeys: pending.companyKeys,
        });
        clusterKeyToId.set(url, row.id);
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
      const publishedAt = pendingClusters.get(clusterKey)?.result.publishedAt;
      return sentiments.map((s) => ({
        ...s,
        clusterKey: clusterId,
        publishedAt: publishedAt ?? undefined,
      }));
    },
  );

  const sentimentCompaniesByKey = new Map<string, SentimentCompanyRef>();
  for (const sentiment of idBackedSentiments) {
    const ref = companiesByKey.get(sentiment.companyKey);
    if (ref) sentimentCompaniesByKey.set(sentiment.companyKey, ref);
  }
  const { companiesRescored, error: companySentimentError } = await updateRollingCompanySentiment(
    client,
    idBackedSentiments,
    sentimentCompaniesByKey,
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
      persistenceFailed = true;
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

  if (
    (allCompanies.length > 0 || marketCandidates.length > 0) &&
    companies.length === 0 &&
    marketEntries.length === 0
  ) {
    errors.push("news fanout produced no search coverage");
  }

  const result = {
    distinctCompaniesQueried: companies.length,
    marketTopicsQueried: marketEntries.length,
    clustersUpserted,
    matchesUpserted,
    undatedDropped,
    staleDropped,
    googleWrappedDropped,
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
    persistenceFailed,
    errors,
  };

  console.log("[news] fanout complete:", result);
  return result;
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  firecrawlSearchNews,
  mapFirecrawlNewsResults,
  type FirecrawlSearchResponse,
  type NewsSearchResult,
} from "./firecrawl";
import { deriveMarketTopics, mentionsTopic, type MarketTopic } from "./market-topics";
import { isFundLike } from "./portfolio-profile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  FIRECRAWL_API_KEY?: string;
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

// 7-day window: French/European mid-caps have sparse coverage. A short window
// often returns 0 articles; 7 days keeps the feed populated. The expires_at TTL
// uses the same value so we don't surface stale content indefinitely.
const CLUSTER_TTL_HOURS = 168;
const NEWS_WINDOW_MS = CLUSTER_TTL_HOURS * 3_600_000;
// Per-query result limits. Company queries: every on-target result in the
// 1A-114 spike sat at rank ≤ 7, so 10 loses nothing and cuts scrape credits
// ~60% vs 25. Market queries are relevant throughout, so 15 balances coverage
// against credit spend (~110 credits per full run at this mix).
const RESULTS_PER_COMPANY = 10;
const RESULTS_PER_MARKET_TOPIC = 15;
// Bounded concurrency for the Firecrawl fetch phase (inline-summary searches
// run 12-38s each; concurrency keeps the fanout inside cron wall-clock).
const FETCH_CONCURRENCY = 4;
// Distinct-company window per run (rotating-cursor insurance for growth).
// At current scale (~4 distinct companies) this covers everything every run.
const FANOUT_WINDOW = 200;
// Hard cap on ETF-derived market-topic searches per run (subrequest-budget guard).
const MAX_MARKET_TOPICS = 12;
// Per-topic keep cap (best provider score first) so broad market queries don't
// drown per-company coverage in the feed.
const MARKET_RESULTS_KEPT = 12;

// Source-quality allowlist: curated premium financial/news outlets. An allowlist
// (not blocklist) decisively cuts the long tail of quote pages / SEO junk.
// wsj/bloomberg/reuters/apnews were once removed because Exa dropped them from
// its index (whole-request 403s); Firecrawl covers all four with live, dated
// results and real through-paywall summaries (1A-114 spike), so they are back.
// A domain with zero Firecrawl coverage just returns an empty list (no failure
// mode, no credits billed).
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
// The provider score is relevance (rank), NOT authority, so quality ranking
// must be explicit.
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

// Map exchange suffix → ISO 2-letter country code for the Firecrawl search location
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
// Cluster row builder — pure, no DB call (batch upsert happens after Phase 1)
// Dropping the per-row pre-SELECT + GREATEST(expires_at) logic keeps subrequests
// within the free-plan cap. expires_at = published_at + TTL is deterministic for
// a given article (published_at is fixed), so re-fetching computes the same value.
// ---------------------------------------------------------------------------

function buildClusterRow(
  pending: PendingCluster,
  tickers: string[],
  isins: string[],
  countries: string[] = [],
  sectors: string[] = [],
) {
  const result = pending.result;
  const url = result.url;
  return {
    cluster_key: url,
    primary_article: {
      title: result.title,
      url,
      source: hostname(url),
      published_at: result.publishedAt!,
      // Strip an occasional leading "Summary:"/"Résumé:" label.
      snippet: result.summary.replace(/^\s*(summary|résumé|resume)\s*:\s*/i, "").trim(),
      image: result.image,
      provider_score: pending.providerScore,
    },
    see_also: [] as unknown[],
    entities: { isins, tickers, countries, sectors },
    published_at: result.publishedAt!,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(new Date(result.publishedAt!).getTime() + NEWS_WINDOW_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Score: providerScore × recencyDecay × holdingsBooster (hybrid; each signal once)
// ---------------------------------------------------------------------------

function computeMatchScore(
  providerScore: number,
  publishedAt: string,
  holdingsHit: number,
): number {
  // Missing score → 0.5: the result came from this company's query, so a format
  // quirk shouldn't zero it out.
  const relevance = Math.min(1, Math.max(0, Number.isFinite(providerScore) ? providerScore : 0.5));
  const booster = Math.min(1.3, 1 + (Math.max(1, holdingsHit) - 1) * 0.15);
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  const recency = Math.max(0.1, 1 - (ageHours / CLUSTER_TTL_HOURS) * 0.9);
  return Math.round(relevance * recency * booster * 10000) / 10000;
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
// tier (tiebreak providerScore, then recency); merges companyKeys and entity sets so
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
      const tierA = sourceTier(hostname(pcA.result.url));
      const tierB = sourceTier(hostname(pcB.result.url));
      let dropKey: string;
      if (tierA !== tierB) dropKey = tierA < tierB ? keyB : keyA;
      else if (pcA.providerScore !== pcB.providerScore)
        dropKey = pcA.providerScore >= pcB.providerScore ? keyB : keyA;
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
//   N    company Firecrawl searches (one per distinct company, N=4 today;
//        summaries ride inline on the search call — 0 extra subrequests)
//   ≤N   secondary company searches (only when premium results are thin)
//   M    market-topic Firecrawl searches (one per distinct ETF-derived topic,
//        M ≤ MAX_MARKET_TOPICS=12, M≈4 today; no secondary tier for topics)
//   1    cluster entities pre-read (batched .in() on cluster_key, so a
//        re-upsert never erases entity attribution from a previous run)
//   1    batch cluster upsert (all at once)
//   1    batch match upsert
//   1    sweep
//   ─────────────────
//   worst case 2N+M+7 (= 19 today with N=4, M=4; ≤ 2N+19 at the topic cap),
//   typical N+M+7 ≈ 15 — well under 50 at current scale.
// ---------------------------------------------------------------------------

interface PendingCluster {
  result: NewsSearchResult; // mapped search result — summary already inline
  providerScore: number;
  companyKeys: Set<string>; // company canonical keys AND `topic:*` market keys
  tickers: Set<string>;
  isins: Set<string>;
  countries: Set<string>; // from market topics; empty for company-only clusters
  sectors: Set<string>;
}

interface ClusterAccum {
  publishedAt: string;
  providerScore: number;
  companyKeys: Set<string>;
}

export async function runNewsFanout(env: Env): Promise<{
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
  errors: string[];
}> {
  const errors: string[] = [];

  if (!env.FIRECRAWL_API_KEY) {
    console.warn("[news] FIRECRAWL_API_KEY not set — skipping news fanout");
    return {
      distinctCompaniesQueried: 0,
      marketTopicsQueried: 0,
      clustersUpserted: 0,
      matchesUpserted: 0,
      undatedDropped: 0,
      staleDropped: 0,
      googleWrappedDropped: 0,
      lowValueDropped: 0,
      offTargetDropped: 0,
      offTopicDropped: 0,
      secondarySearches: 0,
      dedupedAway: 0,
      expiredSwept: 0,
      errors: ["FIRECRAWL_API_KEY not configured"],
    };
  }

  const apiKey = env.FIRECRAWL_API_KEY;
  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

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
  const marketEntries = [...marketList.values()]
    .sort((a, b) =>
      a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
    )
    .slice(0, MAX_MARKET_TOPICS);
  // Drop capped-away entries so later match/dedup phases can't reference them.
  marketList = new Map(marketEntries.map((e) => [e.canonicalKey, e]));

  const allCompanies = [...workList.values()].sort((a, b) =>
    a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
  );
  const cursor = 0;
  const companies = allCompanies.slice(cursor, cursor + FANOUT_WINDOW);

  const userLocation = deriveUserLocation(workList);

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
        existing.providerScore = Math.max(existing.providerScore, result.providerScore);
        existing.companyKeys.add(company.canonicalKey);
        tickerArr.forEach((t) => existing.tickers.add(t));
        isinArr.forEach((i) => existing.isins.add(i));
      } else {
        pendingClusters.set(clusterKey, {
          result,
          providerScore: result.providerScore,
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
        existing.providerScore = Math.max(existing.providerScore, result.providerScore);
        existing.companyKeys.add(entry.canonicalKey);
        entry.topic.countries.forEach((c) => existing.countries.add(c));
        entry.topic.sectors.forEach((sec) => existing.sectors.add(sec));
      } else {
        pendingClusters.set(clusterKey, {
          result,
          providerScore: result.providerScore,
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
      const primary = await firecrawlSearchNews(apiKey, {
        query: newsQuery,
        limit: RESULTS_PER_COMPANY,
        location: userLocation,
        includeDomains: NEWS_INCLUDE_DOMAINS,
      });
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
        const secondary = await firecrawlSearchNews(apiKey, {
          query: newsQuery,
          limit: RESULTS_PER_COMPANY,
          location: userLocation,
          includeDomains: NEWS_INCLUDE_DOMAINS_SECONDARY,
        });
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

  // Market-topic searches (M subrequests) — premium allowlist only. Macro/market
  // coverage is dense there, so no secondary tier: keeps the budget deterministic.
  await runWithConcurrency(marketEntries, FETCH_CONCURRENCY, async (entry) => {
    try {
      const response = await firecrawlSearchNews(apiKey, {
        query: entry.topic.query,
        limit: RESULTS_PER_MARKET_TOPIC,
        location: userLocation,
        includeDomains: NEWS_INCLUDE_DOMAINS,
      });
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

  // Collapse same-story duplicates across sources (keep best source tier).
  const queryByKey = new Map<string, string>();
  for (const [key, entry] of workList) queryByKey.set(key, entry.query);
  for (const [key, entry] of marketList) queryByKey.set(key, entry.topic.label);
  const dedupedAway = dedupeByStory(pendingClusters, queryByKey);

  // Summaries arrived inline with each search result (scrapeOptions summary
  // format) — no separate contents/scrape phase. Results whose scrape failed
  // keep an empty snippet, exactly as before.
  const survivors = [...pendingClusters.values()];

  // --- Merge prior-run entity attribution (1 subrequest) ---------------------
  // The upsert below is last-writer-wins on the whole row: without this union a
  // cluster re-fetched by a different search (company vs market topic) would
  // erase the entities written by an earlier run.
  // Read-merge-write is not atomic across CONCURRENT fanouts (scheduled + admin
  // debug overlapping). That race is accepted: runs are minutes apart on 3 fixed
  // cron slots, admin runs are rare and manual, a lost union self-heals on the
  // next run's pre-read, and a DB-side jsonb merge would need a new RPC/trigger
  // migration that this feature deliberately avoids.
  if (survivors.length > 0) {
    const { data: existingRows, error: preReadError } = await client
      .from("news_clusters")
      .select("cluster_key,entities")
      .in(
        "cluster_key",
        survivors.map((p) => p.result.url),
      );
    if (preReadError) {
      errors.push(`cluster entities pre-read: ${preReadError.message}`);
      console.error("[news] cluster entities pre-read failed:", preReadError.message);
    }
    const rows =
      (existingRows as Array<{
        cluster_key: string;
        entities: {
          isins?: string[];
          tickers?: string[];
          countries?: string[];
          sectors?: string[];
        } | null;
      }> | null) ?? [];
    for (const row of rows) {
      const pending = pendingClusters.get(row.cluster_key);
      if (!pending || !row.entities) continue;
      (row.entities.tickers ?? []).forEach((t) => pending.tickers.add(t));
      (row.entities.isins ?? []).forEach((n) => pending.isins.add(n));
      (row.entities.countries ?? []).forEach((c) => pending.countries.add(c));
      (row.entities.sectors ?? []).forEach((s) => pending.sectors.add(s));
    }
  }

  // --- Batch cluster upsert (1 subrequest) -----------------------------------
  const clusterRows = survivors.map((p) =>
    buildClusterRow(p, [...p.tickers], [...p.isins], [...p.countries], [...p.sectors]),
  );
  let clustersUpserted = 0;
  const clusterMap = new Map<string, ClusterAccum>();

  if (clusterRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: upserted, error: clusterBatchError } = (await (client as any)
      .from("news_clusters")
      .upsert(clusterRows, { onConflict: "cluster_key" })
      .select("id, cluster_key")) as {
      data: Array<{ id: string; cluster_key: string }> | null;
      error: { message: string } | null;
    };

    if (clusterBatchError) {
      errors.push(`batch cluster upsert: ${clusterBatchError.message}`);
      console.error("[news] batch cluster upsert failed:", clusterBatchError.message);
    } else {
      for (const row of upserted ?? []) {
        const pending = pendingClusters.get(row.cluster_key);
        if (pending) {
          clusterMap.set(row.id, {
            publishedAt: pending.result.publishedAt ?? new Date().toISOString(),
            providerScore: pending.providerScore,
            companyKeys: pending.companyKeys,
          });
        }
      }
      clustersUpserted = clusterMap.size;
    }
  }

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
        score: computeMatchScore(cluster.providerScore, cluster.publishedAt, acc.keys.size),
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
    staleDropped,
    googleWrappedDropped,
    lowValueDropped,
    offTargetDropped,
    offTopicDropped,
    secondarySearches,
    dedupedAway,
    expiredSwept: expiredSwept ?? 0,
    errors,
  };

  console.log("[news] fanout complete:", result);
  return result;
}

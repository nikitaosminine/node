import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateObservationsByCompany,
  computeEwma,
  mergeEvidenceClusterIds,
  mergeScoredClusterIds,
  scoreClusterSentiments,
  type ClusterSentiment,
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
// Distinct-company window per run (rotating-cursor insurance for growth).
// At current scale (~4 distinct companies) this covers everything every run.
const FANOUT_WINDOW = 200;

// Source-quality allowlist: curated premium financial/news outlets. An allowlist
// (not blocklist) decisively cuts the long tail of quote pages / SEO junk.
// NOTE: Exa returns HTTP 403 ("domains not available") for the WHOLE request if
// includeDomains names a domain it no longer indexes — and these were dropped
// from Exa's index (publisher opt-outs / removed crawl): wsj.com, bloomberg.com,
// reuters.com, apnews.com, breakingviews.reuters.com. They are removed below so
// the allowlist works; only add a domain back after confirming Exa still indexes
// it (a single search with includeDomains:[domain] 403s if it doesn't).
export const NEWS_INCLUDE_DOMAINS = [
  "ft.com", "economist.com",
  "barrons.com", "marketwatch.com", "cnbc.com", "seekingalpha.com",
  "morningstar.com", "imf.org", "worldbank.org", "bis.org", "ecb.europa.eu",
  "banque-france.fr", "sec.gov", "amf-france.org", "oecd.org", "alphaville.ft.com",
  "institutionalinvestor.com", "pensions-investments.com",
  "zerohedge.com", "calculatedriskblog.com", "lesechos.fr", "latribune.fr",
  "boursier.com", "boursorama.com", "challenges.fr", "euronews.com",
];

// Secondary (broader / small-cap-friendly) allowlist — only searched when the
// premium list yields too few on-target results for a company. Tune as needed.
export const NEWS_INCLUDE_DOMAINS_SECONDARY = [
  "investir.lesechos.fr", "capital.fr", "usinenouvelle.com", "agefi.fr",
  "tradingsat.com", "bfmtv.com",
];

// Trigger a secondary search when fewer than this many on-target results come
// back from the premium list (big caps often return mostly sector-noise, so the
// company-specific count is low even for well-covered names).
const MIN_ONTARGET = 4;

// Source-quality priority for cross-story dedup (lower = better, kept on merge).
// Exa's score is relevance, NOT authority, so quality ranking must be explicit.
const SOURCE_TIER: Record<string, number> = {
  "reuters.com": 1, "bloomberg.com": 1, "ft.com": 1, "wsj.com": 1, "economist.com": 1, "apnews.com": 1,
  // Top French sources — human-written, high quality for this portfolio.
  "lesechos.fr": 1, "boursier.com": 1, "boursorama.com": 1,
  "barrons.com": 2, "cnbc.com": 2, "marketwatch.com": 2, "latribune.fr": 2,
  "sec.gov": 2, "ecb.europa.eu": 2, "imf.org": 2, "amf-france.org": 2,
  "seekingalpha.com": 3, "morningstar.com": 3, "challenges.fr": 3, "euronews.com": 3,
};
function sourceTier(source: string): number {
  return SOURCE_TIER[source.replace(/^www\./i, "")] ?? 99;
}

// French-language sources → drive the language of the generated summary.
const FRENCH_DOMAINS = new Set([
  "lesechos.fr", "investir.lesechos.fr", "boursier.com", "boursorama.com", "latribune.fr",
  "challenges.fr", "capital.fr", "usinenouvelle.com", "agefi.fr", "tradingsat.com",
  "bfmtv.com", "banque-france.fr", "amf-france.org",
]);
function isFrenchSource(source: string): boolean {
  const s = source.replace(/^www\./i, "");
  return FRENCH_DOMAINS.has(s) || s.endsWith(".fr");
}

// English stopwords + filler — dropped from title signatures so dedup compares
// the distinctive tokens of a story.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "as", "at", "by",
  "from", "with", "is", "are", "be", "its", "it", "that", "this", "se", "sa",
  "inc", "ltd", "plc", "corp", "co", "group", "news", "update", "latest",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Is an asset fund-like (ETF/mutual fund)? Mirrors geography.ts without a cross-import.
function isFundLike(assetType: string | null | undefined, name = ""): boolean {
  const value = `${assetType ?? ""} ${name}`.toLowerCase();
  return /\betf\b|exchange traded fund|mutual\s*fund|\bfund\b|\bucits\b/.test(value);
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
  PA: "FR", DE: "DE", AS: "NL", MI: "IT", L: "GB", SW: "CH",
  MC: "ES", BE: "BE", VI: "AT", CO: "DK", HE: "FI", ST: "SE", OL: "NO",
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
const LOW_VALUE_TITLE = /stock quote|share price|markets data|stock price|\bADR\b.*\bquote\b|cours de bourse|quote \(|price target|^subscribe to (read|continue)|^log ?in|^sign ?in/i;
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
): Promise<Map<string, CompanyEntry>> {
  const { data, error } = await client
    .from("holdings")
    .select("ticker,isin,asset_type,name,quantity,portfolio_id")
    .gt("quantity", 0);

  if (error) {
    throw new Error(`[news] failed to fetch holdings: ${error.message}`);
  }

  const holdings = (data as HoldingRow[] | null) ?? [];
  const workList = new Map<string, CompanyEntry>();

  for (const h of holdings) {
    if (isFundLike(h.asset_type, h.name)) continue;
    if (!h.name && !h.ticker && !h.isin) continue;

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

  return workList;
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
  attempt = 1,
): Promise<ExaSearchResponse> {
  let res: Response;
  try {
    res = await fetch(`${EXA_BASE}/search`, {
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
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaSearchNews(apiKey, query, startPublishedDate, userLocation, includeDomains, attempt + 1);
  }

  // Retry only transient failures. 400/401/422 are deterministic — fail fast.
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Exa ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaSearchNews(apiKey, query, startPublishedDate, userLocation, includeDomains, attempt + 1);
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
  attempt = 1,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;

  let res: Response;
  try {
    res = await fetch(`${EXA_BASE}/contents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      // Prefer Exa's cached/indexed content (what search-summary used) over a fresh
      // livecrawl, which hits paywalls (Bloomberg/FT/MarketWatch) and returns no text.
      body: JSON.stringify({ urls, summary: { query: summaryQuery }, maxAgeHours: 720 }),
    });
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaFetchSummaries(apiKey, urls, summaryQuery, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      const body = await res.text().catch(() => "");
      throw new Error(`Exa contents ${res.status} after ${MAX_RETRIES} attempts: ${body}`);
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    return exaFetchSummaries(apiKey, urls, summaryQuery, attempt + 1);
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
) {
  const url = result.url!;
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
    entities: { isins, tickers, countries: [] as string[], sectors: [] as string[] },
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
          sentiments: sentiments.map((s) => {
            const ref = companiesByKey.get(s.companyKey);
            return {
              company_key: s.companyKey,
              company_name: ref?.name ?? null,
              tickers: ref?.tickers ?? [],
              isins: ref?.isins ?? [],
              score: s.score,
              rationale: s.rationale,
            };
          }),
        }),
    published_at: result.publishedDate!,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(new Date(result.publishedDate!).getTime() + NEWS_WINDOW_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Rolling per-company sentiment (EWMA) — up to 2 subrequests, 0 when there is
// nothing to update. A cluster already present in the company's stored
// scored_cluster_ids is the same article re-surfacing across fanout runs
// within the 7-day window and must not move the EWMA again; scored_cluster_ids
// (cap 200) is the dedupe source of truth, while evidence_cluster_ids stays a
// 10-id display list. Companies with nothing new this run are skipped and
// their rows left untouched. Never throws.
// ---------------------------------------------------------------------------

export async function updateRollingCompanySentiment(
  client: AnySupabaseClient,
  idBackedSentiments: ClusterSentiment[],
  companiesByKey: Map<string, SentimentCompanyRef>,
): Promise<{ companiesRescored: number; error: string | null }> {
  if (idBackedSentiments.length === 0) return { companiesRescored: 0, error: null };
  const companyKeys = [...new Set(idBackedSentiments.map((s) => s.companyKey))];

  try {
    const { data: priorRows, error: priorError } = await client
      .from("company_sentiment")
      .select("company_key, score, evidence_cluster_ids, scored_cluster_ids")
      .in("company_key", companyKeys);

    if (priorError) throw new Error(priorError.message);

    const priorByKey = new Map<
      string,
      { score: number; evidence_cluster_ids: string[]; scored_cluster_ids: string[] }
    >(
      (priorRows ?? []).map(
        (r: {
          company_key: string;
          score: number;
          evidence_cluster_ids: string[] | null;
          scored_cluster_ids: string[] | null;
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
      [...priorByKey].map(([companyKey, prior]) => [companyKey, new Set(prior.scored_cluster_ids)]),
    );
    const observationsByCompany = aggregateObservationsByCompany(idBackedSentiments, priorScoredByCompany);

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
        evidence_cluster_ids: mergeEvidenceClusterIds(prior?.evidence_cluster_ids ?? [], obs.clusterKeys),
        scored_cluster_ids: mergeScoredClusterIds(prior?.scored_cluster_ids ?? [], obs.clusterKeys),
        updated_at: new Date().toISOString(),
      };
    });

    if (companySentimentRows.length === 0) return { companiesRescored: 0, error: null };

    const { error: companyUpsertError } = await client
      .from("company_sentiment")
      .upsert(companySentimentRows, { onConflict: "company_key" });

    if (companyUpsertError) throw new Error(companyUpsertError.message);
    return { companiesRescored: companySentimentRows.length, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[news] rolling company sentiment update failed:", msg);
    return { companiesRescored: 0, error: msg };
  }
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
  t = t.replace(/\$/g, " ").replace(/(\d)\s*b\b/g, "$1 billion").replace(/(\d)\s*m\b/g, "$1 million");
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
// tier (tiebreak exaScore, then recency); merges companyKeys so attribution
// survives. Conservative: requires ≥3 shared distinctive tokens AND ≥0.6 containment.
function dedupeByStory(
  pending: Map<string, PendingCluster>,
  workList: Map<string, CompanyEntry>,
): number {
  const keys = [...pending.keys()];
  const sig = new Map<string, Set<string>>();
  for (const key of keys) {
    const pc = pending.get(key)!;
    const names = [...pc.companyKeys].map((ck) => workList.get(ck)?.query ?? "").filter(Boolean);
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
      pending.get(dropKey)!.companyKeys.forEach((ck) => pending.get(keepKey)!.companyKeys.add(ck));
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
//   1  holdings query
//   N  Exa calls (one per distinct company, N=4 today)
//   1  batch cluster upsert (sentiments jsonb folded into this row — 0 extra)
//   1  batch match upsert
//   1  sweep
//   1  Grok sentiment scoring call (skipped if no survivors)
//   1  company_sentiment prior-score lookup (skipped if nothing scored)
//   1  company_sentiment batch upsert (skipped if nothing scored)
//   ─────────────────
//   N+7  total worst case (11 today, well under 50)
// ---------------------------------------------------------------------------

interface PendingCluster {
  result: ExaSearchResult; // raw search result — summary fetched later via Contents API
  exaScore: number;
  companyKeys: Set<string>;
  tickers: Set<string>;
  isins: Set<string>;
}

interface ClusterAccum {
  publishedAt: string;
  exaScore: number;
  companyKeys: Set<string>;
}

export async function runNewsFanout(env: Env): Promise<{
  distinctCompaniesQueried: number;
  clustersUpserted: number;
  matchesUpserted: number;
  undatedDropped: number;
  lowValueDropped: number;
  offTargetDropped: number;
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
      clustersUpserted: 0,
      matchesUpserted: 0,
      undatedDropped: 0,
      lowValueDropped: 0,
      offTargetDropped: 0,
      secondarySearches: 0,
      dedupedAway: 0,
      expiredSwept: 0,
      clustersScored: 0,
      companiesRescored: 0,
      errors: ["EXA_SEARCH not configured"],
    };
  }

  const apiKey = env.EXA_SEARCH;
  const client: AnySupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  // --- Build global work-list (1 subrequest) ---------------------------------
  const workList = await buildGlobalWorkList(client);

  const allCompanies = [...workList.values()].sort((a, b) =>
    a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0,
  );
  const cursor = 0;
  const companies = allCompanies.slice(cursor, cursor + FANOUT_WINDOW);

  const startPublishedDate = new Date(Date.now() - NEWS_WINDOW_MS).toISOString();
  const userLocation = deriveUserLocation(workList);

  // --- Phase 1: FETCH — collect results, no DB writes (N..2N subrequests) ----
  const pendingClusters = new Map<string, PendingCluster>();
  let undatedDropped = 0;
  let lowValueDropped = 0;
  let offTargetDropped = 0;
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
        });
      }
    }
    return kept;
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
      primary = await exaSearchNews(apiKey, newsQuery, startPublishedDate, userLocation, NEWS_INCLUDE_DOMAINS);
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
          apiKey, newsQuery, startPublishedDate, userLocation, NEWS_INCLUDE_DOMAINS_SECONDARY,
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

  // Collapse same-story duplicates across sources (keep best source tier).
  const dedupedAway = dedupeByStory(pendingClusters, workList);

  // --- Fetch summaries for survivors only, in the article's language ---------
  const EN_SUMMARY_QUERY =
    "Summarize the key business, financial, and strategic developments in this article in 2-3 sentences.";
  const FR_SUMMARY_QUERY =
    "Résumez les principaux développements commerciaux, financiers et stratégiques de cet article en 2 à 3 phrases.";

  const survivors = [...pendingClusters.values()];
  const summaryByUrl = new Map<string, string>();
  const frUrls = survivors.filter((p) => isFrenchSource(hostname(p.result.url ?? ""))).map((p) => p.result.url!);
  const enUrls = survivors.filter((p) => !isFrenchSource(hostname(p.result.url ?? ""))).map((p) => p.result.url!);
  for (const [urls, q] of [[frUrls, FR_SUMMARY_QUERY], [enUrls, EN_SUMMARY_QUERY]] as const) {
    if (urls.length === 0) continue;
    try {
      const m = await exaFetchSummaries(apiKey, urls, q);
      for (const [u, s] of m) summaryByUrl.set(u, s);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[news] Exa contents (summaries) failed:", msg);
      errors.push(`contents: ${msg}`);
    }
  }

  // --- Sentiment scoring: one batched Grok call for every survivor's ---------
  // (cluster, company) pairs (1 subrequest). Never throws — a failure here
  // must not block the feed from populating (see scoreClusterSentiments).
  const companiesByKey = new Map<string, SentimentCompanyRef>();
  const sentimentTargets: SentimentTarget[] = survivors.map((p) => {
    const clusterKey = p.result.id ?? p.result.url!;
    const companies: SentimentCompanyRef[] = [...p.companyKeys].map((ck) => {
      const entry = workList.get(ck);
      const holderTickers = new Set<string>();
      const holderIsins = new Set<string>();
      for (const holder of entry?.holders.values() ?? []) {
        holder.tickers.forEach((t) => holderTickers.add(t));
        holder.isins.forEach((i) => holderIsins.add(i));
      }
      const ref: SentimentCompanyRef = {
        canonicalKey: ck,
        name: entry?.query ?? ck,
        tickers: [...holderTickers],
        isins: [...holderIsins],
      };
      companiesByKey.set(ck, ref);
      return ref;
    });
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
  );
  if (sentimentError) errors.push(`sentiment scoring: ${sentimentError}`);

  const sentimentsByClusterKey = new Map<string, ClusterSentiment[]>();
  for (const s of clusterSentiments) {
    const arr = sentimentsByClusterKey.get(s.clusterKey);
    if (arr) arr.push(s);
    else sentimentsByClusterKey.set(s.clusterKey, [s]);
  }

  // --- Batch cluster upsert (1 subrequest) -----------------------------------
  const clusterRows = survivors.map((p) => {
    const clusterKey = p.result.id ?? p.result.url!;
    return buildClusterRow(
      p.result,
      [...p.tickers],
      [...p.isins],
      summaryByUrl.get(p.result.url!) ?? "",
      sentimentError ? null : (sentimentsByClusterKey.get(clusterKey) ?? []),
      companiesByKey,
    );
  });
  let clustersUpserted = 0;
  const clusterMap = new Map<string, ClusterAccum>();
  const clusterKeyToId = new Map<string, string>();

  if (clusterRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: upserted, error: clusterBatchError } = await (client as any)
      .from("news_clusters")
      .upsert(clusterRows, { onConflict: "cluster_key" })
      .select("id, cluster_key") as { data: Array<{ id: string; cluster_key: string }> | null; error: { message: string } | null };

    if (clusterBatchError) {
      errors.push(`batch cluster upsert: ${clusterBatchError.message}`);
      console.error("[news] batch cluster upsert failed:", clusterBatchError.message);
    } else {
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
      clustersUpserted = clusterMap.size;
    }
  }

  // --- Rolling per-company sentiment (EWMA) — up to 2 subrequests ------------
  // Skipped entirely (0 subrequests) when nothing was scored, e.g. sentiment
  // scoring failed above; the feed above is already fully populated by now.
  // Swap the survivor-scoped clusterKey for the durable DB cluster id so
  // company_sentiment cluster-id lists reference real, queryable rows.
  const idBackedSentiments: ClusterSentiment[] = clusterSentiments
    .map((s) => {
      const clusterId = clusterKeyToId.get(s.clusterKey);
      return clusterId ? { ...s, clusterKey: clusterId } : null;
    })
    .filter((s): s is ClusterSentiment => s !== null);

  const { companiesRescored, error: companySentimentError } = await updateRollingCompanySentiment(
    client,
    idBackedSentiments,
    companiesByKey,
  );
  if (companySentimentError) errors.push(`company sentiment: ${companySentimentError}`);

  // --- Phase 2: SCORE + MATCH — build matchAccum (pure JS, 0 subrequests) ---
  const matchAccum = new Map<string, Map<string, { keys: Set<string>; tickers: Set<string> }>>();

  for (const [clusterId, cluster] of clusterMap) {
    for (const ck of cluster.companyKeys) {
      const entry = workList.get(ck);
      if (!entry) continue;
      for (const [portfolioId, holder] of entry.holders) {
        let pMap = matchAccum.get(portfolioId);
        if (!pMap) {
          pMap = new Map();
          matchAccum.set(portfolioId, pMap);
        }
        let acc = pMap.get(clusterId);
        if (!acc) {
          acc = { keys: new Set(), tickers: new Set() };
          pMap.set(clusterId, acc);
        }
        acc.keys.add(ck);
        holder.tickers.forEach((t) => acc!.tickers.add(t));
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

      matchRows.push({
        portfolio_id: portfolioId,
        cluster_id: clusterId,
        score: computeMatchScore(cluster.exaScore, cluster.publishedAt, acc.keys.size),
        match_reason: {
          matched_tickers: [...acc.tickers],
          matched_company_names: companyNames,
        },
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
    clustersUpserted,
    matchesUpserted,
    undatedDropped,
    lowValueDropped,
    offTargetDropped,
    secondarySearches,
    dedupedAway,
    expiredSwept: expiredSwept ?? 0,
    clustersScored: sentimentsByClusterKey.size,
    companiesRescored,
    errors,
  };

  console.log("[news] fanout complete:", result);
  return result;
}
